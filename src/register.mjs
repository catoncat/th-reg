// Pure-protocol registration flow for tokenharbor.ai (no browser).
//
// This is THE primary path. The browser flow in `register-browser.mjs` is a
// separate, opt-in alternative — never an automatic fallback.
//
// Steps (every one verified live against the API, 2026-08-06):
//   1. GET /login?mode=signup with a cookie jar (on residential IPs the jar
//      is what satisfies the Vercel Security Checkpoint; without it the POST
//      is bounced back with the signup page)
//   2. parse the React-19 server-action binding fields ($ACTION_KEY is an
//      AES-128 key shipped in cleartext -> payload is constructible)
//   3. signup-precheck; if needCaptcha -> mark `captcha-required` and skip
//      (Turnstile is never bypassed)
//   4. multipart POST with email/password/invite_code/device_fingerprint
//      (random UUID - that's all the frontend does) /timezone -> 303 +
//      Supabase session cookie
//   5. POST /api/me/send-verification-email, then read the link from the
//      mailbox and open it -> 307 /dashboard?verify=success
//   6. POST /api/welcome/claim -> { ok, rewardUsd: 5, newTrialBalance: 5 }
//   7. POST /api/keys -> plaintext full key
//   8. verify the money landed by reading Supabase `wallets` (authoritative)
//
// HARD-WON FACTS — do not "simplify" these away:
//   * Supabase `email_confirmed_at` is written automatically ~6s after signup
//     but does NOT mean tokenharbor considers the address verified. The API
//     answers 403 `email_not_verified` until the mailbox link is opened.
//     => a real mailbox is REQUIRED for a usable account.
//   * The $5 grant needs an explicit claim call. The dashboard HTML contains a
//     marketing "$5" string that matches even at zero balance, which once
//     produced 5 accounts recorded as verified/gift_claimed that were in fact
//     unusable. Money is judged from `wallets` only.
//
// Proxy is OPTIONAL and off by default (`direct`). Use --proxy sticky|rotate
// when the production batch needs per-account residential IPs.

import { createMailProvider, sleep } from './mailbox.mjs';
import { randomHex } from './config.mjs';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { nullPacer } from './pacer.mjs';
import {
  resolveProxy,
  httpRequest,
  fetchActionPage,
  parseSignupReject,
  fetchEgressIp,
  signupPrecheck,
  postSignup,
  openVerify,
  sendVerificationEmail,
  claimWelcomeGrant,
  createApiKey,
  enableFreeModels,
  fetchWallet,
  supabaseSignup,
  buildSessionCookie,
  SIGNUP_URL,
  HOST,
} from './http.mjs';

export { SIGNUP_URL, HOST };

export async function registerOne(cfg, { email, password, log = () => {}, pacer = nullPacer() }) {
  const mail = createMailProvider(cfg.mailMode, { cli: cfg.mailboxCli });

  const result = {
    email,
    password,
    sess_id: `th${randomHex(6)}`,
    proxy: 'direct',
    created_at: new Date().toISOString(),
    status: 'pending',
  };

  // Signup may refresh sticky IP + jar once: Vercel checkpoint bounces POST
  // as 200+HTML, and bad residential exits show up as curl SSL/network errors.
  // One cheap session rotate absorbs most noise without burning a new email.
  let sessId = result.sess_id;
  let proxy = resolveProxy(cfg, sessId);
  result.proxy = proxy ? maskProxy(proxy) : 'direct';
  let jar = `/tmp/th-reg-${process.pid}-${sessId}.jar`;
  const jarsToClean = new Set([jar]);

  const rotateSession = () => {
    sessId = `th${randomHex(6)}`;
    proxy = resolveProxy(cfg, sessId);
    result.sess_id = sessId;
    result.proxy = proxy ? maskProxy(proxy) : 'direct';
    jar = `/tmp/th-reg-${process.pid}-${sessId}.jar`;
    jarsToClean.add(jar);
  };

  try {
    // Retries only help for walls tied to THIS exit IP or to a flaky tunnel.
    // A 'rate_fast' rejection is the shared cross-IP bucket (measured), so
    // retrying — with or without a new IP — only burns time; pacing is the
    // caller's job.
    const MAX_SIGNUP_ATTEMPTS = 3;
    const ROTATE_WORTH = new Set(['rate_network_hour', 'unsupported', 'transport', 'pagefail', 'server_error']);
    let created = false;
    let lastSignupErr = null;
    let lastClass = null;
    let sbSession = null; // supabase-native session (rate-limit bypass path)

    // Helper: create the account via GoTrue /auth/v1/signup. This endpoint
    // does NOT pass through the shared cross-IP submission bucket, so it works
    // while the server-action signup is being rate-limited ("rate_fast").
    // Measured limitation: no server-side signup_proof => welcome grant is $0.
    const supabaseAttempt = async () => {
      const fp = randomUUID();
      result.device_fingerprint = fp;
      const sb = await supabaseSignup({
        email, password, fp, timezone: cfg.timezone,
        signupIp: result.egress_ip || undefined, inviteCode: cfg.inviteCode,
      });
      if (sb.error) {
        lastSignupErr = 'supabase-signup: ' + sb.error;
        lastClass = 'supabase';
        log('[!] ' + lastSignupErr);
        return false;
      }
      sbSession = sb;
      result.status = 'created';
      result.sess_id = sb.user.id; // real uid is more useful than a fake sess id
      created = true;
      log('[+] account created via supabase-native signup (rate-limit bypass)');
      return true;
    };

    if (cfg.signupPath === 'supabase') {
      // Explicit bypass path: no shared bucket, no pacer slot needed.
      await supabaseAttempt();
    } else {
      for (let attempt = 1; attempt <= MAX_SIGNUP_ATTEMPTS; attempt++) {
      lastClass = null;
      try {
        // Serialize the submit step across workers (shared server-side bucket).
        await pacer.slot();
        // 1. signup page (jar must be shared with the POST below) + egress IP
        const [page, egressIp] = await Promise.all([
          fetchActionPage({ jar, proxy }),
          proxy ? fetchEgressIp({ proxy }) : Promise.resolve(null),
        ]);
        if (egressIp) result.egress_ip = egressIp;
        if (!page.key || page.status !== 200) {
          lastSignupErr = `signup page fetch failed (http ${page.status})`;
          lastClass = 'pagefail';
          log(`[!] ${lastSignupErr}`);
        } else {
          const fp = randomUUID();
          result.device_fingerprint = fp;

          // 2. precheck — never bypass Turnstile
          const pre = await signupPrecheck(fp, { proxy });
          if (pre.needCaptcha) {
            result.status = 'captcha-required';
            result.note = 'signup-precheck requested Turnstile; not bypassed';
            log(`[!] ${result.note}`);
            return result;
          }

          // 3. submit the server action
          const r = await postSignup({
            email, password, invite: cfg.inviteCode, fp, timezone: cfg.timezone,
            actionKey: page.key, actionMeta: page.meta, actionArgs: page.args,
            jar, proxy,
          });
          if (r.code === 303) {
            result.status = 'created';
            if (attempt > 1) result.signup_retries = attempt - 1;
            pacer.report('ok');
            log(`[+] account created (303 -> ${r.location})${attempt > 1 ? ` after ${attempt - 1} session retry` : ''}`);
            created = true;
            break;
          }
          // Non-303: the server action re-rendered the page and named the wall.
          const rej = parseSignupReject(r.body);
          lastClass = rej.klass;
          lastSignupErr = `${rej.klass}${rej.message ? ': ' + rej.message : ` (http ${r.code}, unparsed)`}`;
          result.reject_class = rej.klass;
          pacer.report(rej.klass);
          log(`[!] signup rejected ${lastSignupErr}`);
        }
      } catch (err) {
        // Proxy SSL / tunnel / timeout during signup — retryable via new sticky IP.
        lastClass = 'transport';
        lastSignupErr = err?.message?.split('\n')[0]?.slice(0, 160) || String(err);
        pacer.report('transport');
        log(`[!] signup transport: ${lastSignupErr}`);
      }

      if (created || attempt >= MAX_SIGNUP_ATTEMPTS) break;
      if (!ROTATE_WORTH.has(lastClass)) {
        log(`[·] no in-place retry for ${lastClass} (a fresh IP changes nothing); caller backs off`);
        break;
      }
      log(`[·] rotating sticky session (attempt ${attempt + 1}/${MAX_SIGNUP_ATTEMPTS}, was ${lastClass})`);
      rotateSession();
      await sleep(400);
    }
      }

    // rate_fast (shared cross-IP bucket empty) → fall back to the bypass path
    // so a batch keeps moving instead of stalling on the shared bucket.
    if (!created && cfg.signupPath !== 'server-action' && lastClass === 'rate_fast') {
      log('[·] rate_fast — falling back to supabase-native signup (bypass)');
      await supabaseAttempt();
    }

    if (!created) {
      result.status = 'failed';
      result.error = lastSignupErr || 'signup failed';
      if (lastClass) result.reject_class = lastClass;
      return result;
    }

    // supabase-native sessions authenticate the business /api/* endpoints via
    // the GoTrue chunked cookie pair (Bearer is rejected: "Sign in first.").
    const sbCookie = sbSession
      ? buildSessionCookie({
          access_token: sbSession.accessToken,
          expires_at: sbSession.expiresAt,
          refresh_token: sbSession.refreshToken,
          user: sbSession.user,
        })
      : null;

    // 4. verify the email for real. This is mandatory: without opening the
    //    mailbox link the API answers 403 email_not_verified, so an account
    //    that skips this step is worthless no matter what Supabase says.
    if (mail.name === 'none') {
      result.status = 'created-unverified';
      result.note =
        'mailMode=none: cannot verify the address, so the API stays locked ' +
        '(403 email_not_verified). Set TH_MAIL_MODE=cloud-mail for usable accounts.';
      log(`[!] ${result.note}`);
      return result;
    }

    // Ask the app to send the mail (signup alone does not reliably send it).
    // A dead proxy tunnel here used to throw away a perfectly good account, so
    // this is retried and, if it still fails, we fall through to the mailbox
    // poll anyway (the mail may already be on its way).
    const sent = await withRetry(() => sendVerificationEmail({ jar, proxy, cookie: sbCookie }), 2, (m) =>
      log(`[!] send-verification-email retry: ${m}`),
    );
    log(sent ? `[·] verification email requested (http ${sent.code})` : '[!] send-verification-email failed; polling the mailbox anyway');

    let link = null;
    try {
      link = await mail.waitVerifyLink(email, {
        timeoutMs: cfg.mailTimeout * 1000,
        intervalMs: cfg.mailPollInterval * 1000,
        log,
      });
    } catch (err) {
      log(`[!] verify link lookup failed: ${err.message}`);
    }
    if (!link) {
      result.status = 'created-unverified';
      result.note = `no verify link within ${cfg.mailTimeout}s; API stays locked. Retry with scripts/recover-verify.mjs`;
      log(`[!] ${result.note}`);
      return result;
    }

    result.verify_link = link;
    const v = await openVerify(link, { jar, cookie: sbCookie, proxy });
    if (!v.location?.includes('verify=success')) {
      result.status = 'created-unverified';
      result.note = `verify link did not confirm (${v.location || 'http ' + v.code})`;
      log(`[!] ${result.note}`);
      return result;
    }
    result.status = 'verified';
    log(`[+] email verified -> ${v.location}`);

    // 5. claim the $5 grant + create the API key, then prove both landed.
    //    Best-effort: failures are recorded but do not undo the account.
    try {
      await postRegisterSetupHTTP(cfg, { jar, cookie: sbCookie, proxy, result, password, log });
    } catch (err) {
      result.note = [result.note, `post-register: ${err.message}`].filter(Boolean).join(' | ');
      log(`[!] post-register partial: ${err.message}`);
    }

    return result;
  } finally {
    for (const j of jarsToClean) rmSync(j, { force: true });
  }
}

/**
 * Claim the welcome grant, create an API key, then confirm the balance from
 * Supabase `wallets` — the authoritative source. Never infer money from HTML.
 */
export async function postRegisterSetupHTTP(cfg, { jar, cookie, proxy, result, password, log }) {
  // After verify, claim / API key / free-models only need the session cookie.
  // Run them concurrently (async curl). free-models is best-effort and must
  // not block a funded paid-route account (opus etc. do not need it).
  const claimP = withRetry(() => claimWelcomeGrant({ jar, cookie, proxy }), 2)
    .then((cr) => {
      if (!cr) return { cr: { code: 0 }, claimed: null, error: 'transport' };
      let claimed = null;
      try {
        claimed = JSON.parse(cr.body);
      } catch {
        /* non-JSON */
      }
      return { cr, claimed };
    })
    .catch((e) => ({ cr: { code: 0 }, claimed: null, error: e.message }));

  const keyP = withRetry(() => createApiKey({ label: 'bot-key', jar, cookie, proxy }), 2)
    .then((kr) => {
      if (!kr) return { kr: { code: 0 }, plaintext: null, error: 'transport' };
      let plaintext = null;
      if (kr.code === 200 || kr.code === 201) {
        try {
          const j = JSON.parse(kr.body);
          if (j.plaintext) plaintext = j.plaintext;
        } catch {
          /* not json */
        }
      }
      return { kr, plaintext };
    })
    .catch((e) => ({ kr: { code: 0 }, plaintext: null, error: e.message }));

  const freeP = enableFreeModels({ jar, cookie, proxy })
    .then((fr) => {
      try {
        return JSON.parse(fr.body)?.free_models_enabled === true;
      } catch {
        return false;
      }
    })
    .catch(() => false);

  const [claimRes, keyRes, freeEnabled] = await Promise.all([claimP, keyP, freeP]);

  result.free_models_enabled = !!freeEnabled;
  log(freeEnabled ? '[+] free models enabled' : '[·] free models skipped/failed (non-blocking)');

  if (keyRes.plaintext) {
    result.api_key = keyRes.plaintext;
    log('[+] API key created');
  } else {
    log(`[!] api/keys failed (${keyRes.error || 'http ' + keyRes.kr?.code})`);
  }

  if (claimRes.claimed?.ok) {
    const trial = Number(claimRes.claimed.newTrialBalance);
    result.balance_trial = Number.isFinite(trial) ? trial : Number(claimRes.claimed.rewardUsd) || 5;
    result.balance_paid = 0;
    result.gift_claimed = result.balance_trial >= 4.99;
    if (cookie && result.balance_trial < 4.99) {
      // supabase-native signup lacks the server-side signup_proof, so the
      // welcome grant is issued at $0 (measured 2026-08-13; see http.mjs).
      result.note = [result.note, 'welcome grant $0 (supabase-native signup: no signup_proof; known limitation)'].filter(Boolean).join(' | ');
      log('[!] welcome grant $0 — supabase-native signup has no signup_proof (known limitation)');
    } else {
      log(
        `[+] welcome grant claimed: ${claimRes.claimed.rewardUsd ?? 5} (trial=${result.balance_trial})`,
      );
    }
  } else {
    const why = claimRes.claimed?.error?.code || claimRes.error || `http ${claimRes.cr?.code}`;
    result.note = [result.note, `welcome claim failed: ${why}`].filter(Boolean).join(' | ');
    log(`[!] welcome claim failed: ${why}`);
    // Fallback authoritative wallet read only when claim did not confirm money.
    const wallet = await fetchWallet(result.email, password);
    if (wallet) {
      result.balance_trial = wallet.balanceTrial;
      result.balance_paid = wallet.balancePaid;
      result.gift_claimed = wallet.balanceTrial >= 4.99;
      log(
        result.gift_claimed
          ? `[+] wallet confirms $${wallet.balanceTrial.toFixed(2)} trial credit`
          : `[!] wallet shows only $${wallet.balanceTrial.toFixed(2)} trial credit`,
      );
    } else {
      result.gift_claimed = false;
      result.note = [result.note, 'wallet read failed; balance unverified'].filter(Boolean).join(' | ');
      log('[!] wallet read failed; not asserting any balance');
    }
  }
}


/**
 * Retry a request that only failed at the transport layer (dead residential
 * tunnel, timeout). Returns null when every attempt failed — callers decide
 * whether that is fatal. Session cookies are not IP-bound, so retrying on the
 * same jar is safe.
 */
async function withRetry(fn, attempts = 2, onRetry = () => {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i + 1 < attempts) {
        onRetry(String(err?.message || err).split('\n')[0].slice(0, 100));
        await sleep(800);
      }
    }
  }
  void lastErr;
  return null;
}

function maskProxy(url) {
  return url.replace(/:\/\/[^@]+@/, '://***:***@');
}

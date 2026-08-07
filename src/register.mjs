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
import {
  resolveProxy,
  httpRequest,
  fetchActionPage,
  signupPrecheck,
  postSignup,
  openVerify,
  sendVerificationEmail,
  claimWelcomeGrant,
  createApiKey,
  enableFreeModels,
  fetchWallet,
  SIGNUP_URL,
  HOST,
} from './http.mjs';

export { SIGNUP_URL, HOST };

export async function registerOne(cfg, { email, password, log = () => {} }) {
  const sessId = `th${randomHex(6)}`;
  const proxy = resolveProxy(cfg, sessId);
  const jar = `/tmp/th-reg-${process.pid}-${sessId}.jar`;
  const mail = createMailProvider(cfg.mailMode, { cli: cfg.mailboxCli });

  const result = {
    email,
    password,
    sess_id: sessId,
    proxy: proxy ? maskProxy(proxy) : 'direct',
    created_at: new Date().toISOString(),
    status: 'pending',
  };

  try {
    // 1. signup page (jar must be shared with the POST below)
    const page = fetchActionPage({ jar, proxy });
    if (!page.key || page.status !== 200) {
      result.status = 'failed';
      result.error = `signup page fetch failed (http ${page.status})`;
      log(`[!] ${result.error}`);
      return result;
    }
    const fp = randomUUID();
    result.device_fingerprint = fp;

    // 2. precheck — never bypass Turnstile
    const pre = signupPrecheck(fp, { proxy });
    if (pre.needCaptcha) {
      result.status = 'captcha-required';
      result.note = 'signup-precheck requested Turnstile; not bypassed';
      log(`[!] ${result.note}`);
      return result;
    }

    // 3. submit the server action
    const r = postSignup({
      email, password, invite: cfg.inviteCode, fp, timezone: cfg.timezone,
      actionKey: page.key, actionMeta: page.meta, actionArgs: page.args,
      jar, proxy,
    });
    if (r.code !== 303) {
      result.status = 'failed';
      result.error = `signup http ${r.code} ${r.body.slice(0, 160)}`;
      log(`[!] signup http ${r.code}`);
      return result;
    }
    result.status = 'created';
    log(`[+] account created (303 -> ${r.location})`);

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
    const sent = sendVerificationEmail({ jar, proxy });
    log(`[·] verification email requested (http ${sent.code})`);

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
    const v = openVerify(link, { jar, proxy });
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
      await postRegisterSetupHTTP(cfg, { jar, proxy, result, password, log });
    } catch (err) {
      result.note = [result.note, `post-register: ${err.message}`].filter(Boolean).join(' | ');
      log(`[!] post-register partial: ${err.message}`);
    }

    return result;
  } finally {
    rmSync(jar, { force: true });
  }
}

/**
 * Claim the welcome grant, create an API key, then confirm the balance from
 * Supabase `wallets` — the authoritative source. Never infer money from HTML.
 */
export async function postRegisterSetupHTTP(cfg, { jar, proxy, result, password, log }) {
  // 1. claim the $5 welcome grant (explicit API call; nothing is automatic)
  const cr = claimWelcomeGrant({ jar, proxy });
  let claimed = null;
  try {
    claimed = JSON.parse(cr.body);
  } catch { /* non-JSON body handled below */ }
  if (cr.code === 200 && claimed?.ok) {
    log(`[+] welcome grant claimed: $${claimed.rewardUsd} (trial=$${claimed.newTrialBalance})`);
  } else {
    const why = claimed?.error?.code || `http ${cr.code}`;
    result.note = [result.note, `welcome claim failed: ${why}`].filter(Boolean).join(' | ');
    log(`[!] welcome claim failed: ${why}`);
  }

  // 2. enable the free-models tier (without it every :free route answers 429
  //    free_route_inactive). Idempotent.
  const fr = enableFreeModels({ jar, proxy });
  let freeEnabled = false;
  try {
    freeEnabled = JSON.parse(fr.body)?.free_models_enabled === true;
  } catch { /* non-JSON */ }
  result.free_models_enabled = freeEnabled;
  log(freeEnabled ? '[+] free models enabled' : `[!] free models: http ${fr.code}`);

  // 3. API key — the full value exists only in this response
  const kr = createApiKey({ label: 'bot-key', jar, proxy });
  if (kr.code === 200 || kr.code === 201) {
    try {
      const j = JSON.parse(kr.body);
      if (j.plaintext) {
        result.api_key = j.plaintext;
        log('[+] API key created');
      } else {
        log('[!] api/keys response had no plaintext');
      }
    } catch {
      log('[!] api/keys response not JSON');
    }
  } else {
    log(`[!] api/keys http ${kr.code}`);
  }

  // 3. authoritative balance check (replaces the old dashboard-regex guess)
  const wallet = await fetchWallet(result.email, password);
  if (wallet) {
    result.balance_trial = wallet.balanceTrial;
    result.balance_paid = wallet.balancePaid;
    result.gift_claimed = wallet.balanceTrial >= 5;
    log(
      result.gift_claimed
        ? `[+] wallet confirms $${wallet.balanceTrial.toFixed(2)} trial credit`
        : `[!] wallet shows only $${wallet.balanceTrial.toFixed(2)} trial credit`
    );
  } else {
    result.gift_claimed = false;
    result.note = [result.note, 'wallet read failed; balance unverified'].filter(Boolean).join(' | ');
    log('[!] wallet read failed; not asserting any balance');
  }
}

function maskProxy(url) {
  return url.replace(/:\/\/[^@]+@/, '://***:***@');
}

// Pure-protocol registration flow for tokenharbor.ai (no browser, 2026-08-06).
//
// Steps (verified live):
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
//   5. poll cloud-mail for the verify link, open it over HTTP -> 307
//      /dashboard?verify=success (no cookie needed, token self-authorizes)
//   6. POST /api/keys -> plaintext full key; dashboard body confirms $5 gift
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
  createApiKey,
  supabaseGetUser,
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
      email, password, invite: cfg.inviteCode, fp,
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

    // 4. determine email-verification. Two signals (2026-08-06):
    //   - signups on these IPs are auto-confirmed (email_confirmed_at written
    //     ~6s after signup) with NO verify email sent -> poll Supabase with
    //     short retries (fast, no 150s wait)
    //   - if Supabase stays unconfirmed, fall back to mailbox polling
    let supaUser = null;
    for (let i = 0; i < 4 && !supaUser?.email_confirmed_at; i++) {
      if (i) await sleep(3000);
      supaUser = await supabaseGetUser(email, password);
    }
    if (supaUser?.email_confirmed_at) {
      result.status = 'verified';
      result.note = 'email auto-confirmed (no verify mail)';
      log('[+] email auto-confirmed (no verify mail needed)');
    } else {
      // Supabase still unconfirmed; ask the mail provider for the verify link.
      // With mailMode=none this returns null immediately and the account is
      // recorded created-unverified (a verified status cannot be assumed).
      let link = null;
      try {
        link = await mail.waitVerifyLink(email, {
          timeoutMs: cfg.mailTimeout * 1000,
          intervalMs: cfg.mailPollInterval * 1000,
          log,
        });
      } catch (err) {
        result.note = `verify link lookup failed: ${err.message}`;
        log(`[!] ${result.note}`);
      }
      if (link) {
        result.verify_link = link;
        const v = openVerify(link, { jar, proxy });
        const ok = !!v.location?.includes('verify=success') || (/BALANCE/.test(v.body) && /Overview/.test(v.body));
        if (ok) {
          result.status = 'verified';
          log(`[+] email verified -> ${v.location || 'dashboard'}`);
        } else {
          result.status = 'created-unverified';
          result.note = `verify link opened but not confirmed (${v.location || 'http ' + v.code})`;
          log(`[!] ${result.note}`);
        }
      } else {
        result.status = 'created-unverified';
        result.note = result.note || `no verify mail (mailMode=${cfg.mailMode}) and email not confirmed in Supabase`;
        log(`[!] created-unverified: ${result.note}`);
      }
    }

    // 5. post-register over HTTP: create API key + confirm $5 gift.
    //    Best-effort: failures are recorded but do not undo the account.
    if (result.status === 'verified') {
      try {
        await postRegisterSetupHTTP(cfg, { jar, proxy, result, log });
      } catch (err) {
        result.note = [result.note, `post-register: ${err.message}`].filter(Boolean).join(' | ');
        log(`[!] post-register partial: ${err.message}`);
      }
    }

    return result;
  } finally {
    rmSync(jar, { force: true });
  }
}

/** Create an API key (plaintext in response) + confirm the $5 gift via dashboard body. */
export async function postRegisterSetupHTTP(cfg, { jar, proxy, result, log }) {
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

  const d = httpRequest({ method: 'GET', url: `${HOST}/dashboard`, jar, proxy, timeout: 20000 });
  if (d.code === 200) {
    const five = d.body.match(/\$5(\.00)?/);
    if (five) {
      result.gift_claimed = true;
      result.balance = five[0];
      log('[+] $5 gift confirmed');
    }
  }
}

function maskProxy(url) {
  return url.replace(/:\/\/[^@]+@/, '://***:***@');
}

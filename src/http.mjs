// Minimal curl-based HTTP client for the pure-protocol registration flow.
// (2026-08-06) tokenharbor's React-19 server-action signup is fully
// reproducible over plain HTTP once you send device_fingerprint=<UUID> and
// timezone. This module wraps curl for cookie-jar persistence + header capture.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync as readFileSyncFs, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import { stickyEndpoint, rotateEndpoint } from './config.mjs';
import { SUPABASE_BASE, SUPABASE_ANON } from './th-api.mjs';

export const SIGNUP_URL = 'https://tokenharbor.ai/login?mode=signup';
export const HOST = 'https://tokenharbor.ai';
export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Resolve the proxy endpoint for a register run. `direct` -> null. */
export function resolveProxy(cfg, sessId) {
  if (!cfg.proxyMode || cfg.proxyMode === 'direct') return null;
  if (cfg.proxyMode === 'rotate') return rotateEndpoint(cfg);
  return stickyEndpoint(cfg, sessId); // sticky == per-account IP
}

/** Run curl with a cookie jar; return { code, location, cookies, body }. */
export async function httpRequest({ method = 'GET', url, data, contentType, jar, proxy, timeout = 30000 }) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const args = ['-sS', '-m', String(timeout), '-A', UA];
    if (proxy) args.push('-x', proxy);
    if (jar) args.push('-b', jar, '-c', jar);
    if (data != null) args.push('--data-binary', data);
    if (contentType) args.push('-H', 'content-type: ' + contentType);
    const hdrFile = '/tmp/thh-' + process.pid + '-' + randomBytes(4).toString('hex') + '.hdr';
    const bodyFile = '/tmp/thh-' + process.pid + '-' + randomBytes(4).toString('hex') + '.body';
    args.push('-D', hdrFile, '-o', bodyFile, '-w', '%{http_code}', '-X', method, url);
    let code;
    try {
      const { stdout } = await execFileAsync('curl', args, {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      });
      code = Number(stdout);
    } catch (e) {
      lastErr = e;
      try { rmSync(hdrFile, { force: true }); rmSync(bodyFile, { force: true }); } catch { /* ignore */ }
      // SSL / proxy auth / resolve failures won't heal on the same sticky IP.
      // Fail fast so registerOne can rotate the session instead of burning ~3s.
      const msg = String(e?.message || e);
      if (/SSL certificate|self signed|CONNECT tunnel|Proxy CONNECT|Could not resolve|Connection refused/i.test(msg)) {
        throw e;
      }
      await sleep(1000);
      continue;
    }
    let headers = '', body = '';
    try {
      headers = readFileSyncFs(hdrFile, 'utf8');
      body = readFileSyncFs(bodyFile, 'utf8');
    } catch { /* best effort */ }
    try { rmSync(hdrFile, { force: true }); rmSync(bodyFile, { force: true }); } catch { /* ignore */ }
    return {
      code,
      headers,
      location: (headers.match(/^location:\s*(.+)$/im) || [])[1]?.trim() || null,
      cookies: headers.match(/^set-cookie:\s*([^;]+)/gim) || [],
      body,
    };
  }
  throw lastErr;
}

/** Fetch the sign-up page and return its server-action binding fields. */
export async function fetchActionPage({ jar, proxy }) {
  const page = await httpRequest({ method: 'GET', url: SIGNUP_URL, jar, proxy });
  const val = (name) => {
    const m = page.body.match(new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`));
    return m ? m[1].replaceAll('&quot;', '"') : null;
  };
  return {
    status: page.code,
    key: val('\\$ACTION_KEY'),
    meta: val('\\$ACTION_1:0'),
    args: val('\\$ACTION_1:1'),
  };
}

/** Check signup-precheck; true means Turnstile is required (we skip, never force). */
export async function signupPrecheck(fp, { proxy }) {
  const r = await httpRequest({ method: 'GET', url: `https://tokenharbor.ai/api/auth/signup-precheck?fp=${encodeURIComponent(fp)}`, proxy });
  try {
    return JSON.parse(r.body);
  } catch {
    return { needCaptcha: true, parseError: r.body.slice(0, 80) };
  }
}

/** POST the signup server action. Expect 303 + Supabase session cookie in jar. */
export async function postSignup({ email, password, invite, fp, timezone = 'Asia/Shanghai', actionKey, actionMeta, actionArgs, jar, proxy }) {
  const entries = [
    ['$ACTION_REF_1', ''],
    ['$ACTION_1:0', actionMeta],
    ['$ACTION_1:1', actionArgs],
    ['$ACTION_KEY', actionKey],
    ['email', email],
    ['password', password],
    ['invite_code', invite || ''],
    ['device_fingerprint', fp],
    ['timezone', timezone],
  ];
  const b = 'x' + randomBytes(8).toString('hex');
  const body =
    entries.map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('') +
    `--${b}--\r\n`;
  return httpRequest({
    method: 'POST',
    url: SIGNUP_URL,
    data: body,
    contentType: `multipart/form-data; boundary=${b}`,
    jar,
    proxy,
    timeout: 40000,
  });
}

/**
 * Classify a non-303 signup response.
 *
 * The React-19 server action re-renders the signup page and puts its return
 * value in the `$ACTION_1:1` hidden input (and in the flight payload). Reading
 * only the first bytes of that HTML — as this project did until 2026-08-11 —
 * makes every rejection look like an anonymous "checkpoint 200"; the body
 * actually names the wall we hit. Measured classes:
 *
 *   rate_fast          shared cross-IP bucket is empty; rotating the exit IP
 *                      does NOT help, only waiting does
 *   rate_network_hour  this exit network is capped for ~1h; rotate the IP
 *   unsupported        IP or email domain rejected by reputation; rotate the IP
 *   validation         our own payload is wrong (checked BEFORE rate limits)
 *   checkpoint         genuine Vercel challenge (no server-action payload)
 */
export function parseSignupReject(body) {
  let message = null;
  const m = body.match(/name="\$ACTION_1:1" value="(\[[^"]*\])"/);
  if (m) {
    const raw = m[1].replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&amp;', '&');
    try {
      const parsed = JSON.parse(raw);
      message = (Array.isArray(parsed) ? parsed[0] : parsed)?.error || null;
    } catch {
      message = raw.slice(0, 200);
    }
  }
  const t = message || '';
  const klass =
    /bit fast/i.test(t) ? 'rate_fast'
    : /too many sign-?ups/i.test(t) ? 'rate_network_hour'
    : /not supported/i.test(t) ? 'unsupported'
    : /captcha|turnstile/i.test(t) ? 'captcha'
    // Server-side hiccup, explicitly "try again in a minute". Must be tested
    // BEFORE validation: the text ends in "email support@tokenharbor.ai", and a
    // naive /email/ check files it as our own bad payload.
    : /couldn't create your account|team has been alerted/i.test(t) ? 'server_error'
    : /password|email|invite|required|characters/i.test(t) ? 'validation'
    : message ? 'rejected'
    : /Security Checkpoint|challenge-platform|__vercel_challenge/i.test(body) ? 'checkpoint'
    : 'unknown';
  return { klass, message };
}

/** Best-effort egress IP for the current proxy (tiny request; null on failure). */
export async function fetchEgressIp({ proxy }) {
  try {
    const r = await httpRequest({ method: 'GET', url: 'https://api.ipify.org?format=json', proxy, timeout: 12000 });
    return JSON.parse(r.body)?.ip || null;
  } catch {
    return null;
  }
}

/** Open a verify link; returns redirect URL (expect /dashboard?verify=success). */
export async function openVerify(link, { jar, proxy }) {
  return httpRequest({ method: 'GET', url: link, jar, proxy, timeout: 20000 });
}

/**
 * Ask the app to (re)send the verification email. Reverse-engineered from the
 * dashboard bundle: the "Verify email" button does a bare `POST` with no body.
 * Registration does not reliably send the mail on its own, so the pure-protocol
 * path triggers it explicitly.
 */
export async function sendVerificationEmail({ jar, proxy }) {
  return httpRequest({
    method: 'POST',
    url: `${HOST}/api/me/send-verification-email`,
    jar,
    proxy,
    timeout: 20000,
  });
}

/**
 * List claimable rewards -> { claimable: [{ kind, level, reward }] }.
 * `welcome_grant` is the $5 signup credit.
 */
export async function giftsStatus({ jar, proxy }) {
  return httpRequest({ method: 'GET', url: `${HOST}/api/gifts/status`, jar, proxy, timeout: 20000 });
}

/**
 * Claim the $5 welcome grant (bare POST, no body — same as the dashboard).
 * 200 -> { ok: true, rewardUsd: 5, newTrialBalance: 5 }
 * 403 `email_not_verified` -> the mailbox link must be opened first.
 */
export async function claimWelcomeGrant({ jar, proxy }) {
  return httpRequest({ method: 'POST', url: `${HOST}/api/welcome/claim`, jar, proxy, timeout: 25000 });
}

/** POST /api/keys; returns parsed JSON (contains `plaintext` full key). */
export async function createApiKey({ label, jar, proxy }) {
  return httpRequest({
    method: 'POST',
    url: 'https://tokenharbor.ai/api/keys',
    data: JSON.stringify({ label }),
    contentType: 'application/json',
    jar,
    proxy,
    timeout: 20000,
  });
}

/**
 * Enable the free-models tier for the signed-in account (the "Enable free
 * models?" consent on the dashboard). Without it every :free route answers
 * 429 `free_route_inactive`. Reverse-engineered from the dashboard bundle:
 * the consent dialog does POST /api/me/privacy { free_models_enabled: true }.
 * Idempotent — safe to call on an account that already opted in.
 */
export async function enableFreeModels({ jar, proxy }) {
  return httpRequest({
    method: 'POST',
    url: `${HOST}/api/me/privacy`,
    data: JSON.stringify({ free_models_enabled: true }),
    contentType: 'application/json',
    jar,
    proxy,
    timeout: 20000,
  });
}

/** Supabase password grant -> the user object (has email_confirmed_at). */
export async function supabaseGetUser(email, password) {
  try {
    const res = await fetch(`${SUPABASE_BASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    return (await res.json())?.user || null;
  } catch {
    return null;
  }
}

/**
 * Authoritative wallet read: password grant -> GET /rest/v1/wallets.
 *
 * This is the ONLY trustworthy source for "did the $5 actually land".
 * The dashboard HTML contains a marketing "$5" string that matches even on a
 * zero-balance account, which previously produced false `gift_claimed: true`
 * records — never judge money from page text.
 *
 * @returns {Promise<{balanceTrial:number, balancePaid:number}|null>}
 */
export async function fetchWallet(email, password) {
  try {
    const grant = await fetch(`${SUPABASE_BASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(20000),
    });
    if (!grant.ok) return null;
    const { access_token: token, user } = await grant.json();
    if (!token || !user?.id) return null;

    const url =
      `${SUPABASE_BASE}/rest/v1/wallets?select=balance_trial,balance_paid&user_id=eq.${user.id}`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    return { balanceTrial: Number(row.balance_trial) || 0, balancePaid: Number(row.balance_paid) || 0 };
  } catch {
    return null;
  }
}

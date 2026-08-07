// Minimal curl-based HTTP client for the pure-protocol registration flow.
// (2026-08-06) tokenharbor's React-19 server-action signup is fully
// reproducible over plain HTTP once you send device_fingerprint=<UUID> and
// timezone. This module wraps curl for cookie-jar persistence + header capture.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { stickyEndpoint, rotateEndpoint } from './config.mjs';

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
export function httpRequest({ method = 'GET', url, data, contentType, jar, proxy, timeout = 30000 }) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const args = ['-sS', '-m', String(timeout), '-A', UA];
    if (proxy) args.push('-x', proxy);
    if (jar) args.push('-b', jar, '-c', jar);
    if (data != null) args.push('--data-binary', data);
    if (contentType) args.push('-H', `content-type: ${contentType}`);
    const hdrFile = `/tmp/thh-${process.pid}-${randomBytes(4).toString('hex')}.hdr`;
    const bodyFile = `/tmp/thh-${process.pid}-${randomBytes(4).toString('hex')}.body`;
    args.push('-D', hdrFile, '-o', bodyFile, '-w', '%{http_code}', '-X', method, url);
    let code;
    try {
      code = Number(execFileSync('curl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (e) {
      lastErr = e; // transient TLS/reset — retry
      execFileSync('sleep', ['1']);
      continue;
    }
    let headers = '', body = '';
    try {
      headers = execFileSync('cat', [hdrFile], { encoding: 'utf8' });
      body = execFileSync('cat', [bodyFile], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch { /* best effort */ }
    execFileSync('rm', ['-f', hdrFile, bodyFile]);
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
export function fetchActionPage({ jar, proxy }) {
  const page = httpRequest({ method: 'GET', url: SIGNUP_URL, jar, proxy });
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
export function signupPrecheck(fp, { proxy }) {
  const r = httpRequest({ method: 'GET', url: `https://tokenharbor.ai/api/auth/signup-precheck?fp=${encodeURIComponent(fp)}`, proxy });
  try {
    return JSON.parse(r.body);
  } catch {
    return { needCaptcha: true, parseError: r.body.slice(0, 80) };
  }
}

/** POST the signup server action. Expect 303 + Supabase session cookie in jar. */
export function postSignup({ email, password, invite, fp, timezone = 'Asia/Shanghai', actionKey, actionMeta, actionArgs, jar, proxy }) {
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

/** Open a verify link; returns redirect URL (expect /dashboard?verify=success). */
export function openVerify(link, { jar, proxy }) {
  return httpRequest({ method: 'GET', url: link, jar, proxy, timeout: 20000 });
}

/**
 * Ask the app to (re)send the verification email. Reverse-engineered from the
 * dashboard bundle: the "Verify email" button does a bare `POST` with no body.
 * Registration does not reliably send the mail on its own, so the pure-protocol
 * path triggers it explicitly.
 */
export function sendVerificationEmail({ jar, proxy }) {
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
export function giftsStatus({ jar, proxy }) {
  return httpRequest({ method: 'GET', url: `${HOST}/api/gifts/status`, jar, proxy, timeout: 20000 });
}

/**
 * Claim the $5 welcome grant (bare POST, no body — same as the dashboard).
 * 200 -> { ok: true, rewardUsd: 5, newTrialBalance: 5 }
 * 403 `email_not_verified` -> the mailbox link must be opened first.
 */
export function claimWelcomeGrant({ jar, proxy }) {
  return httpRequest({ method: 'POST', url: `${HOST}/api/welcome/claim`, jar, proxy, timeout: 25000 });
}

/** POST /api/keys; returns parsed JSON (contains `plaintext` full key). */
export function createApiKey({ label, jar, proxy }) {
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
export function enableFreeModels({ jar, proxy }) {
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

const SUPABASE_BASE = 'https://auth.tokenharbor.ai'; // tokenharbor's Supabase proxy (public anon key)
const SUPABASE_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlzYm56bXdqbXRpdWlwZXNnbW1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3NjU1MzYsImV4cCI6MjA5MjM0MTUzNn0.CodUcchio6jNW_k68vaAb--LshBQXK51tZ6VTxNSz_A';

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

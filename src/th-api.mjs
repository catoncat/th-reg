// TokenHarbor / Supabase account-level query layer — the single authoritative
// implementation for anything that asks "what does this account actually have".
//
// Before this module existed, the same queries were copy-pasted across
// http.mjs, th-board.mjs, and ad-hoc verification scripts. They now live here
// once, and every consumer (pool, gateway, board, register) imports from here.
//
// Data sources (all pure HTTP, no browser):
//   - auth.tokenharbor.ai  = tokenharbor's Supabase proxy (public anon key).
//     Password grant -> JWT -> /rest/v1/{wallets,transactions,credit_grants}.
//   - tokenharbor.ai/v1    = the OpenAI-compatible chat API (key health probe).

export const SUPABASE_BASE = 'https://auth.tokenharbor.ai';
// Public Supabase anon key — shipped in tokenharbor's frontend JS, public by
// design. Override with TH_SUPABASE_ANON_KEY if it ever rotates.
export const SUPABASE_ANON =
  process.env.TH_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlzYm56bXdqbXRpdWlwZXNnbW1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3NjU1MzYsImV4cCI6MjA5MjM0MTUzNn0.CodUcchio6jNW_k68vaAb--LshBQXK51tZ6VTxNSz_A';
export const API_BASE = 'https://tokenharbor.ai/v1';

const TIMEOUT = 25000;
const RETRIES = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fetch JSON with bounded backoff for the provider's transient TLS/429 errors. */
async function fetchJson(url, { method = 'GET', headers = {}, body } = {}) {
  let last;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const r = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT),
      });
      const json = await r.json().catch(() => null);
      last = { ok: r.ok, status: r.status, json };
      const rateLimited = r.status === 429 || /rate limit|too many requests/i.test(JSON.stringify(json || ''));
      if (!rateLimited || attempt === RETRIES - 1) return last;
    } catch (error) {
      last = { ok: false, status: 0, json: { error: String(error).slice(0, 120) } };
      if (attempt === RETRIES - 1) return last;
    }
    await sleep(800 * 2 ** attempt);
  }
  return last;
}

/** Supabase password grant -> { token, uid } or { error }. */
export async function login(email, password) {
  try {
    const r = await fetchJson(`${SUPABASE_BASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON, 'content-type': 'application/json' },
      body: { email, password },
    });
    const d = r.json;
    if (!r.ok || !d?.access_token || !d?.user?.id) {
      return { error: d?.error_description || d?.msg || `login http ${r.status}` };
    }
    return { token: d.access_token, uid: d.user.id };
  } catch (e) {
    return { error: String(e).slice(0, 120) };
  }
}

function rest(session, table, query) {
  return fetchJson(`${SUPABASE_BASE}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${session.token}` },
  });
}

/** Wallet -> { balanceTrial, balancePaid, bonusLocked, spend, ... } or { error }. */
export async function fetchWallet(session) {
  if (session.error) return { error: session.error };
  const r = await rest(
    session,
    'wallets',
    'select=balance_trial,balance_paid,balance_bonus_locked,api_cumulative_spend,daily_request_used,daily_request_quota' +
      `&user_id=eq.${session.uid}`,
  );
  const w = Array.isArray(r.json) ? r.json[0] : null;
  if (!w) return { error: `wallet http ${r.status}` };
  return {
    balanceTrial: Number(w.balance_trial) || 0,
    balancePaid: Number(w.balance_paid) || 0,
    bonusLocked: Number(w.balance_bonus_locked) || 0,
    spend: Number(w.api_cumulative_spend) || 0,
    dailyUsed: w.daily_request_used ?? null,
    dailyQuota: w.daily_request_quota ?? null,
  };
}

/** Total spendable balance (trial + paid; locked bonus excluded). */
export function totalBalance(w) {
  return (w.balanceTrial || 0) + (w.balancePaid || 0);
}

/** Consumption transactions -> [{ createdAt, amount, model, source }]. */
export async function fetchTransactions(session, { limit = 200 } = {}) {
  if (session.error) return { error: session.error };
  const r = await rest(
    session,
    'transactions',
    `select=created_at,amount,meta&user_id=eq.${session.uid}&type=eq.consume&order=created_at.desc&limit=${limit}`,
  );
  if (!Array.isArray(r.json)) return { error: `transactions http ${r.status}` };
  return r.json.map((t) => ({
    createdAt: t.created_at,
    amount: Math.abs(Number(t.amount) || 0),
    model: t.meta?.model || '?',
    source: t.balance_source || null,
  }));
}

/** Credit grants -> [{ amountUsd, expiresAt, reclaimedAt, reason }]. */
export async function fetchGrants(session) {
  if (session.error) return { error: session.error };
  const r = await rest(
    session,
    'credit_grants',
    `select=amount_usd,expires_at,reclaimed_at,meta&user_id=eq.${session.uid}&order=created_at.desc`,
  );
  if (!Array.isArray(r.json)) return { error: `grants http ${r.status}` };
  return r.json.map((g) => ({
    amountUsd: Number(g.amount_usd) || 0,
    expiresAt: g.expires_at || null,
    reclaimedAt: g.reclaimed_at || null,
    reason: g.meta?.reason || null,
  }));
}

/**
 * Full account snapshot in one call: login + wallet (+optional grants/tx).
 * Returns { email, error? , ...walletFields, total, grants?, transactions? }.
 */
export async function accountSnapshot(email, password, { withGrants = false, withTransactions = false } = {}) {
  const session = await login(email, password);
  if (session.error) return { email, error: session.error };
  const wallet = await fetchWallet(session);
  if (wallet.error) return { email, error: wallet.error };
  const snap = { email, ...wallet, total: totalBalance(wallet) };
  if (withGrants) snap.grants = await fetchGrants(session);
  if (withTransactions) snap.transactions = await fetchTransactions(session);
  return snap;
}

/**
 * Probe one API key's health with a 1-token request (cheapest possible call).
 * Returns { ok, status, reason } where reason ∈
 *   ok | dead(401) | balance(403 balance_zero / 402) | quota(429) | network | unknown.
 *
 * IMPORTANT: tokenharbor returns 403 code=balance_zero when the wallet is
 * empty — NOT 402/insufficient. Missing that mapping previously left every
 * exhausted key marked "ok", which is why the rotator kept picking dead keys.
 */
export async function probeKey(key, { model = 'deepseek-v4-pro' } = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch {
    return { ok: false, status: 0, reason: 'network' };
  }
  const status = res.status;
  if (status === 200) return { ok: true, status, reason: 'ok' };
  let code = '';
  try {
    code = (await res.json())?.error?.code || '';
  } catch { /* not json */ }
  if (status === 401 || code === 'unauthorized') return { ok: false, status, reason: 'dead', error: code };
  if (status === 402 || code === 'balance_zero' || /insufficient|balance/i.test(code))
    return { ok: false, status, reason: 'balance', error: code };
  if (status === 429 || /rate|limit|quota/i.test(code)) return { ok: false, status, reason: 'quota', error: code };
  if (status >= 500) return { ok: false, status, reason: 'network', error: `http ${status}` };
  return { ok: false, status, reason: 'unknown', error: code || `http ${status}` };
}

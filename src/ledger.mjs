// Append-only pool ledger.
//
// Money facts only move forward as events. Fold derives the current per-key
// view. Gateway hard-failure signals (exhausted/dead) and supply openings are
// the primary writers; rare reconcile/warm passes write absolute balances.
//
// Event types:
//   open        new funded key enters the pool (balance may be known or null)
//   set_balance absolute balance observation (warm / reconcile / wallet read)
//   exhausted   upstream proved the wallet empty (402 / balance_zero)
//   dead        upstream proved the key unusable (401)
//   used        key served ≥1 successful request (fact only; no money change)
//   consume     soft debit between $5 and $0 (local estimate; optional fill)

//
// Readers (CLI, supply, /health) fold this file or trust the gateway's
// in-memory fold — they do NOT re-login every account.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

export function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {string} filePath
 */
export function createLedger(filePath) {
  const dir = dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* exists */
  }

  let seq = 0;
  // Boot: count existing lines so seq is monotonic across restarts.
  if (existsSync(filePath)) {
    try {
      const text = readFileSync(filePath, 'utf8');
      for (const line of text.split('\n')) {
        if (line.trim().startsWith('{')) seq++;
      }
    } catch {
      /* empty */
    }
  }

  function append(event) {
    const row = {
      seq: ++seq,
      at: event.at || nowIso(),
      ...event,
    };
    // re-apply seq/at in case event carried stale copies
    row.seq = seq;
    row.at = event.at || row.at;
    if (row.balance != null) row.balance = round4(row.balance);
    if (row.amount != null) row.amount = round4(row.amount);
    try {
      appendFileSync(filePath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    } catch {
      /* best effort — never break the request path */
    }
    return row;
  }

  function readEvents() {
    if (!existsSync(filePath)) return [];
    const out = [];
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s.startsWith('{')) continue;
      try {
        out.push(JSON.parse(s));
      } catch {
        /* skip bad line */
      }
    }
    return out;
  }

  /**
   * Fold events into a per-keyFile view.
   */
  function fold() {
    /** @type {Map<string, object>} */
    const keys = new Map();
    let asOf = null;
    let maxSeq = 0;

    for (const ev of readEvents()) {
      if (!ev.keyFile && !ev.email) continue;
      const id = ev.keyFile || `email:${ev.email}`;
      const rec = keys.get(id) || {
        keyFile: ev.keyFile || null,
        email: ev.email || null,
        status: 'ok',
        balance: null,
        balanceKnown: false,
        updatedAt: null,
      };
      if (ev.keyFile) rec.keyFile = ev.keyFile;
      if (ev.email) rec.email = ev.email;
      if (ev.seq != null && ev.seq > maxSeq) maxSeq = ev.seq;
      if (ev.at) {
        rec.updatedAt = ev.at;
        asOf = ev.at;
      }

      switch (ev.type) {
        case 'open':
          rec.status = 'ok';
          if (ev.balance != null) {
            rec.balance = round4(ev.balance);
            rec.balanceKnown = true;
            if (rec.balance <= 0.01) {
              rec.status = 'exhausted';
              rec.balance = 0;
            }
          } else {
            // Presence-only: key is in the pool, dollars not yet observed.
            rec.balanceKnown = false;
          }
          break;
        case 'set_balance':
          rec.balance = round4(ev.balance);
          rec.balanceKnown = true;
          if (rec.balance <= 0.01) {
            rec.status = 'exhausted';
            rec.balance = 0;
          } else if (rec.status === 'exhausted' || rec.status === 'dead') {
            rec.status = 'ok';
          }
          break;
        case 'exhausted':
          rec.status = 'exhausted';
          rec.balance = 0;
          rec.balanceKnown = true;
          break;
        case 'dead':
          rec.status = 'dead';
          rec.balance = 0;
          rec.balanceKnown = true;
          break;
        case 'used':
          // Fact only: this key has been observed serving traffic.
          rec.used = true;
          break;
        case 'consume': {
          const amt = Math.abs(Number(ev.amount) || 0);
          if (rec.balance != null && rec.balanceKnown) {
            rec.balance = round4(Math.max(0, rec.balance - amt));
            if (rec.balance <= 0.01) {
              rec.status = 'exhausted';
              rec.balance = 0;
            }
          }
          break;
        }
        default:
          break;
      }
      keys.set(id, rec);
    }

    let totalBalance = 0;
    let knownBalanceKeys = 0;
    let unknownBalanceKeys = 0;
    let activeKeys = 0;
    let exhaustedKeys = 0;
    let deadKeys = 0;

    for (const rec of keys.values()) {
      if (rec.status === 'dead') deadKeys++;
      else if (rec.status === 'exhausted') exhaustedKeys++;
      else activeKeys++;

      if (rec.status === 'exhausted' || rec.status === 'dead') {
        knownBalanceKeys++;
      } else if (rec.balanceKnown && rec.balance != null) {
        knownBalanceKeys++;
        totalBalance += rec.balance;
      } else {
        unknownBalanceKeys++;
      }
    }

    return {
      keys,
      totalBalance: round4(totalBalance),
      knownBalanceKeys,
      unknownBalanceKeys,
      activeKeys,
      exhaustedKeys,
      deadKeys,
      totalKeys: keys.size,
      asOf,
      seq: maxSeq || seq,
    };
  }

  /**
   * Seed ledger from current pool records when the file is empty.
   * @param {Array<object>} records pool.all()
   * @param {string} [source]
   */
  function seedFromPool(records, source = 'seed') {
    if (seq > 0) return 0;
    let n = 0;
    const at = nowIso();
    for (const r of records) {
      const keyFile = r.file;
      const email = r.email || null;
      if (r.status === 'exhausted') {
        append({ type: 'exhausted', keyFile, email, at, source, reason: r.lastError || 'seed' });
      } else if (r.status === 'dead') {
        append({ type: 'dead', keyFile, email, at, source, reason: r.lastError || 'seed' });
      } else if (r.balance != null) {
        append({
          type: r.balance > 0.01 ? 'set_balance' : 'exhausted',
          keyFile,
          email,
          balance: r.balance > 0.01 ? r.balance : 0,
          at,
          source,
        });
      } else {
        append({ type: 'open', keyFile, email, balance: null, at, source: `${source}:unknown` });
      }
      n++;
    }
    return n;
  }

  return {
    path: filePath,
    append,
    fold,
    readEvents,
    seedFromPool,
    get seq() {
      return seq;
    },
  };
}

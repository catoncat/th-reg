// Key pool state machine — the heart of the product.
//
// It builds an in-memory pool from data/accounts.jsonl + ~/.pi/agent/secrets,
// hands out one healthy key per request, and immediately retires a key the
// moment the gateway reports a hard failure (401/402/403). State persists to
// data/pool-state.json so restarts don't resurrect dead keys.
//
// Balance accounting is append-only via an optional Ledger (see ledger.mjs):
//   open / set_balance / exhausted / dead / consume
// Gateway traffic is the primary signal for exhausted/dead (= $0). Readers
// should prefer healthSnapshot() over re-logging into every account.
//
// Status lifecycle:
//   registering -> ok -> exhausted | dead | quota
//   quota/exhausted can recover on probe; dead is terminal.
//
// This is what the old rotate.sh + th-board pair could never do: learn from a
// failed request and avoid that key within the SAME request. Pi's `!command`
// apiKey mechanism runs stateless per request, so failure could never feed
// back. The pool lives in the gateway process, so it can.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from './ledger.mjs';

/** Default secrets dir, overridable per-instance. */
const DEFAULT_SECRETS_DIR = join(process.env.HOME || '', '.pi', 'agent', 'secrets');

export class Pool {
  /**
   * @param {object} opts
   * @param {string} opts.accountsFile  data/accounts.jsonl
   * @param {string} opts.stateFile     data/pool-state.json
   * @param {string} [opts.secretsDir]  defaults to ~/.pi/agent/secrets (or TH_SECRETS_DIR)
   * @param {{append: Function, seedFromPool?: Function, seq?: number}|null} [opts.ledger]
   */
  constructor({
    accountsFile,
    stateFile,
    secretsDir = DEFAULT_SECRETS_DIR,
    ledger = null,
    currentKeyFile = null,
  }) {
    this.accountsFile = accountsFile;
    this.stateFile = stateFile;
    this.secretsDir = secretsDir;
    this.currentKeyFile = currentKeyFile;
    /** @type {{append: Function, seedFromPool?: Function, seq?: number}|null} */
    this.ledger = ledger;
    /** @type {Map<string, object>} key -> record */
    this.keys = new Map();
    this.rr = 0; // round-robin cursor
    this._load();
  }

  /** Attach a ledger after construction (and optionally seed it). */
  setLedger(ledger, { seed = true } = {}) {
    this.ledger = ledger;
    if (seed && ledger && typeof ledger.seedFromPool === 'function') {
      const n = ledger.seedFromPool(this.all(), 'pool-boot');
      if (n) this._note = `seeded ledger with ${n} event(s)`;
    }
  }

  _emit(event) {
    if (!this.ledger) return;
    try {
      this.ledger.append(event);
    } catch {
      /* never break serving path */
    }
  }

  _loadAccounts() {
    if (!existsSync(this.accountsFile)) return new Map();
    const byKey = new Map();
    for (const line of readFileSync(this.accountsFile, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s.startsWith('{')) continue;
      try {
        const a = JSON.parse(s);
        if (a.api_key) {
          const trial = Number(a.balance_trial);
          const paid = Number(a.balance_paid);
          const opening =
            Number.isFinite(trial) || Number.isFinite(paid)
              ? (Number.isFinite(trial) ? trial : 0) + (Number.isFinite(paid) ? paid : 0)
              : null;
          byKey.set(a.api_key, {
            email: a.email,
            password: a.password,
            openingBalance: opening,
          });
        }
      } catch {
        /* skip bad line */
      }
    }
    return byKey;
  }

  _loadSecretKeys() {
    if (!existsSync(this.secretsDir)) return [];
    return readdirSync(this.secretsDir)
      .filter((f) => f.startsWith('tokenharbor-api-key') && !f.endsWith('.tmp'))
      .sort()
      .map((f) => ({ file: f, key: readFileSync(join(this.secretsDir, f), 'utf8').trim() }))
      .filter((x) => x.key);
  }

  _loadPersisted() {
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf8'));
    } catch {
      return {};
    }
  }

  _load() {
    const accts = this._loadAccounts();
    const persisted = this._loadPersisted();
    for (const { file, key } of this._loadSecretKeys()) {
      const acct = accts.get(key) || {};
      const p = persisted[file] || {};
      // Prefer persisted balance (learned); else registration opening balance.
      const balance = p.balance != null ? p.balance : acct.openingBalance ?? null;
      this.keys.set(key, {
        file,
        key,
        email: acct.email || p.email || null,
        password: acct.password || p.password || null,
        status: p.status || 'ok', // ok | exhausted | dead | quota | registering
        balance,
        lastError: p.lastError || null,
        lastUsed: null,
        failCount: p.failCount || 0,
      });
    }
  }

  _persist() {
    const out = {};
    const updated = nowIso();
    for (const rec of this.keys.values()) {
      out[rec.file] = {
        status: rec.status,
        email: rec.email,
        balance: rec.balance,
        lastError: rec.lastError,
        failCount: rec.failCount,
        updated_at: updated,
      };
    }
    try {
      writeFileSync(this.stateFile, JSON.stringify(out, null, 2), { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  /**
   * Re-scan the secrets dir and accounts file, adopting keys that appeared
   * after boot (supply registers new funded accounts while we stay resident).
   * Existing records keep their learned status/balance; only identity gaps are
   * backfilled. Returns the number of newly adopted keys.
   */
  refresh() {
    const accts = this._loadAccounts();
    let added = 0;
    const at = nowIso();
    for (const { file, key } of this._loadSecretKeys()) {
      const known = this.keys.get(key);
      if (known) {
        if (!known.email) {
          const a = accts.get(key);
          if (a) {
            known.email = a.email;
            known.password = a.password;
          }
        }
        continue;
      }
      const acct = accts.get(key) || {};
      const balance = acct.openingBalance != null ? acct.openingBalance : null;
      this.keys.set(key, {
        file,
        key,
        email: acct.email || null,
        password: acct.password || null,
        status: 'ok', // supply only persists keys for funded accounts
        balance,
        lastError: null,
        lastUsed: null,
        failCount: 0,
      });
      this._emit({
        type: 'open',
        keyFile: file,
        email: acct.email || null,
        balance,
        at,
        source: 'supply-adopt',
      });
      added++;
    }
    if (added) this._persist();
    return added;
  }

  /** All records as an array (for board / snapshots). */
  all() {
    return [...this.keys.values()].sort((a, b) => a.file.localeCompare(b.file));
  }

  /** Keys currently eligible to serve a request. */
  activeKeys() {
    return this.all().filter((r) => r.status === 'ok' || r.status === 'quota');
  }

  activeCount() {
    return this.activeKeys().length;
  }

  /**
   * Sum of known balances for non-retired keys. Exhausted/dead contribute 0.
   * Keys with status ok|quota and balance == null are excluded (see unknownBalanceKeys).
   */
  totalBalance() {
    return this.healthSnapshot().totalBalance;
  }

  /**
   * Cheap, local view of pool health — the thing CLI/supply should read.
   * No network. Exhausted/dead are hard $0 from gateway traffic.
   * @param {{currentKeyFile?: string}} [opts]
   */
  healthSnapshot(opts = {}) {
    let totalBalance = 0;
    let knownBalanceKeys = 0;
    let unknownBalanceKeys = 0;
    let activeKeys = 0;
    let exhaustedKeys = 0;
    let deadKeys = 0;
    let quotaKeys = 0;
    const keys = [];

    let currentKey = '';
    const currentKeyFile = opts.currentKeyFile || this.currentKeyFile;
    if (currentKeyFile && existsSync(currentKeyFile)) {
      try {
        currentKey = readFileSync(currentKeyFile, 'utf8').trim();
      } catch {
        /* ignore */
      }
    }

    let current = null;
    for (const r of this.all()) {
      const retired = r.status === 'exhausted' || r.status === 'dead';
      if (r.status === 'dead') deadKeys++;
      else if (r.status === 'exhausted') exhaustedKeys++;
      else if (r.status === 'quota') {
        quotaKeys++;
        activeKeys++;
      } else if (r.status === 'ok') {
        activeKeys++;
      }

      let balance = null;
      let balanceKnown = false;
      if (retired) {
        balance = 0;
        balanceKnown = true;
        knownBalanceKeys++;
      } else if (r.balance != null) {
        balance = Number(r.balance) || 0;
        balanceKnown = true;
        knownBalanceKeys++;
        totalBalance += balance;
      } else {
        unknownBalanceKeys++;
      }

      const isCurrent = currentKey && r.key === currentKey;
      const row = {
        file: r.file,
        status: r.status,
        balance,
        balanceKnown,
        email: r.email,
        lastError: r.lastError,
        lastUsed: r.lastUsed,
        current: !!isCurrent,
      };
      if (isCurrent) current = row;
      keys.push(row);
    }

    return {
      ok: activeKeys > 0,
      source: 'gateway-memory',
      asOf: nowIso(),
      activeKeys,
      exhaustedKeys,
      deadKeys,
      quotaKeys,
      totalKeys: keys.length,
      totalBalance: Math.round(totalBalance * 100) / 100,
      knownBalanceKeys,
      unknownBalanceKeys,
      ledgerSeq: this.ledger?.seq ?? null,
      current: current
        ? { email: current.email, file: current.file, balance: current.balance, status: current.status }
        : null,
      keys,
    };
  }

  /**
   * Borrow the next active key (round-robin). Returns the record or null when
   * the pool is exhausted. `exclude` lets the gateway skip keys already tried
   * within the current request.
   */
  borrowKey(exclude = new Set()) {
    const active = this.activeKeys().filter((r) => !exclude.has(r.key));
    if (active.length === 0) return null;
    this.rr = (this.rr + 1) % active.length;
    const rec = active[this.rr];
    rec.lastUsed = nowIso();
    return rec;
  }

  /**
   * Report the outcome of a request that used `key`. Hard failures retire the
   * key immediately and persist, so the next borrowKey() skips it — within the
   * same request via `exclude`, and across requests via status.
   *
   * Exhausted/dead are hard balance facts (= $0) and are appended to the ledger.
   *
   * @param {string} key
   * @param {{ok:boolean, reason?:string, error?:string, balance?:number}} outcome
   */
  report(key, outcome) {
    const rec = this.keys.get(key);
    if (!rec) return;
    const at = nowIso();
    if (outcome.ok) {
      rec.status = 'ok';
      rec.lastError = null;
      rec.failCount = 0;
      if (outcome.balance != null) {
        rec.balance = outcome.balance;
        this._emit({
          type: 'set_balance',
          keyFile: rec.file,
          email: rec.email,
          balance: outcome.balance,
          at,
          source: 'gateway-ok',
        });
      }
    } else {
      rec.failCount = (rec.failCount || 0) + 1;
      rec.lastError = outcome.error || outcome.reason || 'unknown';
      if (outcome.reason === 'dead') {
        rec.status = 'dead';
        rec.balance = 0;
        this._emit({
          type: 'dead',
          keyFile: rec.file,
          email: rec.email,
          at,
          source: 'gateway',
          reason: rec.lastError,
        });
      } else if (outcome.reason === 'balance') {
        rec.status = 'exhausted';
        rec.balance = 0;
        this._emit({
          type: 'exhausted',
          keyFile: rec.file,
          email: rec.email,
          at,
          source: 'gateway',
          reason: rec.lastError,
        });
      } else if (outcome.reason === 'quota') {
        rec.status = 'quota';
        // quota is not a balance fact — leave balance alone, no ledger write
      }
      // network/unknown: leave status, just record the error (transient)
    }
    this._persist();
  }

  /** Update a key's known balance (from a periodic snapshot / warm). */
  setBalance(key, balance, { source = 'reconcile', status = null } = {}) {
    const rec = this.keys.get(key);
    if (!rec) return;
    const at = nowIso();
    const b = Number(balance);
    if (!Number.isFinite(b)) return;
    rec.balance = b;
    if (status) rec.status = status;
    else if (b <= 0.01) {
      rec.status = 'exhausted';
      rec.balance = 0;
    } else if (rec.status === 'exhausted' || rec.status === 'dead') {
      rec.status = 'ok';
    }
    this._emit({
      type: b <= 0.01 ? 'exhausted' : 'set_balance',
      keyFile: rec.file,
      email: rec.email,
      balance: rec.balance,
      at,
      source,
    });
    this._persist();
  }

  /** Add a freshly registered account and make it immediately borrowable. */
  
  /**
   * Append-only spend: subtract from in-memory balance + ledger consume.
   * No network. Used by gateway on every successful upstream response.
   */
  consume(key, amount, { model = null, usage = null, source = 'gateway' } = {}) {
    const rec = this.keys.get(key);
    if (!rec) return null;
    const amt = Math.abs(Number(amount) || 0);
    if (!(amt > 0)) return null;
    const at = nowIso();
    // If we never learned a balance, assume opening $5 (welcome grant) so the
    // first consumes still move the needle instead of staying stuck at book $5
    // forever after a seed that wrote 5 without subsequent updates.
    if (rec.balance == null || !Number.isFinite(Number(rec.balance))) {
      rec.balance = 5;
    }
    const next = Math.round(Math.max(0, Number(rec.balance) - amt) * 10000) / 10000;
    rec.balance = next;
    rec.lastUsed = at;
    rec.lastError = null;
    if (rec.status === 'dead') {
      /* keep dead */
    } else if (next <= 0.01) {
      rec.status = 'exhausted';
      rec.balance = 0;
      this._emit({
        type: 'exhausted',
        keyFile: rec.file,
        email: rec.email,
        at,
        source,
        reason: 'consume_to_zero',
        model: model || undefined,
      });
    } else {
      rec.status = 'ok';
      this._emit({
        type: 'consume',
        keyFile: rec.file,
        email: rec.email,
        amount: amt,
        balance: next,
        at,
        source,
        model: model || undefined,
        usage: usage || undefined,
      });
    }
    return { balance: rec.balance, status: rec.status, amount: amt };
  }

  addAccount({ email, password, apiKey, balance = null }) {
    let n = 1;
    const names = new Set([...this.keys.values()].map((r) => r.file));
    while (names.has(`tokenharbor-api-key-${n}`)) n++;
    const file = `tokenharbor-api-key-${n}`;
    this.keys.set(apiKey, {
      file,
      key: apiKey,
      email,
      password,
      status: 'ok',
      balance,
      lastError: null,
      lastUsed: null,
      failCount: 0,
    });
    this._emit({
      type: 'open',
      keyFile: file,
      email,
      balance,
      at: nowIso(),
      source: 'addAccount',
    });
    this._persist();
    return file;
  }
}

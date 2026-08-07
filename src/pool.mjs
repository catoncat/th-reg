// Key pool state machine — the heart of the product.
//
// It builds an in-memory pool from data/accounts.jsonl + ~/.pi/agent/secrets,
// hands out one healthy key per request, and immediately retires a key the
// moment the gateway reports a hard failure (401/402/403). State persists to
// data/pool-state.json so restarts don't resurrect dead keys.
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
import { join, basename } from 'node:path';

/** Default secrets dir, overridable per-instance. */
const DEFAULT_SECRETS_DIR = join(process.env.HOME || '', '.pi', 'agent', 'secrets');

export class Pool {
  /**
   * @param {object} opts
   * @param {string} opts.accountsFile  data/accounts.jsonl
   * @param {string} opts.stateFile     data/pool-state.json
   * @param {string} [opts.secretsDir]  defaults to ~/.pi/agent/secrets (or TH_SECRETS_DIR)
   */
  constructor({ accountsFile, stateFile, secretsDir = DEFAULT_SECRETS_DIR }) {
    this.accountsFile = accountsFile;
    this.stateFile = stateFile;
    this.secretsDir = secretsDir;
    /** @type {Map<string, object>} key -> record */
    this.keys = new Map();
    this.rr = 0; // round-robin cursor
    this._load();
  }

  _loadAccounts() {
    if (!existsSync(this.accountsFile)) return new Map();
    const byKey = new Map();
    for (const line of readFileSync(this.accountsFile, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s.startsWith('{')) continue;
      try {
        const a = JSON.parse(s);
        if (a.api_key) byKey.set(a.api_key, { email: a.email, password: a.password });
      } catch { /* skip bad line */ }
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
      this.keys.set(key, {
        file,
        key,
        email: acct.email || p.email || null,
        password: acct.password || p.password || null,
        status: p.status || 'ok', // ok | exhausted | dead | quota | registering
        balance: p.balance ?? null,
        lastError: p.lastError || null,
        lastUsed: null,
        failCount: p.failCount || 0,
      });
    }
  }

  _persist() {
    const out = {};
    for (const rec of this.keys.values()) {
      out[rec.file] = {
        status: rec.status,
        email: rec.email,
        balance: rec.balance,
        lastError: rec.lastError,
        failCount: rec.failCount,
        updated_at: new Date().toISOString(),
      };
    }
    try {
      writeFileSync(this.stateFile, JSON.stringify(out, null, 2), { mode: 0o600 });
    } catch { /* best effort */ }
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

  totalBalance() {
    return this.all().reduce((s, r) => s + (r.status === 'ok' ? r.balance || 0 : 0), 0);
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
    rec.lastUsed = new Date().toISOString();
    return rec;
  }

  /**
   * Report the outcome of a request that used `key`. Hard failures retire the
   * key immediately and persist, so the next borrowKey() skips it — within the
   * same request via `exclude`, and across requests via status.
   *
   * @param {string} key
   * @param {{ok:boolean, reason?:string, error?:string, balance?:number}} outcome
   */
  report(key, outcome) {
    const rec = this.keys.get(key);
    if (!rec) return;
    if (outcome.ok) {
      rec.status = 'ok';
      rec.lastError = null;
      rec.failCount = 0;
      if (outcome.balance != null) rec.balance = outcome.balance;
    } else {
      rec.failCount = (rec.failCount || 0) + 1;
      rec.lastError = outcome.error || outcome.reason || 'unknown';
      if (outcome.reason === 'dead') rec.status = 'dead';
      else if (outcome.reason === 'balance') rec.status = 'exhausted';
      else if (outcome.reason === 'quota') rec.status = 'quota';
      // network/unknown: leave status, just record the error (transient)
    }
    this._persist();
  }

  /** Update a key's known balance (from a periodic snapshot). */
  setBalance(key, balance) {
    const rec = this.keys.get(key);
    if (rec) {
      rec.balance = balance;
      this._persist();
    }
  }

  /** Add a freshly registered account and make it immediately borrowable. */
  addAccount({ email, password, apiKey, balance = null }) {
    // store under a deterministic file slot name
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
    this._persist();
    return file;
  }
}

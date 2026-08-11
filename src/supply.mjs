// Supply — keeps the TokenHarbor pool topped up to a target balance.
//
// First-principles design:
//   * One account = $5 welcome credit. An account is disposable: once spent it
//     is abandoned, never nursed back.
//   * We can read every account's balance over the API (th-api.accountSnapshot),
//     so we refill EARLY — before the pool runs dry — instead of reacting to a
//     failed request. Refill is a steady background habit, not an emergency fix.
//   * Pi points at a single static key file (`tokenharbor-current`). Supply makes
//     sure that file always holds a funded key. No round-robin, no rotation, no
//     gateway, no "retry on 403": the current pointer simply never points at an
//     empty account because a fresh one is registered before that can happen.
//
// Run it on a schedule (launchd) or by hand: `node src/th-supply.mjs`.
//
// Paths are read from config (cfg.secretsDir, cfg.currentKeyFile, etc.) whose
// defaults point at ~/.pi/agent/secrets — override via env vars for your setup.

import { readFileSync, writeFileSync, existsSync, appendFileSync, openSync, writeSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, randomHex } from './config.mjs';
import { registerOne } from './register.mjs';
import { generateUsername } from './names.mjs';
import { DomainAllocator, loadCfEnv } from './domains.mjs';
import { accountSnapshot } from './th-api.mjs';
import { createSignupPacer } from './pacer.mjs';
import { sleep } from './mailbox.mjs';

const log = (m) => console.log(`[supply] ${m}`);

/** Load account records that actually produced a usable key. */
function loadUsableAccounts(accountsFile) {
  if (!existsSync(accountsFile)) return [];
  const seen = new Map(); // email -> latest record
  for (const line of readFileSync(accountsFile, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const a = JSON.parse(s);
      if (a.email && a.password && a.api_key) seen.set(a.email, a);
    } catch { /* skip */ }
  }
  return [...seen.values()];
}

/** Cheap gateway /health — preferred over full-fleet Supabase login. */
async function gatewayHealth() {
  try {
    const host = process.env.TH_GATEWAY_HOST || '127.0.0.1';
    const port = process.env.TH_GATEWAY_PORT || 19672;
    const base = process.env.TH_GATEWAY_URL || `http://${host}:${port}`;
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * Sum spendable balance across every account that has a key.
 * Prefers gateway health (exhausted=$0 from live traffic, no Supabase login).
 * Falls back to serial accountSnapshot only when the gateway is down.
 */
async function poolBalance(accounts, log) {
  const health = await gatewayHealth();
  if (health && (health.totalKeys > 0 || (health.keys && health.keys.length))) {
    const byEmail = new Map();
    for (const k of health.keys || []) {
      if (k.email) byEmail.set(k.email, k);
    }
    let matched = 0;
    for (const a of accounts) {
      const k = byEmail.get(a.email);
      if (!k) continue;
      matched++;
      if (k.status === 'exhausted' || k.status === 'dead') a._balance = 0;
      else if (k.balance != null) a._balance = Number(k.balance) || 0;
    }
    const total = Number(health.totalBalance) || 0;
    const funded = health.activeKeys ?? accounts.filter((a) => (a._balance || 0) > 0.01).length;
    log(
      `  via gateway: $${total.toFixed(2)} known across ${funded} active` +
        ` (${health.unknownBalanceKeys || 0} balance-unknown; ${matched} emails matched)`,
    );
    return { total, funded, source: 'gateway', health };
  }

  log('  gateway unavailable; falling back to live Supabase snapshots (slow)');
  let total = 0;
  let funded = 0;
  for (const a of accounts) {
    const snap = await accountSnapshot(a.email, a.password);
    if (snap.error) {
      log(`  balance? ${a.email}: ${snap.error}`);
      continue;
    }
    if (snap.total > 0.01) {
      total += snap.total;
      funded++;
    }
    a._balance = snap.total;
  }
  return { total, funded, source: 'live' };
}

/** Write the current-pointer key file so Pi always reads a funded key. */
function setCurrentKey(apiKey, cfg) {
  writeFileSync(cfg.currentKeyFile, apiKey.trim() + '\n', { mode: 0o600 });
}

/** Persist a new key into the secrets pool (next free slot). O_EXCL-safe for workers. */
function persistKey(apiKey, cfg) {
  const body = apiKey.trim() + '\n';
  for (let n = 1; n < 100000; n++) {
    const file = join(cfg.secretsDir, `tokenharbor-api-key-${n}`);
    try {
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      return file;
    } catch (e) {
      if (e && e.code === 'EEXIST') continue;
      throw e;
    }
  }
  throw new Error('persistKey: no free slot');
}

function appendAccount(accountsFile, rec) {
  appendFileSync(accountsFile, JSON.stringify(rec) + '\n', { mode: 0o600 });
}

/**
 * Register one fully-usable account end-to-end (domain + username + the pure
 * protocol chain), persist it, and return the record — or null on failure.
 */
async function registerUsable(cfg, allocator, usedNames, log, pacer) {
  const username = generateUsername(usedNames);
  const password = `TH_${randomHex(8)}!x9`;
  const domain = await allocator.next();
  const email = `${username}@${domain}`;
  const r = await registerOne(cfg, { email, password, log: (m) => log(`  ${m}`), pacer });
  r.password = password;
  appendAccount(cfg.accountsFile, r);
  let balance = 0;
  if (r.gift_claimed && r.balance_trial != null) {
    balance = Number(r.balance_trial) || 0;
  } else if (r.status === 'verified' && r.api_key) {
    // claim path did not confirm money — one wallet read
    const snap = await accountSnapshot(email, password);
    balance = snap.error ? 0 : snap.total;
  }
  const usable = !!r.api_key && balance > 0.01;
  if (usable) {
    persistKey(r.api_key, cfg);
    log(`  [+] funded account ready: ${email} (${balance.toFixed(2)})`);
  } else {
    log(`  [!] ${email} not usable (status=${r.status}${r.reject_class ? ' ' + r.reject_class : ''} key=${!!r.api_key} balance=${balance.toFixed(2)})`);
  }
  return { usable, rec: usable ? { ...r, _balance: balance } : null, rejectClass: r.reject_class || null };
}

/**
 * Top the pool up to `targetUsd`. Registers accounts in small serial batches
 * until the total spendable balance reaches the target (or we hit maxAdds).
 *
 * @param {object} opts
 * @param {object} [opts.cfg]   Config override. If omitted, loadConfig() is called.
 * @param {number} [opts.targetUsd]  Target total balance (default cfg.supplyTarget).
 * @param {number} [opts.lowWatermark]  Balance below which we switch current key.
 * @param {number} [opts.maxAdds]  Max new accounts to register (default 60).
 * @param {function} [opts.log]  Logger.
 */
export async function supply({ cfg, targetUsd, lowWatermark, maxAdds = 60, workers, log = console.log } = {}) {
  cfg = cfg || loadConfig({});
  targetUsd = targetUsd ?? cfg.supplyTarget;
  lowWatermark = lowWatermark ?? cfg.supplyLowWatermark;
  workers = Math.max(1, Math.min(8, Number(workers ?? cfg.supplyWorkers ?? 3) || 3));

  if (cfg.mailMode === 'none') {
    throw new Error('TH_MAIL_MODE=none cannot produce funded accounts; set TH_MAIL_MODE=cloud-mail');
  }

  // domain allocator (dynamic top-up if CF creds are available, else fixed pool)
  let cfEnv = null;
  if (cfg.domainMode === 'dynamic') {
    cfEnv = await loadCfEnv({ keychainDir: cfg.cfKeychainDir, scope: cfg.cfEnvchainScope });
  }
  // Do NOT size the domain pool to the full maxAdds (e.g. 220 for $1000).
  // init() would try to CF-create dozens of subdomains up front and block refill.
  // Size for near-term concurrency; DomainAllocator still reuses the allowlist.
  const domainBatch = Math.min(maxAdds, Math.max(workers * 10, 30));
  const allocator = new DomainAllocator({
    mode: cfg.domainMode,
    count: domainBatch,
    maxReuse: cfg.domainMaxReuse,
    dynamicZones: cfg.dynamicZones,
    fixedPool: cfg.fixedPool,
    singleDomain: cfg.domain,
    cfEnv,
    mailboxCli: cfg.mailboxCli,
    log: (m) => log(`  ${m}`),
  });
  await allocator.init();

  // 1. measure the pool (gateway health first — no full-fleet login)
  const accounts = loadUsableAccounts(cfg.accountsFile);
  log(`measuring ${accounts.length} account(s) with keys...`);
  let { total, funded, source: balSource } = await poolBalance(accounts, log);
  log(`pool: $${total.toFixed(2)} across ${funded} funded account(s) (target $${targetUsd}, source=${balSource || '?'})`);

  // 2. keep the current pointer on its account until that account runs low
  const currentKey = existsSync(cfg.currentKeyFile) ? readFileSync(cfg.currentKeyFile, 'utf8').trim() : '';
  const currentAcct = accounts.find((a) => a.api_key === currentKey);
  // If gateway didn't know this account's balance, do ONE live check (not the fleet).
  if (currentAcct && currentAcct._balance == null) {
    const snap = await accountSnapshot(currentAcct.email, currentAcct.password);
    if (!snap.error) currentAcct._balance = snap.total;
  }
  const currentBalance = currentAcct?._balance ?? 0;
  if (currentAcct && currentBalance > lowWatermark) {
    log(`current stays ${currentAcct.email} ($${currentBalance.toFixed(2)}; use-to-dregs)`);
  } else {
    const best = accounts
      .filter((a) => (a._balance || 0) > lowWatermark)
      .sort((x, y) => (y._balance || 0) - (x._balance || 0))[0];
    if (best) {
      setCurrentKey(best.api_key, cfg);
      log(`current -> ${best.email} ($${best._balance.toFixed(2)}; previous was empty/missing)`);
    } else {
      log('[!] no funded account to point current at yet');
    }
  }

  // 3. refill early if below target (concurrent workers)
  if (total >= targetUsd) {
    log(`pool healthy ($${total.toFixed(2)} >= $${targetUsd}); nothing to add`);
    return { added: 0, total, funded };
  }

  const usedNames = new Set(accounts.map((a) => (a.email || '').split('@')[0]));
  let added = 0;
  let consecFail = 0;
  let rateRejects = 0;
  // Rate-limit rejections are expected weather, not a broken run: the pacer
  // backs off and we keep going. Only non-rate failures (captcha, bad payload,
  // dead proxy) count toward the give-up streak.
  const MAX_CONSEC_FAIL = Math.max(4, workers * 2);
  const MAX_RATE_REJECTS = Number(process.env.TH_MAX_RATE_REJECTS || 25);
  const pacer = createSignupPacer({
    minGapMs: cfg.signupMinGapMs,
    startGapMs: cfg.signupStartGapMs,
    maxGapMs: cfg.signupMaxGapMs,
    log,
  });
  // Shared counter lock (JS single-threaded; mutex serializes critical sections across awaits)
  let chain = Promise.resolve();
  const withLock = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  log(
    `refilling with ${workers} worker(s); below target by $${(targetUsd - total).toFixed(2)} (~${Math.ceil((targetUsd - total) / 5)} account(s))`,
  );

  async function worker(id) {
    while (true) {
      const proceed = await withLock(async () => {
        if (total >= targetUsd || added >= maxAdds || consecFail >= MAX_CONSEC_FAIL) return false;
        if (rateRejects >= MAX_RATE_REJECTS) return false;
        log(
          `[w${id}] below target by $${(targetUsd - total).toFixed(2)} (added=${added}/${maxAdds}, failStreak=${consecFail}); registering...`,
        );
        return true;
      });
      if (!proceed) break;

      const out = await registerUsable(cfg, allocator, usedNames, (m) => log(`[w${id}]${m.startsWith(' ') ? '' : ' '}${m}`), pacer).catch((e) => {
        log(`  [w${id}] [fail] register: ${e.message}`);
        return { usable: false, rec: null, rejectClass: 'exception' };
      });
      const r = out?.rec || null;
      const rateRejected = out?.rejectClass === 'rate_fast' || out?.rejectClass === 'rate_network_hour';

      await withLock(async () => {
        if (r) {
          added++;
          consecFail = 0;
          total += 5;
          // Point current at a funded key as soon as we have one.
          if (!existsSync(cfg.currentKeyFile) || !readFileSync(cfg.currentKeyFile, 'utf8').trim()) {
            setCurrentKey(r.api_key, cfg);
            log(`[w${id}] current -> ${r.email} ($${(r._balance || 5).toFixed(2)})`);
          }
        } else if (rateRejected) {
          rateRejects++;
          log(`  [w${id}] [retry] rate-limited (${out.rejectClass}) ${rateRejects}/${MAX_RATE_REJECTS}; pacer gap ${(pacer.gapMs / 1000).toFixed(1)}s`);
        } else {
          consecFail++;
          log(`  [w${id}] [retry] failStreak ${consecFail}/${MAX_CONSEC_FAIL}`);
        }
      });

      // The pacer owns signup spacing now; this is only anti-spin.
      await sleep(r ? cfg.delayMs : 500);
    }
  }

  await Promise.all(Array.from({ length: workers }, (_, i) => worker(i + 1)));

  if (consecFail >= MAX_CONSEC_FAIL) {
    log(`stopped after failStreak ${MAX_CONSEC_FAIL} (likely captcha/proxy); pool $${total.toFixed(2)}`);
  }
  if (rateRejects >= MAX_RATE_REJECTS) {
    log(`stopped after ${rateRejects} rate-limit rejections; the signup bucket is dry — next scheduled run retries`);
  }
  log(
    `done: +${added} account(s); pool now ~$${total.toFixed(2)} (workers=${workers}, ` +
      `submits=${pacer.stats.slots} ok=${pacer.stats.ok} rate=${pacer.stats.fast} other=${pacer.stats.other}, ` +
      `final gap ${(pacer.gapMs / 1000).toFixed(1)}s)`,
  );
  return { added, total, funded };
}

#!/usr/bin/env node
// Gateway entry — the single static endpoint Pi points at.
//
//   node src/th-gateway.mjs [--port N] [--no-warm]
//
// On boot it:
//   1. loads the key pool from secrets + accounts.jsonl + pool-state.json
//   2. attaches an append-only ledger (data/pool-ledger.jsonl), seeding from
//      current pool-state when the ledger is empty
//   3. optionally warms balances via accountSnapshot (skipped with --no-warm;
//      launchd currently uses --no-warm because traffic teaches exhausted/dead
//      for free and full-fleet login hits Supabase rate limits)
//
// Runtime (gateway.mjs): on a hard upstream failure (401/402/403) the key is
// retired, balance pinned to $0, a ledger event is appended, and the SAME
// request retries with the next healthy key.
//
// Run under launchd (com.tokenharbor.gateway) so it stays alive and restarts.

import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { appendFileSync, truncateSync } from 'node:fs';
import { loadConfig, PROJECT_ROOT } from './config.mjs';
import { Pool } from './pool.mjs';
import { createGateway } from './gateway.mjs';
import { createLedger } from './ledger.mjs';
import { accountSnapshot } from './th-api.mjs';

const cfg = loadConfig({});
const args = process.argv.slice(2);
const warm = !args.includes('--no-warm');
const port = Number(process.env.TH_GATEWAY_PORT || 19672);
// Bind loopback only: the gateway holds the whole key pool and has no auth, so
// it must never be reachable from the LAN.
const host = process.env.TH_GATEWAY_HOST || '127.0.0.1';
// Adopt keys that supply registers while we stay resident (see Pool.refresh).
// Keep this short: new funded keys should become borrowable within seconds, not a minute.
const refreshMs = Number(process.env.TH_GATEWAY_REFRESH_MS || 15000);

const ledgerPath = process.env.TH_LEDGER_FILE || join(PROJECT_ROOT, 'data', 'pool-ledger.jsonl');
const ledger = createLedger(ledgerPath);

const pool = new Pool({
  accountsFile: join(PROJECT_ROOT, cfg.accountsFile),
  stateFile: join(PROJECT_ROOT, 'data', 'pool-state.json'),
  secretsDir: cfg.secretsDir,
  currentKeyFile: cfg.currentKeyFile,
});
pool.setLedger(ledger, { seed: true });

const ts = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const log = (m) => console.log(`[gateway] ${ts()} ${m}`);

// Short-lived routing metadata only: no prompt contents are persisted.
// The file is truncated on boot and contains project/session attribution when
// the client includes the standard pi developer context.
const requestLogPath = process.env.TH_REQUEST_LOG || join(PROJECT_ROOT, 'data', 'gateway-requests.log');
try {
  truncateSync(requestLogPath, 0);
} catch {
  /* first run / missing */
}
const requestLog = (row) => {
  try {
    appendFileSync(requestLogPath, `${row}\n`, { mode: 0o600 });
  } catch {
    /* best effort — never break the request path */
  }
};
if (pool._note) log(pool._note);

/** Warm the pool: snapshot balances, mark empty wallets exhausted. Writes ledger. */
async function warmPool() {
  const records = pool.all();
  log(`warming ${records.length} key(s)...`);
  let ok = 0;
  let exhausted = 0;
  let skipped = 0;
  for (const rec of records) {
    if (!rec.email || !rec.password) {
      skipped++;
      continue;
    }
    const snap = await accountSnapshot(rec.email, rec.password).catch(() => null);
    if (!snap || snap.error) {
      skipped++;
      continue;
    }
    if (snap.total > 0.01) {
      pool.setBalance(rec.key, snap.total, { source: 'warm', status: 'ok' });
      rec.lastError = null;
      ok++;
    } else {
      pool.setBalance(rec.key, 0, { source: 'warm', status: 'exhausted' });
      rec.lastError = 'balance_zero';
      exhausted++;
    }
  }
  log(`warm done: ${ok} funded, ${exhausted} exhausted, ${skipped} skipped (rate-limited/unknown)`);
}

// When traffic proves the pool is empty, ask launchd to run supply immediately
// (debounced). Periodic StartInterval is the backstop; this closes the gap
// between "last healthy tick" and "first 503".
let lastSupplyKickAt = 0;
const SUPPLY_KICK_DEBOUNCE_MS = Number(process.env.TH_SUPPLY_KICK_DEBOUNCE_MS || 60_000);
function requestSupplyKick(reason) {
  const now = Date.now();
  if (now - lastSupplyKickAt < SUPPLY_KICK_DEBOUNCE_MS) return;
  lastSupplyKickAt = now;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid == null) {
    log(`supply kick skipped (no uid): ${reason}`);
    return;
  }
  // No -k: do not kill an in-flight register run; launchd no-ops if already running.
  try {
    const child = spawn(
      'launchctl',
      ['kickstart', `gui/${uid}/${cfg.supplyService || 'com.tokenharbor.supply'}`],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    log(`supply kick requested (${reason})`);
  } catch (e) {
    log(`supply kick failed: ${e.message}`);
  }
}

const server = createGateway({
  pool,
  log,
  requestLog,
  onPoolExhausted: () => requestSupplyKick('pool_exhausted'),
});

server.listen(port, host, async () => {
  const snap = pool.healthSnapshot();
  log(
    `listening on ${host}:${port} (${snap.activeKeys} active / ${snap.totalKeys} keys, $${snap.totalBalance} known, ledger seq=${snap.ledgerSeq})`,
  );

  // Pick up newly supplied keys without a restart; keeps the pool from going
  // permanently dry while supply keeps registering funded accounts.
  const timer = setInterval(() => {
    try {
      const added = pool.refresh();
      if (added) {
        const s = pool.healthSnapshot();
        log(`adopted ${added} new key(s) from supply (${s.activeKeys} active, $${s.totalBalance} known)`);
      }
    } catch (e) {
      log(`refresh failed: ${e.message}`);
    }
  }, refreshMs);
  timer.unref();

  if (warm) {
    try {
      await warmPool();
      const s = pool.healthSnapshot();
      log(`post-warm: ${s.activeKeys} active, $${s.totalBalance} known (${s.unknownBalanceKeys} unknown)`);
    } catch (e) {
      log(`warm failed (continuing anyway): ${e.message}`);
    }
  }
});

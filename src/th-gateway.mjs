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
const refreshMs = Number(process.env.TH_GATEWAY_REFRESH_MS || 60000);

const ledgerPath = process.env.TH_LEDGER_FILE || join(PROJECT_ROOT, 'data', 'pool-ledger.jsonl');
const ledger = createLedger(ledgerPath);

const pool = new Pool({
  accountsFile: join(PROJECT_ROOT, cfg.accountsFile),
  stateFile: join(PROJECT_ROOT, 'data', 'pool-state.json'),
  secretsDir: cfg.secretsDir,
  currentKeyFile: cfg.currentKeyFile,
});
pool.setLedger(ledger, { seed: true });

const log = (m) => console.log(`[gateway] ${m}`);
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

const server = createGateway({ pool, log });

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

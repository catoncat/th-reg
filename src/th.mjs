#!/usr/bin/env node
// Read-only TokenHarbor operations CLI for humans and Pi skills.
// It deliberately exposes account facts, never credentials or API keys.
//
// Default path is CHEAP and local:
//   1. GET gateway /health  (in-memory pool + ledger-backed balances)
//   2. fallback: fold data/pool-ledger.jsonl
//   3. fallback: read data/pool-state.json
//
// `--live` forces the old full-fleet path (serial Supabase login + wallet for
// every account). That is slow (~1s+/account) and rate-limit sensitive — use
// it for reconcile, not for watch loops.

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT, loadConfig } from './config.mjs';
import { accountSnapshot } from './th-api.mjs';
import { createLedger } from './ledger.mjs';

function parseArgs(argv) {
  const positional = [];
  const out = { json: false, limit: 20, live: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--live' || a === '--refresh') out.live = true;
    else if (a === '--limit') out.limit = Math.max(1, Number(argv[++i]) || 20);
    else positional.push(a);
  }
  return { command: positional[0] || 'status', subcommand: positional[1], options: out };
}

function accountsFile() {
  const cfg = loadConfig({});
  return resolve(PROJECT_ROOT, cfg.accountsFile);
}

function loadAccounts() {
  const file = accountsFile();
  if (!existsSync(file)) return [];
  const latest = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      const a = JSON.parse(line);
      if (a.email) latest.set(a.email, a);
    } catch {
      /* tolerate legacy/non-JSON lines */
    }
  }
  return [...latest.values()].filter((a) => a.email && a.password && a.api_key);
}

function currentKey(cfg) {
  try {
    return readFileSync(cfg.currentKeyFile, 'utf8').trim();
  } catch {
    return '';
  }
}

function ledgerPath(cfg) {
  return process.env.TH_LEDGER_FILE || join(PROJECT_ROOT, 'data', 'pool-ledger.jsonl');
}

function poolStatePath() {
  return join(PROJECT_ROOT, 'data', 'pool-state.json');
}

function gatewayBase() {
  const host = process.env.TH_GATEWAY_HOST || '127.0.0.1';
  const port = process.env.TH_GATEWAY_PORT || 19672;
  return process.env.TH_GATEWAY_URL || `http://${host}:${port}`;
}

/**
 * Read launchd status for the supply service. Pure macOS detail — returns
 * a stub when launchctl is unavailable so the CLI works cross-platform.
 */
function launchd(cfg) {
  let loaded = false;
  let pid = null;
  try {
    const line = execFileSync('launchctl', ['list', cfg.supplyService], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    loaded = line.includes(cfg.supplyService);
    const fields = line.trim().split(/\s+/);
    pid = fields[0] === '-' ? null : Number(fields[0]);
  } catch {
    /* service not loaded or launchctl unavailable */
  }
  let target = cfg.supplyTarget;
  try {
    const plist = readFileSync(cfg.plistPath, 'utf8');
    const m = plist.match(/<string>--target<\/string>\s*<string>([\d.]+)<\/string>/);
    if (m) target = Number(m[1]);
  } catch {
    /* plist optional */
  }
  return { service: cfg.supplyService, loaded, running: pid !== null, pid, targetUsd: target };
}

/** Cheap local/gateway snapshot. Never hits Supabase. */
async function cheapSnapshot(cfg) {
  // 1. gateway /health
  try {
    const r = await fetch(`${gatewayBase()}/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const j = await r.json();
      return {
        source: 'gateway',
        asOf: j.asOf || new Date().toISOString(),
        activeKeys: j.activeKeys ?? null,
        exhaustedKeys: j.exhaustedKeys ?? null,
        deadKeys: j.deadKeys ?? null,
        totalKeys: j.totalKeys ?? (Array.isArray(j.keys) ? j.keys.length : null),
        totalBalance: Number(j.totalBalance) || 0,
        knownBalanceKeys: j.knownBalanceKeys ?? null,
        unknownBalanceKeys: j.unknownBalanceKeys ?? 0,
        ledgerSeq: j.ledgerSeq ?? null,
        keys: j.keys || [],
        current: j.current || findCurrentFromKeys(j.keys || [], cfg),
      };
    }
  } catch {
    /* gateway down */
  }

  // 2. ledger fold
  try {
    const led = createLedger(ledgerPath(cfg));
    const f = led.fold();
    if (f.totalKeys > 0) {
      const keys = [...f.keys.values()].map((k) => ({
        file: k.keyFile,
        email: k.email,
        status: k.status,
        balance: k.balance,
        balanceKnown: k.balanceKnown,
      }));
      return {
        source: 'ledger',
        asOf: f.asOf || new Date().toISOString(),
        activeKeys: f.activeKeys,
        exhaustedKeys: f.exhaustedKeys,
        deadKeys: f.deadKeys,
        totalKeys: f.totalKeys,
        totalBalance: f.totalBalance,
        knownBalanceKeys: f.knownBalanceKeys,
        unknownBalanceKeys: f.unknownBalanceKeys,
        ledgerSeq: f.seq,
        keys,
        current: findCurrentFromKeys(keys, cfg),
      };
    }
  } catch {
    /* no ledger */
  }

  // 3. pool-state.json
  try {
    const raw = JSON.parse(readFileSync(poolStatePath(), 'utf8'));
    const keys = Object.entries(raw).map(([file, v]) => ({
      file,
      email: v.email || null,
      status: v.status || 'ok',
      balance: v.status === 'exhausted' || v.status === 'dead' ? 0 : v.balance ?? null,
      balanceKnown: v.status === 'exhausted' || v.status === 'dead' || v.balance != null,
    }));
    let totalBalance = 0;
    let known = 0;
    let unknown = 0;
    let active = 0;
    let exhausted = 0;
    let dead = 0;
    for (const k of keys) {
      if (k.status === 'dead') dead++;
      else if (k.status === 'exhausted') exhausted++;
      else active++;
      if (k.status === 'exhausted' || k.status === 'dead') known++;
      else if (k.balance != null) {
        known++;
        totalBalance += Number(k.balance) || 0;
      } else unknown++;
    }
    const asOf = Object.values(raw)
      .map((v) => v.updated_at)
      .filter(Boolean)
      .sort()
      .pop() || new Date().toISOString();
    return {
      source: 'pool-state',
      asOf,
      activeKeys: active,
      exhaustedKeys: exhausted,
      deadKeys: dead,
      totalKeys: keys.length,
      totalBalance: Math.round(totalBalance * 100) / 100,
      knownBalanceKeys: known,
      unknownBalanceKeys: unknown,
      ledgerSeq: null,
      keys,
      current: findCurrentFromKeys(keys, cfg),
    };
  } catch {
    return null;
  }
}

function findCurrentFromKeys(keys, cfg) {
  // pool-state/health don't carry api keys; match via current key file → secrets slot is hard.
  // Best-effort: if a key is marked current in a live row, use it. Otherwise null here;
  // live path fills it properly.
  const cur = keys.find((k) => k.current);
  return cur || null;
}

async function snapshots(accounts, cfg, options = {}) {
  const result = [];
  // Supabase rate-limits bursts of password grants. Keep this deliberately
  // serial and paced: a slower truthful read is better than a fast false $0.
  for (const [index, a] of accounts.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 700));
    const s = await accountSnapshot(a.email, a.password, options);
    result.push({
      email: a.email,
      status: a.status || null,
      balance: s.error ? null : s.total,
      balanceTrial: s.error ? null : s.balanceTrial,
      balancePaid: s.error ? null : s.balancePaid,
      spend: s.error ? null : s.spend,
      transactions: s.transactions,
      error: s.error || null,
      current: a.api_key === currentKey(cfg),
    });
  }
  return result;
}

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
function jsonOut(value) {
  console.log(JSON.stringify(value, null, 2));
}
function money(n) {
  return `$${round(n).toFixed(2)}`;
}

async function status(json, live) {
  const cfg = loadConfig({});
  const ld = launchd(cfg);

  if (!live) {
    const cheap = await cheapSnapshot(cfg);
    if (cheap) {
      const out = {
        generatedAt: new Date().toISOString(),
        source: cheap.source,
        asOf: cheap.asOf,
        targetUsd: ld.targetUsd,
        totalBalance: round(cheap.totalBalance),
        knownBalanceKeys: cheap.knownBalanceKeys,
        unknownBalanceKeys: cheap.unknownBalanceKeys,
        balanceConfirmed: cheap.knownBalanceKeys,
        balanceErrors: 0,
        fundedAccounts: cheap.activeKeys,
        activeKeys: cheap.activeKeys,
        exhaustedKeys: cheap.exhaustedKeys,
        deadKeys: cheap.deadKeys,
        accountCount: cheap.totalKeys,
        ledgerSeq: cheap.ledgerSeq,
        current: cheap.current
          ? {
              email: cheap.current.email,
              balance: cheap.current.balance,
              balanceConfirmed: cheap.current.balance != null,
            }
          : null,
        supply: ld,
        errors: [],
        note:
          cheap.unknownBalanceKeys > 0
            ? `${cheap.unknownBalanceKeys} active key(s) have unknown balance (not in sum). Use --live to reconcile.`
            : 'local/gateway view; pass --live for full Supabase reconcile',
      };
      if (json) return jsonOut(out);
      console.log(`Token Harbor Pool  ${out.generatedAt.slice(0, 16).replace('T', ' ')}  [${out.source}]`);
      console.log('─'.repeat(58));
      console.log(
        `total balance   ${money(out.totalBalance)} / target ${money(out.targetUsd || 0)}` +
          (out.unknownBalanceKeys ? `  (+${out.unknownBalanceKeys} unknown)` : ''),
      );
      console.log(
        `keys            ${out.activeKeys} active / ${out.exhaustedKeys ?? '?'} exhausted / ${out.accountCount} total`,
      );
      console.log(
        `current         ${out.current ? `${out.current.email} (${money(out.current.balance)})` : 'n/a (use --live)'}`,
      );
      console.log(
        `supply          ${out.supply.loaded ? (out.supply.running ? 'running' : 'loaded') : 'not loaded'} (target ${money(out.supply.targetUsd || 0)})`,
      );
      console.log(`asOf            ${out.asOf}${out.ledgerSeq != null ? `  ledger#${out.ledgerSeq}` : ''}`);
      if (out.note) console.log(`note            ${out.note}`);
      return;
    }
  }

  // --live or no local state: full fleet snapshot
  const rows = await snapshots(loadAccounts(), cfg);
  const healthy = rows.filter((r) => r.balance !== null && r.balance > 0.01);
  const total = rows.reduce((n, r) => n + (r.balance || 0), 0);
  const current = rows.find((r) => r.current) || null;
  const errors = rows.filter((r) => r.error).map((r) => ({ email: r.email, error: r.error }));
  const out = {
    generatedAt: new Date().toISOString(),
    source: 'live',
    asOf: new Date().toISOString(),
    targetUsd: ld.targetUsd,
    totalBalance: round(total),
    balanceConfirmed: rows.length - errors.length,
    balanceErrors: errors.length,
    fundedAccounts: healthy.length,
    activeKeys: healthy.length,
    accountCount: rows.length,
    current: current
      ? { email: current.email, balance: current.balance, balanceConfirmed: current.balance !== null }
      : null,
    supply: ld,
    errors,
    note: errors.length
      ? 'partial live sum; query errors mean total is a lower bound'
      : 'live Supabase snapshot',
  };
  if (json) return jsonOut(out);
  console.log(`Token Harbor Pool  ${out.generatedAt.slice(0, 16).replace('T', ' ')}  [live]`);
  console.log('─'.repeat(58));
  console.log(
    `total balance   ${money(out.totalBalance)} / target ${money(out.targetUsd || 0)} (${out.balanceConfirmed}/${out.accountCount} confirmed)`,
  );
  console.log(`funded accounts ${out.fundedAccounts} / ${out.accountCount}`);
  console.log(`current         ${current ? `${current.email} (${money(current.balance)})` : 'none'}`);
  console.log(
    `supply          ${out.supply.loaded ? (out.supply.running ? 'running' : 'loaded') : 'not loaded'} (target ${money(out.supply.targetUsd || 0)})`,
  );
  if (out.errors.length) console.log(`query errors    ${out.errors.length} (total is partial; use --json for details)`);
}

async function usage(json, limit) {
  // usage still needs live tx pulls — always expensive
  const cfg = loadConfig({});
  const rows = await snapshots(loadAccounts(), cfg, { withTransactions: true });
  const byModel = new Map();
  const recent = [];
  for (const row of rows) {
    for (const tx of row.transactions || []) {
      byModel.set(tx.model, (byModel.get(tx.model) || 0) + tx.amount);
      recent.push({ email: row.email, createdAt: tx.createdAt, model: tx.model, amount: tx.amount });
    }
  }
  recent.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const out = {
    generatedAt: new Date().toISOString(),
    source: 'live',
    totalConsumed: round([...byModel.values()].reduce((a, b) => a + b, 0)),
    byModel: Object.fromEntries(
      [...byModel.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, round(v)]),
    ),
    recent: recent.slice(0, limit),
    errors: rows.filter((r) => r.error).map((r) => ({ email: r.email, error: r.error })),
  };
  if (json) return jsonOut(out);
  console.log(`Token Harbor Usage  ${out.generatedAt.slice(0, 16).replace('T', ' ')}  [live]`);
  console.log('─'.repeat(58));
  console.log(`total consumed ${money(out.totalConsumed)}`);
  for (const [model, amount] of Object.entries(out.byModel)) console.log(`${model.padEnd(28)} ${money(amount)}`);
  console.log(`transactions    ${recent.length} shown (use --json for details)`);
}

async function accounts(json, live) {
  const cfg = loadConfig({});
  if (!live) {
    const cheap = await cheapSnapshot(cfg);
    if (cheap?.keys?.length) {
      const out = cheap.keys.map((k) => ({
        file: k.file,
        email: k.email,
        status: k.status,
        balance: k.balance,
        balanceKnown: k.balanceKnown ?? k.balance != null,
        current: false,
        error: null,
        source: cheap.source,
      }));
      if (json) return jsonOut(out);
      console.log(
        'file'.padEnd(28) + 'email'.padEnd(36) + 'balance'.padEnd(10) + 'status'.padEnd(12) + 'known',
      );
      for (const r of out) {
        console.log(
          String(r.file || '-').padEnd(28) +
            String(r.email || '-').padEnd(36) +
            (r.balance === null ? 'unknown' : money(r.balance)).padEnd(10) +
            String(r.status || '-').padEnd(12) +
            (r.balanceKnown ? 'yes' : 'no'),
        );
      }
      console.log(`\n[${cheap.source}] pass --live for Supabase wallet rows`);
      return;
    }
  }
  const rows = await snapshots(loadAccounts(), cfg);
  const out = rows.map(({ email, status, balance, balanceTrial, balancePaid, spend, error, current }) => ({
    email,
    status,
    balance,
    balanceTrial,
    balancePaid,
    spend,
    current,
    error,
  }));
  if (json) return jsonOut(out);
  console.log('email'.padEnd(40) + 'balance'.padEnd(10) + 'status'.padEnd(14) + 'current');
  for (const r of out) {
    console.log(
      r.email.padEnd(40) +
        (r.balance === null ? 'error' : money(r.balance)).padEnd(10) +
        String(r.status || '-').padEnd(14) +
        (r.current ? 'yes' : ''),
    );
  }
}

async function main() {
  const { command, subcommand, options } = parseArgs(process.argv.slice(2));
  if (command === 'pool' && subcommand === 'usage') return usage(options.json, options.limit);
  if (command === 'pool' && subcommand === 'accounts') return accounts(options.json, options.live);
  if (command === 'pool' && (!subcommand || subcommand === 'status')) return status(options.json, options.live);
  if (command === 'supply' && subcommand === 'status') return status(options.json, options.live);
  if (command === 'current') {
    const cfg = loadConfig({});
    if (!options.live) {
      const cheap = await cheapSnapshot(cfg);
      // current key pointer match needs live accounts file
    }
    const rows = await snapshots(loadAccounts(), cfg);
    const current = rows.find((r) => r.current) || null;
    return options.json
      ? jsonOut(current)
      : console.log(
          current
            ? `${current.email} ${current.balance === null ? '(balance unconfirmed)' : money(current.balance)}`
            : 'current: none',
        );
  }
  console.error(
    'usage: th pool status|usage|accounts [--json] [--live] [--limit N] | th supply status [--json] [--live]',
  );
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(`[th] fatal: ${e.message}`);
  process.exitCode = 1;
});

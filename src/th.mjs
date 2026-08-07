#!/usr/bin/env node
// Read-only TokenHarbor operations CLI for humans and Pi skills.
// It deliberately exposes account facts, never credentials or API keys.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT, loadConfig } from './config.mjs';
import { accountSnapshot } from './th-api.mjs';

function parseArgs(argv) {
  const positional = [];
  const out = { json: false, limit: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
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
    } catch { /* tolerate legacy/non-JSON lines */ }
  }
  return [...latest.values()].filter((a) => a.email && a.password && a.api_key);
}

function currentKey(cfg) {
  try { return readFileSync(cfg.currentKeyFile, 'utf8').trim(); } catch { return ''; }
}

/**
 * Read launchd status for the supply service. Pure macOS detail — returns
 * `null` when launchctl is unavailable so the CLI works cross-platform.
 */
function launchd(cfg) {
  let loaded = false;
  let pid = null;
  try {
    const line = execFileSync('launchctl', ['list', cfg.supplyService], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    loaded = line.includes(cfg.supplyService);
    const fields = line.trim().split(/\s+/);
    pid = fields[0] === '-' ? null : Number(fields[0]);
  } catch { /* service not loaded or launchctl unavailable */ }
  let target = cfg.supplyTarget;
  try {
    const plist = readFileSync(cfg.plistPath, 'utf8');
    const m = plist.match(/<string>--target<\/string>\s*<string>([\d.]+)<\/string>/);
    if (m) target = Number(m[1]);
  } catch { /* plist optional */ }
  return { service: cfg.supplyService, loaded, running: pid !== null, pid, targetUsd: target };
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

function round(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function jsonOut(value) { console.log(JSON.stringify(value, null, 2)); }
function money(n) { return `$${round(n).toFixed(2)}`; }

async function status(json) {
  const cfg = loadConfig({});
  const rows = await snapshots(loadAccounts(), cfg);
  const healthy = rows.filter((r) => r.balance !== null && r.balance > 0.01);
  const total = rows.reduce((n, r) => n + (r.balance || 0), 0);
  const current = rows.find((r) => r.current) || null;
  const errors = rows.filter((r) => r.error).map((r) => ({ email: r.email, error: r.error }));
  const out = {
    generatedAt: new Date().toISOString(),
    targetUsd: launchd(cfg).targetUsd,
    totalBalance: round(total),
    balanceConfirmed: rows.length - errors.length,
    balanceErrors: errors.length,
    fundedAccounts: healthy.length,
    accountCount: rows.length,
    current: current ? { email: current.email, balance: current.balance, balanceConfirmed: current.balance !== null } : null,
    supply: launchd(cfg),
    errors,
  };
  if (json) return jsonOut(out);
  console.log(`Token Harbor Pool  ${out.generatedAt.slice(0, 16).replace('T', ' ')}`);
  console.log('─'.repeat(58));
  console.log(`total balance   ${money(out.totalBalance)} / target ${money(out.targetUsd || 0)} (${out.balanceConfirmed}/${out.accountCount} confirmed)`);
  console.log(`funded accounts ${out.fundedAccounts} / ${out.accountCount}`);
  console.log(`current         ${current ? `${current.email} (${money(current.balance)})` : 'none'}`);
  console.log(`supply          ${out.supply.loaded ? (out.supply.running ? 'running' : 'loaded') : 'not loaded'} (target ${money(out.supply.targetUsd || 0)})`);
  if (out.errors.length) console.log(`query errors    ${out.errors.length} (total is partial; use --json for details)`);
}

async function usage(json, limit) {
  const cfg = loadConfig({});
  const rows = await snapshots(loadAccounts(), cfg, { withTransactions: true });
  const byModel = new Map();
  const recent = [];
  for (const row of rows) for (const tx of row.transactions || []) {
    byModel.set(tx.model, (byModel.get(tx.model) || 0) + tx.amount);
    recent.push({ email: row.email, createdAt: tx.createdAt, model: tx.model, amount: tx.amount });
  }
  recent.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const out = {
    generatedAt: new Date().toISOString(),
    totalConsumed: round([...byModel.values()].reduce((a, b) => a + b, 0)),
    byModel: Object.fromEntries([...byModel.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, round(v)])),
    recent: recent.slice(0, limit),
    errors: rows.filter((r) => r.error).map((r) => ({ email: r.email, error: r.error })),
  };
  if (json) return jsonOut(out);
  console.log(`Token Harbor Usage  ${out.generatedAt.slice(0, 16).replace('T', ' ')}`);
  console.log('─'.repeat(58));
  console.log(`total consumed ${money(out.totalConsumed)}`);
  for (const [model, amount] of Object.entries(out.byModel)) console.log(`${model.padEnd(28)} ${money(amount)}`);
  console.log(`transactions    ${recent.length} shown (use --json for details)`);
}

async function accounts(json) {
  const cfg = loadConfig({});
  const rows = await snapshots(loadAccounts(), cfg);
  const out = rows.map(({ email, status, balance, balanceTrial, balancePaid, spend, error, current }) => ({
    email, status, balance, balanceTrial, balancePaid, spend, current, error,
  }));
  if (json) return jsonOut(out);
  console.log('email'.padEnd(40) + 'balance'.padEnd(10) + 'status'.padEnd(14) + 'current');
  for (const r of out) console.log(r.email.padEnd(40) + (r.balance === null ? 'error' : money(r.balance)).padEnd(10) + String(r.status || '-').padEnd(14) + (r.current ? 'yes' : ''));
}

async function main() {
  const { command, subcommand, options } = parseArgs(process.argv.slice(2));
  if (command === 'pool' && subcommand === 'usage') return usage(options.json, options.limit);
  if (command === 'pool' && subcommand === 'accounts') return accounts(options.json);
  if (command === 'pool' && (!subcommand || subcommand === 'status')) return status(options.json);
  if (command === 'supply' && subcommand === 'status') return status(options.json);
  if (command === 'current') {
    const cfg = loadConfig({});
    const rows = await snapshots(loadAccounts(), cfg);
    const current = rows.find((r) => r.current) || null;
    return options.json ? jsonOut(current) : console.log(current ? `${current.email} ${current.balance === null ? '(balance unconfirmed)' : money(current.balance)}` : 'current: none');
  }
  console.error('usage: th pool status|usage|accounts [--json] [--limit N] | th supply status [--json]');
  process.exitCode = 2;
}

main().catch((e) => { console.error(`[th] fatal: ${e.message}`); process.exitCode = 1; });

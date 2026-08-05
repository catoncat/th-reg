#!/usr/bin/env node
// Token Harbor registration CLI.
//
//   node src/cli.mjs --count 3 --domain dogfood.0day3.com --delay-ms 8000
//   node src/cli.mjs --workers 3 --count 6
//
// Reads config from .env.local / environment / DataImpulse secrets file.
// A per-account random email th-<hex>@<domain> is generated and the verify
// email is consumed through the cloud-mail mailbox CLI.

import { fileURLToPath } from 'node:url';
import { loadConfig, randomHex } from './config.mjs';
import { registerOne } from './register.mjs';
import { appendAccount, printAccount } from './accounts.mjs';
import { stickyEndpoint } from './config.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sleep } from './mailbox.mjs';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const o = { count: undefined, domain: undefined, delayMs: undefined, workers: undefined, noVerify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--count') o.count = Number(next());
    else if (a === '--domain') o.domain = next().replace(/^@/, '');
    else if (a === '--delay-ms') o.delayMs = Number(next());
    else if (a === '--workers') o.workers = Number(next());
    else if (a === '--no-verify') o.noVerify = true;
    else if (a === '--help') { console.log('usage: node src/cli.mjs [--count N] [--domain D] [--delay-ms MS] [--workers N] [--no-verify]'); process.exit(0); }
  }
  return o;
}

async function preflight(cfg) {
  // Verify the residential proxy is reachable and the mailbox CLI works.
  const ep = stickyEndpoint(cfg, 'preflight');
  const { stdout } = await execFileAsync('curl', ['-sS', '-m', '15', '-x', ep, 'https://api.ipify.org/']);
  const ip = stdout.trim();
  if (!ip) throw new Error('residential proxy preflight failed (no exit IP)');
  return ip;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cfg = loadConfig({
    ...(o.count !== undefined ? { count: o.count } : {}),
    ...(o.domain !== undefined ? { domain: o.domain } : {}),
    ...(o.delayMs !== undefined ? { delayMs: o.delayMs } : {}),
    ...(o.workers !== undefined ? { workers: o.workers } : {}),
  });

  console.log(`[config] domain=${cfg.domain} count=${cfg.count} workers=${cfg.workers} delay=${cfg.delayMs}ms`);
  const exitIp = await preflight(cfg);
  console.log(`[proxy] residential proxy OK, exit ${exitIp}`);

  const created = { created: 0, verified: 0, failed: 0 };
  const queue = Array.from({ length: cfg.count }, () => ({
    email: `th-${randomHex(5)}@${cfg.domain}`,
    password: `TH_${randomHex(8)}!x9`,
  }));

  const worker = async (job) => {
    const t0 = Date.now();
    try {
      const r = await registerOne(cfg, { ...job, log: (m) => console.log(`  ${m}`) });
      r.password = job.password;
      appendAccount(cfg.accountsFile, r);
      printAccount(r);
      if (r.status === 'verified') created.verified++;
      if (r.status === 'created' || r.status === 'verified' || r.status === 'created-unverified') created.created++;
      if (r.status === 'failed' || r.status === 'captcha-required') created.failed++;
      console.log(`[done] ${r.email} status=${r.status} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
      created.failed++;
      const rec = { email: job.email, status: 'failed', error: String(err.message || err).slice(0, 300), created_at: new Date().toISOString() };
      try { appendAccount(cfg.accountsFile, rec); } catch {}
      console.log(`[fail] ${job.email}: ${err.message}`);
    }
  };

  if (cfg.workers > 1) {
    let i = 0;
    const run = async () => {
      while (i < queue.length) {
        const job = queue[i++];
        await worker(job);
        await sleep(cfg.delayMs);
      }
    };
    await Promise.all(Array.from({ length: cfg.workers }, run));
  } else {
    for (const job of queue) {
      await worker(job);
      await sleep(cfg.delayMs);
    }
  }

  console.log(`\n[summary] created=${created.created} verified=${created.verified} failed=${created.failed} -> ${cfg.accountsFile}`);
}

main().catch((err) => {
  console.error(`[fatal] ${err.stack || err.message}`);
  process.exit(1);
});

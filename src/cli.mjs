#!/usr/bin/env node
// Token Harbor registration CLI.
//
//   node src/cli.mjs --count 3 --domain mail.example.com --delay-ms 8000
//   node src/cli.mjs --workers 3 --count 6
//
// Reads config from .env.local / environment / DataImpulse secrets file.
// A per-account random email th-<hex>@<domain> is generated and the verify
// email is consumed through the cloud-mail mailbox CLI.

import { fileURLToPath } from 'node:url';
import { loadConfig, randomHex } from './config.mjs';
import { registerOne } from './register.mjs';
import { appendAccount, printAccount } from './accounts.mjs';
import { stickyEndpoint, rotateEndpoint } from './config.mjs';
import { generateUsername } from './names.mjs';
import { DomainAllocator, loadCfEnv } from './domains.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sleep } from './mailbox.mjs';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const o = { count: undefined, domain: undefined, delayMs: undefined, workers: undefined, inviteCode: undefined, noVerify: false, domainMode: undefined, proxyMode: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--count') o.count = Number(next());
    else if (a === '--domain') o.domain = next().replace(/^@/, '');
    else if (a === '--domain-mode') o.domainMode = next();
    else if (a === '--delay-ms') o.delayMs = Number(next());
    else if (a === '--workers') o.workers = Number(next());
    else if (a === '--invite-code') o.inviteCode = next();
    else if (a === '--proxy') o.proxyMode = next();
    else if (a === '--no-verify') o.noVerify = true;
    else if (a === '--help') { console.log('usage: node src/cli.mjs [--count N] [--domain D] [--domain-mode dynamic|pool|single] [--delay-ms MS] [--workers N] [--invite-code CODE] [--proxy direct|sticky|rotate] [--no-verify]'); process.exit(0); }
  }
  return o;
}

async function preflight(cfg) {
  // Verify the residential proxy is reachable (only used in proxy modes).
  const ep = cfg.proxyMode === 'rotate' ? rotateEndpoint(cfg) : stickyEndpoint(cfg, 'preflight');
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
    ...(o.domainMode !== undefined ? { domainMode: o.domainMode } : {}),
    ...(o.delayMs !== undefined ? { delayMs: o.delayMs } : {}),
    ...(o.workers !== undefined ? { workers: o.workers } : {}),
    ...(o.inviteCode !== undefined ? { inviteCode: o.inviteCode } : {}),
    ...(o.proxyMode !== undefined ? { proxyMode: o.proxyMode } : {}),
  });

  // domain allocator: dynamic (default) -> pool -> single
  let cfEnv = null;
  if (cfg.domainMode === 'dynamic') {
    cfEnv = await loadCfEnv({ keychainDir: cfg.cfKeychainDir, scope: cfg.cfEnvchainScope });
    if (!cfEnv) console.log('[config] CF creds not available; using fixed pool (--domain-mode pool)');
  }
  const allocator = new DomainAllocator({
    mode: cfg.domainMode,
    count: cfg.count,
    maxReuse: cfg.domainMaxReuse,
    dynamicZones: cfg.dynamicZones,
    fixedPool: cfg.fixedPool,
    singleDomain: cfg.domain,
    cfEnv,
    mailboxCli: cfg.mailboxCli,
    log: (m) => console.log(`  ${m}`),
  });

  console.log(`[config] domain-mode=${allocator.mode} count=${cfg.count} workers=${cfg.workers} delay=${cfg.delayMs}ms maxReuse=${cfg.domainMaxReuse} proxy=${cfg.proxyMode}`);
  if (cfg.proxyMode === 'direct') {
    console.log('[proxy] direct (no proxy)');
  } else {
    const exitIp = await preflight(cfg);
    console.log(`[proxy] ${cfg.proxyMode} proxy OK, exit ${exitIp}`);
  }

  // prepare the domain pool (pull historical dynamic domains + top-up if needed)
  await allocator.init();

  const created = { created: 0, verified: 0, failed: 0 };
  const usedNames = new Set();
  const queue = Array.from({ length: cfg.count }, () => ({
    username: generateUsername(usedNames),
    password: `TH_${randomHex(8)}!x9`,
  }));

  const worker = async (job) => {
    const t0 = Date.now();
    let email = null;
    try {
      const domain = await allocator.next();
      email = `${job.username}@${domain}`;
      const r = await registerOne(cfg, { email, password: job.password, log: (m) => console.log(`  ${m}`) });
      r.password = job.password;
      appendAccount(cfg.accountsFile, r);
      printAccount(r);
      if (r.status === 'verified') created.verified++;
      if (r.status === 'created' || r.status === 'verified' || r.status === 'created-unverified') created.created++;
      if (r.status === 'failed' || r.status === 'captcha-required') created.failed++;
      console.log(`[done] ${email} status=${r.status} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
      created.failed++;
      const rec = { email: email || `${job.username}@<no-domain>`, status: 'failed', error: String(err.message || err).slice(0, 300), created_at: new Date().toISOString() };
      try { appendAccount(cfg.accountsFile, rec); } catch {}
      console.log(`[fail] ${email || job.username}: ${err.message}`);
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

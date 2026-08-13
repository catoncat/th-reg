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
import { appendAccount, printAccount } from './accounts.mjs';
import { stickyEndpoint, rotateEndpoint } from './config.mjs';
import { generateUsername } from './names.mjs';
import { DomainAllocator, loadCfEnv } from './domains.mjs';
import { createSignupPacer } from './pacer.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sleep } from './mailbox.mjs';

const execFileAsync = promisify(execFile);

/**
 * Engine selection is explicit and one-way: `protocol` is the product, and it
 * never degrades into `browser` on failure. A user opts in with --engine.
 */
async function loadEngine(name) {
  if (name === 'browser') {
    const m = await import('./register-browser.mjs');
    return { name: 'browser', registerOne: m.registerOne };
  }
  if (name !== 'protocol') {
    throw new Error(`unknown --engine '${name}' (expected 'protocol' | 'browser')`);
  }
  const m = await import('./register.mjs');
  return { name: 'protocol', registerOne: m.registerOne };
}

function parseArgs(argv) {
  const o = { count: undefined, domain: undefined, delayMs: undefined, workers: undefined, inviteCode: undefined, domainMode: undefined, proxyMode: undefined, engine: 'protocol' };
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
    else if (a === '--signup-path') o.signupPath = next();
    else if (a === '--engine') o.engine = next();
    else if (a === '--help') {
      console.log(`usage: node src/cli.mjs [options]

  --count N                       accounts to create (default 1)
  --workers N                     parallel workers
  --domain D                      single catch-all domain
  --domain-mode dynamic|pool|single
  --delay-ms MS                   pause between accounts
  --invite-code CODE              referral code
  --proxy direct|sticky|rotate    network mode (default direct)
--signup-path auto|server-action|supabase
                              signup path; supabase bypasses the rate bucket
                              but pays no $5 welcome grant (default auto)
  --engine protocol|browser       registration engine (default protocol)

Engines are independent paths; 'protocol' never falls back to 'browser'.
  protocol  pure HTTP, no browser (the product)
  browser   agent-browser/CDP click-path, opt-in alternative

A real mailbox is required either way: the API returns 403 email_not_verified
until the verification link is opened, so TH_MAIL_MODE must not be 'none'.`);
      process.exit(0);
    }
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
    ...(o.signupPath !== undefined ? { signupPath: o.signupPath } : {}),
  });

  const engine = await loadEngine(o.engine);

  // Guard rail: without a real mailbox every account comes out API-locked
  // (403 email_not_verified) and cannot claim its $5. Fail fast instead of
  // burning domains and invite credit on unusable shells.
  if (cfg.mailMode === 'none') {
    console.error(
      "[fatal] TH_MAIL_MODE=none cannot produce usable accounts: the API stays locked\n" +
      "        at 403 email_not_verified and the $5 grant cannot be claimed.\n" +
      "        Set TH_MAIL_MODE=cloud-mail (or another real inbox provider)."
    );
    process.exit(2);
  }

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

  console.log(`[config] engine=${engine.name} domain-mode=${allocator.mode} count=${cfg.count} workers=${cfg.workers} delay=${cfg.delayMs}ms maxReuse=${cfg.domainMaxReuse} proxy=${cfg.proxyMode} mail=${cfg.mailMode}`);
  if (cfg.proxyMode === 'direct') {
    console.log('[proxy] direct (no proxy)');
  } else {
    const exitIp = await preflight(cfg);
    console.log(`[proxy] ${cfg.proxyMode} proxy OK, exit ${exitIp}`);
  }

  // prepare the domain pool (pull historical dynamic domains + top-up if needed)
  await allocator.init();

  // Signup submits are rate-limited server-side across exit IPs (measured
  // 2026-08-11), so all workers share one adaptive pacer for that step only.
  const pacer = createSignupPacer({
    minGapMs: cfg.signupMinGapMs,
    startGapMs: cfg.signupStartGapMs,
    maxGapMs: cfg.signupMaxGapMs,
    log: (m) => console.log(`  ${m}`),
  });

  // `usable` is the only number that matters: verified + key + funded.
  const created = { created: 0, verified: 0, usable: 0, failed: 0 };
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
      const r = await engine.registerOne(cfg, { email, password: job.password, log: (m) => console.log(`  ${m}`), pacer });
      r.password = job.password;
      appendAccount(cfg.accountsFile, r);
      printAccount(r);
      if (r.status === 'verified') created.verified++;
      if (r.status === 'verified' && r.api_key && r.gift_claimed) created.usable++;
      if (r.status === 'created' || r.status === 'verified' || r.status === 'created-unverified') created.created++;
      if (r.status === 'failed' || r.status === 'captcha-required') created.failed++;
      const money = r.balance_trial !== undefined ? ` trial=$${Number(r.balance_trial).toFixed(2)}` : '';
      console.log(`[done] ${email} status=${r.status}${money}${r.api_key ? ' key=yes' : ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
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

  console.log(
    `\n[summary] usable=${created.usable} (verified+key+funded) | created=${created.created} verified=${created.verified} failed=${created.failed} -> ${cfg.accountsFile}`
  );
  console.log(
    `[pace] submits=${pacer.stats.slots} ok=${pacer.stats.ok} rate-limited=${pacer.stats.fast} other=${pacer.stats.other} final gap=${(pacer.gapMs / 1000).toFixed(1)}s`
  );
  if (created.usable < created.created) {
    console.log('[note] accounts short of "usable" are missing verification, a key, or the $5 grant.');
  }
}

main().catch((err) => {
  console.error(`[fatal] ${err.stack || err.message}`);
  process.exit(1);
});

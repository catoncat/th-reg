// Domain allocation strategy for the registration batch.
//
// The FIXED POOL is the baseline: 23 pre-configured domains, round-robin with a
// reshuffle per round (even distribution, unpredictable order, zero external
// deps). Dynamic subdomains are ONLY a top-up mechanism: when a batch is larger
// than the pool can serve at <= TH_DOMAIN_MAX_REUSE accounts per domain, we
// create just enough fresh subdomains (via Cloudflare Email Routing + a worker
// allowlist entry) and merge them into the pool, where they are reused like any
// other domain. They are not per-account throwaways.
//
// Modes:
//   dynamic (default) - fixed pool + automatic top-up when the batch demands it
//   pool              - the fixed 23-domain pool only, no top-up
//   single            - a fixed domain (legacy --domain / TH_DOMAIN mode)
//
// live facts (2026-08-06):
//   * CF Email Routing MX is per-subdomain (no wildcard). A new subdomain must
//     be explicitly enabled via POST /zones/{z}/email/routing/dns {name}.
//   * Once enabled, the subdomain automatically inherits the zone catch-all
//     (matchers all -> worker). Worker stores mail only if the recipient domain
//     is in its D1 allowlist (exact match), so we also upsert that allowlist.
//   * All 11 parent zones below already have email routing enabled.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sleep } from './mailbox.mjs';

const execFileAsync = promisify(execFile);

const CF_API = 'https://api.cloudflare.com/client/v4';

// Pre-configured, manually vetted pool (23 domains): excludes the two forward
// domains (z-skills.com, 2api.org -> Gmail, not catch-all) and the business-relevant
// domains r1.chat / grokmail.2api.org.
//
// 2026-08-06: NO hardcoded infra domains in source (repo is shareable).
// Provide your own catch-all domains via .env.local (TH_FIXED_POOL / TH_DYNAMIC_ZONES,
// comma-separated) or --domain-mode single --domain <yours>.
export const FIXED_POOL = [];

// Parent domains with Cloudflare Email Routing already enabled (verified live).
// Dynamic mode builds a unique subdomain under one of these per account.
// Configure yours in .env.local: TH_DYNAMIC_ZONES=a.com,b.com (comma-separated).
export const DYNAMIC_ZONES = [];

const LABEL_WORDS = [
  // functional
  'mail', 'relay', 'mx', 'post', 'inbox', 'smtp', 'mail2', 'mail3',
  // codename-ish
  'alpha', 'beta', 'gamma', 'delta', 'node', 'hub', 'lab', 'dev', 'web',
  'cloud', 'edge', 'core', 'pico', 'mini', 'echo',
  // short word roots
  'luna', 'nova', 'orca', 'iris', 'jade', 'amber', 'pine', 'oak', 'elm',
  'fox', 'owl', 'ray', 'sky', 'sun', 'moon', 'star',
];

function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Short, meaningful subdomain label (dogfood / mail2 / alpha7 style) rather
 * than a random hex string. ~70% get a 1-2 digit suffix so the label space is
 * effectively unbounded while every label stays short and readable.
 */
function randomLabel(used, rng = Math.random) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const w = LABEL_WORDS[Math.floor(rng() * LABEL_WORDS.length)];
    const withNum = rng() < 0.7;
    const s = withNum ? `${w}${1 + Math.floor(rng() * 99)}` : w;
    if (used.has(s)) continue;
    used.add(s);
    return s;
  }
  throw new Error('failed to allocate a unique subdomain label');
}

/**
 * Load Cloudflare credentials once via envchain (kept in memory, never written
 * to disk or printed). Returns null if the lane is unavailable.
 */
export async function loadCfEnv({ keychainDir, scope }) {
  try {
    const { stdout } = await execFileAsync(
      'envchain',
      ['--keychain-dir', keychainDir, scope, 'sh', '-lc',
        'printf "%s\\n" "$CLOUDFLARE_EMAIL"; printf "%s" "$CLOUDFLARE_GLOBAL_API_KEY"'],
      { timeout: 20000, encoding: 'utf8' },
    );
    const [email = '', apiKey = ''] = stdout.split('\n');
    if (!email || !apiKey) return null;
    return { email, apiKey };
  } catch {
    return null;
  }
}

/**
 * Enable a fresh subdomain for mail: CF Email Routing DNS + worker allowlist.
 * Both calls are idempotent/upsert; a CF "already exists" error is tolerated.
 */
export async function enableSubdomain(cfEnv, { zone, domain, mailboxCli }) {
  const zoneId = await cfZoneId(cfEnv, zone);

  // 1. CF Email Routing: enable routing DNS for the subdomain (builds the MX).
  const res = await fetch(`${CF_API}/zones/${zoneId}/email/routing/dns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth-email': cfEnv.email, 'x-auth-key': cfEnv.apiKey },
    body: JSON.stringify({ name: domain }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (!/already/i.test(body)) {
      throw new Error(`CF email routing enable failed (${res.status}): ${body.slice(0, 200)}`);
    }
  }

  // 2) Worker D1 allowlist upsert via the cloud-mail CLI (reads its own token).
  const dat = await execFileAsync(mailboxCli, [
    'api', 'POST', '/admin/domains',
    '--json', JSON.stringify({ domain, zone, enabled: true }),
  ], { timeout: 20000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
  const parsed = JSON.parse(dat.stdout || '{}');
  if (!parsed?.ok) {
    throw new Error(`worker allowlist upsert failed: ${(dat.stdout || '').slice(0, 200)}`);
  }
}

const zoneIdCache = new Map();

async function cfZoneId(cfEnv, zone) {
  const cached = zoneIdCache.get(zone);
  if (cached) return cached;
  const url = `${CF_API}/zones?name=${encodeURIComponent(zone)}`;
  const res = await fetch(url, {
    headers: { 'x-auth-email': cfEnv.email, 'x-auth-key': cfEnv.apiKey },
  });
  const body = await res.json().catch(() => ({}));
  const zoneId = body?.result?.[0]?.id;
  if (!zoneId) throw new Error(`CF zone not found: ${zone}`);
  zoneIdCache.set(zone, zoneId);
  return zoneId;
}

/** Fetch enabled domains from the worker allowlist (historical dynamic domains
 *  plus anything else that has been configured). */
export async function getAllowlist(mailboxCli) {
  const dat = await execFileAsync(mailboxCli, ['api', 'GET', '/admin/domains'], {
    timeout: 20000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
  });
  const parsed = JSON.parse(dat.stdout || '{}');
  const items = parsed?.items || [];
  if (!Array.isArray(items)) throw new Error('allowlist response missing items');
  return items.filter((i) => i.enabled).map((i) => i.domain);
}

export class DomainAllocator {
  /**
   * @param {object} opts
   * @param {string} opts.mode          'dynamic' | 'pool' | 'single'
   * @param {number} opts.count         accounts in this batch (drives top-up size)
   * @param {number} opts.maxReuse      max accounts per domain before top-up (default 2)
   * @param {string[]} opts.dynamicZones parent domains usable for new subdomains
   * @param {string[]} opts.fixedPool    baseline domains for pool mode
   * @param {string}  opts.singleDomain  fixed domain for single mode
   * @param {object}  opts.cfEnv          { email, apiKey } or null
   * @param {string}  opts.mailboxCli     cloud-mail CLI name
   * @param {number}  opts.settleMs       wait after enabling a subdomain (MX propagation)
   * @param {(m:string)=>void} opts.log
   */
  constructor(opts) {
    this.mode = opts.mode;
    this.count = opts.count || 1;
    this.maxReuse = opts.maxReuse || 2;
    this.dynamicZones = opts.dynamicZones?.length ? [...opts.dynamicZones] : [...DYNAMIC_ZONES];
    this.fixedPool = [...(opts.fixedPool || FIXED_POOL)];
    this.singleDomain = opts.singleDomain || '';
    this.cfEnv = opts.cfEnv || null;
    this.mailboxCli = opts.mailboxCli || 'cloud-mail';
    this.settleMs = opts.settleMs ?? 3000;
    this.log = opts.log || (() => {});
    this.usedLabels = new Set();
    this.pool = [...this.fixedPool];
    this.cursor = 0;
    if (this.mode === 'dynamic' && (!this.cfEnv || this.dynamicZones.length === 0)) {
      this.log('[domains] CF creds unavailable -> fixed pool only (no top-up)');
      this.mode = 'pool';
    }
  }

  /**
   * Prepare the pool. In dynamic mode: pull historical dynamic domains from the
   * worker allowlist back into the pool, then create just enough fresh
   * subdomains so no domain serves more than maxReuse accounts this batch.
   * Must be called before next().
   */
  async init() {
    if (this.mode === 'single') return;
    if (this.mode !== 'dynamic') return;

    // 1) reuse domains that are already live (previous top-ups, manual adds)
    try {
      const live = await getAllowlist(this.mailboxCli);
      const extras = live.filter((d) => !this.pool.includes(d));
      if (extras.length) {
        this.pool.push(...extras);
        this.log(`[domains] reused ${extras.length} existing domain(s) from allowlist`);
      }
    } catch (err) {
      this.log(`[domains] allowlist read failed (${err.message}); fixed pool only`);
    }

    // 2) top up only if the batch would exceed maxReuse accounts per domain
    const target = Math.max(this.pool.length, Math.ceil(this.count / this.maxReuse));
    const topup = target - this.pool.length;
    if (topup <= 0) {
      this.log(`[domains] pool of ${this.pool.length} covers ${this.count} accounts (<=${this.maxReuse}/domain), no top-up`);
      return;
    }
    this.log(`[domains] batch needs ${topup} more domain(s) (${this.count} accounts @ <=${this.maxReuse}/domain)`);

    const zones = shuffle([...this.dynamicZones]);
    const added = [];
    for (let i = 0; i < topup; i++) {
      const zone = zones[i % zones.length];
      const label = randomLabel(this.usedLabels);
      const domain = `${label}.${zone}`;
      try {
        await enableSubdomain(this.cfEnv, { zone, domain, mailboxCli: this.mailboxCli });
        if (this.settleMs > 0) await sleep(this.settleMs);
        this.pool.push(domain);
        added.push(domain);
      } catch (err) {
        this.log(`[domains] top-up ${domain} failed (${err.message}); continuing with current pool`);
        break;
      }
    }
    if (added.length) this.log(`[domains] top-up added: ${added.join(', ')}`);
  }

  /** Next recipient domain for a fresh account. */
  async next() {
    if (this.mode === 'single') return this.singleDomain;
    if (this.mode === 'dynamic' && this.pool.length === 0) {
      // nothing live (all top-ups failed) - fall back to the fixed pool
      this.pool.push(...this.fixedPool);
    }
    // reshuffle at the start of each round so consecutive rounds are unpredictable
    if (this.cursor % this.pool.length === 0) shuffle(this.pool);
    return this.pool[this.cursor++ % this.pool.length];
  }
}

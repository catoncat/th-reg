// Config loader: environment variables + DataImpulse secrets file.
// The .env.local file (gitignored) is loaded first if present.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { FIXED_POOL, DYNAMIC_ZONES } from './domains.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(here, '..');

function loadDotEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function readSecretEnvFile() {
  const candidates = [
    join(homedir(), '.agents', 'skills', 'residential-proxy', '.secrets', 'dataimpulse.env'),
    join(homedir(), '.pi', 'agent', 'skills', 'residential-proxy', '.secrets', 'dataimpulse.env'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return loadDotEnv(p);
  }
  return {};
}

export function loadConfig(overrides = {}) {
  const env = { ...loadDotEnv(join(PROJECT_ROOT, '.env.local')), ...process.env };
  const dip = readSecretEnvFile();

  const username = env.DIP_USERNAME || dip.username || '';
  const password = env.DIP_PASSWORD || dip.password || '';
  const host = env.DIP_HOST || dip.host || 'gw.dataimpulse.com';

  const splitList = (v) =>
    String(v || '').split(',').map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);

  const cfg = {
    domain: (env.TH_DOMAIN || '').replace(/^@/, ''),
    mailboxCli: env.MAILBOX_CLI || 'cloud-mail',
    // Mail verification provider. REQUIRED for a usable account: tokenharbor
    // answers 403 email_not_verified until the mailbox link is opened, and the
    // $5 grant cannot be claimed before that. Supabase's email_confirmed_at is
    // set automatically but means nothing to the business logic (measured).
    //   'cloud-mail' (default) - real inbox, produces working accounts
    //   'none'                 - account shell only; API stays locked
    mailMode: env.TH_MAIL_MODE || env.MAIL_MODE || 'cloud-mail',
    dip: { username, password, host, rotatePort: Number(env.DIP_ROTATE_PORT || 823) },
    dipCountry: env.DIP_COUNTRY || 'us',
    count: Number(env.TH_COUNT || 1),
    delayMs: Number(env.TH_DELAY_MS || 8000),
    workers: Number(env.TH_WORKERS || 1),
    inviteCode: env.TH_INVITE_CODE || '',
    // proxy: 'direct' (default, no proxy) | 'sticky' (per-account residential IP) | 'rotate'
    proxyMode: env.TH_PROXY_MODE || 'direct',
    timezone: env.TH_TIMEZONE || 'Asia/Shanghai',
    mailTimeout: Number(env.TH_MAIL_TIMEOUT || 150),
    mailPollInterval: Number(env.TH_MAIL_POLL_INTERVAL || 5),
    accountsFile: env.TH_ACCOUNTS_FILE || 'data/accounts.jsonl',
    // only used by the browser engine (register-browser.mjs), which waits for
    // the dashboard to render; the protocol engine gets a 303 synchronously.
    signupTimeout: Number(env.TH_SIGNUP_TIMEOUT || 60),
    // domain strategy: 'dynamic' (fixed pool + auto top-up of fresh readable
    // subdomains when the batch exceeds maxReuse accounts/domain), 'pool'
    // (round-robin fixed 23-domain pool only), or 'single' (fixed TH_DOMAIN)
    domainMode: env.TH_DOMAIN_MODE || 'dynamic',
    dynamicZones: splitList(env.TH_DYNAMIC_ZONES).length ? splitList(env.TH_DYNAMIC_ZONES) : DYNAMIC_ZONES,
    fixedPool: splitList(env.TH_FIXED_POOL).length ? splitList(env.TH_FIXED_POOL) : FIXED_POOL,
    domainMaxReuse: Number(env.TH_DOMAIN_MAX_REUSE || 2),
    cfEnvchainScope: env.CF_ENVCHAIN_SCOPE || 'cf-migrate-target',
    cfKeychainDir: env.CF_KEYCHAIN_DIR || join(homedir(), 'Library', 'Keychains', 'envchain-scopes'),
    ...overrides,
  };

  // a fixed TH_DOMAIN / --domain forces single-domain mode
  if (cfg.domain) cfg.domainMode = 'single';

  // refuse to run with no catch-all domains (the pool is no longer hardcoded).
  // Must be navigated: .env.local TH_FIXED_POOL / TH_DYNAMIC_ZONES, or single mode.
  if (cfg.domainMode !== 'single') {
    const hasDomains = (cfg.dynamicZones?.length || 0) > 0 || (cfg.fixedPool?.length || 0) > 0;
    if (!hasDomains) {
      throw new Error(
        'no catch-all domains configured. Provide TH_FIXED_POOL / TH_DYNAMIC_ZONES ' +
          '(comma-separated) in .env.local, or use --domain-mode single --domain <yours>.'
      );
    }
  } else if (!cfg.domain) {
    throw new Error('domain-mode single requires --domain <yours> or TH_DOMAIN.');
  }

  // proxy credentials are only required when a proxy mode is actually used;
  // the default `direct` mode needs none.
  if (cfg.proxyMode !== 'direct' && (!cfg.dip.username || !cfg.dip.password)) {
    throw new Error(
      `proxyMode=${cfg.proxyMode} requires DataImpulse credentials. Set DIP_USERNAME/DIP_PASSWORD ` +
        'env vars (or your credential file mounted under a path resolvable by readSecretEnvFile), or use --proxy direct.'
    );
  }
  return cfg;
}

/** Build a DataImpulse sticky proxy endpoint: http://user__cc;sessid.X:pass@host:port */
export function stickyEndpoint(cfg, sessId) {
  const { username, password, host } = cfg.dip;
  const cc = cfg.dipCountry ? `__${cfg.dipCountry}` : '';
  // sticky ports 10000-20000; pick one deterministically from the sessId
  const port = 10000 + (hash(sessId) % 10001);
  return `http://${username}${cc};sessid.${sessId}:${password}@${host}:${port}`;
}

/** Build a rotating endpoint (used for preflight only). */
export function rotateEndpoint(cfg) {
  const { username, password, host } = cfg.dip;
  return `http://${username}:${password}@${host}:${cfg.dip.rotatePort}`;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function randomHex(n = 5) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

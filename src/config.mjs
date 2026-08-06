// Config loader: environment variables + DataImpulse secrets file.
// The .env.local file (gitignored) is loaded first if present.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

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

  const cfg = {
    domain: (env.TH_DOMAIN || 'dogfood.0day3.com').replace(/^@/, ''),
    mailboxCli: env.MAILBOX_CLI || 'cloud-mail',
    dip: { username, password, host, rotatePort: Number(env.DIP_ROTATE_PORT || 823) },
    dipCountry: env.DIP_COUNTRY || 'us',
    count: Number(env.TH_COUNT || 1),
    delayMs: Number(env.TH_DELAY_MS || 8000),
    workers: Number(env.TH_WORKERS || 1),
    inviteCode: env.TH_INVITE_CODE || '',
    signupTimeout: Number(env.TH_SIGNUP_TIMEOUT || 60),
    mailTimeout: Number(env.TH_MAIL_TIMEOUT || 150),
    mailPollInterval: Number(env.TH_MAIL_POLL_INTERVAL || 5),
    accountsFile: env.TH_ACCOUNTS_FILE || 'data/accounts.jsonl',
    ...overrides,
  };

  if (!cfg.dip.username || !cfg.dip.password) {
    throw new Error(
      'DataImpulse credentials missing. Set DIP_USERNAME/DIP_PASSWORD or ensure ' +
        '~/.agents/skills/residential-proxy/.secrets/dataimpulse.env exists (mode 600).'
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

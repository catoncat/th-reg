// Glance panel for pool + supply (TTY live). Read-only.
// Fills the terminal: sections expand with rows/cols — not a postcard in empty space.

import { existsSync, readFileSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT, loadConfig } from './config.mjs';

const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  altOn: '\x1b[?1049h',
  altOff: '\x1b[?1049l',
  clear: '\x1b[H\x1b[J',
  eraseLine: '\x1b[K',
};

/** Window for the per-model spend table. Series holds 6s x 400 = 40 min,
 *  so 30 min stays inside the ring buffer. */
const MODEL_WINDOW_MIN = 30;

function paint(enabled, code, s) {
  if (!enabled || !code) return s;
  return code + s + ansi.reset;
}

function termSize() {
  const cols = process.stdout.columns || Number(process.env.COLUMNS) || 80;
  const rows = process.stdout.rows || Number(process.env.LINES) || 24;
  return { cols: Math.max(48, cols), rows: Math.max(12, rows) };
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function clipLine(line, cols) {
  if (stripAnsi(line).length <= cols) return line;
  let out = '';
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      const m = line.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (n >= cols - 1) break;
    out += line[i];
    n++;
  }
  return out;
}

/** Pack exactly `rows` lines: content from top, footer last, pad only if content short. */
function packFrame(contentLines, footerLine, cols, rows) {
  const foot = clipLine(footerLine || '', cols);
  const budget = Math.max(1, rows - 1);
  const body = contentLines.map((l) => clipLine(l, cols)).slice(0, budget);
  while (body.length < budget) body.push('');
  // Erase to end of line on every row: without this a shorter line leaves the
  // tail of the previous frame visible, which reads as ghosting.
  return [...body, foot].map((l) => l + ansi.eraseLine).join('\n');
}

function gatewayBase() {
  const host = process.env.TH_GATEWAY_HOST || '127.0.0.1';
  const port = process.env.TH_GATEWAY_PORT || 19672;
  return process.env.TH_GATEWAY_URL || 'http://' + host + ':' + port;
}

function supplyLogPath() {
  return process.env.TH_SUPPLY_LOG || join(PROJECT_ROOT, 'data', 'supply.log');
}

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
    /* not loaded */
  }
  let target = cfg.supplyTarget;
  try {
    const plist = readFileSync(cfg.plistPath, 'utf8');
    const m = plist.match(/<string>--target<\/string>\s*<string>([\d.]+)<\/string>/);
    if (m) target = Number(m[1]);
  } catch {
    /* optional */
  }
  return { service: cfg.supplyService, loaded, running: pid !== null, pid, targetUsd: target };
}

async function fetchHealth() {
  const t0 = Date.now();
  try {
    const r = await fetch(gatewayBase() + '/health', { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { ok: false, error: 'http ' + r.status, ms: Date.now() - t0 };
    const j = await r.json();
    return {
      ok: true,
      ms: Date.now() - t0,
      asOf: j.asOf || new Date().toISOString(),
      activeKeys: Number(j.activeKeys) || 0,
      exhaustedKeys: Number(j.exhaustedKeys) || 0,
      deadKeys: Number(j.deadKeys) || 0,
      quotaKeys: Number(j.quotaKeys) || 0,
      totalKeys: Number(j.totalKeys) || 0,
      totalBalance: Number(j.totalBalance) || 0,
      knownBalanceKeys: Number(j.knownBalanceKeys) || 0,
      unknownBalanceKeys: Number(j.unknownBalanceKeys) || 0,
      usedKeys: j.usedKeys != null ? Number(j.usedKeys) : null,
      ledgerSeq: j.ledgerSeq ?? null,
      current: j.current || null,
      source: j.source || 'gateway',
      keys: Array.isArray(j.keys) ? j.keys : [],
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e), ms: Date.now() - t0 };
  }
}

function readTail(path, maxBytes = 128 * 1024) {
  if (!existsSync(path)) return '';
  let fd;
  try {
    fd = openSync(path, 'r');
    const st = fstatSync(fd);
    const size = st.size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function parseSupplyLog(text) {
  const workers = new Map();
  let added = null;
  let maxAdds = null;
  let failStreak = 0;
  let targetGap = null;
  let runWorkers = null;
  const recent = []; // { kind, worker, text, email }

  const pushRecent = (ev) => {
    recent.push(ev);
    if (recent.length > 80) recent.shift();
  };

  const touch = (id, patch) => {
    const prev = workers.get(id) || { id, stage: 'idle', email: '', detail: '', at: null };
    workers.set(id, { ...prev, ...patch });
  };

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;

    let m = line.match(/refilling with (\d+) worker/);
    if (m) runWorkers = Number(m[1]);

    m = line.match(
      /\[w(\d+)\]\s*below target by \$([\d.]+).*added=(\d+)\/(\d+).*failStreak=(\d+)/,
    );
    if (m) {
      const id = m[1];
      targetGap = Number(m[2]);
      added = Number(m[3]);
      maxAdds = Number(m[4]);
      failStreak = Number(m[5]);
      touch(id, { stage: 'signup', email: '', detail: 'registering' });
      continue;
    }

    m = line.match(/\[w(\d+)\]/);
    if (!m) {
      const a = line.match(/done: \+(\d+) account/);
      if (a) added = Number(a[1]);
      continue;
    }
    const id = m[1];
    const rest = line.slice(m.index + m[0].length);

    if (/\[\+\] account created/.test(rest)) {
      touch(id, { stage: 'signup', detail: 'created' });
      pushRecent({ kind: 'signup', worker: id, text: 'account created' });
      continue;
    }
    if (/verification email requested/.test(rest)) {
      touch(id, { stage: 'mail', detail: 'requested' });
      continue;
    }
    if (/\[mailbox\]/.test(rest)) {
      const em = rest.match(/for\s+(\S+@\S+)/);
      touch(id, { stage: 'mail', email: em?.[1] || '', detail: 'inbox' });
      continue;
    }
    if (/email verified/.test(rest)) {
      touch(id, { stage: 'verify', detail: 'verified' });
      pushRecent({ kind: 'verify', worker: id, text: 'email verified', email: workers.get(id)?.email });
      continue;
    }
    if (/free models|API key created|welcome grant/.test(rest)) {
      touch(id, { stage: 'opening', detail: 'claim · key' });
      continue;
    }
    if (/funded account ready:/.test(rest)) {
      const em = rest.match(/ready:\s*(\S+@\S+)/);
      const email = em?.[1] || '';
      touch(id, { stage: 'done', email, detail: '+$5' });
      pushRecent({ kind: 'funded', worker: id, text: '+$5', email });
      continue;
    }
    if (/\[fail\]|not usable|\[retry\]/.test(rest)) {
      touch(id, { stage: 'fail', detail: rest.replace(/^\s+/, '').slice(0, 48) });
      pushRecent({ kind: 'fail', worker: id, text: rest.replace(/^\s+/, '').slice(0, 60) });
      continue;
    }
    if (/domains|waiting/.test(rest)) {
      touch(id, { stage: 'dns', detail: 'domain pool' });
      continue;
    }
  }

  return {
    workers: [...workers.values()].sort((a, b) => Number(a.id) - Number(b.id)),
    added,
    maxAdds,
    failStreak,
    targetGap,
    runWorkers,
    recent,
  };
}


/** Tail gateway.log for spend/exhaust facts (mixed RECENT feed). */

/** Short model label for glance rows. */
function shortProject(name) {
  if (!name) return '?';
  const s = String(name).replace(/\/$/, '');
  return s.split('/').pop() || s;
}

function shortModel(name) {
  if (!name) return '?';
  let s = String(name);
  s = s.replace(/^claude-/, '');
  s = s.replace(/^gemini-/, 'gem-');
  s = s.replace(/^deepseek-/, 'ds-');
  if (s.length > 16) s = s.slice(0, 15) + '…';
  return s;
}

/**
 * Tail gateway.log → model spend facts (no identity).
 * @returns {{ recent: object[], byModel: Record<string,{amount:number,count:number}>, totalSpend: number }}
 */
function parseGatewayLog(text) {
  const recent = [];
  /** @type {Record<string,{amount:number,count:number}>} */
  const byModel = Object.create(null);
  let totalSpend = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;

    let m = line.match(
      /\)\s*->\s*200\b.*?soft−\$?([\d.]+).*?book=\$?([\d.]+)\s+([a-zA-Z0-9._:-]+)/,
    );
    if (m) {
      const amount = Number(m[1]);
      const book = Number(m[2]);
      const model = m[3];
      if (Number.isFinite(amount) && amount > 0) {
        totalSpend += amount;
        if (!byModel[model]) byModel[model] = { amount: 0, count: 0 };
        byModel[model].amount += amount;
        byModel[model].count += 1;
        const projectMatch = line.match(/\sproject=([^\s]+)/);
        const sessionMatch = line.match(/\ssession=([^\s]+)/);
        recent.push({
          kind: 'spend',
          model,
          amount,
          book,
          project: projectMatch ? decodeURIComponent(projectMatch[1]) : null,
          sessionId: sessionMatch ? decodeURIComponent(sessionMatch[1]) : null,
        });
      }
      continue;
    }

    m = line.match(/\)\s*->\s*(?:402|403)\b/);
    if (m) {
      recent.push({ kind: 'exhaust' });
      continue;
    }
    m = line.match(/\)\s*->\s*401\b/);
    if (m) {
      recent.push({ kind: 'dead' });
      continue;
    }
    m = line.match(/\)\s*->\s*429\b/);
    if (m) {
      recent.push({ kind: 'ratelimit' });
      continue;
    }
    m = line.match(/adopted (\d+) new key/);
    if (m) {
      recent.push({ kind: 'adopt', n: Number(m[1]) });
      continue;
    }
    if (/pool exhausted/i.test(line)) {
      recent.push({ kind: 'pool-empty' });
      continue;
    }
    if (/network error/i.test(line)) {
      recent.push({ kind: 'neterr' });
    }
  }

  if (recent.length > 400) recent.splice(0, recent.length - 400);
  return { recent, byModel, totalSpend };
}

function gatewayLogPath() {
  return process.env.TH_GATEWAY_LOG || join(PROJECT_ROOT, 'data', 'gateway.log');
}

/**
 * All-time spend from the ledger, cut two ways: by model and by project.
 * Cached on file size+mtime — this file grows to megabytes and the panel
 * repaints every few seconds.
 */
let ledgerCache = { sig: '', value: null };
function historicalStats() {
  const empty = { models: {}, projects: {}, total: 0, count: 0, since: null };
  const path = join(PROJECT_ROOT, 'data', 'pool-ledger.jsonl');
  if (!existsSync(path)) return empty;
  let sig = '';
  try {
    const st = fstatSync(openSync(path, 'r'));
    sig = st.size + ':' + Number(st.mtimeMs).toFixed(0);
  } catch { /* fall through to reparse */ }
  if (sig && ledgerCache.sig === sig && ledgerCache.value) return ledgerCache.value;

  const models = Object.create(null);
  const projects = Object.create(null);
  let total = 0;
  let count = 0;
  let since = null;
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type !== 'consume' || !ev.model) continue;
      const amount = Number(ev.amount) || 0;
      if (amount <= 0) continue;
      if (!models[ev.model]) models[ev.model] = { amount: 0, count: 0 };
      models[ev.model].amount += amount;
      models[ev.model].count += 1;
      const proj = ev.project ? shortProject(ev.project) : 'unattributed';
      if (!projects[proj]) projects[proj] = { amount: 0, count: 0 };
      projects[proj].amount += amount;
      projects[proj].count += 1;
      total += amount;
      count += 1;
      if (ev.at && (!since || ev.at < since)) since = ev.at;
    }
  } catch { return empty; }
  const value = { models, projects, total, count, since };
  ledgerCache = { sig, value };
  return value;
}

/**
 * Wall-clock time series. gateway.log has no timestamps, so we attribute
 * newly-appended lines to the moment we observe them. Bin = fixed seconds.
 */
function createSeries({ binMs = 10_000, bins = 60 } = {}) {
  /** @type {{ t: number, burn: number, fill: number, req: number, bal: number|null, models: Record<string,{amount:number,count:number}> }[]} */
  const buf = [];
  const binOf = (t) => Math.floor(t / binMs) * binMs;

  /** @type {Map<number, object>} */
  const index = new Map();

  const at = (t) => {
    const key = binOf(t);
    const existing = index.get(key);
    if (existing) return existing;
    const slot = { t: key, burn: 0, fill: 0, req: 0, bal: null, models: Object.create(null) };
    // Observations can arrive out of order (cold-start backfill interleaves
    // with live ticks). Keep bins keyed and sorted rather than assuming the
    // newest write is always the newest bin — appending blindly created
    // duplicate bins whose values were later dropped by window()'s dedup.
    index.set(key, slot);
    if (buf.length && key < buf[buf.length - 1].t) {
      let i = buf.length;
      while (i > 0 && buf[i - 1].t > key) i--;
      buf.splice(i, 0, slot);
    } else {
      buf.push(slot);
    }
    while (buf.length > bins) {
      const dropped = buf.shift();
      index.delete(dropped.t);
    }
    return slot;
  };

  return {
    /** @param {{ burn?: number, fill?: number, req?: number, bal?: number|null, models?: Record<string,{amount:number,count:number}> }} d */
    observe(d, t = Date.now()) {
      const slot = at(t);
      if (d.burn) slot.burn += d.burn;
      if (d.fill) slot.fill += d.fill;
      if (d.req) slot.req += d.req;
      if (d.bal != null) slot.bal = d.bal;
      if (d.models) {
        for (const [model, v] of Object.entries(d.models)) {
          if (!slot.models[model]) slot.models[model] = { amount: 0, count: 0 };
          slot.models[model].amount += v.amount || 0;
          slot.models[model].count += v.count || 0;
        }
      }
    },
    mark(t = Date.now()) {
      at(t);
    },
    binMs,
    all() {
      return buf.slice();
    },
    /** Event-derived rates over the last `mins` minutes: $/min. */
    ratesOver(mins = 2) {
      const n = Math.max(1, Math.round((mins * 60_000) / binMs));
      const win = this.window(n);
      const burn = win.reduce((s, b) => s + b.burn, 0) / mins;
      const fill = win.reduce((s, b) => s + b.fill, 0) / mins;
      const req = win.reduce((s, b) => s + b.req, 0);
      const seen = win.some((b) => b.burn > 0 || b.fill > 0 || b.req > 0);
      return seen ? { burn, fill, net: fill - burn, req } : null;
    },

    /**
     * Per-model spend over the last `mins` minutes, so the figure has a
     * stated time window instead of "whatever fit in the log buffer".
     * spanMin reports the window actually covered by observations, which is
     * shorter than `mins` until the panel has been open that long.
     */
    /**
     * Aggregate per-model spend over the last `mins` minutes.
     * `observedMin` clamps the reported span to how long the caller has
     * actually been watching, so a young panel says "last 20s" instead of
     * claiming a full window it has no data for — while the aggregation
     * itself always scans the full window, which keeps early totals stable
     * rather than letting bins slide in and out of a shrinking range.
     */
    modelsOver(mins = 10, observedMin = Infinity) {
      const n = Math.max(2, Math.ceil((mins * 60_000) / binMs));
      const win = this.window(n);
      /** @type {Record<string,{amount:number,count:number}>} */
      const agg = Object.create(null);
      let total = 0;
      let count = 0;
      for (const b of win) {
        for (const [model, v] of Object.entries(b.models || {})) {
          if (!agg[model]) agg[model] = { amount: 0, count: 0 };
          agg[model].amount += v.amount;
          agg[model].count += v.count;
          total += v.amount;
          count += v.count;
        }
      }
      const full = (win.length * binMs) / 60_000;
      return { models: agg, total, count, spanMin: Math.min(full, observedMin) };
    },

    /** Last n bins, oldest first, always length n (zero-filled). */
    window(n) {
      const now = binOf(Date.now());
      const map = new Map(buf.map((b) => [b.t, b]));
      const out = [];
      for (let i = n - 1; i >= 0; i--) {
        const t = now - i * binMs;
        out.push(map.get(t) || { t, burn: 0, fill: 0, req: 0, bal: null, models: {} });
      }
      return out;
    },
    spanMin(n) {
      return (n * binMs) / 60_000;
    },
  };
}

/** Incremental log reader: returns only bytes appended since last call. */
function createLogFollower(pathFn) {
  let offset = null;
  return function readNew() {
    const path = pathFn();
    if (!existsSync(path)) return '';
    let fd;
    try {
      fd = openSync(path, 'r');
      const size = fstatSync(fd).size;
      if (offset == null) {
        offset = size; // first tick: baseline only, no backfill storm
        return '';
      }
      if (size < offset) offset = 0; // rotated
      const len = size - offset;
      if (len <= 0) return '';
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, offset);
      offset = size;
      return buf.toString('utf8');
    } catch {
      return '';
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  };
}

function createRateTracker() {
  const samples = [];
  return {
    push(bal) {
      const t = Date.now();
      samples.push({ t, bal });
      const cut = t - 180_000;
      while (samples.length > 2 && samples[0].t < cut) samples.shift();
    },
    /** @returns {{ net: number|null, burn: number|null, fill: number|null, dtMin: number|null }} */
    rates() {
      if (samples.length < 2) return { net: null, burn: null, fill: null, dtMin: null };
      const last = samples[samples.length - 1];
      let i = 0;
      for (let k = 0; k < samples.length; k++) {
        if (last.t - samples[k].t >= 55_000) i = k;
      }
      const first = samples[i];
      const dtMin = (last.t - first.t) / 60_000;
      if (dtMin < 0.25) return { net: null, burn: null, fill: null, dtMin };
      let up = 0;
      let down = 0;
      for (let k = i; k < samples.length - 1; k++) {
        const d = samples[k + 1].bal - samples[k].bal;
        if (d > 0) up += d;
        else if (d < 0) down += -d;
      }
      return {
        net: (last.bal - first.bal) / dtMin,
        burn: down / dtMin,
        fill: up / dtMin,
        dtMin,
      };
    },
    netPerMin() {
      return this.rates().net;
    },
    samples() {
      return samples.slice();
    },
  };
}


function money(n) {
  if (n == null || Number.isNaN(n)) return '$—';
  const sign = n < 0 ? '-' : '';
  return (
    sign +
    '$' +
    Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
  );
}

/** Hero book balance with cents — integer $ hid soft-debit movement. */
function moneyBook(n) {
  if (n == null || Number.isNaN(n)) return '$—';
  const sign = n < 0 ? '-' : '';
  return (
    sign +
    '$' +
    Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

function moneyFine(n) {
  if (n == null || Number.isNaN(n)) return '$—';
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toFixed(2);
}


function fmtDur(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return null;
  if (sec < 60) return Math.round(sec) + 's';
  if (sec < 3600) return '~' + Math.round(sec / 60) + ' min';
  return '~' + (sec / 3600).toFixed(1) + ' h';
}

function fmtAge(sec) {
  if (sec == null || sec < 0) return '';
  if (sec < 60) return Math.floor(sec) + 's';
  return Math.floor(sec / 60) + 'm' + String(Math.floor(sec % 60)).padStart(2, '0');
}

function ageSec(at) {
  if (!at) return null;
  return (Date.now() - at) / 1000;
}


/** Share text that stays honest at the small end: 12% / 3.4% / <0.1%. */
function sharePct(pct) {
  if (pct <= 0) return '0%';
  if (pct < 0.1) return '<0.1%';
  if (pct < 10) return pct.toFixed(1) + '%';
  return pct.toFixed(0) + '%';
}

/** Window label: 45s / 8m / 1.5h. */
function fmtSpan(mins) {
  if (!(mins > 0)) return '0s';
  if (mins < 1) return Math.round(mins * 60) + 's';
  if (mins < 60) return Math.round(mins) + 'm';
  return (mins / 60).toFixed(1) + 'h';
}

function padVisible(s, width) {
  const v = stripAnsi(s).length;
  if (v === width) return s;
  if (v > width) return clipLine(s, width);
  return s + ' '.repeat(width - v);
}


/** Pool composition from /health keys (fact buckets, no identity). */
function poolComposition(health) {
  const keys = health.keys || [];
  let fresh = 0;
  let partial = 0;
  let zero = 0;
  let unknown = 0;
  for (const k of keys) {
    const b = k.balance;
    if (b == null || Number.isNaN(b)) unknown++;
    else if (b <= 0.01) zero++;
    else if (b >= 4.99) fresh++;
    else partial++;
  }
  if (!keys.length) {
    return {
      fresh: 0,
      partial: health.activeKeys || 0,
      zero: health.exhaustedKeys || 0,
      unknown: health.unknownBalanceKeys || 0,
      live: health.activeKeys || 0,
      used: health.usedKeys,
      total: health.totalKeys || 0,
    };
  }
  return {
    fresh,
    partial,
    zero,
    unknown,
    live: health.activeKeys || 0,
    used: health.usedKeys,
    total: health.totalKeys || keys.length,
  };
}

// ── Visual vocabulary: one shape per meaning ───────────────
//   progress  ▰▱   pool level toward target
//   share     █░   proportion of a whole (models, key mix)
//   flow      ▐    opposed rate meters (burn vs fill)
//   time      ⠿    braille dual-line chart over a real axis


/** Progress bar: pool level. Distinct glyphs from share. */
function progressBar(frac, width, c, color) {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)));
  return c(color, '▰'.repeat(n)) + c(ansi.gray, '▱'.repeat(width - n));
}


/**
 * Braille dual-line chart with real time axis.
 * Two series share one vertical scale so burn vs fill is directly comparable.
 */
/**
 * Two stacked mini-charts sharing one time axis.
 * burn (continuous) and fill (lumpy +$5 grants) have different natural
 * magnitudes, so each gets its own vertical scale; the shared axis is time.
 */
/**
 * Burn history as a single tall braille chart over a real time axis.
 *
 * Design notes learned the hard way:
 *  - The window must match the data we actually have, or the axis lies.
 *  - Splitting into two 1-row lanes produced scatter, not lines; burn gets
 *    the full height and fill is drawn as event ticks along the baseline.
 */
function classify({ health, ld, supply, rates }) {
  if (!health.ok) return 'DOWN';
  const bal = health.totalBalance;
  const active = health.activeKeys;
  const target = ld.targetUsd || 1000;
  const running = ld.running;
  const fails = supply.failStreak || 0;
  const net = rates?.net;
  const burn = rates?.burn ?? 0;
  const fill = rates?.fill ?? 0;

  if (active === 0 && bal < 0.5) return 'EMPTY';
  if (running && fails >= 4) return 'STALLED';
  if (active > 0 && bal < target * 0.05 && running) return 'RECOVERING';

  // Net outflow is normal at a healthy level — supply only tops up on demand.
  // Draining is a warning about the level, not about momentary direction.
  const runway = net != null && net < -0.05 ? (bal / Math.abs(net)) * 60 : Infinity;
  const lowLevel = bal < target * 0.9;
  const shortRunway = runway < 20 * 60; // under ~20 minutes of headroom
  if (lowLevel && shortRunway && fill < burn * 0.4) return 'DRAINING';

  if (running && bal < target * 0.98) return 'REFILLING';
  if (bal >= target * 0.98) {
    if (net != null && net < -0.05 && burn > 0.5) return 'BALANCED';
    return 'HEALTHY';
  }
  return 'REFILLING';
}

/** Verdict: one sentence, one supporting clause. Never repeated elsewhere. */
function conclusion({ mood, health, ld, rates, supply }) {
  const target = ld.targetUsd || 1000;
  const bal = health.ok ? health.totalBalance : 0;
  const net = rates?.net;

  const eta = () => {
    if (net == null) return null;
    if (net < -0.05 && bal > 0) return 'dry in ' + fmtDur((bal / Math.abs(net)) * 60);
    if (net > 0.05 && bal < target) return 'full in ' + fmtDur(((target - bal) / net) * 60);
    return null;
  };

  switch (mood) {
    case 'DOWN':
      return { title: 'GATEWAY DOWN', sub: health.error || 'unreachable', color: ansi.red };
    case 'EMPTY':
      return {
        title: 'EMPTY',
        sub: ld.running ? 'supply engaged · first key ~60s' : 'supply idle · needs a kick',
        color: ansi.red,
      };
    case 'STALLED':
      return {
        title: 'STALLED',
        sub: 'supply failing ×' + supply.failStreak + ' · captcha / mail / proxy',
        color: ansi.red,
      };
    case 'DRAINING':
      return { title: 'DRAINING', sub: eta() || 'burn outpacing fill', color: ansi.yellow };
    case 'RECOVERING':
      return { title: 'RECOVERING', sub: eta() || 'climbing out of empty', color: ansi.yellow };
    case 'REFILLING':
      return { title: 'REFILLING', sub: eta() || 'supply working', color: ansi.yellow };
    case 'BALANCED': {
      const runway =
        rates?.net != null && rates.net < -0.05
          ? 'headroom ' + fmtDur((bal / Math.abs(rates.net)) * 60)
          : 'holding';
      return { title: 'AT TARGET', sub: runway + ' · supply tops up on demand', color: ansi.green };
    }
    default:
      return {
        title: 'HEALTHY',
        sub: bal >= target ? 'at or above target' : 'comfortable level',
        color: ansi.green,
      };
  }
}

function stageLabel(stage) {
  const map = {
    signup: 'signup',
    mail: 'mailbox',
    verify: 'verify',
    opening: 'opening',
    done: 'done',
    fail: 'fail',
    dns: 'dns',
    idle: 'idle',
  };
  return map[stage] || stage;
}

/** HH:MM:SS for feed rows — the panel's own clock, not the log's. */
function clockOf(t) {
  return new Date(t).toLocaleTimeString('en-GB', { hour12: false });
}

/** Rolling event feed: newest first. */
function feedLine(ev, c, W) {
  const pad2 = (s, n) => padVisible(s, n);
  switch (ev.kind) {
    case 'spend': {
      // No per-row icon: at ~1 line/second a glyph column becomes noise.
      // Weight carries the signal instead — big spends are the only red ones.
      const heavy = ev.amount >= 0.25;
      const amt = ('−$' + ev.amount.toFixed(2)).padStart(8);
      const project = ev.project ? shortProject(ev.project) : '';
      return (
        c(ansi.dim, ev.at ? clockOf(ev.at) : '     ') +
        ' ' +
        pad2(c(ansi.bold, shortModel(ev.model)), 17) +
        c(heavy ? ansi.red : ansi.dim, amt) +
        '  ' +
        (project ? c(ansi.dim, project) : '')
      );
    }
    case 'funded':
      return (
        c(ansi.dim, ev.at ? clockOf(ev.at) : '     ') +
        ' ' +
        padVisible(c(ansi.green, '+ new account'), 17) +
        c(ansi.green, '  +$5.00'.padStart(8))
      );
    case 'exhaust':
      return c(ansi.dim, ev.at ? clockOf(ev.at) : '     ') + ' ' + c(ansi.dim, 'key drained, rotating');
    case 'dead':
      return c(ansi.dim, ev.at ? clockOf(ev.at) : '     ') + ' ' + c(ansi.red, 'key rejected (401)');
    case 'ratelimit':
      return c(ansi.dim, ev.at ? clockOf(ev.at) : '     ') + ' ' + c(ansi.yellow, 'rate limited, backing off');
    case 'adopt':
      return c(ansi.dim, ev.at ? clockOf(ev.at) : '     ') + ' ' + c(ansi.green, '+' + ev.n + ' key(s) live');
    case 'pool-empty':
      return c(ansi.dim, ev.at ? clockOf(ev.at) : '     ') + ' ' + c(ansi.red, 'POOL EMPTY — requests failing');
    case 'neterr':
      return c(ansi.dim, ev.at ? clockOf(ev.at) : '     ') + ' ' + c(ansi.dim, 'network retry, next key');
    case 'stage':
      return (
        c(ansi.yellow, '◐') +
        ' ' +
        c(ansi.dim, 'supply ') +
        pad2(c(ansi.dim, 'w' + ev.worker + ' ' + ev.stage), 14) +
        c(ansi.dim, ev.detail || '')
      );
    default:
      return c(ansi.dim, '· ' + (ev.text || ev.kind));
  }
}

/**
 * Layout, driven by how this panel is actually used:
 *   it stays open all day, so it must feel alive and answer three things —
 *   how much money is left, is supply really working, what is burning now.
 *
 *   1 MONEY    balance, direction, runway
 *   2 SUPPLY   is it working, which stage, how many this run
 *   3 MODELS   share of spend as plain text + percent
 *   4 LIVE     event feed, newest last, fills all remaining rows
 */
function renderGlance(ctx) {
  const { health, ld, supply, rates, netPerMin, now, cols, rows, sessionStartBal, gateway } = ctx;
  const tty = ctx.tty;
  const c = (code, s) => paint(tty, code, s);
  const rateObj = rates || { net: netPerMin };
  const mood = classify({ ...ctx, rates: rateObj });
  const head = conclusion({ ...ctx, mood, rates: rateObj });

  const target = ld.targetUsd || 1000;
  const bal = health.ok ? health.totalBalance : 0;
  const pct = target > 0 ? Math.min(1, bal / target) : 0;
  const net = rateObj?.net ?? netPerMin;
  const burn = rateObj?.burn;
  const comp = health.ok ? poolComposition(health) : null;

  const gutter = 2;
  const W = Math.max(44, cols - gutter * 2);
  const pad = (s) => ' '.repeat(gutter) + s;
  const out = [];
  const add = (s = '') => out.push(s.length ? pad(s) : '');

  const accent =
    mood === 'EMPTY' || mood === 'STALLED' || mood === 'DOWN'
      ? ansi.red
      : mood === 'HEALTHY' || mood === 'BALANCED'
        ? ansi.green
        : ansi.yellow;

  if (!health.ok) {
    add('');
    add(c(ansi.bold, c(ansi.red, 'GATEWAY DOWN')) + c(ansi.dim, '   ' + (health.error || '')));
    add('');
    add(c(ansi.dim, 'launchctl kickstart gui/$(id -u)/com.tokenharbor.gateway'));
  } else {
    // ── 1 MONEY ────────────────────────────────────────────
    add('');
    const dir = net == null ? '' : net >= 0 ? '▲' : '▼';
    const dirColor = net == null ? ansi.dim : net >= 0 ? ansi.green : ansi.red;
    const rateTxt = burn == null ? 'measuring' : moneyFine(burn) + '/min';
    add(
      c(ansi.bold, c(accent, moneyBook(bal))) +
        c(ansi.dim, '  of ' + money(target)) +
        '   ' +
        c(dirColor, dir + ' ' + rateTxt),
    );
    add(c(ansi.bold, c(accent, head.title)) + c(ansi.dim, '  ' + head.sub));
    add(progressBar(pct, W, c, accent) + c(ansi.dim, ' ' + Math.round(pct * 100) + '%'));

    if (comp) {
      add(
        c(ansi.dim, 'keys  ') +
          c(ansi.green, comp.fresh + ' full') +
          c(ansi.dim, ' · ') +
          c(ansi.yellow, comp.partial + ' partial') +
          c(ansi.dim, ' · ') +
          c(ansi.dim, comp.zero + ' empty') +
          c(ansi.dim, '   (' + comp.total + ' total)'),
      );
    }
    add('');

    // ── 2 SUPPLY ───────────────────────────────────────────
    if (!ld.loaded) {
      add(c(ansi.dim, 'supply  ') + c(ansi.red, 'launchd not loaded'));
    } else if (!ld.running) {
      const last = supply.added != null && supply.added > 0 ? ' · last run +' + supply.added : '';
      add(c(ansi.dim, 'supply  ') + c(ansi.dim, 'idle, tops up on demand' + last));
    } else {
      const ws = supply.workers || [];
      const chips = ws.map((wk) => {
        const col =
          wk.stage === 'done' ? ansi.green : wk.stage === 'fail' ? ansi.red : ansi.yellow;
        const age = ageSec(wk.at);
        return (
          c(col, 'w' + wk.id + ' ' + stageLabel(wk.stage)) +
          c(ansi.dim, age != null ? ' ' + fmtAge(age) : '')
        );
      });
      add(
        c(ansi.dim, 'supply  ') +
          (chips.length ? chips.join(c(ansi.dim, '  ')) : c(ansi.yellow, 'starting…')) +
          c(ansi.dim, supply.added != null ? '   +' + supply.added + ' this run' : ''),
      );
    }
    add('');

    // ── 3 SPEND: all-time totals, cut by model and by project ──
    const hist = historicalStats();
    const mtotal = hist.total;
    const sinceLabel = hist.since
      ? new Date(hist.since).toLocaleDateString('en-CA')
      : null;
    add(
      c(ansi.bold, 'spent  ') +
        c(ansi.red, moneyBook(mtotal)) +
        c(ansi.dim, '  across ' + hist.count.toLocaleString('en-US') + ' requests') +
        c(ansi.dim, sinceLabel ? '  since ' + sinceLabel : ''),
    );
    add('');

    const rank = (obj) =>
      Object.entries(obj || {})
        .map(([name, v]) => ({ name, amount: v.amount, count: v.count }))
        .sort((a, b) => b.amount - a.amount);
    const mrows = rank(hist.models);
    const prows = rank(hist.projects);

    /** Two stacked tables share one column grid so the eye can scan down. */
    const statRow = (label, r, labelFn) =>
      '  ' +
      padVisible(c(ansi.bold, labelFn(r.name)), 22) +
      c(ansi.dim, moneyFine(r.amount).padStart(10)) +
      c(accent, sharePct(mtotal > 0 ? (r.amount / mtotal) * 100 : 0).padStart(7)) +
      c(ansi.dim, ('×' + r.count.toLocaleString('en-US')).padStart(8)) +
      c(ansi.dim, ('$' + (r.count ? r.amount / r.count : 0).toFixed(2) + '/req').padStart(12));

    if (mrows.length) {
      add(c(ansi.dim, 'by model'));
      for (const r of mrows.slice(0, 5)) add(statRow('model', r, shortModel));
      add('');
    }
    // Attribution only exists for traffic seen after the gateway learned to
    // record it, so scope this table to attributed spend and say so.
    const attributed = prows.filter((r) => r.name !== 'unattributed');
    const attrTotal = attributed.reduce((s, r) => s + r.amount, 0);
    if (attributed.length) {
      add(
        c(ansi.dim, 'by project') +
          c(ansi.dim, '  ' + moneyFine(attrTotal) + ' attributed'),
      );
      for (const r of attributed.slice(0, 4)) {
        add(
          '  ' +
            padVisible(c(ansi.bold, r.name), 22) +
            c(ansi.dim, moneyFine(r.amount).padStart(10)) +
            c(accent, sharePct(attrTotal > 0 ? (r.amount / attrTotal) * 100 : 0).padStart(7)) +
            c(ansi.dim, ('×' + r.count.toLocaleString('en-US')).padStart(8)) +
            c(ansi.dim, ('$' + (r.count ? r.amount / r.count : 0).toFixed(2) + '/req').padStart(12)),
        );
      }
      add('');
    }
  }

  // ── 4 LIVE FEED: fills whatever is left ──────────────────
  const footerReserve = 1;
  const spare = rows - footerReserve - out.length;
  if (health.ok && spare >= 3) {
    add(c(ansi.dim, 'live') + c(ansi.dim, '  newest first'));
    const budget = Math.max(1, rows - footerReserve - out.length);

    const tail = (ctx.feed || []).slice(-budget).reverse();
    if (!tail.length) {
      add(c(ansi.dim, 'waiting for traffic…'));
    } else {
      for (const ev of tail) add(feedLine(ev, c, W));
    }
  }

  const clock = new Date(now).toLocaleTimeString('en-GB', { hour12: false });
  const sess =
    sessionStartBal != null && Math.abs(bal - sessionStartBal) >= 0.005
      ? 'session ' + (bal - sessionStartBal >= 0 ? '+' : '') + moneyBook(bal - sessionStartBal)
      : null;
  const dock = ['q quit', sess, health.ok ? 'ledger #' + (health.ledgerSeq ?? '—') : null]
    .filter(Boolean)
    .join('  ·  ');
  const gap = Math.max(2, cols - gutter * 2 - dock.length - clock.length);
  const footer = pad(c(ansi.dim, dock) + ' '.repeat(gap) + c(ansi.dim, clock));

  if (!tty) return [...out, '', footer].join('\n') + '\n';
  return packFrame(out, footer, cols, rows);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {{ once?: boolean }} opts */
export async function runWatch(opts = {}) {
  const cfg = loadConfig({});
  const tty = !!(process.stdout.isTTY && !opts.once && process.env.TH_WATCH_ONCE !== '1');
  const rates = createRateTracker();
  const series = createSeries({ binMs: 6_000, bins: 400 });
  const followGateway = createLogFollower(gatewayLogPath);
  const followSupply = createLogFollower(supplyLogPath);
  const startedAt = Date.now();
  let sessionStartBal = null;

  let quitting = false;
  const restore = () => {
    if (!tty) return;
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
      process.stdin.pause();
    } catch {
      /* ignore */
    }
    process.stdout.write(ansi.show + ansi.altOff);
  };

  if (tty) {
    process.stdout.write(ansi.altOn + ansi.hide);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (key) => {
        if (key === 'q' || key === '\u0003') quitting = true;
      });
    }
    process.on('exit', restore);
    process.on('SIGINT', () => {
      quitting = true;
    });
  }

  const stageSince = new Map();

  // Cold start: the logs have no timestamps, but their tail is recent traffic.
  // Spread it across the recent window so the first frame is informative.
  /** @type {{ kind: string, [k: string]: any }[]} */
  const feed = [];
  const pushFeed = (evs, at = Date.now()) => {
    for (const ev of evs) feed.push(ev.at ? ev : { ...ev, at });
    if (feed.length > 500) feed.splice(0, feed.length - 500);
  };

  let seeded = false;
  const seedFromLogs = (nowMs) => {
    if (seeded) return;
    seeded = true;
    const gw = parseGatewayLog(readTail(gatewayLogPath()));
    const spends = (gw.recent || []).filter((e) => e.kind === 'spend');
    if (!spends.length) return;
    const spanMs = Math.min(10 * 60_000, spends.length * 4_000);
    const step = spanMs / spends.length;
    // Deliberately no per-model data here: these timestamps are synthetic
    // (N spends spread over an assumed 4s cadence), so the span they imply is
    // a guess. Compressing a long log tail into 10 minutes made the model
    // table read −$318 "last 10m" = $31/min against a measured $12/min.
    // The table therefore counts only what this process actually observed.
    spends.forEach((ev, i) => {
      series.observe({ burn: ev.amount || 0, req: 1 }, nowMs - spanMs + i * step);
    });
    // Prime the feed so the panel opens with recent history, not a blank tail.
    // These lines have no clock of their own; spread them over the synthetic
    // span so the timestamps stay ordered instead of all claiming "now".
    const primed = (gw.recent || []).slice(-60);
    primed.forEach((ev, i) => {
      pushFeed([ev], nowMs - spanMs + ((i + 1) * spanMs) / (primed.length || 1));
    });
  };

  try {
    do {
      const health = await fetchHealth();
      if (health.ok) {
        rates.push(health.totalBalance);
        if (sessionStartBal == null) sessionStartBal = health.totalBalance;
      }
      const ld = launchd(cfg);
      const supply = parseSupplyLog(readTail(supplyLogPath()));
      const gateway = parseGatewayLog(readTail(gatewayLogPath()));
      const nowMs = Date.now();

      // Attribute newly-appended log lines to this instant (logs carry no clock).
      const freshGw = parseGatewayLog(followGateway());
      let burnTick = 0;
      let reqTick = 0;
      for (const ev of freshGw.recent) {
        if (ev.kind === 'spend') {
          burnTick += ev.amount || 0;
          reqTick += 1;
        }
      }
      const modelsTick = freshGw.byModel || {};
      const freshSupply = parseSupplyLog(followSupply());
      const fillTick = (freshSupply.recent || []).filter((e) => e.kind === 'funded').length * 5;

      // Merge this tick's events from both logs; within a tick, order is
      // arbitrary but the tick boundary keeps the feed roughly chronological.
      pushFeed(freshGw.recent || []);
      for (const ev of freshSupply.recent || []) {
        if (ev.kind === 'funded') pushFeed([{ kind: 'funded' }]);
        else if (ev.kind === 'fail') pushFeed([{ kind: 'supply-fail' }]);
      }
      seedFromLogs(nowMs);
      series.observe(
        {
          burn: burnTick,
          fill: fillTick,
          req: reqTick,
          models: modelsTick,
          bal: health.ok ? health.totalBalance : null,
        },
        nowMs,
      );
      series.mark(nowMs);
      for (const wk of supply.workers) {
        const key = String(wk.id);
        const prev = stageSince.get(key);
        if (!prev || prev.stage !== wk.stage || prev.email !== (wk.email || '')) {
          stageSince.set(key, { stage: wk.stage, email: wk.email || '', at: nowMs });
          wk.at = nowMs;
        } else {
          wk.at = prev.at;
        }
      }
      const sampled = rates.rates();
      const observed = series.ratesOver(2);
      const rateSnap = observed
        ? { burn: observed.burn, fill: observed.fill, net: observed.net, dtMin: 2 }
        : sampled;
      // Fixed aggregation window; the label is clamped to real observation
      // time so it never claims a period this process did not watch.
      const modelWindow = series.modelsOver(
        MODEL_WINDOW_MIN,
        (nowMs - startedAt) / 60_000,
      );

      const { cols, rows } = termSize();
      const frame = renderGlance({
        tty,
        health,
        ld,
        supply,
        rates: rateSnap,
        netPerMin: rateSnap.net,
        rateSamples: rates.samples(),
        sessionStartBal,
        gateway,
        modelWindow,
        feed,
        series,
        now: nowMs,
        startedAt,
        cols,
        rows,
      });

      if (tty) process.stdout.write(ansi.clear + frame);
      else {
        process.stdout.write(frame);
        break;
      }

      const tEnd = Date.now() + 1000;
      while (!quitting && Date.now() < tEnd) await sleep(40);
    } while (tty && !quitting);
  } finally {
    restore();
  }
}



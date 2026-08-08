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
};

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
  return [...body, foot].join('\n');
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

    // soft−0.80 book=4.19 claude-opus-5   OR   −$0.80 bal=$4.19 claude-opus-5
    let m = line.match(
      /\)\s*->\s*200\b.*?soft−\$?([\d.]+).*?book=\$?[\d.]+\s+([a-zA-Z0-9._:-]+)/,
    );
    if (!m) {
      m = line.match(
        /\)\s*->\s*200\b.*?−\$([\d.]+)\s+bal=\$[\d.]+\s+([a-zA-Z0-9._:-]+)/,
      );
    }
    if (m) {
      const amount = Number(m[1]);
      const model = m[2];
      if (Number.isFinite(amount) && amount > 0) {
        totalSpend += amount;
        if (!byModel[model]) byModel[model] = { amount: 0, count: 0 };
        byModel[model].amount += amount;
        byModel[model].count += 1;
        recent.push({ kind: 'spend', model, amount });
      }
      continue;
    }

    if (/\)\s*->\s*(?:402|403)\b.*\bbalance\b/i.test(line) || /\(balance\)/.test(line) && /->\s*40[23]/.test(line)) {
      const mm = line.match(/\s([a-zA-Z0-9._:-]+)\s*$/);
      recent.push({ kind: 'exhaust', model: mm ? mm[1] : null });
      continue;
    }
    if (/pool exhausted/i.test(line)) {
      recent.push({ kind: 'empty', text: 'pool exhausted' });
    }
  }

  if (recent.length > 120) recent.splice(0, recent.length - 120);
  return { recent, byModel, totalSpend };
}

function gatewayLogPath() {
  return process.env.TH_GATEWAY_LOG || join(PROJECT_ROOT, 'data', 'gateway.log');
}

/**
 * Wall-clock time series. gateway.log has no timestamps, so we attribute
 * newly-appended lines to the moment we observe them. Bin = fixed seconds.
 */
function createSeries({ binMs = 10_000, bins = 60 } = {}) {
  /** @type {{ t: number, burn: number, fill: number, req: number, bal: number|null }[]} */
  const buf = [];
  const binOf = (t) => Math.floor(t / binMs) * binMs;

  const at = (t) => {
    const key = binOf(t);
    let last = buf[buf.length - 1];
    if (!last || last.t !== key) {
      last = { t: key, burn: 0, fill: 0, req: 0, bal: null };
      buf.push(last);
      while (buf.length > bins) buf.shift();
    }
    return last;
  };

  return {
    /** @param {{ burn?: number, fill?: number, req?: number, bal?: number|null }} d */
    observe(d, t = Date.now()) {
      const slot = at(t);
      if (d.burn) slot.burn += d.burn;
      if (d.fill) slot.fill += d.fill;
      if (d.req) slot.req += d.req;
      if (d.bal != null) slot.bal = d.bal;
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

    /** Last n bins, oldest first, always length n (zero-filled). */
    window(n) {
      const now = binOf(Date.now());
      const map = new Map(buf.map((b) => [b.t, b]));
      const out = [];
      for (let i = n - 1; i >= 0; i--) {
        const t = now - i * binMs;
        out.push(map.get(t) || { t, burn: 0, fill: 0, req: 0, bal: null });
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

/** Share bar: solid vs light, for "part of a whole". */
function shareBar(frac, width, c, color) {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)));
  return c(color, '█'.repeat(n)) + c(ansi.gray, '░'.repeat(width - n));
}

/** Progress bar: pool level. Distinct glyphs from share. */
function progressBar(frac, width, c, color) {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)));
  return c(color, '▰'.repeat(n)) + c(ansi.gray, '▱'.repeat(width - n));
}

/** Stacked composition bar: full / partial / empty in one strip. */
function stackBar(parts, width, c) {
  const total = parts.reduce((s, p) => s + p.n, 0) || 1;
  let used = 0;
  let out = '';
  parts.forEach((p, i) => {
    let n = i === parts.length - 1 ? width - used : Math.round((p.n / total) * width);
    n = Math.max(0, Math.min(width - used, n));
    used += n;
    out += c(p.color, p.glyph.repeat(n));
  });
  return out;
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
function burnChart(series, width, height, c) {
  const w = Math.max(12, width);
  const h = Math.max(2, height);
  const cells = w * 2;

  // Only chart the span we have data for; never paint an empty past.
  const all = series.all();
  const withData = all.filter((b) => b.burn > 0 || b.fill > 0 || b.req > 0);
  if (!withData.length) {
    return [c(ansi.dim, 'no traffic observed yet')];
  }
  const oldest = withData[0].t;
  const nowBin = Math.floor(Date.now() / series.binMs) * series.binMs;
  const haveBins = Math.max(1, Math.round((nowBin - oldest) / series.binMs) + 1);
  const useBins = Math.min(cells, haveBins);

  const win = series.window(useBins);
  const perMin = 60_000 / series.binMs;

  // Resample onto the pixel grid so the drawing always spans the full width.
  const burnRaw = new Array(cells).fill(0);
  const fill = new Array(cells).fill(0);
  for (let i = 0; i < cells; i++) {
    const src = Math.min(win.length - 1, Math.floor((i / cells) * win.length));
    burnRaw[i] = win[src].burn * perMin;
    fill[i] = win[src].fill * perMin;
  }

  // Carry the last known value across empty bins: a gap means "no request
  // landed in this 6s slot", not "spend dropped to zero".
  let carry = 0;
  for (let i = 0; i < cells; i++) {
    if (burnRaw[i] > 0) carry = burnRaw[i];
    else burnRaw[i] = carry;
  }

  // Requests land on bin boundaries unevenly, so a steady spend renders as a
  // sawtooth. Smooth the burn line; the shape is the signal, not the binning.
  const smoothW = Math.max(2, Math.round(cells / 40));
  const burn = burnRaw.map((_, i) => {
    const lo = Math.max(0, i - smoothW);
    const hi = Math.min(burnRaw.length - 1, i + smoothW);
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += burnRaw[k];
    return sum / (hi - lo + 1);
  });

  // Scale to the observed band, not 0..peak: a line hovering at $18 with a
  // lone $29 spike would otherwise sit in the middle with dead space above
  // and below. Keep zero visible only when the data actually approaches it.
  const vmax = Math.max(...burn, 0.0001);
  const vmin = Math.min(...burn);
  const nearZero = vmin < vmax * 0.25;
  const lo = nearZero ? 0 : vmin - (vmax - vmin) * 0.15;
  const hi = vmax + (vmax - lo) * 0.05;
  const range = Math.max(hi - lo, 0.0001);
  const dotRows = h * 4;
  const grid = Array.from({ length: h }, () => new Array(w).fill(0));

  for (let i = 0; i < cells; i++) {
    const v = burn[i];
    if (v <= 0) continue;
    const level = Math.min(
      dotRows - 1,
      Math.max(0, Math.round(((v - lo) / range) * (dotRows - 1))),
    );
    const col = Math.floor(i / 2);
    const half = i % 2;
    const row = h - 1 - Math.floor(level / 4);
    const dotIdx = level % 4;
    const bits = half === 0 ? [0x40, 0x04, 0x02, 0x01] : [0x80, 0x20, 0x10, 0x08];
    grid[row][col] |= bits[3 - dotIdx];
  }

  const lines = [];
  for (let r = 0; r < h; r++) {
    let body = '';
    for (let x = 0; x < w; x++) {
      const mask = grid[r][x];
      body += mask ? String.fromCharCode(0x2800 + mask) : ' ';
    }
    let line = c(ansi.red, body);
    if (r === 0) line += c(ansi.dim, '  ' + moneyFine(hi) + '/m');
    else if (r === h - 1) line += c(ansi.dim, '  ' + moneyFine(Math.max(0, lo)) + '/m');
    lines.push(line);
  }

  // Fill events as ticks on the baseline: lumpy grants, not a continuous rate.
  let ticks = '';
  let anyFill = false;
  for (let x = 0; x < w; x++) {
    const a = fill[x * 2] || 0;
    const b = fill[x * 2 + 1] || 0;
    if (a > 0 || b > 0) {
      ticks += '▲';
      anyFill = true;
    } else ticks += ' ';
  }
  if (anyFill) lines.push(c(ansi.green, ticks) + c(ansi.dim, '  +$5 grants'));

  // Axis reflects the real span of the data on screen.
  const spanMin = (useBins * series.binMs) / 60_000;
  const ticksN = Math.max(2, Math.min(5, Math.floor(w / 14)));
  let axis = '';
  let cursor = 0;
  for (let i = 0; i < ticksN; i++) {
    const frac = i / (ticksN - 1);
    const pos = Math.round(frac * (w - 1));
    const mins = spanMin * (1 - frac);
    const label =
      i === ticksN - 1
        ? 'now'
        : '-' + (mins >= 1 ? Math.round(mins) + 'm' : Math.round(mins * 60) + 's');
    const target = Math.min(pos, w - label.length);
    if (target > cursor) {
      axis += ' '.repeat(target - cursor);
      cursor = target;
    }
    if (cursor <= w - label.length) {
      axis += label;
      cursor += label.length;
    }
  }
  lines.push(c(ansi.dim, axis));
  return lines;
}

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

/**
 * Layout — one subject per band, top to bottom by eye priority:
 *   1 MONEY      the number, its direction, its deadline
 *   2 FLOW       burn vs fill, opposed meters on a shared scale
 *   3 TIME       dual-line chart with a real axis   ← the missing piece
 *   4 MODELS     share of burn + unit price
 *   5 KEYS       stacked composition, one strip
 *   6 SUPPLY     one line idle, worker rows only when busy
 */
function renderGlance(ctx) {
  const { health, ld, supply, rates, netPerMin, now, cols, rows, sessionStartBal, gateway, series } = ctx;
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
  const fill = rateObj?.fill;
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

  // ── 1 MONEY ──────────────────────────────────────────────
  add('');
  if (!health.ok) {
    add(c(ansi.bold, c(ansi.red, 'GATEWAY DOWN')) + c(ansi.dim, '   ' + (health.error || '')));
    add('');
    add(c(ansi.dim, 'launchctl kickstart gui/$(id -u)/com.tokenharbor.gateway'));
  } else {
    const big = moneyBook(bal);
    const dir = net == null ? '' : net >= 0 ? '▲' : '▼';
    const dirColor = net == null ? ansi.dim : net >= 0 ? ansi.green : ansi.red;
    const rate = net == null ? 'measuring' : moneyFine(Math.abs(net)) + '/min';
    add(
      c(ansi.bold, c(accent, big)) +
        c(ansi.dim, '  of ' + money(target) + '   ') +
        c(dirColor, dir + ' ' + rate),
    );
    add(
      c(ansi.bold, c(accent, head.title)) + c(ansi.dim, '  ' + head.sub),
    );
    add(progressBar(pct, W, c, accent) + c(ansi.dim, ' ' + Math.round(pct * 100) + '%'));
    add('');

    // ── 2 FLOW: opposed meters on a stable, historical scale ──
    // Scaling to max(burn, fill) alone pins the larger bar at 100% forever.
    // Anchor to the recent peak so the bars encode magnitude, not just rank.
    const hist = series ? series.window(200) : [];
    const perMinHist = series ? 60_000 / series.binMs : 1;
    const histPeak = hist.length
      ? Math.max(...hist.map((b) => Math.max(b.burn, b.fill) * perMinHist))
      : 0;
    const scale = Math.max(burn || 0, fill || 0, histPeak, 0.01);
    const meterW = Math.max(10, Math.floor(W * 0.45));
    const fmtRate = (v, sign) => (v == null ? '  measuring' : (sign + moneyFine(v) + '/m').padStart(11));
    add(
      c(ansi.dim, 'burn ') +
        c(ansi.red, fmtRate(burn, '−')) +
        '  ' +
        shareBar(burn == null ? 0 : burn / scale, meterW, c, ansi.red),
    );
    add(
      c(ansi.dim, 'fill ') +
        c(ansi.green, fmtRate(fill, '+')) +
        '  ' +
        shareBar(fill == null ? 0 : fill / scale, meterW, c, ansi.green),
    );
    add('');

    // ── 3 TIME ─────────────────────────────────────────────
    if (series) {
      add(c(ansi.dim, 'burn over time'));
      const chartH = rows >= 34 ? 6 : rows >= 28 ? 5 : 4;
      for (const line of burnChart(series, W - 2, chartH, c)) add('  ' + line);
      add('');
    }

    // ── 4 MODELS: share of burn + unit price ───────────────
    const byModel = gateway?.byModel || {};
    const mrows = Object.entries(byModel)
      .map(([model, v]) => ({ model, amount: v.amount, count: v.count }))
      .sort((a, b) => b.amount - a.amount);
    const mtotal = mrows.reduce((s, r) => s + r.amount, 0);
    if (mrows.length) {
      const barW = Math.max(8, Math.floor(W * 0.3));
      for (const r of mrows.slice(0, 4)) {
        const frac = mtotal > 0 ? r.amount / mtotal : 0;
        add(
          c(ansi.bold, padVisible(shortModel(r.model), 12)) +
            c(ansi.dim, (Math.round(frac * 100) + '%').padStart(5)) +
            ' ' +
            shareBar(frac, barW, c, ansi.red) +
            c(ansi.dim, ('$' + (r.count ? r.amount / r.count : 0).toFixed(2) + '/req').padStart(13)) +
            c(ansi.dim, ('×' + r.count).padStart(7)),
        );
      }
      add('');
    }

    // ── 5 KEYS: one stacked strip ──────────────────────────
    if (comp) {
      const stripW = Math.max(12, Math.floor(W * 0.5));
      const strip = stackBar(
        [
          { n: comp.fresh, glyph: '█', color: ansi.green },
          { n: comp.partial, glyph: '▓', color: ansi.yellow },
          { n: comp.zero, glyph: '░', color: ansi.gray },
        ],
        stripW,
        c,
      );
      add(
        c(ansi.dim, 'keys  ') +
          strip +
          c(ansi.dim, '  ') +
          c(ansi.green, comp.fresh + ' full') +
          c(ansi.dim, ' · ') +
          c(ansi.yellow, comp.partial + ' part') +
          c(ansi.dim, ' · ') +
          c(ansi.dim, comp.zero + ' empty'),
      );
    }

    // ── 6 SUPPLY: one line idle, rows when busy ────────────
    if (!ld.running) {
      const lastRun = supply.added != null && supply.added > 0 ? ' · last +' + supply.added : '';
      add(c(ansi.dim, 'supply  ') + c(ansi.dim, ld.loaded ? 'idle · next ≤60s' + lastRun : 'not loaded'));
    } else {
      const ws = supply.workers || [];
      const chips = ws.map((wk) => {
        const col =
          wk.stage === 'done' ? ansi.green : wk.stage === 'fail' ? ansi.red : ansi.yellow;
        const age = ageSec(wk.at);
        return c(col, 'w' + wk.id + ' ' + stageLabel(wk.stage)) + c(ansi.dim, age != null ? ' ' + fmtAge(age) : '');
      });
      add(
        c(ansi.dim, 'supply  ') +
          (chips.length ? chips.join(c(ansi.dim, '  ')) : c(ansi.dim, 'starting…')) +
          c(ansi.dim, supply.added != null ? '   +' + supply.added + '/' + (supply.maxAdds ?? '?') : ''),
      );
    }
  }

  // ── footer: provenance, nothing else ─────────────────────
  const clock = new Date(now).toLocaleTimeString('en-GB', { hour12: false });
  const sessTxt =
    sessionStartBal != null && Number.isFinite(sessionStartBal) && Math.abs(bal - sessionStartBal) >= 0.005
      ? 'session ' + (bal - sessionStartBal >= 0 ? '+' : '') + moneyBook(bal - sessionStartBal)
      : null;
  const dockBits = ['q quit', sessTxt, health.ok ? 'ledger #' + (health.ledgerSeq ?? '—') : null].filter(Boolean);
  const dock = dockBits.join('  ·  ');
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
  let seeded = false;
  const seedFromLogs = (nowMs) => {
    if (seeded) return;
    seeded = true;
    const gw = parseGatewayLog(readTail(gatewayLogPath()));
    const spends = (gw.recent || []).filter((e) => e.kind === 'spend');
    if (!spends.length) return;
    const spanMs = Math.min(10 * 60_000, spends.length * 4_000);
    const step = spanMs / spends.length;
    spends.forEach((ev, i) => {
      series.observe({ burn: ev.amount || 0, req: 1 }, nowMs - spanMs + i * step);
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
      const freshSupply = parseSupplyLog(followSupply());
      const fillTick = (freshSupply.recent || []).filter((e) => e.kind === 'funded').length * 5;
      seedFromLogs(nowMs);
      series.observe(
        { burn: burnTick, fill: fillTick, req: reqTick, bal: health.ok ? health.totalBalance : null },
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



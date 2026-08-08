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

function bar(pct, width, colorize, color) {
  const p = Math.max(0, Math.min(1, pct));
  const exact = p * width;
  const full = Math.floor(exact);
  const frac = exact - full;
  const partial = frac >= 0.5 ? '▌' : '';
  const on = '='.repeat(full) + (partial ? '=' : '');
  // Use '=' / '-' — universally monospaced, no font blob for █
  const filled = Math.min(width, Math.round(p * width));
  const on2 = '='.repeat(filled);
  const off2 = '-'.repeat(Math.max(0, width - filled));
  return colorize(color, on2) + colorize(ansi.gray, off2);
}

function sparkline(samples, width, colorize) {
  if (!samples || samples.length < 2 || width < 8) return colorize(ansi.dim, '·'.repeat(width));
  const vals = samples.map((s) => s.bal);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const blocks = '▁▂▃▄▅▆▇█';
  // take last `width` samples (resample if needed)
  const out = [];
  for (let x = 0; x < width; x++) {
    const idx = Math.floor((x / Math.max(1, width - 1)) * (vals.length - 1));
    const v = vals[idx];
    const t = (v - min) / span;
    out.push(blocks[Math.min(7, Math.floor(t * 7))]);
  }
  return colorize(ansi.dim, out.join(''));
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

function truncEmail(email, n = 28) {
  if (!email) return '…';
  if (email.length <= n) return email;
  return email.slice(0, n - 1) + '…';
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

/** Side-by-side columns; gap is plain spaces (no box drawing). */
function zipColumns(leftLines, rightLines, leftW, totalW, gap = 3) {
  const rightW = Math.max(12, totalW - leftW - gap);
  const n = Math.max(leftLines.length, rightLines.length, 1);
  const out = [];
  const sp = ' '.repeat(gap);
  for (let i = 0; i < n; i++) {
    out.push(padVisible(leftLines[i] || '', leftW) + sp + padVisible(rightLines[i] || '', rightW));
  }
  return out;
}

/**
 * Pool ops moods — burn vs fill first, supply second.
 * EMPTY | STALLED | DRAINING | REFILLING | RECOVERING | BALANCED | HEALTHY | DOWN
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
  if (running && bal < target) return 'REFILLING';
  if (
    (net != null && net < -1 && fill < burn * 0.4) ||
    (bal < target && !running && net != null && net < -0.2)
  ) {
    return 'DRAINING';
  }
  if (bal >= target && active > 0) {
    if (net != null && Math.abs(net) < 2 && burn > 0.5) return 'BALANCED';
    if (!running || (supply.targetGap != null && supply.targetGap <= 0)) return 'HEALTHY';
    return 'BALANCED';
  }
  if (running || bal < target) return 'REFILLING';
  return 'HEALTHY';
}

function conclusion({ mood, health, ld, supply, rates }) {
  const target = ld.targetUsd || 1000;
  const bal = health.ok ? health.totalBalance : 0;
  const net = rates?.net;
  const burn = rates?.burn;
  const fill = rates?.fill;

  const netStr =
    net == null
      ? null
      : (net >= 0 ? 'net +' : 'net ') + moneyFine(net).replace('$-', '-') + '/min';

  if (mood === 'DOWN') {
    return { title: 'GATEWAY DOWN', sub: health.error || 'unreachable', color: ansi.red };
  }
  if (mood === 'EMPTY') {
    return {
      title: 'EMPTY · requests will 503',
      sub: ld.running
        ? 'supply engaged · first live key ~60–90s'
        : 'supply not running · kick com.tokenharbor.supply',
      color: ansi.red,
    };
  }
  if (mood === 'STALLED') {
    return {
      title: 'STALLED · supply failing',
      sub: 'fail streak ' + supply.failStreak + ' · captcha/proxy/mail?',
      color: ansi.red,
    };
  }
  if (mood === 'DRAINING') {
    const parts = ['DRAINING'];
    if (netStr) parts.push(netStr);
    if (net != null && net < -0.05 && bal > 0) {
      parts.push('~' + fmtDur((bal / Math.abs(net)) * 60) + ' to 503');
    }
    return {
      title: parts.join(' · '),
      sub: [
        burn != null ? 'burn ' + moneyFine(burn) + '/min' : null,
        fill != null && fill > 0 ? 'fill ' + moneyFine(fill) + '/min' : 'fill idle',
      ]
        .filter(Boolean)
        .join(' · '),
      color: ansi.yellow,
    };
  }
  if (mood === 'RECOVERING') {
    return {
      title: 'RECOVERING · ' + moneyBook(bal) + ' · ' + health.activeKeys + ' live',
      sub: netStr ? netStr + ' · climbing out of empty' : 'supply engaged',
      color: ansi.yellow,
    };
  }
  if (mood === 'REFILLING') {
    const parts = ['REFILLING'];
    if (netStr) parts.push(netStr);
    if (net != null && net > 0.05 && bal < target) {
      parts.push('clear in ' + fmtDur(((target - bal) / net) * 60));
    } else if (bal < target) {
      parts.push(moneyBook(target - bal) + ' below');
    }
    return {
      title: parts.join(' · '),
      sub: [
        supply.added != null ? '+' + supply.added + ' this run' : null,
        health.activeKeys + ' live',
      ]
        .filter(Boolean)
        .join(' · '),
      color: ansi.yellow,
    };
  }
  if (mood === 'BALANCED') {
    return {
      title: 'BALANCED · ' + (netStr || 'steady') + ' · ' + moneyBook(bal),
      sub:
        (burn != null ? 'burn ' + moneyFine(burn) + '/min' : 'burn …') +
        ' · ' +
        (fill != null ? 'fill ' + moneyFine(fill) + '/min' : 'fill …'),
      color: ansi.green,
    };
  }
  return {
    title: 'HEALTHY · ' + moneyBook(bal) + ' · ' + health.activeKeys + ' live',
    sub: ld.running ? 'above target · supply winding down' : 'above target · supply idle',
    color: ansi.green,
  };
}

function stageLabel(stage) {
  const map = {
    signup: 'signup ',
    mail: 'mailbox',
    verify: 'verify ',
    opening: 'opening',
    done: 'done   ',
    fail: 'fail   ',
    dns: 'dns    ',
    idle: 'idle   ',
  };
  return map[stage] || (stage + '       ').slice(0, 7);
}

function rateBar(value, maxRef, width, colorize, color) {
  const max = Math.max(maxRef, 0.01);
  const pct = Math.max(0, Math.min(1, (value || 0) / max));
  const filled = Math.round(pct * width);
  return colorize(color, '='.repeat(filled)) + colorize(ansi.gray, '-'.repeat(Math.max(0, width - filled)));
}

/** Build left column: model burn breakdown. */

/** Pool composition from /health keys (fact buckets, no identity). */
function poolComposition(health) {
  const keys = health.keys || [];
  let fresh = 0; // ~$5 unburned
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
  // if keys array absent, fall back to counters
  if (!keys.length) {
    return {
      fresh: null,
      partial: null,
      zero: health.exhaustedKeys || 0,
      unknown: health.unknownBalanceKeys || 0,
      live: health.activeKeys || 0,
      used: health.usedKeys,
      total: health.totalKeys || 0,
      dead: health.deadKeys || 0,
      quota: health.quotaKeys || 0,
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
    dead: health.deadKeys || 0,
    quota: health.quotaKeys || 0,
  };
}

/** Build burn-by-model lines (dense single row each). */
function renderBurnCol(ctx, width) {
  const { gateway, rates, c } = ctx;
  const lines = [];
  lines.push(c(ansi.dim, 'BURN BY MODEL'));

  const byModel = gateway?.byModel || {};
  const rows = Object.entries(byModel)
    .map(([model, v]) => ({ model, amount: v.amount, count: v.count }))
    .sort((a, b) => b.amount - a.amount);

  const total = rows.reduce((s, r) => s + r.amount, 0) || gateway?.totalSpend || 0;
  const burn = rates?.burn;
  const fill = rates?.fill;
  const reqs = rows.reduce((s, r) => s + r.count, 0);

  if (!rows.length) {
    lines.push(c(ansi.dim, 'no spend in log window'));
  } else {
    const nameW = Math.min(12, Math.max(8, Math.floor(width * 0.28)));
    const moneyW = 9;
    const metaW = 11; // avg
    const barW = Math.max(4, width - nameW - moneyW - metaW - 8);

    for (const r of rows.slice(0, 10)) {
      const pct = total > 0 ? r.amount / total : 0;
      const name = padVisible(shortModel(r.model), nameW);
      const amt = ('−' + moneyFine(r.amount)).padStart(moneyW);
      const avg = r.count ? r.amount / r.count : 0;
      const meta = (r.count + '× ~' + moneyFine(avg)).padStart(metaW + 4).slice(-metaW - 2);
      const b = rateBar(r.amount, total, barW, c, ansi.red);
      lines.push(
        c(ansi.bold, name) +
          c(ansi.dim, amt) +
          ' ' +
          b +
          ' ' +
          c(ansi.dim, meta),
      );
    }
    if (rows.length > 10) lines.push(c(ansi.dim, '+' + (rows.length - 10) + ' models'));
  }

  // compact totals under models
  const bits = [];
  if (total > 0) bits.push('win −' + moneyFine(total));
  if (reqs) bits.push(reqs + ' req');
  if (burn != null) bits.push('−' + moneyFine(burn) + '/min');
  if (bits.length) lines.push(c(ansi.dim, bits.join(' · ')));
  return lines;
}

/** Rates column: burn/fill bars + headroom. */
function renderFlowCol(ctx, width) {
  const { rates, health, ld, sessionStartBal, rateSamples, c } = ctx;
  const lines = [];
  lines.push(c(ansi.dim, 'FLOW'));

  const burn = rates?.burn;
  const fill = rates?.fill;
  const net = rates?.net;
  const target = ld.targetUsd || 1000;
  const bal = health.ok ? health.totalBalance : 0;
  const ref = Math.max(burn || 0, fill || 0, Math.abs(net || 0), 1);
  const barW = Math.max(6, width - 16);

  const burnStr = burn == null ? '…' : ('−' + moneyFine(burn)).padStart(8);
  const fillStr = fill == null ? '…' : ('+' + moneyFine(fill)).padStart(8);
  const netStr =
    net == null ? '…' : ((net >= 0 ? '+' : '') + moneyFine(net)).padStart(8);

  lines.push(
    c(ansi.red, 'burn') +
      ' ' +
      c(ansi.dim, burnStr) +
      ' ' +
      rateBar(burn || 0, ref, barW, c, ansi.red),
  );
  lines.push(
    c(ansi.green, 'fill') +
      ' ' +
      c(ansi.dim, fillStr) +
      ' ' +
      rateBar(fill || 0, ref, barW, c, ansi.green),
  );
  lines.push(c(ansi.dim, 'net  ' + netStr + '/min'));

  // headroom / clear
  if (net != null && net < -0.05 && bal > 0) {
    lines.push(c(ansi.yellow, '503 in ~' + fmtDur((bal / Math.abs(net)) * 60)));
  } else if (net != null && net > 0.05 && bal < target) {
    lines.push(c(ansi.dim, 'clear ~' + fmtDur(((target - bal) / net) * 60)));
  } else if (net != null && Math.abs(net) <= 0.05) {
    lines.push(c(ansi.dim, 'flat · holding'));
  } else {
    lines.push(c(ansi.dim, 'rate warming…'));
  }

  if (sessionStartBal != null && Number.isFinite(sessionStartBal)) {
    const d = bal - sessionStartBal;
    if (Math.abs(d) >= 0.005) {
      lines.push(c(ansi.dim, 'session ' + (d >= 0 ? '+' : '') + moneyBook(d)));
    }
  }

  // mini spark if room
  if (rateSamples && rateSamples.length >= 2 && width >= 16) {
    lines.push(sparkline(rateSamples, Math.min(width, 28), c));
  }

  return lines;
}

/** Supply column. */
function renderSupplyCol(ctx, width) {
  const { ld, supply, c } = ctx;
  const lines = [];
  lines.push(c(ansi.dim, 'SUPPLY'));

  if (!ld.loaded) {
    lines.push(c(ansi.dim, 'launchd not loaded'));
    return lines;
  }

  if (!ld.running) {
    lines.push(c(ansi.dim, 'idle · next ≤60s'));
    if (ld.targetUsd) lines.push(c(ansi.dim, 'target ' + money(ld.targetUsd)));
    if (supply.added != null && supply.added > 0) {
      lines.push(c(ansi.dim, 'last +' + supply.added + (supply.maxAdds != null ? '/' + supply.maxAdds : '')));
    }
    if (supply.failStreak) lines.push(c(ansi.red, 'fail streak ' + supply.failStreak));
    return lines;
  }

  const ws = supply.workers || [];
  if (!ws.length) {
    lines.push(c(ansi.dim, 'workers starting…'));
  } else {
    for (const wk of ws) {
      const age = ageSec(wk.at);
      const ageStr =
        wk.stage === 'done' ? wk.detail || '+$5' : age != null ? fmtAge(age) : '';
      const stageColor =
        wk.stage === 'done'
          ? ansi.green
          : wk.stage === 'fail'
            ? ansi.red
            : wk.stage === 'opening'
              ? ansi.yellow
              : null;
      const showId =
        wk.stage === 'mail' ||
        wk.stage === 'verify' ||
        wk.stage === 'signup' ||
        wk.stage === 'opening';
      const id =
        showId && wk.email ? truncEmail(wk.email, Math.max(6, width - 16)) : '';
      const left =
        c(ansi.dim, 'w' + wk.id) + ' ' + c(stageColor, stageLabel(wk.stage).trim());
      const mid = id ? ' ' + id : '';
      const padn = Math.max(1, width - stripAnsi(left + mid).length - String(ageStr).length);
      lines.push(left + mid + ' '.repeat(padn) + c(ansi.dim, String(ageStr)));
    }
  }

  const bits = [];
  if (supply.added != null) bits.push('+' + supply.added + ' run');
  if (supply.maxAdds != null && supply.added != null) bits.push(supply.added + '/' + supply.maxAdds);
  if (supply.failStreak) bits.push(c(ansi.red, 'fail×' + supply.failStreak));
  if (ld.pid) bits.push('pid ' + ld.pid);
  // bits may contain ansi from fail - join carefully
  if (supply.added != null || supply.failStreak || ld.pid) {
    const plain = [];
    if (supply.added != null) {
      plain.push(
        '+' +
          supply.added +
          (supply.maxAdds != null ? '/' + supply.maxAdds : '') +
          ' run',
      );
    }
    if (supply.failStreak) plain.push('fail×' + supply.failStreak);
    if (ld.pid) plain.push('pid ' + ld.pid);
    lines.push(c(ansi.dim, plain.join(' · ')));
  }

  // recent funded rate from supply.recent
  const funded = (supply.recent || []).filter((e) => e.kind === 'funded').length;
  const fails = (supply.recent || []).filter((e) => e.kind === 'fail').length;
  if (funded || fails) {
    lines.push(
      c(ansi.dim, 'log ') +
        (funded ? c(ansi.green, 'fund×' + funded) : '') +
        (funded && fails ? c(ansi.dim, ' ') : '') +
        (fails ? c(ansi.red, 'fail×' + fails) : ''),
    );
  }
  return lines;
}

/**
 * Layout denser:
 *   hero mood
 *   money + bar + composition (multi KPI lines)
 *   3-col when wide: BURN | FLOW | SUPPLY
 *   PULSE fills ALL leftover rows (dense ticket tape, no emails)
 */
function renderGlance(ctx) {
  const {
    health,
    ld,
    supply,
    rates,
    netPerMin,
    now,
    cols,
    rows,
    sessionStartBal,
    gateway,
    rateSamples,
  } = ctx;
  const tty = ctx.tty;
  const c = (code, s) => paint(tty, code, s);
  const rateObj = rates || { net: netPerMin };
  const mood = classify({ ...ctx, rates: rateObj });
  const head = conclusion({ ...ctx, mood, rates: rateObj });
  const target = ld.targetUsd || 1000;
  const bal = health.ok ? health.totalBalance : 0;
  const pct = target > 0 ? bal / target : 0;
  const net = rateObj?.net ?? netPerMin;
  const comp = health.ok ? poolComposition(health) : null;

  const gutter = 1;
  const W = Math.max(40, cols - gutter * 2);
  const pad = (s) => ' '.repeat(gutter) + s;
  const out = [];
  const add = (s = '') => out.push(s.length ? pad(s) : '');

  // ── HERO ────────────────────────────────────────────────
  add(c(ansi.bold, c(head.color, head.title)));
  if (head.sub) add(c(ansi.dim, head.sub));

  if (mood === 'DOWN') {
    add('');
    add(c(ansi.dim, 'launchctl kickstart gui/$(id -u)/com.tokenharbor.gateway'));
  } else {
    // money line
    const balColor =
      mood === 'EMPTY' ? ansi.red : mood === 'HEALTHY' || mood === 'BALANCED' ? ansi.green : ansi.bold;
    add(
      c(balColor, moneyBook(bal)) +
        c(ansi.dim, ' / ' + money(target)) +
        c(ansi.dim, '  ·  ' + Math.round(pct * 100) + '%'),
    );

    const barColor =
      mood === 'EMPTY'
        ? ansi.red
        : mood === 'HEALTHY' || mood === 'BALANCED'
          ? ansi.green
          : ansi.yellow;
    // bar + spark on same visual band when wide
    if (W >= 70 && rateSamples && rateSamples.length >= 2) {
      const sparkW = Math.min(24, Math.floor(W * 0.25));
      const barW = W - sparkW - 1;
      add(bar(pct, barW, c, barColor) + ' ' + sparkline(rateSamples, sparkW, c));
    } else {
      add(bar(pct, W, c, barColor));
    }

    // composition — the density the screenshot was missing
    if (comp) {
      const parts = [];
      parts.push(comp.live + ' live');
      if (comp.partial != null) parts.push(comp.partial + ' mid');
      if (comp.fresh != null) parts.push(comp.fresh + ' full');
      parts.push((comp.zero || 0) + '∅');
      if (comp.dead) parts.push(comp.dead + ' dead');
      if (comp.quota) parts.push(comp.quota + ' quota');
      if (comp.used != null) parts.push(comp.used + ' used');
      parts.push(comp.total + ' keys');
      if (health.ledgerSeq != null) parts.push('#' + health.ledgerSeq);
      add(c(ansi.dim, parts.join(' · ')));
    }

    // session / net / burn / fill one KPI strip
    {
      const bits = [];
      if (sessionStartBal != null && Number.isFinite(sessionStartBal)) {
        const d = bal - sessionStartBal;
        if (Math.abs(d) >= 0.005) bits.push('sess ' + (d >= 0 ? '+' : '') + moneyBook(d));
      }
      if (rateObj?.burn != null) bits.push('burn −' + moneyFine(rateObj.burn) + '/m');
      if (rateObj?.fill != null) bits.push('fill +' + moneyFine(rateObj.fill) + '/m');
      if (net != null) bits.push('net ' + (net >= 0 ? '+' : '') + moneyFine(net) + '/m');
      if (gateway?.totalSpend) bits.push('win −' + moneyFine(gateway.totalSpend));
      const reqs = gateway?.byModel
        ? Object.values(gateway.byModel).reduce((s, v) => s + (v.count || 0), 0)
        : 0;
      if (reqs) bits.push(reqs + ' req');
      if (bits.length) add(c(ansi.dim, bits.join('  ·  ')));
    }

    add('');

    // ── MAIN columns ──────────────────────────────────────
    // wide (≥100): 3-col burn | flow | supply
    // mid  (≥72): 2-col burn | supply, flow folded into hero already
    // narrow: stack
    if (W >= 100) {
      const g = 2;
      const c1 = Math.floor(W * 0.42);
      const c2 = Math.floor(W * 0.28);
      const c3 = W - c1 - c2 - g * 2;
      const L = renderBurnCol({ gateway, rates: rateObj, c }, c1);
      const M = renderFlowCol(
        { rates: rateObj, health, ld, sessionStartBal, rateSamples, c },
        c2,
      );
      const R = renderSupplyCol({ ld, supply, c }, c3);
      const n = Math.max(L.length, M.length, R.length);
      for (let i = 0; i < n; i++) {
        add(
          padVisible(L[i] || '', c1) +
            ' '.repeat(g) +
            padVisible(M[i] || '', c2) +
            ' '.repeat(g) +
            padVisible(R[i] || '', c3),
        );
      }
    } else if (W >= 72) {
      const g = 3;
      const c1 = Math.floor(W * 0.58);
      const c2 = W - c1 - g;
      const L = renderBurnCol({ gateway, rates: rateObj, c }, c1);
      const R = renderSupplyCol({ ld, supply, c }, c2);
      // inject flow summary at top of right if supply short
      const flowBits = renderFlowCol(
        { rates: rateObj, health, ld, sessionStartBal, rateSamples: null, c },
        c2,
      );
      // merge: flow first lines then supply (skip duplicate header spacing)
      const right = [...flowBits, '', ...R];
      const n = Math.max(L.length, right.length);
      for (let i = 0; i < n; i++) {
        add(padVisible(L[i] || '', c1) + ' '.repeat(g) + padVisible(right[i] || '', c2));
      }
    } else {
      for (const line of renderBurnCol({ gateway, rates: rateObj, c }, W)) add(line);
      add('');
      for (const line of renderFlowCol(
        { rates: rateObj, health, ld, sessionStartBal, rateSamples, c },
        W,
      ))
        add(line);
      add('');
      for (const line of renderSupplyCol({ ld, supply, c }, W)) add(line);
    }
  }

  // ── PULSE + STATS: fill leftover without email spam ─────
  const footerReserve = 1;
  const leftover = Math.max(0, rows - footerReserve - out.length);

  if (mood !== 'DOWN' && leftover >= 2) {
    add('');
    add(c(ansi.dim, 'ACTIVITY'));
    let budget = Math.max(1, rows - footerReserve - out.length);
    const lines = [];
    const recent = gateway?.recent || [];
    const spends = recent.filter((e) => e.kind === 'spend');

    // chips
    let fundedN = 0;
    let failN = 0;
    for (const ev of supply.recent || []) {
      if (ev.kind === 'funded') fundedN++;
      if (ev.kind === 'fail') failN++;
    }
    const exhN = recent.filter((e) => e.kind === 'exhaust').length;
    const chips = [];
    if (fundedN) chips.push(c(ansi.green, 'fund×' + fundedN));
    if (failN) chips.push(c(ansi.red, 'fail×' + failN));
    if (exhN) chips.push(c(ansi.red, 'empty×' + exhN));
    if (spends.length) chips.push(c(ansi.dim, 'spend×' + spends.length));
    if (chips.length) lines.push(chips.join('  '));

    // spend size histogram (useful shape, not identity)
    if (spends.length >= 3) {
      const edges = [0.05, 0.25, 0.5, 1.0, 1.5, 2.5, 5, Infinity];
      const labels = ['≤5¢', '≤25¢', '≤50¢', '≤$1', '≤$1.5', '≤$2.5', '≤$5', '>$5'];
      const bins = edges.map(() => 0);
      for (const s of spends) {
        const a = s.amount || 0;
        for (let i = 0; i < edges.length; i++) {
          if (a <= edges[i]) {
            bins[i]++;
            break;
          }
        }
      }
      const maxB = Math.max(...bins, 1);
      // pack 2 bins per line when narrow, else more compact single lines
            const histLines = [];
      for (let i = 0; i < bins.length; i++) {
        if (!bins[i]) continue;
        const maxHist = Math.min(28, Math.max(10, Math.floor(W * 0.35)));
        const bw = Math.max(1, Math.round(maxHist * (bins[i] / maxB)));
        histLines.push(
          c(ansi.dim, labels[i].padEnd(5)) +
            ' ' +
            c(ansi.yellow, '='.repeat(bw)) +
            c(ansi.dim, '-'.repeat(maxHist - bw)) +
            c(ansi.dim, (' ' + bins[i]).padStart(4)),
        );
      }
      if (histLines.length) {
        lines.push(c(ansi.dim, 'ticket $'));
        for (const hl of histLines.slice(0, 6)) lines.push(hl);
      }
    }

    // per-model summary (sum, count, avg, last)
    /** @type {Map<string, number[]>} */
    const buckets = new Map();
    for (const ev of spends) {
      const k = ev.model || '?';
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(ev.amount);
    }
    const order = [...buckets.entries()].sort((a, b) => {
      const sa = a[1].reduce((x, y) => x + y, 0);
      const sb = b[1].reduce((x, y) => x + y, 0);
      return sb - sa;
    });
    for (const [m, amts] of order) {
      const sum = amts.reduce((a, b) => a + b, 0);
      const avg = amts.length ? sum / amts.length : 0;
      const last = amts.slice(-5).map((a) => moneyFine(a).replace('$', ''));
      lines.push(
        c(ansi.bold, padVisible(shortModel(m), 10)) +
          c(ansi.dim, ('−' + moneyFine(sum)).padStart(9)) +
          c(ansi.dim, ('×' + amts.length).padStart(5)) +
          c(ansi.dim, ('avg ' + moneyFine(avg)).padStart(12)) +
          c(ansi.dim, '  last ' + last.join(' ')),
      );
    }

    // current pointer (ops useful, still no random emails list)
    if (health.current && (health.current.balance != null || health.current.status)) {
      const cb =
        health.current.balance != null ? moneyBook(Number(health.current.balance)) : '?';
      lines.push(
        c(ansi.dim, 'cursor ') +
          c(ansi.dim, String(health.current.status || 'ok')) +
          c(ansi.dim, ' book ' + cb) +
          (health.current.file ? c(ansi.dim, '  ' + String(health.current.file).replace('tokenharbor-api-key', 'key')) : ''),
      );
    }

    // fill remaining with a single spark of recent spend magnitudes (not labels)
    const room = budget - lines.length;
    if (room > 0 && spends.length >= 4) {
      const vals = spends.slice(-Math.min(spends.length, W * room)).map((s) => s.amount);
      // render as block sparkline row(s)
      const blocks = '▁▂▃▄▅▆▇█';
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const span = max - min || 1;
      let spark = '';
      for (const v of vals) {
        spark += blocks[Math.min(7, Math.floor(((v - min) / span) * 7))];
      }
      // wrap spark across rows
      for (let i = 0; i < spark.length && lines.length < budget; i += W) {
        const chunk = spark.slice(i, i + W);
        lines.push(
          c(ansi.dim, i === 0 ? 'req $' : '    ') +
            (i === 0 ? ' ' : '') +
            c(ansi.yellow, i === 0 ? chunk.slice(0, Math.max(0, W - 6)) : chunk),
        );
      }
      lines.push(c(ansi.dim, 'req $ span ' + moneyFine(min) + '…' + moneyFine(max)));
    }

    if (!lines.length) {
      add(c(ansi.dim, 'waiting for traffic…'));
    } else {
      for (const line of lines.slice(0, budget)) add(line);
    }
  }

  // if still short of rows, don't leave a giant void feeling — add a status dock
  while (out.length < rows - 2) {
    // only pad one analytical line once then blanks via packFrame
    break;
  }
  // status dock just above footer when we have 1 spare conceptual row in content
  {
    const asOf = health.ok && health.asOf ? String(health.asOf).slice(11, 19) + 'Z' : '';
    const src = health.ok ? health.source || '' : '';
    const dock = [src, asOf, health.ok ? 'ledger #' + (health.ledgerSeq ?? '—') : null]
      .filter(Boolean)
      .join(' · ');
    // put dock into footer area instead of content if tight
    var dockStr = dock;
  }

  const clock = new Date(now).toLocaleTimeString('en-GB', { hour12: false });
  const leftFoot = 'q quit' + (dockStr ? c(ansi.dim, '  ·  ' + dockStr) : '');
  // leftFoot has ansi - compute gap with strip
  const leftVis = stripAnsi('q quit' + (dockStr ? '  ·  ' + dockStr : ''));
  const gap = Math.max(2, cols - gutter * 2 - leftVis.length - clock.length);
  const footer =
    pad(
      c(ansi.dim, 'q quit') +
        (dockStr ? c(ansi.dim, '  ·  ' + dockStr) : '') +
        ' '.repeat(gap) +
        c(ansi.dim, clock),
    );

  if (!tty) {
    return [...out, '', footer].join('\n') + '\n';
  }
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
      const rateSnap = rates.rates();
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

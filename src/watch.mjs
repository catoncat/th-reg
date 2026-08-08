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
      totalKeys: Number(j.totalKeys) || 0,
      totalBalance: Number(j.totalBalance) || 0,
      unknownBalanceKeys: Number(j.unknownBalanceKeys) || 0,
      ledgerSeq: j.ledgerSeq ?? null,
      current: j.current || null,
      source: j.source || 'gateway',
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

  if (!rows.length) {
    lines.push(c(ansi.dim, 'no spend in log window yet'));
    lines.push('');
    lines.push(c(ansi.dim, burn == null ? 'rate  …/min' : 'rate  −' + moneyFine(burn) + '/min'));
    return lines;
  }

  const nameW = Math.min(14, Math.max(8, Math.floor(width * 0.35)));
  const moneyW = 9;
  const barW = Math.max(6, width - nameW - moneyW - 6);

  for (const r of rows.slice(0, 8)) {
    const pct = total > 0 ? r.amount / total : 0;
    const name = padVisible(shortModel(r.model), nameW);
    const amt = ('−' + moneyFine(r.amount)).padStart(moneyW);
    const share = String(Math.round(pct * 100)).padStart(3) + '%';
    const hits = (r.count + '×').padStart(4);
    const b = rateBar(r.amount, total, Math.max(4, barW - 8), c, ansi.red);
    lines.push(
      c(ansi.bold, name) +
        ' ' +
        c(ansi.dim, amt) +
        ' ' +
        b +
        ' ' +
        c(ansi.dim, share + ' ' + hits.trim()),
    );
  }

  if (rows.length > 8) {
    lines.push(c(ansi.dim, '+' + (rows.length - 8) + ' more models'));
  }

  lines.push('');
  const rateTxt = burn == null ? 'rate  …/min' : 'rate  −' + moneyFine(burn) + '/min';
  const winTxt = total > 0 ? 'window −' + moneyFine(total) : '';
  lines.push(c(ansi.dim, rateTxt + (winTxt ? '  ·  ' + winTxt : '')));
  return lines;
}

/** Build right column: supply stage strip (email only while registering). */
function renderSupplyCol(ctx, width) {
  const { ld, supply, c } = ctx;
  const lines = [];
  lines.push(c(ansi.dim, 'SUPPLY'));

  if (!ld.loaded) {
    lines.push(c(ansi.dim, 'launchd not loaded'));
    return lines;
  }

  if (!ld.running) {
    lines.push(c(ansi.dim, 'idle · next tick ≤60s'));
    if (supply.added != null && supply.added > 0) {
      lines.push(c(ansi.dim, 'last run +' + supply.added));
    }
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
      // Email only meaningful mid-register; hide on done/fail noise
      const showId =
        wk.stage === 'mail' ||
        wk.stage === 'verify' ||
        wk.stage === 'signup' ||
        wk.stage === 'opening';
      const id = showId && wk.email ? truncEmail(wk.email, Math.max(8, width - 18)) : '';
      const left = c(ansi.dim, 'w' + wk.id) + ' ' + c(stageColor, stageLabel(wk.stage).trim());
      const room = Math.max(1, width - stripAnsi(left).length - String(ageStr).length - 1);
      const mid = id ? ' ' + padVisible(id, Math.min(room, stripAnsi(id).length + 1)) : '';
      const pad = Math.max(1, width - stripAnsi(left + mid).length - String(ageStr).length);
      lines.push(left + mid + ' '.repeat(pad) + c(ansi.dim, String(ageStr)));
    }
  }

  const bits = [];
  if (supply.added != null) bits.push('+' + supply.added + ' this run');
  if (supply.maxAdds != null && supply.added != null) bits.push(supply.added + '/' + supply.maxAdds);
  if (supply.failStreak) bits.push('fail×' + supply.failStreak);
  if (bits.length) lines.push(c(ansi.dim, bits.join(' · ')));
  return lines;
}

/**
 * Layout:
 *   [ hero: mood + pool bar full width ]
 *   [ BURN BY MODEL  |  SUPPLY ]   ← side by side when wide
 *   [ pulse: last model events ]   ← only leftover rows, no emails
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

  const gutter = 2;
  const W = Math.max(40, cols - gutter * 2);
  const pad = (s) => ' '.repeat(gutter) + s;
  const out = [];
  const add = (s = '') => out.push(s.length ? pad(s) : '');
  const addRaw = (s = '') => out.push(s); // already padded via zip

  // ── HERO ────────────────────────────────────────────────
  add('');
  add(c(ansi.bold, c(head.color, head.title)));
  if (head.sub) add(c(ansi.dim, head.sub));

  if (mood === 'DOWN') {
    add('');
    add(c(ansi.dim, 'launchctl kickstart gui/$(id -u)/com.tokenharbor.gateway'));
  } else {
    add('');
    // pool one strip: money + bar + live counts on one visual band
    const balColor =
      mood === 'EMPTY' ? ansi.red : mood === 'HEALTHY' || mood === 'BALANCED' ? ansi.green : ansi.bold;
    const left = c(balColor, moneyBook(bal));
    const right = c(ansi.dim, '/ ' + money(target));
    const meta =
      health.activeKeys +
      ' live · ' +
      health.exhaustedKeys +
      '∅' +
      (health.usedKeys != null ? ' · ' + health.usedKeys + ' used' : '');
    add(left + ' ' + right + '  ' + c(ansi.dim, meta));

    const barColor =
      mood === 'EMPTY'
        ? ansi.red
        : mood === 'HEALTHY' || mood === 'BALANCED'
          ? ansi.green
          : ansi.yellow;
    add(bar(pct, W, c, barColor));

    // session delta under bar
    const bits = [];
    if (sessionStartBal != null && Number.isFinite(sessionStartBal)) {
      const d = bal - sessionStartBal;
      if (Math.abs(d) >= 0.005) bits.push('session ' + (d >= 0 ? '+' : '') + moneyBook(d));
    }
    if (net != null) bits.push('net ' + (net >= 0 ? '+' : '') + moneyFine(net) + '/min');
    bits.push(Math.round(pct * 100) + '%');
    if (bits.length) add(c(ansi.dim, bits.join('  ·  ')));

    add('');

    // ── MAIN: two columns when wide enough ────────────────
    const useCols = W >= 72;
    const leftW = useCols ? Math.floor(W * 0.58) : W;
    const burnLines = renderBurnCol({ gateway, rates: rateObj, c }, leftW);
    const supplyLines = renderSupplyCol({ ld, supply, c }, useCols ? W - leftW - 3 : W);

    if (useCols) {
      for (const row of zipColumns(burnLines, supplyLines, leftW, W, 3)) {
        add(row);
      }
    } else {
      // narrow: burn first, then supply — still not a long laundry list
      for (const line of burnLines) add(line);
      add('');
      for (const line of supplyLines) add(line);
    }
  }

  // ── PULSE: leftover rows = recent model activity (no emails) ──
  const footerReserve = 1;
  const used = out.length;
  const leftover = Math.max(0, rows - footerReserve - used);

  if (mood !== 'DOWN' && leftover >= 3) {
    add('');
    add(c(ansi.dim, 'PULSE'));
    const budget = Math.max(1, leftover - 2);
    // collapse consecutive spends into per-model ticks
    const recent = gateway?.recent || [];
    const pulse = [];
    // also fold supply funded counts (no email)
    let fundedN = 0;
    for (const ev of supply.recent || []) {
      if (ev.kind === 'funded') fundedN++;
    }
    if (fundedN > 0) pulse.push(c(ansi.green, 'funded') + c(ansi.dim, '  +$5 ×' + fundedN));

    // last spends grouped by model in reverse chrono chunks
    const tail = recent.filter((e) => e.kind === 'spend').slice(-40);
    /** @type {Map<string, number[]>} */
    const buckets = new Map();
    for (const ev of tail) {
      const k = ev.model || '?';
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(ev.amount);
    }
    // show models by most recent activity order
    const order = [];
    const seen = new Set();
    for (let i = tail.length - 1; i >= 0; i--) {
      const m = tail[i].model || '?';
      if (seen.has(m)) continue;
      seen.add(m);
      order.push(m);
    }
    for (const m of order) {
      const amts = buckets.get(m) || [];
      const last3 = amts.slice(-3).map((a) => '−' + moneyFine(a)).join(' ');
      const line =
        c(ansi.bold, padVisible(shortModel(m), 12)) +
        ' ' +
        c(ansi.dim, last3) +
        c(ansi.dim, amts.length > 3 ? '  ×' + amts.length : '');
      pulse.push(line);
    }

    // exhaust blips (dedupe)
    const exhN = recent.filter((e) => e.kind === 'exhaust').length;
    const emptyN = recent.filter((e) => e.kind === 'empty').length;
    if (exhN > 0) pulse.push(c(ansi.red, 'key empty') + c(ansi.dim, '  ×' + exhN + ' in window'));
    if (emptyN > 0) pulse.push(c(ansi.red, 'pool empty'));

    if (!pulse.length) {
      add(c(ansi.dim, 'waiting for traffic…'));
    } else {
      for (const line of pulse.slice(0, budget)) add(line);
    }
  }

  const clock = new Date(now).toLocaleTimeString('en-GB', { hour12: false });
  const leftFoot = 'q quit';
  const gap = Math.max(2, cols - gutter * 2 - leftFoot.length - clock.length);
  const footer = pad(c(ansi.dim, leftFoot) + ' '.repeat(gap) + c(ansi.dim, clock));

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

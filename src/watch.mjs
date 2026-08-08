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
function parseGatewayLog(text) {
  const recent = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let m = line.match(/\(([^)]+@[^)]+)\) -> 200.*?soft−\$?([\d.]+).*?book=\$?([\d.]+)/);
    if (!m) m = line.match(/\(([^)]+@[^)]+)\) -> 200\s+−\$([\d.]+)\s+bal=\$([\d.]+)/);
    if (m) {
      recent.push({
        kind: 'spend',
        email: m[1],
        text: '−$' + Number(m[2]).toFixed(2),
        amount: Number(m[2]),
      });
      continue;
    }
    m = line.match(/\(([^)]+@[^)]+)\) -> (?:402|403).*\(balance\)/);
    if (m) {
      recent.push({ kind: 'exhaust', email: m[1], text: 'exhausted' });
      continue;
    }
    m = line.match(/pool exhausted/);
    if (m) {
      recent.push({ kind: 'empty', text: 'pool exhausted' });
    }
  }
  if (recent.length > 80) return recent.slice(-80);
  return recent;
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
  // Draining: burning with little/no fill, or deep below target while supply idle
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
      parts.push('503 risk in ' + fmtDur((bal / Math.abs(net)) * 60));
    }
    return {
      title: parts.join(' · '),
      sub: [
        burn != null ? 'burn ' + moneyFine(burn) + '/min' : null,
        fill != null && fill > 0 ? 'fill ' + moneyFine(fill) + '/min' : 'fill idle',
        !ld.running ? 'supply idle' : null,
      ]
        .filter(Boolean)
        .join(' · '),
      color: ansi.yellow,
    };
  }
  if (mood === 'RECOVERING') {
    return {
      title: 'RECOVERING · ' + moneyBook(bal) + ' book · ' + health.activeKeys + ' live',
      sub: netStr ? netStr + ' · climbing out of empty' : 'supply engaged · climbing out of empty',
      color: ansi.yellow,
    };
  }
  if (mood === 'REFILLING') {
    const parts = ['REFILLING'];
    if (netStr) parts.push(netStr);
    if (net != null && net > 0.05 && bal < target) {
      parts.push('clear in ' + fmtDur(((target - bal) / net) * 60));
    } else if (bal < target) {
      parts.push(moneyBook(target - bal) + ' below target');
    }
    return {
      title: parts.join(' · '),
      sub: [
        supply.added != null ? '+' + supply.added + ' this run' : null,
        health.activeKeys + ' live',
        burn != null && burn > 0.05 ? 'burn ' + moneyFine(burn) + '/min' : null,
      ]
        .filter(Boolean)
        .join(' · '),
      color: ansi.yellow,
    };
  }
  if (mood === 'BALANCED') {
    return {
      title: 'BALANCED · ' + (netStr || 'steady') + ' · ' + moneyBook(bal) + ' book',
      sub:
        (burn != null ? 'burn ' + moneyFine(burn) + '/min' : 'burn —') +
        ' · ' +
        (fill != null ? 'fill ' + moneyFine(fill) + '/min' : 'fill —') +
        ' · ' +
        health.activeKeys +
        ' live',
      color: ansi.green,
    };
  }
  // HEALTHY
  return {
    title: 'HEALTHY · ' + moneyBook(bal) + ' book · ' + health.activeKeys + ' live',
    sub: ld.running
      ? 'above target · supply winding down'
      : 'above target · supply idle',
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
    rateSamples,
    sessionStartBal,
    gatewayRecent,
  } = ctx;
  const tty = ctx.tty;
  const c = (code, s) => paint(tty, code, s);
  const mood = classify({ ...ctx, rates: rates || { net: netPerMin } });
  const head = conclusion({
    ...ctx,
    mood,
    rates: rates || { net: netPerMin },
  });
  const target = ld.targetUsd || 1000;
  const bal = health.ok ? health.totalBalance : 0;
  const pct = target > 0 ? bal / target : 0;
  const burn = rates?.burn ?? null;
  const fill = rates?.fill ?? null;
  const net = rates?.net ?? netPerMin;

  const gutter = 2;
  const W = Math.max(40, cols - gutter * 2);
  const pad = (s) => ' '.repeat(gutter) + s;
  const out = [];
  const add = (s = '') => out.push(s.length ? pad(s) : '');

  // ── 1. conclusion ─────────────────────────────────────────
  add('');
  add(c(ansi.bold, c(head.color, head.title)));
  if (head.sub) add(c(ansi.dim, head.sub));
  add('');

  if (mood === 'DOWN') {
    add(c(ansi.dim, 'is gateway up?  launchctl kickstart gui/$(id -u)/com.tokenharbor.gateway'));
  } else {
    // ── 2. dual track burn | fill ───────────────────────────
    const ref = Math.max(burn || 0, fill || 0, Math.abs(net || 0), 1);
    const trackW = Math.max(12, W - 28);
    add(c(ansi.dim, 'DEMAND / SUPPLY'));
    {
      const b = burn == null ? null : burn;
      const label = 'burn  ';
      const val = b == null ? '  …/min' : ('−' + moneyFine(b) + '/min').padEnd(14);
      add(
        c(ansi.red, label) +
          c(ansi.dim, val) +
          rateBar(b || 0, ref, trackW, c, ansi.red),
      );
    }
    {
      const f = fill == null ? null : fill;
      const label = 'fill  ';
      const val = f == null ? '  …/min' : ('+' + moneyFine(f) + '/min').padEnd(14);
      add(
        c(ansi.green, label) +
          c(ansi.dim, val) +
          rateBar(f || 0, ref, trackW, c, ansi.green),
      );
    }
    {
      let session = '';
      if (sessionStartBal != null && Number.isFinite(sessionStartBal)) {
        const d = bal - sessionStartBal;
        if (Math.abs(d) >= 0.005) {
          session = 'session ' + (d >= 0 ? '+' : '') + moneyBook(d);
        }
      }
      const netTxt =
        net == null ? 'net …' : 'net ' + (net >= 0 ? '+' : '') + moneyFine(net) + '/min';
      add(c(ansi.dim, netTxt + (session ? '  ·  ' + session : '')));
    }
    add('');

    // ── 3. pool book ────────────────────────────────────────
    add(c(ansi.dim, 'POOL'));
    const balColor =
      mood === 'EMPTY' ? ansi.red : mood === 'HEALTHY' || mood === 'BALANCED' ? ansi.green : ansi.bold;
    const left = moneyBook(bal) + ' book';
    const right = 'target ' + money(target);
    const mid = Math.max(2, W - stripAnsi(left).length - stripAnsi(right).length);
    add(c(balColor, left) + ' '.repeat(mid) + c(ansi.dim, right));
    const barColor =
      mood === 'EMPTY'
        ? ansi.red
        : mood === 'HEALTHY' || mood === 'BALANCED'
          ? ansi.green
          : ansi.yellow;
    add(bar(pct, W, c, barColor));
    let meta =
      Math.round(pct * 100) +
      '%  ·  ' +
      health.activeKeys +
      ' live  ·  ' +
      health.exhaustedKeys +
      ' empty  ·  ' +
      (health.usedKeys != null ? health.usedKeys + ' used  ·  ' : '') +
      health.totalKeys +
      ' keys';
    add(c(ansi.dim, meta));
    add('');

    // ── 4. supply workers (collapse when idle) ──────────────
    if (ld.running) {
      add(c(ansi.dim, 'SUPPLY'));
      const ws = supply.workers || [];
      if (ws.length) {
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
          const leftW = c(ansi.dim, 'w' + wk.id) + '  ' + c(stageColor, stageLabel(wk.stage));
          const emailBudget = Math.max(12, W - stripAnsi(leftW).length - 8);
          const email = truncEmail(
            wk.email || (wk.stage === 'signup' ? '…' : '…'),
            emailBudget,
          );
          const row =
            leftW +
            '  ' +
            email +
            ' '.repeat(
              Math.max(
                1,
                W - stripAnsi(leftW).length - 2 - stripAnsi(email).length - String(ageStr).length,
              ),
            ) +
            c(ansi.dim, String(ageStr));
          add(row);
        }
      } else {
        add(c(ansi.dim, 'workers starting…'));
      }
      const footBits = [];
      if (supply.added != null) footBits.push('+' + supply.added + ' this run');
      if (supply.maxAdds != null && supply.added != null) {
        footBits.push(supply.added + '/' + supply.maxAdds);
      }
      if (supply.failStreak) footBits.push('fail ' + supply.failStreak);
      if (ld.pid) footBits.push('pid ' + ld.pid);
      if (footBits.length) add(c(ansi.dim, footBits.join('  ·  ')));
      add('');
    } else {
      add(
        c(ansi.dim, 'SUPPLY') +
          '  ' +
          c(ansi.dim, ld.loaded ? 'idle · next tick ≤60s' : 'not loaded'),
      );
      add('');
    }
  }

  // ── 5. RECENT fills leftover ──────────────────────────────
  const footerReserve = 1;
  const used = out.length;
  const leftover = Math.max(0, rows - footerReserve - used);
  if (mood !== 'DOWN' && leftover >= 3) {
    add(c(ansi.dim, 'RECENT'));
    const feedBudget = Math.max(1, leftover - 1);
    // merge supply recent + gateway recent, newest last in sources → reverse for display
    const merged = [];
    for (const ev of supply.recent || []) {
      merged.push({ ...ev, _src: 'supply' });
    }
    for (const ev of gatewayRecent || []) {
      merged.push({ ...ev, _src: 'gw' });
    }
    // supply recent is chronological; gateway too — take tails
    const show = merged.slice(-feedBudget).reverse();
    if (!show.length) {
      add(c(ansi.dim, 'no events yet'));
    } else {
      for (const ev of show) {
        let tag;
        let tagColor = ansi.dim;
        if (ev.kind === 'funded') {
          tag = 'funded';
          tagColor = ansi.green;
        } else if (ev.kind === 'spend') {
          tag = 'spend ';
          tagColor = ansi.yellow;
        } else if (ev.kind === 'exhaust' || ev.kind === 'empty') {
          tag = 'empty ';
          tagColor = ansi.red;
        } else if (ev.kind === 'fail') {
          tag = 'fail  ';
          tagColor = ansi.red;
        } else {
          tag = ((ev.kind || 'event') + '      ').slice(0, 6);
        }
        const wtag = ev.worker ? c(ansi.dim, 'w' + ev.worker) + ' ' : '';
        const who = ev.email
          ? truncEmail(ev.email, Math.max(10, W - 20))
          : (ev.text || '').slice(0, W - 14);
        const extra =
          ev.kind === 'spend' && ev.text
            ? c(ansi.dim, ' ' + ev.text)
            : ev.kind === 'funded'
              ? c(ansi.dim, ' +$5')
              : '';
        add(wtag + c(tagColor, tag) + '  ' + who + extra);
      }
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
      const gatewayRecent = parseGatewayLog(readTail(gatewayLogPath()));
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
        gatewayRecent,
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

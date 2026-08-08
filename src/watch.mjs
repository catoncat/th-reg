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

function createRateTracker() {
  const samples = [];
  return {
    push(bal) {
      const t = Date.now();
      samples.push({ t, bal });
      const cut = t - 180_000;
      while (samples.length > 2 && samples[0].t < cut) samples.shift();
    },
    netPerMin() {
      if (samples.length < 2) return null;
      const last = samples[samples.length - 1];
      let i = 0;
      for (let k = 0; k < samples.length; k++) {
        if (last.t - samples[k].t >= 55_000) i = k;
      }
      const first = samples[i];
      const dtMin = (last.t - first.t) / 60_000;
      if (dtMin < 0.25) return null;
      return (last.bal - first.bal) / dtMin;
    },
    samples() { return samples.slice(); },
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

function classify({ health, ld, supply }) {
  if (!health.ok) return 'DOWN';
  const bal = health.totalBalance;
  const active = health.activeKeys;
  const target = ld.targetUsd || 1000;
  const running = ld.running;
  const fails = supply.failStreak || 0;
  if (active === 0 && bal < 0.5) return 'EMPTY';
  if (running && fails >= 4) return 'STALLED';
  if (bal >= target && active > 0) return 'HEALTHY';
  if (active > 0 && bal < target * 0.05 && running) return 'RECOVERING';
  if (running || bal < target) return 'REFILLING';
  return 'HEALTHY';
}

function conclusion({ mood, health, ld, supply, netPerMin }) {
  const target = ld.targetUsd || 1000;
  const bal = health.ok ? health.totalBalance : 0;
  const net = netPerMin;
  const netStr =
    net == null
      ? null
      : (net >= 0 ? 'net +' : 'net ') + moneyFine(net).replace('$-', '−$') + '/min';

  if (mood === 'DOWN') return { title: 'GATEWAY DOWN', sub: health.error || 'unreachable', color: ansi.red };
  if (mood === 'EMPTY')
    return {
      title: 'EMPTY · requests will 503',
      sub: ld.running ? 'supply engaged · first live key ~60–90s' : 'supply not running · kick com.tokenharbor.supply',
      color: ansi.red,
    };
  if (mood === 'STALLED')
    return {
      title: 'STALLED · supply failing',
      sub: 'fail streak ' + supply.failStreak + ' · captcha/proxy/mail?',
      color: ansi.red,
    };
  if (mood === 'HEALTHY')
    return {
      title: 'HEALTHY · ' + money(bal) + ' book · ' + health.activeKeys + ' live',
      sub: ld.running ? 'above target · supply still winding down' : 'above target · supply idle',
      color: ansi.green,
    };
  if (mood === 'RECOVERING')
    return {
      title: 'RECOVERING · ' + money(bal) + ' book · ' + health.activeKeys + ' live',
      sub: netStr ? netStr + ' · climbing out of empty' : 'supply engaged · climbing out of empty',
      color: ansi.yellow,
    };

  const parts = ['REFILLING'];
  if (netStr) parts.push(netStr);
  if (net != null && net > 0.05 && bal < target) parts.push('clear in ' + fmtDur(((target - bal) / net) * 60));
  else if (bal < target) parts.push(money(target - bal) + ' below target');

  return {
    title: parts.join(' · '),
    sub: [
      ld.running ? null : 'supply not running',
      supply.added != null ? '+' + supply.added + ' this run' : null,
      health.activeKeys + ' live',
    ]
      .filter(Boolean)
      .join(' · '),
    color: ansi.yellow,
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

function hr(cols, colorize) {
  return colorize(ansi.gray, '─'.repeat(Math.max(8, cols)));
}

function renderGlance(ctx) {
  const { health, ld, supply, netPerMin, now, cols, rows, rateSamples } = ctx;
  const tty = ctx.tty;
  const c = (code, s) => paint(tty, code, s);
  const mood = classify(ctx);
  const head = conclusion({ ...ctx, mood });
  const target = ld.targetUsd || 1000;
  const bal = health.ok ? health.totalBalance : 0;
  const pct = target > 0 ? bal / target : 0;

  // Content width = full terminal minus small gutter
  const gutter = 2;
  const W = Math.max(40, cols - gutter * 2);
  const pad = (s) => ' '.repeat(gutter) + s;

  const out = [];
  const add = (s = '') => out.push(s.length ? pad(s) : '');

  // ── header ───────────────────────────────────────────────
  add('');
  add(c(ansi.bold, c(head.color, head.title)));
  if (head.sub) add(c(ansi.dim, head.sub));
  add('');

  if (mood === 'DOWN') {
    add(c(ansi.dim, 'is gateway up?  launchctl kickstart gui/$(id -u)/com.tokenharbor.gateway'));
  } else {
    // ── hero balance (uses full width) ─────────────────────
    const balColor = mood === 'EMPTY' ? ansi.red : mood === 'HEALTHY' ? ansi.green : ansi.bold;
    const left = money(bal) + ' book';
    const right = 'target ' + money(target);
    const mid = Math.max(2, W - stripAnsi(left).length - stripAnsi(right).length);
    add(c(balColor, left) + ' '.repeat(mid) + c(ansi.dim, right));

    // progress track = full content width
    const barColor =
      mood === 'EMPTY' ? ansi.red : mood === 'HEALTHY' ? ansi.green : ansi.yellow;
    add(bar(pct, W, c, barColor));

    // pct + counts on one full-width row
    const pctStr = Math.round(pct * 100) + '%';
    let meta =
      pctStr +
      '  ·  ' +
      health.activeKeys +
      ' live  ·  ' +
      health.exhaustedKeys +
      ' exhausted  ·  ' +
      health.totalKeys +
      ' keys';
    if (netPerMin != null && netPerMin < -0.05 && bal > 0) {
      meta += '  ·  headroom ' + fmtDur((bal / Math.abs(netPerMin)) * 60);
    }
    add(c(ansi.dim, meta));
    add('');

    // ── workers (full width columns) ───────────────────────
    add(c(ansi.dim, 'WORKERS'));
    const ws = supply.workers || [];
    if (ld.running && ws.length) {
      for (const w of ws) {
        const age = ageSec(w.at);
        const ageStr = w.stage === 'done' ? w.detail || '+$5' : age != null ? fmtAge(age) : '';
        const stageColor =
          w.stage === 'done'
            ? ansi.green
            : w.stage === 'fail'
              ? ansi.red
              : w.stage === 'opening'
                ? ansi.yellow
                : null;
        const leftW =
          c(ansi.dim, 'w' + w.id) + '  ' + c(stageColor, stageLabel(w.stage));
        const emailBudget = Math.max(12, W - stripAnsi(leftW).length - 8);
        const email = truncEmail(w.email || (w.stage === 'signup' ? '…' : '…'), emailBudget);
        const row =
          leftW +
          '  ' +
          email +
          ' '.repeat(Math.max(1, W - stripAnsi(leftW).length - 2 - stripAnsi(email).length - String(ageStr).length)) +
          c(ansi.dim, String(ageStr));
        add(row);
      }
    } else if (ld.running) {
      add(c(ansi.dim, 'starting…'));
    } else {
      add(c(ansi.dim, 'idle'));
    }
    add('');

    // ── rate sparkline when we have samples ───────────────
    if (rateSamples && rateSamples.length >= 2) {
      add(c(ansi.dim, 'BALANCE (session)'));
      const net = netPerMin;
      const netTxt =
        net == null ? '' : '  ' + (net >= 0 ? '+' : '') + moneyFine(net) + '/min';
      add(sparkline(rateSamples, W - stripAnsi(netTxt).length, c) + c(ansi.dim, netTxt));
      add('');
    }

    // ── recent feed: CONSUMES remaining rows ──────────────
    // Compute how many lines we can still place before footer.
    // We'll finalize after building fixed sections; see below.
  }

  // evidence strip
  const footBits = [];
  if (supply.added != null) footBits.push('+' + supply.added + ' this run');
  if (supply.maxAdds != null && supply.added != null) footBits.push(supply.added + '/' + supply.maxAdds);
  if (supply.failStreak) footBits.push('fail ' + supply.failStreak);
  if (ld.running && ld.pid) footBits.push('pid ' + ld.pid);
  else if (!ld.running) footBits.push(ld.loaded ? 'supply idle' : 'supply not loaded');
  if (health.ok && health.ledgerSeq != null) footBits.push('ledger #' + health.ledgerSeq);
  if (health.ok && health.ms != null) footBits.push(health.ms + 'ms');
  if (mood !== 'DOWN') add(c(ansi.dim, footBits.join('  ·  ')));

  // Fill leftover viewport with RECENT activity
  const footerReserve = 1;
  const used = out.length;
  const leftover = Math.max(0, rows - footerReserve - used);
  if (mood !== 'DOWN' && leftover >= 3) {
    add('');
    add(c(ansi.dim, 'RECENT'));
    const feedBudget = Math.max(1, leftover - 2); // header + blank eaten
    const events = (supply.recent || []).slice().reverse(); // newest first
    const show = events.slice(0, feedBudget);
    if (!show.length) {
      add(c(ansi.dim, 'no events yet'));
    } else {
      for (const ev of show) {
        const tag =
          ev.kind === 'funded'
            ? c(ansi.green, 'funded')
            : ev.kind === 'fail'
              ? c(ansi.red, 'fail  ')
              : c(ansi.dim, (ev.kind || 'event').padEnd(6));
        const who = ev.email ? truncEmail(ev.email, Math.max(10, W - 18)) : ev.text || '';
        const wtag = ev.worker ? c(ansi.dim, 'w' + ev.worker) + '  ' : '';
        add(wtag + tag + '  ' + who);
      }
      // if still short, pad is fine — packFrame handles it
    }
  }

  // If STILL short on a tall terminal, stretch the bar section was already full width;
  // add a blank spacer section label so it doesn't feel like a bug — actually just let pack pad.

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
      if (health.ok) rates.push(health.totalBalance);
      const ld = launchd(cfg);
      const supply = parseSupplyLog(readTail(supplyLogPath()));
      const nowMs = Date.now();
      for (const w of supply.workers) {
        const key = String(w.id);
        const prev = stageSince.get(key);
        if (!prev || prev.stage !== w.stage || prev.email !== (w.email || '')) {
          stageSince.set(key, { stage: w.stage, email: w.email || '', at: nowMs });
          w.at = nowMs;
        } else {
          w.at = prev.at;
        }
      }
      const { cols, rows } = termSize();
      const frame = renderGlance({
        tty,
        health,
        ld,
        supply,
        netPerMin: rates.netPerMin(),
        rateSamples: rates.samples(),
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

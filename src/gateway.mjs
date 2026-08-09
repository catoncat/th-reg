// Local OpenAI-compatible gateway — the single static endpoint Pi points at.
//
// Pi configures ONE baseUrl (http://localhost:PORT/v1) and ONE static key
// (th-local), and never thinks about key rotation, balance, or registration
// again. The gateway borrows a healthy key from the pool, forwards the request
// upstream, and — the part the old rotate.sh could never do — on a hard failure
// (401/402/403) it retires that key and retries with a DIFFERENT key inside the
// same HTTP request, so Pi only ever sees a clean success or a clean
// pool-exhausted error.
//
// Fact ledger (not a full wallet mirror):
//   open (+$5) → used (once on first 200) → exhausted ($0 on hard fail).
// Coarse money is $5 or $0 per key. Optional soft debit (usage × local rates)
// only interpolates between those facts — never "login every account".
// Stream requests get stream_options.include_usage so soft fill has a signal.
//
// Endpoints (request/response bodies are never translated):
//   POST /v1/chat/completions   (OpenAI Chat Completions)
//   POST /v1/responses          (OpenAI Responses)
//   POST /v1/messages           (Anthropic Messages)
//   GET  /v1/models             (proxied, for pi model discovery)
//   GET  /health                (pool status: active keys, total balance)
//
// Failure mapping (must mirror th-api.probeKey): tokenharbor returns
// 403 code=balance_zero for an empty wallet, 401 for a dead key, 429 for quota.

import { createServer } from 'node:http';
import { estimateCostUsd } from './pricing.mjs';

const UPSTREAM = 'https://tokenharbor.ai/v1';
const TIMEOUT = 120000; // upstream LLM calls can be slow
const MAX_KEY_ATTEMPTS = 8; // give up after trying this many distinct keys

function classify(status, code) {
  if (status === 401 || code === 'unauthorized') return 'dead';
  if (status === 402 || code === 'balance_zero' || /insufficient|balance/i.test(code || '')) return 'balance';
  if (status === 429 || /rate|limit|quota/i.test(code || '')) return 'quota';
  if (status >= 500 || status === 0) return 'network';
  return 'unknown';
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function sendJson(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
  res.end(b);
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Copy end-to-end request headers while replacing client/local authentication. */
function upstreamHeaders(req, protocol, key) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (
      value == null ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'authorization' ||
      lower === 'x-api-key'
    ) {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  if (protocol === 'anthropic') {
    headers.set('x-api-key', key);
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
  } else {
    headers.set('authorization', `Bearer ${key}`);
  }
  return headers;
}

/** Preserve upstream status metadata and protocol-specific response headers. */
function responseHeaders(upstream) {
  const headers = {};
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    // Node fetch transparently decompresses upstream bodies, so the original
    // content-encoding/content-length no longer describe the relayed bytes.
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'content-length' || lower === 'content-encoding') continue;
    headers[name] = value;
  }
  return headers;
}

function isRetryable(status, reason) {
  return reason === 'dead' || reason === 'balance' || reason === 'quota' || status >= 500;
}

/** Pull OpenAI-style usage from a buffered non-stream or SSE body. */
function extractUsage(raw, streaming) {
  if (!raw) return null;
  if (!streaming) {
    try {
      return JSON.parse(raw).usage || null;
    } catch {
      return null;
    }
  }
  let usage = null;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.replace(/^data:\s?/, '').trim();
    if (!data || data === '[DONE]') continue;
    try {
      const j = JSON.parse(data);
      const eventUsage = j.usage || j.message?.usage || j.response?.usage;
      if (eventUsage) usage = { ...(usage || {}), ...eventUsage };
    } catch {
      /* partial */
    }
  }
  return usage;
}

function onSuccess(pool, rec, { model, raw, streaming, log, requestMeta = null }) {
  // Fact first (used once). Soft fill between $5 and $0 is optional interpolation.
  try {
    if (typeof pool.markUsed === 'function') pool.markUsed(rec, { source: 'gateway' });
    else pool.report(rec.key, { ok: true });

    const usage = extractUsage(raw, streaming);
    const cost = estimateCostUsd(model || 'default', usage);
    if (cost > 0 && typeof pool.consume === 'function') {
      const r = pool.consume(rec.key, cost, {
        model,
        usage,
        source: 'gateway-soft',
        project: requestMeta?.project || null,
        session: requestMeta?.sessionId || null,
      });
      if (r) {
        const route = requestMeta?.project
          ? `  project=${encodeURIComponent(requestMeta.project)}${requestMeta.sessionId ? `  session=${encodeURIComponent(requestMeta.sessionId)}` : ''}`
          : '';
        log(
          `${rec.file} (${rec.email || '?'}) -> 200  used  soft−${cost.toFixed(4)}  book=${Number(r.balance).toFixed(2)}  ${model || '?'}${route}`,
        );
        return;
      }
    }
    log(`${rec.file} (${rec.email || '?'}) -> 200  used`);
  } catch (e) {
    try {
      pool.report(rec.key, { ok: true });
    } catch {
      /* ignore */
    }
    log(`${rec.file} onSuccess-failed ${String(e).slice(0, 60)}`);
  }
}

export function createGateway({
  pool,
  log = () => {},
  onPoolExhausted = null,
  requestLog = null,
  upstreamBase = UPSTREAM,
  timeoutMs = TIMEOUT,
  maxKeyAttempts = MAX_KEY_ATTEMPTS,
}) {
  async function handleMessages(req, res, bodyBuf, endpoint = 'messages') {
    const tried = new Set();
    let lastHard = null;
    let model = null;
    let streaming = false;
    try {
      const j = JSON.parse(bodyBuf.toString('utf8'));
      model = j.model || null;
      streaming = !!j.stream;
    } catch {
      /* upstream will report malformed JSON */
    }
    // count_tokens is a metering endpoint: it does not spend, so we do not
    // mark the key used or rotate on failure — just forward the first result.
    const metering = endpoint === 'messages/count_tokens';
    // Local token estimate for the metering endpoint. Claude Code calls
    // count_tokens before every request to budget context; if the upstream
    // metering endpoint hangs (observed: upstream Anthropic POST path can
    // stall while GET stays healthy), we fall back to an approximation so the
    // agent keeps moving instead of blocking for the full upstream timeout.
    // This is a budget estimate, not billing — the real call reports usage.
    const estimateTokens = (buf) => {
      try {
        const j = JSON.parse(buf.toString('utf8'));
        const parts = [j.system, ...(j.messages || [])].map((m) => {
          if (m == null) return '';
          if (typeof m === 'string') return m;
          const c = m?.content;
          return typeof c === 'string' ? c : JSON.stringify(c ?? '');
        });
        const text = parts.join(' ');
        let ascii = 0;
        let cjk = 0;
        for (const ch of text) {
          if (ch.codePointAt(0) > 0x2e80) cjk += 1;
          else ascii += 1;
        }
        // ASCII ≈ 4 chars/token, CJK ≈ 1 char/token. Approximation only.
        return Math.max(1, Math.ceil(ascii / 4) + cjk);
      } catch {
        return 0;
      }
    };

    for (let attempt = 0; attempt < maxKeyAttempts; attempt++) {
      const rec = pool.borrowKey(tried);
      if (!rec) {
        log(`pool exhausted after ${tried.size} Anthropic key attempt(s)`);
        try {
          onPoolExhausted?.({ tried: tried.size });
        } catch {
          /* never break the 503 path */
        }
        return sendJson(res, 503, {
          error: {
            message: 'tokenharbor pool exhausted: no healthy key with balance. Run supply / top-up.',
            type: 'pool_exhausted',
          },
        });
      }
      tried.add(rec.key);

      let upstream;
      try {
        // Metering endpoint gets a short budget; fall back to local estimate
        // when the upstream stalls (see comment at estimateTokens).
        upstream = await fetch(`${upstreamBase}/${endpoint}`, {
          method: 'POST',
          headers: upstreamHeaders(req, 'anthropic', rec.key),
          body: bodyBuf,
          signal: AbortSignal.timeout(metering ? 3000 : timeoutMs),
        });
      } catch (e) {
        if (metering) {
          const estimated = estimateTokens(bodyBuf);
          log(`count_tokens upstream unavailable (${String(e).slice(0, 40)}); local estimate ${estimated}`);
          return sendJson(res, 200, { input_tokens: estimated });
        }
        pool.report(rec.key, { ok: false, reason: 'network', error: String(e).slice(0, 80) });
        log(`${rec.file} Anthropic network error, trying next key`);
        continue;
      }

      const status = upstream.status;
      if (status >= 200 && status < 300) {
        res.writeHead(status, responseHeaders(upstream));
        const chunks = [];
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            res.write(chunk);
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
        }
        res.end();
        if (!metering) {
          onSuccess(pool, rec, {
            model,
            raw: Buffer.concat(chunks).toString('utf8'),
            streaming,
            log,
          });
        }
        return;
      }

      const failureBody = Buffer.from(await upstream.arrayBuffer());
      let code = '';
      try {
        const failure = JSON.parse(failureBody.toString('utf8'));
        code = failure?.error?.code || failure?.error?.type || '';
      } catch {
        /* not json */
      }
      const reason = classify(status, code);
      if (!isRetryable(status, reason)) {
        res.writeHead(status, responseHeaders(upstream));
        res.end(failureBody);
        return;
      }
      pool.report(rec.key, { ok: false, reason, error: code || `http ${status}` });
      lastHard = { status, code, reason };
      log(`${rec.file} Anthropic -> ${status} ${code} (${reason}); rotating`);
    }

    sendJson(res, 503, {
      error: {
        message: `tokenharbor upstream failed after ${maxKeyAttempts} key attempts. Last: ${lastHard?.status} ${lastHard?.code}`,
        type: lastHard?.reason || 'upstream_error',
      },
    });
  }

  async function handleOpenAI(req, res, bodyBuf, endpoint) {
    // Record routing metadata only. Do not persist prompt contents.
    if (requestLog) {
      try {
        const j = JSON.parse(bodyBuf.toString('utf8'));
        const text = Array.isArray(j.messages)
          ? j.messages.map((m) => (typeof m?.content === 'string' ? m.content : '')).join('\n')
          : '';
        const workingDirectory = text.match(/Working directory:\s*(.+)/)?.[1]?.trim() || null;
        const conversationLog = text.match(/Conversation log:\s*(.+)/)?.[1]?.trim() || null;
        const sessionId = conversationLog
          ? conversationLog.split('/').pop()?.replace(/\.jsonl$/, '') || null
          : null;
        requestLog(
          JSON.stringify({
            at: new Date().toISOString(),
            model: j.model || null,
            ua: req.headers['user-agent'] || null,
            project: workingDirectory,
            session_id: sessionId,
            remote_port: req.socket.remotePort || null,
          }),
        );
      } catch {
        /* body not JSON — ignore */
      }
    }
    const tried = new Set();
    let lastHard = null;
    let model = null;
    let streaming = false;
    try {
      const j = JSON.parse(bodyBuf.toString('utf8'));
      model = j.model || null;
      streaming = !!j.stream;
    } catch {
      /* upstream will report malformed JSON */
    }
    let requestMeta = null;
    try {
      const j = JSON.parse(bodyBuf.toString('utf8'));
      const text = Array.isArray(j.messages)
        ? j.messages.map((m) => (typeof m?.content === 'string' ? m.content : '')).join('\n')
        : '';
      const project = text.match(/Working directory:\s*(.+)/)?.[1]?.trim() || null;
      const conversationLog = text.match(/Conversation log:\s*(.+)/)?.[1]?.trim() || null;
      const sessionId = conversationLog
        ? conversationLog.split('/').pop()?.replace(/\.jsonl$/, '') || null
        : null;
      requestMeta = { project, sessionId };
      if (!project && process.env.TH_ATTR_DEBUG) {
        // Structure only — never content. Answers: did the marker arrive at all,
        // and in what shape did the client send message content?
        const raw = bodyBuf.toString('utf8');
        requestLog?.(
          JSON.stringify({
            at: new Date().toISOString(),
            debug: 'attr-miss',
            model: j.model || null,
            roles: Array.isArray(j.messages) ? j.messages.map((m) => m?.role) : null,
            contentKinds: Array.isArray(j.messages)
              ? j.messages.map((m) =>
                  typeof m?.content === 'string' ? 'str' : Array.isArray(m?.content) ? 'arr' : typeof m?.content,
                )
              : null,
            markerInRawBody: raw.includes('Working directory:'),
          }),
        );
      }
    } catch {
      /* metadata is best effort */
    }

    for (let attempt = 0; attempt < maxKeyAttempts; attempt++) {
      const rec = pool.borrowKey(tried);
      if (!rec) {
        log(`pool exhausted after ${tried.size} key attempt(s)`);
        try {
          onPoolExhausted?.({ tried: tried.size });
        } catch {
          /* never break the 503 path */
        }
        return sendJson(res, 503, {
          error: {
            message: 'tokenharbor pool exhausted: no healthy key with balance. Run supply / top-up.',
            type: 'pool_exhausted',
            code: 'pool_exhausted',
          },
        });
      }
      tried.add(rec.key);

      let upstream;
      try {
        upstream = await fetch(`${upstreamBase}/${endpoint}`, {
          method: 'POST',
          headers: upstreamHeaders(req, 'openai', rec.key),
          body: bodyBuf,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        // network-level failure talking to upstream; do NOT kill the key
        pool.report(rec.key, { ok: false, reason: 'network', error: String(e).slice(0, 80) });
        log(`${rec.file} network error, trying next key`);
        continue;
      }

      const status = upstream.status;
      if (status >= 200 && status < 300) {
        // Stream/buffer to client while retaining a copy for usage → local consume.
        res.writeHead(status, responseHeaders(upstream));
        const chunks = [];
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            res.write(chunk);
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
        }
        res.end();
        const raw = Buffer.concat(chunks).toString('utf8');
        onSuccess(pool, rec, {
          model,
          raw,
          streaming,
          log,
          requestMeta,
        });
        return;
      }

      // hard failure: classify, retire the key, retry with another
      const failureBody = Buffer.from(await upstream.arrayBuffer());
      let code = '';
      try {
        const failure = JSON.parse(failureBody.toString('utf8'));
        code = failure?.error?.code || failure?.error?.type || '';
      } catch {
        /* not json */
      }
      const reason = classify(status, code);
      if (!isRetryable(status, reason)) {
        res.writeHead(status, responseHeaders(upstream));
        res.end(failureBody);
        return;
      }
      pool.report(rec.key, { ok: false, reason, error: code || `http ${status}` });
      lastHard = { status, code, reason, file: rec.file };
      log(`${rec.file} -> ${status} ${code} (${reason}); rotating`);
      // loop continues with a different key
    }

    // ran out of attempts
    sendJson(res, 503, {
      error: {
        message: `tokenharbor upstream failed after ${maxKeyAttempts} key attempts. Last: ${lastHard?.status} ${lastHard?.code}`,
        type: lastHard?.reason || 'upstream_error',
        code: lastHard?.code || 'upstream_error',
      },
    });
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        // Prefer Pool.healthSnapshot (includes exhausted=$0 facts learned from traffic).
        if (typeof pool.healthSnapshot === 'function') {
          return sendJson(res, 200, pool.healthSnapshot());
        }
        return sendJson(res, 200, {
          ok: pool.activeCount() > 0,
          activeKeys: pool.activeCount(),
          totalBalance: Number(pool.totalBalance().toFixed(2)),
          keys: pool.all().map((r) => ({
            file: r.file,
            status: r.status,
            balance: r.balance,
            email: r.email,
          })),
        });
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const rec = pool.borrowKey();
        if (!rec) return sendJson(res, 503, { error: { message: 'pool exhausted' } });
        const u = await fetch(`${upstreamBase}/models`, {
          headers: { authorization: `Bearer ${rec.key}` },
          signal: AbortSignal.timeout(20000),
        });
        const j = await u.json().catch(() => ({}));
        return sendJson(res, u.status, j);
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readBody(req);
        return await handleOpenAI(req, res, body, 'chat/completions');
      }
      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        const body = await readBody(req);
        return await handleOpenAI(req, res, body, 'responses');
      }
      if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
        const body = await readBody(req);
        return await handleMessages(req, res, body, 'messages/count_tokens');
      }
      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        const body = await readBody(req);
        return await handleMessages(req, res, body);
      }
      sendJson(res, 404, { error: { message: 'not found' } });
    } catch (e) {
      // Only send if headers not already flushed (e.g. mid-stream failure).
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message: String(e).slice(0, 200) } });
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
  });
}

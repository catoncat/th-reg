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
// Endpoints:
//   POST /v1/chat/completions   (stream + non-stream passthrough)
//   GET  /v1/models             (proxied, for pi model discovery)
//   GET  /health                (pool status: active keys, total balance)
//
// Failure mapping (must mirror th-api.probeKey): tokenharbor returns
// 403 code=balance_zero for an empty wallet, 401 for a dead key, 429 for quota.

import { createServer } from 'node:http';

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

export function createGateway({ pool, log = () => {} }) {
  async function handleChat(req, res, bodyBuf) {
    const tried = new Set();
    let lastHard = null;

    for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
      const rec = pool.borrowKey(tried);
      if (!rec) {
        log(`[gateway] pool exhausted after ${tried.size} key attempt(s)`);
        return sendJson(res, 503, {
          error: {
            message: 'tokenharbor pool exhausted: no healthy key with balance. Run `th board` / top-up.',
            type: 'pool_exhausted',
            code: 'pool_exhausted',
          },
        });
      }
      tried.add(rec.key);

      let upstream;
      try {
        upstream = await fetch(`${UPSTREAM}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${rec.key}` },
          body: bodyBuf,
          signal: AbortSignal.timeout(TIMEOUT),
        });
      } catch (e) {
        // network-level failure talking to upstream; do NOT kill the key
        pool.report(rec.key, { ok: false, reason: 'network', error: String(e).slice(0, 80) });
        log(`[gateway] ${rec.file} network error, trying next key`);
        continue;
      }

      const status = upstream.status;
      if (status === 200) {
        pool.report(rec.key, { ok: true });
        log(`[gateway] ${rec.file} (${rec.email || '?'}) -> 200`);
        // stream or buffer straight back to Pi
        res.writeHead(200, {
          'content-type': upstream.headers.get('content-type') || 'application/json',
          'transfer-encoding': 'chunked',
        });
        if (upstream.body) {
          for await (const chunk of upstream.body) res.write(chunk);
        }
        return res.end();
      }

      // hard failure: classify, retire the key, retry with another
      let code = '';
      try {
        code = (await upstream.clone().json())?.error?.code || '';
      } catch { /* not json */ }
      const reason = classify(status, code);
      pool.report(rec.key, { ok: false, reason, error: code || `http ${status}` });
      lastHard = { status, code, reason, file: rec.file };
      log(`[gateway] ${rec.file} -> ${status} ${code} (${reason}); rotating`);
      // loop continues with a different key
    }

    // ran out of attempts
    sendJson(res, 503, {
      error: {
        message: `tokenharbor upstream failed after ${MAX_KEY_ATTEMPTS} key attempts. Last: ${lastHard?.status} ${lastHard?.code}`,
        type: lastHard?.reason || 'upstream_error',
        code: lastHard?.code || 'upstream_error',
      },
    });
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
          ok: pool.activeCount() > 0,
          activeKeys: pool.activeCount(),
          totalBalance: Number(pool.totalBalance().toFixed(2)),
          keys: pool.all().map((r) => ({ file: r.file, status: r.status, balance: r.balance, email: r.email })),
        });
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const rec = pool.borrowKey();
        if (!rec) return sendJson(res, 503, { error: { message: 'pool exhausted' } });
        const u = await fetch(`${UPSTREAM}/models`, { headers: { authorization: `Bearer ${rec.key}` }, signal: AbortSignal.timeout(20000) });
        const j = await u.json().catch(() => ({}));
        return sendJson(res, u.status, j);
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readBody(req);
        return await handleChat(req, res, body);
      }
      sendJson(res, 404, { error: { message: 'not found' } });
    } catch (e) {
      sendJson(res, 500, { error: { message: String(e).slice(0, 200) } });
    }
  });
}

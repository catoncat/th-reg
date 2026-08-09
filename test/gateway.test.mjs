import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGateway } from '../src/gateway.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function pool(keys = ['key-one']) {
  const reports = [];
  return {
    reports,
    borrowKey(excluded = new Set()) {
      const key = keys.find((candidate) => !excluded.has(candidate));
      return key ? { key, file: key, email: `${key}@example.test` } : null;
    },
    markUsed() {},
    report(key, result) {
      reports.push({ key, ...result });
    },
  };
}

test('gateway transparently relays all three protocol bodies and relevant headers', async () => {
  const seen = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    const body = JSON.stringify({ path: req.url, usage: { input_tokens: 1, output_tokens: 1 } });
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': `request-${seen.length}` });
    res.end(body);
  });
  const upstreamOrigin = await listen(upstream);
  const gateway = createGateway({ pool: pool(), upstreamBase: `${upstreamOrigin}/v1` });
  const gatewayOrigin = await listen(gateway);
  try {
    const cases = [
      ['/v1/chat/completions', { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] }],
      ['/v1/responses', { model: 'gpt-5.6-sol', input: 'hi', metadata: { keep: 'verbatim' } }],
      ['/v1/messages', { model: 'claude-sonnet-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }],
    ];
    for (const [path, body] of cases) {
      const response = await fetch(`${gatewayOrigin}${path}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer local-placeholder',
          'x-api-key': 'local-placeholder',
          'content-type': 'application/json',
          'x-client-request-id': 'client-request',
          ...(path.endsWith('/messages') ? { 'anthropic-beta': 'test-beta' } : {}),
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('x-request-id'), /^request-/);
      assert.deepEqual(await response.json(), {
        path: path.replace('/v1', '/v1'),
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }

    assert.deepEqual(seen.map((request) => request.path), [
      '/v1/chat/completions',
      '/v1/responses',
      '/v1/messages',
    ]);
    for (let index = 0; index < cases.length; index++) {
      assert.deepEqual(JSON.parse(seen[index].body), cases[index][1]);
      assert.equal(seen[index].headers['x-client-request-id'], 'client-request');
    }
    assert.equal(seen[0].headers.authorization, 'Bearer key-one');
    assert.equal(seen[1].headers.authorization, 'Bearer key-one');
    assert.equal(seen[2].headers['x-api-key'], 'key-one');
    assert.equal(seen[2].headers['anthropic-version'], '2023-06-01');
    assert.equal(seen[2].headers['anthropic-beta'], 'test-beta');
    assert.equal(seen[2].headers.authorization, undefined);
  } finally {
    await close(gateway);
    await close(upstream);
  }
});

test('gateway rotates keys on hard failures but preserves ordinary upstream errors', async () => {
  const attempts = [];
  const upstream = createServer(async (req, res) => {
    const auth = req.headers.authorization;
    attempts.push(auth);
    if (auth === 'Bearer key-one') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'bad key' } }));
    }
    res.writeHead(400, { 'content-type': 'application/json', 'x-request-id': 'bad-request-id' });
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad input' } }));
  });
  const upstreamOrigin = await listen(upstream);
  const keyPool = pool(['key-one', 'key-two']);
  const gateway = createGateway({ pool: keyPool, upstreamBase: `${upstreamOrigin}/v1` });
  const gatewayOrigin = await listen(gateway);
  try {
    const response = await fetch(`${gatewayOrigin}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi' }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('x-request-id'), 'bad-request-id');
    assert.deepEqual(await response.json(), {
      error: { type: 'invalid_request_error', message: 'bad input' },
    });
    assert.deepEqual(attempts, ['Bearer key-one', 'Bearer key-two']);
    assert.equal(keyPool.reports[0].reason, 'dead');
    assert.equal(keyPool.reports.length, 1);
  } finally {
    await close(gateway);
    await close(upstream);
  }
});

test('gateway relays SSE bytes and protocol usage without translation', async () => {
  const payload = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
  ].join('');
  const upstream = createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'stream-request' });
    res.write(payload.slice(0, 47));
    res.end(payload.slice(47));
  });
  const upstreamOrigin = await listen(upstream);
  const gateway = createGateway({ pool: pool(), upstreamBase: `${upstreamOrigin}/v1` });
  const gatewayOrigin = await listen(gateway);
  try {
    const response = await fetch(`${gatewayOrigin}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi', stream: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(response.headers.get('x-request-id'), 'stream-request');
    assert.equal(await response.text(), payload);
  } finally {
    await close(gateway);
    await close(upstream);
  }
});

test('gateway falls back to local token estimate when count_tokens upstream stalls', async () => {
  const upstream = createServer(async (_req, _res) => {
    // Simulate the observed upstream stall: never respond.
    await new Promise(() => {});
  });
  const upstreamOrigin = await listen(upstream);
  const gateway = createGateway({ pool: pool(), upstreamBase: `${upstreamOrigin}/v1` });
  const gatewayOrigin = await listen(gateway);
  try {
    const started = Date.now();
    const response = await fetch(`${gatewayOrigin}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'th-local', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hello world' }] }),
    });
    const elapsed = Date.now() - started;
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.input_tokens >= 1);
    assert.ok(elapsed < 5000, `fallback should be fast, took ${elapsed}ms`);
  } finally {
    await close(gateway);
    await close(upstream);
  }
});

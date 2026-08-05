import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpMailbox } from '../src/http-mailbox.mjs';

test('HttpMailbox fetches and normalizes messages', async () => {
  let request;
  const mailbox = new HttpMailbox({
    baseUrl: 'https://mail.example.test',
    token: 'secret-token',
    fetchImpl: async (url, options) => {
      request = { url: url.toString(), options };
      return new Response(JSON.stringify({
        messages: [{ id: 'm1', receivedAt: '2026-01-01T00:00:00Z', text: 'enter: 123456' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.deepEqual(await mailbox.messages('user@example.com', 10), {
    items: [{
      id: 'm1',
      received_at: '2026-01-01T00:00:00Z',
      text_body: 'enter: 123456',
      html_body: '',
      subject: '',
      from: null,
      to: null,
    }],
  });
  assert.equal(request.url, 'https://mail.example.test/messages?email=user%40example.com&limit=10');
  assert.equal(request.options.headers.authorization, 'Bearer secret-token');
});

test('HttpMailbox supports raw custom auth headers', async () => {
  let headers;
  const mailbox = new HttpMailbox({
    baseUrl: 'https://mail.example.test',
    token: 'api-key',
    authHeader: 'x-api-key',
    authScheme: '',
    fetchImpl: async (_url, options) => {
      headers = options.headers;
      return new Response('{"items":[]}');
    },
  });
  await mailbox.messages('user@example.com');
  assert.equal(headers['x-api-key'], 'api-key');
});

test('HttpMailbox does not expose upstream error bodies', async () => {
  const mailbox = new HttpMailbox({
    baseUrl: 'https://mail.example.test',
    fetchImpl: async () => new Response('internal details', { status: 401 }),
  });
  await assert.rejects(() => mailbox.messages('user@example.com'), /HTTP 401/);
});

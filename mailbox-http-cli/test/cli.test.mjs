import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);

test('mailbox-http binary implements the JSON CLI contract', async (context) => {
  let request;
  const server = createServer((incoming, response) => {
    request = { url: incoming.url, authorization: incoming.headers.authorization };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ items: [{ id: 'm1', text_body: 'enter: 654321' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());

  const address = server.address();
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    new URL('../bin/mailbox-http.mjs', import.meta.url).pathname,
    'messages', '--email', 'user@example.com', '--limit', '7',
  ], {
    env: {
      ...process.env,
      MAILBOX_HTTP_BASE_URL: `http://127.0.0.1:${address.port}`,
      MAILBOX_HTTP_TOKEN: 'test-token',
    },
  });

  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).items[0].text_body, 'enter: 654321');
  assert.equal(request.url, '/messages?email=user%40example.com&limit=7');
  assert.equal(request.authorization, 'Bearer test-token');
});

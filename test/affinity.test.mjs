import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from '../src/pool.mjs';
import { conversationId } from '../src/gateway.mjs';

function mkPool(n) {
  const p = Object.create(Pool.prototype);
  p.keys = new Map();
  p.rr = 0;
  p.affinity = new Map();
  for (let i = 0; i < n; i++) {
    const key = `k${i}`;
    p.keys.set(key, { key, file: `f${i}`, status: 'ok', balance: 5 });
  }
  return p;
}
const body = (o) => Buffer.from(JSON.stringify(o), 'utf8');

test('same conversation sticks to one key', () => {
  const p = mkPool(5);
  const id = conversationId(body({ system: 'S', messages: [{ role: 'user', content: 'hi' }] }));
  const first = p.borrowKey(new Set(), id).key;
  for (let i = 0; i < 20; i++) assert.equal(p.borrowKey(new Set(), id).key, first);
});

test('different conversations spread across keys', () => {
  const p = mkPool(5);
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    const id = conversationId(body({ system: `S${i}`, messages: [{ role: 'user', content: 'hi' }] }));
    seen.add(p.borrowKey(new Set(), id).key);
  }
  assert.ok(seen.size > 1, `expected spread, got ${seen.size}`);
});

test('exhausted pinned key falls back and re-pins', () => {
  const p = mkPool(3);
  const id = conversationId(body({ system: 'S', messages: [{ role: 'user', content: 'hi' }] }));
  const first = p.borrowKey(new Set(), id).key;
  p.keys.get(first).status = 'exhausted';
  const next = p.borrowKey(new Set(), id).key;
  assert.notEqual(next, first);
  assert.equal(p.borrowKey(new Set(), id).key, next, 're-pinned to the new key');
});

test('retry excludes the pinned key', () => {
  const p = mkPool(3);
  const id = conversationId(body({ system: 'S', messages: [{ role: 'user', content: 'hi' }] }));
  const first = p.borrowKey(new Set(), id).key;
  assert.notEqual(p.borrowKey(new Set([first]), id).key, first);
});

test('appending messages keeps the same conversation id', () => {
  const a = conversationId(body({ system: 'S', messages: [{ role: 'user', content: 'one' }] }));
  const b = conversationId(body({ system: 'S', messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'r' }] }));
  assert.equal(a, b);
});

test('different system prompt yields a different id', () => {
  const a = conversationId(body({ system: 'S', messages: [{ role: 'user', content: 'one' }] }));
  const b = conversationId(body({ system: 'T', messages: [{ role: 'user', content: 'one' }] }));
  assert.notEqual(a, b);
});

test('no prompt head yields null, and null disables affinity', () => {
  assert.equal(conversationId(body({ model: 'x' })), null);
  assert.equal(conversationId(Buffer.from('not json')), null);
  const p = mkPool(3);
  const keys = new Set([p.borrowKey(new Set(), null).key, p.borrowKey(new Set(), null).key]);
  assert.equal(keys.size, 2, 'null affinity keeps plain round-robin');
});

test('affinity map stays bounded', () => {
  const p = mkPool(3);
  for (let i = 0; i < 600; i++) p.borrowKey(new Set(), `id-${i}`);
  assert.ok(p.affinity.size <= 500, `size=${p.affinity.size}`);
});

test('transient failure keeps the pin for the next turn', () => {
  const p = mkPool(3);
  const id = conversationId(body({ system: 'S', messages: [{ role: 'user', content: 'hi' }] }));
  const first = p.borrowKey(new Set(), id).key;

  // Retry inside the same request must land elsewhere...
  const retry = p.borrowKey(new Set([first]), id).key;
  assert.notEqual(retry, first);
  // ...but must not steal the pin.
  assert.equal(p.affinity.get(id), first);
  // Next turn returns to the warm key.
  assert.equal(p.borrowKey(new Set(), id).key, first);
});

test('retired pin is released, transient one is not', () => {
  const p = mkPool(3);
  const id = conversationId(body({ system: 'S', messages: [{ role: 'user', content: 'hi' }] }));
  const first = p.borrowKey(new Set(), id).key;

  p.keys.get(first).status = 'quota'; // transient: pin survives
  p.borrowKey(new Set(), id);
  assert.equal(p.affinity.get(id), first);

  p.keys.get(first).status = 'exhausted'; // terminal: pin moves
  const next = p.borrowKey(new Set(), id).key;
  assert.equal(p.affinity.get(id), next);
  assert.notEqual(next, first);
});

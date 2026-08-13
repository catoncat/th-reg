import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from '../src/pool.mjs';

// Same harness as pool-flagged.test.mjs: drive Pool logic directly.
function mkPool(n = 2) {
  const p = Object.create(Pool.prototype);
  p.keys = new Map();
  p.rr = 0;
  p.affinity = new Map();
  p.ledger = null;
  p._persist = () => {};
  p._emit = () => {};
  for (let i = 0; i < n; i++) {
    const key = `k${i}`;
    p.keys.set(key, { key, file: `f${i}`, status: 'ok', balance: 5, email: `a${i}@x.test` });
  }
  return p;
}

const quotaFail = { ok: false, reason: 'quota', error: 'insufficient_quota' };

test('a fresh quota hit stays active for a fast retry (short backoff)', () => {
  const p = mkPool(2);
  p.report('k0', quotaFail); // failCount 1, lastUsed = now
  // failCount=1 backoff floor is the base window; the key has not waited it
  // out yet, so it must not be handed out again immediately.
  assert.equal(p.activeCount(), 1, 'a just-failed quota key must back off, not retry instantly');
  assert.ok(p.activeKeys().every((r) => r.key !== 'k0'));
});

test('a fresh quota hit becomes eligible again once its short backoff elapses', () => {
  const p = mkPool(2);
  p.report('k0', quotaFail);
  const rec = p.keys.get('k0');
  rec.lastUsed = new Date(Date.now() - 35_000).toISOString(); // past the 30s base window
  assert.equal(p.activeCount(), 2, 'failCount=1 must recover after the base backoff window');
});

test('a chronically stuck quota key (high failCount) is excluded even minutes later', () => {
  const p = mkPool(2);
  const rec = p.keys.get('k0');
  rec.status = 'quota';
  rec.failCount = 170; // measured 2026-08-13 production value
  rec.lastUsed = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 minutes ago
  assert.equal(p.activeCount(), 1, 'a chronic staller must not be retried on every request');
});

test('a chronically stuck quota key still recovers once its capped backoff elapses (top-up path)', () => {
  const p = mkPool(2);
  const rec = p.keys.get('k0');
  rec.status = 'quota';
  rec.failCount = 170;
  rec.lastUsed = new Date(Date.now() - 31 * 60_000).toISOString(); // past the 30min cap
  assert.equal(p.activeCount(), 2, 'backoff is capped, not permanent — a later top-up must still be reachable');
});

test('healthSnapshot reports quota keys waiting out backoff separately from active capacity', () => {
  const p = mkPool(2);
  const rec = p.keys.get('k0');
  rec.status = 'quota';
  rec.failCount = 170;
  rec.lastUsed = new Date().toISOString();
  const snap = p.healthSnapshot();
  assert.equal(snap.quotaKeys, 1);
  assert.equal(snap.quotaBackoffKeys, 1, 'a backing-off quota key must be visible, not silently folded into active');
  assert.equal(snap.activeKeys, 1, 'a backing-off quota key must not inflate reported active capacity');
});

test('borrowKey never hands out a quota key still inside its backoff window', () => {
  const p = mkPool(2);
  const rec = p.keys.get('k0');
  rec.status = 'quota';
  rec.failCount = 20;
  rec.lastUsed = new Date().toISOString();
  for (let i = 0; i < 10; i++) assert.equal(p.borrowKey().key, 'k1');
});

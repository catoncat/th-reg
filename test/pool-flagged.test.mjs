import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from '../src/pool.mjs';

// Same shape as affinity.test.mjs: drive the Pool logic directly instead of
// standing up secrets/state files, so nothing can reach the production pool.
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

const hold = { ok: false, reason: 'flagged', error: 'confidence_level_required' };

test('a flagged key leaves the rotation but keeps its money', () => {
  const p = mkPool(2);
  assert.equal(p.activeCount(), 2);

  p.report('k0', hold);

  assert.equal(p.activeCount(), 1, 'held key must not be borrowed again right away');
  const rec = p.keys.get('k0');
  assert.equal(rec.status, 'flagged');
  assert.equal(rec.balance, 5, 'a risk hold is not a money fact');
  assert.equal(p.healthSnapshot().totalBalance, 5, 'held money is not spendable head-room');
});

test('flagged is a per-tier terminal state: no cooldown revival for restricted, still borrowable by unrestricted', () => {
  const p = mkPool(2);
  p.report('k0', hold);
  assert.equal(p.activeCount(), 1);

  // Design since 2026-08-12 (model-tier layering): flagged is NOT a temporary
  // cooldown any more — an expired flaggedAt never returns the key to the
  // restricted rotation (claude/glm/gpt/gemini/kimi/deepseek-flash).
  p.keys.get('k0').flaggedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  assert.equal(p.activeCount(), 1, 'restricted pool must not revive a flagged key after cooldown');

  // Unrestricted-tier models (deepseek-pro/mimo/qwen) may still borrow it.
  assert.equal(p.activeKeys('unrestricted').length, 2);
  assert.ok(p.activeKeys('unrestricted').some((r) => r.key === 'k0'), 'unrestricted tier may borrow flagged keys');
});

test('a flagged key is never counted as exhausted or dead', () => {
  const p = mkPool(1);
  p.report('k0', hold);
  const snap = p.healthSnapshot();
  assert.equal(snap.exhaustedKeys, 0);
  assert.equal(snap.deadKeys, 0);
  assert.equal(snap.flaggedKeys, 1);
});

test('borrowKey never hands out a key inside its cooldown', () => {
  const p = mkPool(2);
  p.report('k0', hold);
  for (let i = 0; i < 10; i++) assert.equal(p.borrowKey().key, 'k1');
});

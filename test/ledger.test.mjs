import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLedger } from '../src/ledger.mjs';

test('ledger fold: open + exhausted + set_balance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'th-ledger-'));
  const path = join(dir, 'ledger.jsonl');
  try {
    const L = createLedger(path);
    L.append({ type: 'open', keyFile: 'k1', email: 'a@b.c', balance: 5, source: 't' });
    L.append({ type: 'open', keyFile: 'k2', email: 'c@d.e', balance: null, source: 't' });
    L.append({ type: 'exhausted', keyFile: 'k1', email: 'a@b.c', source: 'gateway' });
    L.append({ type: 'set_balance', keyFile: 'k2', email: 'c@d.e', balance: 3.5, source: 'warm' });
    const f = L.fold();
    assert.equal(f.totalBalance, 3.5);
    assert.equal(f.activeKeys, 1);
    assert.equal(f.exhaustedKeys, 1);
    assert.equal(f.unknownBalanceKeys, 0);
    assert.equal(f.seq, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger seedFromPool only when empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'th-ledger-'));
  const path = join(dir, 'ledger.jsonl');
  try {
    const L = createLedger(path);
    const n = L.seedFromPool([
      { file: 'a', email: 'x', status: 'ok', balance: 5 },
      { file: 'b', email: 'y', status: 'exhausted', balance: 0, lastError: 'balance_zero' },
      { file: 'c', email: 'z', status: 'ok', balance: null },
    ]);
    assert.equal(n, 3);
    const f = L.fold();
    assert.equal(f.totalBalance, 5);
    assert.equal(f.activeKeys, 2);
    assert.equal(f.exhaustedKeys, 1);
    assert.equal(f.unknownBalanceKeys, 1);
    assert.equal(L.seedFromPool([{ file: 'd', status: 'ok', balance: 5 }]), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

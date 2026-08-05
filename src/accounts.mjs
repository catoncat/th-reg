// Append created accounts to a JSONL file (0600, gitignored).

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function appendAccount(file, record) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
}

export function printAccount(record) {
  // one JSON object per account on stdout (no secrets in proxy)
  const { proxy, ...safe } = record;
  console.log(JSON.stringify(safe));
}

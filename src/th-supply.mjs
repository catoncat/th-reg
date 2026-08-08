#!/usr/bin/env node
// Supply entry point — top the TokenHarbor pool up to a target balance.
//
//   node src/th-supply.mjs                 # top up to cfg.supplyTarget (default $200)
//   node src/th-supply.mjs --target 100    # custom target
//   node src/th-supply.mjs --dry           # measure only, register nothing
//
// Designed to run unattended from launchd; safe to run by hand any time.
// It only ever ADDS funded accounts and re-points the current key — it never
// deletes accounts and never touches the browser.

import { supply } from './supply.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
let targetUsd;
const ti = args.indexOf('--target');
if (ti >= 0) targetUsd = Number(args[ti + 1]);

// One account ≈ $5 welcome credit. Scale the per-run cap to the target so a
// $1000 top-up is not stuck at the old hard ceiling of 60 adds ($300).
const effectiveTarget = Number.isFinite(targetUsd) ? targetUsd : 1000;
const maxAdds = dry ? 0 : Math.min(400, Math.max(80, Math.ceil(effectiveTarget / 5) + 20));

const wi = args.indexOf('--workers');
const workers = wi >= 0 ? Number(args[wi + 1]) : undefined;

supply({
  targetUsd,
  maxAdds,
  workers,
  log: (m) => console.log(m),
})
  .then((r) => {
    console.log(`[supply] result: added=${r.added} total=$${r.total.toFixed(2)} funded=${r.funded}`);
  })
  .catch((e) => {
    console.error(`[supply] fatal: ${e.message}`);
    process.exit(1);
  });

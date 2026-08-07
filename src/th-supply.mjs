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

supply({
  targetUsd,
  maxAdds: dry ? 0 : 60,
  log: (m) => console.log(m),
})
  .then((r) => {
    console.log(`[supply] result: added=${r.added} total=$${r.total.toFixed(2)} funded=${r.funded}`);
  })
  .catch((e) => {
    console.error(`[supply] fatal: ${e.message}`);
    process.exit(1);
  });

// Global signup pacer.
//
// MEASURED 2026-08-11: tokenharbor's signup endpoint rate-limits ACROSS exit
// IPs. Three probe arms on three unrelated residential IPs entered and left the
// rejected state in lockstep, and a brand-new /24 gets rejected just as often as
// a reused one. The server tells us which wall we hit:
//
//   "You're doing that a bit fast — take a breath and try again."   -> shared bucket
//   "Too many sign-ups from this network. Please try again in an hour." -> per-network
//   "Your IP or email provider is not supported ..."                -> IP/domain reputation
//
// So concurrency does not buy signup throughput: only the pace of the *submit*
// step matters. Everything after signup (mail RTT, claim, key) is per-account and
// stays parallel. This module serializes just the submit step and adapts the gap
// AIMD-style: halve-ish on success, double on a shared-bucket rejection.

export function createSignupPacer({ minGapMs = 4000, startGapMs = 15000, maxGapMs = 240000, log = () => {} } = {}) {
  let gap = startGapMs;
  let nextAt = 0;
  let chain = Promise.resolve();
  const stats = { slots: 0, ok: 0, fast: 0, other: 0 };

  /** Reserve the next submit slot (FIFO across workers). Resolves when it's your turn. */
  function slot() {
    const run = chain.then(async () => {
      const now = Date.now();
      const waitMs = Math.max(0, nextAt - now);
      if (waitMs > 0) {
        log(`[pace] waiting ${(waitMs / 1000).toFixed(1)}s before signup (gap ${(gap / 1000).toFixed(1)}s)`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      nextAt = Date.now() + gap;
      stats.slots++;
    });
    chain = run.catch(() => {});
    return run;
  }

  /** Feed back the outcome class of a submit so the gap can adapt. */
  function report(klass) {
    if (klass === 'ok') {
      stats.ok++;
      gap = Math.max(minGapMs, Math.round(gap * 0.7));
    } else if (klass === 'rate_fast') {
      stats.fast++;
      gap = Math.min(maxGapMs, Math.round(gap * 2));
      // The shared bucket is empty right now; make the next slot wait a full gap
      // even if the previous reservation was already consumed.
      nextAt = Math.max(nextAt, Date.now() + gap);
      log(`[pace] shared bucket empty -> gap now ${(gap / 1000).toFixed(1)}s`);
    } else {
      stats.other++;
    }
  }

  return { slot, report, stats, get gapMs() { return gap; } };
}

/** No-op pacer for single-shot CLI runs. */
export function nullPacer() {
  return { slot: async () => {}, report: () => {}, stats: {}, gapMs: 0 };
}

// Local sell-price table for TokenHarbor metered models.
// Observed from transactions.meta (sell_in_per_1m / sell_out_per_1m).
// Gateway uses this to append consume events without re-querying wallets.

/** @type {Record<string, { in: number, out: number, cacheRead?: number, cacheWrite?: number }>} */
const PER_1M = {
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // fallbacks: prefer over-estimate (safe for supply) over silent $0
  default: { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

/**
 * @param {string} model
 * @param {{ prompt_tokens?: number, completion_tokens?: number, input_tokens?: number, output_tokens?: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number } | null} usage
 * @returns {number} USD cost ≥ 0
 */
export function estimateCostUsd(model, usage) {
  if (!usage) return 0;
  const rates = PER_1M[model] || PER_1M.default;
  const pin = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const pout = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens ?? 0) || 0;
  const cacheWrite = Number(usage.cache_creation_input_tokens ?? 0) || 0;
  const usd =
    (pin * rates.in +
      pout * rates.out +
      cacheRead * (rates.cacheRead ?? rates.in) +
      cacheWrite * (rates.cacheWrite ?? rates.in)) /
    1e6;
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  // 4 dp matches ledger round4; keep tiny calls visible (0.0002)
  return Math.round(usd * 10000) / 10000;
}

export function pricesFor(model) {
  return PER_1M[model] || PER_1M.default;
}

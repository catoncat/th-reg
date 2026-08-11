// Local sell-price table for TokenHarbor metered models.
//
// Source of truth: GET https://tokenharbor.ai/v1/models returns a `pricing`
// object per model ({input_usd_per_1m, output_usd_per_1m}). The table below was
// pulled from there on 2026-08-11 and should be refreshed the same way when the
// upstream catalogue changes.
//
// WHY THIS MATTERS (bug found 2026-08-11): until now only claude-opus-5 had a
// real rate and everything else fell through to `default` — i.e. opus prices.
// deepseek-v4-flash was billed at $5/$25 per 1M instead of $0.14/$0.28, a 36x
// overcharge on input and 89x on output, and `:free` models (which upstream
// never bills at all) were charged opus rates too. The gateway's soft ledger
// therefore drained keys that still had money and parked them as `exhausted`.

/** @type {Record<string, { in: number, out: number, cacheRead?: number, cacheWrite?: number }>} */
const PER_1M = {
  // free routes — upstream never bills these (rolling 7-day / campaign allowance)
  'deepseek-v4-flash:free': { in: 0, out: 0 },
  'mimo-v2.5:free': { in: 0, out: 0 },
  'kimi-k3:free': { in: 0, out: 0 },
  'th-orchestra': { in: 0, out: 0 },

  // paid routes (upstream sell prices)
  'claude-fable-5': { in: 10, out: 50 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'gpt-5.6-sol': { in: 5, out: 30 },
  'gpt-5.6-terra': { in: 2, out: 12 },
  'gpt-5.6-luna': { in: 0.1, out: 0.6 },
  'gemini-3.1-pro-preview': { in: 2, out: 12 },
  'gemini-3.6-flash': { in: 1.5, out: 7.5 },
  'kimi-k3': { in: 3, out: 15 },
  'qwen3.8-max': { in: 2, out: 6 },
  'grok-4.5': { in: 2, out: 6 },
  'glm-5.2': { in: 1.4, out: 4.4 },
  'minimax-m3': { in: 0.3, out: 1.2 },
  'mimo-v2.5-pro': { in: 0.435, out: 0.87 },
  'mimo-v2.5': { in: 0.14, out: 0.28 },
  'deepseek-v4-pro': { in: 0.435, out: 0.87 },
  'deepseek-v4-flash': { in: 0.14, out: 0.28 },

  // unknown model: keep over-estimating rather than silently booking $0
  default: { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

/**
 * @param {string} model
 * @param {{ prompt_tokens?: number, completion_tokens?: number, input_tokens?: number, output_tokens?: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number } | null} usage
 * @returns {number} USD cost ≥ 0
 */
export function estimateCostUsd(model, usage) {
  if (!usage) return 0;
  // Any `:free` route is never billed upstream, including ones added later that
  // are not in the table yet. Booking them would drain a key that never paid.
  if (typeof model === 'string' && model.endsWith(':free')) return 0;
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

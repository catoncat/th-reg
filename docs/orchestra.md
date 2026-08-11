# TH Orchestra (th-orchestra) — reverse-engineering notes (2026-08-11)

Findings from a live investigation of Token Harbor's smart-routing model
`th-orchestra`: how it routes, how the per-account pool configuration works
under the hood, and why we are **not** wiring it into the supply flow yet.
Everything below was verified against production (dashboard UI, Supabase REST,
billing ledger, and Token Harbor's own verification API).

## What th-orchestra is

A server-side router. A request to `model=th-orchestra` is classified per turn
and dispatched to a pool:

| Pool | Role key (DB) | When it fires | Admin default (2026-08-11) |
| --- | --- | --- | --- |
| Planner + Reviewer | `planner`, `reviewer` | Opening turn of a task, plan/outline, review pass | Claude Opus 5 |
| Coder (executor) | `coder` | fix / implement / refactor, UI, debugging, search — sticky per session | Claude Sonnet 5 |
| Summarizer | `summarizer` | Auto-compaction under context pressure | DeepSeek V4 Flash |
| Chat | — (see bug #1) | Turns with no `tools` array | MiMo V2.5 |

Critical classification fact: **every single-turn probe is an "opening turn" and
lands in the planner pool** — you cannot reach the coder pool without a
multi-turn conversation.

Observed upstreams (via `/api/verify`, below): planner resolved to
`claude-opus-4-8` and `claude-opus-5` on the same day — **routing drifts and
may use models outside the public catalog**. Both price at $5/$25 per 1M, so
cost-based inference cannot tell same-priced models apart; trust only
`/api/verify`.

## Ground-truth tool: the verify API (public, no auth)

```
GET https://tokenharbor.ai/api/verify/<completion_id>
→ { requested_model, upstream_model, task_type, tokens_in, tokens_out,
    ttfb_ms, cache_hit, ok, ... }
```

The completion id comes from any chat/completions response (`j.id`). The
dashboard "Request Logs → Verify ↗" links render the same data at
`/verify/<completion_id>`. **This is the judge for any routing experiment.**
Dashboard usage rows also show the classified role and a "thinking" marker.

## Per-account pool configuration

Entry point: `https://tokenharbor.ai/dashboard/orchestra` (login required) —
four `<select>`s, saved via a React Server Action.

Storage: Supabase table, reachable pure-protocol (no browser):

```
POST {SUPABASE_BASE}/rest/v1/user_orchestra_overrides
headers: apikey: <anon>, authorization: Bearer <account JWT>,
         content-type: application/json, Prefer: resolution=merge-duplicates
body: { "user_id": "<account uuid>", "role": "coder",
        "model_id": "alibaba-us/deepseek-v4-flash" }
```

Schema: `user_orchestra_overrides(user_id, role, model_id, byok_id, updated_at)`.
RLS requires passing `user_id` explicitly (= the JWT's uid).
Model ids use `vendor/model` form: `anthropic/claude-opus-5`,
`alibaba-us/deepseek-v4-flash`, `moonshot/kimi-k3`, `z-ai/glm-5.2`, …
Valid roles per the CHECK constraint: `planner`, `coder`, `summarizer`,
`reviewer`. Login/JWT via `th-api.mjs login()`; account uuid comes back as
`uid`.

## Two confirmed upstream bugs — why supply integration is ON HOLD

1. **The UI's Chat select can never save.** Dispatching it fires
   `["chat", "<model>"]` into the server action, which fails with
   `new row for relation "user_orchestra_overrides" violates check constraint
   "user_orchestra_overrides_role_check"` — `chat` is not an allowed role.
   Dead control in production UI.
2. **Overrides do not take effect.** We wrote `planner=deepseek-v4-flash`
   through *both* paths (direct REST upsert → 201, row present; and the
   official UI server action → 200). 12+ minutes later `/api/verify` still
   showed planner = `claude-opus-4-8`/`claude-opus-5` and billing stayed at
   the $5/$25 tier (a flash-routed call would be ~50x cheaper — unmistakable).
   Caveat: verified on **one trial-balance account**; paid accounts or unknown
   activation conditions might differ.

Until bug #2 is fixed (or an activation condition is found), writing overrides
from the supply flow would only create a false "configured" impression.
**Do not integrate yet.** Re-check procedure: run
`scripts/probe-ui-action.mjs <email> <password>`, then one
`th-orchestra` call + `/api/verify/<id>`; if `upstream_model` equals the
override, it works.

## Probe scripts (this repo)

| Script | Purpose |
| --- | --- |
| `scripts/probe-orchestra.mjs` | Login → dump /dashboard/orchestra page (pools, defaults, option values) |
| `scripts/probe-orchestra-save.mjs` / `probe-orchestra-save2.mjs` | Capture the save server action (URL, Next-Action id, body shape, response) |
| `scripts/probe-ui-action.mjs` | Change Planner via the real UI (server-action path) and capture the response |
| `scripts/probe-orchestra-verify.mjs` | Re-read the selects to check persistence |
| `scripts/probe-usage.mjs` / `probe-usage2.mjs` | Dump dashboard Request Logs rows (role, thinking marker, cost) |
| `scripts/probe-claim-gift.mjs` | Click the welcome-gift claim (did NOT credit — needs follow-up if ever used) |

All take `<email> <password>` from `data/accounts.jsonl` / `pure-verify.jsonl`
and drive Chrome via `src/browser.mjs` (visible window; closes itself).

## Billing reverse-engineering (secondary tool)

When `/api/verify` is not available: the local gateway log records actual
debited cost per request (`soft−X`), and
`cost × 1e6 ≈ tokens_in × price_in + tokens_out × price_out`. Fit against
`GET /v1/models` pricing to infer the upstream model **by price tier only** —
same-priced models (opus-4-8 vs opus-5) are indistinguishable this way.
Test accounts used in this investigation were restored (overrides deleted);
total experiment spend ≈ $0.06.

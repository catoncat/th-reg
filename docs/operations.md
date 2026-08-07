# Operations layer (reference)

Beyond the registration CLI, this repo contains a small **operations layer**
that turns a pool of Token Harbor accounts into a self-managing, funded API
backend. It grew out of real production needs, so it is kept here as
reference — the ideas are generic even if the paths default to this machine.

Everything here is **pure HTTP** (no browser), reads the same `data/accounts.jsonl`
the registrar writes, and talks to Token Harbor's public Supabase proxy for
balances.

## Modules

| Module | Role |
| --- | --- |
| `src/th-api.mjs` | Authoritative account queries: login → wallet / transactions / credit grants, and `probeKey` (key health). The one place the "what does this account actually have" question is answered. |
| `src/th.mjs` | Read-only CLI: `th pool status|usage|accounts`, `th supply status`, `th current`. Emits human tables or `--json`. Designed to be called by an agent, never prints credentials. |
| `src/supply.mjs` | **Auto-supply.** Keeps total pool balance ≥ a target by registering fresh accounts *before* the pool runs dry. |
| `src/th-supply.mjs` | Entry point for supply (launchd / cron / by hand). |
| `src/gateway.mjs` | Optional local OpenAI-compatible gateway that borrows a healthy key per request and retires+retries on hard failure **within the same request**. |
| `src/pool.mjs` | Key-pool state machine behind the gateway (active keys, retirement, persisted state). |
| `src/register-browser.mjs` | Browser-driven registration (agent-browser/CDP), an opt-in alternative to the pure-protocol engine. |

## First-principles design

### One account = one $5 credit; refill early, don't chase

A Token Harbor account is born with a $5 welcome grant, so it is **disposable**:
once spent it is abandoned, never nursed back. Because every account's balance
is readable over the API (`accountSnapshot`), the pool is refilled **early** —
when the total dips below target — instead of reacting to a failed request.
Refill is a steady background habit, not an emergency fix.

### A single "current key" pointer, never a rotation

The consumer (e.g. Pi) points at **one static key file** (`tokenharbor-current`).
Supply guarantees that file always holds a funded key. There is no round-robin,
no rotation, no gateway, no "retry on 403" — the pointer simply never points at
an empty account because a fresh one is registered before that can happen.

### Use one account to the dregs, then abandon it

`supply` does not hop to whichever account is richest. The current key stays on
its account until that account's balance falls below a low watermark
(`TH_SUPPLY_LOW_WATERMARK`, default `$1`); only then does it re-point to the
next best-funded account and register more.

### Hard failures are classified by API, never guessed

`probeKey` and the gateway share one failure taxonomy, learned from live
observations: Token Harbor returns **`403 code=balance_zero`** for an empty
wallet (not 402), `401` for a dead key, `429` for quota. Missing the
`balance_zero` mapping was the root cause of a real outage — exhausted keys
stayed marked "ok" and kept getting reused. The taxonomy is the contract.

## Paths & configuration

All local paths default to `~/.pi/agent/...` (the machine's Pi integration) but
are overridable through `loadConfig()` env vars — see `src/config.mjs`:

| Env | Default | Meaning |
| --- | --- | --- |
| `TH_SECRETS_DIR` | `~/.pi/agent/secrets` | where keys live |
| `TH_CURRENT_KEY_FILE` | `~/.pi/agent/secrets/tokenharbor-current` | the single current-key pointer |
| `TH_STATE_DIR` | `~/.pi/agent/state` | pool/gateway state |
| `TH_PLIST_PATH` | `~/Library/LaunchAgents/com.tokenharbor.supply.plist` | supply launchd plist (macOS) |
| `TH_SUPPLY_SERVICE` | `com.tokenharbor.supply` | launchd service name |
| `TH_SUPPLY_TARGET` | `200` | pool target in USD |
| `TH_SUPPLY_LOW_WATERMARK` | `1.0` | re-point threshold in USD |

## Running

```bash
# measure the pool (no registration)
node src/th-supply.mjs --dry

# top up to $100
node src/th-supply.mjs --target 100

# query (read-only, --json for machines)
node src/th.mjs pool status
node src/th.mjs pool usage --json
node src/th.mjs pool accounts
node src/th.mjs supply status
node src/th.mjs current

# optional local gateway
node src/gateway.mjs        # localhost:8787/v1 (requires a running pool)
```

On macOS, `com.tokenharbor.supply.plist` schedules `th-supply.mjs --target 200`
every 30 minutes; the same idea ports to cron or a container.

## Notes

- The read-only CLI never prints credentials; it exposes account facts only.
- Nothing here bypasses CAPTCHA: accounts that hit `needCaptcha` are skipped.
- This is reference architecture, not a promised SLA — measure, adapt, reuse.

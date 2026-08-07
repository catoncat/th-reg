# tokenharbor-register

Pure-HTTP registration bot for [Token Harbor](https://tokenharbor.ai).

**No browser, no proxy required.** Token Harbor's signup is a React 19 server
action whose `$ACTION_KEY` is published in the page HTML — so the whole flow is
reproducible with `curl` + a cookie jar. A real mailbox is still required for
each account (the API returns `403 email_not_verified` until the verify link is
opened), but the `cloud-mail` CLI handles that.

## Flow (verified live)

```
GET /login?mode=signup            → parse $ACTION_KEY / $ACTION_1:0 / $ACTION_1:1
GET /api/auth/signup-precheck     → needCaptcha:false (true ⇒ skipped, no bypass)
POST signup server action (multipart)
  email / password / invite_code  → 303 /dashboard + Supabase session cookie
  / device_fingerprint / timezone
POST /api/me/send-verification-email → ask the app to send the mail
Poll mailbox for verify link      → https://tokenharbor.ai/verify-email?token=...
Open verify link                  → /dashboard?verify=success (API unlocked)
POST /api/welcome/claim           → $5 welcome grant credited
POST /api/me/privacy              → enable free-models tier (DeepSeek V4 Flash, MiMo V2.5)
POST /api/keys                    → plaintext full key (thk_live_...)
GET /rest/v1/wallets              → confirm balance from Supabase
```

> ⚠️ **Mail verification is mandatory.** Supabase writes `email_confirmed_at`
> seconds after signup, but Token Harbor ignores it — the API returns
> `403 email_not_verified` until the mailbox link is opened. A `TH_MAIL_MODE`
> of `none` produces locked accounts only.

## Requirements

- Node.js >= 20
- A catch-all mail domain you control (used as the account identity)
- A mailbox CLI that can retrieve messages for that domain
  (the [`mailbox-http-cli/`](mailbox-http-cli/README.md) adapter turns any
  HTTP mailbox API into the required contract)

Everything else is optional:
- DataImpulse residential proxy credentials (`--proxy sticky|rotate`)

## Quick start

```bash
cp .env.example .env.local     # set TH_FIXED_POOL + TH_INVITE_CODE
node src/cli.mjs --count 1
```

## Usage

```bash
node src/cli.mjs --count 1                          # single account, direct IP
node src/cli.mjs --count 6 --workers 2              # concurrent batch
node src/cli.mjs --count 2 --domain-mode pool       # fixed pool only
node src/cli.mjs --count 2 --proxy sticky           # per-account residential IP
node src/cli.mjs --count 2 --domain mail.example.com  # single-domain mode
```

| Option | Meaning |
| --- | --- |
| `--count N` | number of accounts (default 1) |
| `--workers N` | parallel workers |
| `--domain-mode dynamic\|pool\|single` | domain strategy (default `dynamic`) |
| `--domain D` | fixed single catch-all domain |
| `--proxy direct\|sticky\|rotate` | network mode (default `direct`) |
| `--invite-code CODE` | referral code |
| `--engine protocol\|browser` | registration engine (default `protocol`) |

Every account appends one JSON line to `data/accounts.jsonl` (0600) with
`email`, `password`, `status` (`created` / `verified` / `created-unverified` /
`captcha-required` / `failed`), `api_key`, `balance_trial`, `gift_claimed`,
`free_models_enabled`, `note`.

## Domain setup

Three strategies, all reading from `.env.local`:

- **pool** — round-robin over `TH_FIXED_POOL=a.com,b.com` (comma-separated).
  Only domains you know are catch-all.
- **dynamic** (default) — pool plus automatic top-up: when the batch needs
  more domains than `TH_DOMAIN_MAX_REUSE` accounts per domain, it creates
  fresh subdomains under `TH_DYNAMIC_ZONES` via Cloudflare Email Routing +
  a worker allowlist. Requires CF credentials via `envchain`
  (`CF_ENVCHAIN_SCOPE`, default `cf-migrate-target`) — without them it falls
  back to pool mode.
- **single** — one fixed domain (`--domain` / `TH_DOMAIN`).

No domains are hardcoded in the source.

## Mail verification

- `TH_MAIL_MODE=cloud-mail` (default): polls a mailbox CLI
  (`messages --email <addr> --limit N` → `{items:[...]}`) for the verify link.
- `TH_MAIL_MODE=none`: skip mail verification. Produces **API-locked** accounts
  (403 `email_not_verified`), only useful for account shells.

The [`mailbox-http-cli/`](mailbox-http-cli/README.md) directory is a
provider-neutral adapter that turns any HTTP mailbox API into the contract
the script expects.

## Proxy

`direct` is the default and works — signups pass from a plain IP. `sticky`
gives each account its own DataImpulse sticky IP
(`__<cc>;sessid.<id>`, port 10000–20000) for batches that want IP separation.
On proxied IPs a GET with a cookie jar before the POST satisfies the Vercel
security checkpoint (handled automatically).

## Guardrails

- **No CAPTCHA bypass.** If `signup-precheck` returns `needCaptcha:true`
  (Turnstile), the account is recorded `captcha-required` and skipped.
- `data/` and `.env.local` are gitignored; credentials never leave your box.
- Use only for accounts you are authorized to create, and respect the
  service's terms and rate limits. Verify links (when sent) expire in 24h.
- Turnstile demands are flaky on some IPs — a `captcha-required` account is
  expected occasionally in large batches, not an error.
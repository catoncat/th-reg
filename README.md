# tokenharbor-register

Pure-HTTP registration bot for [Token Harbor](https://tokenharbor.ai).

**No browser, no proxy, no mail service required.** Signup is a React 19
server action whose encrypted-looking fields are actually client-published
(the AES-128 `$ACTION_KEY` ships in the page HTML), so the whole flow is
reproducible with `curl` + a cookie jar. Email verification is skipped too:
on current signups Token Harbor auto-confirms the address (Supabase
`email_confirmed_at`, written seconds after signup) and never sends a verify
email — the mail step only exists as an optional fallback for edge cases.

## Flow (verified live, 2026-08-06)

```
GET /login?mode=signup            → parse $ACTION_KEY / $ACTION_1:0 / $ACTION_1:1
GET /api/auth/signup-precheck     → needCaptcha:false (true ⇒ skipped, no bypass)
POST signup server action (multipart)
  email / password / invite_code / device_fingerprint=<random UUID> / timezone
                                  → 303 /dashboard + Supabase session cookie
Supabase check (retry ×4)         → email_confirmed_at ⇒ account verified
  (fallback) mailbox provider     → open verify link if one was sent
POST /api/keys                    → plaintext full key (e.g. thk_live_…)
GET /dashboard                    → $5 gift confirmed
```

## Requirements

- Node.js >= 20
- A catch-all mail domain you control (used as the account identity; any
  domain that can receive mail to random local parts works — **the script does
  not need to read it** unless you enable the mail fallback)

Everything else is optional:
- `cloud-mail`-compatible CLI (mail verify fallback)
- DataImpulse residential proxy credentials (`--proxy sticky|rotate`)

## Quick start

```bash
cp .env.example .env.local     # set TH_FIXED_POOL (or TH_DOMAIN) + invite code
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
| `--no-verify` | skip the verification step |

Every account appends one JSON line to `data/accounts.jsonl` (0600) with
`email`, `password`, `sess_id`, `status` (`created` / `verified` /
`created-unverified` / `captcha-required` / `failed`), `invite_code`,
`api_key`, `gift_claimed`, `balance`, `note`.

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

- `TH_MAIL_MODE=none` (default): rely on Supabase auto-confirm. Fast, zero
  mail dependencies.
- `TH_MAIL_MODE=cloud-mail`: additionally poll a mailbox CLI
  (`messages --email <addr> --limit N` → `{items:[…]}`) for the verify link,
  used only when the account was not auto-confirmed. The
  [`mailbox-http-cli/`](mailbox-http-cli/README.md) directory is a
  provider-neutral adapter that turns any HTTP mailbox API into that contract.

## Proxy

`direct` is the default and works — signups pass from a plain residential/DC
IP. `sticky` gives each account its own DataImpulse sticky IP
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

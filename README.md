# tokenharbor-register

Token Harbor (`tokenharbor.ai`) account registration bot.

Architecture follows the [aihub-register](https://github.com/catoncat/aihub-register)
pattern (provider-neutral mailbox contract, batch CLI, JSONL account output) but
drives the signup through `agent-browser` (CDP) because Token Harbor's signup is a
Next.js **React 19 server action** with a Cloudflare **Turnstile** gate — the
encrypted `$ACTION_REF_1` bound-args field cannot be reproduced by a plain HTTP
client (verified: raw `curl` POST returns HTTP 500 `digest 182133037`).

## Verified protocol (2026-08-06, live)

| Step | Request | Result |
| --- | --- | --- |
| 1 | `GET /login?mode=signup` | SSR form with hidden `$ACTION_KEY`, `$ACTION_1:0` (action id `603c964e…df296`), `device_fingerprint`, `timezone` |
| 2 | `GET /api/auth/signup-precheck?fp=<fp>` | `{"needCaptcha":false}` on residential IP; `true` triggers Turnstile (sitekey `0x4AAAAAADBuC8Knz1EJZx9-`) |
| 3 | POST signup server action | → redirect to `/dashboard` (account created, **API locked**) |
| 4 | email from `verify@tokenharbor.ai` | "Verify your email to unlock API access", 24h link `https://tokenharbor.ai/verify-email?token=<base64>` |
| 5 | open verify link | → `/dashboard?verify=success` (API unlocked) |
| 6 | `/dashboard/api-keys` | create API key (optional post-step) |

Email verification is **required** for API access, which is why this bot consumes
the self-hosted [cloud-mail](https://github.com/catoncat/cloud-mail) receive-only
mailbox (catch-all domains) via its CLI:

```bash
cloud-mail messages --email th-xxxx@dogfood.0day3.com --limit 10
```

## Requirements

- Node.js >= 20
- `agent-browser` CLI (`npm i -g agent-browser && agent-browser install`)
- `cloud-mail` CLI from the `apps/intake` app of the cloud-mail monorepo
- DataImpulse residential proxy credentials at
  `~/.agents/skills/residential-proxy/.secrets/dataimpulse.env` (mode 600),
  or via `DIP_USERNAME` / `DIP_PASSWORD`

## Usage

```bash
cp .env.example .env.local   # edit domain / counts
node src/cli.mjs --count 1                    # single account
node src/cli.mjs --count 6 --workers 3        # concurrent batch
node src/cli.mjs --domain kada.cam --count 2  # pick another catch-all domain
```

Each account:
- gets its own `agent-browser` session and its own **DataImpulse sticky** proxy
  (`__<cc>;sessid.<id>`, port 10000–20000) so IPs are never shared
- uses a random catch-all address `th-<hex>@<domain>`
- is appended as one JSON line to `data/accounts.jsonl` (0600) with status
  `created` / `verified` / `created-unverified` / `captcha-required` / `failed`

No CAPTCHA bypass: if `signup-precheck` demands Turnstile the account is recorded
as `captcha-required` and skipped.

## Notes

- Use only for accounts you are authorized to create; respect the service's terms
  and rate limits.
- Verify-email links expire after 24 hours; `--no-verify` skips the mailbox step.
- The `mailbox-http-cli/` directory is the provider-neutral adapter from
  aihub-register and is kept for parity; the default mailbox backend is the
  cloud-mail CLI itself (output shape already matches the contract).

# register

Pure-HTTP account registration bot — no browser.

The target service's signup is a React 19 server action whose fields ship in
the page HTML, so the whole flow replays with `curl` + a cookie jar. After
signup the script verifies the email for real, claims the welcome grant,
enables free models, and creates an API key.

## You can't run this as-is

The code ships with **no domain pool and no mailbox credentials** — those are
yours to provide. To produce working (verified, funded) accounts you need:

1. **A catch-all mail domain you control** — used as the account identity
   (e.g. `mail.example.com`). Random addresses on it must receive mail.
2. **A mailbox backend** that can fetch that mail and expose it via a CLI
   answering `messages --email <addr> --limit N` with `{ "items": [...] }`.
   The [`mailbox-http-cli/`](mailbox-http-cli/README.md) adapter turns any
   HTTP mailbox API into that contract.
   A ready-made option is [**cloud-mail**](https://github.com/catoncat/cloud-mail),
   a self-hosted receive-only mail platform on Cloudflare (BYO domains, read
   codes / magic links from a UI, REST API, or CLI).
3. **Node.js >= 20**

Optional: DataImpulse residential proxy credentials (`--proxy sticky|rotate`).

> ⚠️ **Mail verification is not optional.** The API returns
> `403 email_not_verified` until the verify link in the email is opened.
> Without a real mailbox every account comes out API-locked. The service's
> own auto-confirm flag is written but means nothing.

## Quick start

```bash
cp .env.example .env.local
# edit .env.local: TH_FIXED_POOL=mail.example.com,mail2.example.com  (or TH_DOMAIN)
#                  TH_INVITE_CODE=...  (optional referral code)
node src/cli.mjs --count 1
```

## Config (`.env.local`)

| Key | Required | Meaning |
| --- | --- | --- |
| `TH_FIXED_POOL` | yes* | comma-separated catch-all domains, round-robin |
| `TH_DOMAIN` | yes* | fixed single domain (`--domain-mode single`) |
| `TH_DYNAMIC_ZONES` | no | parent zones to auto-create subdomains under (needs Cloudflare) |
| `TH_MAIL_MODE` | yes | `cloud-mail` (default) or `none` (locked accounts only) |
| `MAILBOX_CLI` | no | mailbox CLI binary (default `cloud-mail`) |
| `TH_INVITE_CODE` | no | referral code |
| `DIP_USERNAME`/`DIP_PASSWORD` | no | DataImpulse credentials, only for `--proxy sticky\|rotate` |

\* exactly one of `TH_FIXED_POOL` or `TH_DOMAIN` is required. Nothing is
hardcoded in the source.

## Usage

```bash
node src/cli.mjs --count 1                          # single account, direct IP
node src/cli.mjs --count 6 --workers 2              # concurrent batch
node src/cli.mjs --count 2 --domain-mode pool       # fixed pool only
node src/cli.mjs --count 2 --proxy sticky           # per-account residential IP
node src/cli.mjs --count 2 --domain mail.example.com  # single-domain mode
```

Output: one JSON line per account appended to `data/accounts.jsonl` (0600,
gitignored) — `email`, `password`, `status`, `api_key`, `balance_trial`,
`gift_claimed`, `free_models_enabled`, `note`.

## Notes

- **No CAPTCHA bypass.** Accounts that hit Turnstile are marked
  `captcha-required` and skipped.
- `direct` is the default network mode; no proxy needed unless you want
  per-account residential IPs.
- Use only for accounts you are authorized to create, and respect the
  service's terms and rate limits.
- This is a batch registration tool. It creates real accounts with real
  credentials — treat the output file as sensitive.

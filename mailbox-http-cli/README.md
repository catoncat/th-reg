# mailbox-http-cli

A small, provider-neutral adapter that exposes an HTTP mailbox API through a stable JSON command-line contract.

It is independent of the Qualcomm registration project and can be installed or copied into another tool that needs to poll a mailbox.

## Requirements

- Node.js 20 or newer.
- An HTTP mailbox API that can list messages for an email address.
- A domain configured to deliver those addresses to that API. Catch-all delivery is useful when callers generate random local parts.

## HTTP API contract

By default the CLI requests:

```http
GET /messages?email=user@example.com&limit=20
Accept: application/json
Authorization: Bearer <MAILBOX_HTTP_TOKEN>
```

The API may return either `items` or `messages`:

```json
{
  "items": [
    {
      "id": "unique-message-id",
      "received_at": "2026-01-01T00:00:00Z",
      "text_body": "plain text",
      "html_body": "<p>HTML</p>",
      "subject": "Optional",
      "from": "sender@example.com",
      "to": "user@example.com"
    }
  ]
}
```

For convenience, input fields may also be named `receivedAt`, `textBody`, and `htmlBody`. Every message must have a stable, unique `id` so callers can distinguish new mail from old mail without relying on clocks.

## Configuration

```bash
export MAILBOX_HTTP_BASE_URL='https://mail-api.example.com'
export MAILBOX_HTTP_TOKEN='replace-with-your-token'
```

Optional variables:

- `MAILBOX_HTTP_MESSAGES_PATH`: endpoint path, default `/messages`.
- `MAILBOX_HTTP_AUTH_HEADER`: authentication header, default `authorization`.
- `MAILBOX_HTTP_AUTH_SCHEME`: token prefix, default `Bearer`. Set it to an empty string for a raw token such as `x-api-key: <token>`.

Tokens are accepted only through environment variables, not command-line flags, to reduce accidental shell-history and process-list exposure.

## Run

Directly from this repository:

```bash
./bin/mailbox-http.mjs messages --email user@example.com --limit 20
```

Or install/link the package to expose `mailbox-http`:

```bash
npm link
mailbox-http messages --email user@example.com --limit 20
```

On success, stdout contains exactly one JSON object with an `items` array. Errors go to stderr and return a nonzero exit code. Upstream response bodies and credentials are not printed.

## Adapting another service

If an existing service does not expose the expected endpoint or field names, implement the same downstream CLI contract instead of adding service-specific code to the consumer:

```bash
custom-mailbox messages --email user@example.com --limit 20
```

```json
{"items":[{"id":"m1","received_at":"...","text_body":"...","html_body":"..."}]}
```

This keeps provider credentials, SDKs, and mailbox-specific behavior outside the registration application.

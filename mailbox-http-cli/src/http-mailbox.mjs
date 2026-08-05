function normalizeMessage(message) {
  return {
    id: message.id,
    received_at: message.received_at ?? message.receivedAt ?? null,
    text_body: message.text_body ?? message.textBody ?? message.text ?? '',
    html_body: message.html_body ?? message.htmlBody ?? message.html ?? '',
    subject: message.subject ?? '',
    from: message.from ?? null,
    to: message.to ?? null,
  };
}

export class HttpMailbox {
  constructor({
    baseUrl,
    token,
    authHeader = 'authorization',
    authScheme = 'Bearer',
    messagesPath = '/messages',
    fetchImpl = globalThis.fetch,
  }) {
    if (!baseUrl) throw new Error('MAILBOX_HTTP_BASE_URL or --base-url is required');
    this.baseUrl = baseUrl;
    this.token = token;
    this.authHeader = authHeader;
    this.authScheme = authScheme;
    this.messagesPath = messagesPath;
    this.fetchImpl = fetchImpl;
  }

  async messages(email, limit = 20) {
    if (!email) throw new Error('--email is required');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('--limit must be an integer between 1 and 100');
    }

    const url = new URL(this.messagesPath, this.baseUrl);
    url.searchParams.set('email', email);
    url.searchParams.set('limit', String(limit));
    const headers = { accept: 'application/json' };
    if (this.token) {
      headers[this.authHeader] = this.authScheme
        ? `${this.authScheme} ${this.token}`
        : this.token;
    }

    const response = await this.fetchImpl(url, { headers });
    if (!response.ok) throw new Error(`Mailbox HTTP API failed with HTTP ${response.status}`);
    const body = await response.json();
    const items = body.items ?? body.messages;
    if (!Array.isArray(items)) throw new Error('Mailbox HTTP API response must contain an items array');
    if (items.some((message) => !message?.id)) throw new Error('Every mailbox message must contain an id');
    return { items: items.map(normalizeMessage) };
  }
}

// Mailbox polling via the cloud-mail CLI (provider-neutral contract):
//   <cli> messages --email <addr> --limit N  -> JSON { items: [...] }
// Each item carries text_body/html_body/subject/sender.
// Used to extract the Token Harbor verify-email activation link.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class Mailbox {
  constructor({ cli = 'cloud-mail' } = {}) {
    this.cli = cli;
  }

  async messages(email, limit = 10, timeoutMs = 20000) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { stdout } = await execFileAsync(this.cli, ['messages', '--email', email, '--limit', String(limit)], {
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
        });
        const data = JSON.parse(stdout);
        const items = data.items || [];
        if (!Array.isArray(items)) throw new Error('mailbox response missing items array');
        return items;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await sleep(1200); // transient TLS/reset — retry
      }
    }
    throw lastErr;
  }

  /** Poll until a verify link from Token Harbor appears, or timeout. */
  async waitForVerifyLink(email, { timeoutMs = 150000, intervalMs = 5000, log = () => {} } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastCount = 0;
    while (Date.now() < deadline) {
      let items = [];
      try {
        items = await this.messages(email, 10);
      } catch (err) {
        log(`[mailbox] poll error: ${err.message}`);
      }
      if (items.length > lastCount) log(`[mailbox] ${items.length} message(s) for ${email}`);
      lastCount = Math.max(lastCount, items.length);
      for (const item of items) {
        const link = extractVerifyLink(item);
        if (link) return { link, item };
      }
      await sleep(intervalMs);
    }
    throw new Error(`no Token Harbor verify email within ${Math.round(timeoutMs / 1000)}s for ${email}`);
  }
}

export function extractVerifyLink(item) {
  const body = [item.text_body, item.html_body].join('\n');
  // e.g. https://tokenharbor.ai/verify-email?token=<base64...>
  const m = body.match(/https:\/\/tokenharbor\.ai\/verify-email\?token=([A-Za-z0-9._~-]+)/);
  return m ? `https://tokenharbor.ai/verify-email?token=${m[1]}` : null;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Mail verification provider factory.
 *   'none' (default)       -> waitVerifyLink always resolves null; relies on
 *                             Supabase auto-confirm (email_confirmed_at).
 *   'cloud-mail' (optional)-> polls a cloud-mail CLI inbox for the verify link.
 * Anything else throws so misconfiguration is loud.
 */
export function createMailProvider(mode = 'none', { cli = 'cloud-mail' } = {}) {
  if (!mode || mode === 'none') {
    return {
      name: 'none',
      async waitVerifyLink() {
        return null;
      },
    };
  }
  if (mode === 'cloud-mail') {
    const mb = new Mailbox({ cli });
    return {
      name: 'cloud-mail',
      waitVerifyLink: (email, opts) => mb.waitForVerifyLink(email, opts),
    };
  }
  throw new Error(`unknown mailMode '${mode}' (expected 'none' | 'cloud-mail')`);
}

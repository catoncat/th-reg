// Thin wrapper around the agent-browser CLI (CDP-driven Chrome/Chromium).
// Each account gets its own isolated session id and its own sticky proxy
// so IPs and browser contexts are never shared between accounts.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sleep } from './mailbox.mjs';

const execFileAsync = promisify(execFile);

export class Browser {
  constructor({ session, proxyUrl, bin = 'agent-browser' }) {
    this.bin = bin;
    this.session = session;
    this.proxyUrl = proxyUrl;
  }

  async run(args, { timeoutMs = 120000, env = {} } = {}) {
    const { stdout, stderr } = await execFileAsync(
      this.bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          AGENT_BROWSER_SESSION: this.session,
          HTTP_PROXY: this.proxyUrl,
          HTTPS_PROXY: this.proxyUrl,
          ALL_PROXY: this.proxyUrl,
          NO_PROXY: 'localhost,127.0.0.1,::1',
          ...env,
        },
      }
    );
    return { stdout, stderr };
  }

  async open(url, opts) {
    await this.run(['open', url], opts);
  }

  async fill(selector, value) {
    await this.run(['fill', selector, value]);
  }

  async click(selector) {
    try {
      await this.run(['click', selector]);
    } catch {
      // fallback: click the first button containing the text
      await this.eval(
        `(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.includes(${JSON.stringify(selector)}));if(b){b.click();return 'ok'}return 'no-button'})()`
      );
    }
  }

  async eval(js) {
    const { stdout } = await this.run(['eval', js], { timeoutMs: 30000 });
    const s = stdout.trim();
    if (!s) return null;
    // agent-browser returns eval output double-JSON-encoded:
    // '"{\\"url\\":...}"' -> parse twice to reach the object.
    try {
      const once = JSON.parse(s);
      if (typeof once === 'string') return JSON.parse(once);
      return once;
    } catch {
      try {
        return JSON.parse(s);
      } catch {
        return s;
      }
    }
  }

  /** Wait until location.href matches a pattern, or timeout. */
  async waitForUrl(regex, { timeoutMs = 40000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const st = await this.state();
      if (st && typeof st === 'object' && regex.test(st.url || '')) return st;
      await sleep(1500);
    }
    throw new Error(`timeout waiting for URL matching ${regex}`);
  }

  async state() {
    const st = await this.eval(`JSON.stringify({url:location.href,title:document.title,body:document.body.innerText.slice(0,2000)})`);
    if (typeof st === 'string') {
      try {
        return JSON.parse(st);
      } catch {
        return { url: '', title: '', body: '' };
      }
    }
    return st;
  }
}

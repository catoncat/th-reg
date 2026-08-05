// Single-account registration flow for tokenharbor.ai.
//
// Steps (verified live 2026-08-06):
//   1. open /login?mode=signup (residential sticky IP)
//   2. fill email (catch-all on the cloud-mail domain) + password
//   3. submit the React 19 server-action form (Create account)
//   4. wait for /dashboard -> account created (API locked until verified)
//   5. poll cloud-mail for the verify-email link (24h expiry)
//   6. open the verify link -> /dashboard?verify=success (API unlocked)
//
// No CAPTCHA/Turnstile bypass: if the signup-precheck returns needCaptcha
// the account is marked `captcha-required` and skipped, not forced.

import { Browser } from './browser.mjs';
import { Mailbox, sleep } from './mailbox.mjs';
import { randomHex, stickyEndpoint } from './config.mjs';

export const SIGNUP_URL = 'https://tokenharbor.ai/login?mode=signup';
export const HOST = 'https://tokenharbor.ai';

export async function registerOne(cfg, { email, password, log = () => {} }) {
  const sessId = `th${randomHex(6)}`;
  const proxyUrl = stickyEndpoint(cfg, sessId);
  const browser = new Browser({ session: `th-reg-${sessId}`, proxyUrl });
  const mailbox = new Mailbox({ cli: cfg.mailboxCli });

  const result = {
    email,
    password,
    sess_id: sessId,
    proxy: maskProxy(proxyUrl),
    created_at: new Date().toISOString(),
    status: 'pending',
  };

  // 1. open the signup page (retry once on transient CF/network failures)
  await openWithRetry(browser, SIGNUP_URL, { timeoutMs: 90000 });
  await sleep(3500);
  let st = await browser.state();
  if (!st?.url?.includes('tokenharbor.ai')) {
    throw new Error(`page did not load tokenharbor (got ${st?.url || 'no url'})`);
  }

  // 2. fill the form
  await browser.fill('input[name="email"]', email);
  await browser.fill('input[name="password"]', password);
  const before = await browser.eval(
    `JSON.stringify({email:document.querySelector('input[name=email]')?.value||'',pw:document.querySelector('input[name=password]')?.value?.length||0,hasTurnstile:!!document.querySelector('[name=cf-turnstile-response]')})`
  );
  if (!before?.email) throw new Error('signup form did not render (email empty)');
  if (before.hasTurnstile) {
    result.status = 'captcha-required';
    result.note = 'signup-precheck requested Turnstile; not bypassed';
    return result;
  }

  // 3. submit
  await browser.click('button[type="submit"]');
  await sleep(2500);

  // 4. wait for dashboard (account created)
  let landed = false;
  try {
    const s = await browser.waitForUrl(/\/dashboard/, { timeoutMs: cfg.signupTimeout * 1000 });
    landed = true;
    result.dashboard_url = s.url;
    result.status = 'created';
    log(`[+] account created -> ${s.url}`);
  } catch {
    const s2 = await browser.state();
    const body = (s2?.body || '').slice(0, 300);
    result.note = `signup did not land on dashboard: ${body}`;
    log(`[!] signup did not land on dashboard: ${body}`);
    return result;
  }
  if (!landed) return result;

  // 5. poll mailbox for the verify email
  try {
    const { link } = await mailbox.waitForVerifyLink(email, {
      timeoutMs: cfg.mailTimeout * 1000,
      intervalMs: cfg.mailPollInterval * 1000,
      log,
    });
    result.verify_link = link;

    // 6. open the verify link (same session/sticky IP)
    await browser.open(link, { timeoutMs: 60000 });
    await sleep(3500);
    const vs = await browser.state();
    if (vs?.url?.includes('verify=success')) {
      result.status = 'verified';
      log(`[+] email verified -> ${vs.url}`);
    } else {
      result.status = 'created-unverified';
      result.note = `verify link opened but no verify=success (${vs?.url})`;
    }
  } catch (err) {
    result.status = 'created-unverified';
    result.note = `verify email not found: ${err.message}`;
    log(`[!] ${result.note}`);
  }

  return result;
}

function maskProxy(url) {
  return url.replace(/:\/\/[^@]+@/, '://***:***@');
}

async function openWithRetry(browser, url, opts, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      await browser.open(url, opts);
      return;
    } catch (err) {
      lastErr = err;
      await sleep(2000 * i);
    }
  }
  throw lastErr;
}

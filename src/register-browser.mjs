// ALTERNATIVE PATH — browser-driven registration (agent-browser + CDP).
//
// This is NOT the primary path and NOT a fallback. `register.mjs` (pure
// protocol) is the product; nothing in the main flow degrades into this file
// automatically. It exists only so a user can deliberately choose it:
//
//     node src/cli.mjs --engine browser --count 1
//
// Reasons you might pick it:
//   * the pure-protocol signup starts failing after an upstream change and you
//     need a working path today
//   * you want the exact click-path a human takes (e.g. to re-verify a claim)
//
// Costs: requires `agent-browser` installed, one Chrome per account, ~10x
// slower, and it must close every session or it leaks Chrome processes.
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
//
// NOTE: this path predates two facts learned later on the pure-protocol side —
// the $5 grant is claimed via POST /api/welcome/claim, and balances must be
// read from Supabase `wallets`. Here the gift is still clicked in the UI and
// `balance` is scraped from the page, which is why its records carry a
// scraped string rather than a numeric `balance_trial`.

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

  try {
  // 1. open the signup page (retry once on transient CF/network failures)
  await openWithRetry(browser, SIGNUP_URL, { timeoutMs: 90000 });
  await sleep(3500);
  let st = await browser.state();
  if (!st?.url?.includes('tokenharbor.ai')) {
    throw new Error(`page did not load tokenharbor (got ${st?.url || 'no url'})`);
  }

  // dismiss the cookie consent banner so it cannot cover the submit button
  await browser.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/essential only|accept analytics/i.test(x.innerText));if(b){b.click();return 'dismissed'}return 'none'})()`);
  await sleep(800);

  // 2. fill the form
  await browser.fill('input[name="email"]', email);
  await browser.fill('input[name="password"]', password);
  if (cfg.inviteCode) {
    try {
      await browser.fill('input[name="invite_code"]', cfg.inviteCode);
      result.invite_code = cfg.inviteCode;
    } catch {
      /* optional field may not be present */
    }
  }
  const before = await browser.eval(
    `JSON.stringify({email:document.querySelector('input[name=email]')?.value||'',pw:document.querySelector('input[name=password]')?.value?.length||0,hasTurnstile:!!document.querySelector('[name=cf-turnstile-response]')})`
  );
  if (!before?.email) throw new Error('signup form did not render (email empty)');
  if (before.hasTurnstile) {
    result.status = 'captcha-required';
    result.note = 'signup-precheck requested Turnstile; not bypassed';
    return result;
  }

  // 3. submit via form.requestSubmit() so the React 19 server action fires
  //    even if a floating layer would otherwise cover the submit button.
  await browser.eval(`(()=>{
    const emailInput=document.querySelector('input[name="email"]');
    const form=emailInput && emailInput.closest('form');
    if(form){form.requestSubmit();return 'requestSubmit'}
    const btn=[...document.querySelectorAll('button')].find(b=>b.type==='submit')||document.querySelector('button[type="submit"]');
    if(btn){btn.click();return 'button-click'}
    return 'no-form';
  })()`);
  await sleep(2500);

  // 4. wait for the dashboard. NOTE: the React 19 server action renders the
  //    dashboard content WITHOUT changing location.href (observed live: URL
  //    stays /login?mode=signup for >70s while the body becomes the
  //    dashboard). So we detect the dashboard by its body, not by URL.
  let landed = false;
  const deadline = Date.now() + cfg.signupTimeout * 1000;
  while (Date.now() < deadline) {
    let s = null;
    try { s = await browser.state(); } catch { /* keep polling */ }
    const body = (s?.body || '');
    const isDashboard = /BALANCE/.test(body) && /Overview/.test(body) && /API Key/.test(body);
    const stillSignup = /Create account|Sign up to|one time pin/i.test(body) && !/BALANCE/.test(body);
    if (isDashboard && !stillSignup) {
      landed = true;
      result.dashboard_url = s?.url || '';
      result.status = 'created';
      log(`[+] account created (dashboard body detected)`);
      break;
    }
    await sleep(1500);
  }
  if (!landed) {
    let s2 = null;
    try { s2 = await browser.state(); } catch {}
    const body = (s2?.body || '').slice(0, 300);
    result.note = `signup did not reach dashboard: ${body}`;
    log(`[!] signup did not reach dashboard: ${body}`);
    return result;
  }

  // 5. poll mailbox for the verify email
  try {
    const { link } = await mailbox.waitForVerifyLink(email, {
      timeoutMs: cfg.mailTimeout * 1000,
      intervalMs: cfg.mailPollInterval * 1000,
      log,
    });
    result.verify_link = link;

    // 6. open the verify link (same session/sticky IP)
    await openWithRetry(browser, link, { timeoutMs: 60000 });
    await sleep(3500);
    const vs = await browser.state().catch(() => null);
    const vBody = vs?.body || '';
    const vUrl = vs?.url || '';
    if (vUrl.includes('verify=success') || (/BALANCE/.test(vBody) && /Overview/.test(vBody))) {
      result.status = 'verified';
      log(`[+] email verified -> ${vUrl}`);
    } else {
      result.status = 'created-unverified';
      result.note = `verify link opened but dashboard not confirmed (${vUrl})`;
    }
  } catch (err) {
    result.status = 'created-unverified';
    result.note = `verify email not found: ${err.message}`;
    log(`[!] ${result.note}`);
  }

  // 7. post-register: claim the $5 gift, enable free models, create an API key.
  //    Best-effort: failures are recorded but do not undo the account.
  if (result.status === 'verified') {
    try {
      await postRegisterSetup(browser, result, log);
    } catch (err) {
      result.note = [result.note, `post-register: ${err.message}`].filter(Boolean).join(' | ');
      log(`[!] post-register partial: ${err.message}`);
    }
  }

  return result;
  } finally {
    // always close the per-account browser session, even on failure,
    // so batch runs do not leak Chrome instances
    await browser.close();
  }
}

/** Claim welcome gift, enable free models, create API key (same session). */
export async function postRegisterSetup(browser, result, log) {
  // claim $5 welcome gift: open the gift panel then press Claim
  await openWithRetry(browser, 'https://tokenharbor.ai/dashboard', { timeoutMs: 60000 });
  await sleep(2500);
  const claim = await browser.eval(`(()=>{
    const open=[...document.querySelectorAll('button')].find(b=>/gift to claim/i.test(b.innerText));
    if(!open) return {skipped:'no-gift'};
    open.click();
    return {opened:true};
  })()`);
  await sleep(2000);
  const claimed = await browser.eval(`(()=>{
    const c=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Claim');
    if(!c) return {claimed:false,reason:'no-claim-btn'};
    c.click();
    return {claimed:true};
  })()`);
  await sleep(3000);
  if (claimed?.claimed) { result.gift_claimed = true; log('[+] $5 gift claimed'); }

  // enable free models (no-op if already enabled / absent)
  await browser.eval(`(()=>{
    const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='Enable free models');
    if(b){b.click();return 'on'}
    return 'absent';
  })()`);
  await sleep(2000);
  result.free_models_enabled = true;
  log('[+] free models enabled');

  // create an API key on /dashboard/api-keys (full key shown once)
  await openWithRetry(browser, 'https://tokenharbor.ai/dashboard/api-keys', { timeoutMs: 60000 });
  await sleep(2500);
  await browser.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/new key/i.test(x.innerText));if(b)b.click();return 'ok'})()`);
  await sleep(1800);
  await browser.eval(`(()=>{
    const i=[...document.querySelectorAll('input')].find(x=>/cursor|production|side project/i.test(x.placeholder||''));
    if(!i) return 'no-input';
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(i,'bot-key');
    i.dispatchEvent(new Event('input',{bubbles:true}));
    const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='Create key');
    if(b) b.click();
    return 'created';
  })()`);
  await sleep(2500);
  // The full key is shown once in a <code> element. Its prefix is NOT fixed
  // (observed both `thk_live_A_…` and `thk_live_-…`); masked entries contain
  // `•`, so match the base64url body of an unmasked key only.
  const key = await browser.eval(`(()=>{
    const els=[...document.querySelectorAll('code')].map(e=>e.innerText.trim());
    return els.find(t=>/^thk_live_[A-Za-z0-9_-]{20,}$/.test(t)) || null;
  })()`);
  if (key) {
    result.api_key = key;
    log('[+] API key created');
  } else {
    log('[!] API key not captured');
  }

  // read the balance
  await openWithRetry(browser, 'https://tokenharbor.ai/dashboard', { timeoutMs: 60000 });
  await sleep(2000);
  const bal = await browser.eval(`(()=>{const t=document.body.innerText;const m=t.match(/\\$\\d+(?:\\.\\d+)?/);return m?m[0]:null})()`);
  if (bal) result.balance = bal;
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

/**
 * shoot-auth.mjs — screenshots of the actual pre-auth screens (login,
 * forgot-password, signup, multi-account picker) using the REAL,
 * unmodified src/app.js against a mock Supabase project URL (see
 * harness-auth.html) rather than the per-view shim harness.mjs/shim-*.mjs
 * use — those deliberately swap app.js OUT for a shim, so they can't render
 * app.js's own auth screens. This is the one place those screens get a
 * visual check before delivery.
 */
import { chromium } from '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';
import { startServer } from './server.mjs';
import fs from 'node:fs';

const PORT = 8935;
const MOCK_SUPABASE_URL = 'https://mock-project.supabase.co';

async function waitMounted(page) {
  await page.waitForFunction(() => window.__mockMounted === true, { timeout: 15000 });
  await page.waitForTimeout(150);
}

async function main() {
  fs.mkdirSync('mockups/out', { recursive: true });
  await startServer(PORT);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  const url = `http://localhost:${PORT}/mockups/harness-auth.html`;

  // 9a. Login — brief A1 ("Welcome back" centered, Student/Parent tabs gone)
  // + B1 (single phone-number field, "Your username is your phone number").
  await page.goto(url, { waitUntil: 'load' });
  await waitMounted(page);
  await page.screenshot({ path: 'mockups/out/9a-login.png', fullPage: true });
  console.log('wrote mockups/out/9a-login.png');

  // 9b. Forgot password — brief B2.
  await page.click('#go-forgot');
  await page.waitForSelector('#forgot-form');
  await page.screenshot({ path: 'mockups/out/9b-forgot-password.png', fullPage: true });
  console.log('wrote mockups/out/9b-forgot-password.png');

  // 9c. Signup — brief A2/C1.
  await page.click('#forgot-back');
  await page.waitForSelector('#login-form');
  await page.click('#go-signup');
  await page.waitForSelector('#signup-form');
  await page.screenshot({ path: 'mockups/out/9c-signup.png', fullPage: true });
  console.log('wrote mockups/out/9c-signup.png');

  // 9d. Multi-account picker — brief B1 ("if the phone number exists in TWO
  // OR MORE schools... prompt the user to select the correct account").
  // find_login_accounts_by_phone is intercepted (no real backend here) to
  // return two accounts, so the real renderAccountPicker() path renders.
  await page.click('#go-login');
  await page.waitForSelector('#login-form');
  await page.route(`${MOCK_SUPABASE_URL}/rest/v1/rpc/find_login_accounts_by_phone`, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { school_code: 'tumaini', school_name: 'Tumaini Junior School', role: 'admin', display_name: 'David Kinyua' },
        { school_code: 'greenhill', school_name: 'Greenhill Academy', role: 'teacher', display_name: 'David Kinyua' }
      ])
    });
  });
  await page.fill('#login-phone', '0712345678');
  await page.fill('#login-pw', 'testpassword');
  await page.click('#login-btn');
  await page.waitForSelector('.acct-list');
  await page.screenshot({ path: 'mockups/out/9d-account-picker.png', fullPage: true });
  console.log('wrote mockups/out/9d-account-picker.png');

  await browser.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

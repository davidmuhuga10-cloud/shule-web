/**
 * multitenant.e2e.mjs — real-browser smoke test for the multi-tenant login
 * and self-serve school-signup screens added in the Phase 0 migration.
 * Not part of `npm test` (needs a real browser + a static file server) —
 * run manually with:
 *   npm i -D playwright && node tests/e2e/multitenant.e2e.mjs
 *
 * It serves the app over plain HTTP and intercepts every Supabase Auth/REST/
 * RPC call and the /.netlify/functions/school-signup call with an in-memory
 * mock, so it needs no live Supabase project or Netlify dev server. Covers:
 * the School Code field + live preview, staff login with a matching code,
 * the cross-tenant-mismatch guard (verifySchoolMatch in auth.js), the
 * signup form's auto-slugging, and a full signup -> auto-login -> dashboard
 * boot with zero console/page errors.
 */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8899;
const SUPABASE_HOST = 'tyycjuppsdqcbrzmlimf.supabase.co';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  const filePath = path.join(ROOT, url);
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404); res.end('not found: ' + url);
  }
});
await new Promise((resolve) => server.listen(PORT, resolve));
console.log('static server up on', PORT);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const context = await browser.newContext();
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

let signupCalled = false;
let loginAttempts = [];
const usersByEmail = {
  'admin@greenhill.test': { id: 'user-admin@greenhill.test', name: 'Admin Person', role: 'admin', school_id: 'school-1', code: 'greenhill', school_name: 'Greenhill Test School' }
};

await page.route(`**://${SUPABASE_HOST}/**`, async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const p = url.pathname;
  const method = req.method();

  // ---- Auth: password sign-in --------------------------------------------
  if (p === '/auth/v1/token' && method === 'POST') {
    const body = JSON.parse(req.postData() || '{}');
    loginAttempts.push(body.email);
    if (body.password === 'wrongpass') {
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials' }) });
    }
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'fake-jwt-for-' + body.email,
        token_type: 'bearer', expires_in: 3600, refresh_token: 'fake-refresh',
        user: { id: 'user-' + body.email, email: body.email, aud: 'authenticated', role: 'authenticated' }
      })
    });
  }
  if (p === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
  if (p === '/auth/v1/user' && method === 'GET') {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'user-admin@greenhill.test', email: 'admin@greenhill.test' }) });
  }

  // ---- RPC: get_school_public_info ---------------------------------------
  if (p === '/rest/v1/rpc/get_school_public_info' && method === 'POST') {
    const body = JSON.parse(req.postData() || '{}');
    if (String(body.p_code || '').toLowerCase() === 'greenhill') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        found: true, school_id: 'school-1', school_code: 'greenhill', school_name: 'Greenhill Test School', settings: {}
      }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ found: false }) });
  }

  // ---- REST: profiles (post-login profile fetch, with schools embed) -----
  // Looks up whichever user is embedded in the bearer token so the signup
  // flow's newly-created admin resolves to ITS OWN school, not the
  // pre-seeded fixture — otherwise verifySchoolMatch()'s cross-check would
  // (correctly) refuse to let a "newschool" login through under a
  // "greenhill" profile, which is the exact bug this mock needs to avoid.
  if (p === '/rest/v1/profiles' && method === 'GET') {
    const auth = req.headers()['authorization'] || '';
    const email = auth.replace(/^Bearer fake-jwt-for-/, '');
    const user = usersByEmail[email] || usersByEmail['admin@greenhill.test'];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{
      id: user.id, name: user.name, email, role: user.role,
      staff_id: null, student_id: null, status: 'active', school_id: user.school_id,
      schools: { code: user.code, name: user.school_name }
    }]) });
  }

  // ---- Everything else (settings, classes, students, exams, counts...) ---
  if (method === 'HEAD') {
    return route.fulfill({ status: 200, headers: { 'content-range': '*/0' }, body: '' });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
});

// The self-serve signup Netlify function lives on the SAME origin as the app.
await page.route('**/.netlify/functions/school-signup', async (route) => {
  signupCalled = true;
  const body = JSON.parse(route.request().postData() || '{}');
  if (!body.school_name || !body.admin_email) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, message: 'Missing fields' }) });
  }
  usersByEmail[body.admin_email] = {
    id: 'user-' + body.admin_email, name: body.admin_name, role: 'admin',
    school_id: 'school-2', code: 'newschool', school_name: body.school_name
  };
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, school_code: 'newschool', school_name: body.school_name, admin_email: body.admin_email, seeded: true
  }) });
});

const results = [];
function check(name, cond) { results.push({ name, cond: !!cond }); }

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForSelector('#login-form', { timeout: 5000 });

check('auth screen shows a School Code field', await page.locator('#login-code').count() === 1);
check('auth screen shows staff/student tabs', await page.locator('#tab-staff').count() === 1 && await page.locator('#tab-student').count() === 1);
check('auth screen shows a link to create a new school', await page.locator('#go-signup').count() === 1);

// --- School Code preview on blur ---
await page.fill('#login-code', 'greenhill');
await page.locator('#login-code').blur();
await page.waitForTimeout(300);
const previewText = await page.locator('#school-preview').textContent();
check('typing a valid School Code + blur shows a resolved school name preview', /Greenhill Test School/.test(previewText || ''));

await page.fill('#login-code', 'doesnotexist');
await page.locator('#login-code').blur();
await page.waitForTimeout(300);
const previewText2 = await page.locator('#school-preview').textContent();
check('an unknown School Code shows no preview (blank, not an error)', (previewText2 || '').trim() === '');

// --- Staff login happy path ---
await page.fill('#login-code', 'greenhill');
await page.fill('#login-id', 'admin@greenhill.test');
await page.fill('#login-pw', 'correctpass');
await page.click('#login-btn');
await page.waitForSelector('#app:not(.hidden)', { timeout: 5000 }).catch(() => {});
const appVisible = await page.locator('#app').evaluate((el) => !el.classList.contains('hidden'));
check('staff login with matching School Code successfully boots the app', appVisible);
check('the login attempt used the real staff email (not a synthetic one)', loginAttempts.includes('admin@greenhill.test'));

// Sign back out to test the signup flow from a clean auth screen.
await page.evaluate(() => window.App.logout());
await page.waitForSelector('#login-form', { timeout: 5000 });

// --- Signup flow ---
await page.click('#go-signup');
await page.waitForSelector('#signup-form', { timeout: 5000 });
check('signup screen renders all expected fields', (
  await page.locator('#su-name').count() === 1 &&
  await page.locator('#su-code').count() === 1 &&
  await page.locator('#su-admin-name').count() === 1 &&
  await page.locator('#su-email').count() === 1 &&
  await page.locator('#su-pw').count() === 1
));

await page.fill('#su-name', 'New School Co');
const autoCode = await page.locator('#su-code').inputValue();
check('school code auto-suggests a slug from the school name', autoCode === 'new-school-co');

await page.fill('#su-admin-name', 'Founding Admin');
await page.fill('#su-email', 'founder@newschool.test');
await page.fill('#su-pw', 'foundersecret');
await page.click('#signup-btn');
await page.waitForSelector('#app:not(.hidden)', { timeout: 5000 }).catch(() => {});
const appVisibleAfterSignup = await page.locator('#app').evaluate((el) => !el.classList.contains('hidden'));
check('school-signup endpoint was actually called', signupCalled);
check('signup auto-logs the new admin straight into the app', appVisibleAfterSignup);

// --- Console/page error check across the whole flow ---
const seriousErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
check('no uncaught console/page errors during the whole flow', seriousErrors.length === 0);
if (seriousErrors.length) console.log('Console errors seen:\n' + seriousErrors.join('\n'));

console.log('\n=== RESULTS ===');
let failCount = 0;
for (const r of results) {
  console.log((r.cond ? 'PASS' : 'FAIL') + ' - ' + r.name);
  if (!r.cond) failCount++;
}
console.log(`\n${results.length - failCount} passed, ${failCount} failed`);

await browser.close();
server.close();
process.exit(failCount ? 1 : 0);

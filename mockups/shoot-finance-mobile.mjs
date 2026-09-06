/**
 * shoot-finance-mobile.mjs — screenshot pass over the Finance module at a
 * mobile viewport (375x812, iPhone-ish), plus a couple of desktop shots as a
 * quick regression sanity check. Same harness/shim pattern as shoot.mjs —
 * real, unmodified src/views/finance*.mjs rendered against the shimmed
 * Db/app.js in this folder (see shim-db.mjs's Finance fixtures block).
 */
import { chromium } from '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';
import { startServer } from './server.mjs';
import fs from 'node:fs';

const PORT = 8936;
const OUT = 'mockups/out/finance-mobile';

async function waitMounted(page) {
  await page.waitForFunction(() => window.__mockMounted === true, { timeout: 15000 });
  await page.waitForTimeout(200);
}

async function shoot(page, url, outfile, opts) {
  opts = opts || {};
  await page.goto(url, { waitUntil: 'load' });
  await waitMounted(page);
  if (opts.after) await opts.after(page);
  await page.screenshot({ path: outfile, fullPage: true });
  console.log('wrote', outfile);
}

// Clicks a Finance top-nav tab by its visible label (the sidebar is a
// slide-out drawer on mobile — opens it, clicks the tab, which itself calls
// toggleFinNav(false) to close the drawer again, same as a real tap would).
async function gotoFinTab(page, label, opts) {
  opts = opts || {};
  const url = `http://localhost:${PORT}/mockups/harness.html?view=finance&route=finance`;
  await page.goto(url, { waitUntil: 'load' });
  await waitMounted(page);
  if (opts.openDrawerFirst) {
    await page.click('#fin-menu-toggle');
    await page.waitForTimeout(200);
  }
  if (label !== 'Dashboard') {
    await page.click('#fin-menu-toggle');
    await page.waitForTimeout(150);
    await page.click(`.fin-side-nav a[data-tab]:has-text("${label}")`);
    await page.waitForTimeout(250);
  }
}

async function subtab(page, label) {
  await page.click(`.fin-tabs button:has-text("${label}")`);
  await page.waitForTimeout(200);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await startServer(PORT);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  // ------------------------------------------------------------- MOBILE ---
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });

  // 0. Mobile drawer itself — closed state (default landing) and the open
  // slide-out drawer + scrim, to check for dead space / overlap.
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=finance&route=finance`, `${OUT}/00-dashboard-drawer-closed.png`);
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=finance&route=finance`, `${OUT}/00b-drawer-open.png`, {
    after: async (p) => { await p.click('#fin-menu-toggle'); await p.waitForTimeout(250); }
  });

  // 1. Dashboard (already the landing tab).
  await gotoFinTab(page, 'Dashboard');
  await page.screenshot({ path: `${OUT}/01-dashboard.png`, fullPage: true });

  // 2. Collections — list, then Record Payment modal, then Payment in Kind
  // and Bursary modes specifically.
  await gotoFinTab(page, 'Collections');
  await page.screenshot({ path: `${OUT}/02a-collections-list.png`, fullPage: true });
  await page.click('#fc-record');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/02b-collections-record-modal.png`, fullPage: true });
  await page.selectOption('#rc-mode', 'kind');
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/02c-collections-record-kind.png`, fullPage: true });
  await page.selectOption('#rc-mode', 'bursary');
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/02d-collections-record-bursary.png`, fullPage: true });

  // 3. Invoicing — Fee Structures list + Add Fee Structure modal.
  await gotoFinTab(page, 'Invoicing');
  await page.screenshot({ path: `${OUT}/03a-invoicing-structures.png`, fullPage: true });
  await page.click('#fi-add-structure');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/03b-invoicing-add-structure-modal.png`, fullPage: true });

  // 4. Expenses / Payment Vouchers.
  await gotoFinTab(page, 'Expenses');
  await page.screenshot({ path: `${OUT}/04-expenses-vouchers.png`, fullPage: true });

  // 5. Accounting — 3 sub-tabs.
  await gotoFinTab(page, 'Accounting');
  await page.screenshot({ path: `${OUT}/05a-accounting-types.png`, fullPage: true });
  await subtab(page, 'Vote Heads');
  await page.screenshot({ path: `${OUT}/05b-accounting-voteheads.png`, fullPage: true });
  await subtab(page, 'Bank Accounts');
  await page.screenshot({ path: `${OUT}/05c-accounting-accounts.png`, fullPage: true });

  // 6. Payroll — 4 sub-tabs.
  await gotoFinTab(page, 'Payroll');
  await page.screenshot({ path: `${OUT}/06a-payroll-setup.png`, fullPage: true });
  await subtab(page, 'Run Payroll');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/06b-payroll-run.png`, fullPage: true });
  await subtab(page, 'History');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/06c-payroll-history.png`, fullPage: true });
  await subtab(page, 'Reports');
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/06d-payroll-reports.png`, fullPage: true });

  // 7. Inventory — Dashboard, Items, Movements, Setup.
  await gotoFinTab(page, 'Inventory');
  await page.screenshot({ path: `${OUT}/07a-inventory-dashboard.png`, fullPage: true });
  await subtab(page, 'Items');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/07b-inventory-items.png`, fullPage: true });
  await subtab(page, 'Movements');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/07c-inventory-movements.png`, fullPage: true });
  await subtab(page, 'Setup');
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/07d-inventory-setup.png`, fullPage: true });

  // 8. Transport — Routes, Invoicing, Reports.
  await gotoFinTab(page, 'Transport');
  await page.screenshot({ path: `${OUT}/08a-transport-routes.png`, fullPage: true });
  await subtab(page, 'Invoicing');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/08b-transport-invoicing.png`, fullPage: true });
  await subtab(page, 'Reports');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/08c-transport-reports.png`, fullPage: true });

  // 9. Reports — Balances, Cashbook, Vote Head Collections, Trial Balance,
  // Opening Balances.
  await gotoFinTab(page, 'Reports');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/09a-reports-balances.png`, fullPage: true });
  await subtab(page, 'Vote Head Balances');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/09b-reports-votehead.png`, fullPage: true });
  await subtab(page, 'Cashbook');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/09c-reports-cashbook.png`, fullPage: true });
  await subtab(page, 'Trial Balance');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/09d-reports-trial.png`, fullPage: true });
  await subtab(page, 'Opening Balances');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/09e-reports-opening-balances.png`, fullPage: true });

  // 10. Student profile — search a student, open their statement.
  await gotoFinTab(page, 'Dashboard'); // any tab with the header search box
  await page.fill('#fin-search-q', 'Faith');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/10a-student-search-results.png`, fullPage: true });
  await page.click('.search-hit[data-id]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/10b-student-profile.png`, fullPage: true });
  await page.click('.fin-tabs button:has-text("Statement")');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/10c-student-statement.png`, fullPage: true });

  await page.close();

  // ------------------------------------------------------------ DESKTOP ---
  const dpage = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  await shoot(dpage, `http://localhost:${PORT}/mockups/harness.html?view=finance&route=finance`, `${OUT}/d1-dashboard-desktop.png`);
  await dpage.click('.fin-side-nav a[data-tab]:has-text("Collections")');
  await dpage.waitForTimeout(250);
  await dpage.screenshot({ path: `${OUT}/d2-collections-desktop.png`, fullPage: true });
  await dpage.click('.fin-side-nav a[data-tab]:has-text("Inventory")');
  await dpage.waitForTimeout(250);
  await dpage.screenshot({ path: `${OUT}/d3-inventory-desktop.png`, fullPage: true });
  await dpage.close();

  await browser.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

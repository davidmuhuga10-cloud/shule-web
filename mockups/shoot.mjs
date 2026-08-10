import { chromium } from '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';
import { startServer } from './server.mjs';
import fs from 'node:fs';

const PORT = 8934;
const EXAM_ID = 'exam-1', CLASS_ID = 'class-8', REPORT_STUDENT_ID = 'stu-1002';

async function waitMounted(page) {
  await page.waitForFunction(() => window.__mockMounted === true, { timeout: 15000 });
  await page.waitForTimeout(150);
}

async function shoot(page, url, outfile, opts) {
  opts = opts || {};
  await page.goto(url, { waitUntil: 'load' });
  await waitMounted(page);
  if (opts.after) await opts.after(page);
  await page.screenshot({ path: outfile, fullPage: true });
  console.log('wrote', outfile);
}

async function main() {
  fs.mkdirSync('mockups/out', { recursive: true });
  await startServer(PORT);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  // 1. Dashboard — desktop layout fix (2x2 tiles beside the gender panel, no dead gutter).
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=dashboard&route=dashboard`, 'mockups/out/1-dashboard.png');

  // 1b/1c/1d. Classes & Streams — Edit/Delete are now labelled buttons
  // (not icons), and the class -> streams -> subjects drill-down now shows
  // "Manage Subjects & Teachers" as a real centered button instead of a
  // plain text link, with a labelled red Delete button next to it.
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=classes&route=classes`, 'mockups/out/1b-classes-list.png');
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=classes&route=classes`, 'mockups/out/1c-classes-streams.png', {
    after: async (p) => { await p.click('[data-open="class-8"]'); await p.waitForTimeout(200); }
  });
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=classes&route=classes`, 'mockups/out/1d-classes-stream-subjects.png', {
    after: async (p) => {
      await p.click('[data-open="class-8"]'); await p.waitForTimeout(200);
      await p.click('.stream-row'); await p.waitForTimeout(200);
    }
  });

  // 2. Staff — Teachers + Staff merged into one module with two tabs (brief
  // E1). Teachers is the default/active tab; 2b clicks over to Staff, which
  // still has the reset-password/enable-disable icon actions.
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=staffTeachers&route=staff-teachers`, 'mockups/out/2a-staff-teachers-tab.png');
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=staffTeachers&route=staff-teachers`, 'mockups/out/2b-staff-staff-tab.png', {
    after: async (p) => { await p.click('.staff-teachers-tabs [data-tab="staff"]'); await p.waitForTimeout(150); }
  });

  // 3. Mark List — Zeraki-style bordered grid. Wider viewport + a one-off
  // "don't clip the content column" style override (harness-only, not a
  // real CSS change) so the full grid — including the SBJ/TT MKS/PL/position
  // columns off to the right — fits in a single screenshot for review,
  // instead of being scrolled off inside the normal 1200px .content column.
  await page.setViewportSize({ width: 2300, height: 950 });
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=broadsheet&route=broadsheet`, 'mockups/out/3-marklist.png', {
    after: async (p) => {
      await p.addStyleTag({ content: '.content{max-width:none!important} .table-wrap{overflow:visible!important}' });
      await p.selectOption('#bs-exam', EXAM_ID);
      await p.selectOption('#bs-class', CLASS_ID);
      await p.waitForTimeout(400); // refreshStreams() + reload() are async
      await p.waitForSelector('.mark-list-grid');
    }
  });
  await page.setViewportSize({ width: 1440, height: 950 });

  // 3b. Class List — new bordered print grid + 3-column header (logo left,
  // school name centered with report title below, address right), same
  // standard as the Mark List (feature brief §2 — requires screenshot
  // review before deploy).
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=classList&route=class-list`, 'mockups/out/3b-classlist.png', {
    after: async (p) => {
      await p.selectOption('#cl-class', CLASS_ID);
      await p.waitForTimeout(300);
      await p.waitForSelector('.print-grid');
    }
  });

  // 3c. Score Sheet — new report (feature brief §9.2): Grade/Stream/Learning
  // Area/Strand/Sub Strand/Indicator filters, then a blank printable roster.
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=scoreSheet&route=score-sheet`, 'mockups/out/3c-scoresheet.png', {
    after: async (p) => {
      await p.selectOption('#ss-class', CLASS_ID);
      await p.selectOption('#ss-subject', 'sub-mat');
      await p.fill('#ss-strand', 'Numbers');
      await p.fill('#ss-substrand', 'Fractions');
      await p.click('#ss-generate');
      await p.waitForTimeout(300);
      await p.waitForSelector('.print-grid');
    }
  });

  // 3d. Exam Analysis — new report (feature brief §7): top students +
  // class grade summary + learning area statistics, built from getBroadsheet().
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=examAnalysis&route=exam-analysis`, 'mockups/out/3d-examanalysis.png', {
    after: async (p) => {
      await p.selectOption('#ea-exam', EXAM_ID);
      await p.selectOption('#ea-class', CLASS_ID);
      await p.waitForTimeout(400);
      await p.waitForSelector('.print-grid');
    }
  });

  // 2c. Staff tab — teachers no longer duplicated here (feature brief §9.1
  // bug fix): only non-teacher staff (Bursar, Support Staff) should appear.
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=staff&route=staff-teachers`, 'mockups/out/2c-staff-dedup.png');

  // 3e. Missing contact info blocks printing (feature brief §3).
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=classList&route=class-list&missingContact=1`, 'mockups/out/3e-missing-contact-info.png', {
    after: async (p) => { await p.selectOption('#cl-class', CLASS_ID); await p.waitForTimeout(300); }
  });

  // 4. Report Form — Zeraki-style single report form (school header, title
  // bar, avatar + chart, 5 summary boxes, learning-area grid w/ Dev/Teacher).
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=reportForms&route=reports`, 'mockups/out/4-reportform.png', {
    after: async (p) => {
      await p.selectOption('#rf-exam', EXAM_ID);
      await p.selectOption('#rf-class', CLASS_ID);
      await p.waitForTimeout(400); // refreshStudents() populates #rf-student
      await p.selectOption('#rf-student', REPORT_STUDENT_ID);
      await p.waitForTimeout(400); // tryLoad()
      await p.waitForSelector('.report');
    }
  });

  // 5. Exams hub — flat sidebar "Exams" entry now lands on an icon grid
  // instead of a nested sidebar dropdown.
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=examsHub&route=exams-hub`, 'mockups/out/5-exams-hub.png');

  // 6. Reports hub — same idea for "Reports".
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=reportsHub&route=reports-hub`, 'mockups/out/6-reports-hub.png');

  // 7. Settings — consolidated School Settings + User Accounts (admin-only,
  // grant/revoke) + Academic Years & Terms behind one flat sidebar entry,
  // switched via a top tab bar instead of 3 separate sidebar items.
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=settings&route=settings`, 'mockups/out/7a-settings-profile.png');
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=settings&route=settings`, 'mockups/out/7b-settings-users.png', {
    after: async (p) => { await p.click('[data-tab="users"]'); await p.waitForTimeout(150); }
  });
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=settings&route=settings`, 'mockups/out/7c-settings-calendar.png', {
    after: async (p) => { await p.click('[data-tab="calendar"]'); await p.waitForTimeout(150); }
  });

  // 8. Messaging — brief G1 (exam/term results, personalized per guardian)
  // and G2 (placeholder "Buy Bulk SMS" tab).
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=messaging&route=messaging`, 'mockups/out/8a-messaging-compose.png');
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=messaging&route=messaging`, 'mockups/out/8b-messaging-results.png', {
    after: async (p) => { await p.selectOption('#msg-scope', 'exam_results'); await p.waitForTimeout(150); }
  });
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=messaging&route=messaging`, 'mockups/out/8c-messaging-buy-sms.png', {
    after: async (p) => { await p.click('[data-tab="buy-sms"]'); await p.waitForTimeout(150); }
  });

  // 9. Exam Desk — Round 2 §7/§8: board shows the renamed/reordered row
  // actions ("✅ Review and Publish" for not_started, unchanged "📝 Continue
  // marks entry" for in_progress, full post-publish action set for
  // published), and editing an exam opens the newly-approved class-selection
  // card grid (grouped by CBC level, search + Select all/Clear, a locked
  // card for the class that already has marks recorded).
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=examDesk&route=exam-desk`, 'mockups/out/9a-examdesk-board.png');
  await page.setViewportSize({ width: 1000, height: 1400 }); // tall enough that the modal's own 90vh cap doesn't force internal scrolling for this shot
  await shoot(page, `http://localhost:${PORT}/mockups/harness.html?view=examDesk&route=exam-desk`, 'mockups/out/9b-examdesk-class-selection.png', {
    after: async (p) => {
      await p.click('[data-edit-exam]'); await p.waitForTimeout(200);
      // Harness-only override so the review screenshot shows every level
      // group in one shot instead of needing to scroll — the real app
      // keeps the 360px internal scroll (see main.css's .ex-class-scroll).
      await p.addStyleTag({ content: '#ex-class-groups{max-height:none!important}' });
    }
  });
  await page.setViewportSize({ width: 1440, height: 950 });

  await browser.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

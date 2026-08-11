import { isContactInfoComplete, addressLines, printHeaderHtml, reportTitleBarHtml, missingContactInfoHtml } from '../src/lib/printHeader.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

function run() {
  // ---- isContactInfoComplete (feature brief §3: mandatory structured address) ----
  check('empty settings are incomplete', isContactInfoComplete({}) === false);
  check('missing just the town is still incomplete', isContactInfoComplete({ po_box: '100', postal_code: '00100', phone: '0712345678' }) === false);
  check('missing just the phone is still incomplete', isContactInfoComplete({ po_box: '100', postal_code: '00100', town: 'Nairobi' }) === false);
  check('all four structured fields present is complete', isContactInfoComplete({ po_box: '100', postal_code: '00100', town: 'Nairobi', phone: '0712345678' }) === true);
  check('whitespace-only fields still count as missing', isContactInfoComplete({ po_box: '  ', postal_code: '00100', town: 'Nairobi', phone: '0712345678' }) === false);
  check('logo is NOT required for completeness', isContactInfoComplete({ po_box: '100', postal_code: '00100', town: 'Nairobi', phone: '0712345678', logo: '' }) === true);

  // ---- addressLines ----
  const lines = addressLines({ po_box: '100', postal_code: '00100', town: 'Nairobi', phone: '0712345678', email: 'info@school.ac.ke' });
  check('addressLines combines P.O. Box + postal code on one line', lines[0] === 'P.O. Box 100-00100, Nairobi');
  check('addressLines includes phone as its own line', lines[1] === '0712345678');
  check('addressLines includes email as its own line', lines[2] === 'info@school.ac.ke');
  check('addressLines omits lines for unset fields', addressLines({ school_name: 'X' }).length === 0);

  // ---- printHeaderHtml ----
  const html = printHeaderHtml({ school_name: 'Tumaini Junior School', po_box: '245', postal_code: '00100', town: 'Nakuru', phone: '0712345678' });
  check('printHeaderHtml includes the school name', html.includes('Tumaini Junior School'));
  check('printHeaderHtml shows a logo placeholder when no logo is set', html.includes('logo-placeholder'));
  const withLogo = printHeaderHtml({ school_name: 'X', logo: 'data:image/png;base64,abc' });
  check('printHeaderHtml renders an <img> when a logo is set', withLogo.includes('<img') && withLogo.includes('data:image/png;base64,abc'));
  check('printHeaderHtml escapes HTML in the school name', printHeaderHtml({ school_name: '<script>x</script>' }).indexOf('<script>') === -1);

  // ---- reportTitleBarHtml (Round 5 §2/§3: the shared "green rectangle"
  // title bar every printable report now uses under its header) ----
  const bar = reportTitleBarHtml('Class List — Grade 8');
  check('reportTitleBarHtml includes the title', bar.includes('Class List — Grade 8'));
  check('reportTitleBarHtml uses the shared ph-title-bar class', bar.includes('ph-title-bar'));
  check('reportTitleBarHtml escapes HTML in the title', reportTitleBarHtml('<script>x</script>').indexOf('<script>') === -1);
  check('reportTitleBarHtml renders nothing for an empty title', reportTitleBarHtml('') === '');

  // ---- missingContactInfoHtml ----
  const blocked = missingContactInfoHtml();
  check('missingContactInfoHtml includes a call-to-action to go to Settings', blocked.includes('data-goto-settings'));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();

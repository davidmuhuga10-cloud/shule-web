/**
 * amountInWords.mjs — "amount in words" line on the A5 receipt (brief
 * §Collections reference image: "student, payment info, vote-head
 * breakdown, balance, amount in words"). Pure, no DOM — kept separate so
 * it's trivially unit-testable, same convention as every other lib module
 * in this app.
 */
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function threeDigits(n) {
  let out = '';
  if (n >= 100) { out += ONES[Math.floor(n / 100)] + ' Hundred'; n %= 100; if (n) out += ' '; }
  if (n >= 20) { out += TENS[Math.floor(n / 10)]; if (n % 10) out += '-' + ONES[n % 10]; }
  else if (n > 0) { out += ONES[n]; }
  return out;
}

/** Whole non-negative integer -> English words (e.g. 12450 -> "Twelve
 *  Thousand Four Hundred And Fifty"). Kenyan schools use whole-shilling
 *  receipts, so amounts are rounded to the nearest shilling before
 *  wording — cents are not spelled out. */
export function numberToWords(n) {
  n = Math.round(Math.abs(Number(n) || 0));
  if (n === 0) return 'Zero';
  const parts = [];
  const millions = Math.floor(n / 1000000);
  const thousands = Math.floor((n % 1000000) / 1000);
  const rest = n % 1000;
  if (millions) parts.push(threeDigits(millions) + ' Million');
  if (thousands) parts.push(threeDigits(thousands) + ' Thousand');
  if (rest) {
    if (parts.length) parts.push('And');
    parts.push(threeDigits(rest));
  }
  return parts.join(' ');
}

/** Full receipt line — "Two Thousand Shillings Only" — currency code is
 *  configurable (settings.currency, defaulting to KES-style "Shillings")
 *  since a school outside Kenya could relabel it. */
export function amountInWords(amount, currencyWord) {
  const word = currencyWord || 'Shillings';
  return `${numberToWords(amount)} ${word} Only`;
}

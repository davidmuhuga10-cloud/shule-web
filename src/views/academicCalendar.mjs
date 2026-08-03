import { esc, options, modal, closeModal, toast, confirmAction } from '../app.js';
import { Db } from '../lib/api/index.mjs';

function yearOptions(selected) {
  const now = new Date().getFullYear();
  const years = [];
  for (let y = now - 1; y <= now + 4; y++) years.push(y);
  return years.map((y) => `<option value="${y}"${String(y) === String(selected) ? ' selected' : ''}>${y}</option>`).join('');
}

// ---- Automatic academic-year / term defaults ---------------------------------
// A Kenyan school year always runs Jan 1 – Dec 31, and the three CBC terms
// follow a predictable pattern each year. Users can still edit every date —
// these are just sensible starting points filled in automatically so nobody
// has to type the same dates by hand every January.
function yearBounds(year) {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}
const TERM_DEFAULTS = {
  'Term 1': (y) => ({ start: `${y}-01-05`, end: `${y}-04-26` }),
  'Term 2': (y) => ({ start: `${y}-04-27`, end: `${y}-08-23` }),
  'Term 3': (y) => ({ start: `${y}-08-24`, end: `${y}-12-31` })
};

const STATUS_OPTIONS = ['upcoming', 'active', 'archived'];
function statusSelect(id, selected) {
  return `<select id="${id}">${STATUS_OPTIONS.map((s) => `<option value="${s}"${s === selected ? ' selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select>`;
}
function statusBadge(status) {
  const map = { active: 'green', upcoming: 'blue', archived: 'grey' };
  return `<span class="badge ${map[status] || 'grey'}">${esc(status)}</span>`;
}

export async function viewAcademicCalendar(root) {
  await render(root);
}

async function render(root) {
  const [yearsRes, termsRes] = await Promise.all([Db.academicYears.list(), Db.terms.list()]);
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];

  const yearRows = years.length
    ? years.map((y) => `<tr>
        <td>${esc(y.name)}</td><td>${statusBadge(y.status)}</td>
        <td class="row-actions">
          <button class="icon-btn" data-edit-year="${y.id}">✏️</button>
          <button class="icon-btn danger" data-del-year="${y.id}">🗑️</button>
        </td></tr>`).join('')
    : `<tr><td colspan="3" class="muted center">No academic years yet.</td></tr>`;

  const termRows = terms.length
    ? terms.map((t) => `<tr>
        <td>${esc(t.academic_year_name)}</td><td>${esc(t.name)}</td><td>${statusBadge(t.status)}</td>
        <td class="row-actions">
          <button class="icon-btn" data-edit-term="${t.id}">✏️</button>
          <button class="icon-btn danger" data-del-term="${t.id}">🗑️</button>
        </td></tr>`).join('')
    : `<tr><td colspan="4" class="muted center">No terms yet.</td></tr>`;

  root.innerHTML = `
    <div class="page-head"><div><h2>Academic Calendar</h2><p>Academic years and terms — one active year and one active term drive the rest of the app.</p></div></div>
    <div class="grid2">
      <div class="card">
        <div class="card-h"><h3>Academic Years</h3><div class="spacer"></div><button class="btn sm" id="add-year">+ Add year</button></div>
        <div class="card-b table-wrap"><table class="data"><thead><tr><th>Year</th><th>Status</th><th></th></tr></thead>
        <tbody>${yearRows}</tbody></table></div>
      </div>
      <div class="card">
        <div class="card-h"><h3>Terms</h3><div class="spacer"></div>
          <button class="btn sm" id="add-term" ${years.length ? '' : 'disabled title="Add an academic year first"'}>+ Add term</button>
        </div>
        <div class="card-b table-wrap">
          ${years.length ? `<table class="data"><thead><tr><th>Year</th><th>Term</th><th>Status</th><th></th></tr></thead>
          <tbody>${termRows}</tbody></table>` : `<div class="empty warn"><div class="e-ico">⚠️</div><h3>No academic years found</h3><p>Please create an academic year before adding terms.</p></div>`}
        </div>
      </div>
    </div>`;

  root.querySelector('#add-year').onclick = () => openYearModal(root, years);
  root.querySelectorAll('[data-edit-year]').forEach((b) => b.onclick = () => openYearModal(root, years, years.find((y) => y.id === b.dataset.editYear)));
  root.querySelectorAll('[data-del-year]').forEach((b) => b.onclick = () => confirmAction('Delete this academic year?', async () => {
    const res = await Db.academicYears.remove(b.dataset.delYear);
    if (res.ok) { toast('Academic year deleted.', 'ok'); render(root); } else toast(res.message, 'err');
  }, true));

  const addTermBtn = root.querySelector('#add-term');
  if (addTermBtn) addTermBtn.onclick = () => openTermModal(root, years, terms);
  root.querySelectorAll('[data-edit-term]').forEach((b) => b.onclick = () => openTermModal(root, years, terms, terms.find((t) => t.id === b.dataset.editTerm)));
  root.querySelectorAll('[data-del-term]').forEach((b) => b.onclick = () => confirmAction('Delete this term?', async () => {
    const res = await Db.terms.remove(b.dataset.delTerm);
    if (res.ok) { toast('Term deleted.', 'ok'); render(root); } else toast(res.message, 'err');
  }, true));
}

function openYearModal(root, years, existing) {
  const defaultYear = existing ? existing.name : String(new Date().getFullYear());
  const defaultBounds = yearBounds(defaultYear);
  modal({
    title: existing ? 'Edit academic year' : 'Add academic year',
    body: `
      <div class="field"><label>Year</label><select id="ay-name">${yearOptions(defaultYear)}</select></div>
      <div class="grid2">
        <div class="field"><label>Start date</label><input id="ay-start" type="date" value="${esc(existing && existing.start_date ? existing.start_date.slice(0, 10) : defaultBounds.start)}"></div>
        <div class="field"><label>End date</label><input id="ay-end" type="date" value="${esc(existing && existing.end_date ? existing.end_date.slice(0, 10) : defaultBounds.end)}"></div>
      </div>
      <div class="field"><label>Status</label>${statusSelect('ay-status', existing ? existing.status : 'upcoming')}</div>
      <p class="hint">Dates default to Jan 1 – Dec 31 for the chosen year — edit them if your school's year runs differently. Marking a year "Active" automatically archives any other active year.</p>
    `,
    okLabel: 'Save',
    onOk: async () => {
      const payload = {
        id: existing ? existing.id : undefined,
        name: document.getElementById('ay-name').value,
        start_date: document.getElementById('ay-start').value || null,
        end_date: document.getElementById('ay-end').value || null,
        status: document.getElementById('ay-status').value
      };
      const res = await Db.academicYears.save(payload);
      if (res.ok) { toast('Academic year saved.', 'ok'); closeModal(); render(root); } else toast(res.message, 'err');
    }
  });
  // Changing the year auto-refreshes the Jan 1 – Dec 31 default dates.
  // Users who've already typed their own dates keep full control — this only
  // recomputes the fields, it never blocks manual edits afterwards.
  document.getElementById('ay-name').onchange = (e) => {
    const b = yearBounds(e.target.value);
    document.getElementById('ay-start').value = b.start;
    document.getElementById('ay-end').value = b.end;
  };
}

function openTermModal(root, years, terms, existing) {
  const defaultYearId = existing ? existing.academic_year_id : (years[0] ? years[0].id : '');
  const defaultTermName = existing ? existing.name : 'Term 1';
  function computeTermBounds(yearId, termName) {
    const y = (years.find((x) => String(x.id) === String(yearId)) || {}).name;
    const fn = TERM_DEFAULTS[termName];
    return (y && fn) ? fn(y) : null;
  }
  const initialBounds = (!existing) ? computeTermBounds(defaultYearId, defaultTermName) : null;
  modal({
    title: existing ? 'Edit term' : 'Add term',
    body: `
      <div class="field"><label>Academic year</label><select id="tm-year">${options(years, 'id', 'name', defaultYearId, 'Choose a year')}</select></div>
      <div class="field"><label>Term</label>
        <select id="tm-name">${options([{ v: 'Term 1' }, { v: 'Term 2' }, { v: 'Term 3' }].map(x => ({ id: x.v, name: x.v })), 'id', 'name', defaultTermName, 'Choose a term')}</select>
      </div>
      <div class="grid2">
        <div class="field"><label>Start date</label><input id="tm-start" type="date" value="${esc(existing && existing.start_date ? existing.start_date.slice(0, 10) : (initialBounds ? initialBounds.start : ''))}"></div>
        <div class="field"><label>End date</label><input id="tm-end" type="date" value="${esc(existing && existing.end_date ? existing.end_date.slice(0, 10) : (initialBounds ? initialBounds.end : ''))}"></div>
      </div>
      <div class="field"><label>Status</label>${statusSelect('tm-status', existing ? existing.status : 'upcoming')}</div>
      <p class="hint">Term dates default to the standard CBC term calendar (Term 1: Jan 5 – Apr 26, Term 2: Apr 27 – Aug 23, Term 3: Aug 24 – Dec 31) — edit them if your school's terms differ. Marking a term "Active" automatically archives any other active term.</p>
    `,
    okLabel: 'Save',
    onOk: async () => {
      const payload = {
        id: existing ? existing.id : undefined,
        academic_year_id: document.getElementById('tm-year').value,
        name: document.getElementById('tm-name').value,
        start_date: document.getElementById('tm-start').value || null,
        end_date: document.getElementById('tm-end').value || null,
        status: document.getElementById('tm-status').value
      };
      const res = await Db.terms.save(payload);
      if (res.ok) { toast('Term saved.', 'ok'); closeModal(); render(root); } else toast(res.message, 'err');
    }
  });
  // Changing the year or term picks up the standard CBC term-date defaults.
  // Same principle as the year modal: this refreshes the fields, it never
  // stops anyone from typing their own dates afterwards.
  const refreshTermDates = () => {
    const b = computeTermBounds(document.getElementById('tm-year').value, document.getElementById('tm-name').value);
    if (b) {
      document.getElementById('tm-start').value = b.start;
      document.getElementById('tm-end').value = b.end;
    }
  };
  document.getElementById('tm-year').onchange = refreshTermDates;
  document.getElementById('tm-name').onchange = refreshTermDates;
}

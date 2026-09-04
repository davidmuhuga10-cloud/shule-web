/**
 * admin.js — Super Admin / platform-management dashboard
 * (Admin_Dashboard_Architecture3.docx). A small, separate mini-app living at
 * /admin (admin.html/admin.js/admin.css) — NOT part of the main school SPA's
 * hash-router — but sharing the exact same Supabase project/session, so
 * signing in here is a normal Supabase Auth sign-in, not a separate login
 * system.
 *
 * Access control: there is no hardcoded email check anywhere in here. Every
 * screen and every action goes through admin_* SECURITY DEFINER RPCs (see
 * migrations/0035_admin_dashboard.sql) that themselves re-check
 * public.is_super_admin() — a boolean flag on the signed-in profile — before
 * doing anything. This file's own "is this account allowed here" check
 * (right after sign-in) is a UX convenience only; the real enforcement is
 * server-side and cannot be bypassed by editing this file.
 */
import { createClient } from './src/vendor/supabase-js.esm.js';

const cfg = window.SHULE_CONFIG || {};
const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

const root = document.getElementById('admin-root');
let profile = null;

// Same shared sw.js as the main app (see its own header comment) — harmless
// and consistent to register here too, since someone could open /admin on a
// browser that's never loaded the main app. Moved here from a literal
// inline <script> in admin.html as part of the security hardening pass —
// this file is already loaded as a real module, no reason to keep a
// separate inline script around too (and a strict script-src CSP has to
// block inline <script> blocks that aren't file-loaded).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

/* ------------------------------ helpers ---------------------------------- */
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function toast(msg, type) {
  const t = document.createElement('div');
  t.className = 'a-toast ' + (type || '');
  t.textContent = msg;
  document.getElementById('admin-toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = '.3s'; setTimeout(() => t.remove(), 300); }, 3500);
}
function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
}
function fmtMoney(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
async function withBusy(btn, fn, busyLabel) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel || 'Please wait…';
  try { await fn(); } finally { btn.disabled = false; btn.textContent = original; }
}
function modal({ title, bodyHtml, okLabel, onOk, cancelLabel }) {
  const scrim = document.createElement('div');
  scrim.className = 'a-modal-scrim';
  scrim.innerHTML = `<div class="a-modal">
    <div class="a-modal-h">${esc(title)}</div>
    <div class="a-modal-b">${bodyHtml}</div>
    <div class="a-modal-f">
      <button class="a-btn secondary" id="a-modal-cancel">${esc(cancelLabel || 'Cancel')}</button>
      ${onOk ? `<button class="a-btn" id="a-modal-ok">${esc(okLabel || 'Confirm')}</button>` : ''}
    </div>
  </div>`;
  document.body.appendChild(scrim);
  const close = () => scrim.remove();
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  scrim.querySelector('#a-modal-cancel').onclick = close;
  if (onOk) {
    const okBtn = scrim.querySelector('#a-modal-ok');
    okBtn.onclick = () => withBusy(okBtn, async () => { await onOk(close); }, 'Working…');
  }
  return { close, root: scrim };
}
async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args || {});
  if (error) { toast(error.message, 'err'); throw error; }
  return data;
}

/* ------------------------------ auth screen ------------------------------- */
function renderLogin(errorMsg) {
  root.innerHTML = `
    <div class="a-login-wrap">
      <div class="a-login-box">
        <h1>ShuleTop — Super Admin</h1>
        <p class="a-sub">Platform management. This is not the school login — regular school accounts cannot sign in here.</p>
        <div class="a-field"><label>Email</label><input id="a-login-email" type="email" autocomplete="username"></div>
        <div class="a-field"><label>Password</label><input id="a-login-pw" type="password" autocomplete="current-password"></div>
        <button class="a-btn" id="a-login-btn" style="width:100%">Sign in</button>
        ${errorMsg ? `<div class="a-err">${esc(errorMsg)}</div>` : ''}
      </div>
    </div>`;
  const btn = document.getElementById('a-login-btn');
  btn.onclick = () => withBusy(btn, async () => {
    const email = document.getElementById('a-login-email').value.trim();
    const password = document.getElementById('a-login-pw').value;
    if (!email || !password) { renderLogin('Enter your email and password.'); return; }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) { renderLogin('Sign in failed: ' + (error ? error.message : 'unknown error')); return; }
    await boot();
  }, 'Signing in…');
  document.getElementById('a-login-pw').onkeydown = (e) => { if (e.key === 'Enter') btn.click(); };
}

/* -------------------------------- shell ----------------------------------- */
const SCREENS = [
  { key: 'dashboard', label: 'Dashboard', ico: '🏠' },
  { key: 'schools', label: 'Schools', ico: '🏫' },
  { key: 'sms', label: 'SMS Requests', ico: '📶' },
  { key: 'audit', label: 'Audit Log', ico: '📜' }
];

function renderShell(activeKey) {
  root.innerHTML = `
    <div class="a-shell">
      <aside class="a-sidebar">
        <div class="a-brand">ShuleTop<small>Super Admin</small></div>
        <nav class="a-nav">
          ${SCREENS.map((s) => `<a data-screen="${s.key}" class="${s.key === activeKey ? 'active' : ''}">${s.ico} ${esc(s.label)}</a>`).join('')}
        </nav>
        <div class="a-nav-foot"><a id="a-signout" style="cursor:pointer;color:#94a3b8;font-size:13px">↩️ Sign out</a></div>
      </aside>
      <div class="a-main">
        <div class="a-topbar">
          <h2 id="a-screen-title"></h2>
          <div class="a-who">${esc((profile && profile.name) || '')} · Super Admin</div>
        </div>
        <div id="a-screen-body"><div class="a-loader"><div class="a-spin"></div></div></div>
      </div>
    </div>`;
  root.querySelectorAll('[data-screen]').forEach((a) => a.onclick = () => go(a.dataset.screen));
  document.getElementById('a-signout').onclick = async () => { await supabase.auth.signOut(); profile = null; renderLogin(); };
}

let currentScreen = 'dashboard';
function go(key) {
  currentScreen = key;
  renderShell(key);
  const titleEl = document.getElementById('a-screen-title');
  const body = document.getElementById('a-screen-body');
  const meta = SCREENS.find((s) => s.key === key);
  titleEl.textContent = meta ? meta.label : '';
  if (key === 'dashboard') renderDashboard(body);
  else if (key === 'schools') renderSchools(body);
  else if (key === 'sms') renderSmsRequests(body);
  else if (key === 'audit') renderAuditLog(body);
}

/* ------------------------------ Dashboard --------------------------------- */
async function renderDashboard(body) {
  // The whole render — not just the RPC awaits — lives inside this try
  // block on purpose: an interactive test caught a real bug here where an
  // unexpected/malformed RPC result threw OUTSIDE the try (at trend.map),
  // which left the loading spinner stuck forever instead of showing the
  // friendly error message this catch is meant to guarantee.
  try {
    const [summary, trials, recent, trend] = await Promise.all([
      rpc('admin_dashboard_summary'),
      rpc('admin_list_expiring_trials', { p_within_days: 14 }),
      rpc('admin_list_recent_schools', { p_limit: 8 }),
      rpc('admin_registration_trend', { p_weeks: 10 })
    ]);
    renderDashboardBody(body, summary || {}, Array.isArray(trials) ? trials : [], Array.isArray(recent) ? recent : [], Array.isArray(trend) ? trend : []);
  } catch (e) {
    body.innerHTML = `<div class="a-card"><div class="a-card-b">⚠️ Could not load the dashboard.</div></div>`;
  }
}

function renderDashboardBody(body, summary, trials, recent, trend) {
  const stats = [
    { label: 'Total Schools', value: summary.total_schools },
    { label: 'Total Students', value: summary.total_students },
    { label: 'Total Teachers', value: summary.total_teachers },
    { label: 'Pending SMS Confirmations', value: summary.pending_sms_confirmations },
    { label: 'Total SMS Revenue', value: fmtMoney(summary.total_sms_revenue) },
    { label: 'New Schools (7 days)', value: summary.new_schools_this_week },
    { label: 'New Schools (30 days)', value: summary.new_schools_this_month }
  ];

  const maxTrend = Math.max(1, ...trend.map((t) => t.new_schools));

  body.innerHTML = `
    <div class="a-stats">${stats.map((s) => `<div class="a-stat"><div class="a-stat-label">${esc(s.label)}</div><div class="a-stat-value">${esc(String(s.value))}</div></div>`).join('')}</div>

    <div class="a-card">
      <div class="a-card-h">Trials Expiring Soon (next 14 days)</div>
      <div class="a-card-b">
        ${trials.length ? `<div class="a-table-wrap"><table class="a-data"><thead><tr><th>School</th><th>Code</th><th>Trial ends</th><th>Days left</th></tr></thead>
          <tbody>${trials.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.code)}</td><td>${fmtDate(t.trial_ends_at)}</td>
            <td><span class="a-badge ${t.days_left <= 3 ? 'red' : t.days_left <= 7 ? 'amber' : 'grey'}">${t.days_left} day${t.days_left === 1 ? '' : 's'}</span></td></tr>`).join('')}</tbody>
        </table></div>` : `<div class="a-empty">No trials expiring in the next 14 days.</div>`}
      </div>
    </div>

    <div class="a-card">
      <div class="a-card-h">Registration Trend (last 10 weeks)</div>
      <div class="a-card-b">
        ${trend.length ? trend.map((t) => `<div class="a-bar-row"><span style="width:90px">${esc(String(t.week_start))}</span>
          <div class="a-bar-track"><div class="a-bar-fill" style="width:${Math.round((t.new_schools / maxTrend) * 100)}%"></div></div>
          <span style="width:24px;text-align:right">${t.new_schools}</span></div>`).join('') : `<div class="a-empty">No signups yet.</div>`}
      </div>
    </div>

    <div class="a-card">
      <div class="a-card-h">Most Recently Registered Schools</div>
      <div class="a-card-b">
        ${recent.length ? `<div class="a-table-wrap"><table class="a-data"><thead><tr><th>School</th><th>Code</th><th>Registered</th></tr></thead>
          <tbody>${recent.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.code)}</td><td>${fmtDate(r.created_at)}</td></tr>`).join('')}</tbody>
        </table></div>` : `<div class="a-empty">No schools yet.</div>`}
      </div>
    </div>
  `;
}

/* ------------------------------- Schools ---------------------------------- */
async function renderSchools(body, searchTerm) {
  body.innerHTML = `
    <div class="a-card">
      <div class="a-card-h">
        <span>All Schools</span>
        <input id="a-school-search" placeholder="Search by name or code…" value="${esc(searchTerm || '')}" style="padding:8px 10px;border-radius:8px;border:1px solid #cbd5e1;font-size:13px;min-width:220px">
      </div>
      <div class="a-card-b" id="a-schools-list"><div class="a-loader"><div class="a-spin"></div></div></div>
    </div>`;
  const searchEl = document.getElementById('a-school-search');
  let t = null;
  searchEl.oninput = () => { clearTimeout(t); t = setTimeout(() => renderSchools(body, searchEl.value), 300); };
  searchEl.focus();
  searchEl.setSelectionRange(searchEl.value.length, searchEl.value.length);

  let rows;
  try { rows = await rpc('admin_list_schools', { p_search: searchTerm || null }); } catch (e) { return; }
  if (!Array.isArray(rows)) rows = [];
  const listEl = document.getElementById('a-schools-list');
  if (!rows.length) { listEl.innerHTML = `<div class="a-empty">No schools found.</div>`; return; }

  listEl.innerHTML = `<div class="a-table-wrap"><table class="a-data">
    <thead><tr><th>School</th><th>Code</th><th>Students</th><th>Teachers</th><th>SMS Balance</th><th>Trial ends</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(r.name)}</td><td>${esc(r.code)}</td><td>${r.student_count}</td><td>${r.teacher_count}</td><td>${r.sms_balance}</td>
      <td>${fmtDate(r.trial_ends_at)}</td>
      <td>${r.deleted_at ? '<span class="a-badge red">Deleted</span>' : r.locked_at ? '<span class="a-badge red">Locked</span>' : '<span class="a-badge green">Active</span>'}</td>
      <td><button class="a-btn sm secondary" data-open="${r.id}">Open</button></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
  listEl.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => openSchoolDetail(b.dataset.open, body, searchTerm));
}

async function openSchoolDetail(schoolId, body, searchTerm) {
  let detail;
  try { detail = await rpc('admin_school_detail', { p_school_id: schoolId }); } catch (e) { return; }

  const { close, root: modalRoot } = modal({
    title: detail.name,
    bodyHtml: `
      <div class="a-field"><label>School code</label><div>${esc(detail.code)}</div></div>
      <div class="a-field"><label>Students / Teachers</label><div>${detail.student_count} students · ${detail.teacher_count} teachers</div></div>
      <div class="a-field"><label>Last activity</label><div>${fmtDate(detail.last_activity)}</div></div>
      <div class="a-field"><label>Trial ends</label><div>${fmtDate(detail.trial_ends_at)}</div></div>
      <div class="a-field"><label>Status</label><div>${detail.deleted_at ? 'Deleted' : detail.locked_at ? ('Locked — ' + esc(detail.locked_reason || 'no reason given')) : 'Active'}</div></div>
      <div class="a-field"><label>SMS wallet balance</label><div style="display:flex;gap:8px;align-items:center">
        <b>${detail.sms_balance}</b> credits
        <input id="a-wallet-delta" type="number" placeholder="+/- amount" style="width:110px;padding:6px 8px;border-radius:6px;border:1px solid #cbd5e1">
        <button class="a-btn sm" id="a-wallet-apply">Apply</button>
      </div></div>
      <div class="a-field"><label>Extend trial</label><div style="display:flex;gap:8px;align-items:center">
        <input id="a-extend-days" type="number" placeholder="days" style="width:90px;padding:6px 8px;border-radius:6px;border:1px solid #cbd5e1">
        <button class="a-btn sm" id="a-extend-apply">Extend</button>
      </div></div>
      <div class="a-field"><label>Admin login on file</label><div>${detail.admin_profile ? esc(detail.admin_profile.name) + ' — ' + esc(detail.admin_profile.email || 'no email on file') : 'None found'}</div></div>
      <div class="a-field" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">
        <button class="a-btn secondary sm" id="a-lock-toggle">${detail.locked_at ? 'Unlock school' : 'Lock school'}</button>
        <button class="a-btn secondary sm" id="a-login-as" ${!detail.admin_profile || !detail.admin_profile.email ? 'disabled' : ''}>Login as School</button>
        <button class="a-btn danger sm" id="a-delete-school" ${detail.deleted_at ? 'disabled' : ''}>Delete school</button>
      </div>
    `
  });

  const walletBtn = modalRoot.querySelector('#a-wallet-apply');
  walletBtn.onclick = () => withBusy(walletBtn, async () => {
    const delta = parseInt(modalRoot.querySelector('#a-wallet-delta').value, 10);
    if (!delta) { toast('Enter a non-zero amount.', 'err'); return; }
    await rpc('admin_adjust_sms_wallet', { p_school_id: schoolId, p_delta: delta, p_note: 'Manual adjustment from Admin Dashboard' });
    toast('SMS wallet updated.', 'ok');
    close(); renderSchools(body, searchTerm);
  });

  const extendBtn = modalRoot.querySelector('#a-extend-apply');
  extendBtn.onclick = () => withBusy(extendBtn, async () => {
    const days = parseInt(modalRoot.querySelector('#a-extend-days').value, 10);
    if (!days || days <= 0) { toast('Enter a positive number of days.', 'err'); return; }
    await rpc('admin_extend_trial', { p_school_id: schoolId, p_extra_days: days });
    toast('Trial extended.', 'ok');
    close(); renderSchools(body, searchTerm);
  });

  const lockBtn = modalRoot.querySelector('#a-lock-toggle');
  lockBtn.onclick = () => withBusy(lockBtn, async () => {
    const willLock = !detail.locked_at;
    let reason = null;
    if (willLock) {
      reason = window.prompt('Reason to show this school\'s users while locked (optional):') || 'Access locked by the platform administrator.';
    }
    await rpc('admin_set_school_lock', { p_school_id: schoolId, p_locked: willLock, p_reason: reason });
    toast(willLock ? 'School locked.' : 'School unlocked.', 'ok');
    close(); renderSchools(body, searchTerm);
  });

  const loginAsBtn = modalRoot.querySelector('#a-login-as');
  loginAsBtn.onclick = () => withBusy(loginAsBtn, async () => {
    // Open the tab SYNCHRONOUSLY, before any await — browsers only allow
    // window.open() to bypass the popup blocker while it's still running
    // inside the original click's call stack. We navigate this captured
    // window reference to its real destination once the async fetch below
    // resolves. about:blank shows a brief "Opening..." placeholder in the
    // meantime rather than a blank flash.
    const newTab = window.open('about:blank', '_blank');
    if (newTab) {
      try { newTab.document.write('<title>ShuleTop</title><body style="font:15px system-ui;display:flex;align-items:center;justify-content:center;height:100vh;color:#374151">Opening school account…</body>'); } catch (e) { /* cross-origin timing edge case — harmless */ }
    }

    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch('/.netlify/functions/admin-impersonate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ action: 'start', school_id: schoolId })
    });
    const out = await res.json();
    if (!out.ok) {
      toast(out.message || 'Could not start impersonation.', 'err');
      if (newTab && !newTab.closed) newTab.close();
      return;
    }

    // The new tab's own Supabase client (see src/lib/supabaseClient.js)
    // switches to sessionStorage-backed auth specifically because
    // ?impersonate=1 is present, isolating it from this /admin tab's own
    // (localStorage-backed) Super Admin session — so this tab is left
    // completely untouched and stays signed in the whole time.
    const url = '/index.html?impersonate=1'
      + '&impersonate_email=' + encodeURIComponent(out.email)
      + '&impersonate_token=' + encodeURIComponent(out.token_hash)
      + '&impersonate_school=' + encodeURIComponent(out.school_name || '')
      + '&impersonate_session=' + encodeURIComponent(out.session_id || '');

    if (newTab && !newTab.closed) {
      newTab.location.href = url;
    } else {
      // Popup was blocked despite the synchronous open (e.g. an
      // aggressive blocker) — fall back to a link so the Super Admin can
      // still get in with one click, without losing their own /admin tab.
      toast('Your browser blocked the new tab. Please allow pop-ups for this site and try again.', 'err');
    }
  });

  const deleteBtn = modalRoot.querySelector('#a-delete-school');
  deleteBtn.onclick = () => {
    close();
    modal({
      title: `Delete "${detail.name}"`,
      bodyHtml: `<p>This is the most dangerous action here. The school will be soft-deleted and recoverable for 30 days, then permanently removed.</p>
        <p>Type the school's exact name to confirm:</p>
        <div class="a-field"><input id="a-confirm-name" placeholder="${esc(detail.name)}"></div>`,
      okLabel: 'Delete school',
      onOk: async (closeConfirm) => {
        const typed = document.getElementById('a-confirm-name').value;
        try {
          await rpc('admin_delete_school', { p_school_id: schoolId, p_confirm_name: typed });
        } catch (e) { return; }
        toast('School deleted (recoverable for 30 days).', 'ok');
        closeConfirm(); renderSchools(body, searchTerm);
      }
    });
  };
}

/* ----------------------------- SMS Requests -------------------------------- */
async function renderSmsRequests(body) {
  body.innerHTML = `<div class="a-card"><div class="a-card-h">SMS Credit Purchase Requests</div><div class="a-card-b" id="a-sms-list"><div class="a-loader"><div class="a-spin"></div></div></div></div>`;
  let rows;
  try { rows = await rpc('admin_list_sms_requests', { p_status: null }); } catch (e) { return; }
  if (!Array.isArray(rows)) rows = [];
  const listEl = document.getElementById('a-sms-list');
  if (!rows.length) { listEl.innerHTML = `<div class="a-empty">No SMS credit requests yet.</div>`; return; }

  listEl.innerHTML = `<div class="a-table-wrap"><table class="a-data">
    <thead><tr><th>Date</th><th>School</th><th>Credits</th><th>Amount</th><th>Payment message</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${fmtDate(r.created_at)}</td><td>${esc(r.school_name)}</td><td>${r.requested_credits}</td><td>${fmtMoney(r.amount_paid)}</td>
      <td style="max-width:260px;white-space:pre-wrap">${esc(r.payment_message)}</td>
      <td><span class="a-badge ${r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : 'amber'}">${esc(r.status)}</span></td>
      <td class="a-row-actions">${r.status === 'pending' ? `<button class="a-btn sm" data-approve="${r.id}">Approve</button><button class="a-btn sm secondary" data-reject="${r.id}">Reject</button>` : ''}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;

  listEl.querySelectorAll('[data-approve]').forEach((b) => b.onclick = () => withBusy(b, async () => {
    const reference = window.prompt('Reference for this credit (for the paper trail), optional:') || null;
    try { await rpc('admin_review_sms_request', { p_request_id: b.dataset.approve, p_approve: true, p_reference: reference }); }
    catch (e) { return; }
    toast('Approved — school\'s SMS wallet credited.', 'ok');
    renderSmsRequests(body);
  }));
  listEl.querySelectorAll('[data-reject]').forEach((b) => b.onclick = () => withBusy(b, async () => {
    const note = window.prompt('Reason for rejecting (optional):') || null;
    try { await rpc('admin_review_sms_request', { p_request_id: b.dataset.reject, p_approve: false, p_note: note }); }
    catch (e) { return; }
    toast('Request rejected.', 'ok');
    renderSmsRequests(body);
  }));
}

/* ------------------------------- Audit Log ---------------------------------- */
async function renderAuditLog(body) {
  body.innerHTML = `<div class="a-card"><div class="a-card-h">Audit Log</div><div class="a-card-b" id="a-audit-list"><div class="a-loader"><div class="a-spin"></div></div></div></div>`;
  let rows;
  try { rows = await rpc('admin_list_audit_log', { p_limit: 300 }); } catch (e) { return; }
  if (!Array.isArray(rows)) rows = [];
  const listEl = document.getElementById('a-audit-list');
  if (!rows.length) { listEl.innerHTML = `<div class="a-empty">No admin actions recorded yet.</div>`; return; }
  listEl.innerHTML = `<div class="a-table-wrap"><table class="a-data">
    <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>School</th><th>Details</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${fmtDate(r.created_at)}</td><td>${esc(r.actor_name || 'System')}</td><td>${esc(r.action)}</td><td>${esc(r.target_school_name || '—')}</td>
      <td class="a-muted" style="max-width:320px;white-space:pre-wrap">${esc(JSON.stringify(r.details || {}))}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

/* --------------------------------- boot ------------------------------------ */
async function boot() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { renderLogin(); return; }

  const { data: p, error } = await supabase.from('profiles').select('id, name, email, is_super_admin, status').eq('id', session.user.id).maybeSingle();
  if (error || !p || !p.is_super_admin || p.status !== 'active') {
    await supabase.auth.signOut();
    renderLogin('This account is not authorized for the Super Admin Dashboard.');
    return;
  }
  profile = p;
  go(currentScreen);
}

boot();

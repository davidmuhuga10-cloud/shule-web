/** Placeholder for nav routes not yet ported from the Apps Script version. */
export function renderComingSoon(root, label) {
  root.innerHTML = `<div class="card"><div class="card-b">
    <div class="empty">
      <div class="e-ico">🚧</div>
      <h3>${label || 'This section'} is coming soon</h3>
      <p>This part of the migration to Supabase/Netlify hasn't landed yet — it's next on the list.</p>
    </div>
  </div></div>`;
}

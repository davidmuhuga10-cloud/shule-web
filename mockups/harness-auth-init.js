// Real app.js's supabaseClient.js reads window.SHULE_CONFIG at import
// time — a syntactically valid but unreachable project so getSession()
// (called once on load) resolves locally with `session: null` and never
// actually reaches the network, letting the REAL, unmodified renderAuth()
// render exactly as production would for a signed-out visitor.
//
// Split out of harness-auth.html's own inline <script> tags during the
// security hardening pass — a strict script-src Content-Security-Policy
// (applied site-wide, dev harness included) blocks inline script blocks,
// so this dev-only tooling gets the same file-loaded treatment as every
// production page.
window.SHULE_CONFIG = { SUPABASE_URL: 'https://mock-project.supabase.co', SUPABASE_ANON_KEY: 'mock-anon-key' };
window.__mockMounted = false;

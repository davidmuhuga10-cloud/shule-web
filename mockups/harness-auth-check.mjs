// The real app.js has no explicit "mounted" signal (it's the actual
// production entry point, not a harness-aware shim) — poll for the auth
// screen actually having content instead.
const check = () => {
  const el = document.getElementById('auth-screen');
  if (el && !el.classList.contains('hidden') && el.children.length) window.__mockMounted = true;
  else setTimeout(check, 50);
};
check();

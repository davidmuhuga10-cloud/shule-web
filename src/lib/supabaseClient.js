/**
 * supabaseClient.js
 * ----------------------------------------------------------------------------
 * One shared Supabase client for the whole app, using the public anon key
 * (config.js). supabase-js is vendored locally at src/vendor/supabase-js.esm.js
 * (a pre-built, dependency-free bundle — see src/vendor/README.md) rather than
 * pulled from a third-party CDN at page-load time: no runtime dependency on
 * esm.sh/unpkg staying up, no surprise version drift, and it works even if
 * the school's network blocks CDN domains but allows the Netlify site itself.
 * ----------------------------------------------------------------------------
 */
import { createClient } from '../vendor/supabase-js.esm.js';

const cfg = window.SHULE_CONFIG || {};
if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.indexOf('YOUR-PROJECT-REF') !== -1) {
  console.warn('Shule: src/lib/config.js still has placeholder Supabase values — update it with your project URL and anon key.');
}

export const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

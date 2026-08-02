/**
 * config.js
 * ----------------------------------------------------------------------------
 * Fill these in with YOUR Supabase project's values (Project Settings -> API).
 * The anon key is safe to expose in client code by design — Postgres
 * Row-Level Security (see supabase/schema.sql) is what actually enforces who
 * can read/write what. NEVER put the service_role key here or anywhere in
 * the frontend — that one lives only in the Netlify function's environment
 * variables.
 * ----------------------------------------------------------------------------
 */
window.SHULE_CONFIG = {
  SUPABASE_URL: 'https://tyycjuppsdqcbrzmlimf.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR5eWNqdXBwc2RxY2Jyem1saW1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2ODg5ODgsImV4cCI6MjEwMTI2NDk4OH0.908_pOVgcbDF4RrwGwdYqyXQjaV7jXzbrY-evBhBqlg',
  SCHOOL_BRAND_NAME: 'Shule' // fallback shown before Settings has a school_name saved
};

# vendor/

`supabase-js.esm.js` is a pre-built, dependency-free ES module bundle of
`@supabase/supabase-js`, generated once with esbuild and committed here so
the site has **zero build step** and **no runtime dependency on a third-party
CDN** (esm.sh/unpkg) — it's just another static file Netlify serves.

You do not need to touch this file. If you ever want to upgrade the Supabase
client library version:

```
npm install @supabase/supabase-js@latest
npm run build:vendor
```

That regenerates this file from whatever version is in `node_modules`, and
the app picks it up automatically (`src/lib/supabaseClient.js` imports from
here).

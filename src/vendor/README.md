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

## xlsx.esm.js

Same deal for `xlsx.esm.js` — a pre-built ES module bundle of the
[SheetJS](https://sheetjs.com) `xlsx` community edition, used by
`src/lib/xlsxUtil.mjs` so student bulk-upload and "Download Excel" exports
work with **real `.xlsx` spreadsheets** (not CSV) with zero build step and no
CDN dependency. Regenerate with:

```
npm install xlsx@latest
npm run build:vendor:xlsx
```

Note: the npm registry's last published `xlsx` release is 0.18.5 (SheetJS
publishes newer fixed releases only via their own CDN, which isn't reachable
from every environment). 0.18.5's known advisories are a ReDoS in the parser
and a prototype-pollution bug when parsing a hostile, untrusted file — this
app only ever parses spreadsheets a school's own signed-in admin uploads for
their own tenant, never arbitrary internet content, so the practical risk
here is low. If SheetJS's CDN is reachable from your machine, feel free to
grab a newer tarball from cdn.sheetjs.com and bundle that instead.

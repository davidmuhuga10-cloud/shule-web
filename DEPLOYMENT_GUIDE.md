# Shule — Deployment Guide (Phase 4)

This is the last step: putting the app on the public internet. By the end of
this guide, Shule will be live at a `https://*.netlify.app` address (or your
own domain), backed by your Supabase project, with the login-provisioning
function running as a serverless Netlify Function.

If you haven't done these yet, do them first — this guide assumes they're
done:

1. **Database** — `supabase/SETUP_GUIDE.md` (run `schema.sql` + `seed.sql`,
   create the first admin).
2. **Frontend config** — `src/lib/config.js` filled in with your real
   Supabase project URL and anon key.

---

## 1. Put the code in a Git repository

Netlify deploys from Git (GitHub, GitLab or Bitbucket) — this is what gives
you automatic redeploys every time you push a change, plus a full deploy
history you can roll back to.

If this project isn't already a Git repo:

```
cd shule-web
git init
git add .
git commit -m "Shule — initial deploy"
```

Then create a new, empty repository on GitHub (or GitLab/Bitbucket) and push
to it:

```
git remote add origin https://github.com/<your-username>/<your-repo>.git
git branch -M main
git push -u origin main
```

A `.gitignore` is already included so `node_modules/`, the delivered `.zip`
bundles, and any local `.env` files never get committed — nothing sensitive
lives in the repo. (The Supabase **anon** key inside `src/lib/config.js` is
meant to be public/client-visible — see `supabase/SETUP_GUIDE.md` for why —
so committing it is fine and expected.)

## 2. Create the Netlify site

1. Go to **app.netlify.com** and sign in (or create a free account).
2. Click **Add new site → Import an existing project**.
3. Choose your Git provider and authorize Netlify if asked, then select the
   repository you just pushed.
4. Netlify will read `netlify.toml` (already included in this project) and
   pre-fill the build settings:
   - **Base directory:** (leave blank)
   - **Build command:** (leave blank — there is nothing to compile)
   - **Publish directory:** `.`
   - **Functions directory:** `netlify/functions`

   You shouldn't need to change any of these — just confirm and click
   **Deploy site**.

Netlify will do a first deploy immediately. It will "succeed" (the site will
load), but **login won't work yet** — the serverless function needs its
secret key first. That's the next step.

## 3. Set the function's environment variables

The `admin-provision` function is the only place your Supabase **service
role** key is ever used — it must never appear in frontend code. Set it as a
Netlify environment variable instead:

1. In your new Netlify site, go to **Site configuration → Environment
   variables → Add a variable**.
2. Add both of these (values from **Supabase dashboard → Project Settings →
   API**):

   | Key | Value |
   |---|---|
   | `SUPABASE_URL` | Your project URL (same one already in `src/lib/config.js`) |
   | `SUPABASE_SERVICE_ROLE_KEY` | The **service_role** secret key — **not** the anon key |

3. Click **Save**, then go to **Deploys** and click **Trigger deploy → Deploy
   site** so the function picks up the new variables (env var changes don't
   apply to a deploy already in flight).

## 4. Verify the live site

Open the `https://<your-site-name>.netlify.app` URL Netlify gave you:

- The login screen should show your school's name (from `settings.school_name`
  — confirms the frontend can reach Supabase).
- Sign in with the first admin account you created in `SETUP_GUIDE.md`.
- Try creating a class, then a student — a successful save shows a toast with
  a default password, which confirms the Netlify function, the service role
  key, and the RLS policies are all working together end to end.
- Sign out and confirm you're returned to the login screen.

If something doesn't work, see **Troubleshooting** below before re-checking
every step above.

## 5. Custom domain (optional)

Netlify's `*.netlify.app` subdomain works fine indefinitely, but if you have
your own domain (e.g. `portal.yourschool.ac.ke`):

1. **Site configuration → Domain management → Add a domain**.
2. Follow Netlify's instructions to either point your domain's nameservers at
   Netlify DNS, or add the CNAME/A records it gives you at your existing DNS
   provider.
3. Netlify automatically provisions a free HTTPS certificate once the domain
   is verified — no extra setup needed.

## 6. Ongoing updates

Because the site is connected to Git, **every push to your main branch
redeploys automatically** — no manual re-upload step, ever. For a small
change (say, a CSS tweak or a bug fix):

```
git add -A
git commit -m "Describe the change"
git push
```

Netlify picks it up within seconds and the new version is live within
roughly a minute.

---

## Troubleshooting

**Blank white page / console errors about `SHULE_CONFIG`.**
`src/lib/config.js` still has its placeholder values. Fill in your real
Supabase URL and anon key, commit, and push.

**Login screen loads, but shows no school name / a generic error.**
Usually means the anon key or URL in `config.js` doesn't match your Supabase
project, or `seed.sql` was never run (no `settings` rows exist yet). Check
the browser console (F12) for the specific Supabase error message.

**"Student saved" but no default password / "Login provisioning will be
available once the Netlify function is deployed."**
This is the frontend's own fallback message for when the function call
failed — almost always because `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_URL`
wasn't set as a Netlify environment variable yet, or a deploy hasn't run
since you added them (redeploy after adding env vars — see step 3).

**Function returns 401 / "Not authorized" even when signed in as admin.**
The `admin-provision` function double-checks (server-side, via the service
role key) that the calling user's `profiles` row has `role = 'admin'` and
`status = 'active'`. If you created the first admin by hand in the Supabase
dashboard, double check that row directly (`select * from profiles;`).

**Deploys succeed but changes don't appear.**
Check the Netlify **Deploys** tab — if a deploy shows as failed, click it for
the build log. Since there's no build step, the most common cause is simply
that the push didn't include the files you expected (check `git status` /
`git log` locally).

**I want to test the Netlify Function locally before pushing.**
Install the Netlify CLI (`npm install -g netlify-cli`, already a
devDependency here) and run `netlify dev` from the project root — it serves
the static site *and* runs the function locally, using a `.env` file you
create yourself (never commit it) with `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` for local testing.

---

That's it — Shule is live. From here, the day-to-day workflow is: sign in as
an admin, set up the academic calendar and classes, add subjects, add staff
and students (logins are created automatically), assign teachers to
subjects, then start entering marks each term.

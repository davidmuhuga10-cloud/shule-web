# How to deploy future Shule updates (no re-cloning, no confusion)

The mistakes last time came from treating each update like a brand-new
setup (re-unzipping everything, re-cloning, deleting folders). Going
forward, the process is much simpler: **you already have one permanent,
correctly-connected project folder on your computer — always update that
same folder, never recreate it.**

Your permanent folder is:
```
C:\Users\user\Downloads\shule-web
```
This one has the hidden `.git` folder connecting it to your GitHub repo.
**Never delete this folder. Never delete the `.git` folder inside it.
Never run `git clone` again unless something is actually broken** (if
that ever happens, just tell me and we'll fix that specific problem —
don't re-clone as a first resort).

## Every time I send you updated files

I'll tell you exactly which files changed and where each one goes (e.g.
`src/app.js`, `netlify/functions/school-signup.js`). Two ways to get them
into place — pick whichever is easier for you:

**Option A — drag and drop in File Explorer (easiest):**
1. Download the file(s) I send.
2. Open `C:\Users\user\Downloads\shule-web` in File Explorer.
3. Drag each downloaded file into the matching subfolder (e.g. a file
   that goes in `src/lib/` gets dropped into the existing `src\lib`
   folder inside `shule-web`), choosing **"Replace"** when Windows asks.
   If a file is brand new and its folder doesn't exist yet, create that
   folder first, then drop the file in.

**Option B — I give you one `cp` command (if there are many files):**
Same idea, just faster if there's a lot to move — I'll give you the exact
command to run from Git Bash.

## Then, always the same three commands

Open Git Bash **directly inside** `shule-web` (right-click inside the
folder in File Explorer → "Git Bash Here" or "Open in Terminal" — this
guarantees you're in the right place, no `cd`-ing needed). Then run these
one at a time, checking each result before the next:

```
git add -A
```
```
git commit -m "describe what changed here"
```
```
git push
```

That's it. Netlify sees the push and redeploys automatically — no
Netlify dashboard steps needed.

## If there's also a SQL file

That's a separate, independent step — it never touches your computer's
files at all:
1. Open your Supabase project → **SQL Editor** → New query.
2. Paste in the SQL file's contents.
3. Run it.
4. Check the **Messages** panel (not just "Success. No rows returned")
   for any notes it prints — some migrations report something useful
   there, like a generated code.

**If I send you two SQL files for one update (named like `..a_..sql` and
`..b_..sql`):** run them in that order, as two *separate* "New query → paste
→ Run" steps — don't paste both into the same query box. This only happens
when an update adds a brand-new option to a fixed list (a new role, a new
status, etc.) — Postgres has a rule that a query can't use a brand-new option
in the same breath it was added in, so it has to be its own step first. I'll
always tell you clearly when a change needs this.

## A few habits that prevent the mistakes from last time

- **Run one command at a time.** Don't paste multiple lines together —
  if one fails partway through, it's hard to tell which one.
- **Check `pwd` if you're ever unsure where you are** — it prints your
  current folder. If it doesn't say `.../shule-web`, `cd` there first.
- **Never delete-and-recreate the `shule-web` folder** to "start fresh."
  If something seems broken, tell me what you're seeing instead — almost
  everything is fixable without starting over.
- **`git status`** is always safe to run and never changes anything —
  when in doubt, run it and send me a screenshot before doing anything
  else.

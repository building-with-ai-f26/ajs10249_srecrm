# SECURITY.md: SRECRM Build 3 security audit

**Lane:** Beginner. **Live demo:** https://srecrm-demo.onrender.com/ (made-up sample data only).
**Audit date:** November 23, 2026.

## What kind of app this is

**An app with sign-in.** Board members sign in with Supabase Auth (email and password on the demo). It also has one AI route: firm profiles through OpenRouter.

- **Contact data** (names, emails, outreach) lives only in the Google Sheet. The public demo instead uses the made-up file `data/sample/sample.json`. None of it is ever stored in Supabase.
- **Supabase holds only what Row Level Security needs:**
  - `auth.users`: the login.
  - `members`: board name and role.
  - `contact_access`: Contact_ID, owner, approval and owner hold.

  Schema and policies are tracked in git in `migrations/`.
- **How access is decided:** the server checks each request's login token. It then asks Supabase which contacts that person may work, **using the person's own token**, so RLS decides. Contacts outside that set come back with no email, and every write to them returns 403. The rule is:
  - Admins and approvers see every contact.
  - A contact's owner sees it unless it's Do Not Contact.
  - Other members see it only if it's approved and not on an owner hold.
- **Real data stays local.** The live-sheet mode (`DATA_SOURCE=google`) acts as my Google account, so it runs only on localhost. The server refuses to start in that mode on a public host, and also refuses if sign-in isn't configured.

## Access-control test (Account B tries to read Account A's data)

Two test accounts. Account A is the owner ("Sample Owner B") of contact C003, which is still Pending approval. Account B is a plain member. Run against the live site:

| # | Attack | Result |
|---|---|---|
| 1 | Load `/api/data` without signing in | 401 "Please sign in." ✅ |
| 2 | A reads C003's email through the app | Sees it (A is the owner) ✅ |
| 3 | **B reads C003's email through the app** | **Email removed, `Locked: true`** ✅ |
| 4 | B logs an outreach on C003 | 403 "You don't have access to this contact." ✅ |
| 5 | Forged login token | 401 ✅ |
| 6 | **B queries `contact_access` for C003 directly in Supabase with the publishable key** | **200 with `[]`: RLS returns no row** ✅ |
| 7 | B lists all members | Only B's own row ✅ |
| 8 | B PATCHes its own role to `admin` | 403 permission denied ✅ |
| 9 | Insert into `contact_access` with only the public key | 401 permission denied ✅ |
| 10 | B deletes a `contact_access` row | 403 permission denied ✅ |
| 11 | 30 calls in a row to the AI route `/api/org-profile` | 10 × 200, then 20 × **429** ✅ |
| 12 | Outreach summary containing `<img src=x onerror=...>` (in a browser) | Shown as plain text; the script never ran ✅ |

Backup: `members` and `contact_access` were exported to CSV from Supabase's Table Editor and saved outside the repo, because the free plan has no automatic backups. None of the attacks above changed a row.

## Secret keys

- I searched every tracked file **and the full git history** for `sb_secret_`, `service_role`, `sk-or-`, `sk-ant-`, `sk-proj-`, `sk_live_`, `sb_publishable_`, Google API keys (`AIza…`), OAuth client secrets (`GOCSPX-`), `private_key` and `refresh_token`. **Nothing found.**
- I also searched the live page and `/api/config`: no secret keys. The only keys sent to the browser are the Supabase **publishable** key (public by design; RLS protects the data) and the PostHog `phc_` key (public by design).
- The server never uses the Supabase secret key, so there is no secret key that could skip RLS. All keys live in `.env` (gitignored) and in Render's environment variables.

## File storage

No file uploads and no storage buckets.

## Protecting production from the coding agent

- AGENTS.md has an **Ask me first** list covering:
  - deleting data or changing the database (any SQL, migrations, sheet edits outside the log tabs, dedupe)
  - keys, secrets and permissions (including RLS policies and grants)
  - anything that costs money
  - force-pushes, and any public deploy that isn't sample data
- The agent wrote both migrations but did not run them; I ran them myself in the Supabase SQL Editor.
- The Google Sheet keeps its own version history. Every app write to it adds a row or logs an Owner change in `Assignment_Log`.

## Spending caps and rate limits

- **OpenRouter:** the Render deploy uses its own key with a **$2 credit limit**. The local key has a $10 limit.
- **Supabase, Render and PostHog:** free plans with no card attached, so they can't bill anything.
- **Per-visitor rate limits**, keyed by signed-in user, or by IP before sign-in:
  - 10 per minute on `/api/org-profile` (the paid API)
  - 20 per minute on every `POST` route (every write)
- Supabase Auth applies its own sign-up and sign-in rate limits.

## Dependencies

`npm audit --omit=dev`: **0 high, 0 critical**. There are 2 moderate issues in `uuid`, pulled in by `exceljs`. The only fix npm offers is a breaking downgrade of exceljs, and exceljs runs only in the local, read-only Excel mode, never on the public demo. Left as a known issue.

## Agent security review: what it found and what was fixed

- **No sign-in.** Before Build 3, anyone who could reach the server acted as me (it was safe only because it was bound to 127.0.0.1). **Fixed:** sign-in plus RLS, and the server refuses to run live-sheet mode on a public host.
- **Emails sent to everyone.** The browser had no per-person filter. **Fixed:** emails are sent only for contacts RLS allows, and writes to other contacts return 403.
- **No grant for signed-in users.** This Supabase project doesn't grant new tables to API roles. RLS was on, but signed-in users got "permission denied", and the server would have quietly shown nobody any contacts. **Fixed:** `migrations/002` grants **read only** to `authenticated`. The server now fails loudly on any Supabase error other than an invalid login.
- **Sign-in broke during the build.** A scripted edit dropped a backslash, turning `\s+` into `s+` in the login-token regex, and every sign-in failed. The attack tests caught it before deploy. **Fixed,** and added to AGENTS.md as a rule.
- **No rate limits** on the paid API or on writes. **Fixed** (see above).
- **Stored XSS risk.** On a public demo, one visitor's text is shown to others. Tested with an `onerror` payload: the existing `esc()` escaping holds.
- **Also hardened:** `trust proxy` (so rate limits see the real visitor IP behind Render), `x-powered-by` header removed, JSON body limit of 10 KB (already in place), and errors return short JSON with no stack traces (already in place).

## Remaining issues

1. **Confirm email is off** on the demo, because Supabase's free email sender allows about 2 emails an hour. Anyone can sign up with any address, but new accounts are plain members who see only approved sample contacts, and only an admin can give an account an owner name or role. **Build 5:** nyu.edu Google sign-in only, plus an allowlist.
2. **`contact_access` is filled from the sample data by a migration.** Claiming a contact in the app changes the Owner in the data but not in `contact_access`. **Build 5:** a one-way server sync from the sheet (Sheet → Supabase) using the secret key on the server only.
3. **Demo writes don't persist.** Outreach logged on the demo goes into the sample file on Render's disk and resets when Render restarts. That's acceptable for made-up data; real outreach goes to the Google Sheet.
4. **Rate-limit counters live in memory** and reset on restart. That's fine for one free instance, and a shared store would be needed for more.
5. **Supabase errors in the browser** include hints such as "GRANT SELECT ON …". They reveal table names, but no data and no extra access.
6. **Board members with direct access to the sheet** see every row. RLS protects the app, not the spreadsheet's own sharing.
7. **Two moderate `uuid` advisories** via exceljs (see Dependencies).

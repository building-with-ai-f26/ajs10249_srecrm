# SRECRM: a sponsorship CRM for the NYU Stern Real Estate Club board

One job: let a board member find a firm or contact, see the history, and log an outreach in under a minute.

## Rules
- Small changes. Commit after each working step with a clear message.
- Never commit secrets. Keys, the service-account JSON, and the Google Sheet ID live in .env (listed in .gitignore).
- Never commit real contact data. Sheet contents (names, emails, phone numbers, alumni rows) stay in the sheet. The repo holds sample data only, in data/sample/.
- The Google Sheet is the source of truth. The app reads it via Google sign-in (OAuth) and writes only to log tabs (Outreach_Log, Event_Attendance, Relationships, Assignment_Log, Tasks, Approval_Log) plus one core field: the Owner column on Contacts and Organizations (assigning). Every Owner change is recorded in Assignment_Log. All other core fields are edited in the sheet by design.
- Read sheet columns by header name, never by position.
- Plain stack: Node + Express backend, plain HTML/CSS/JS frontend, no framework, no build step, unless I say otherwise.
- Before saying "done", run the app and tell me exactly how you verified it.
- Keep docs/index.html (Product Page = PRD + build log) up to date.
- If a task gets big or confusing, stop and propose a smaller slice.

- Supabase holds ONLY access facts: members (login, board name, role) and contact_access (Contact_ID, owner, approval, hold). Never put names, emails, phones or outreach in Supabase, and never write from Supabase back to the sheet.
- Chen Institute approvals: a reviewer (role `chen`) decides Yes/No on two tags, Outreach and Sponsorship. Each decision is a new Approval_Log row (the newest row wins); the app never edits Contacts.Approval. An Outreach decision also sets `contact_access.approval`, the only Supabase write in the app, made with the reviewer's own token. Any future sheet-to-Supabase sync must take approval from the newest Approval_Log row, not the Contacts column, or it will undo Chen decisions.
- Server calls to Supabase use the signed-in person's token with the publishable key, so RLS applies. Never use the secret key for reads: it skips RLS.
- Schema changes go in a new numbered file in migrations/, committed to git. Never edit a migration that has already been run.

## Rules from real mistakes
- Twice, a stale server still holding port 3000 served old code during a test. Before testing, check the port (`Get-NetTCPConnection -LocalPort 3000`) and stop any old process.
- A scripted (heredoc/sed) edit silently turned the login regex `\s+` into `s+`, and every sign-in failed. Use the Edit tool for anything with backslashes, regexes or template strings, then grep the changed line to confirm it.

## Shipping (public demo on Render)
1. Run locally as the host would: `$env:PUBLIC="1"; $env:PORT="3100"; npm start`. It must start with `DATA_SOURCE=sample` and refuse google/xlsx.
2. Rerun the security checks: no-login 401, Account B can't see C003's email (app and direct Supabase), 30 AI calls hit 429, secret-key grep of repo and history is clean, `npm audit --omit=dev` has no high-severity issues.
3. Commit, then `git push` to main. Render auto-deploys from main (render.yaml). New schema: add `migrations/00N_*.sql` and ask me to run it in the Supabase SQL Editor before pushing code that needs it.
4. Verify the live site: open it at phone width, sign in, find a firm, open a contact, log an outreach; then rerun the 401 / RLS / 429 checks against the live URL and grep the live page source for secret keys.
5. Rollback: in Render, Events → pick the last good deploy → Rollback (or `git revert` the bad commit and push).

## Ask me first
- Deleting data or changing the database: any SQL that drops, deletes, updates or alters; running migrations; editing the Google Sheet outside the log tabs and Owner; `npm run dedupe` without dry run.
- Keys, secrets and permissions: creating, rotating, reading out or pasting any key; changing .env or Render env vars; Supabase Auth settings, grants or RLS policies; Google OAuth scopes or sharing.
- Anything that costs money: paid plans, OpenRouter credit limits, new paid APIs.
- Force-push, rewriting git history, or deploying anything other than DATA_SOURCE=sample publicly.

## Weekly build (due Monday noon)
- Add a build-log entry to docs/index.html: what shipped, what broke, what it cost (tokens, API, hosting, hours), what is next.

## Prior work
- docs/prior-work/ holds the design summary of an earlier Google Apps Script version. Reuse its data model and feature decisions; do not reuse its architecture.

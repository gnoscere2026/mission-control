# Deploy Runbook — Railway (Phase 0)

Everything in this file requires **Mark's accounts/devices** (GitHub, Railway, SMTP, the iPhone). All code, tests, and CI are already in the repo; this is the one-time provisioning checklist plus the Phase-0 exit-criteria drill.

## 1. GitHub

1. Create the GitHub repo and push: `git remote add origin <repo-url> && git push -u origin main`.
2. CI (`.github/workflows/ci.yml`) runs typecheck, lint, clean-Postgres migration apply, drift check, and tests on every push/PR. Optionally protect `main` on the `ci` check.

## 2. Generate secrets (local, once)

```sh
npx web-push generate-vapid-keys        # → VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
# SESSION_SECRET: any random string ≥32 chars (e.g. `openssl rand -base64 33`)
# SESSION_PASSWORD: the secret you'll type at /login
```

## 3. SMTP credentials

Any SMTP relay works (the mirror is ~plain text to your own inbox). Easiest: a Gmail **app password** (Google Account → Security → 2-Step Verification → App passwords) with `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=<gmail address>`, `SMTP_PASS=<app password>`.

## 4. Railway project

1. New project → **Deploy from GitHub repo** (this repo).
2. Add **PostgreSQL** (must be a pgvector-capable image — Railway's standard Postgres ships pgvector; migration 0000 runs `CREATE EXTENSION IF NOT EXISTS vector` and fails loudly if not) and **Redis**.
3. Create two services from the same repo:
   - **web** — Settings → Config-as-code file: `railway/web.json`
   - **worker** — Settings → Config-as-code file: `railway/worker.json`
4. Set env vars on **both** services (web also needs the `NEXT_PUBLIC_*` ones at build time):

   | Var | Value |
   |---|---|
   | `DATABASE_URL` | reference Railway Postgres (`${{Postgres.DATABASE_URL}}`) |
   | `REDIS_URL` | reference Railway Redis |
   | `SESSION_SECRET` / `SESSION_PASSWORD` | from step 2 |
   | `USER_EMAIL` / `USER_NAME` | `mark.l.gallen@gmail.com` / `Mark` |
   | `TOKEN_SEAL_KEY` | leave empty until MC-101 |
   | `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM`, `MAIL_TO` | from step 3 |
   | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | from step 2; subject `mailto:mark.l.gallen@gmail.com` |
   | `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | same as `VAPID_PUBLIC_KEY` |
   | `NEXT_PUBLIC_APP_URL` | the web service's public URL |
   | `APP_URL` (worker) | same public URL (used in push payload links) |

5. One-time DB seed: `railway run -s web npm run db:seed` (or run the SQL insert in the Railway Postgres console).
6. Deploy = push to `main`. Web's `preDeployCommand` applies migrations (idempotent, journal-tracked).

## 5. Verify the deploy

- `GET https://<web-url>/api/health` → `{"ok":true}` (the probe pings Postgres).
- Worker logs show: `worker up — owner=… queues=[ingest, extraction, reconciliation, briefs, notify] schedulers=[morning-brief-tick]`.
- Log in at `/login`, open `/runs` (empty is fine on first deploy).

## 6. iPhone PWA install (push requires home-screen install on iOS ≥16.4)

1. Open the web URL in **Safari** on the iPhone → log in.
2. Share → **Add to Home Screen** (Settings page shows these instructions on iOS).
3. Open the installed app → Settings → **Enable push** → accept the permission prompt.
4. Desktop Chrome: same Settings page, Enable push directly.

## 7. Phase-0 exit-criteria drill (BUILD-PLAN)

1. **7 AM delivery:** next morning at 7:00 AM MT a push lands on the installed PWA *and* the mirror email arrives. (Impatient path: `railway run -s worker npm run trigger:brief -w apps/worker` — same jobId/dedupe semantics.)
2. **Idempotency:** trigger the brief, kill the worker service mid-run, redeploy/restart, trigger again — `briefs` has exactly one row for today (`dedupe_key = morning:<date>`), no duplicate email.
3. **Failure visibility:** temporarily set a bogus `SMTP_HOST` on the worker, trigger the brief — `/runs` shows the `notify` run red with the SMTP error; restore the var, use the retry path.
4. **CI green on main; deploy is `git push`.**

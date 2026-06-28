# Admin provisioning console — Cursor handoff

In-app console that lets an admin provision a Retell agent, check status,
activate, and set the call window **without the terminal**. Claude drives it
via Claude-in-Chrome; you (Cursor) just commit + deploy.

## Files added

| File | Purpose |
| --- | --- |
| `src/lib/admin.ts` | `ADMIN_EMAILS` allowlist + `requireAdmin()` session guard. |
| `src/app/api/console/provision/route.ts` | `POST` — validate (dryRun) or run `provisionRetellAgent`. |
| `src/app/api/console/status/route.ts` | `GET ?workspace=<name>` — agents, status, effective enroll tag. |
| `src/app/api/console/activate/route.ts` | `POST {workspace,dryRun?}` — runs `validateAgentActivation`, flips draft→active. |
| `src/app/api/console/call-window/route.ts` | `POST {workspace,start,end,runAt,gap,attempts}` — rewrites `agent_call_configs`. |
| `src/app/api/console/team-members/route.ts` | `GET` list admins · `POST {fullName,email,password}` create login + grant admin. |
| `src/app/admin/page.tsx` | The console UI (provision · manage-existing · team-members panels). |
| `supabase/migrations/0021_app_admins.sql` | `profiles.is_admin`, `is_app_admin()`, widened `user_org_ids()` for cross-org access, admin profile-read policy. |
| `src/types/database.ts` | `profiles` type updated with `is_admin`. |

These reuse the same `provisionRetellAgent` lib and `validateAgentActivation`
invariants as the CLI scripts and the headless endpoint — no behavior fork.

## Team members / admin access model

Admin status is **DB-backed** (`profiles.is_admin`) so admins can be added from
the console without a redeploy. `ADMIN_EMAILS` is only a **bootstrap**: any
listed email is treated as admin and self-healed into `profiles.is_admin` on
first console use, so the owner is always admin even on a fresh DB.

An app admin has **full access to every workspace, current and future**. The
migration widens the RLS helper `user_org_ids()` to return all org ids when
`is_app_admin()` is true; because every downstream policy derives from it, the
bypass cascades to workspaces, agents, configs, contacts, calls, and memory.

Adding a team member (full name + email + password) uses the Supabase Admin API
(service role) to create the auth user with the password pre-confirmed, then
sets `profiles.is_admin = true`. They can sign in immediately.

> Run migration `0021_app_admins.sql` in order with the others before deploy.

## Required env var

Add to the app environment (Vercel + local `.env.local`):

```
ADMIN_EMAILS=austin@upsurgecrmpros.com
```

Comma-separated, case-insensitive. If unset, every console route returns 403
(fail closed). No `PROVISION_API_KEY` is needed for this path — it's gated by
the signed-in session + this allowlist.

The routes also need the already-present provisioning env:
`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`CREDENTIALS_ENCRYPTION_KEY`, `NEXT_PUBLIC_APP_URL`.

## Why /api/console and not /api/admin

`src/middleware.ts` excludes `api/admin` from the session matcher (that path is
for the bearer-secret headless endpoint). Session-based routes must live
elsewhere, hence `/api/console/*`.

## Auth model

Every route calls `requireAdmin()`: `createServerClient()` reads the session →
checks the email against `ADMIN_EMAILS` → only then does it use
`createServiceClient()` for writes. The `/admin` page itself is not separately
guarded (it just calls the routes), so the protection is server-side on the API.

## Verify

`npm run typecheck` is clean. After deploy: sign in as an admin email, open
`/admin`, paste a spec, Dry-run, then Provision; connect CRM in the app;
Activate.

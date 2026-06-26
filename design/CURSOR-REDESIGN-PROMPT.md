# Cursor Task — Implement the UpSurge Workspace Redesign (UI only)

You are working in the UpSurge repo (Next.js 14 App Router + Tailwind, Supabase, a
separate BullMQ worker that places Retell AI voice calls). I need you to implement a
**front-end redesign only**. The visual + interaction spec is a finished, clickable
mockup already in the repo:

> **Visual source of truth:** `design/workspace-redesign-mockup.html`
> Open it in a browser and match it. It includes the light/dark toggle and the exact
> black + electric-blue theme, the left-rail navigation, and every sub-tab layout.

---

## 🚨 HARD CONSTRAINT — DO NOT TOUCH THE BACKEND / AUTOMATION LOGIC

This app runs **live outbound AI voice calls** on a cadence and writes results back to
CRMs. The calling engine, queue, scheduler, webhooks, and CRM adapters MUST keep working
**byte-for-byte the same**. This is a presentation refactor, nothing else.

**NEVER edit, move, rename, or change the behavior of any of these (read-only to you):**

- `src/lib/engine/**` — poller, caller, process-outcome, process-inbound, scheduler,
  cadence, outcome, tags, memory, reconcile, reconcile-health, pipeline-routing,
  crm-writeback, call-queue
- `src/lib/queue/**` — queues, connection, reschedule, sweeper, `workers/call.worker.ts`,
  `workers/poll.worker.ts`
- `src/lib/crm/**` — followupboss, highlevel, highlevel-oauth, index, types, url
- `src/lib/retell/**`, `src/lib/agents/**`, `src/lib/db/**`, `src/lib/supabase/**`,
  `src/lib/webhooks/**`, `src/lib/reporting/**`
- `src/lib/crypto.ts`, `src/lib/secure.ts`, `src/lib/authz.ts`, `src/lib/hhmm.ts`,
  `src/lib/task-config.ts`, `src/lib/pipeline-options.ts`, `src/lib/validation.ts`
- **All API route handlers** under `src/app/api/**` — do **not** change their logic,
  request params, or response shapes. The UI must keep calling them exactly as it does now.
- Any `*.test.ts`, anything under `supabase/`, and `.env.local`.

If something in the UI seems to need a backend change, **STOP and leave a `// TODO(austin):`
comment instead** — do not modify the backend to make the UI easier.

**Allowed to edit (front-end only):**

- `src/components/TopNav.tsx` (this becomes the new left rail / app shell)
- `src/components/ui.tsx` (shared primitives — extend, don't break existing exports)
- `src/components/workspace/WorkspaceOpsTab.tsx`
- `src/components/reporting/**` (KpiGrid, ReportingCharts, CallLog, types)
- `src/components/agent-form/**` (CallSettings, TaskSettings, PostCallWebhookSettings,
  HighLevelOpportunityFieldSettings, PipelineStageSettings, CadenceDayGapsEditor, types)
- `src/app/page.tsx` (workspaces list)
- `src/app/workspaces/[id]/page.tsx` (workspace detail)
- `src/app/agents/[id]/page.tsx` (agent detail)
- `src/app/workspaces/[id]/agents/new/page.tsx`
- `src/app/layout.tsx` (only to wire the theme attribute / font if needed)
- `tailwind.config.ts` and `src/app/globals.css` (theme tokens — see Theming below)

**Golden rule for the pages:** keep every `useState`, `useEffect`, `fetch(...)`, every
`/api/...` call, every payload you `POST`/`PATCH`, every save handler, and every data shape
**exactly as they are today**. You are only allowed to **re-arrange and restyle the JSX**
and lift navigation state. If you find yourself changing what gets sent to an endpoint,
you've gone too far — revert that part.

---

## What to build (match the mockup)

### 1. App shell — left-rail master/detail navigation
Replace the current top/side nav (`TopNav.tsx` / `PageShell`) with the fixed **264px left
rail** from the mockup so users reach any destination in one click:

- Brand mark + workspace switcher at top.
- **"Workspace"** section: `Dashboard`, `Operations`.
- **"Agents"** section: **auto-lists every agent in the workspace** with a live status dot
  (active / paused / draft), plus a **`+` button** to create one. The list is generated
  from the agents already fetched for the workspace — when a new agent is created, it must
  appear in the rail automatically (no hardcoding). Clicking an agent opens its detail view.
- Account footer (user + settings) at the bottom.
- Active item gets the electric-blue highlight + left accent bar.
- Collapse the rail under ~880px (see the mockup's media query) for small screens.

### 2. Dashboard — DO NOT change content
The reporting dashboard stays functionally identical (same filters, KPI tiles, "calls over
time" chart, call log). Only restyle it to the new theme. Keep `KpiGrid`,
`ReportingCharts`, `CallLog` and their data wiring intact.

### 3. Operations — reorganize into sub-tabs (no scrolling marathon)
Split today's single Operations page into in-page sub-tabs that swap the content container
below (don't navigate away): **Overview · Call queue · Schedule · Outcomes**. Everything
currently on the Operations tab must still be present — test call, operations scope,
last-poll info, the queue table, the schedule table with bulk-select + "queue calls now",
and the outcome taxonomy. Same buttons, same endpoints (`/api/workspaces/[id]/run`,
`/test-call`, `/queue-calls`, `/reporting`, `/agents`).

### 4. Agent detail — sub-tabs to kill the long scroll
The agent page currently stacks everything vertically. Break it into sub-tabs that change
the container below on the same page: **Overview · Call & Cadence · CRM & Integrations ·
Tasks & Automations · Call History**. Move the opportunity / pipeline-stage mapping into
**Tasks & Automations** so settings are no longer one endless scroll. Reuse the existing
components (`CallSettings`, `CadenceDayGapsEditor`, `TaskSettings`, `PostCallWebhookSettings`,
`HighLevelOpportunityFieldSettings`, `PipelineStageSettings`) — just place them inside the
right sub-tab. Keep all their props, save handlers, and `/api/agents/[id]*` calls unchanged.
Keep the Duplicate action wired to `/api/agents/[id]/duplicate`.

---

## Theming — black + electric blue, with a light/dark toggle

Implement real theming (the mockup shows the exact palette and the toggle):

- Electric blue accent `#0A84FF` is the single brand color (buttons, active nav, links,
  focus rings, charts, brand gradient `135deg #0a6bff → #22b3ff`).
- **Light** = white surfaces, near-black text (`#0a0e17`), electric blue.
- **Dark** = true-black background (`#0b0d11`), raised charcoal cards (`#1a1d25`), white
  text, electric blue.
- A **toggle in the top bar** (sun/moon) flips the whole app.

**Recommended implementation (cleanest for this codebase):**
1. In `globals.css`, define semantic CSS variables for both themes under `:root` and
   `html[data-theme="dark"]` (copy the variable values straight from the mockup's
   `<style>` block — they're already tuned). Include `color-scheme`.
2. In `tailwind.config.ts`, set `darkMode: ['selector', '[data-theme="dark"]']` and point
   the existing `brand` / `ink` / `accent` / surface colors at the CSS variables (e.g.
   `brand: { 500: 'var(--brand-500)', ... }`) so existing utility classes re-theme
   automatically. Where components hardcode `bg-white`, swap to a token-backed class (e.g.
   `bg-[var(--surface)]`) so dark mode actually flips.
3. Add the toggle to the shell; set `data-theme` on `<html>` and **persist the choice**
   (the mockup uses in-session state; in the real app use `localStorage` + an inline
   no-flash script in `layout.tsx` to set the attribute before paint). Status colors
   (green active / amber paused / red terminal) stay meaningful in both modes.

Do not break any existing `ui.tsx` exports — `Button, Input, Select, Label, Card, Badge,
StatusBadge, IconBadge, StatTile, SectionHeader, Segmented, Pill, Tabs, EmptyState,
Skeleton, PageGreeting, InsightPanel, cn`. Other files import these.

---

## Acceptance criteria

- Visual + interaction parity with `design/workspace-redesign-mockup.html`, including the
  working light/dark toggle and the black + electric-blue palette.
- Left rail auto-lists agents and updates when one is created; every screen is ≤ 1–2 clicks.
- Dashboard content unchanged; Operations and Agent settings are organized into in-page
  sub-tabs with **zero functionality removed** — every field, button, and table that
  exists today is still present, just relocated.
- **Not a single change** to backend logic, queue/worker behavior, Retell calling, CRM
  adapters, webhooks, or any `/api` request/response contract. `git diff` should show only
  front-end files (the "Allowed to edit" list) plus `tailwind.config.ts` / `globals.css`.
- `npm run typecheck` passes. `npm run build` succeeds.
- `npm run dev` renders all three areas (Workspaces list, Workspace dashboard/operations,
  Agent detail) in both themes with no console errors.

## How to verify you didn't touch the backend
Run `git status` / `git diff --stat` and confirm **no files under** `src/lib/engine`,
`src/lib/queue`, `src/lib/crm`, `src/lib/retell`, `src/lib/webhooks`, `src/app/api`, or
`supabase/` are modified. If any are, revert them.

Work incrementally: (1) theme tokens + toggle, (2) app shell / left rail, (3) Operations
sub-tabs, (4) Agent sub-tabs. Typecheck after each step.

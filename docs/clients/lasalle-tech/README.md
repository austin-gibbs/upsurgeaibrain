# LaSalle Tech — "Drew" outbound admissions agent (build + runbook)

Outbound AI admissions assistant ("Drew") for LaSalle Tech, in its own UpSurge workspace,
calling prospective students **once per day for 5 days**, **9am–6pm ET**, to build rapport,
confirm program interest, answer light questions, and **book an admissions appointment**.
Booking calendar is chosen by the contact's **campus** (Plant City books live via Cal.com;
Houma/Baton Rouge hand off to a campus admissions rep until their calendars are added).

## Files in this folder

- `drew-agent-prompt.md` — the canonical Retell prompt + begin message (source of truth).
- `provision-spec.json` — spec for the `/admin` console (or `npm run provision:agent`) that
  creates the **LaSalle Tech** workspace + Drew agent + call config + new phone number.
- `cal-com-functions.json` — the two Cal.com tools (check availability + book) to add to
  Drew's Retell LLM for Plant City, with placeholders for the Cal.com credentials.

## What's automated vs. what's manual

The UpSurge provisioner creates the workspace, the Retell LLM + agent, the phone number,
and the call config. Two things it does **not** do and are wired afterward:

1. **Cal.com booking functions** (Plant City) — added to Drew's Retell LLM after creation.
2. **HighLevel field injection** (interested campus/program → prompt variables) — needs the
   engine change below deployed, plus HighLevel connected.

## Engine change shipped in this branch (deploy via Cursor)

To pull HighLevel custom fields into the prompt as `{{...}}` dynamic variables, this branch
adds a strictly-additive, non-breaking enrichment:

- `src/lib/crm/types.ts` — new optional `getContactFieldValues?(contactId)` on `CrmAdapter`.
- `src/lib/crm/highlevel.ts` — implements it: reads the contact's standard + custom fields
  and returns a flat `slug → value` map. Each custom field is exposed under its **fieldKey
  slug** and its **name slug** (e.g. `houma_interested_program`, `baton_rouge_interested_programs`,
  `plant_city_interested_programs`, `location`).
- `src/lib/engine/caller.ts` — merges those values into the Retell dynamic variables. Base
  identity/memory variables win on collision; any failure is swallowed so a dial never breaks.

Typecheck passes (`npm run typecheck`). **Commit + push from Cursor and deploy to Vercel**
(the Cowork sandbox can't push). Until deployed + HighLevel connected, the campus/program
variables resolve empty and Drew simply asks for them conversationally (the prompt handles
the empty case).

## HighLevel custom-field injection — root cause + fix (2026-07-06)

Symptom: on a test call Drew knew the contact's name but not their **interested campus** or
**program**. Diagnosis (from the Retell test call's `retell_llm_dynamic_variables`): the values
DO reach Retell, but keyed by **raw HighLevel field id** (e.g. `ujhzwirtpqf2jyqzpl7p` =
"Plant City, Florida", `xuo9b07dm3iqirah0ecf` = "Medical Assistant") instead of readable names —
so `{{location}}` / `{{plant_city_interested_programs}}` render empty. The name resolves because
it's a hardcoded base variable.

Cause: `getContactFieldValues` maps field id → readable name via `loadContactFieldDefs()`
(`GET /locations/{id}/customFields`), which needs the **`locations/customFields.readonly`** OAuth
scope. That scope was missing from `src/lib/crm/highlevel-oauth.ts`, so the definitions call 401s
and every custom field falls back to its raw id.

Fix (shipped in this branch): added `locations/customFields.readonly` to the OAuth scopes.
**Deploy via Cursor, then RECONNECT HighLevel** in the app so the new token carries the scope.
After that, the existing readable-name prompt resolves all four fields
(`{{location}}`, `{{houma_interested_program}}`, `{{baton_rouge_interested_programs}}`,
`{{plant_city_interested_programs}}`) with **no prompt change**.

Stopgap already applied (Retell prompt, no deploy needed): campus + Plant City program now also
reference the raw field ids (`{{location}}{{ujhzwirtpqf2jyqzpl7p}}`,
`{{plant_city_interested_programs}}{{xuo9b07dm3iqirah0ecf}}`) so the Plant City path works right
now; exactly one side resolves per state, so it stays correct after the scope fix. Houma + Baton
Rouge programs resolve once the scope fix is deployed + HighLevel reconnected.

## Cal.com booking — DONE (Plant City)

Copied the two Cal.com tools verbatim from the existing Retell agent **"LaSalle Tech | Drew"**
into the new agent's LLM: same **event type id 3159259** and same `cal_live_...` keys, so
bookings land on the same Plant City calendar. Tools named `check_availability` /
`book_appointment` to match Drew's prompt (see `cal-com-functions.json`).

## What I still need from you

1. **Deploy the OAuth-scope change** (Cursor → commit/push → Vercel) **then reconnect HighLevel**
   so campus + all three program fields resolve by name for every campus.
2. **Houma + Baton Rouge** Cal.com calendars (event type IDs) whenever they're ready — then
   Drew books live for those campuses too (today they hand off to a human rep).

## Live runbook (in order)

1. **Deploy the engine change** (Cursor → commit/push → Vercel).
2. **Provision** Drew + the workspace: `/admin` console → paste `provision-spec.json` →
   Dry-run, then Provision. (Lands as **draft** — no CRM yet, by design.)
3. **Add Cal.com tools** to Drew's Retell LLM using `cal-com-functions.json` (once you send
   the Cal.com key + Plant City event type id).
4. **Connect HighLevel** to the LaSalle Tech workspace in the app.
5. **Verify field keys** via `GET /api/console/highlevel` + a test contact; adjust prompt
   variable names if a key differs from the assumed slug.
6. **Activate** Drew via the console (`POST /api/console/activate`).
7. **Test**: tag a test contact with `lasalleadmissions` (the agent enroll tag) in HighLevel,
   run the worker in-window, and confirm the call, the campus/program injection, and (Plant
   City) a live Cal.com booking.

## Key settings (from the spec)

| Setting | Value |
| --- | --- |
| Workspace / Org | LaSalle Tech / LaSalle Tech |
| Timezone | America/New_York (EST). Note Houma/Baton Rouge are Central — 9–6 ET = 8–5 CT there |
| Agent | "LaSalle Tech \| Drew AI Agent", outbound |
| Agent enroll tag | `lasalleadmissions` |
| Cadence | 1 call/day × 5 consecutive days, then 1 call/month × 12 months (`cadence_day_gaps:[1,1,1,1,1,30]`, `max_attempts_per_contact:17`) |
| Call window | 09:00–18:00, all 7 days (so the 5-day run isn't broken by a weekend) |
| Phone | new Retell number, area code 985 (Houma) |
| Voice | 11labs-Adrian (swap in dashboard if desired) |
| CRM | HighLevel (connect after provisioning) |

## Campuses & programs (for reference; from lasalletech.edu)

- **Houma, LA (Main)** — Cosmetology (1500h), Manicuring (600h), Esthetics (750h), Instructor Training (600h)
- **Baton Rouge, LA** — Cosmetology (1500h), Manicuring (600h), Esthetics (750h)
- **Plant City, FL** — Cosmetology (1200h), Barber Stylist (1200h), Esthetician (260h), Full Specialist (605h), Medical Assistant–Hybrid Online (900h)

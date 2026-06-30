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

## What I still need from you

1. **Cal.com**: an API key for the Plant City Cal.com account + the **Plant City event type
   ID** (so I can wire `check_availability` / `book_appointment`).
2. **Houma + Baton Rouge** Cal.com calendars (event type IDs) whenever they're ready — then
   Drew books live for those campuses too.
3. **Connect HighLevel** to the LaSalle Tech workspace in the app (you do this step).
4. **Confirm the HighLevel custom-field keys** for interested campus + per-campus program so
   the prompt variable names line up exactly (I'll verify via the console once connected).

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
| Cadence | 1 call/day × 5 consecutive days (`cadence_day_gaps:[1]`, `max_attempts_per_contact:5`) |
| Call window | 09:00–18:00, all 7 days (so the 5-day run isn't broken by a weekend) |
| Phone | new Retell number, area code 985 (Houma) |
| Voice | 11labs-Adrian (swap in dashboard if desired) |
| CRM | HighLevel (connect after provisioning) |

## Campuses & programs (for reference; from lasalletech.edu)

- **Houma, LA (Main)** — Cosmetology (1500h), Manicuring (600h), Esthetics (750h), Instructor Training (600h)
- **Baton Rouge, LA** — Cosmetology (1500h), Manicuring (600h), Esthetics (750h)
- **Plant City, FL** — Cosmetology (1200h), Barber Stylist (1200h), Esthetician (260h), Full Specialist (605h), Medical Assistant–Hybrid Online (900h)

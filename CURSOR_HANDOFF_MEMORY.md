# Cursor Handoff — Agent Memory: Remember Personal / Rapport Details

_Generated 2026-06-22. Describes work already written into this working tree
(uncommitted). Cursor opens the same folder, so the files below are already
present — nothing pushed to GitHub yet._

---

## Paste this into Cursor to get oriented

> I'm continuing work on UpSurge. The AI voice agent keeps a per-(agent×contact)
> rolling memory so it can continue a relationship across calls instead of
> starting cold. It was forgetting **personal** details: in a test the contact
> said "I'm going to my karate class," the agent acknowledged it, but on the next
> call the agent knew it was a returning contact yet had no memory of karate.
>
> The memory code lives in `src/lib/engine/memory.ts` (READ path
> `buildDynamicVariables`, WRITE path `updateMemoryAfterCall`, plus
> `summarizeForMemory` / `extractFacts`). Storage is the `agent_memory` table:
> a rolling lossy `summary` (text) and a durable merge-forward `facts` (jsonb).
>
> Two code changes are already in the tree (uncommitted): the fact schema and the
> LLM prompts were generalized so personal/rapport details (hobbies, family, life
> events, preferences, small-talk hooks) are captured alongside the existing
> probate/business fields. My remaining steps: (a) set `ANTHROPIC_API_KEY`,
> (b) confirm the Retell agent prompt actually reads the memory variables, then
> (c) re-run the karate test. Don't place real outbound calls beyond agreed testing.

---

## Why karate was forgotten (root cause)

The symptom — agent knows you're a returning contact but forgets what you said —
comes from three independent causes:

1. **`ANTHROPIC_API_KEY` is not set.** This is the dominant cause.
   - `extractFacts()` short-circuits: `if (!process.env.ANTHROPIC_API_KEY) return prior;`
     → the `facts` object **never updates** and stays `{}` forever.
   - `summarizeForMemory()` falls back to a thin deterministic string built only
     from the call outcome + Retell's own generic call summary. "Karate" only
     survives if Retell's summary happened to mention it (it usually won't).
   - But `is_returning_contact` / `prior_call_count` derive from the integer
     `call_count`, which needs **no LLM** — so "we've spoken before" keeps working
     while everything else is blank. That's the exact asymmetry observed.

2. **The schema was probate-only.** `FACT_KEYS` and the extraction prompt were
   hardcoded to probate fields with "Allowed keys ONLY" — a hobby like karate had
   nowhere to live and was dropped even when extraction ran. **(Fixed below.)**

3. **Replay depends on the Retell prompt.** The memory only influences a call if
   the Retell agent's prompt references `{{memory_summary}}` and `{{known_facts}}`.
   That's configured in the Retell dashboard, not this repo — verify it (step 2).

---

## What was changed in code (`src/lib/engine/memory.ts`)

1. **Split the fact schema into two reusable groups** and compose `FACT_KEYS` from
   them:
   - `PERSONAL_FACT_KEYS` (NEW, vertical-agnostic): `personal_interests`,
     `family_details`, `life_events`, `preferences`, `rapport_notes`.
   - `BUSINESS_FACT_KEYS`: the existing probate/qualification + logistics fields
     (`probate_status`, `executor_status`, `motivation`, `timeline`,
     `property_condition`, `repairs_needed`, `occupancy_status`,
     `realtor_involved`, `appointment_status`, `email`, `best_phone`,
     `best_call_window`, `emotional_tone`).
   - `FACT_KEYS = [...PERSONAL_FACT_KEYS, ...BUSINESS_FACT_KEYS]`.
   - Note: the old `important_family_details` key was folded into `family_details`.
     No data loss — `mergeFacts` spreads `...prior`, so any value already stored
     under the old key is preserved; it just stops being actively updated.

2. **Generalized `llmExtractFacts` prompt** — it now explicitly instructs the model
   to capture BOTH personal/rapport details (with the karate example called out)
   AND business/qualification details, instead of "calling about a probate /
   inherited property."

3. **Strengthened `llmSummarize` prompt** — it now leads with the personal
   connection (hobbies, family, life events, small-talk) and is told never to drop
   a personal detail the contact volunteered.

No interface/type changes; `FACT_KEYS` is only consumed inside `memory.ts`.
`npm run typecheck` / `npx tsc --noEmit` passes clean.

---

## Setup checklist (do these in order)

1. **Set `ANTHROPIC_API_KEY`.** Add it to `.env.local` (and Vercel + Railway for
   deploy — the WRITE path runs in the BullMQ worker on Railway, so it needs the
   key too, not just the Next.js app). Without it, fact extraction is a no-op and
   the summary is the thin deterministic fallback. Model already wired:
   `claude-haiku-4-5-20251001`.

2. **Verify the Retell agent prompt consumes memory.** In the Retell dashboard, the
   outbound agent's prompt must reference the dynamic variables this app injects
   (see `buildDynamicVariables` in `memory.ts`):
   - `{{memory_summary}}` — the rolling relationship note.
   - `{{known_facts}}` — JSON of the durable facts (includes the new personal keys).
   - `{{is_returning_contact}}`, `{{prior_call_count}}`, `{{contact_name}}`,
     `{{objective}}`, `{{attempt_number}}`.
   Suggested prompt snippet:
   > "If `{{is_returning_contact}}` is true, you've spoken before. Here's what you
   > remember: `{{memory_summary}}`. Known details: `{{known_facts}}`. Use personal
   > details (hobbies, family, life events) naturally to reconnect before getting
   > to business."

3. **Re-run the karate test with the RIGHT call mode.** Memory only flows on
   contact-based calls. The ad-hoc test (`placeTestCall`, the `{ toNumber }` branch
   of `POST /api/workspaces/:id/test-call`) **intentionally injects empty memory**
   (`memory_summary: "", known_facts: "{}"`). To exercise memory you must call a
   real CRM contact via the `{ contactId }` branch (`placeCall`), which loads the
   stored memory and writes it back through the `call_analyzed` webhook.

---

## How to test the fix end-to-end

1. Set `ANTHROPIC_API_KEY` (step 1) and update the Retell prompt (step 2).
2. Place a `{ contactId }` test call to yourself; mention a hobby ("I do karate").
3. Let the call complete so Retell fires `call_analyzed` → `process-outcome.ts` →
   `updateMemoryAfterCall`. Confirm the `agent_memory` row for that
   (agent_id, contact_id): `facts.personal_interests` ≈ "karate" and `summary`
   mentions it.
4. Place a second `{ contactId }` call to the same contact. The agent should open
   by referencing karate.

Quick DB check (service role / Supabase SQL):
```sql
select call_count, summary, facts
from agent_memory
where agent_id = '<agent>' and contact_id = '<contact>';
```

---

## Files

**Modified (this work)**
- `src/lib/engine/memory.ts` — split `FACT_KEYS` into `PERSONAL_FACT_KEYS` +
  `BUSINESS_FACT_KEYS`; generalized the extract + summary prompts.

**Read for context (unchanged)**
- `src/lib/engine/caller.ts` — `placeCall` loads memory; `placeTestCall` injects empty memory.
- `src/lib/engine/process-outcome.ts` — calls `updateMemoryAfterCall` in the webhook path.
- `docs/V2-MEMORY.md` — memory design doc.

---

## Notes / follow-ups

- **The key is the unlock.** Items 2 and 3 of the root cause are fixed in code, but
  nothing improves until `ANTHROPIC_API_KEY` is set in BOTH runtimes (Vercel app +
  Railway worker). The WRITE path that records memory runs in the worker.
- **Probate behavior preserved.** Personal keys are additive; every existing
  business/probate field still extracts exactly as before.
- **Cost.** Each completed call now makes up to 2 Haiku calls (summary + facts).
  Haiku is cheap, but it's per-call — fine at current volume.
- **Git state.** Uncommitted, same as the routing/OAuth work. `origin` =
  `git@github.com:austin-gibbs/upsurgeaibrain.git`, branch `main`. Decide whether to
  commit this memory change on its own focused commit (recommended) separate from
  the pipeline-routing/OAuth changeset.

# Best-Performing Retell Voice-Agent Settings & Voice — Research Report

**Goal:** make the Policy PathFinder agent (outbound + inbound callback, insurance live-transfer) sound maximally human and convert as well as possible. This is a synthesis of deep research across Retell's official docs, provider docs (ElevenLabs, Cartesia, Deepgram, OpenAI), independent benchmarks, and practitioner guides. Compiled 2026-07-08.

> How to read this: the **hard, documented** recommendations are marked ✅. Values marked 🔧 are use-case-tuned judgment calls (Retell documents the parameter/range but not an exact "best" number) — good starting points to A/B. Anything **latency-adding** is marked 🐢 in Retell's own UI.

---

## TL;DR — the recommended stack

| Layer | Pick | Notes |
| --- | --- | --- |
| **Architecture** | Retell **cascaded** pipeline (not native speech-to-speech) | ~600ms is already in the "human" zone; keeps voice choice + cost control. Speech-to-speech (OpenAI Realtime) costs ~$20/hr and locks you out of custom voices. |
| **LLM** | **GPT-4.1** + **Fast tier ON**, reasoning OFF | Retell's own recommended default for real-time voice; best latency/quality/function-calling balance. **Avoid reasoning models (incl. GPT-5.x with reasoning)** — they add ~0.8–2s of dead air per turn. |
| **TTS voice engine** | **ElevenLabs Turbo/Flash v2.5** (most consistent) **or Cartesia Sonic** (lowest median latency + emotion control, cheaper) | Both sit comfortably under the 800ms budget; pick the actual *voice* by ear. |
| **Voice (persona)** | Start **warm female (Jessica)**, A/B a **warm male (Eric)** | Gender-conversion research is a near-wash (slight female trust edge); the specific voice + delivery matters more. Audition in Retell. |
| **STT** | **Deepgram Nova-3** (auto-selected for en-US) | Not the bottleneck; endpointing/turn-taking is the real lever. |
| **Target latency** | **< 800ms end-to-end, ~600ms ideal** | Below ~500ms feels human; over ~1.5s reads as a machine. |

---

## 1. Voice choice

**Provider quality:** ElevenLabs is the consensus naturalness leader (emotional expression, natural breathing, callers often can't tell in short interactions). Cartesia Sonic 3.5 is ranked #1 for naturalness in its own/partner benchmarks, at lower latency and lower cost, with built-in emotion control (Happy/Sympathetic/Calm) — an excellent primary **or** automatic fallback. Retell aggregates ElevenLabs, OpenAI, Cartesia, Minimax, Fish, and platform voices with automatic provider failover.

**Cost note:** ElevenLabs voices add ~$0.040/min on top of base; Cartesia/OpenAI/Minimax/Fish/Platform are ~$0.015/min. ([Retell pricing/blog](https://www.retellai.com/blog/best-voice-ai-providers))

**Specific voices to audition** (warm, eager, conversational US-English; confirm exact availability in *your* Retell voice picker):

- **Female:** **Jessica** (expressive, youthful, warm+energetic — top pick), **Laura** (upbeat, approachable), **Sarah** (energetic, professional). Runner-up: Aria.
- **Male:** **Eric** (friendly, approachable — top pick), **Charlie** (natural, relaxed, low-pressure), **George** or **Adrian**/`retell-Cimo` (more gravitas/trust for the insurance topic). Runner-up: Roger (watch it doesn't read "pushy").

**Male vs female:** small/nuanced. A University of Glasgow finding and industry sources give female voices a slight trust edge (relevant for cold homeowner outreach); an Adweek/Harris poll of 2,000+ US adults found gender "largely didn't make a difference" (~19% found female more persuasive, ~18% male, ~⅔ no difference). **Verdict: no reason to force a gender — A/B test one warm female + one warm male on your real list; the data decides.**

**Voice tuning (per-voice, by ear):** speed **1.0–1.05** 🔧, volume ~**0.8–1.0** 🔧, ElevenLabs **stability ~50** (lower = more expressive/human, higher = more consistent) 🔧, **similarity ~75** 🔧, **style 0** 🔧, `voice_temperature` **~1.0–1.2** 🔧 (higher = more expressive but adds TTS latency). Turn on **`enable_dynamic_voice_speed`** ✅ so the agent matches the caller's pace.

**How to audition:** Retell dashboard → agent **Voice tab** has instant preview; or `GET /list-voices` returns a `preview_audio_url` for every voice to batch-listen. Retell's own guidance maps the **"Sales: energetic, confident, friendly"** profile to your persona.

_Sources: [Best Voice AI Providers (Retell)](https://www.retellai.com/blog/best-voice-ai-providers), [List Voices API](https://docs.retellai.com/api-references/list-voices), [Cartesia Sonic](https://www.cartesia.ai/sonic), [ElevenLabs models](https://elevenlabs.io/docs/overview/models), [Voice selection lesson](https://community.retellai.com/t/lesson-13-voice-selection-customization/2931), [female-voice trust](https://www.debbiegrattan.com/blog/why-trust-female-voice-over-male-voices/), [gender near-wash](https://esbadvertising.com/advertising/radio/male-vs-female-voices-in-commercials-is-one-more-effective/)._

---

## 2. Retell settings — recommended values

> Retell's raw API defaults for `responsiveness` and `interruption_sensitivity` are **1** (max), and `enable_backchannel` defaults to **false**. The tuning below deliberately deviates for a "warm/eager but not trigger-happy" feel.

**Turn-taking & responsiveness**

- `interruption_sensitivity`: **0.8** ✅ (Retell's own noise-handling guide — reduces false interruptions from background speech while a real human can still cut in; go 0.9 only in very noisy environments).
- `responsiveness`: **~0.9** 🔧 (eager, responds quickly) + `enable_dynamic_responsiveness: true` ✅ (adapts turn-taking to the caller's pace — more human).
- Transcription/turn-taking mode: **"optimize for speed"** ✅ (lowest latency; switch to "accuracy" only when precisely capturing numbers/dates like a callback number).

**Backchanneling & disfluencies (the big humanizers)**

- `enable_backchannel`: **true** ✅ ("uh-huh"/"I see" during caller speech = active listening).
- `backchannel_frequency`: **0.8** ✅ (Retell default; drop to ~0.6 if chatty). Keep default `backchannel_words` per voice.
- Agent Handbook 🐢: `natural_filler_words: true` ✅ (adds "um/you know"), `conversational_personality: true` ✅ (shortens/rephrases to sound human), `speech_normalization: true` ✅ (speaks "$1,200" and "3/15" correctly).

**Ambient / background sound**

- `ambient_sound: "call-center"` at **volume ~0.3** 🔧 — Retell says it makes calls "more humanlike and engaging" and reinforces the "I'm a rep at a desk" frame. Keep it **subtle** or leave off; too loud is distracting (the low volume is a judgment call, not a documented number).

**Timing / call flow**

- `begin_message_delay_ms`: **~1000** 🔧 (a beat so the person finishes "hello" / gets the phone to their ear — prevents talking over the pickup).
- `reminder_trigger_ms`: **~8,000–10,000** 🔧, `reminder_max_count`: **1** 🔧 (nudge a silent caller once, don't badger).
- `end_call_after_silence_ms`: **~30,000** 🔧 (default is 10 min — far too long for outbound; end dead calls fast to save minutes).
- `max_call_duration_ms`: **~300,000 (5 min)** 🔧 (a transfer call rarely needs an hour).
- `ring_duration_ms`: ~30,000 (standard). `allow_user_dtmf: true`.

**STT / audio**

- `stt_mode: "fast"` ✅, ASR provider **auto (Deepgram Nova-3 for en-US)** — don't force it, `language: "en-US"` (single locale = best accuracy).
- `denoising_mode: "noise-cancellation"` ✅ (removes noise with negligible accuracy hit; use `noise-and-background-speech-cancellation` only for TV/construction-loud environments, +$0.005/min).

**Voicemail / recognition**

- `voicemail_option`: **enable** ✅ — `hangup` for a pure cadence, or `static_text`/`prompt` to leave a message (supports `{{variables}}`; our prompt already has a no-price voicemail line). Enable **IVR hangup** so answering-machine menus don't burn minutes.
- `boosted_keywords`: add brand/rep/city names (e.g., "Policy PathFinder", "American Family", target cities) to bias the transcriber — keep the list tight (adds a little latency). Add a **pronunciation dictionary** entry for any odd names.

**LLM**

- Model: **GPT-4.1** ✅ (Retell's recommended default; most-used across 40M+ calls/mo; best balance for a scripted transfer with one key tool call). A/B **GPT-4.1-mini** for cost only if the transfer tool-call reliability holds.
- `temperature`: **0.5–0.7** ✅ (Retell's own "engaging but focused" range for sales; drop to 0.1–0.3 for strict data capture).
- **Fast tier: ON** ✅ (~25% faster average response, 50% less latency variance, higher availability; "ideal for high-value/sales calls"; costs 1.5× model rate — worth it).
- **Structured output: ON** for the transfer/booking function (guarantees valid args).
- Keep the **prompt lean** (< ~8k tokens) — every token adds to time-to-first-token on every turn.

_Sources: [Create Agent API](https://docs.retellai.com/api-references/create-agent.md), [Configure basic settings](https://docs.retellai.com/build/single-multi-prompt/configure-basic-settings.md), [Handle background noise](https://docs.retellai.com/build/handle-background-noise.md), [Add backchannel](https://docs.retellai.com/build/interaction-configuration.md), [Transcription mode](https://docs.retellai.com/build/transcription-mode.md), [ASR providers](https://docs.retellai.com/build/asr-providers.md), [Handle voicemail](https://docs.retellai.com/build/handle-voicemail.md), [LLM options](https://docs.retellai.com/build/llm-options.md), [Troubleshoot latency](https://docs.retellai.com/reliability/troubleshoot-latency.md)._

---

## 3. Latency (drives "human-ness" more than the voice does)

Human turn gaps average ~200ms; under ~500ms feels natural, over ~1.5s reads as a machine. Retell's default end-to-end is ~600ms with a target band ~800ms. **Levers, biggest first:** (1) fast-tier **GPT-4.1**, reasoning off; (2) lean prompt/knowledge base; (3) low-latency TTS (ElevenLabs Turbo/Flash v2.5 or Cartesia Sonic); (4) fast transfer webhook — a slow tool call stalls the turn (configure a "one moment…" filler during tool calls); (5) a phone number geographically near the callee; (6) tune endpointing (~500–600ms) rather than accepting defaults; (7) watch the 🐢 turtle-icon features and keep estimated latency < 1.5s.

_Sources: [Why low latency matters (Retell)](https://www.retellai.com/blog/why-low-latency-matters-how-retell-ai-outpaces-traditional-players), [Best LLM for Voice AI (Retell)](https://www.retellai.com/blog/best-llm-for-voice-ai-agents), [TTS latency benchmark 2026](https://gradium.ai/content/tts-latency-benchmark-2026), [The 300ms rule (AssemblyAI)](https://www.assemblyai.com/blog/low-latency-voice-ai)._

---

## 4. Prompt & behavior for human-likeness (Retell + Vapi both say the same)

**Do:** natural **contractions**; **1–2 sentence** turns; **one question at a time**; **spell numbers/dates/digits** in spoken form (`4158923245` → "four one five - eight nine two - three two four five"); add **deliberate disfluencies** (um, "let me see", light self-corrects) with a **self-monitoring line** ("if a turn comes out perfectly polished with no disfluency, add a filler and try again"); **empathy/mirroring**; **adapt pace to caller type** (crisp for busy, warmer for chatty); **handle barge-in** ("caller interrupts → stop, listen, respond"); handle **silence/hold** (`NO_RESPONSE_NEEDED` stop-sequence, or "when they say hold on, simply don't respond").

**Warm + eager without pushy:** open with genuine low-pressure energy; **backchannel** to show you're eager to *listen*; react to what they say before advancing; frame the ask as helping ("I'd love to get you a quick answer — want me to connect you real quick?"); **always give an easy out** ("totally fine if now's not good — later today or tomorrow?").

**Don't:** no visual formatting/lists/markdown/URLs in speech; don't say "as an AI" unprompted; avoid long "never say X" banlists (each banned phrase is a token the model can over-sample — prefer short positive rules); don't over-use "haha".

> The current Riley prompt already does most of this (contractions, one-question, spoken digits guidance, consent-gated transfer, no-variable rule). The main upgrade would be an explicit **disfluency + self-monitoring** instruction and a **caller-type pacing** rule.

_Sources: [Prompt Engineering Guide (Retell)](https://docs.retellai.com/build/prompt-engineering-guide), [Prompt situation guide (Retell)](https://docs.retellai.com/build/prompt-situation-guide), [Speech Controllability (Retell)](https://docs.retellai.com/agent/speech-controllability), [Voice AI Prompting Guide (Vapi)](https://docs.vapi.ai/prompting-guide)._

---

## 5. What converts (outbound) — directional benchmarks

Vendor/aggregator-sourced, treat as ranges: **speed-to-lead is the #1 lever** — responding within 5 min ≈ **9× more likely to convert**; first responder captures 35–50% of the market. **Local caller ID ≈ 4× answer rate** (branded caller ID adds ~27%). Best windows ≈ **11am–12pm and 4–5pm local, Wed/Thu**; connects drop ~44% at lunch. **Multi-touch cadence** matters — many conversions aren't reached until the **6th+ attempt** (supports tiered cadences). Booking ≈ 6% of connected calls. Cold-call answer rate ≈ 28% (Baylor).

**Implications for UpSurge/American Family:** weight dials toward the 11–12 / 4–5 local windows within the 9–7 window; pursue **local/branded caller ID** (Retell supports Branded/Verified caller ID) — likely the single highest-ROI change for answer rate; keep the multi-attempt cadence.

_Sources: [Cold Calling Statistics (CloudTalk)](https://www.cloudtalk.io/blog/cold-calling-statistics/), [Local numbers impact (DialMyCalls)](https://www.dialmycalls.com/blog/impact-of-local-numbers-on-cold-calling), [Answer-rate benchmarks (Convoso)](https://www.convoso.com/blog/how-to-improve-call-answer-rates-benchmarks-caller-id-reputation-and-outbound-dialing-best-practices/), [TCPA playbook (Retell)](https://www.retellai.com/blog/tcpa-compliance-playbook-voice-ai-outbound)._

---

## 6. Recommended config to apply to the American Family "Policy PathFinder" agent

Current agent: voice **Cimo** (= "Adrian", young American male — a fine default), model **GPT 5.1**, mostly default settings.

**Highest-impact changes:**

1. **Switch model GPT-5.1 → GPT-4.1, Fast tier ON, reasoning OFF.** (Biggest latency/consistency win; GPT-5.1 reasoning risks dead air.)
2. **Audition and pick a warmer voice**, and A/B female vs male: start **Jessica** (female) vs **Eric** (male); keep Cimo as a third option.
3. **Enable the humanizers:** `enable_backchannel: true` (freq 0.8), Handbook `natural_filler_words` + `conversational_personality` + `speech_normalization` true, `enable_dynamic_responsiveness` + `enable_dynamic_voice_speed` true.
4. **Tune turn-taking:** `interruption_sensitivity 0.8`, `responsiveness ~0.9`, speed transcription mode, `denoising: noise-cancellation`, `begin_message_delay_ms ~1000`.
5. **Guardrail timeouts:** `end_call_after_silence_ms ~30000`, `max_call_duration_ms ~300000`, `reminder_trigger_ms ~8000` / `reminder_max_count 1`.
6. **Recognition:** `boosted_keywords` = ["Policy PathFinder","American Family","cabin", target city names]; enable voicemail detection + IVR hangup.
7. **Prompt tweak (optional):** add a disfluency + self-monitoring line and a caller-type pacing rule.
8. **Ops (outside the agent):** pursue **local/branded caller ID**, and weight dialing toward 11–12 / 4–5 local windows.

```
# Starting config
LLM:            GPT-4.1, fast_tier: ON, reasoning: OFF, temperature: 0.6, structured_output: ON
voice:          A/B Jessica (F) vs Eric (M)  [engine: ElevenLabs Turbo/Flash v2.5, or Cartesia Sonic]
voice_speed:    1.0   (enable_dynamic_voice_speed: true)
voice_temperature: 1.1
interruption_sensitivity: 0.8
responsiveness: 0.9   (enable_dynamic_responsiveness: true)
enable_backchannel: true   (backchannel_frequency: 0.8)
handbook:       natural_filler_words: true, conversational_personality: true, speech_normalization: true
ambient_sound:  call-center  (volume ~0.3)   # optional/subtle
stt_mode:       fast          denoising_mode: noise-cancellation      language: en-US
begin_message_delay_ms: 1000
reminder_trigger_ms: 8000     reminder_max_count: 1
end_call_after_silence_ms: 30000     max_call_duration_ms: 300000
voicemail_option: enabled (hangup or static_text)     ivr: hangup
boosted_keywords: ["Policy PathFinder","American Family","cabin", <city names>]
```

---

## Caveats / things to verify live

- Exact numeric values marked 🔧 (responsiveness 0.9, reminder 8s, silence 30s, max 5min, ambient volume 0.3, voice_temperature 1.1) are use-case-tuned recommendations — Retell documents the parameter/range/default but not a single "best" number. The **hard documented** ones are `interruption_sensitivity 0.8`, `backchannel_frequency 0.8` default, LLM temp **0.5–0.7** for sales, and **GPT-4.1** as the recommended model.
- Specific ElevenLabs voice names (Jessica/Eric/etc.) come from ElevenLabs' library/aggregators — confirm each appears in *your* Retell voice picker (BYOK/ElevenLabs access affects availability). No authoritative public Retell "recommended voices" list exists beyond the showcase "Adrian"/`retell-Cimo`; get exact IDs from `GET /list-voices` or the dashboard.
- Benchmark conversion figures are vendor/aggregator-sourced — directional ranges, not guarantees. Retell's own guidance: benchmarks don't predict phone outcomes — **A/B on real traffic** (e.g., GPT-4.1 vs one alternative, one voice vs another, for a week) and compare transfer success + how natural it sounds.
- Retell rotates its model list and voice roster frequently — verify the live dropdown when you apply this.

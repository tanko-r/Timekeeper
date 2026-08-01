# AI narrative voice — design

**Date**: 2026-08-01
**Status**: approved, ready to plan
**Supersedes**: the narrative-prompt portions of
`2026-07-06-timekeeper-design.md` §6

## Problem

The AI-assisted narratives invent too much, run far too long, and read as
filler rather than substance. The complaint in David's words: less
*"correspondence with client by email or other electronic means"*, more
*"compose message to client with commentary xyz"*.

### Measured baseline

357 imported historical narratives in `entries` are the ground truth for the
house voice:

| | words |
|---|---|
| p10 | 4 |
| **p50** | **11** |
| p90 | 29 |
| max | 95 |

Running the prompt currently saved in `settings.ai.systemPrompt` against the
brief `draft psa; review loi; email w client; email w title co` produced:

> Review and analyze letter of intent to identify key terms and conditions for
> Purchase and Sale Agreement; draft Purchase and Sale Agreement to comport
> with LOI requirements; compose message to client regarding drafting and deal
> points; transmit draft PSA to title company for review and feedback.

**40 words against a median of 11**, and it invented a purpose ("to identify
key terms and conditions"), an outcome ("for review and feedback"), and a
fact never stated (that the PSA was sent to the title company).

### Root causes

1. **The saved prompt contradicts itself.** It says *"Make reasonable
   conjecture about the content of each task"* and four lines later *"do not
   invent facts, names, or documents."* A small model resolves a contradiction
   by padding.

2. **The prompt's worked example *is* the verbose style.** An 8B model imitates
   an in-context example far more strongly than it obeys a prose rule. The
   example teaches exactly the register the rules forbid.

3. **Negative rules backfire.** Empirically confirmed during design: a
   prototype that listed forbidden phrases produced them verbatim. Naming a
   string in the prompt makes the model more likely to emit it, not less. The
   same run invented a person named "J. Smith" — the placeholder used in the
   rule about name formatting.

4. **No abbreviation authority.** `psa` expanded to "Property Settlement
   Agreement" in a real-estate practice where it means Purchase and Sale
   Agreement.

### Validated direction

A prototype using positive-only rules, quality-filtered real narratives as
style exemplars, and four `shorthand → narrative` few-shot pairs produced
16 / 13 / 10 / 9 / 13 words across five test briefs — median 13 against a
target of 11, with no purpose clauses and no invented facts.

## Design decisions

David chose, during design:

- **The model should still make conjectures**, just cheap ones. Guesses that
  add a *subject* ("regarding escrow" — two words, one word to fix if wrong)
  are useful. Guesses that add a *purpose* ("to identify key terms") are
  filler. Billing narratives name what work touched, never why it was done.
- **Voice is learned from real entries pulled live**, not from handwritten
  rules or frozen examples.
- **AI output must not feed back in as "David's voice."** Flagged and excluded.

## Architecture

```
                    ┌──────────────────────────────┐
   SHORTHAND   ────▶│   buildNarrateMessages()     │
                    └───────────────┬──────────────┘
        ┌───────────────┬───────────┴────┬──────────────────┐
        ▼               ▼                ▼                  ▼
  ┌──────────┐   ┌────────────┐   ┌────────────┐   ┌──────────────┐
  │  RULES   │   │  GLOSSARY  │   │ EXEMPLARS  │   │  MATTER CTX  │
  │ positive │   │ shortcuts  │   │ past       │   │ people +     │
  │ only     │   │ table      │   │ narratives │   │ phrases      │
  │ (new)    │   │ (exists)   │   │ (new)      │   │ (exists)     │
  └──────────┘   └────────────┘   └─────┬──────┘   └──────────────┘
                                        │ excludes narrative_ai = 1
                                        ▼
                              ┌────────────────────┐
                              │  FEW-SHOT PAIRS    │
                              │  6 fixed slots,    │
                              │  growing pool      │
                              └────────────────────┘
```

### 1. Positive-only rules

`DEFAULT_AI_INSTRUCTIONS` is rewritten so that **no rule names a string the
model must avoid**, and no rule contains a placeholder name. Constraints are
expressed as what to do:

- "Don't explain why the work was done" becomes *"State what the work touched:
  the document, the person, the subject. Stop there."*
- "Don't invent" becomes *"Every noun in your output must trace to a word the
  attorney wrote. Where the shorthand names no subject, leave it unnamed."*

Target length ~7 lines, down from ~20.

**`settings.ai.systemPrompt` must be replaced too.** The saved value shadows
the code default; changing only the default changes nothing in the running app.
The migration nulls the stale saved prompt so the new default takes effect,
leaving the Settings → AI editor working exactly as before for future edits.

### 2. Style exemplars — `server/lib/exemplars.js` (new, pure)

Six of David's real narratives, injected as samples of the target register.

**Quality gate.** The design prototype learned from a truncated entry
(`"…from R. Calder regarding;"`). An exemplar must:
- end in a period,
- have no dangling connector before terminal punctuation (`regarding;`,
  `with.`),
- be 6–40 words.

**Normalisation.** Strip leading matter tags (`(MTR09 – Cedar Lease)`,
`[MTR09]`) and time allocations (`(0.3)`) — neither belongs in generated prose,
and the format contract forbids the model emitting them.

**Selection.** Sort surviving candidates by length and take an even spread
across the range, so the model learns the *range* of lengths rather than one.

**Source.** Prefer the current matter, backfill from recent global. Always
`WHERE narrative_ai = 0`.

Pure function over rows, per the `server/lib/*` convention; the DB query lives
in the route.

### 3. Glossary injection

The existing `shortcuts` table (`abbrev` → `phrase`, 18 rows, already editable
in Settings) is injected as a lookup list. This is the primary tuning surface:
David corrects `psa` or `tc` by adding a row, not by editing prompt prose.
Keeps the prompt short and the control in data he owns.

Cap at 40 rows by most-recently-created to bound prompt growth.

### 4. Few-shot pairs — fixed slots, growing pool

Six `shorthand → narrative` exchanges appended as real chat turns (user /
assistant), which teach the *compression ratio* that no prose rule expresses.

**The slot count stays fixed at 6; the pool grows.** Prompt tokens are
processed before generation begins, so an unbounded prompt costs latency on
every request; and style few-shot hits diminishing returns fast — 4→8 helps,
8→40 dilutes.

Pool eligibility:
- narrative was written or corrected by David (`narrative_ai = 0`),
- an `ai_brief` was recorded,
- brief and narrative are not near-identical (no learning signal, and teaches
  the model to echo).

Selection from the pool: same matter first, then briefs sharing verbs with the
current brief, then spread across work types so six "review" examples don't
crowd out calls and drafting.

Bootstrap: four hand-authored seed pairs, displaced permanently once enough
real pairs exist.

**Accepted risk**: lightly-edited AI output enters the pool carrying mostly-AI
phrasing. It is text David signed off on, so it is a legitimate target; the
eval harness (§6) is the detector if quality drifts.

### 5. Data model

One migration appended to `MIGRATIONS` in `server/db.js`:

```sql
ALTER TABLE entries ADD COLUMN narrative_ai INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN ai_brief TEXT;
UPDATE settings SET value = json_set(value, '$.systemPrompt', '')
  WHERE key = 'ai';
```

- `narrative_ai` — 1 when AI text was accepted untouched; **0 the moment any
  character is edited**, and 0 for anything typed by hand.
- `ai_brief` — the shorthand that produced the narrative.

Existing rows default to `narrative_ai = 0`, correctly treating the 357
imported entries as David's own voice.

Together these turn daily editing into a labelled
`(shorthand → corrected narrative)` corpus — the prerequisite for the
fine-tuning phase.

### 6. Verification

**Unit tests** (`node:test`) on the pure module: quality gate rejects
truncated and over-long candidates; tag and allocation stripping; length
spread; near-identical pair filtering; pair diversity.

**Offline eval** — `scripts/ai-eval.mjs`, a fixed set of briefs through the
configured model, asserting:
- median output ≤ 16 words (baseline 40, target 11),
- no output contains purpose-clause markers (`in order to`, `to ensure`,
  `for review and approval`, `with a view to`),
- no output contains a time parenthetical.

Not part of `npm test` — it needs a live Ollama and takes minutes. It is the
regression check for prompt edits, and the yardstick a fine-tune must beat.

**E2E**: `node scripts/e2e-smoke.mjs` must stay green.

## Non-goals

- No change to the JSON task-split contract in `formatContract`.
- No new runtime dependency; `express` + `better-sqlite3` only.
- No change to `rankPhrases` / `matterAiContext`. Grounding context (name
  resolution) and style exemplars stay separate concerns.

## Phase 2 — fine-tuning (separate spec)

Deferred, but shapes the design above. ~350 real narratives is enough for a
LoRA on a 3–4B model, but the *pairs* it needs do not exist yet — hence
`ai_brief`. Likely shape: synthesise plausible shorthand for historical
entries, train a LoRA, and compare against this prompt on the §6 eval. The
expected win is latency (a 3B answers in seconds where `llama3.1:8b` takes
~30s+ on this CPU) more than quality. The eval harness must exist first;
otherwise there is no way to tell whether a fine-tune beat the prompt.

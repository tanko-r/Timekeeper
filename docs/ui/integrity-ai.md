# Data-integrity audit — AI prompt construction

**Area:** every builder that assembles a prompt for the local model.
**Branch:** `ui-overhaul-2026-08`. **Date:** 2026-08-15. **Read-only audit** —
no application source was changed.

**Proof file:** `test/integrity.ai.test.js` — 8 tests, 1 control (passes),
7 leak proofs (**all fail today, deliberately**). They are the regression
tests the brief demands; do not soften the assertions to make them green.

Suite state with the proof file in place: `npm test` → 656 tests, 634 pass,
22 fail. 7 of the failures are mine; the other 15 belong to the parallel
`integrity.entries` / `integrity.suggestions` audits. Nothing else fails.

---

## The short answers

**When the model is asked to write or rewrite a narrative, what goes into the
prompt?** Four blocks, built by `buildVoiceContext()` and `matterAiContext()`
in `server/routes/ai.js` and shared by all three AI paths (`POST /api/ai/expand`,
`POST /api/ai/narrate`, and the background `refineSuggestedNarrative`):

1. a **shortcuts glossary** (`abbrev → phrase`) — generic, correctly shared;
2. an **exemplar block** — six of the attorney's real finished narratives,
   pasted under the heading `The attorney's entries:`;
3. **few-shot pairs** — up to six real `(shorthand brief → finished narrative)`
   pairs, spliced in as actual `user`/`assistant` chat turns for the model to
   imitate;
4. a **matter context** block — the people roster and recent phrases, labelled
   `People from this matter's history` / `The attorney's recent work on this
   matter`.

**Where do they come from, and how are they scoped?**

| Block | Intended scope | Actual scope |
|---|---|---|
| Glossary | global (correct) | global — fine |
| Exemplars | same matter | **whole database** |
| Few-shot pairs | same matter, else synthetic | **whole database**; `cmId` is only a sort key |
| Matter context — people | this matter | this matter, then client siblings |
| Matter context — phrases | this matter | this matter, **then client siblings, relabelled as this matter's** |

**What happens when the matter has no examples?** It silently widens the net —
not to a synthetic fallback, but to the most recent real narratives in the
database, whoever they belong to. `SEED_PAIRS` (the hand-authored synthetic
pairs that exist for exactly this case) are only consulted *after* every
eligible real pair from every other client has been used. A brand-new matter
therefore gets the maximum dose of other clients' work, not the minimum.

**Is example text stored, cached, or reused across requests?** No in-process
cache: `buildVoiceContext()` re-queries on every call, and each Ollama request
carries its whole message list (no `context` handle, no session). But state
*does* survive a request in one place — `timers.suggested_narrative` — and
that is Leak 5 below.

**Does any AI-written narrative come back as an exemplar?** It is supposed to
be blocked by `narrative_ai = 1` (`server/routes/ai.js:161`), and the entry
editor and stop chips set that flag correctly. **Quick capture does not** —
Leak 6. Once such an entry is finalized it joins the exemplar pool, and
because that pool is global (Leak 1) the model's own sentence about matter A
is then taught to the model on every other matter in the database.

---

## Leaks

### Leak 1 — CRITICAL. The exemplar block is drawn from the whole database

`server/routes/ai.js:163-180`, `buildVoiceContext()`.

```js
const own = cmId == null ? [] : db.prepare(`… AND cm_id = ? … LIMIT 60`).all(cmId)…
const recent = db.prepare(`
  SELECT narrative FROM entries
  WHERE ${FINAL} …
  ORDER BY date DESC LIMIT 200          // ← no cm_id filter
`).all()…
const exemplars = pickExemplars(own.concat(recent), { count: 6 });
```

The second query has no matter and no client predicate. `pickExemplars()`
(`server/lib/exemplars.js:110-121`) then dedupes the union, sorts it by word
count and samples six *evenly across the length range* — it has no idea which
matter anything came from, so length alone decides. Whenever another client's
narratives sit at a length the current matter's do not cover, they are picked.

These are finished, client-facing sentences — parties, documents, subjects —
and they land in the prompt under the heading `The attorney's entries:`.

The only thing standing between them and the bill is a prose instruction
(`DEFAULT_AI_INSTRUCTIONS`, ai.js:38): *"Those entries show you how the
attorney writes. Take only their shape."* The file's own comment, ai.js:68-75,
records that this does not hold:

> *"on some runs the model imports people and stock phrases from OTHER matters
> in the voice context … for an entry naming neither. Measured on the same
> entry, 5 runs each: with the few-shot pairs 2/5, without them 5/5"*

That is the author's own measurement of the finished narrative being
contaminated on **40–100 % of runs**, filed as a "watch item". Under the brief
it is not a watch item; it is the top-priority defect in this audit. The leak
is not theoretical and does not stop at the prompt — it has been observed
reaching the narrative text.

Affects `/api/ai/expand`, `/api/ai/narrate` (draft, regenerate, shorter,
longer — `rewritePrompt` carries the same block) and the background timer
refinement.

**Proof:** `test/integrity.ai.test.js` →
*"LEAK: exemplars in a Northgate prompt include another client's narratives"*.
Northgate has **eight** finalized house-voice narratives of its own — it needs
nothing borrowed — and two of the six chosen exemplars are still Verity's.

### Leak 2 — CRITICAL. Few-shot pairs are drawn from the whole database; `cmId` only sorts

`server/routes/ai.js:184-191` and `server/lib/exemplars.js:158-212`.

```js
const pool = db.prepare(`… WHERE ${FINAL} AND ai_brief IS NOT NULL …
  ORDER BY date DESC LIMIT 300`).all();          // ← no cm_id filter
const pairs = pickPairs(pool, SEED_PAIRS, { count: 6, cmId, brief });
```

Inside `pickPairs`, the matter is a *preference*, never a filter:

```js
const matter = (cmId != null && b.cm_id === cmId) - (cmId != null && a.cm_id === cmId);
```

Three consequences, all reproduced:

1. **A matter with no history is given other clients' pairs, not the seeds.**
   `SEED_PAIRS` are appended only after the loop over real pairs (exemplars.js
   :207-211), so a live client's real narrative always outranks the synthetic
   fallback that exists precisely for this case.
2. **A matter with ample history still leaks.** The verb-diversity pass
   (exemplars.js:196-205) keeps only the first pair per lead verb on pass 1.
   Six same-matter pairs that open with the same verb collapse to one, and the
   freed slots go to other clients before pass 2 comes back for the rest.
3. Pairs are the strongest possible reproduction vector: they enter the
   message list as `{role:'assistant', content:'<another matter's narrative>'}`
   — the model reads them as *its own prior answers*, not as reference text.

**Proof:** *"LEAK: a brand-new matter is given another client's pairs instead
of the seeds"* (3 of the 6 pairs are Verity's, ranked ahead of the seeds) and *"LEAK:
pairs cross the client boundary even when the matter has plenty of its own"*
(Northgate has six pairs; three of the six slots still go to Verity).

**It reaches the wire.** A third test, *"LEAK: another client's narrative is
sent to the model on POST /api/ai/narrate"*, captures the actual JSON body
POSTed to Ollama and shows both blocks in it. The assertion failure prints the
whole payload — useful as the exhibit.

### Leak 3 — HIGH. The matter-context block presents a sibling matter's narratives as this matter's own history

`server/routes/ai.js:116-125` (`matterAiContext`) →
`server/routes/matters.js:42-55` (`matterSuggestions`) → `SIBLING_PHRASES`
(matters.js:28-36).

When the matter's own ranked phrases number fewer than five, `matterSuggestions`
blends in phrases from **other matters of the same client** and marks them
`source: 'client'` with `borrowed: true`. Every other consumer honours that
flag. `matterAiContext` drops it and emits:

```
The attorney's recent work on this matter:
- <a different matter's narrative>
```

The phrases are whole narratives and whole task fragments — real facts about a
different matter — asserted to the model as *this* matter's history. It is
made worse by `NAME_RESOLUTION_RULE` (ai.js:220), which is appended whenever
this context exists and explicitly instructs the model to resolve informal
references *using the names it finds there*. The people roster
(`matterPeopleList`, matters.js:61-79) blends siblings unconditionally, not
just when thin.

The brief allows same-client sibling borrowing nowhere: *"Not across clients,
and not between two matters of the SAME client."*

**This is not a claim that the phrasebook should be scoped per matter.** The
brief is explicit that shared reusable wording is intended, and I am not
proposing to change `matterSuggestions`, the phrasebook endpoint, ghost text
or expansions. The narrow defect is that *this prompt* discards the
`source`/`borrowed` distinction the rest of the app carries and states another
matter's sentence as a fact about the one being billed.

**Proof:** *"LEAK: a thin matter's prompt states a sibling matter's narrative
as its own history"*. (Overlaps with a finding in the parallel
`test/integrity.suggestions.test.js` — dedupe before assigning the fix.)

### Leak 4 — HIGH. An in-flight AI suggestion for matter A lands on the timer after it moves to matter B

`server/routes/ai.js:305-332`, `refineSuggestedNarrative()`.

The function resolves the timer's matter **once**, before an HTTP call that is
allowed 180 seconds, then writes back with:

```js
db.prepare('UPDATE timers SET suggested_narrative=? WHERE id=? AND running=1')
```

The guard is `running=1` only — nothing checks that the timer still points at
the matter the text was written from. `PATCH /api/timers/:id` deliberately
clears the suggestion on a matter change
(`server/routes/timers.js:325` — *"suggestion belonged to the old matter"*),
but a refinement already in flight overwrites that `NULL` afterwards. The text
then surfaces as the AI stop chip on the new matter.

Start a timer on the wrong matter and fix it — an everyday move, and the
explicitly supported matter→matter re-point added 2026-07-31 — and matter A's
AI narrative is offered for matter B's bill.

**Proof:** *"LEAK: an in-flight AI suggestion for matter A lands on the timer
after it moves to matter B"*. The stub Ollama parks the request, the test
re-points the timer, then releases; the Verity text is on the Northgate timer.

### Leak 5 — HIGH (reverse direction). Quick capture's AI-written narrative is stored as the attorney's own

`server/routes/quickcapture.js:43-46` accepts a model-written narrative:

```js
if (filled.narrative && !containsTimeAmounts(filled.narrative) && …) {
  parsed.narrative = String(filled.narrative).slice(0, 300);
}
```

The response object (`parseQuickCapture`'s shape, `server/lib/quickcapture.js:158`)
carries **no provenance field**, so the client has nothing to relay, and
`public/js/components/quickcapture.js:171` files:

```js
await api.post('/api/entries', { date, cm_id, narrative: parsed.narrative, tasks: […] });
```

`POST /api/entries` defaults `narrative_ai` to 0 (`server/routes/entries.js:347`).
Compare `entryeditor.js:342` and `stopchips.js:427`, which both send the flag
correctly — quick capture is the one path that does not.

Consequence: the model's own sentence, written about matter A, is recorded as
hand-written. On finalization it clears the `narrative_ai = 0` gate at
ai.js:161 and joins the exemplar and few-shot pools — from which Leaks 1 and 2
hand it to every other matter. It also defeats the provenance UI at
`entryeditor.js:1006` (no "AI wrote this" badge) and the model's own drafting
compounds on itself, which is exactly the failure mode the `narrative_ai`
column was added to prevent (`server/db.js:323-324`).

**Proof:** *"LEAK: an AI-written quick-capture narrative is stored as the
attorney's own"* — files the entry exactly as the UI does and asserts
`narrative_ai = 1`; it is 0.

---

## Checked and clean

- **`buildLlmFillMessages`** (`server/routes/quickcapture.js:79-88`) — the
  only prompt in the app with no exemplars and no narratives at all. Correct.
- **`SEED_PAIRS`** (ai.js:131-148) and **`REWRITE_SHOTS`** (ai.js:257-266) —
  fully synthetic, belong to no client, flagged `seed: true`. The rewrite
  demonstrations use declared house names. Correct, and covered by the passing
  control test.
- **`formatContract` / `rewriteContract` / `DEFAULT_AI_INSTRUCTIONS`** — pure
  style and format guidance, no client facts. Correct.
- **The shortcuts glossary** (`renderGlossary`) — generic reusable wording,
  shared by design. Not a leak; not reported as one.
- **Cross-request state.** No module-level cache in `ai.js`; every call
  re-queries. Ollama is called statelessly (`/api/chat` with a full message
  list, no `context` handle, no `keep_alive` session), so no prompt text
  survives into the next request through the model. The one exception is
  `timers.suggested_narrative`, which is Leak 4.
- **`narrative_ai` handling on `POST`/`PATCH /api/entries`** — server-side
  provenance is sound: an edit that changes the text clears the flag, an
  identical autosave does not (entries.js:400-403). The gap is only that quick
  capture never sets it.
- **`FINAL`'s `status = 'finalized'` filter** — drafts correctly stay out of
  both pools.

## Notes for the orchestrator, not findings

- `scripts/ai-eval.mjs:59` calls `buildVoiceContext(db, { brief })` with **no
  `cmId` at all**, against the live database. It is a dev tool, not a runtime
  path, but it confirms the whole-database pool is the default behaviour rather
  than a fallback.
- **Possible confidentiality issue, needs David's confirmation.** The comment
  at `server/routes/ai.js:70-72` quotes measured model output containing two
  personal names and a subject, described as measured *"against the live
  database"*. If those are real, they are real client-adjacent data in the repo
  and in git history, which the brief forbids and which the earlier
  confidentiality scrub was meant to remove. Everything else I read uses the
  declared house fictional names. Worth a one-line check before the next push.

## Shape of the fix (not implemented — read-only audit)

Not prescriptive, but the failing tests pin these invariants:

1. `buildVoiceContext` must take the matter as a **filter**, not a hint: drop
   the unscoped `recent` query, and add `AND cm_id = ?` to the pair pool.
2. When the matter yields nothing, fall through to `SEED_PAIRS` and to
   generic-only exemplars — never to another matter's rows.
3. `pickPairs` should refuse a pair whose `cm_id` differs from the requested
   one rather than merely ranking it lower; the verb-diversity pass then
   operates inside the matter.
4. `matterAiContext` should either use own-matter phrases only, or keep
   `source: 'client'` rows out of the prompt while leaving `matterSuggestions`
   itself untouched for its other consumers.
5. `refineSuggestedNarrative` should capture `cm_id` up front and add
   `AND cm_id = ?` to its `UPDATE` guard.
6. Quick capture should return an AI-provenance flag and the client should send
   `narrative_ai: 1` (and ideally `ai_brief` = the captured line) when the
   model wrote the narrative.

# Entity-Aware Ghost Text — Design

**Source:** TODO.md UI feedback (2026-08-30 10:55): *"Ghost text predictions in
narratives should be preloaded with matter-derived snippets. If the matter has
several entries mentioning 'development agreement' the ghost text should
predict a given action was done with that document. E.g. user starts typing
'review and analyze' and ghost text autofills the document name. Or people get
auto filled e.g. 'email with…' pops up a name and then 'regarding' the
document."*

**Directions confirmed with David (2026-08-30):**
1. Predictions come from **his own entries only** — a deterministic extractor,
   no model, live or nightly.
2. **Inline grey ghost by default, with a candidate list on a key.**
3. **Documents never cross matters. People may** — own roster first, client
   siblings last.

⚠️ marks an assumption made without David's input; ratify before executing.

## Why the current engine cannot do this

`ghostCompletion` (`public/js/lib/ghost.js`) completes a **whole ranked phrase
from the start of a clause**. Typing "review and analyze " matches nothing
unless a stored phrase begins with those exact words. What this feature needs
is a **continuation** from the middle of a clause, and the unit continued is
not a phrase but a thing: a document, a person, an organisation.

So the phrasebook stays as it is and earns first refusal. Entities are a
second tier underneath it.

## What gets extracted

Measured on the live database (475 entries) with a throwaway extractor: a
plain capitalised-run regex already recovers real document names, the top
three appearing 12, 12 and 5 times. It also produces two predictable kinds of
junk, and both have a rule that removes them:

| Raw capture | Problem | Rule |
|---|---|---|
| "Draft Purchase and Sale Agreement" | a verb glued to its object | strip a leading verb |
| "Acme and Cedar Utility" | two organisations joined by "and" | split an org candidate on " and " |

The discriminator between the two is a **head noun**. A capitalised run whose
LAST word is a document word — Agreement, Amendment, Lease, Easement, Deed,
Letter, Intent, Survey, Plat, Binder, Addendum, Assignment, Consent, Notice,
Report, Schedule, Exhibit, Ordinance, Permit, Commitment, Abstract, Term
Sheet — is a **document**, and "and" inside it is part of the name. Anything
else is an **organisation**, and "and" inside it joins two of them.

People are NOT extracted here. `extractPeople` and the `matter_people` table
already do that job, and `matterPeopleList()` already returns the matter's own
roster first and the client's siblings after it — which is precisely the
ranking David asked for. This feature only reads it.

## Data model (migration v18)

```
matter_entities
  id, matter_id→matters ON DELETE CASCADE,
  name TEXT,               -- display casing, from the most recent sighting
  kind TEXT,               -- 'document' | 'org'
  count INTEGER,
  last_seen_at TEXT,       -- the ENTRY DATE (YYYY-MM-DD), not a wall clock
  UNIQUE(matter_id, name)
```

A deliberate copy of `matter_people`: same shape, same derivation, same
lifecycle. It is a cache of entries, never a source of truth — dropping the
table and rebuilding must produce the same rows.

- ⚠️ **Organisations are matter-scoped, like documents.** David ruled on
  people and documents; organisations were not named. Matter-scoped is the
  conservative reading and matches the leak fixed on 2026-08-30.
- ⚠️ **An entity needs 2 sightings** before it can predict, so a typo never
  becomes a suggestion. Stored from the first sighting; the floor is applied
  on read, so lowering it needs no rebuild.

## Extraction (`server/lib/entities.js`, pure)

`extractEntities(text)` → `[{ name, kind }]`. Pure, no DB, no clock — the
`server/lib/people.js` contract exactly.

- A candidate is 1–5 capitalised tokens, allowing the lowercase joiners
  `of and the to for` between them ("Letter of Intent").
- Strip a leading verb (draft, review, revise, prepare, analyze, negotiate,
  attend, execute, circulate, …). "Prepare Closing Binder" → "Closing Binder".
- Last token in the head-noun list → `document`, keep "and".
  Otherwise → `org`, split on " and ".
- Drop anything `extractPeople` claims from the same text, so a name never
  files twice under two kinds.
- Drop the matter tag first (`stripMatterTag`, already shared with the
  phrasebook since 2026-08-21).

`rankEntities(rows, today)` scores `count × 0.5^(ageDays / 30)` — the
phrasebook's decay, so the two tiers age at the same rate. It is an
approximation of `rankPhrases`, which decays each sighting separately; the
table stores only a count and a last date. ⚠️ Accepted: entities are ranked
against each other, never against phrases, so the two never need to agree.

## Rebuild and backfill

`rebuildMatterPeople(db, matterId)` in `server/routes/entries.js` becomes
`rebuildMatterMemory(db, matterId)` and rebuilds both tables in one pass over
the matter's rows — one read instead of two, and the two caches can never
drift apart. Existing history is backfilled on the first `jobs.js` tick after
upgrade, the way the people roster was.

## API

`GET /api/matters/:id/suggestions` grows two fields:

```
{ matter_id, borrowed, phrases: [...],
  entities: [{ name, kind, count, last_seen }],  // this matter only
  people:   [{ name, source }] }                 // own first, siblings last
```

One `entities` list carries both kinds. Documents and organisations are
matter-scoped alike and answer the same triggers, so splitting them into two
fields would buy nothing the `kind` field does not already say.

⚠️ Extending the existing endpoint rather than adding one. The browser caches
this response per matter for 60s already (`ghosttext.js`); a second endpoint
would mean a second fetch and a second cache for data that is always wanted at
the same moment.

## Completion engine (`public/js/lib/ghost.js`)

The signature stays backward compatible — the fourth argument is already an
options object, so existing callers that pass none keep today's behaviour and
today's tests pass unchanged:

```js
ghostCompletion(value, caret, phrases, { minChars, entities, people })
```

Tier 1 is the whole-phrase match that exists now. If it misses, tier 2 runs on
the current clause:

- **Mid-word** — "…analyze Cedar Le" → prefix-match entities AND people,
  return the remainder. Same mechanic as tier 1, different corpus. A part-typed
  word is unambiguous enough that no trigger is needed.
- **After a space** — offer nothing unless the preceding word is a trigger,
  because an unconditional guess after every space is noise:
  - a document verb, or `regarding` / `re` / `of` → offer the top **entity**
  - `with` / `to` / `from` → offer the top **person**
- ⚠️ **The chain.** Once a person has been accepted and the caret sits after
  a name with no document yet in the clause, offer ` regarding <top document>`
  — `kind: 'document'` only, never an organisation, because "email with
  M. Smith regarding Acme" reads wrong. This is the most speculative rule in
  the design and the first one to cut if it proves annoying.
- Never offer an entity already written in the current narrative.

All of it stays pure and dependency-free: the same ES module runs in the
browser with no build step and under `node:test`.

## UI (`public/js/components/ghosttext.js`)

- The module-level 60s cache entry becomes `{ at, phrases, entities, people }`.
  `useMatterSuggestions(cmId)` keeps returning phrase strings — three call
  sites depend on that — and a sibling hook `useMatterEntities(cmId)` reads
  the same cache entry, so there is still one fetch per matter.
- `GhostInput` takes an optional `entities` prop and passes it through. The
  entry editor, the entry list's inline editor, and the close-out all pass it
  — each already calls the phrase hook, so it is a second hook call and one
  prop at each site. Quick capture does not change: it has no ghost text by
  decision.
- **Ctrl+Space** opens a candidate list under the caret: the top 5 of the kind
  the trigger implies, ↑/↓ and Enter to pick, Escape to close. Verified free —
  the app-level shortcut handler ignores any modified key, and the editor's
  only Ctrl binding is Ctrl+Enter for Save. While the list is open it stops
  Escape propagating, so it closes without also closing the editor modal (the
  capture-phase precedent StopChips documents).

## Testing

- `test/entities.test.js` — the two junk shapes above, the head-noun split,
  the org "and" split, people excluded, matter tag stripped, `rankEntities`
  decay.
- `test/ghost.test.js` — mid-word completion, each trigger word routing to the
  right kind, no offer after a non-trigger word, no duplicate offer, the
  person→regarding chain. **Every existing case must still pass untouched** —
  that is the proof tier 1 was not disturbed.
- `test/api.matters.test.js` — a matter gets its own entities and none of a
  sibling's; people still blend siblings, own first.
- `scripts/e2e-smoke.mjs` — type a trigger in the narrative, expect grey ghost
  text; Tab accepts it; Ctrl+Space opens the list and Escape closes it without
  closing the editor.

## Out of scope

- Any model involvement. Ruled out by David: this tier is deterministic, and
  a live call cannot meet the sub-50ms budget ghost text needs on this box.
- Alias grouping ("the PSA" → "Purchase and Sale Agreement"). The shortcuts
  table already does abbreviation expansion by hand and is the cheaper answer
  if this is wanted.
- Entities in quick capture. Ghost text is deliberately absent there today.

## Risks

- **The head-noun list is a fixed vocabulary.** An unusual document type falls
  through to `org` — degraded, not broken: it still predicts, and after the
  same triggers. The list is one array in one file.
- **Trigger noise.** If the ghost fires too often it will be worse than
  nothing. The trigger set is the throttle and is the first thing to tune
  after a day of live use.

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
2. **Inline grey ghost by default. The candidate list opens on ↓** — not
   Ctrl+Space.
3. **Documents never cross matters.**
4. **People and organisations may cross** — own matter first, client siblings
   ranked last.
5. **A person trigger is more than "with"** — `to` and `from` too, behind the
   full connector vocabulary `people.js` already uses.
6. **The dictionary is editable in Settings** — what was extracted is a
   starting point, not the last word.

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
roster first and the client's siblings after it — precisely the ranking David
asked for. This feature reads that roster and adds the editing layer below.

## Scope of each kind

One rule, applied everywhere — the ghost, the candidate list, the API:

| Kind | This matter | Client siblings | Global manual |
|---|---|---|---|
| `document` | yes | **never** | yes, ranked last |
| `org` | yes | yes, ranked last | yes, ranked last |
| `person` | yes | yes, ranked last | yes, ranked last |

A document belongs to one deal. An organisation and a person move between a
client's matters, so they may be borrowed — but always below the matter's own,
so they surface only when the matter itself has nothing better.

## Data model (migration v18)

```
matter_entities
  id, matter_id→matters ON DELETE CASCADE  NULLABLE,
  name TEXT,               -- display casing, from the most recent sighting
  kind TEXT,               -- 'document' | 'org' | 'person'
  count INTEGER,
  last_seen_at TEXT,       -- the ENTRY DATE (YYYY-MM-DD), not a wall clock
  origin TEXT,             -- 'derived' | 'manual'
  hidden INTEGER 0/1,      -- user suppressed it; rebuild must not resurrect it
  locked INTEGER 0/1,      -- user edited name/kind; rebuild must not overwrite
  UNIQUE(IFNULL(matter_id,0), name COLLATE NOCASE)   -- an expression index:
    -- plain UNIQUE(matter_id, name) does not constrain rows where matter_id
    -- is NULL, because SQLite treats every NULL as distinct
```

**One table holds all three kinds** — documents, organisations and people —
and it is the only thing the ghost and the dictionary read. `matter_people` is
NOT changed by this feature: it keeps feeding the AI prompt and the `/people`
endpoint exactly as it does today, and `rebuildMatterMemory` writes both from
one pass over the matter's rows, so the two cannot drift.

The alternative — override columns on `matter_people` and a read-time merge of
two tables with different rules — was rejected while planning: it puts the
same three flags in two places and gives the Settings page two sources to
reconcile. The cost of this choice is that a derived person is stored twice.
Both copies come from one extraction in one transaction, which is what makes
that acceptable.

`matterPeopleList()` gains one filter: a name hidden in the dictionary is
dropped from the AI prompt roster too. Hiding a mis-captured name has to mean
hidden everywhere, or the same bad name keeps reaching the model.

- **`matter_id` NULL = a global dictionary entry**, available to every matter
  and ranked last. This is what makes "editable dictionary in Settings"
  coherent: Settings is a global place, and a document type or an organisation
  he always wants offered should not have to be retyped per matter. Precedent:
  the `shortcuts` table is global for the same reason.
- ⚠️ **An entity needs 2 sightings** before it can predict, so a typo never
  becomes a suggestion. The floor applies to `origin='derived'` rows only — a
  row he typed by hand is wanted from the moment he types it. Applied on read,
  so lowering it needs no rebuild.

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
drift apart.

The rebuild **cannot stay a DELETE-then-INSERT** now that rows carry user
edits. It becomes an upsert keyed on `(matter_id, name)` case-insensitively:

- sighted, `locked=0` → update name, kind, count, last_seen_at
- sighted, `locked=1` → update count and last_seen_at only
- not sighted, `origin='derived'`, `hidden=0`, `locked=0` → delete
- anything else (manual, hidden, or locked) → keep untouched

That is the whole contract: **a derived row is disposable, a row he touched is
not.** Existing history is backfilled on the first `jobs.js` tick after
upgrade, the way the people roster was.

## API

`GET /api/matters/:id/suggestions` grows two fields:

```
{ matter_id, borrowed, phrases: [...],
  entities: [{ name, kind, count, last_seen, source }],
  people:   [{ name, source }] }
```

`source` is `matter` | `client` | `global`, and the list arrives in that order
— the browser never re-sorts, so the scope table above is enforced in one
place on the server.

⚠️ Extending the existing endpoint rather than adding one. The browser caches
this response per matter for 60s already (`ghosttext.js`); a second endpoint
would mean a second fetch and a second cache for data that is always wanted at
the same moment.

Dictionary CRUD, modelled on the task-codes and shortcuts routes:

- `GET /api/dictionary?matter_id=` — global rows, or one matter's rows plus
  the global ones, each with `origin`, `hidden`, `count`, `last_seen`
- `POST /api/dictionary` — add a manual row (`matter_id` null = global)
- `PATCH /api/dictionary/:id` — rename, change kind, hide or unhide. Any
  change to name or kind sets `locked=1`
- `DELETE /api/dictionary/:id` — removes a manual row. On a derived row it
  sets `hidden=1` instead, because a real delete would come straight back on
  the next rebuild

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
  word is unambiguous enough to need no trigger.
- **After a space** — offer nothing unless the preceding word is a trigger,
  because an unconditional guess after every space is noise.

**Person triggers are `with`, `to` and `from`** — and they are not a
hand-built list. They are the same connectors `people.js` uses to FIND names,
so what the app learned from is what it predicts into: call / telephone
conference / meeting / met / spoke / confer / discussion / negotiation / zoom
/ correspondence **with**, and email / e-mail / letter / memo / message /
voicemail / correspondence **to** or **from**. If a verb joins that vocabulary
in `people.js`, this tier gains it for free and cannot drift out of step.

- **Entity triggers** — a document verb, or `regarding` / `re` / `of` → offer
  the top entity (documents and organisations both).
- **Another person** — after a name, a `,` or an `and` in a clause that
  already fired a person trigger offers a further person, since "call with
  A. Turner and M. Smith" is an ordinary shape. Never one already in the text.
- ⚠️ **The chain.** Once a person has been accepted and the caret sits after
  a name with no document yet in the clause, offer ` regarding <top document>`
  — `kind: 'document'` only, never an organisation, because "email with
  M. Smith regarding Acme" reads wrong. This is the most speculative rule in
  the design and the first one to cut if it proves annoying.
- Never offer an entity already written in the current narrative.

All of it stays pure and dependency-free: the same ES module runs in the
browser with no build step and under `node:test`.

## Ghost and list (`public/js/components/ghosttext.js`)

- The module-level 60s cache entry becomes `{ at, phrases, entities, people }`.
  `useMatterSuggestions(cmId)` keeps returning phrase strings — three call
  sites depend on that — and a sibling hook `useMatterEntities(cmId)` reads
  the same cache entry, so there is still one fetch per matter.
- `GhostInput` takes an optional `entities` prop and passes it through. The
  entry editor, the entry list's inline editor, and the close-out all pass it
  — each already calls the phrase hook, so it is one more hook call and one
  prop per site. Quick capture does not change: it has no ghost text by
  decision.
- **↓ opens the candidate list.** It shows the top 5 of the kind the trigger
  implies, with borrowed and global rows labelled so their origin is visible;
  ↓/↑ move, Enter or Tab accepts, Escape closes, and typing closes it and
  re-runs the ghost.

  The key is free because of an invariant this feature already relies on: a
  ghost is only ever offered when the caret is at the very end of the text.
  There, ↓ has nothing to do — the caret is already on the last line at its
  end — so intercepting it costs no editing behaviour. When no ghost is
  showing, ↓ is not touched at all.

  While the list is open it stops Escape propagating, so Escape closes the
  list without also closing the editor modal (the capture-phase precedent
  StopChips documents).

## Settings → Dictionary

A new `dictionary` entry in `SETTINGS_CATEGORIES`, rendering one
`DictionaryCard`. It belongs beside "Codes & shortcuts" because it is the same
kind of thing: a store the attorney maintains by hand that feeds a
deterministic engine.

- A scope picker at the top: **Global** (default) or one matter, via the
  existing `CMPicker`.
- A table for that scope: name, kind, uses, last used, origin. Inline rename,
  a kind toggle (Document / Organisation / Person), a hide toggle, delete.
- An add row: name + kind, filed against the chosen scope.
- Derived rows below the 2-sighting floor render greyed with a "not predicting
  yet" note, so the page explains the floor instead of hiding rows and looking
  broken.
- ⚠️ Hidden rows stay listed with a struck-through name rather than being
  filtered out, so nothing he suppressed becomes invisible and unrecoverable.

## Testing

- `test/entities.test.js` — the two junk shapes above, the head-noun split,
  the org "and" split, people excluded, matter tag stripped, `rankEntities`
  decay.
- `test/ghost.test.js` — mid-word completion, each trigger word routing to the
  right kind, `to` and `from` as person triggers, the person-list "and" case,
  no offer after a non-trigger word, no duplicate offer, the person→regarding
  chain. **Every existing case must still pass untouched** — that is the proof
  tier 1 was not disturbed.
- `test/api.matters.test.js` — a matter gets its own documents and none of a
  sibling's; organisations and people DO blend siblings, ranked after own;
  global rows come last.
- `test/api.dictionary.test.js` — a manual row survives a rebuild; a hidden
  derived row is not resurrected; a locked row keeps its edited name while its
  count still updates; deleting a derived row hides it instead; a hidden person
  also disappears from `matterPeopleList()`.
- `scripts/e2e-smoke.mjs` — type a trigger in the narrative, expect grey ghost
  text; Tab accepts it; ↓ opens the list and Escape closes it without closing
  the editor.

## Out of scope

- Any model involvement. Ruled out by David: this tier is deterministic, and
  a live call cannot meet the sub-50ms budget ghost text needs on this box.
- Alias grouping ("the PSA" → "Purchase and Sale Agreement"). The `shortcuts`
  table already expands abbreviations by hand and is the cheaper answer.
- Client-level dictionary rows. A row is either one matter's or global; an
  "every matter under this client" scope can be added later on the same table
  if the global tier proves too blunt.
- Entities in quick capture. Ghost text is deliberately absent there today.

## Risks

- **The head-noun list is a fixed vocabulary.** An unusual document type falls
  through to `org` — degraded, not broken: it still predicts, and after the
  same triggers. It is one array in one file, and the Settings dictionary lets
  him correct any row the list gets wrong.
- **The rebuild contract is now load-bearing.** Before this feature the caches
  could be dropped and rebuilt freely; now a rebuild that ignores `locked` or
  `hidden` silently destroys his edits. That is why it gets its own test file
  rather than riding along in the API tests.
- **Trigger noise.** If the ghost fires too often it will be worse than
  nothing. The trigger set is the throttle and is the first thing to tune
  after a day of live use.

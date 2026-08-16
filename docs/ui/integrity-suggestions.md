# Data-integrity audit — the suggestion sources that propose narrative text

Branch `ui-overhaul-2026-08`. Standard: `docs/ui/BRIEF.md` §"Data integrity",
which outranks everything else in this run.

> A **narrative** — the client-facing sentence describing work done on a
> specific matter — may never be shown as belonging to, suggested for,
> pre-filled into, or written onto an entry for a different matter. Not across
> clients, and not between two matters of the same client.
>
> Shared **by design**, and not defects: the shortcut/text-expansion table,
> and generic style guidance in prompts. Reusable wording is shared; a sentence
> about a particular matter is not.

**Proving test: `test/integrity.suggestions.test.js`.** Eight tests, all
written to FAIL against current `master`/`ui-overhaul-2026-08`. Every one of
them runs a real server on a temp database (`test/helpers.js
startTestServer`). Full suite before this file: 633 pass. After: 633 pass, 8
fail — the eight below, and nothing else. Do not make them pass by weakening
the assertion; the assertion is the spec.

---

## Verdict

The stop-chip leak already reported (offer A re-dressed over entry B) was a
component-lifecycle bug. **The leaks below are not.** They are the designed
behaviour of the memory layer, and they were designed before the brief's
integrity rule existed. One endpoint — `GET /api/matters/:id/suggestions` —
deliberately blends a **sibling matter's finished narratives** into a cold
matter's phrasebook, and four separate UI surfaces consume it. One prompt
builder — `buildVoiceContext` — deliberately reads **every client's**
finalized narratives out of the database and splices them into the prompt that
writes the current one.

The single worst consequence: **on the close-out path a sibling matter's
billing sentence is pre-filled, saved, finalized and exported with zero taps.**
Nobody has to accept it. Leaving the dialog alone and pressing the primary is
enough.

| # | Source | Carries | Scope | Severity |
|---|--------|---------|-------|----------|
| S1 | `/matters/:id/suggestions` → close-out pre-fill → **finalize & export** | narratives | matter **+ client siblings** | **critical** |
| S2 | `buildVoiceContext` → every AI prompt | narratives | **whole database, all clients** | **critical** |
| S3 | `/matters/:id/suggestions` → stop chips, with false provenance | narratives | matter + client siblings | high |
| S4 | `timers.suggested_narrative` at start → the ✦ stop chip | narratives | matter + client siblings | high |
| S5 | `/matters/:id/suggestions` → ghost-text completion (4 fields) | narratives | matter + client siblings | high |
| S6 | `matterAiContext` — labels a sibling's narrative "this matter" | narratives + people | matter + client siblings | high |
| S7 | `timers.draft_narrative` survives a matter re-point | narrative | follows the timer | high |
| S8 | `timers.narrative_template` survives a matter re-point | narrative | follows the timer | medium |
| S9 | the brief's stop-chip empty state is unreachable | — | — | medium |
| S10 | `useMatterSuggestions` stale-phrase window on a matter switch | narratives | one round trip | medium |
| S11 | `NarrativeHistory` keeps rows/picks across a `cmId` change | narratives | latent | low |

---

## Source-by-source: the questions the audit asked

### `GET /api/matters/:id/recent-narratives` — CLEAN

`server/routes/matters.js:108-127`. `WHERE e.cm_id = ?`, no blend, no
fallback. `pickRecentNarratives` (`server/lib/recentnarratives.js`) is pure and
touches nothing but the rows it is given. `NarrativeHistory`
(`public/js/components/narrativehistory.js`) refetches on `cmId` and holds no
module state. A matter with no history gets `{ entries: [] }` and the correct
empty state. **This is what every other source should look like.** (See S11 for
one latent nit.)

### `GET /api/matters/:id/suggestions` — LEAKS (S1, S3, S4, S5, S9)

`server/routes/matters.js:20-55`. Two unions:

```sql
OWN_PHRASES     … WHERE e.cm_id = ?                       -- correct
SIBLING_PHRASES … WHERE m.client_id = ? AND m.id != ?     -- the leak
```

The blend fires when `rankPhrases(own).length < THIN_PHRASES` (5). A matter
with **0–4 distinct phrases of its own** — i.e. every new matter, and most
matters for their first weeks — is served its siblings'.

What it serves is not "phrasing". The `FREE_NARRATIVE` branch selects
`e.narrative` — the **whole client-facing sentence**, verbatim, off a
different matter's entry. Proven:

```
GET /api/matters/<Ridgeline Permit>/suggestions
→ phrases[0].text = "Review and analyze the Harbor Lease termination notice
                     and confer with T. Vance regarding same"
   phrases[0].source = "client"
```

Ridgeline Permit has never been worked on. Harbor Lease is a different matter.

The server does tell the truth about it — `borrowed: true`, `source:
'client'`. **Every consumer throws that away:**

| Consumer | What it keeps |
|---|---|
| `closeout.js:263` | `r.phrases.map((p) => p.text)` — source dropped |
| `ghosttext.js:29` | `r.phrases.map((p) => p.text)` — source dropped |
| `stopchips.js:284` | keeps `source`, but only to gate the auto-write; never to label |
| `timers.js:485` | `sugg.phrases.find(…)` — source ignored |

#### S1 — close-out pre-fills and exports a sibling's narrative · **critical**

`public/js/components/closeout.js`:

```js
const valueOf = useCallback((g) => {
  if (texts[g.key] !== undefined) return texts[g.key];
  return (sugg[g.cm?.id] || [])[0] || '';      // ← phrases[0], provenance gone
}, [texts, sugg]);
```

and `finalizeAndExport` (line 378):

```js
for (const g of needs) {
  const text = valueOf(g);
  if (!String(text).trim()) continue;
  for (const d of g.blank) await save(d, text);   // PATCH narrative
}
… await api.post('/api/finalize-day', …); await doExport(hard);
```

So for a cold matter, `phrases[0]` — a sibling matter's billing sentence — is
the value of the narrative box; the lawyer never touched it; the primary
writes it, locks it, and puts it in the CSV that is keyed into the firm's
billing system. `Accept all` (line 330) does the same thing one button
earlier. It is also counted in `filing.going`, so the panel's headline number
counts it as a finished entry.

Nothing in the dialog says the sentence came from another matter — the row
shows the matter's own name above the box.

Proof: `test/integrity.suggestions.test.js` →
`LEAK: the close-out pre-fill value for a cold matter is a sibling's narrative`
and `LEAK: a cold matter is offered its sibling matter's narrative`.

#### S3 — the stop chips show a sibling's narrative, labelled as his own · **high**

`stopchips.js` gets the auto-write gate right, and that should be preserved:
`own: p.source !== 'client'` means only a `source: 'matter'` phrase is ever
PATCHed without being asked for. That gate is the only thing standing between
the blend and an unasked write, and it works.

But borrowed phrases are still **rendered as chips**, and the chip lies about
where they came from (`stopchips.js:597-605`):

```js
title=${chip.ai
  ? `Suggested when this timer started — finish the entry with: ${chip.text}`
  : `You wrote this on this matter before — finish the entry with: ${chip.text}`}
…
<${Icon} name=${chip.ai ? 'sparkles' : 'history'} size=${14} />
```

`chip.ai` is false for every phrasebook chip regardless of `source`, so a
sentence from Harbor Lease is offered on Ridgeline Permit's entry under the
words **"You wrote this on this matter before"** with the ⟲ history icon. One
tap writes it. Against the brief this is the exact prohibited act — "shown as
belonging to … an entry for matter B" — with an affirmative false claim on top.

#### S4 — the timer is pre-loaded with a sibling's narrative at start · **high**

`server/routes/timers.js:484-489`, inside `doStart`:

```js
const sugg = matterSuggestions(db, timer.cm_id, todayLocal(clock()));
const cleanPhrase = sugg && sugg.phrases.find((p) => !containsTimeAmounts(p.text));
db.prepare('UPDATE timers SET suggested_narrative=? WHERE id=?')
  .run(cleanPhrase ? cleanPhrase.text : null, timer.id);
```

`source` is not consulted. Start a timer on a cold matter and the row's
`suggested_narrative` column holds a sibling matter's sentence, persisted.
`stopchips.js:283` then renders it as the ✦ chip captioned *"Suggested when
this timer started"* — and because it enters via `add(…, { ai: true })`, a tap
writes it with `narrative_ai = 1`, i.e. flagged as model output when it is in
fact another matter's human-written billing sentence.

Proof: `LEAK: a timer started on a cold matter is pre-loaded with a sibling's
narrative`.

#### S5 — ghost text completes a sibling's sentence · **high**

Ghost text as a mechanism is fine and shared by design; the problem is the
*list it completes from*. `ghosttext.js useMatterSuggestions` feeds
`ghostCompletion` the same `phrases` array, so on a cold matter, typing the
first two characters of a sibling matter's narrative offers the rest of it in
grey and **Tab writes it into the field**. Four fields:

- `entryeditor.js:156, 784, 919` — the narrative box and every task fragment
- `entrylist.js:111, 178` — the inline row editor
- `closeout.js:618` — the close-out box
- `stopchips.js:628` — the stop offer's own field, `suggestions=${chips.map(c => c.text)}`,
  which includes the borrowed chips

The module-level cache in `ghosttext.js` (`cache: cmId -> {at, phrases}`, 60 s
TTL) is **correctly keyed** — no cross-matter mixing there. See S10 for its one
real hazard.

#### S9 — the brief's stop-chip empty state is dead code · **medium**

The brief: *"If the matter has no prior narratives, offer generic phrasing or
offer nothing."* `stopchips.js:334` implements exactly that —

```js
const noHistory = offerChips && chips !== null && chips.length === 0;
```

— and it can essentially never be true, because the blend guarantees a
non-empty list for any matter whose client has any other matter with history.
The "Nothing on file for this matter yet — say what you did:" field, added in
response to wave-1 review D10, is unreachable on those matters. Fixing S1 turns
it back on, which is the desired behaviour and needs a screenshot check.

### `buildVoiceContext` / `pickPairs` / `pickExemplars` — LEAKS (S2)

`server/routes/ai.js:163-218`, `server/lib/exemplars.js`.

#### S2 — every AI prompt carries other clients' real narratives · **critical**

```js
const own = cmId == null ? [] : db.prepare(`… WHERE ${FINAL} AND cm_id = ? … LIMIT 60`).all(cmId)…;
const recent = db.prepare(`… WHERE ${FINAL} … ORDER BY date DESC LIMIT 200`).all()…;  // ← every client
const exemplars = pickExemplars(own.concat(recent), { count: 6 });
…
const pool = db.prepare(`SELECT ai_brief AS brief, narrative, cm_id, date FROM entries
  WHERE ${FINAL} AND ai_brief … LIMIT 300`).all();                                     // ← every client
const pairs = pickPairs(pool, SEED_PAIRS, { count: 6, cmId, brief });
```

Neither pool is scoped. `pickPairs` prefers same-matter rows
(`exemplars.js:185`) but that is a **sort key, not a filter** — with no
same-matter pairs it takes any client's real (brief → narrative) pairs, and
only tops up from `SEED_PAIRS` once six real ones are chosen. The brief is
explicit and the opposite is implemented:

> Where a prompt includes before/after narrative pairs as examples, those pairs
> come from the same matter; where a matter has none, use fully synthetic
> examples.

`SEED_PAIRS` already exist and are already synthetic. They are the correct
answer for a cold matter; the code reaches past them.

Blast radius: this block is on **every AI path** — `/api/ai/narrate` (draft,
regenerate, shorter, longer), `/api/ai/expand` (both the split and the rewrite
contract) and the background `refineSuggestedNarrative` that writes
`timers.suggested_narrative`. So the chain closes: another client's narrative →
prompt → model output → `suggested_narrative` on this matter's timer → the ✦
stop chip → one tap → onto this matter's bill.

**This is not theoretical, and the codebase already knows it.** `ai.js:69-73`:

> *"Watch item … on some runs the model imports people and stock phrases from
> OTHER matters in the voice context ("email with J. Busse and C. Pierce
> regarding legal descriptions" for an entry naming neither). Measured on the
> same entry, 5 runs each: with the few-shot pairs 2/5, without them 5/5."*

That is a measured cross-matter narrative leak, recorded as a watch item and
mitigated with a rate reduction. Under the brief it is a defect, and the fix is
to remove the foreign material from the prompt rather than to reduce how often
the model copies it.

Proof: `LEAK: few-shot pairs for one client are another client's real
narratives` (unit) and `LEAK: the prompt sent to the model for one client
quotes another client's narrative` (end-to-end against a stub Ollama, asserting
on the actual `/api/chat` request body).

Note the tension to resolve deliberately: style exemplars are *meant* to teach
voice, and voice is genuinely global. But `pickExemplars` emits **verbatim
finalized narratives**, not a voice profile — subject matter, parties and
document names included. Either scope the pool, or strip it to something that
carries no matter facts. Whichever, the *few-shot pairs* have an explicit rule
in the brief and must be same-matter-or-synthetic.

### `matterAiContext` / `matterPeopleList` / `/matters/:id/people` — LEAKS (S6)

`server/routes/ai.js:116-125` builds, verbatim:

```
People from this matter's history: T. Vance.

The attorney's recent work on this matter:
- Review and analyze the Harbor Lease termination notice and confer with T. Vance regarding same
```

…for **Ridgeline Permit**, a matter with no history, no entries and no
T. Vance. It inherits `matterSuggestions`'s blend, drops `source`, and then
*asserts in the prompt* that the borrowed sentence is this matter's own work.
`matterPeopleList` is worse than the `/people` endpoint by design
(`matters.js:60-63`): it blends siblings **always**, not only when own history
is thin, so a roster of another matter's counterparties is handed to the model
as this matter's people. That is the mechanism behind the J. Busse / C. Pierce
observation above.

Proof: `LEAK: the AI matter context labels a sibling's narrative as "this
matter"`.

### The timer's own stashed text — LEAKS (S7, S8)

`server/routes/timers.js:319-334` (PATCH) and `:76-92` (`syncToEntry`).

The PATCH gets `suggested_narrative` right and says so —

```js
cmChanged ? null : timer.suggested_narrative, // suggestion belonged to the old matter
```

— and then, three lines down, deliberately keeps the two fields that hold text
the attorney actually wrote:

```js
// user text — deliberately SURVIVES cmChanged; the next entry the
// timer creates is where the stash gets consumed
b.draft_narrative !== undefined ? … : timer.draft_narrative,
b.narrative_template !== undefined ? … : timer.narrative_template,
```

`syncToEntry` then seeds the next entry with them:

```js
const seedNarrative = [timer.narrative_template, timer.draft_narrative]
  .filter(Boolean).join(' ').trim();
```

#### S7 — `draft_narrative` follows the timer to a new matter · **high**

`draft_narrative` is narrative text typed in the float window while the timer
had no entry yet (`public/js/lib/pip.js:444`, stash mode). Re-point that timer
at a different matter — the ordinary "wrong timer, fix it" move — and the next
start writes the old matter's sentence **verbatim into the new matter's brand
new entry**. No chip, no toast, no Undo, no provenance. It is the only path in
this audit where a foreign narrative is written with no UI surface at all.

Proven cross-client (Northgate → Acme):
`LEAK: a timer's stashed narrative is written onto the next matter's entry`.

The rationale for keeping it — "the next entry the timer creates is where the
stash gets consumed" — is right for a matter change that does not happen. The
fix is to clear the stash on `cmChanged` exactly as `suggested_narrative` is
cleared, or (better, since the text is his) to move it to the entry it was
written for before the re-point.

#### S8 — `narrative_template` follows the timer to a new matter · **medium**

Same mechanism, weaker case: a template is wording the attorney set on purpose,
and some templates are genuinely generic. But it is set per timer, timers are
per matter, and templates in practice name the matter's own documents. Proven:
`LEAK: a timer's narrative template survives a matter change`. At minimum the
re-point should surface it ("this timer's template still says X — keep it?"),
not carry it silently.

### Client-side caches, refs and component state

| Holder | Verdict |
|---|---|
| `ghosttext.js` module `cache` (`cmId → phrases`, 60 s) | keyed correctly, no cross-matter mixing |
| `ghosttext.js` `phrases` state | **S10** — not reset on `cmId` change |
| `closeout.js` `sugg` state (`cm id → lines`) | keyed correctly; not reset by `load()`, but per-matter so it cannot cross |
| `closeout.js` `texts` / `skip` (`g.key`) | keyed `cm:<id>` / `entry:<id>`; reset by `load()`; clean |
| `stopchips.js` `StopChips` key shell, `autoRef`, `ownWriteRef`, `liveRef`, `applied`/`saved` | this is the already-reported bug's fix and it holds — a new stop is a new instance, and `settled` is the intersection of what this offer wrote with what the server says the entry holds |
| `stopchips.js` `useRowSlot` interval | re-resolves the row every 400 ms and removes its slot on unmount; addressed by `data-timer-id` / `data-entry-id`; clean |
| `narrativehistory.js` `rows` / `picked` | **S11** — not reset on `cmId` change |

#### S10 — the ghost list lags a matter switch · **medium**, not proven end-to-end

```js
export function useMatterSuggestions(cmId) {
  const [phrases, setPhrases] = useState([]);
  useEffect(() => {
    if (!cmId) { setPhrases([]); return undefined; }
    …
    api.get(`/api/matters/${cmId}/suggestions`).then(…setPhrases(texts));
  }, [cmId]);
```

On a `cmId` change the hook never clears `phrases` first, so for one round trip
the field is completing from the **previous matter's** narratives. Reachable
the ordinary way: open an entry on matter A, change the matter in the editor's
CM picker (`entryeditor.js:156` re-reads `local?.cm?.id`), keep typing. Locally
that window is milliseconds; over the cloudflared remote path it is not. Fix is
one line — clear on change, and let the cache re-populate.

#### S11 — `NarrativeHistory` does not reset on a `cmId` change · **low**, latent

`narrativehistory.js:33-42` fetches on `[cmId]` but leaves `rows` and `picked`
alone, so a re-pointed instance would render matter A's list, with A's entry
ids still selected, under matter B's title. Both current call sites mount it
fresh (`historyOpen && cmId ? …`, `showHistory && local.cm ? …`) so it is not
live today. Guard it anyway: `setRows(null); setPicked([]);` at the top of the
effect.

---

## What to reconcile when fixing

These existing tests encode the pre-brief design and will fail once the blend
is scoped. They are not regressions — they are the old contract, and each needs
a deliberate decision, not a delete:

- `test/api.matters.test.js` — *"suggestions: a cold matter borrows client
  siblings, not strangers"* (line 64) and *"people: roster ranked by recency;
  cold sibling borrows; strangers do not"* (line 83).
- `test/phrasebook.test.js` — *"client-borrowed occurrences weigh less and are
  flagged"* (line 55). `rankPhrases` itself is pure and fine; what changes is
  whether anyone still hands it `source: 'client'` occurrences.
- `server/routes/matters.js` `THIN_PHRASES` / `THIN_PEOPLE` and the
  `SIBLING_PHRASES` constant become dead if the blend goes.

A distinction worth keeping while fixing: **task-line fragments**
(`entry_tasks.fragment`, e.g. "revise lease") sit much closer to reusable
phrasing than **whole entry narratives** (`entries.narrative`, e.g. "Review and
analyze the Harbor Lease termination notice and confer with T. Vance regarding
same"). If any sibling borrowing survives the fix, the narrative half of the
`UNION ALL` is the half that must not. Simpler and safer: scope both to the
matter and let a cold matter be cold.

---

## Reproduction

```bash
node --test test/integrity.suggestions.test.js   # 8 tests, 8 expected failures
npm test                                          # 633 pass, 8 fail — only these
```

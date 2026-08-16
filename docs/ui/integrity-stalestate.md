# Data-integrity audit — client state that outlives the record it belongs to

Branch `ui-overhaul-2026-08`. Standard: `docs/ui/BRIEF.md` §"Data integrity",
which outranks everything else in this run.

> A **narrative** — the client-facing sentence describing work done on a
> specific matter — may never be shown as belonging to, suggested for,
> pre-filled into, or written onto an entry for a different matter. Not across
> clients, and not between two matters of the same client.
>
> And: no time and no narrative may be lost, dropped, double-counted, or
> silently overwritten without an undo.

**Scope of this pass.** The general form of the stop-chip bug — a React
component holding matter A's state while rendering matter B's record. Every
module-level variable, `useRef`, cache, un-keyed reused component, event
listener closing over a stale record, storage key, and dialog reused for a
second record across `public/js/` (components, views, lib).

**Proving test: `test/integrity.stalestate.test.js`.** Two tests, both written
to FAIL against `ui-overhaul-2026-08`, both driven through the shipped UI in
headless Chromium against a real server on a temp database (one browser, one
server, ~10s in total). They run in `npm test` by default; `TK_SKIP_UI_PROOF=1`
skips them while a screenshot run owns the cores. Do not make them pass by
weakening the assertion — the assertion is the spec.

**Deliberately not duplicated here.** Three findings this sweep re-derived
independently are already proved by other agents' files, and are cross
referenced rather than re-filed: `timers.draft_narrative` and
`timers.narrative_template` surviving a matter re-point
(`integrity-suggestions.md` S7/S8, `integrity-closeout.md` F3, proved in
`test/integrity.suggestions.test.js`), close-out clearing its typed-text map
with the wrong key (`integrity-closeout.md` F9), and `exported_at` being
stamped before the CSV exists (`integrity-closeout.md` F11).

---

## Verdict

Two live defects of the reported shape, both proved by driving the real app.

**The worse one is not a suggestion path — it is the entry editor itself.**
`EntryEditor` loads its record in an effect with an empty dependency list and
`app.js` mounts it with no key, so re-opening the editor on a second entry
while it is already open re-renders the *same instance* and the load never runs
again. Measured: the dialog opened for a **Northgate Partners** entry showed
**Acme Holdings'** narrative, Acme's matter, Acme's hours, and every keystroke
autosaved onto Acme's entry. Nothing on screen says which record it is. The
lawyer's typing never reaches the entry he opened, and it silently overwrites
another client's billing sentence — two of the brief's rules broken by one
missing `key`.

The second is quick capture committing a parse that describes a sentence which
is no longer on screen: correct the matter at the head of the line, press
Enter, and the entry is filed against the client the *previous* wording named.

| # | Where | State held | Keyed by | Severity | Proved |
|---|-------|-----------|----------|----------|--------|
| **S1** | `components/entryeditor.js` + `app.js` mount | the whole record: `entry`, `local` (matter, narrative, hours, task lines, custom values), `entryRef`, `aiUndo`, `caretClaimed` | **nothing** — loaded once per mount | **critical** | yes |
| **S2** | `components/quickcapture.js` | `parsed` (matter matches + narrative) | the line as it was ~200 ms ago | **high** | yes |
| S3 | `components/entrylist.js` `InlineNarrative` | typed narrative `text` | the card key `t<timerId>`, not the entry | medium | reasoned |
| S4 | `components/narrativehistory.js` | fetched `rows` + `picked` ids | never reset on `cmId` change | low (latent) | reasoned |
| S5 | `components/customfields.js`, `cmpicker.js` `EditCmModal`, `timergrid.js` `TimerModal` | the owner/record's fields | mount-time props only | low (latent) | reasoned |
| S6 | `lib/pip.js` `drafts` Map | unsaved narrative text | timer id, which SQLite reuses | low | reasoned |

---

## S1 — CRITICAL — the open entry editor ignores the record it is re-opened for

**What state is held.** Everything. `EntryEditor` keeps the record in
`useState`/`useRef` and fetches it exactly once:

```js
// public/js/components/entryeditor.js:188-220
useEffect(() => {
  (async () => {
    if (spec.id) {
      const e = await api.get(`/api/entries/${spec.id}`);
      setEntry(e); setLocal(toLocal(e));
    } else if (spec.copyFrom) { … } else { … }
  })();
}, []); // eslint-disable-line
```

**What it is keyed by.** Nothing. `app.js` mounts it with no `key`:

```js
// public/js/app.js:857
${editor ? html`<${EntryEditor} spec=${editor} settings=${settings} onClose=${closeEditor} />` : null}
```

so a second `setEditor({ id })` while the dialog is up is a prop change, not a
remount. React keeps the instance; the `[]` effect never re-runs; `entry`,
`local`, `entryRef.current`, `aiUndo`, `customFields`, `caretClaimed` and the
`saveChain` all stay on the FIRST record. `doPersist` then PATCHes
`entryRef.current.id` — the first record — on every keystroke.

**The trigger that exists today** is the float window's "Open entry", which is
the only caller that opens the editor while it may already be open:

```js
// public/js/lib/pip.js:517-521           // public/js/app.js:552-556
b.addEventListener('click', async () => { const onOpenEntry = (e) => setEditor({ id: e.detail.id });
  await saveNarrative(t.id);              window.addEventListener('tk:open-entry', onOpenEntry);
  window.dispatchEvent(new CustomEvent('tk:open-entry', { detail: { id: t.linked_entry_id } }));
  window.focus();                         // ← brings the wrong dialog to the front
});
```

I checked the other doors and they are all closed: a route change nulls
`editor` (`app.js:468-472`), the global shortcut handler stands down while any
overlay is open (`app.js:629`), close-out's capture-phase key handler stands
down while it is covered (`closeout.js:459-463`), and every list that calls
`openEditor` is behind the scrim and `inert` while the dialog is up. **The
float is the one live trigger — but the defect is in the editor's lifecycle,
not in the float**, so any future second caller re-opens it.

**The exact sequence** (this is the proving test, verbatim):

1. Today, two draft entries: Acme Holdings — lease dispute (0.7h, "Reviewed the
   landlord termination notice and the underlying lease.") and Northgate
   Partners — diligence (0.4h, "Reviewed the data room index and flagged three
   missing consents.").
2. Click the Acme row's matter name. The editor opens on Acme. ✔
3. In the float, expand the Northgate timer and press **Open entry**. pip.js
   dispatches `tk:open-entry` for Northgate's entry and calls `window.focus()`,
   so the main window comes forward with the dialog on it.
4. **Measured:** Matter row reads `Acme lease dispute`; the narrative box reads
   `Reviewed the landlord termination notice and the underlying lease.`; one
   `.ovl-panel` on screen; no console error.
5. Type ` Call with opposing counsel re the notice.` and wait for the autosave.
6. **Measured in the database:** Acme's entry is now
   `Reviewed the landlord termination notice and the underlying lease. Call with
   opposing counsel re the notice.` — Northgate's entry is untouched.

**Both halves are integrity failures.**

- *Shown:* Acme Holdings' billing sentence is displayed as the content of
  Northgate Partners' entry. Nothing distinguishes it from the correct dialog —
  there is no entry id, no timestamp, no second panel, no error.
- *Written:* the narrative the lawyer wrote for Northgate lands on Acme,
  overwriting Acme's own sentence with no undo, and Northgate's entry keeps
  looking unwritten. If he then finalizes, the wrong sentence exports on Acme's
  bill and Northgate's row goes out blank.

Only one thing limits it: `doPersist` returns early when the *held* record is
finalized, so a finalized first record cannot be rewritten — the display leak
stands either way.

**Fix direction** (not applied — this pass is read-only on source, and `app.js`
belongs to another agent this wave). Both halves are cheap, and the second is
enough on its own:

- In `app.js`, give the mount a key derived from the spec —
  `key=${editor.id ?? editor.copyFrom ?? 'new'}` — so a new record is a new
  instance. This is exactly the fix `StopChips` already took for the same bug
  (see its wave-2b3 header comment).
- In `entryeditor.js`, make the load effect depend on the spec
  (`[spec.id, spec.copyFrom]`) and, before re-loading, `cancelSave()` and flush
  the in-flight `saveChain` against the OLD `entryRef`, then reset `entry`,
  `local`, `gate`, `audit`, `aiUndo`, `aiBusy`, `historyOpen`, `moreOpen`,
  `tasksOpen`, `codeOpenIdx`, `selText` and `caretClaimed`. Anything not reset
  is a smaller version of the same bug.

A regression test that only checks the narrative would pass on a half-fix;
`test/integrity.stalestate.test.js` asserts the matter row, the narrative box,
and **both** entries in the database.

---

## S2 — HIGH — quick capture files the sentence you replaced

**What state is held.** `parsed` — the server's reading of the line, including
`parsed.matches` (candidate matters, ranked) and `parsed.narrative` (the
sentence that will be billed).

**What it is keyed by.** The line as it stood when the request was sent, which
is up to 200 ms plus a round trip behind what is on screen:

```js
// public/js/components/quickcapture.js:99-119
function requestParse(text, useAi = false) { … timer.current = setTimeout(run, 200); }
function onInput(e) {
  const text = e.target.value;
  setLine(text);
  setPickMatter(null); setPickHours(null); setPickCode(null);
  if (text.trim().length >= 3) requestParse(text);
  else { setParsed(null); setFill(null); }     // ← the ONLY place a stale parse is dropped
}
```

The picks are retired on every keystroke ("the sentence is the source of truth"
— the component's own header calls filing against the wrong client "the one
truly expensive mistake this dialog can make"). The **parse itself is not.** It
is dropped only when the line falls under three characters, which covers a
select-all-and-retype and nothing else. Editing a line in place — the natural
correction — leaves the previous sentence's matter and wording live, and Enter
commits them:

```js
// quickcapture.js:122-124, 168-181, 195-198
const matter = pickMatter || (parsed && parsed.matches[matterIdx]) || null;
…
await api.post('/api/entries', { date: todayStr(), cm_id: matter.id, narrative: parsed.narrative, … });
…
else if (e.key === 'Enter') { e.preventDefault(); advance(null); }
```

**The exact sequence** (the proving test):

1. `q`, type `acme lease dispute review notice .3`. The chip confirms
   `Acme Holdings · Acme lease dispute`, `0.3h`.
2. Wrong matter. Press `Home` and correct the head of the line to
   `northgate diligence review notice .3`. The line never falls under three
   characters, so the Acme parse survives; each keystroke restarts the 200 ms
   debounce, so no new parse is in flight.
3. Press **Enter** — the key this dialog is built around.
4. **Measured in the database:** a new entry, `0.3h` against **Acme lease
   dispute**, narrative `acme lease dispute review notice`. The line on screen
   said Northgate.

The dialog closes and a toast says "Filed as draft — 0.3h on Acme lease
dispute", so it is not silent; the stale matter chip is also on screen at the
moment Enter is pressed. That is why this is high and not critical — but the
whole promise of the surface is "type a line, press Enter", the correction it
punishes is the most common one, and what it produces is billable time on the
wrong client's matter with another matter's wording on it.

**Fix direction.** Make the commit refuse a parse that does not describe the
line on screen. Either stamp the parse with the text it came from
(`parsed.line = text` server-side or client-side) and have `canFile` require
`parsed.line === line`, or have `advance()` await a fresh parse when
`line !== parsedLine`. Do **not** fix it by clearing `parsed` on every
keystroke — that would blank the chips on every edit and reintroduce the
"?" flicker the dialog was rebuilt to remove.

---

## S3 — MEDIUM — the inline row narrative follows the card, not the entry

`components/entrylist.js` (owned by another agent this wave — reported, not
touched).

**What state is held.** `InlineNarrative` keeps the typed narrative in local
state and writes it to whatever entry is in props when the field blurs:

```js
// entrylist.js:104-106, 130-157
export function InlineNarrative({ entry, onChanged, autoEdit = false, onDone }) {
  const [editing, setEditing] = useState(!!autoEdit);
  const [text, setText] = useState(autoEdit ? (entry.narrative || '') : '');
  …
  async function save() { … await api.patch(`/api/entries/${entry.id}`, body); … }
```

**What it is keyed by.** On Today, its row is keyed by the TIMER, not the
entry, and the entry it renders is recomputed on every refresh:

```js
// entrylist.js:434-466
out = []; const byTimer = new Map();
for (const e of list) { const t = timerOf(e); … const row = { key: `t${t.id}`, timer: t, entries: [] }; … }
for (const c of out) { … c.focus = focusEntryOf(c); }   // ← which entry the card speaks for
```

`focusEntryOf` (`entrylist.js:425-432`) prefers the timer's linked entry when
it is substantive, else the largest substantive draft. So a card's `focus` can
move from entry 100 to entry 101 while its key stays `t5` — a stop banks time
into the linked entry, or a second draft on the same matter grows larger. React
keeps the `InlineNarrative` instance; `text` is still what was typed for entry
100; the blur PATCHes entry 101.

Every entry under one card belongs to one timer and therefore one matter, so I
could not construct a cross-**matter** version of this: it is a wrong-**entry**
write inside one matter, which silently overwrites the other draft's narrative
with no undo. Reported as medium on the brief's "no silent overwrite without an
undo", not as a boundary crossing. The list's other lists are safe — `search.js`
`LedgerTable` renders each `InlineNarrative` inside `<tr key=${e.id}>`, and
past-day cards key by `e${e.id}`.

**Fix direction.** Key the inline editor by the entry it edits
(`<${InlineNarrative} key=${e.id} …>`), or snapshot the entry id when editing
opens and PATCH that id.

---

## S4 — LOW (latent) — the reuse dialog keeps the previous matter's rows and picks

`components/narrativehistory.js:26-56`. `rows` is fetched in an effect keyed on
`cmId`, but nothing resets `rows` or `picked` when `cmId` changes:

```js
const [rows, setRows] = useState(null);
const [picked, setPicked] = useState([]);        // entry ids, in pick order
useEffect(() => { … api.get(`/api/matters/${cmId}/recent-narratives?limit=20`)
  .then((r) => { if (alive) setRows(r.entries); }) … }, [cmId]);
```

If the component is ever re-rendered with a new `cmId` instead of being
remounted, then for one round trip the dialog is titled
`Reuse a narrative — <new matter>` while listing the **old** matter's
narratives, `picked` still holds the old matter's entry ids, and `Insert`
writes the old matter's sentence onto the new matter's entry.

**Today it is unreachable**, and I say that as a finding rather than an excuse:
both callers make a new instance per matter. The editor renders it only over a
focus-trapped panel where the matter picker underneath cannot be reached
(`entryeditor.js:1069-1072`), and `StopChips` is now keyed per stop, which was
the wave-2b3 fix for the reported bug (`stopchips.js` header). It is on this
list because it is the same latent shape one caller away, and because the fix
is two lines: `useEffect(() => { setRows(null); setPicked([]); }, [cmId])`, or
`key=${cmId}` at both mount sites.

---

## S5 — LOW (latent) — three dialogs read their record once, at mount

The same shape, in dialogs whose record cannot currently change while they are
open (each is opened from a list that the dialog itself covers). Listed so the
next person who adds a second caller does not find them the hard way:

| File | State | Read from props |
|------|-------|-----------------|
| `components/customfields.js:13-15` | `fields` for one owner | `useEffect(…, [])` — `ownerQuery` frozen at mount; `add()` posts `{...owner}` from current props |
| `components/cmpicker.js:284-296` (`EditCmModal`) | CM number, short name, client name, task-billing, billable, favorite | `useState(existing.…)` initializers; `save()` PATCHes `existing.id` from **current** props |
| `components/timergrid.js:1678-1712` (`TimerModal`) | name, matter, task code, group, template | `useState(timer.…)` initializers; `save()` PATCHes `timer.id` from **current** props |

In each, a prop change without a remount would write record A's field values
onto record B. `EditCmModal` is the sharpest: it would renumber a matter.

`TimerModal` also has a live, non-latent quirk worth naming: it sends
`narrative_template` and `cm_id` in one PATCH, so changing a timer's matter
re-sends the template written for the old matter. That is the client half of
`integrity-suggestions.md` S8 — see there, not here.

---

## S6 — LOW — the float's unsaved-draft map is keyed by an id SQLite reuses

`lib/pip.js:382-383, 433-459`. `drafts` (timer id → unsaved narrative text) is
cleared only when its PATCH succeeds:

```js
const drafts = new Map(); // timer id → unsaved narrative text
…
if (drafts.get(id) === text) drafts.delete(id);   // only on success
```

`timers.id` is `INTEGER PRIMARY KEY` with no `AUTOINCREMENT` (`server/db.js:65`,
and again at the `timers_new` rebuild), so SQLite reuses the id of the
highest-numbered row after it is deleted. Compound but real: type a narrative in
the float while the server is unreachable (the text stays in the Map), delete
that timer, create a new one for another matter — it gets the same id, and
`buildNarrativeField` prefers the map over the timer's own value
(`pip.js:473`), so the new matter's row shows the old matter's sentence and
autosaves it onto the new matter's entry.

Not proved: Document Picture-in-Picture is unavailable in headless Chromium, so
this one is read, not measured. The fix is to clear `drafts`/`debounces` for any
id that leaves `buildPipRows`, next to the existing `expandedId` sweep
(`pip.js:682`).

---

## Checked and clean — do not "fix" these

Negative results matter as much as findings; each of these was on the suspect
list and came off it.

- **No client-side storage holds narrative text.** Every `localStorage` key in
  the app is a preference or an id: `tk:listDensity`, `tk:timerGrouping`,
  `tk:timerOnly:<grouping>`, `tk:timerActivity`, `tk:timerOrder`,
  `tk:lastTimer`, `tk:pipRows`, `tk:pipExtras` (ids, guarded by a date stamp).
  Nothing durable survives a session carrying client facts. No `sessionStorage`
  use at all.
- **`entryeditor.js` custom values across a matter change.** `local.custom_values`
  does survive a matter switch, but the server drops every key that is not
  effective for the entry's *current* matter
  (`normalizeCustomValues`, `server/routes/entries.js:77-90`), so the only
  values that carry are client-level fields the two matters genuinely share.
  Correct as built.
- **`cmpicker.js` `restingCache`** (module-level, 30 s TTL) caches only the
  empty-query matter list, and is invalidated on create/edit. Matter metadata,
  no narratives.
- **`ui.js` `justFinalized`** — a `Set` of entry ids with a 600 ms expiry, used
  only to fire an animation once. Keyed correctly.
- **`ui.js useAsync`** cancels a superseded fetch through the effect cleanup.
- **`views/calendar.js` `lastView`** (module-level) holds `{mode, anchor,
  selected}` — dates, not records.
- **`components/menu.js`** row menus act on ids captured when the menu opened;
  a stale snapshot cannot retarget another record.
- **`components/closeout.js`** keys its typed text and skip flags by the group
  key (`cm:<id>` / `entry:<id>`) and its suggestions by `cm.id` — the right
  keys. (Its one wrong-key clear is `integrity-closeout.md` F9.)
- **`components/shortcuts.js` `cached`** — the text-expansion dictionary, which
  the brief says is shared by design.

---

## Considered and dismissed under the BRIEF

`components/ghosttext.js:11-38`. `useMatterSuggestions` keeps a module-level
`Map` keyed by `cmId` (correct), but on a matter switch it leaves the previous
matter's phrases in state until the new fetch resolves — it only clears when
`cmId` is falsy. For that round trip the editor's ghost completions, and the
`editor-suggest-chips` built from the same list (`entryeditor.js:69-83, 252`),
come from the previous matter.

The brief is explicit that the phrasebook and ghost text are shared by design
and must not be reported as leaks or scoped per matter, so **this pass does not
file it.** Noted here only so the next auditor does not re-open it, and because
`integrity-suggestions.md` S10 takes a different view of the same code — that
call belongs to whoever owns the suggestion sources, not to this sweep.

---

## Suggested fix order

1. **S1** — key the editor mount and/or reload on a spec change. One missing
   `key`, and it is the app's core dialog writing to the wrong record.
2. **S2** — refuse to file a parse that does not match the line on screen.
3. **S3** — key the inline narrative editor by its entry.
4. **S4/S5** — reset-on-prop-change (or a `key`) in the four dialogs, as
   cheap insurance before another caller arrives.
5. **S6** — clear the float's draft map for rows that leave the list.

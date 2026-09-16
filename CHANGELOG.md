# Changelog

A run log for the `/todo` skill (see `.claude/skills/todo/SKILL.md`) — every
invocation appends a dated entry here, whether it shipped something or found
nothing to do. This exists because the sidebar's "Run /todo" status can lag
(it polls a tmux window, not a push signal), so this file is the
authoritative record of what actually happened on the last run.

Newest entries first.

## 2026-09-16

- **Dashboard entry cards: added an AI narrative-assist button (Expand /
  Shorten / Rewrite).** UI feedback: the "Today's entries" cards on the
  dashboard have click-to-edit narratives, but the only way to reach the
  AI rewrite was to open the full entry editor. Asked David how the button
  should handle "Expand → split into tasks" (the editor mode that rewrites
  task lines), since the compact card has no task-line editor to show the
  result in — he chose: run Expand/Shorten/Rewrite inline, and have the
  split option open the full editor instead of reimplementing it. Built
  that: a small split-button (main action re-runs whichever task was last
  used, shared via the same `tk:lastAiTask` key the editor already uses;
  the caret opens the full menu) streams tokens from `/api/ai/narrate`
  straight into the card, same as the editor does, then PATCHes the result
  with the same AI-provenance fields the editor sends
  (`narrative_manual`/`narrative_ai`/`ai_brief`/`ai_draft`) and offers a
  toast "Undo" (the app's existing undo-toast pattern, e.g. delete) rather
  than porting the editor's separate Undo button. "Expand → split into
  tasks" opens the full editor via the existing `openEditor` prop.
  Files: `public/js/components/entrylist.js` (new `useAiAssist` hook and
  `InlineAiAssist` component; `EntryList` fetches `/api/ai/status` once for
  the whole card list rather than per card), `public/css/app.css` (narrative
  + AI button share a row, wraps on narrow viewports), `public/sw.js`
  (cache bump v117).
  Verification: `npm test` — 694/694 pass (no new pure-function logic here,
  so no new unit tests — this is a thin UI wrapper around the already-tested
  `/api/ai/narrate` and `/api/entries` endpoints). `node scripts/e2e-smoke.mjs`
  — all clear except the pre-existing "stalled time" export-filter flake
  (unrelated timing test, reproduces on unmodified master too). Additionally
  drove the actual feature in headless Chromium against a scratch
  server + temp database with the real local Ollama (already running on
  this box) — never touched production data — and confirmed live: the
  button renders, Expand streams a real rewrite into the card, the Undo
  toast reverts it, and the caret menu's "Expand → split into tasks" opens
  the full editor.
  Left out: the editor's "Last AI request" debug panel — audit-only, not
  needed for a quick inline action.

## 2026-09-15

- **Narrative ghost-text: fixed the flicker-off on the first matched letter,
  and it now corrects the typed case on accept.** UI feedback: typing toward
  a suggested entity/person name (e.g. "with " triggers "A. Turner") made the
  grey ghost text vanish the instant you typed its first letter, only to
  reappear once you'd typed two. Cause: the mid-word match required 2+ typed
  characters, but the trigger-word suggestion had already been showing the
  full name at 0 characters — so 1 character was a dead zone. Also added:
  matching is explicitly case-insensitive, and Tab-accepting now corrects the
  already-typed prefix to the candidate's real casing (type "s", Tab into
  "S. Minhas", not "s. Minhas") — phrasebook (tier 1) completions are
  untouched, since their casing contract is deliberately "typed part stays
  exactly as typed."
  Files: `public/js/lib/ghost.js` (new `ghostMatch` returning `{text,
  prefixFix}`; `ghostCompletion` is now a thin wrapper kept for its existing
  callers/tests; mid-word match threshold lowered from 2 chars to 1 for tier
  2 only), `public/js/components/ghosttext.js` (consumes `ghostMatch`; new
  `acceptGhost()` applies `prefixFix` before appending on Tab), `public/sw.js`
  (cache bump v116).
  Tests: `npm test` — 694/694 pass (18/18 in `test/ghost.test.js`, 4 new).
  `node scripts/e2e-smoke.mjs` — all clear (one unrelated "stalled time"
  export-filter failure reproduced on a clean run of unmodified master too,
  and passed on a second run against this change — pre-existing timing
  flake, not caused by this fix).
  Left out: the candidate-list (↓) accept path was not touched — it inserts
  an already fully-cased name, not a partial match, so it was never affected.

## 2026-09-14

- **Edit-entry modal: added an "edit matter" pencil next to Client/Matter.**
  UI feedback: from the entry editor there was no way to open the matter for
  editing — you had to close the entry, go to Clients/Matters, find the row,
  and re-open your original entry after. Clicking the picker only let you
  *change* which matter the entry uses, not edit the current one.
  - `entry.cm` (the object the entry editor already had) is a narrow embed —
    it carries `client_name` for display but not `client_id`, which the
    existing edit-matter form (`EditCmModal` in
    `public/js/components/cmpicker.js`) needs to know whether to show/patch
    the shared client-name field. Rather than widening that embed (used
    elsewhere and deliberately narrow), added `GET /api/cms/:id`
    (`server/routes/cms.js`) returning the full record — the same shape
    `GET /api/cms` and the picker already return, just for one id. New test:
    `test/api.cms.test.js` ("GET /api/cms/:id returns the full record,
    including client_id, or 404").
  - `public/js/components/entryeditor.js`: new pencil button next to the
    Client/Matter picker (`openMatterEdit`) fetches the full record and
    opens the existing `NewCmModal`/`EditCmModal` — the very same modal the
    Clients/Matters page uses, not a new one. On save, re-fetches the record
    (`onMatterEdited`) rather than trusting the CM-patch response, because
    `EditCmModal` patches the client name/task-billing in a second request
    *after* the CM patch it returns — same ordering `cms.js`'s own flow
    already has to work around by reloading.
  - `public/sw.js` CACHE bumped to v115.
  - Deliberately left out: no change to the narrow `entry.cm` embed shape
    itself, and no new route beyond the single-record GET — both would have
    been broader than this one feedback item asked for.

  Verified: `npm test` 691/691 (includes the new test above); `node
  scripts/e2e-smoke.mjs` all clear; manually confirmed in a scratch-DB
  browser screenshot — pencil opens "Edit client/matter" pre-filled with
  CM number, client name ("Cerebras"), and short name ("General").

- **Entry cards on the dashboard now show the client name alongside the
  matter name.** UI feedback screenshot: a card only showed the matter's own
  short name (e.g. "General") with no client context, so two matters that
  reuse a short name (a common thing across clients) looked identical at a
  glance. `entry.cm` already carried `client_name` from the server's
  `enrich()` join (`server/routes/entries.js`) — the edit-entry modal was
  already using it via `clientLabel()`, so this was a display-only gap, not a
  data gap. File: `public/js/components/entrylist.js` — the card's title now
  renders `clientLabel(e.cm) + ' - ' + e.cm.short_name` (falls back to the
  bare matter name when the client is still unnamed), matching the format
  David gave in the screenshot annotation ("Cerebras - General"). The CM
  number chip next to it is unchanged. `public/sw.js` CACHE bumped to v114.
  Verified: `npm test` 691/691; `node scripts/e2e-smoke.mjs` all clear;
  manually confirmed in a scratch-DB browser screenshot showing "Cerebras -
  General" on the card.

- **Dashboard timer grid now opens on "Recent" instead of "All", by direct
  instruction.** The dashboard's default view (by-group mode, no tab picked
  yet) landed on "All" — every timer ever created. Now it opens on the
  existing "Recent" activity tab (the rolling two-week window; see
  `public/js/lib/activity.js`), so a long-lived install doesn't show months
  of stale timers on open. Scoped narrowly: only the FIRST-visit default for
  the primary "group" view changed. Switching INTO "By client" for the
  first time still defaults to "All" — that's a deliberate secondary view,
  and defaulting it to Recent too hid a client whose timer just hadn't run
  in two weeks (caught by 3 e2e regressions on the first attempt, fixed by
  scoping the change to `grouping === 'group'` only). File:
  `public/js/components/timergrid.js` (activeTab's two fallback spots).
  `public/sw.js` CACHE bumped to v113. New e2e step in
  `scripts/e2e-smoke.mjs` clears the persisted tab, forces a real reload
  (`page.reload`, not `page.goto` to the same hash — that's a same-document
  no-op and doesn't remount the component, which is why the first version
  of this check falsely passed as "All"), and confirms Recent is what
  renders. Verified: `npm test` 690/690; `node scripts/e2e-smoke.mjs` all
  clear on a clean run (one run hit the same pre-existing unrelated
  stalled-time-export flake noted above; cleared on retry).

- **Quick-add matter: paste-parsing now also works pasted straight into the
  Client number field, plus an explanatory hint.** Follow-up to the
  quick-add-matter feature below, by direct instruction. David couldn't find
  the button, and once shown where it was, asked for a hint that pasting
  works. While adding it I found the earlier fix only covered pasting into a
  CmPicker SEARCH box before clicking "+ New client/matter" — the "New CM"
  button opens the create form with nothing pre-typed, so pasting a
  paragraph straight into its Client number field did nothing (the field
  only ever read plain digits or a name query). Fixed
  `public/js/components/cmpicker.js`'s `CreateMatterModal`: that field now
  runs `extractCmDigits` on every input, so a paste there — bare CM# or
  buried in a paragraph — fills both the client and matter number fields
  from either entry point. Hint text on the "Client number" field and its
  placeholder now say this out loud. New e2e step in
  `scripts/e2e-smoke.mjs` covers the direct-paste path (the existing step
  only covered the picker-search path). `public/sw.js` CACHE bumped to
  v112. Verified: `npm test` 690/690; `node scripts/e2e-smoke.mjs` all clear
  on a clean run (one run hit 3 unrelated pre-existing flakes — multi-select,
  timer search bar, stalled-time export — that reproduce without this
  change and cleared on retry).

- **`/todo` policy change: no more "backlog idea" deferral.** David asked
  for this directly after the quick-add-matter item below got flagged twice
  instead of built. `.claude/skills/todo/SKILL.md` step 2 and its Notes
  section, and `TODO.md`'s own header, no longer treat a feature-shaped
  feedback item as a reason to punt to a separate spec/plan step — every item
  is now an active task to build end to end. The only thing that still
  pauses a run is a genuine ambiguity the codebase can't answer (ask 1-3
  focused questions, per David's global CLAUDE.md) or a verification failure.

- **Implemented, by direct instruction: quick-add matter button.** David
  overrode the earlier flag below and asked for the build directly. Most of
  the requested behavior already existed in the "New client/matter" form
  (`public/js/components/cmpicker.js`'s `CreateMatterModal`) — client
  prefill-if-exists, billable-by-default, task-billing-off-by-default were
  all already there. Two real gaps closed:
  - **Paste-anywhere CM# parsing.** The old prefill logic
    (`initialQ.replace(/\D/g,'')`, then first-6/next-6 digits) broke on
    anything but a bare CM# — any other digit in a pasted paragraph (a date,
    a ZIP) shifted the split. New pure function
    `public/js/lib/cmparse.js::extractCmDigits` finds the 6+6 digit CM#
    pattern anywhere in arbitrary text via lookaround (rejects any digit run
    that isn't exactly 12 digits, split by at most one separator), tested
    against 12 fixtures in `test/cmparse.test.js` including a whole
    paragraph with an unrelated date and ZIP code nearby.
  - **Auto-created, grouped timer.** Clarified with David: "grouping" meant
    timer groups (matters have no grouping concept of their own). Quick-
    adding a matter now also creates a timer for it in a "Timer group" you
    pick right there — UNLESS the picker is already inside the "New Timer"
    form (`timergrid.js`), which has its own Group field for the timer it's
    about to create; that path passes the new `alsoCreateTimer={false}` prop
    to skip the redundant field/timer. New prop threaded through
    `CmPicker` → `NewCmModal` → `CreateMatterModal`.
  - Files: `public/js/lib/cmparse.js` (new), `public/js/components/cmpicker.js`,
    `public/js/components/timergrid.js`, `public/sw.js` (CACHE bump to v111),
    `test/cmparse.test.js` (new), `scripts/e2e-smoke.mjs` (two new steps).
  - Verified: `npm test` — 690/690 pass. `node scripts/e2e-smoke.mjs` — all
    steps pass, including the two new ones (grouped timer auto-created on
    the Clients & Matters page; New Timer's own nested create does NOT
    double-file a timer).
  - Left out deliberately: the separator between the two 6-digit groups is
    limited to zero or one character (hyphen, space, period, or none) —
    matches the three formats David listed; a separator with surrounding
    text between the two numbers is not handled.

- **Flagged again, nothing implemented.** Re-ran `/todo`; TODO.md's only live
  item is still the "quick-add matter button" idea flagged below in this
  same run's earlier entry — no change to it, so it stays in the backlog
  for a spec rather than a guessed implementation.

- **Flagged, not implemented: TODO.md item (2026-09-14 08:59), "quick-add
  matter button."** This is a new UI flow (a CM#/client/matter quick-create
  form with free-text CM-number parsing out of pasted text, client-name
  prefill, billable/task defaults, and a grouping picker), not a bug fix —
  left in TODO.md's backlog for a proper spec/plan rather than guessing at
  the parsing rules and UI placement.

- **TODO.md feedback (2026-09-12 13:07), the entry-card finalize icon read as
  ambiguous.** Each entry card's action row swapped between an open and a
  closed padlock glyph for draft vs. finalized — screenshot showed David
  circling that icon as confusing at a glance. `public/js/components/entrylist.js`:
  both states now render the same "lock" glyph; only the finalized state adds
  an `entry-lock-btn finalized` class. `public/css/app.css`: that class gives
  the button a light red border/fill (mirrors the existing `.timer-stop-btn`
  color-mix pattern), so a glance at the color says "finalized" instead of
  reading two different padlock shapes. Tooltips are unchanged ("Finalize" /
  "Unlock") — only the glyph and color changed. Other "unlock" icon usages
  (export view, search bulk actions, entry editor) were left alone — not
  flagged in the feedback and a different context. Verified visually: booted
  a throwaway server instance with a seeded draft and a seeded finalized
  entry and screenshotted the day view (script discarded after, not
  committed) — draft entry shows a plain lock icon, finalized entry shows the
  same lock icon with the light red fill. Tests: `npm test` 689/689 (no
  server code touched), `node scripts/e2e-smoke.mjs` 47/47 (no e2e coverage
  exercised this specific icon; nothing broke).

- **TODO.md feedback (2026-09-12 13:03), day view's "Finalize Day" button too
  similar to "Close Day" — replaced it.** The day view (`public/js/views/day.js`)
  had its own plain "Finalize day" button that posted straight to
  `/api/finalize-day` with no review step, confusingly close in name to the
  dashboard's "Close the day", which opens a one-card-at-a-time review sweep
  before finalizing and exporting. Swapped the day view's button for the same
  "Close day" sweep, scoped to whatever date is in view (past or present).
  `public/js/components/closeout.js`: added an optional `date` prop and a
  `loadDay()` helper so the sweep can read one day's entries from
  `/api/entries?from=X&to=X` instead of always reading "today" from
  `/api/dashboard`; the empty-state message now names the date instead of
  always saying "today". `public/js/views/day.js`: imports `CloseOut`, opens
  it from the new "Close day" button instead of calling `finalizeDay()`
  directly (that function stays — the Export button's "finalize first" gate
  still uses it). `public/sw.js`: bumped `CACHE` to v109 for the JS change.
  Tests: `npm test` 689/689 pass (no server code touched). Updated the e2e
  regression step in `scripts/e2e-smoke.mjs` that used to click "Finalize
  day" directly — it now clicks "Close day" and waits for the sweep's empty
  state on a far-past date; `node scripts/e2e-smoke.mjs` 47/47 steps pass.
  Left alone: the dashboard's own "Close the day" (today only, `c` shortcut)
  is unchanged; the day view has no `c` shortcut binding — not asked for.

## 2026-09-09

- **TODO.md feedback (2026-09-03 22:26), "needs a summary button for
  today's entries to plug into ChatGPT" — already shipped, no code change.**
  Both the Day view (`public/js/views/day.js`) and the Dashboard's
  today-footer (`public/js/components/todayfooter.js`) already have a
  "Summary" button (also bound to the `s` key) that opens a plain-text
  rendition of the day — client, matter, hours, narrative — via
  `buildDaySummary`/`SummaryModal`, explicitly documented as "for reading
  back and pasting into email" (equally suited to ChatGPT). That code
  shipped 2026-07-24, before this note was written, and the screenshot
  attached to the note shows the button already present on the Dashboard.
  Confirmed via the existing e2e-smoke.mjs step ("day summary: button and
  `s` render the day as plain text"), still passing. Flagging for David: if
  this is about the button being hard to notice (small icon button in a
  crowded footer) rather than missing outright, say so and it can be made
  more prominent — no such repositioning was done here since that wasn't
  what the note asked for.

- **Ghost-text autocomplete no longer floats 3px above the real typed text
  in an entry card's inline narrative editor.** `.entry-card
  .narrative-inline-input` carried its own `margin-top: 3px` (to keep the
  card's footprint tight against the label above it) but the ghost-text
  mirror overlay — a sibling `.ghost-wrap` div with `position: absolute;
  inset: 0` — was never shifted by that margin, so the grey suggestion text
  rendered 3px higher than the real caret. Moved the margin from the field
  onto `.ghost-wrap` itself so the field and its mirror move together.
  Confirmed the bug and the fix with exact pixel measurements from a headless
  browser (before: field top 3px below wrap top; after: equal), and added a
  permanent regression step to `scripts/e2e-smoke.mjs` that seeds a
  phrasebook phrase, opens the inline editor, and asserts the two tops match
  (verified it fails on the old CSS, passes on the new). Only the
  card's inline editor was affected — the modal editor's textarea has no such
  margin and was never broken. `npm test`: 689/689 pass. E2E smoke: all
  steps pass (one unrelated step, "stalled time export filter", failed on an
  earlier run and passed clean on a re-run with no code touched — pre-existing
  flake, not caused by this change).

## 2026-09-03

- **A one-click export now warns before it silently drops unfinalized
  entries.** The Day view's "Export" button and the Dashboard's "Export
  today" button used to call the export API directly — which only ever sends
  finalized entries — with no sign that anything was left out. Both now check
  the day in view first: if it holds a draft, a modal ("N entries are not
  finalized and will not be included in this export") offers "Finalize
  first" (runs the existing Finalize day/today flow) or "Export finalized
  only" (proceeds as before). New shared component
  `public/js/components/exportgate.js`; wired into
  `public/js/views/day.js` (day mode only — Week/Month/Range have no bulk
  finalize action) and `public/js/views/dashboard.js`. The dedicated Export
  page already previews drafts and needed no change. `scripts/e2e-smoke.mjs`
  gained a scenario exercising both gate choices. `npm test`: 689/689 pass;
  `node scripts/e2e-smoke.mjs`: all clear except a pre-existing flaky step
  ("stalled time: banner pill → Export filtered...") that also fails
  intermittently on master with no code changes — unrelated to this fix.
  `public/sw.js` CACHE bumped to v107 (JS-only change).

- **Export's plain-text copy now names the client.** The "Copy text" blob on
  the Export page (and the CSV/.TIM feeds it also builds from) already
  carried the matter's short name and CM number, but not who the client was
  — you'd get "Acme lease" with no indication of which client that matter
  belonged to. `server/routes/export.js`'s `text` field now prefixes the
  matter with `<client name> — ` the same way the Day/Dashboard Summary
  button already did (`public/js/lib/daysummary.js`), so pasting either one
  into an outside tool (e.g. ChatGPT) carries the same identifying
  information. The CSV/.TIM columns are untouched — those are tied to the
  firm's billing import format, not a display convenience.
  `test/api.export.test.js` gained a `client_name` on its fixture matter and
  now asserts the text blob reads "Acme Corp — Acme lease". `npm test`: 689/689
  pass.

## 2026-08-30

- **Shipped Stage B: the dictionary is editable.** Settings → Dictionary lists
  what the app has learned for a matter or globally. A wrong capture can be
  renamed, retyped or hidden, and a name the app has never seen can be added
  by hand — a hand-added row predicts immediately, without the two-sighting
  floor. Hiding a person also drops them from the AI prompt roster, so a
  mis-read name cannot be fixed in one place and left saying itself in
  another. ✕ removes a row you added but only HIDES one read out of your
  entries, because deleting that kind would bring it back on the next entry.
- **Shipped Stage A: ghost text now predicts things, not only phrases.** A new
  extractor mines documents and organisations out of your own narratives and
  files them, with the people layer, into one dictionary per matter. Typing
  "review and analyze " now offers a document, "email to " a person, and
  "email to A. Turner " chains to "regarding <document>"; ↓ opens a short list
  of the alternatives. Documents stay on their own matter, while
  organisations and people cross between a client's matters. Predictions need
  two sightings, so a one-off typo never becomes a suggestion. Backfilled 414
  rows from existing history, 95 of them already predicting.

- **Specced and planned: entity-aware ghost text.** The 2026-08-30 10:55 item
  now has a design doc and a 10-task implementation plan, split into two
  stages so the predictions can be lived with before the Settings dictionary
  is built. Four directions were confirmed with David and two design errors
  were caught while planning (a UNIQUE that would not have constrained the
  global rows, and a rebuild that would have erased his hand edits). No code
  written.
- **Flagged, not built: entity-aware ghost text.** The 2026-08-30 10:55 item
  asks the ghost text to predict documents, people, and entities the matter
  has seen ("review and analyze" → "Development Agreement"). That is a new
  extraction layer plus a change to how completions are ranked, not a fix —
  it stays in TODO.md pending a spec.

- **Fix: stopping a timer from an entry card now offers the narrative chips.**
  The play/stop button on a draft entry card filed the time silently, while
  the same stop on a timer card popped the one-tap narrative suggestions. Both
  stops now show the same chips.

- **Fix: a client sibling no longer lends its whole narratives.** When a
  matter's own history is thin the phrasebook borrows from the client's other
  matters. It borrowed finished narratives too, so a chip under Microsoft
  matter LVL08 offered work recorded on matter YEL. Borrowing is now limited
  to task-line fragments; the matter's own narratives are unaffected.

- **Fix: matter tags no longer reach the narrative suggestions.** A phrase
  imported as "(YEL) All-hands call with…" was offered verbatim as a
  suggestion chip and as ghost text, so the tag of one matter could be typed
  into an entry for another. The phrasebook now strips a leading matter tag,
  and a tagged and an untagged copy of the same phrase count as one.

## 2026-08-19

- **Fix: the float timer's day total now counts the whole day.** The
  always-on-top float showed only the hours of the timers in its own window,
  missing manual entries, quick captures, and stopped timers. It now shows the
  day's full recorded total (all entries, live), matching the dashboard, via a
  new lightweight GET /api/day-total.
- **New: edit an entry's hours right on the card.** Each draft entry's hours
  number now has up/down carets that step it by one increment, and clicking
  the number turns it into a box you type into — no editor round-trip. Saves
  through the same total_override path as the editor; a single-task entry's
  line follows the total automatically. Read-only while a timer runs (the
  number is ticking live then) and for finalized entries.
- **Change: "New entry" button moved to the entries list.** The primary
  "New entry" button now sits at the right of the "Today's entries" header,
  next to the list it adds to, instead of the top toolbar. Finalize today and
  Export today stay at the top. The `n` shortcut is unchanged.
- **Fix: "Needs attention" no longer nags about today.** The per-entry
  validation pills (empty narrative, no matter) now appear only for prior
  days, which are done and billable. Today's drafts are work in progress, so
  the banner leaves them alone. Each prior-day pill now shows its date.

## 2026-08-14

- **New: Reuse a narrative.** The entry editor's Narrative row has a "Reuse"
  button that opens this matter's last 20 narratives, newest first, with
  repeats collapsed to one row carrying a use count. Tick one or several and
  Insert joins them into a single clause list, in the order picked, added to
  whatever is already in the box rather than replacing it.

- **Today's entries now count up while a timer runs.** An entry's hours only
  moved when the timer stopped, so the row read 0.0 next to a clock showing
  real elapsed time. The number now ticks once a second against the running
  timer, rounded exactly like the timer card, and the "running" chip says so.

- **An emptied narrative no longer sticks empty under written task lines.**
  Clearing the AUTO box marked the narrative "durably manual", and the server
  then refused to regenerate it — so an entry could sit blank and unfinalizable
  with two fully written task lines directly above it. An empty narrative is
  now never treated as manual, on either side.

- **New client/matter now gets a Task billing checkbox, and starts off.** A
  matter created inline behaved as though its client required task billing:
  the client row defaulted to `task_billing = 1`, and the create modal had no
  way to say otherwise. Every entry on that matter then blocked at finalize
  with "Entry has no task lines." Task lines are now a task-billing
  requirement instead of a universal one — a block-billed client finalizes on
  narrative plus entry total, which the CSV export already handled.

## 2026-08-11

- Stopped **Expand → split into tasks** lowercasing proper nouns. The split
  contract was the only prompt in the app containing the word "lowercase",
  and the split was the only path that case-folded — an 8B applies a rule
  about the first word to the whole clause. Measured on the reported entry:
  plain Expand 0 of 4 runs folded, the split 1 of 4, and 0 of 12 with the
  word removed. Task lines may now start with a capital letter.

- Fixed **Expand → split into tasks** returning short, collapsed task lines
  when plain Expand on the same text read fine. Two causes, both structural.
  First, the split was the only AI feature in the app running with **no
  examples at all** — the code assembled the same demonstrations plain Expand
  uses and then dropped them before sending. Second, when the narrative was
  already divided into clauses, the split asked the model to work out a
  division you had already made; it now asks for a rewrite of each clause
  instead, one for one. Measured on the reported entry, the old prompt
  returned four task lines for five clauses on a third of runs and reordered
  or merged them on others. The new one returned five for five, in order,
  three runs out of three.

- Fixed the task lines refusing to take time you just added to the entry
  total. Raising **Total hours** left an unallocated remainder, but every
  attempt to type that remainder into a task line was immediately taken back
  out of the other lines, so the lines could never reach the new total. A
  growing line now spends the unallocated remainder first, and only pulls
  from the other lines once the remainder is gone.

## 2026-08-08

- Clients & Matters: new **Export CSV** button downloads the whole roster —
  every matter, archived included — via `GET /api/cms/export`. Also produced
  the current roster as a Gmail draft to the work address, held unsent for
  review.

## 2026-08-06

- Added timer multi-select: Ctrl/⌘-click toggles a card, Shift-click extends
  the range, and right-clicking inside the selection opens a batch menu
  (move to group, pin/unpin, delete N timers). Batch delete goes through a
  new all-or-nothing `POST /api/timers/batch-delete`. Esc or a plain click
  clears. Right-clicking a single timer already opened its menu — unchanged.
- Fixed mouse-selecting text inside a timer's inline name/clock edit starting
  a drag instead — the card is no longer draggable while an edit is open. Also
  added Trello-style relocation feedback: the dragged card fades and a dashed
  slot opens where it will land.
- Fixed AI rewrite putting shorthand back into text that had already been
  expanded ("A. Hollowell" → "ah"). The abbreviation glossary is now written
  one-directionally and is dropped entirely from rewrite prompts, which get
  a rewrite demonstration instead. Measured against llama3.1:8b: shorthand
  leaked back in 3 of 3 runs before, 0 of 3 after.
- Picking a timer from the float window's Find box now STARTS that timer,
  instead of only adding it to today's list. It follows the same path as the
  row's ▶ button, so the server's start-exclusivity stops whatever was
  running and that timer gets the close-out pane to narrate.
- Renamed the first field of the New client/matter modal from "Client" to
  "Client number", and reworded its hint and placeholder to lead with the
  6-digit number ("Type the 6-digit number — or type a name to search
  existing clients"). The field always accepted both a number and a name
  search; the generic "Client" label made it read as a free-text name box.

## 2026-08-04

- Fixed the "Run /todo" sidebar button never returning to neutral after a
  run finished. Root cause: its "running" status was derived purely from
  whether the tmux window named `todo` existed — but the window is
  deliberately kept open after the command exits (`exec bash -i`, so David
  can review the transcript later), so the button stayed lit indefinitely.
  Also, the frontend only checked status once on mount, so it wouldn't have
  updated even if the backend had been correct.
  - `server/lib/agentsession.js`: added `paneIsRunningAgent`, which checks
    the pane's foreground command (`claude` vs. the parked `bash`) instead
    of window existence.
  - `server/routes/agent.js`: `GET /api/agent/todo` now reports `running`
    from the pane check; `POST /api/agent/todo` closes a finished, parked
    window before launching a fresh run instead of mistaking it for a live
    one and silently no-op'ing.
  - `public/js/components/runtodo.js`: polls status every 5s (matching the
    existing timer-polling pattern in `app.js`) instead of once on mount.
  - Added this changelog and a step in `.claude/skills/todo/SKILL.md` to
    keep it updated every run.
  - Tests: `npm test` (550 pass, including new/updated coverage in
    `test/agentsession.test.js` and `test/api.agent.test.js`).

- Replaced the 5s status poll above with a push: the launched command now
  pings the server the instant it exits, over Server-Sent Events, instead of
  the button asking every 5 seconds.
  - `server/lib/agentsession.js`: `shellWrap`/`newWindowArgs` splice a
    best-effort `curl` call to a new `/api/agent/todo/done` route into the
    launched command, right before the window is parked.
  - `server/routes/agent.js`: added `GET /api/agent/todo/events` (SSE
    stream held open only while a run is live) and `POST /api/agent/todo/done`
    (broadcasts to connected listeners).
  - `public/js/components/runtodo.js`: opens the SSE connection only while
    `running` is true — nothing to watch otherwise, and it avoids a standing
    connection for the app's whole session. Falls back to a re-check on
    reconnect and on tab-visibility change, in case a push is ever missed.
  - Caught during verification: an always-open SSE connection broke
    `scripts/e2e-smoke.mjs`, whose ~30 `page.goto`/`page.reload` calls wait
    on Puppeteer's `networkidle0` — a persistent connection means network is
    never idle, so every navigation after the first would hang until
    Puppeteer's internal timeout. Scoping the connection to "only while a
    run is live" fixed it structurally (e2e never triggers a real run, so
    the connection never opens during the suite) rather than by loosening
    the wait condition.
  - Tests: `npm test` (561 pass; two unrelated pre-existing flakes in
    `db.test.js`/`aivoice.test.js` that only appear under full-suite
    parallelism, not touched by this change — confirmed by running each
    file standalone and by two clean full-suite reruns).
    `node scripts/e2e-smoke.mjs`: clean.

# Changelog

A run log for the `/todo` skill (see `.claude/skills/todo/SKILL.md`) — every
invocation appends a dated entry here, whether it shipped something or found
nothing to do. This exists because the sidebar's "Run /todo" status can lag
(it polls a tmux window, not a push signal), so this file is the
authoritative record of what actually happened on the last run.

Newest entries first.

## 2026-09-09

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

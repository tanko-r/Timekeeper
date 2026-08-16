# Data-integrity audit — export

Branch `ui-overhaul-2026-08`. Standard: `docs/ui/BRIEF.md` §"Data integrity",
which outranks everything else in this run.

> No time and no narrative may ever be lost. **No entry dropped, skipped, or
> double-counted on export. No entry marked exported that did not actually
> reach the file.** Nothing that could cause the owner to leak billable time
> before an export or during one.

**Scope audited:** `server/routes/export.js` (`buildExport`, `POST /api/export`,
`GET /api/export/preview`), `server/lib/csv.js`, `server/lib/tim.js` (the .TIM
writer), `server/lib/dates.js`, `server/lib/attention.js`,
`server/lib/rounding.js`, `enrich()` in `server/routes/entries.js`, and the two
surfaces that drive them: `public/js/views/search.js` (`ExportDialog`,
`scopeFor`, `attentionOf`, `caveatsOf`, `LedgerSelection`) and
`public/js/views/exportview.js`. Existing coverage read first:
`test/api.export.test.js`, `test/csv.test.js`, `test/tim.test.js`,
`test/daterange.test.js`, `test/dates.test.js`.

**Proving test: `test/integrity.export.test.js`.** Fifteen tests against a real
server on a temp database (`test/helpers.js startTestServer`). Ten are marked
`LEAK` and are written to **FAIL** against the tree as it stands — each one is
the evidence for a finding below. Five are marked `OK`, pass today, and are
regression guards for the parts of the export that are correct. Do not make a
`LEAK` test pass by weakening its assertion; the assertion is the spec.

Suite baseline when this audit ran: **687 tests, 644 pass, 43 fail** — every
failure is a `LEAK`/`LOSS` proving test from this wave's integrity audits (mine
adds 10). Nothing in the pre-existing suite is red.

---

## Verdict, in one paragraph

The date arithmetic is the strong part and needs no work: ranges are compared
as `YYYY-MM-DD` strings, so both ends are inclusive, a month boundary is exact,
and neither daylight-saving transition moves an entry by a day — proven, not
assumed. Everything else about the export is built on an assumption that does
not hold: **that producing a JSON response is the same event as the attorney
getting a file.** The server commits `exported_at` before the .TIM is even
built and long before a byte reaches the browser, so a dropped connection
silently retires the time forever. On top of that, the file the assistant
actually keys from — the CSV — is the one file in the system that reports an
entry's hours from its task lines instead of its recorded total, so it
disagrees with the screen, with the .TIM, and with the text summary whenever
those two drift apart, which the app makes easy in three separate places. And
because `POST /api/export` takes nothing but a date range and a status, the
ledger's filters and its row selection cannot scope a file: exporting from a
screen filtered to one matter writes, and permanently stamps, a second
client's time.

Six of these nine findings end the same way — **time that has been marked as
sent and can never be found again**, because every backstop in the app
("not exported yet", the dashboard callout, the `unexported` chip) reads the
single `exported_at` column that was just written.

---

## Findings, in severity order

### E1 — CRITICAL. Entries are stamped exported before any file exists, and stay stamped when none is delivered
`server/routes/export.js:97-106`

```js
if (b.markExported !== false && result.entry_ids.length > 0) {
  const stamp = clock().toISOString();
  const upd = db.prepare("UPDATE entries SET exported_at=? WHERE id=? AND status='finalized'");
  db.transaction(() => result.entry_ids.forEach((id) => upd.run(stamp, id)))();
}
const { entries, exportable, ...out } = result;
out.tim = formatTimEntries(exportable, ...);   // ← built AFTER the commit
res.json(out);                                 // ← delivered after that
```

The commit happens first. The .TIM is rendered after it. The response is
serialised after that. And the file itself is only created a further round trip
later, in the browser, by `downloadText()` in `public/js/views/search.js
run()`. Every one of those steps can fail after the database has already said
"sent":

- the phone drops off Wi-Fi or the cloudflared tunnel blips mid-response — the
  owner's normal remote path;
- the tab is closed or the PWA is backgrounded while the request is in flight;
- anything throws between the commit and `res.json` (Express 5 turns a sync
  throw into a 500 — the transaction is already durable);
- the browser refuses or discards the download.

In every case `run()` lands in its `catch`, shows an error toast, writes no
file — and the entries are now invisible to the "Not exported yet" chip, to the
dashboard's stalled-time callout, and to `attention=unexported`. There is no
undo, no audit row, and nothing on any screen that will ever mention them
again. This is the brief's prohibition word for word: *no entry marked exported
that did not actually reach the file*.

**Proven** — `LEAK: entries are stamped exported even when the response never
reaches the client`. The test opens a raw socket, writes the request, destroys
the socket without reading a byte, and finds all three entries (1.5 h) stamped.

**Fix.** Make delivery and stamping the same event, or make stamping revocable:

1. *Best.* Serve the file as the HTTP response body —
   `Content-Disposition: attachment`, `text/csv` / `text/plain` — and stamp in a
   `res.on('finish')` handler, so the stamp lands only after the body has
   actually flushed to the client. This also removes the "server built a file
   the browser has to re-materialise" hop entirely.
2. *Or* split into two calls: `POST /api/export` returns the file and a
   `export_token`; `POST /api/export/:token/confirm` stamps, sent by the client
   after `downloadText` returns. Unconfirmed exports simply never stamp.
3. *Either way*, record each export as a row (`export_log`: id, stamp, range,
   filter, entry ids, format) so an export can be listed, re-downloaded, and —
   critically — **un-stamped**. Today there is no way to answer "what did I send
   on Tuesday?" and no way to undo a mistaken send.

---

### E2 — CRITICAL. The CSV reports hours from the task lines; everything else reports the entry total
`server/routes/export.js:55-67`

```js
const lines = e.tasks.length > 0 ? e.tasks : [{ task_code: '', duration: e.total }];
for (const t of lines) {
  csvRows.push([..., t.task_code, Number(t.duration) || 0, e.narrative, Number(e.total) || 0, e.id, ...]);
}
```

An entry's billable hours are `total_override` when it is set, otherwise the sum
of its task lines (`enrich()`, `server/routes/entries.js:31`). The screen, the
`.TIM` (`am=Math.round(total*3600)`) and the plain-text summary all use that
number. The CSV's `duration` column does not — it uses the task lines. The
moment the two differ, **the CSV under-bills or over-bills by exactly the
difference**, and two files produced by the same click disagree.

The two do not have to be forced apart; the app pushes them apart on ordinary
paths:

- **Tap the hours on a Today row.** `entryTotalSet()` in
  `public/js/components/timergrid.js` PATCHes `total_override` and never touches
  the task lines.
- **Resume a timer onto a split entry.** Stop at 1.0 h, split it into two 0.5 h
  task lines, go back on the matter for another half hour: the entry now records
  1.5 h with task lines summing to 1.0. (This is the same drift
  `test/integrity.entries.test.js` "LOSS L4" proves from the narrative side —
  one root cause, one fix.)
- **Edit a task line in the entry editor** without retyping the total. The
  editor's own "remaining" figure exists precisely because the two are allowed to
  diverge.

`sum_mismatch` is only a **warn** in `server/lib/validation.js:72`, and all
three finalize paths — close-out `finalize-day`, ledger bulk finalize, the entry
editor — send `ack: true` to clear warnings wholesale. So a mismatched entry
finalizes and exports without the attorney seeing anything specific to it.

**Proven** — three tests: `LEAK: CSV total, .TIM total and the screen total
disagree on one entry` (screen 2.0 h, .TIM 2.0 h, CSV 1.5 h), `LEAK: the same
gap over-bills when the task lines exceed the override` (2.0 h recorded, 2.5 h
in the CSV), and `LEAK: a resumed timer bills half an hour that never reaches
the CSV` (the timer path end to end, no unusual action anywhere in it).

**Fix.** Two parts, and both are needed:

1. **Make the CSV total-faithful.** Allocate the entry total across its task
   lines (`server/lib/allocate.js` already does exactly this kind of
   apportionment for narratives) so the `duration` column sums to `entry_total`
   for every entry. A CSV whose columns do not add up is not a billing document.
2. **Stop the drift at the source.** Either reconcile on write (a PATCH that
   changes `total_override` re-allocates the task lines; a PATCH that changes
   task lines clears a stale override), or promote `sum_mismatch` from `warn` to
   `block`. A warning that three separate "accept and finalize" buttons clear in
   bulk is not a guard.

---

### E3 — HIGH. The ledger's filters and its row selection do not scope the file, but the file's stamps hit everything
`public/js/views/search.js` `scopeFor()` / `LedgerSelection`, and
`server/routes/export.js:91-107`

`POST /api/export` accepts `from`, `to`, `includeDrafts`, `attention`,
`markExported` — and nothing else. There is **no `ids` parameter and no matter
parameter**. `scopeFor()` therefore throws away the client/matter filter, the
search text, the task filter, the billable filter and the explicit row
selection, and sends a bare date range. `caveatsOf()` prints a sentence in the
dialog admitting this, which is honest about the file's *contents* — but says
nothing about its *side effect*: every finalized entry in that range, from every
client, is stamped exported.

Two concrete shapes, both proven:

- **Filtered ledger.** Screen filtered to Acme shows 3 entries and says "3
  entries". Export… writes a file holding 6 and stamps all 6, including three
  Northgate entries the attorney never looked at. If the file is later treated as
  "Acme's time" and only Acme's rows are keyed, Northgate's three entries are
  marked sent and will never surface again. — `LEAK: a ledger filtered to one
  matter exports and stamps a second client`
- **Row selection.** Tick two rows two weeks apart and hit Export… in the bulk
  bar: `scopeFor(..., { useListDates: true })` turns them into a 15-day range and
  all four entries in the span are written and stamped. — `LEAK: a two-row
  selection exports and stamps every entry in the span`

The dialog's `exact` note does say "You picked 2 … this one covers 4", so the
count is not a lie. But there is no way to actually export the two, and the
other two are burned either way. The brief asks this directly: *a filter that
shows 17 entries must export exactly those 17.* Today it cannot.

**Fix.** Add `ids: number[]` to `POST /api/export` and
`GET /api/export/preview` (additive, which the brief's API rule allows) and let
`buildExport` filter on it, ignoring the date range when ids are given. Send the
selection from `LedgerSelection`, and send `cm_id` from the ledger's matter
filter. The dialog then stops apologising for a mismatch that no longer exists.
Until that lands, the honest interim is to refuse to stamp when the caller's
scope is narrower than the file — export, don't mark.

---

### E4 — HIGH. Unexported time older than the 1000 most recent entries is invisible and unreachable
`server/routes/entries.js:232` (`ORDER BY date DESC, id DESC LIMIT 1000`) and
`public/js/views/search.js:814-816, 764-776, 875-891`

`GET /api/entries` caps at 1000 rows, returns no total and gives no "there is
more" signal. The ledger then does three things on top of that truncated list:

- applies "Not exported yet" **client-side** (`filters.exported` is filtered in
  the browser — the endpoint does not carry it);
- computes the "N not sent" counter from it;
- derives the export range from it — `scopeFor()` uses the earliest and latest
  **visible** dates when no explicit date filter is set, which is the default
  state and the state the header's Export… button uses.

So past 1000 entries, the oldest unexported time is uncounted by the stat chip
*and* outside the range the Export… button builds. Unexported time is by its
nature the old time you forgot; this is exactly the population the cap discards
first. The dashboard is no backstop either — `ATTENTION_WINDOW_DAYS = 90` in
`server/lib/attention.js`, and the comment there points at "the Export page's
filters", a page that no longer exists (`public/js/views/exportview.js`).

**Proven** — `LEAK: unexported entries past the 1000-row cap are uncounted and
out of range`: 1200 finalized, never-exported entries; the ledger sees 1000, its
"not sent" counter says 1000, and the export it builds ships 1000. Two hundred
entries cannot reach a file from that screen at all.

**Fix.** Cheapest correct version, all additive:

1. Have `GET /api/entries` return the unfiltered match count (a header or an
   envelope) so the ledger can say "showing 1000 of 1200" instead of silently
   lying, and
2. add an `exported=no` server-side filter so the chip filters the whole table
   rather than the visible page, and
3. make `scopeFor()` fall back to the *server's* earliest owed date rather than
   the earliest visible row. `GET /api/dashboard` already computes the unexported
   set; expose its `MIN(date)`.

A stop-gap that costs nothing: when the ledger receives exactly 1000 rows,
disable the derived-range export and require an explicit From date.

---

### E5 — HIGH. A draft written into the .TIM ships again after it is finalized, with a fresh `ref` each time
`server/routes/export.js:99-102` + `server/lib/tim.js:60`

`includeDrafts` (and `attention=either`, and `attention=unfinalized`) puts draft
entries into the CSV *and* into the .TIM, while `markExported` deliberately
stamps only `status='finalized'`. The dialog states this as a feature: "A draft
goes into the file but is never stamped exported." For the text summary that is
right. For the **.TIM it is a double-billing hazard**: the .TIM is a machine
import for DTE Axiom/TimeSaver, so a draft imported today is a real time entry
in the billing system, and the same entry imports again the moment it is
finalized and exported normally. `ref` is a fresh `randomUUID()` on every render
and `shortref`/`ss`/`ar` are fresh random numbers, so nothing in the second file
lets the receiving system recognise the duplicate.

**Proven** — `LEAK: a draft ships in the .TIM, is not stamped, and ships again
once finalized`: 1.0 h in two .TIM files under two different `ref` values.

**Fix.** Either (a) exclude drafts from the .TIM specifically — CSV and text may
still carry them, since a human reads those — or (b) derive `ref` deterministically
from the entry id plus the database's install id, so a re-import is idempotent on
the receiving side. (b) also fixes deliberate re-exports of finalized entries,
which have the same problem for the same reason.

---

### E6 — MEDIUM. The hours on screen and the hours in the file are rounded differently
`public/js/ui.js:23 fmtHours` vs `server/routes/export.js:61-66` and
`server/lib/tim.js:41`

`fmtHours` only fixes the decimal *count*; it never rounds the value to the
billing increment. A stored 0.75 h reads "0.8" on every screen in the app —
ledger row, day total, and the export dialog's own "N entries · X h" — and
leaves as `0.75` in the CSV and `am=2700` in the .TIM. The comment in
`buildExport` ("display rounding must never change what the billing system
receives") is the right instinct, but it makes the screen the thing that lies.

Off-increment values are ordinary: `secondsToHours()` stores two decimals
whenever rounding is switched off in Settings, `POST /api/entries` accepts any
duration, and the Intapp/CSV importers do too.

**Proven** — `LEAK: screen hours and file hours differ (0.8 on screen, 0.75 in
the file)`.

**Fix.** Round once, at the point of record, not at the point of display: snap
`duration` and `total_override` to the configured increment when they are
written, and have `fmtHours` round to the increment as well as format to it so a
legacy value cannot read differently from what will ship. Then the dialog's
figure and the file's figure agree to the penny by construction.

---

### E7 — MEDIUM. The server will write a blank billing line
`server/routes/export.js` (no narrative check) — proven by `LEAK: POST
/api/export writes a .TIM line with an empty narrative`

`ExportDialog` blocks the two file buttons when any in-scope entry has an empty
narrative, and the comment there records that a previous version shipped three
blank `na=` fields into a .TIM. That client-side guard is currently the only
thing standing between a blank bill and the billing system: the endpoint writes
`na=|` happily, and stamps. Any retry, any other caller, any future surface
reintroduces the bug the dialog was written to prevent.

**Fix.** Refuse at the route: if any entry that would enter a `csv`/`tim` payload
has a blank narrative, return 422 with the offending ids. Keep the text summary
unrestricted — it already renders "(no narrative)" honestly and stamps nothing.

---

### E8 — LOW. `entry_total` is repeated on every task row of a multi-line entry
`server/routes/export.js:61-66`

A three-line entry emits three CSV rows each carrying the full `entry_total`, so
a spreadsheet `SUM(entry_total)` triple-counts it. `entry_id` makes the intent
recoverable, and a careful reader will sum `duration` instead — but `duration`
is the column that does not add up today (E2). Once E2 is fixed, consider
writing `entry_total` on the first row of each entry only, or adding a
`line_of_lines` column.

### E9 — LOW. An inverted date range exports nothing, with no warning
`from=2026-07-20&to=2026-07-01` returns 200, `count: 0`, and a header-only CSV;
the dialog says "Nothing in that range to send." A range whose end precedes its
start is a typo, not an empty week, and should say so.

---

## What is correct, and must stay correct

These are the `OK` tests in `test/integrity.export.test.js`. They pass today and
are guards, not findings.

- **Both ends of the range are inclusive**, and the days either side are
  excluded. `WHERE date >= ? AND date <= ?` over `YYYY-MM-DD` strings.
- **Month boundaries are exact** — a `2026-03-01…2026-03-31` export holds the
  1st and the 31st and nothing from February or April.
- **Daylight saving cannot move an entry.** `2026-03-08` (spring forward, a 23-hour
  day) and `2026-11-01` (fall back, 25 hours) each export as one ordinary day,
  and the .TIM's `wd=` work date is the day the work happened, because
  `fmtWorkDate()` in `server/lib/tim.js` splits the date string instead of
  constructing a `Date`. The whole chain — SQL comparison, `isValidDate`,
  `addDays` (noon-anchored), `fmtWorkDate` — is timezone-proof by construction.
  This is genuinely well built and should not be "simplified" into `Date` math.
- **Nothing is silently dropped between the two files.** Every id in
  `entry_ids` appears as a CSV row and as a .TIM line; the counts match.
- **Matterless time is reported, not hidden.** It is excluded from both files
  (there is nothing to key it under), counted in `unassociated` so the dialog can
  say so, kept in the preview rows so the screen built to find leaks still shows
  it, and never stamped.
- **"Copy as text" stamps nothing** (`markExported: false`), which is the right
  answer for a summary you read rather than send.
- **Unlock clears the stamp.** `finalizeOne` clears `exported_at` on the way back
  up, so an entry edited after an export re-alerts as unexported
  (`test/api.export.test.js` covers this; it still holds).

---

## Suggested order of work

1. **E1** — stamp on delivery, and add an `export_log` with an un-stamp. Every
   other finding here becomes recoverable once an export can be undone.
2. **E2** — make the CSV's `duration` column sum to the entry total, and stop
   `total_override` drifting from the task lines.
3. **E3** — `ids` (and `cm_id`) on `POST /api/export`, so what the screen shows
   is what the file holds.
4. **E4** — a real count and a server-side `exported=no` filter, so old owed time
   cannot fall off the bottom of the ledger.
5. **E5** — deterministic `ref`, or keep drafts out of the .TIM.
6. **E6, E7** — round at record time; refuse blank billing lines at the route.

E1, E3 and E4 are all API-additive and none of them touches the data model, so
they fit inside the brief's "API changes are allowed only where the UI genuinely
cannot work without one, and must be additive" rule. E2 is a server fix in
`buildExport` plus a validation change; no UI work is required for it at all.

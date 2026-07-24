# Day summary — design

**Date:** 2026-07-24
**Status:** approved, ready to plan

## Problem

There is no way to read back what a day's work looked like as prose. The Day
view lists entries as cards; the dashboard shows totals. The only text rendition
in the app is the `text` blob `buildExport` produces (`server/routes/export.js`),
reachable solely from the Export page's "Copy summary" button. That blob is
range-scoped, keyed on `cm_number` + matter short name, and carries **no client
name** — so it does not answer "what did I do today, for whom."

David wants a copy-pasteable text summary of a day's entries showing client
name, matter name, time entered, and narrative.

## Scope

**In:** a pure formatting function, a modal that displays/copies/downloads its
output, and two entry points (Day view, dashboard footer).

**Out:** changing the Export page's existing `text` blob. Export text is a
different job — it is scoped to what was actually exported and is consumed by
the billing workflow. The app will carry two text renditions; that is a
deliberate, revisitable choice, not an oversight.

## Architecture

### `public/js/lib/daysummary.js` (new)

```js
buildDaySummary(entries, { title, increment = 0.1, showDates = false }) → string
```

A pure function over already-enriched entry objects. No new API endpoint and no
new server code.

**Why client-side.** Both entry points already hold fully-enriched entries —
the Day view from `GET /api/entries?from&to`, the dashboard from
`GET /api/dashboard`. Each entry carries `cm.client_name`, `cm.short_name`,
`cm.cm_number`, `total`, `narrative`, and `billable` (`enrich()` in
`server/routes/entries.js`). Formatting them needs no server round-trip, and
keeping it client-side means the summary still works when the PWA is offline on
cached data. There is established precedent for tested client-side pure libs:
`public/js/lib/daterange.js`, `expand.js`, and `timeamounts.js`, each with a
`test/*.test.js` under node:test.

This is a display concern, not a business rule, so it does not belong in
`server/lib/*` under the CLAUDE.md convention.

### `public/js/components/summary.js` (new)

`<SummaryModal text title onClose />` — built on the existing `Modal` from
`ui.js` (`wide`), containing:

- the text in a read-only monospace `<pre class="summary-text">` (scrollable,
  `overflow-x: auto`, wrapping preserved)
- **Copy** — `navigator.clipboard.writeText`, then `emitToast('Summary copied')`
- **Download .txt** — existing `downloadText(name, text, 'text/plain')`,
  filename `timekeeper-summary-<from>[_<to>].txt`
- Esc-to-close and backdrop-close come free from `Modal`.

Clipboard failure (denied permission, insecure context) is caught and reported
via `emitToast(..., { error: true })`; the text stays on screen and selectable,
so Copy failing never blocks the user.

### Entry points

**Day view** (`public/js/views/day.js`) — a `Summary` button in the page head,
before Export. It summarizes whatever range is on screen. In `day` mode the
title is `fmtDateFull(day)` and `showDates` is false; in week/month/range mode
the title is the existing range title and `showDates` is true, which groups
blocks under date headings.

**Dashboard** (`public/js/components/todayfooter.js`) — an icon+label button
next to "Close the day", summarizing today's entries. Sized so the footer still
fits at 412px width (the Android PWA target): icon-only below a narrow
breakpoint, following the footer's existing pattern.

## Output format

Flat, one block per entry:

```
Friday, July 24, 2026 — 6.4h (5.9 billable / 0.5 non-billable)

Acme Holdings — Series B Financing (123456-000123) — 1.2h
  Reviewed and revised draft stock purchase agreement;
  telephone conference with opposing counsel re closing.

Acme Holdings — Trademark Portfolio (123456-000789) — 0.3h
  Reviewed office action.

Beta Corp — General Advice (123456-000456) — 0.5h [non-billable]
  (no narrative)
```

Rules:

- **Header line:** `<title> — <total>h (<billable>h billable / <nonbillable>h
  non-billable)`. The parenthetical is omitted when every entry is billable —
  the common case, and the totals then say nothing new.
- **Blank line** between the header and the first block, and between blocks.
- **Entry head:** `<client> — <matter> (<cm_number>) — <hours>h`, plus
  ` [non-billable]` only when the entry is non-billable. Billable is the norm,
  so tagging it would be noise.
- **Narrative:** indented two spaces, wrapped at 76 characters on word
  boundaries. Long unbreakable tokens (a URL) are allowed to overrun rather than
  be hyphenated. Multi-line narratives keep their own line breaks; each
  resulting line is wrapped and indented.
- **Sort:** client name, then matter short name, then entry id — all
  case-insensitive via `localeCompare` with `sensitivity: 'base'`, matching the
  collation `buildExport` uses for custom-field columns.
- **Hours:** formatted with the same decimal precision as the rest of the UI,
  derived from the rounding increment (`fmtHours` semantics — `increment` 0.1 →
  one decimal). Stored values are formatted, never re-rounded.
- **Multi-day (`showDates`):** entries group under a `fmtDateFull` date heading
  followed by that day's subtotal, in ascending date order. Days with no
  entries are skipped entirely.

Degradation:

- no client name → the matter short name stands alone as the head
- no matter (`cm === null`) → `(no matter)` in place of client+matter, and the
  `cm_number` parenthetical is omitted
- empty narrative → `(no narrative)`
- no entries → the header line, a blank line, then `No entries.`

## Scope of entries included

Everything on the day: drafts and finalized alike, matterless entries included.
No filter toggles. This is a recall and review tool, not an export, so hiding
entries would defeat it. Soft-deleted entries never appear — both feeding
endpoints already exclude `deleted_at IS NOT NULL`.

Drafts are not tagged. The chosen format keeps the entry head to client, matter,
number, and hours; status lives in the Day view's own cards.

## Testing

**Unit** — `test/daysummary.test.js` (node:test), covering:

- the block format for a normal multi-entry day
- the header's billable/non-billable split, and its omission when all billable
- `[non-billable]` tagging
- missing client name, missing matter, empty narrative
- narrative wrapping at 76 chars, including a token longer than the limit and a
  narrative that already contains newlines
- sort order across clients and matters
- `showDates` multi-day grouping with per-day subtotals
- the empty-entries case
- hours precision at increment 0.1 and 0.25

**E2E** — a step in `scripts/e2e-smoke.mjs`: from the Day view, click Summary,
assert the modal opens and its `<pre>` contains the seeded client name, matter
name, hours, and narrative; close it.

**Cache** — bump `CACHE` in `public/sw.js`, required for any `public/js/**` or
`public/css/*.css` change.

## Files touched

| File | Change |
|---|---|
| `public/js/lib/daysummary.js` | new — `buildDaySummary` |
| `public/js/components/summary.js` | new — `SummaryModal` |
| `public/js/views/day.js` | Summary button, modal state |
| `public/js/components/todayfooter.js` | Summary button (today) |
| `public/js/views/dashboard.js` | wire footer button to the modal |
| `public/css/app.css` | `.summary-text` styling |
| `public/sw.js` | `CACHE` bump |
| `test/daysummary.test.js` | new — unit tests |
| `scripts/e2e-smoke.mjs` | summary-modal step |

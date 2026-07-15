# Custom Fields per Client / Matter — Design

**Source:** TODO.md manual note (2026-07-15): *"User should be able to add
custom fields per client or per matter. Some clients require 'Phase' and some
require 'Task' with specific format. User can establish custom fields for
these and others and even add dropdown values per field."*

**Spec'd without David's input** — ⚠️ marks assumptions to ratify. This is the
big one of the batch; worth a skim before execution.

## What

Firm billing systems often demand extra per-entry codes — UTBMS-style Phase /
Task codes, project codes — with per-client formats. Today the app has no
place to record them; David must add them by hand while keying the CSV.

This feature adds:
1. **Field definitions** attached to a **client** (applies to every matter
   under it) or a **matter** (that matter only). A definition = name, type
   (`text` | `select`), dropdown options (for select), an optional format
   regex + human hint (for text), a required flag, sort order, active flag.
2. **Values per entry**, entered in the entry editor, validated at finalize,
   and carried on the CSV export.

## Data model (migration v15)

```
custom_fields
  id, client_id NULLABLE→clients ON DELETE CASCADE,
  matter_id NULLABLE→matters ON DELETE CASCADE,
  name, type('text'|'select'), options JSON-array-text,
  pattern (regex source, text-type only), pattern_hint,
  required 0/1, active 0/1, sort_order
  CHECK exactly one of client_id/matter_id; unique name per owner

entry_custom_values
  id, entry_id→entries ON DELETE CASCADE, field_id→custom_fields,
  value TEXT, UNIQUE(entry_id, field_id)
```

- **Effective fields for a matter** = the matter's client-level fields
  (sort order) followed by its matter-level fields; ⚠️ a matter-level field
  **overrides** a same-named (case-insensitive) client-level field rather than
  duplicating it.
- Options stored as JSON text; they cross the API as real arrays.
- ⚠️ Deleting a definition is blocked (409) once any entry values exist —
  deactivate instead, mirroring the task-codes "renaming or removing a code
  never rewrites past entries" philosophy. Values of deactivated fields stay
  stored, stop rendering/validating/exporting.
- Values survive a matter change on the entry (rows keep their field_id);
  only the *effective* set renders — switch back and the values reappear.

## Validation (finalize gate)

Extends `validateEntry` via a pure `validateFieldValues(fields, values)` in
`server/lib/customfields.js`:

- required field, empty value → **block** `custom_required` (the billing
  system would bounce the entry; same severity as a missing narrative).
- text field with `pattern`, non-empty value not matching → **warn**
  `custom_format` (ack-able — a mistyped regex must never deadlock billing).
- select field, non-empty value not among options → **warn** `custom_option`.

⚠️ The block/warn split above is my call. An unparsable stored regex is
ignored (never blocks).

## API

- `GET/POST /api/custom-fields`, `PATCH/DELETE /api/custom-fields/:id`,
  `PUT /api/custom-fields/order` — definitions CRUD, task-codes style.
  List filters: `?client_id=` / `?matter_id=` / `?includeInactive=1`.
- `GET /api/custom-fields/effective/:matterId` — merged active definitions
  for a matter (what the entry editor renders).
- Entries: `enrich()` attaches `custom_fields` (effective defs) and
  `custom_values` (`{field_id: value}`); POST/PATCH `/api/entries` accept
  `custom_values: {field_id: value}` (empty string deletes the value; ⚠️ ids
  not in the entry's effective set are silently skipped so autosaves never
  409 mid-matter-change). Entry copy duplicates values.

## Export

- **CSV:** after the fixed columns, one extra column per distinct effective
  field *name* across the exported entries, header ⚠️ prefixed `field:`
  (e.g. `field:Phase`, `field:Task`) so a custom field named "task" can't
  collide with the fixed `task` column. Alphabetical, blank where a field
  doesn't apply. No fields defined → CSV byte-identical to today.
- **.TIM:** ⚠️ unchanged. The prototype's field set is frozen and verified
  against the real importer; whether DTE Axiom accepts phase/task keys (and
  under what keys) is unknown. Follow-up with David — likely candidates are
  extra `u*`/task fields once he can inspect a phase-coded .TIM sample.

## UI

- **Definitions:** Clients & Matters page. A "Fields" ghost button on each
  client row and each matter row opens a `CustomFieldsModal` (new component):
  list with inline edit (name, type, comma-separated options / regex + hint,
  required, active toggle, reorder arrows, delete), add-form at the bottom.
  ⚠️ Kept out of the Edit-CM modal to avoid modal-in-modal.
- **Entry editor:** when the picked matter has effective fields, a compact
  row of inputs renders between the date/matter/total header and Task lines —
  `select` for dropdown fields (with an empty first option), text input
  (placeholder = `pattern_hint`) otherwise; required fields marked `*`.
  Values autosave with the entry like everything else. Finalize surfaces the
  block/warn findings through the existing gate UI.
- Timer-created entries simply have no values until edited — the finalize
  block on required fields is the safety net (surfaces in close-out too).
- ⚠️ Entry list rows/day view don't show values (narrative stays the star);
  revisit if David wants chips.

## Non-goals

- No firm-wide (global) fields — attach to a client instead. ⚠️
- No per-task-line values — fields are per entry, like the billing systems
  they feed. ⚠️
- No .TIM mapping yet (see Export).
- Quick capture / AI paths don't set values.

## Touches

`server/db.js` (v15) · `server/lib/customfields.js` (new) ·
`server/routes/customfields.js` (new) · `server/app.js` ·
`server/routes/entries.js` · `server/lib/validation.js` ·
`server/routes/export.js` · `public/js/components/customfields.js` (new) ·
`public/js/views/cms.js` · `public/js/components/entryeditor.js` ·
`public/css/app.css` · `scripts/e2e-smoke.mjs` · `public/sw.js` ·
tests: `test/customfields.test.js`, `test/api.customfields.test.js`,
additions to `test/db.test.js`, `test/api.entries.test.js`,
`test/api.finalize.test.js`, `test/api.export.test.js`.

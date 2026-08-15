// EXPORT IS NOT A PAGE. This file is all that is left of the one that was.
//
// The teardown (§12) ruled MERGE: "into the ledger, as an 'Export…' action plus
// an 'Exported' column and a 'not exported' filter chip", keeping the deep link
// "pointing at the ledger with that chip applied". Last wave the column and the
// chip landed and the page stayed standing, so the standing critic measured
// what was actually shipped and called it a blocker:
//
//   "a 4-item status segmented control + 5 preset buttons + 2 date inputs + 1
//    'Include drafts' checkbox + 3 download buttons = the same fifteen
//    controls, above a table containing one row… 28 visible interactive
//    controls, all 28 above the fold, first and only table row at y=486 of a
//    900px viewport — 54% of the first screen is chrome before any content."
//
// So the page is gone. Every question it asked except one — which file? — is a
// question the ledger already answers with its filter chips, and that one
// question is a dialog over the ledger (views/search.js → ExportDialog),
// reachable from the ledger's header and from its bulk-selection bar. What
// remains here is the route adapter, and it is deliberately a RE-EXPORT rather
// than a wrapper component:
//
//   app.js renders <ExportView/> for #/entries/export[/…] and <SearchView/>
//   for #/entries. If those were two different component types, React would
//   unmount the ledger and mount a fresh one every time Export opened —
//   throwing away the very filter chips the dialog reads its scope from, and
//   the selection a bulk export is scoped to. Being the SAME function makes
//   the two routes one mounted screen; SearchView reads which of them it is on
//   from the hash (exportRouteOf), which app.js has already canonicalised.
//
// The deep-link contract is unchanged. #/export, #/export/<filter> and
// #/export/<filter>/<from> all still work, still carry their arguments, and now
// land on the ledger showing exactly those entries:
//
//   #/export                     → the ledger, with the Export dialog open
//   #/export/unfinalized         → the ledger, chip: Draft
//   #/export/unexported          → the ledger, chips: Finalized · Not exported yet
//   #/export/either              → the ledger, chip: Not exported yet
//   #/export/<filter>/<from>     → …plus From <date> · To today
//
// A filtered deep link does NOT open the dialog. Those links come from the
// dashboard's stalled-time callout, whose own button says *Review*: opening a
// download dialog over a list someone came to read would answer a question
// they did not ask. Export… is one control away in the ledger's header.
export { SearchView as ExportView, ExportDialog } from '/js/views/search.js';

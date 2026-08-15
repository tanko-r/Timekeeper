// THE DAY FOOTER IS GONE. This module renders nothing and exists only so the
// one call site that still mounts it (views/dashboard.js) keeps working.
//
// It was a fixed bar along the bottom of the Today screen carrying two things:
// the day's filed total, and "Close the day". The wave-1 review measured what
// that cost once the persistent run bar arrived above it:
//
//   desktop Today, timer running: .runbar 48px at the top + .today-footer 49px
//   at the bottom = 97px of permanent chrome, against 49px before the overhaul
//   began — and BOTH bars said "5.5h filed", which the day's own stat strip
//   700px above them said too, in more detail. Three statements of one number,
//   two of them nailed to the viewport.
//
// So both of its contents moved into the run bar (components/runbar.js), which
// was already pinned and already on every screen:
//
//   the FILED TOTAL — on every screen EXCEPT Today, because on Today the stat
//     strip already carries it with the billable split, the target and the week
//     beside it. Repeating it in a bar 20px higher was the defect, not the
//     placement.
//   CLOSE THE DAY — on Today only, at every width, which is where `c` fires.
//     It is also no longer a permanent slot in the phone's bottom bar, where it
//     closed a day other than the one on screen when pressed from Calendar.
//
// Nothing was lost: both are reachable by touch and by keyboard on both
// viewports, and the day's number is now stated exactly once per screen.
//
// Why a null component rather than a deleted file: dashboard.js is owned by
// another builder in this wave and mounts <TodayFooter today onCloseDay />. The
// props are still accepted and ignored. When that view drops the call, delete
// this file and its <link>-free CSS in views.css (.today-footer, .tf-*).
export function TodayFooter() {
  return null;
}

import { html } from '/js/ui.js';
import { CalendarView } from '/js/views/calendar.js';

// `#/calendar/stats` (and the retired `#/stats`) — Statistics is a SECTION of
// the Calendar, not a screen of its own (teardown §13).
//
// It asked "how am I doing over time" about exactly the period the calendar
// beside it already draws, and answered with four tiles, two good bar lists
// and one bar chart whose values existed only in a `title` attribute. So:
//
//   the four tiles          → the period strip, which the Calendar section
//                             shows too, so the month total and the billable
//                             ratio are now on the screen where the days live
//   the two bar lists       → unchanged, in this section
//   the "By day" chart      → a labelled, valued bar list (its numbers are
//                             readable on a phone for the first time), with
//                             the calendar grid as its richer twin
//   This week / This month  → the period control in the header: one arrow
//   / Last month presets      back is last month, the Month/Week switch is the
//                             other two. "Custom range…" survives intact,
//                             because nothing else spans an arbitrary range.
export function StatsView(ctx) {
  return html`<${CalendarView} section="stats" ...${ctx} />`;
}

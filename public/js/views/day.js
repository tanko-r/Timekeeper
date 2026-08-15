import { html } from '/js/ui.js';
import { CalendarView } from '/js/views/calendar.js';

// `#/day/<YYYY-MM-DD>` — a DEEP LINK, not a destination (teardown §8).
//
// This file used to be 166 lines that were, byte for byte, the dashboard's
// entry list plus a Day/Week/Month/Range control that views/calendar.js had
// already reimplemented, under a header carrying the same four actions the
// dashboard carried in a different order. The navigation had conceded the
// point years before the code did: app.js has always highlighted **Calendar**
// while you stood on this route.
//
// So the route survives — every bookmark, the dashboard's own day arrows, and
// the `[` / `]` keys still land here — and it opens the Calendar with that day
// drawn and selected. One entry renderer, one range picker, one day header.
export function DayView({ date, ...ctx }) {
  return html`<${CalendarView} focusDay=${date} section="calendar" ...${ctx} />`;
}

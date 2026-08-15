import { html, useEffect, useRef, useState, fmtHours, Icon } from '/js/ui.js';

// The day's commit bar: one ambient number, one key that ends the day.
//
// WAVE-1 (teardown §4 / §7 / E4). Three things left this component:
//
//   the METER — it duplicated the Today card's meter word for word and in a
//     different framing ("64%" against "2.9h to go"). The day's numbers are
//     stated once now, in the stat strip under the day header.
//   the LIVE CLOCK — the run bar (components/runbar.js) owns it, on every
//     screen instead of only this one. Two clocks ten inches apart counting the
//     same seconds is the same duplication in a new place, so this one stands
//     down entirely rather than being hidden by a CSS rule.
//   SUMMARY — a once-in-a-while, export-adjacent action that was sitting in
//     the app's most valuable pixel real-estate. It is in the day menu (⋯) at
//     the top of the screen, and `s` still opens it.
//
// What is left is what a lawyer glances at without looking away from his work:
// how much is filed, and the one key that closes the day.
//
// WAVE-1b: AND ON A PHONE IT IS NOT RENDERED AT ALL. Measured at 390×844, the
// phone was carrying three fixed bars — run bar 0→52, this one 722→783, the
// navigation bar 784→844: 173px, 20.5% of the screen, which is why exactly
// 34px of the first row of the day's work was visible, cut mid-word. The
// teardown's instruction (§1, E4) was to MERGE this into the bottom-navigation
// region rather than stack a second bar above it, so below 768px shell.css
// hides it and the bottom bar carries both halves: the filed total as its
// leading label, "Close the day" as its trailing action — on every screen now,
// rather than only this one. Above 768px this bar is unchanged and is where
// the day's number lives on the Today screen (the run bar carries it
// everywhere else; see the ownership note at the end of runbar.css).
export function TodayFooter({ today, onCloseDay }) {
  // subtle pulse when the filed total changes
  const prev = useRef(today.total);
  const [bump, setBump] = useState(false);
  useEffect(() => {
    if (today.total !== prev.current) {
      prev.current = today.total;
      setBump(true);
      const t = setTimeout(() => setBump(false), 400);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [today.total]);

  return html`
    <div class="today-footer">
      <span class=${'tf-total mono' + (bump ? ' bump' : '')} title="Filed today (all entries)">
        ${fmtHours(today.total)}h</span>
      <span class="muted small tf-total-cap">filed</span>
      <span class="spacer" style=${{ flex: 1 }}></span>
      <button class="btn btn-sm tf-close" onClick=${onCloseDay} title="Review, finalize, and export today (c)">
        <${Icon} name="lock" size=${14} /> <span class="tf-btn-label">Close the day</span> <kbd>c</kbd>
      </button>
    </div>`;
}

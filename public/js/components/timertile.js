import {
  html, useRef, fmtClock, fmtTenths, Icon,
} from '/js/ui.js';
import { menuTriggerProps } from '/js/components/menu.js';

// ---------------------------------------------------------------------------
// ONE TIMER, AS A BUTTON  (owner instruction 2026-08-16 — the board comes back)
//
// The overhaul made every timer a full-width row carrying its matter, its
// state, its clock, its hours, its NARRATIVE and five controls. Measured on the
// owner's real density — eighty-four timers — that produced a Today page 4,438
// pixels tall with 445 visible controls, twelve rows above the fold, and no
// separate record of the day at all. His words:
//
//   "The original base app has approximately the structure I want. A list of
//    buttons that persist day-to-day. I don't recreate them. They are very
//    compact, sortable, editable, etc."
//
// So this is a BUTTON, not a row. It carries only what he needs to decide which
// one to press: which matter, whether it is running, how long, and how much is
// already on the books. The narrative and the day's record moved to the entries
// list underneath the board, where a sentence has room to be read — which is
// also how the app looked before the merge.
//
// TWO CONTROLS, NOT FIVE. One transport (start or stop) and one overflow. The
// overflow is PERSISTENT: the baseline reserved 26px on every tile for a
// control that only appeared on hover, which on a phone is dead space, and on a
// board of eighty-four tiles that is 2,184 pixels reserved for nothing.
//
// WHY THE RUNNING TILE IS NOT JUST A COLOUR. He may be colour-blind, the room
// may be bright, and the accent is rationed elsewhere. The running tile is the
// only one that shows a TICKING CLOCK, it carries a heavier left rail, and it
// says "Stop" in words. Three channels, of which two survive greyscale.
//
// WHY THE NAME IS `flex: 1 1 0` AND NOT `1 1 auto`. Names here run to
// forty-four characters and a dozen share a client prefix ("Acme — …" eight
// times). With `auto` the basis is the content, so a long name pushes the clock
// and the transport out of the tile instead of truncating. This is the normal
// case at his scale, not an edge case.
// ---------------------------------------------------------------------------

export function TimerTile({
  timer, secs = 0, filed = 0, roundMode, digit = null, front = false,
  tabbable = false, selectMode = false, selected = false, menuOpen = false,
  needsNarrative = false, canDrag = true, dragging = false,
  onFocusRow, onSelect, onToggleSelected, onStart, onStop, onMenu,
  onDragStart, onDragEnd, onDragOverRow, onDropOn,
}) {
  const ref = useRef(null);
  const running = !!timer.running;
  // WHEN A STOPPED TILE SHOWS ITS CLOCK. Only when the clock holds time that is
  // NOT YET FILED — a timer he stopped mid-task, or one whose stop never
  // landed. That is the one case where the clock says something the hours
  // figure beside it does not, and it is the case standing rule 1 cares about:
  // time that exists but is not on the books.
  //
  // Showing it on every paused tile cost the NAMES their width — eighty-four
  // matters, forty-four characters, eight of them starting "Acme —" — and a
  // clock that merely repeats the filed figure is not worth a truncated name.
  const unfiled = secs / 3600 - filed;
  const clock = (running || unfiled > 0.05) ? fmtClock(secs) : null;
  // What the tile prints as hours is TODAY'S RECORD and only the record — never
  // the record plus the unfiled clock. Adding them is how the board came to
  // report 2.7 while the ledger held 2.6, with the figure 2.7 appearing nowhere
  // in the data (wave-1 review, D8). The unfiled time IS the clock, and it is
  // shown right beside this figure while it runs.
  const hours = fmtTenths(filed * 3600, roundMode);
  const archived = !!timer.archived_at;

  const cls = ['timer-tile', 'timer-row'];
  if (front) cls.push('is-front');
  if (running) cls.push('is-running');
  if (selected) cls.push('is-selected');
  if (dragging) cls.push('is-dragging');
  if (archived) cls.push('is-archived');
  if (needsNarrative) cls.push('needs-narrative');

  return html`
    <div ref=${ref} class=${cls.join(' ')}
      data-timer-id=${timer.id} data-row-key=${`t${timer.id}`}
      role="listitem"
      tabIndex=${tabbable ? 0 : -1}
      aria-label=${`${timer.name}${running ? ', running' : ''}`}
      onFocus=${onFocusRow}
      onClick=${selectMode ? onSelect : undefined}
      draggable=${canDrag && !selectMode}
      onDragStart=${canDrag ? onDragStart : undefined}
      onDragEnd=${canDrag ? onDragEnd : undefined}
      onDragOver=${canDrag ? (e) => { e.preventDefault(); onDragOverRow && onDragOverRow(); } : undefined}
      onDrop=${canDrag ? (e) => { e.preventDefault(); onDropOn && onDropOn(); } : undefined}>

      ${/* THE RAIL. A block of colour is a second channel, but it is also the
            thing a thumb finds first on a phone, so it is part of the tile
            rather than a border on it. */''}
      <span class="timer-rail" aria-hidden="true"></span>

      ${selectMode ? html`
        <input type="checkbox" class="timer-check" checked=${selected}
          aria-label=${`Select ${timer.name}`}
          onChange=${onToggleSelected} onClick=${(e) => e.stopPropagation()} />` : null}

      ${/* THE DIGIT CAP. Printed, not hidden in a help overlay: a shortcut
            nobody can see is a shortcut nobody uses. It names the key that
            starts THIS timer from anywhere on the page, and it is stable —
            the front row never moves, and the Recent band is append-only for
            the length of a day. */''}
      ${digit != null ? html`
        <span class="timer-digit" aria-hidden="true">${digit}</span>` : null}

      ${/* THE IDENTITY BLOCK. On the front row the number sits UNDER the name
            rather than beside it, and this is the whole reason the front tile
            is 56px instead of 34px. Beside it, the number took about 110px of a
            345px tile and the name — the thing he actually scans by — truncated
            to "Acme …", so the tallest, most prominent tiles on the board were
            the least readable ones. Stacking spends the extra height on what
            the height was for. Ordinary tiles have no room for a second line
            and do not print the number at all. */''}
      ${front ? html`
        <span class="timer-ident">
          <span class="timer-name" title=${timer.name}>${timer.name || 'Quick timer'}</span>
          ${timer.cm_number ? html`<span class="timer-meta">${timer.cm_number}</span>` : null}
        </span>` : html`
        <span class="timer-name" title=${timer.name}>${timer.name || 'Quick timer'}</span>`}

      ${needsNarrative ? html`
        <span class="timer-flag" title="This matter has time today with no narrative yet">
          <${Icon} name="alert" size=${12} />
        </span>` : null}

      ${clock ? html`<span class="timer-clock">${clock}</span>` : null}
      <span class=${'timer-hours' + (Number(hours) > 0 ? '' : ' is-zero')}>${hours}</span>

      ${running ? html`
        <button type="button" class="timer-transport is-stop timer-stop-btn" tabIndex=${-1}
          title="Stop & file time" aria-label=${`Stop ${timer.name}`}
          onClick=${(e) => { e.stopPropagation(); onStop(); }}>
          <${Icon} name="stop" size=${14} /><span class="tt-label">Stop</span>
        </button>` : html`
        <button type="button" class="timer-transport is-start" tabIndex=${-1}
          title="Start" aria-label=${`Start ${timer.name}`}
          onClick=${(e) => { e.stopPropagation(); onStart(); }}>
          <${Icon} name="play" size=${14} /><span class="tt-label">Start</span>
        </button>`}

      <button type="button" class="timer-more" tabIndex=${-1}
        title="Row menu" aria-label=${`Row menu — ${timer.name}`}
        ...${menuTriggerProps(menuOpen)}
        onClick=${(e) => { e.stopPropagation(); onMenu({ anchor: e.currentTarget }); }}>
        <${Icon} name="more" size=${14} />
      </button>
    </div>`;
}

import { html, Icon } from '/js/ui.js';
import { menuTriggerProps } from '/js/components/menu.js';

// ---------------------------------------------------------------------------
// THE TIMER BOARD — nine tiles of eighty-four.
//
// The owner has 83 timers. Measured on the merged list this replaces, his Today
// page was 4,438px tall with 445 visible controls and twelve of eighty-five
// rows above the fold. His instruction, 2026-08-16:
//
//   "we can definitely find ways to make the timers more compact. I use dozens.
//    so hiding or sorting would be good. don't need to see all at once."
//
// HIDING IS THEREFORE SANCTIONED, and that permission is the whole design. The
// board opens on a bounded working set and puts the other seventy-five one
// labelled click away:
//
//   BAND A — THE FRONT ROW. Exactly three, taller than the rest, always first.
//     Membership is HIS, it never changes by itself, and it spends the two
//     channels a wall of identical tiles leaves unspent: SIZE and POSITION. At
//     2:40 on a Tuesday the partner's matter is one of three tiles that have
//     been in the same place since he put them there.
//   BAND B — RECENT. Up to six: the running clock, today's work, then a
//     fourteen-day backfill. Append-only for the length of a day, so a timer
//     that enters at position 7 at 11am is still at position 7 at 4pm and the
//     digit keys mean one thing all day.
//   BAND C — ALL TIMERS. Not rendered until he asks.
//
// THE ONE PROPERTY THAT MAKES IT WORK: `Show all` APPENDS. It never re-sorts,
// never re-flows, never moves a tile already on screen. Positions 1-9 survive
// the disclosure, which is what makes printing digit caps on the tiles honest.
//
// A BOARD OF NINE OR FEWER DOES NOT BAND. Three groups over nine timers is
// ceremony; it renders one flat list. Every number above is taken against
// scripts/lib/demoseed.mjs, which seeds eighty-four.
//
// THIS COMPONENT HOLDS NO STATE. Every band, every callback and the tile
// rendering itself arrive as props. The last two attempts at this split broke
// on shared refs and state with no owner, so the coordinator (timergrid.js)
// keeps all of it and this file is layout.
// ---------------------------------------------------------------------------

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function TimerBoard({
  bands, total, running, unfiledHint, scope, query, matches, matterMatches = [],
  density = 'compact', grouping = 'flat', searchInputRef,
  renderTile, onQuery, onSearchKeyDown, onClearQuery, onToggleScope,
  onNewTimer, onMenu, menuOpen = false, onGrouping, onCreateAndStart, onBoardKey,
}) {
  const filtering = query != null && String(query).trim() !== '';
  const { mode, front, recent, rest, prefix } = bands;

  // The digit cap a tile carries. It names the key that starts THIS timer from
  // anywhere on the page, so it must be derived from the SAME array in every
  // scope — the prefix — or pressing 7 would mean two different things before
  // and after `Show all`.
  const digitOf = (timer) => {
    const i = prefix.findIndex((t) => t.id === timer.id);
    return i > -1 && i < 9 ? i + 1 : null;
  };

  const tiles = (list, isFront) => list.map((t) => renderTile(t, digitOf(t), isFront));

  // THE FRONT ROW IS ITS OWN GRID, not a `.timer-grid` inside one. `.band-front`
  // carries `repeat(3, 1fr)` directly (public/css/timers.css) so the three tiles
  // hold their thirds at every width and their positions never depend on how
  // many there are — that fixed geometry IS the muscle memory. Wrapping them in
  // an auto-fill `.timer-grid` put all three in a single 280px track, stacked,
  // with their names truncated to "Acme …".
  const band = (key, label, list, isFront = false) => (list.length === 0 ? null : html`
    <div key=${key} class=${`band band-${key}`} role=${isFront ? 'list' : undefined}>
      ${label ? html`<div class="band-label">${label}</div>` : null}
      ${isFront ? tiles(list, true) : html`
        <div class=${`timer-grid density-${density}`} role="list">
          ${tiles(list, false)}
        </div>`}
    </div>`);

  // ── the filter's answer, always printed ──────────────────────────────────
  // `Enter` used to move focus when several tiles matched and do nothing
  // visible at all. He types this while saying "sure, let me pull that up" and
  // has already looked away, so a silent failure costs him the hour he thinks
  // he is billing. The field says what Enter will do, every keystroke, so he
  // can confirm by peripheral glance and never by reading tiles.
  const resolution = (() => {
    if (!filtering) return null;
    if (matches && matches.length === 1) {
      return html`<span class="board-resolve is-go">⏎ starts: ${matches[0].name}</span>`;
    }
    if (matches && matches.length > 1) {
      return html`<span class="board-resolve">${plural(matches.length, 'timer matches', 'timers match')} — keep typing</span>`;
    }
    if (matterMatches.length === 1) {
      const m = matterMatches[0];
      return html`<span class="board-resolve is-go">⏎ starts a new timer: ${m.short_name}</span>`;
    }
    return html`<span class="board-resolve is-none">no timer matches</span>`;
  })();

  return html`
    <section class=${`panel timer-board density-${density}`} onKeyDown=${onBoardKey}>
      <div class="board-head">
        <h2>Timers</h2>
        <span class="board-meta muted small">
          ${plural(total, 'timer', 'timers')}${running ? ` · 1 running` : ''}${unfiledHint || ''}
        </span>
        <span class="spacer" style=${{ flex: 1 }}></span>

        <div class="board-controls">
          ${/* Grouping stays on the face because the owner named it, but it
                applies to BAND C only — grouping the working set would undo
                the stable positions the front row exists to give him. A-Z is
                NOT here: its only job is to destroy the manual arrangement the
                board exists to preserve, so it lives in the ⋯ as the
                once-a-year setup action it is. */''}
          <div class="seg" role="group" aria-label="Group the rest of the timers">
            ${[['flat', 'Flat'], ['group', 'By group'], ['client', 'By client']].map(([k, label]) => html`
              <button key=${k} type="button" class=${grouping === k ? 'on' : ''}
                aria-pressed=${grouping === k ? 'true' : 'false'}
                onClick=${() => onGrouping(k)}>${label}</button>`)}
          </div>

          <div class="timer-search-field">
            <${Icon} name="search" size=${14} />
            <input ref=${searchInputRef} type="search" class="timer-search"
              placeholder=${`Filter ${total} timers…`}
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck=${false}
              aria-label="Filter timers by name, matter, number or client"
              value=${query || ''}
              onInput=${(e) => onQuery(e.target.value)}
              onKeyDown=${onSearchKeyDown} />
            ${filtering ? html`
              <button type="button" class="timer-search-clear" aria-label="Clear the filter"
                title="Clear the filter (Esc)" onClick=${onClearQuery}>
                <${Icon} name="x" size=${14} />
              </button>` : null}
          </div>

          <button type="button" class="btn btn-sm board-menu-btn today-menu-btn"
            title="Board options — order, archive, import, batch actions"
            aria-label="Board options" ...${menuTriggerProps(menuOpen)}
            onClick=${(e) => onMenu({ anchor: e.currentTarget })}>
            <${Icon} name="more" size=${16} />
          </button>
        </div>
      </div>

      ${resolution ? html`<div class="board-resolve-row" role="status">${resolution}</div>` : null}

      ${filtering ? html`
        ${/* THE FILTER REACHES ALL EIGHTY-FOUR, whatever the scope. A working
              set that hid a timer from search would be a haystack with a window
              on it. */''}
        <div class="band band-matches">
          <div class="band-label">${plural((matches || []).length, 'match', 'matches')} of ${total}</div>
          ${(matches || []).length ? html`
            <div class=${`timer-grid density-${density}`} role="list">
              ${(matches || []).slice(0, 24).map((t, i) => renderTile(t, i < 9 ? i + 1 : null, false))}
            </div>` : null}

          ${/* THE DEAD END, CLOSED. He has 84 timers and 89 matters, and he
                searches by what he REMEMBERS — the client and the matter, not
                the button name he invented in March. When the query names a
                matter with no timer, the old filter returned nothing and he was
                left typing while a partner listened. One row, one keystroke. */''}
          ${matterMatches.length ? html`
            <div class="board-newmatches">
              ${matterMatches.slice(0, 4).map((m) => html`
                <button key=${m.id} type="button" class="board-newmatch"
                  onClick=${() => onCreateAndStart(m)}>
                  <${Icon} name="play" size=${14} />
                  <span class="bn-lead">Start a new timer</span>
                  <span class="bn-name">${m.short_name}</span>
                  <span class="bn-meta">${m.client_name || ''} ${m.cm_number}</span>
                </button>`)}
            </div>` : null}
        </div>` : html`
        ${mode === 'flat'
    ? band('rest', null, rest)
    : html`
          ${band('front', null, front, true)}
          ${band('recent', 'Recent', recent)}
          ${scope === 'all' ? band('rest', 'All timers', rest) : null}
        `}`}

      <div class="board-foot">
        <button type="button" class="btn btn-sm" onClick=${onNewTimer}>
          <${Icon} name="plus" size=${14} /> New timer
        </button>
        <span class="spacer" style=${{ flex: 1 }}></span>
        ${/* A LABELLED CONTROL, never a chevron and never a "… 4 more" inside
              the grid. He is told exactly how many are behind it and exactly
              what pressing it does. */''}
        ${(!filtering && mode === 'banded') ? html`
          <button type="button" class="btn btn-sm board-more"
            aria-expanded=${scope === 'all' ? 'true' : 'false'}
            onClick=${onToggleScope}>
            ${scope === 'all'
    ? `Hide the other ${rest.length} timers`
    : `Show all ${total} timers`}
          </button>` : null}
      </div>
    </section>`;
}

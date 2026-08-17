// Pure selection rules for the timer board (docs/ui/BOARD-BUILD-SCOPE.md,
// docs/ui/TIMERBOARD-SPEC.md §2). No DOM, no fetch, no React — plain
// functions over plain data, so the one part of the board that decides WHAT
// IS ON SCREEN out of eighty-plus timers can be proved correct without a
// browser (same reasoning as lib/timersort.js and lib/activity.js keeping
// their own zero-dep copies).
//
// Vocabulary: "front" is Band A — his 3, pinned. "recent" is Band B —
// today's work plus a 14-day backfill, capped at 6. "rest" is Band C —
// everything else, rendered only under `Show all`. front ++ recent is the
// "prefix": the tiles that carry digit caps 1..9.

const FRONT_CAP = 3;
const RECENT_CAP = 6;
const FLAT_THRESHOLD = 9; // boards this size or smaller render as one group, unbanded
const FOURTEEN_DAYS_MS = 14 * 86400000;

function isArchived(t) {
  return !!t.archived_at;
}

// Manual order — sort_order ascending, id ascending as the tiebreak. This is
// what Band C (and a flat board) renders in, and the fallback tiebreak
// everywhere a "most hours" or "most recent" sort needs to land on something
// deterministic instead of on array-arrival order.
function manualCompare(a, b) {
  return (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id;
}

// COALESCE(last_started_at, last_stopped_at). This matters because the
// server NULLs last_started_at the instant a timer stops
// (server/routes/timers.js) — so on a board where everything is currently
// stopped, which is most of the time, ordering by last_started_at alone
// orders by nothing at all. last_stopped_at is where the real recency lives
// once a timer isn't running.
function recencyMs(t) {
  if (t.last_started_at) {
    const ms = Date.parse(t.last_started_at);
    if (!Number.isNaN(ms)) return ms;
  }
  if (t.last_stopped_at) {
    const ms = Date.parse(t.last_stopped_at);
    if (!Number.isNaN(ms)) return ms;
  }
  return null; // never active — sorts to the back of any recency ordering
}

function byRecencyDesc(a, b) {
  const ra = recencyMs(a);
  const rb = recencyMs(b);
  if (ra == null && rb == null) return manualCompare(a, b);
  if (ra == null) return 1;
  if (rb == null) return -1;
  return rb - ra || manualCompare(a, b);
}

function hoursFiledToday(t, entriesByTimer) {
  if (!entriesByTimer) return 0;
  const v = entriesByTimer instanceof Map ? entriesByTimer.get(t.id) : entriesByTimer[t.id];
  return v || 0;
}

// Same two shapes hoursFiledToday accepts. The two lookups sat asymmetric —
// one took a Map, one silently read `undefined` off it and scored every
// candidate 0, which does not throw: it quietly degrades the front row's
// fill to manual order. One accessor shape, so a caller cannot get that wrong.
function hours14(t, hours14ByTimer) {
  if (!hours14ByTimer) return 0;
  const v = hours14ByTimer instanceof Map ? hours14ByTimer.get(t.id) : hours14ByTimer[t.id];
  return v || 0;
}

// Rule (a)'s "time on its clock today". accumulated_seconds resets to 0 at
// the nightly rollover, and last_reset_date is stamped with the day the
// balance belongs to — so a non-zero accumulated_seconds only means "today"
// when last_reset_date agrees with it; a currently-running timer is
// trivially today regardless, since it is accumulating this instant.
function activeToday(t, opts) {
  const clocked = !!t.running || (t.accumulated_seconds > 0 && t.last_reset_date === opts.today);
  return clocked || hoursFiledToday(t, opts.entriesByTimer) > 0;
}

// Band A. Membership is his (opts.front, in order); short of 3, fill by
// 14-day hours. A pick is never bumped to make room for another pick or for
// a fill candidate — this loop only ever appends.
function computeFront(timers, opts) {
  const byId = new Map(timers.map((t) => [t.id, t]));
  const chosen = [];
  const chosenIds = new Set();
  for (const id of opts.front || []) {
    const t = byId.get(id);
    if (t && !isArchived(t) && !chosenIds.has(id)) {
      chosen.push(t);
      chosenIds.add(id);
    }
  }
  if (chosen.length < FRONT_CAP) {
    const fill = timers
      .filter((t) => !isArchived(t) && !chosenIds.has(t.id))
      .sort((a, b) => hours14(b, opts.hours14) - hours14(a, opts.hours14) || manualCompare(a, b));
    for (const t of fill) {
      if (chosen.length >= FRONT_CAP) break;
      chosen.push(t);
      chosenIds.add(t.id);
    }
  }
  return chosen;
}

// The append-only Recent order. This is the whole reason digits 4-9 are
// worth pressing: without it, Recent recomputes fresh on every render and a
// timer that was "7" at 11am could be "4" by 4pm. `kept` is whatever
// survived from yesterday's — sorry, TODAY's — persisted order; `newcomers`
// is what append after it. The two lists together can run past RECENT_CAP
// (an eleven-matter day appends past position 6) — that overflow is
// deliberate: it keeps the order stable if band membership is ever
// re-rendered, even though only the first six of it ever show a digit.
function computeRecentFull(timers, opts, frontIds) {
  const byId = new Map(timers.map((t) => [t.id, t]));
  const isSameDay = opts.recentDate === opts.today;
  const kept = [];
  const keptIds = new Set();
  if (isSameDay && Array.isArray(opts.recentOrder)) {
    for (const id of opts.recentOrder) {
      const t = byId.get(id);
      // A timer keeps its slot for the rest of the day even if it's gone
      // quiet since — that's the stability digit keys depend on. It only
      // drops out if it stopped existing, got archived, or moved to Band A.
      if (t && !isArchived(t) && !frontIds.has(id)) {
        kept.push(t);
        keptIds.add(id);
      }
    }
  }
  const newcomers = timers
    .filter((t) => !isArchived(t) && !frontIds.has(t.id) && !keptIds.has(t.id) && activeToday(t, opts))
    .sort(byRecencyDesc);
  return [...kept, ...newcomers];
}

// Band B as rendered: the first six of the append-only order, backfilled
// from 14-day recency when today's work hasn't filled the band, then
// guaranteed to hold the running timer no matter where it landed above.
function computeRecentBand(timers, opts, frontIds, recentFull) {
  const band = recentFull.slice(0, RECENT_CAP);
  if (band.length < RECENT_CAP) {
    const bandIds = new Set(band.map((t) => t.id));
    const cutoff = opts.now.getTime() - FOURTEEN_DAYS_MS;
    const backfill = timers
      .filter((t) => !isArchived(t) && !frontIds.has(t.id) && !bandIds.has(t.id))
      .map((t) => ({ t, r: recencyMs(t) }))
      .filter((x) => x.r != null && x.r >= cutoff)
      .sort((a, b) => b.r - a.r || manualCompare(a.t, b.t))
      .map((x) => x.t);
    for (const t of backfill) {
      if (band.length >= RECENT_CAP) break;
      band.push(t);
    }
  }
  // THE BOARD ALWAYS OFFERS NINE. Monday after two weeks away, nothing was
  // worked today and nothing is inside fourteen days, so both rules above come
  // back empty and the board renders THREE tiles — with digits 4-9 dead — on
  // the morning of the worst attention of the year. Falling back to manual
  // order is not a recency claim and does not pretend to be one; it is the
  // difference between a board he can press and a board he has to expand
  // before he can do anything. `bandIsRecent` below tells the caller whether
  // to label it, so an unlabelled row of nine never says "Recent" about
  // timers that are not.
  if (band.length < RECENT_CAP) {
    const have = new Set([...band.map((t) => t.id), ...frontIds]);
    for (const t of [...timers].filter((t) => !isArchived(t) && !have.has(t.id)).sort(manualCompare)) {
      if (band.length >= RECENT_CAP) break;
      band.push(t);
    }
  }
  // The running timer must always carry a digit — a live clock can never go
  // unreachable. Because running implies activeToday, it is already
  // somewhere in recentFull unless it's in the front row; but on a busy day
  // it can sit past position 6 (it may have started early and kept running
  // while later matters pushed the append order past it), where it would
  // render nowhere. Force it into the last Recent slot rather than lose it.
  // (The app runs timers exclusively — server/routes/timers.js stops
  // whatever was running before starting the next — so there is never more
  // than one of these to place.)
  const runner = timers.find((t) => t.running && !isArchived(t));
  if (runner && !frontIds.has(runner.id) && !band.some((t) => t.id === runner.id)) {
    if (band.length >= RECENT_CAP) band[RECENT_CAP - 1] = runner;
    else band.push(runner);
  }
  return band;
}

export function selectBands(timers, opts) {
  const live = (timers || []).filter((t) => !isArchived(t));

  // Small boards do not band. Banding nine timers into three groups is
  // ceremony — one group, manual order, first nine carry the digit caps.
  if (live.length <= FLAT_THRESHOLD) {
    const rest = [...live].sort(manualCompare);
    return { mode: 'flat', front: [], recent: [], rest, prefix: rest.slice(0, FLAT_THRESHOLD) };
  }

  const front = computeFront(live, opts);
  const frontIds = new Set(front.map((t) => t.id));
  const recentFull = computeRecentFull(live, opts, frontIds);
  const recent = computeRecentBand(live, opts, frontIds, recentFull);
  const recentIds = new Set(recent.map((t) => t.id));

  // front and recent are computed identically regardless of scope — showing
  // all only appends Band C beneath them, it never re-sorts, so the first
  // nine tiles never move and his muscle memory survives `Show all`.
  const rest = opts.scope === 'all'
    ? live.filter((t) => !frontIds.has(t.id) && !recentIds.has(t.id)).sort(manualCompare)
    : [];

  // Does the Recent band actually hold anything RECENT? When it is padded
  // out of manual order (a cold Monday), calling it "Recent" would be a
  // false claim about the only thing the band asserts.
  const bandIsRecent = recent.some((t) => t.running || activeToday(t, opts)
    || (recencyMs(t) != null && recencyMs(t) >= opts.now.getTime() - FOURTEEN_DAYS_MS));
  return { mode: 'banded', front, recent, rest, bandIsRecent, prefix: [...front, ...recent] };
}

// The array to persist as settings.board.recent.ids for tomorrow's
// opts.recentOrder. Flat boards have no Recent band, so there's nothing to
// persist a position for.
export function nextRecentOrder(timers, opts) {
  const live = (timers || []).filter((t) => !isArchived(t));
  if (live.length <= FLAT_THRESHOLD) return [];
  const front = computeFront(live, opts);
  const frontIds = new Set(front.map((t) => t.id));
  return computeRecentFull(live, opts, frontIds).map((t) => t.id);
}

// Diacritic- and case-folding, matching the `verite` finds `Verité` behaviour
// already shipped in timergrid.js's grid filter (kept as a plain substring
// match here rather than that filter's token/squash logic, since the board
// filter's contract is simpler: one substring, three fields).
function fold(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function matchTimers(timers, query) {
  const q = fold(query).trim();
  if (!q) return null; // "not filtering" — the filter UI must tell these apart, so never []
  return (timers || []).filter((t) => {
    // THE CLIENT NAME IS IN HERE ON PURPOSE. He remembers "the Northgate
    // thing", not the button name he invented in March, and a dozen of his
    // matters share a client prefix. Leaving the client out means typing
    // "northgate" finds only the timers he happened to NAME that way.
    const hay = `${fold(t.name)} ${fold(t.cm_short_name)} ${fold(t.cm_number)} ${fold(t.client_name)}`;
    return hay.includes(q);
  });
}

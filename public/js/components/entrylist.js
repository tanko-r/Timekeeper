import { api } from '/js/api.js';
import {
  html, useState, useEffect, fmtHours, fmtClock, emitToast, BillableBadge, StatusChip,
  ValidationList, fmtStamp, Icon, markJustFinalized, fmtDateFull, todayStr, Confirm,
} from '/js/ui.js';
import { Menu, rowMenuItems, rowMenuTitle, menuTriggerProps } from '/js/components/menu.js';
import { startAlignedTick, liveTimerSeconds } from '/js/lib/tick.js';
import { parseNarrativeEdit } from '/js/lib/narrativesync.js';
import { GhostInput, useMatterSuggestions } from '/js/components/ghosttext.js';
import { useShortcuts } from '/js/components/shortcuts.js';
import { expandShortcuts } from '/js/lib/expand.js';

// THE OVERFLOW MENU MOVED OUT OF THIS FILE.
//
// `ActionMenu` used to live here and was one of the app's THREE menu
// components (the wave-1 review, D6). There is one now, in
// public/js/components/menu.js, and every call site — this list, the Today
// list, the day header, the attention line, the ledger, Clients & matters and
// the calendar day panel — goes through it. The row menu those two lists carry
// is one state-driven menu built by `rowMenuItems` there.
//
// `usePhone` stays: it is the app's 767px LAYOUT question ("is this the phone
// layout?"), which several callers still need and which is a different
// question from the menu's own 1024px shape question (`useMenuPopover`).
const PHONE_MQ = '(max-width: 767px)';

export function usePhone() {
  const [phone, setPhone] = useState(() => (
    typeof window.matchMedia === 'function' ? window.matchMedia(PHONE_MQ).matches : false));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(PHONE_MQ);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

// ===========================================================================
// DENSITY — the whole-list half of the owner's expansion constraint.
//
// "Compact is the right default, and denser than today is better — provided it
// expands… a compact-versus-comfortable density control for the whole list
// that persists across sessions" (BRIEF, owner constraint 5).
//
// It is ONE setting for both lists that render a `.work-row` — Today and the
// day/calendar entry list — because "same day, same data, two answers" is the
// defect this row was rebuilt to close. It is written by the Today list's ⋯
// menu, persisted per browser, and read here so a reload keeps the choice.
//
//   compact       line 1 identity, line 2 controls. The narrative, the task
//                 split and the findings are one tap away, on the row.
//   comfortable   the same two lines with the narrative at rest.
//
// Expansion is a third step on top of either: see `.work-extra`.
// ===========================================================================
export const DENSITY_KEY = 'tk:listDensity';
const DENSITIES = ['compact', 'comfortable'];

export function readDensity() {
  try {
    const v = localStorage.getItem(DENSITY_KEY);
    return DENSITIES.includes(v) ? v : 'compact';
  } catch { return 'compact'; }
}

export function writeDensity(v) {
  const next = DENSITIES.includes(v) ? v : 'compact';
  try { localStorage.setItem(DENSITY_KEY, next); } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent('tk:density-changed', { detail: { density: next } }));
}

// Every list that draws a row subscribes, so flipping the switch on Today also
// flips the calendar's day panel without a reload.
export function useDensity() {
  const [density, setDensity] = useState(readDensity);
  useEffect(() => {
    const on = () => setDensity(readDensity());
    window.addEventListener('tk:density-changed', on);
    window.addEventListener('storage', on);
    return () => {
      window.removeEventListener('tk:density-changed', on);
      window.removeEventListener('storage', on);
    };
  }, []);
  return density;
}

// Inline narrative editing (2026-07-10 feedback): click a draft entry's
// narrative to edit it in place — no editor round-trip. Same edit-through
// contract as the editor's AUTO box: on a ≥2-line auto entry, text that still
// parses folds back into the task lines (fragments + allocations, staying
// AUTO); a structural break detaches to a durable manual narrative
// (narrative_manual=1). Single/no-line entries just save the text.
//
// WAVE-1: THE AFFORDANCE IS NOW VISIBLE. The teardown's §6 finding was that
// "the best thing in this component is invisible" — the whole edit affordance
// was `cursor: text` plus a `:hover` tint, both pointer-only, so on the phone
// the app's fastest path had no discoverable affordance at all. It is a real
// <button> now: a persistent dotted underline and a trailing pencil when there
// is text, and an explicit "Write narrative" control when there is not.
export function InlineNarrative({ entry, onChanged, autoEdit = false, onDone }) {
  const [editing, setEditing] = useState(!!autoEdit);
  const [text, setText] = useState(autoEdit ? (entry.narrative || '') : '');
  // Same deterministic assists as the main editor (2026-07-14 feedback —
  // text expansion "not working in card view"): shortcut expansion plus the
  // matter's ghost completions. Suggestions fetch only while editing.
  const shortcuts = useShortcuts();
  const phrases = useMatterSuggestions(editing ? entry.cm?.id : null);
  const expand = (t, caret) => expandShortcuts(t, caret, shortcuts);
  // Opened from outside (the attention line's "N need a narrative", or the row
  // menu): the editor has to open on an ALREADY-MOUNTED row, so this can't be
  // lazy initial state.
  useEffect(() => {
    if (!autoEdit) return;
    setText(entry.narrative || '');
    setEditing(true);
  }, [autoEdit]); // eslint-disable-line

  if (entry.status !== 'draft') {
    return entry.narrative
      ? html`<p class="narrative">${entry.narrative}</p>`
      : html`<p class="narrative"><em class="muted">No narrative</em></p>`;
  }

  const finish = () => { setEditing(false); if (onDone) onDone(); };

  async function save() {
    finish();
    const t = text.trim();
    if (t === entry.narrative.trim()) return;
    const substantive = entry.tasks.filter(
      (x) => (x.fragment || '').trim() || (x.task_code || '').trim() || Number(x.duration) > 0);
    const body = { narrative: t };
    if (entry.narrative_auto && substantive.length >= 2) {
      const taskBilling = entry.cm?.client_task_billing !== 0;
      const parsed = parseNarrativeEdit(t, substantive.length, { taskBilling });
      if (parsed) {
        body.tasks = substantive.map((x, k) => ({
          task_code: x.task_code,
          duration: parsed.segments[k].duration ?? (Number(x.duration) || 0),
          fragment: parsed.segments[k].fragment,
        }));
        body.narrative_manual = 0;
      } else {
        body.narrative_manual = 1;
      }
    }
    try {
      await api.patch(`/api/entries/${entry.id}`, body);
      onChanged();
    } catch (e) {
      emitToast(e.message, { error: true });
    }
  }

  if (!editing) {
    const open = () => { setText(entry.narrative); setEditing(true); };
    if (!entry.narrative || !entry.narrative.trim()) {
      return html`
        <button type="button" class="narrative-write" onClick=${open}
          title="Write this entry's billing narrative here — no dialog">
          <${Icon} name="edit" size=${14} /> Write narrative
        </button>`;
    }
    return html`
      <button type="button" class="narrative narrative-editable" onClick=${open}
        title="Edit the narrative in place">
        <span class="narrative-text">${entry.narrative}</span>
        <${Icon} name="edit" size=${13} className="narrative-pencil" />
      </button>`;
  }
  return html`
    <${GhostInput} multiline class="narrative-inline-input" autoFocus
      rows=${Math.max(2, Math.ceil(text.length / 90))}
      value=${text} suggestions=${phrases} expand=${expand}
      onChange=${setText}
      onFocus=${(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
      onBlur=${save}
      onKeyDown=${(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); finish(); }
      }} />`;
}

// A designed empty state, not a grey box. Primer Blankslate's anatomy:
// visual → heading → description → one strong verb-led primary action.
export function EmptyState({ icon = 'clock', heading, description, actionLabel, onAction, secondaryLabel, onSecondary }) {
  return html`
    <div class="blankslate">
      <span class="blankslate-visual" aria-hidden="true"><${Icon} name=${icon} size=${26} /></span>
      <h3 class="blankslate-heading">${heading}</h3>
      ${description ? html`<p class="blankslate-desc">${description}</p>` : null}
      ${/* TONAL, not filled: tokens.css §7a allows at most one filled accent
            surface on a screen at a time, and on an empty day that one belongs
            to the page header's Quick start. Inside an otherwise empty panel a
            raised tonal button is unmistakably the action anyway. */''}
      ${actionLabel ? html`
        <div class="blankslate-actions">
          <button class="btn btn-tonal" onClick=${onAction}>${actionLabel}</button>
          ${secondaryLabel ? html`<button class="btn" onClick=${onSecondary}>${secondaryLabel}</button>` : null}
        </div>` : null}
    </div>`;
}

// ===========================================================================
// ONE ROW COMPONENT, TWO SCREENS.
//
// The wave critic put the Today screen and the Calendar day panel side by side
// and found the same records rendered two ways: "Acme — merger" against
// "Acme — Borealis merger", hours top-right beside a leading Start/Stop
// against hours bottom-right with no transport control at all — and, one route
// away from a Today list that folds them into one row, the running timer's
// linked zero-hour entry standing on its own as a second draft row with
// "⚠ Entry total is zero" hung off it. Same day, same data, two answers.
//
// So this list is the same row as the Today list now:
//
//   LABEL     the timer's name where a timer exists, the matter's display name
//             otherwise — one source, both screens.
//   SHAPE     [transport] [name · number · chips] [hours] [⋯] with the
//             narrative on its own line beneath, at every width.
//   MERGE     on TODAY, entries are keyed by the timer that owns them, exactly
//             as the Today list keys them, so a running timer's placeholder
//             entry is a line inside its matter's row rather than a zero-hour
//             row of its own. Past days are one card per entry: there is no
//             timer to key them by and nothing to merge.
//   VARIANT   the start/stop control is the ONLY difference between the two
//             screens — present on today, absent on a day that is over.
//
// `timers` may be passed in (the caller already has them); when it is not and
// the list contains today's work, this fetches them once and re-reads on
// `tk:timers-changed`, because a day panel that cannot see the running timer
// cannot avoid the defect above.
// ===========================================================================
export function EntryList({
  entries, openEditor, onChanged, settings, showDate = false,
  runningIds = null, timers = null, fetchedAt = null, emptyAction = null,
}) {
  const increment = (settings?.rounding?.increment) || 0.1;
  const [deleting, setDeleting] = useState(null);
  const [menu, setMenu] = useState(null); // { anchor, card }
  // "Write narrative here" — the row menu's item on both lists now, so the
  // fastest path to the narrative is reachable by thumb on this screen too and
  // not only on Today.
  const [writingId, setWritingId] = useState(null);
  const density = useDensity();
  // Per-row expansion, keyed by the card's own stable key.
  const [expanded, setExpanded] = useState(() => new Set());
  const toggleExpand = (key) => setExpanded((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const TODAY = todayStr();
  const hasToday = (entries || []).some((e) => e.date === TODAY);

  // Timers this list was not handed. One read, plus a re-read whenever any
  // /api/timers write is announced (api.js dispatches it for every surface).
  const [ownTimers, setOwnTimers] = useState(null);
  const [ownFetchedAt, setOwnFetchedAt] = useState(Date.now());
  useEffect(() => {
    if (timers || !hasToday) return undefined;
    let alive = true;
    const load = () => api.get('/api/timers')
      .then((t) => { if (alive) { setOwnTimers(t); setOwnFetchedAt(Date.now()); } })
      .catch(() => {});
    load();
    window.addEventListener('tk:timers-changed', load);
    return () => { alive = false; window.removeEventListener('tk:timers-changed', load); };
  }, [timers, hasToday]);

  const timerList = timers || ownTimers || [];
  const at = fetchedAt || ownFetchedAt;

  // THE LIVE ELEMENT IS THE CLOCK, not the recorded figure. Ticking the hours
  // (2026-08-14 feedback: "these numbers don't update live") made the row show
  // a number that existed nowhere else in the app — Today said 2.7 where the
  // ledger held 2.6 and 0.0 (wave-1 review, D8). The counter that is actually
  // moving is the HH:MM:SS beside it, which ticks on this same interval; the
  // recorded figure catches up the moment the timer stops and files.
  const anyRunning = timerList.some((t) => t.running && t.linked_entry_id);
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!anyRunning || !at) return undefined;
    return startAlignedTick(at, () => forceTick((x) => x + 1));
  }, [anyRunning, at]);

  // THE TIMER A ROW BELONGS TO. The one that filed the entry, else the sole
  // timer on its matter — a matter with two named work streams keeps two rows,
  // for the same reason the Today list keeps them (see timergrid.js).
  const timerOf = (e) => {
    const linked = timerList.find((t) => t.linked_entry_id === e.id);
    if (linked) return linked;
    if (!e.cm) return null;
    const onMatter = timerList.filter((t) => t.cm_id === e.cm.id);
    return onMatter.length === 1 ? onMatter[0] : null;
  };

  const liveSecs = (t) => (t && t.running ? liveTimerSeconds(t, at) : null);

  // (no manual tk:timers-changed dispatch here — api.js announces every
  // successful /api/timers write itself now)

  async function startTimer(entry) {
    try {
      await api.post('/api/timers/start-for-entry', { entry_id: entry.id });
      onChanged();
    } catch (e) {
      emitToast(e.message, { error: true });
    }
  }

  async function stopTimer(timer) {
    try {
      const r = await api.post(`/api/timers/${timer.id}/stop`);
      onChanged();
      if (r.discarded) emitToast('Misclick (under 2s) — nothing recorded.');
    } catch (e) {
      emitToast(e.message, { error: true });
    }
  }

  async function del(entry) {
    await api.del(`/api/entries/${entry.id}`);
    onChanged();
    emitToast(`Deleted ${fmtHours(entry.total, increment)}h ${entry.cm ? `entry for ${entry.cm.short_name}` : 'unassociated entry'}`, {
      actionLabel: 'Undo',
      action: async () => { await api.post(`/api/entries/${entry.id}/restore`); onChanged(); },
    });
  }

  async function finalize(entry) {
    try {
      await api.post(`/api/entries/${entry.id}/finalize`);
      markJustFinalized(entry.id); // one lock pulse on the refreshed chip
      onChanged();
      emitToast('Finalized', {
        actionLabel: 'Unlock',
        action: async () => { await api.post(`/api/entries/${entry.id}/unlock`); onChanged(); },
      });
    } catch (e) {
      if (e.status === 422) openEditor({ id: entry.id }); // show the findings in the editor
      else emitToast(e.message, { error: true });
    }
  }

  async function unlock(entry) {
    await api.post(`/api/entries/${entry.id}/unlock`);
    onChanged();
    emitToast('Unlocked — edits will be tracked in the audit log.');
  }

  // ONE ROW MENU, SHARED WITH THE TODAY LIST (components/menu.js). The
  // capabilities are the same on both screens now and are decided by what the
  // row IS — the wave-1 review's D7 was that two different menus hung off
  // visually identical rows and `Delete entry` existed on only one of them.
  // `Edit timer…` and the backdate chips are the two items this surface cannot
  // supply (the Edit-timer dialog lives with the Today list), and rows here
  // have never offered them.
  const cardMenuItems = (card) => rowMenuItems({
    timer: card.timer,
    entries: card.entries,
    focus: card.focus,
    fmtHours: (h) => fmtHours(h, increment),
  }, {
    start: () => startTimer(card.focus),
    stop: (t) => stopTimer(t),
    startForEntry: (e) => startTimer(e),
    openEntry: (e) => openEditor({ id: e.id }),
    // The editor lives in the expandable half of the row, so asking for it has
    // to open that half — otherwise the menu item is a no-op in compact.
    writeNarrative: (e) => {
      setExpanded((s) => new Set([...s, card.key]));
      setWritingId(e.id);
    },
    finalize: (e) => finalize(e),
    unlock: (e) => unlock(e),
    copyToToday: (e) => openEditor({ copyFrom: e.id }),
    deleteEntry: (e) => setDeleting(e),
  });

  if (!entries || entries.length === 0) {
    // Every empty state needs a ROUTE FORWARD, not just an explanation
    // (Primer Blankslate / Polaris both require the action slot for exactly
    // this reason) — so it falls back to opening the entry editor rather than
    // rendering a dead end.
    const onEmpty = emptyAction || (openEditor ? () => openEditor({ template: {} }) : null);
    return html`
      <div class="entry-list">
        <${EmptyState} icon="clock" heading="No time recorded on this day"
          description="Nothing has been logged here yet. Add an entry to record time you have already worked, or start a timer on the Today screen."
          actionLabel=${onEmpty ? 'Add an entry' : null}
          onAction=${onEmpty || undefined} />
      </div>`;
  }

  // Multi-day lists (Week/Month/Range — 2026-07-13 feedback): the date is a
  // GROUP HEADER ("Thursday, June 18, 2026"), not a field repeated on every
  // card, with a subtle divider where a new ISO week begins. Entries arrive
  // date-ordered from the API, so consecutive runs are whole days.
  const mondayOf = (dateStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d, 12);
    dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
    return dt.toDateString();
  };
  const dayGroups = [];
  if (showDate) {
    for (const e of entries) {
      const last = dayGroups[dayGroups.length - 1];
      if (last && last.date === e.date) last.entries.push(e);
      else dayGroups.push({ date: e.date, entries: [e] });
    }
  }

  // THE ENTRY A CARD SPEAKS FOR — same rule as the Today list: the timer's own
  // entry when it carries anything, else the biggest real draft, never a 0.0h
  // leftover.
  const substantive = (e) => !!(e.narrative || '').trim() || e.total > 0;
  const focusEntryOf = (card) => {
    const es = card.entries;
    const linked = card.timer ? es.find((e) => e.id === card.timer.linked_entry_id) : null;
    if (linked && substantive(linked)) return linked;
    const drafts = es.filter((e) => e.status === 'draft' && substantive(e));
    if (drafts.length) return drafts.slice().sort((a, b) => b.total - a.total)[0];
    return linked || es.find((e) => e.status === 'draft') || es[0];
  };

  const cardsFor = (list, date) => {
    let out;
    if (date !== TODAY || timerList.length === 0) {
      out = list.map((e) => ({ key: `e${e.id}`, timer: null, entries: [e] }));
    } else {
      out = [];
      const byTimer = new Map();
      for (const e of list) {
        const t = timerOf(e);
        if (!t) { out.push({ key: `e${e.id}`, timer: null, entries: [e] }); continue; }
        if (!byTimer.has(t.id)) {
          const row = { key: `t${t.id}`, timer: t, entries: [] };
          byTimer.set(t.id, row);
          out.push(row);
        }
        byTimer.get(t.id).entries.push(e);
      }
    }
    for (const c of out) {
      // The running placeholder leads its card, then the day's entries newest
      // first — the same order the Today list shows the same two objects in,
      // because "same day, same data, two answers" is the defect this row was
      // rebuilt to close.
      if (c.entries.length > 1) {
        c.entries.sort((a, b) => {
          const live = (x) => (c.timer && c.timer.running && c.timer.linked_entry_id === x.id ? 0 : 1);
          return live(a) - live(b) || b.id - a.id;
        });
      }
      c.focus = focusEntryOf(c);
    }
    return out;
  };

  const card = (c) => {
    const { timer } = c;
    const es = c.entries;
    const e = c.focus;
    const isToday = e.date === TODAY;
    const running = !!(timer && timer.running) || !!(runningIds && runningIds.has(e.id));
    const secs = timer ? liveSecs(timer) : null;
    // THE DAY'S RECORD, and only the record. It used to carry the running
    // timer's unfiled clock as well, which is how Today came to report a matter
    // at 2.7 while the ledger showed the same work as 2.6 + 0.0 and 2.7 existed
    // nowhere in the data (wave-1 review, D8). Time that has not been filed is
    // the CLOCK, and the clock is beside it while it runs.
    const filed = es.reduce((a, x) => a + x.total, 0);
    const needsNarrative = e.status === 'draft' && !(e.narrative || '').trim() && !running;
    const isOpen = expanded.has(c.key);
    const bodyId = `eb-${c.key}`;
    // The timer's name where a timer exists, the matter's display name
    // otherwise — the Today screen's label source, on this screen too.
    const name = timer ? timer.name : (e.cm ? e.cm.short_name : null);
    const cmNumber = timer ? timer.cm_number : e.cm?.cm_number;
    // A running timer's own entry is work in progress, not a defect: the server
    // excludes it from the attention buckets for exactly this reason, and the
    // Today list says "files at the next stop" rather than "total is zero".
    const isLive = (x) => !!(timer && timer.running && timer.linked_entry_id === x.id);

    const body = [];
    if (es.length > 1) {
      for (const x of es) {
        body.push(html`
          <div key=${`e${x.id}`} class="work-entry">
            <span class="work-entry-h mono" title=${`${fmtHours(x.total, increment)}h on this entry`}>
              ${fmtHours(x.total, increment)}h</span>
            ${isLive(x) && !(x.narrative || '').trim()
              ? html`<span class="muted small">running — files at the next stop</span>`
              : html`<${InlineNarrative} entry=${x} onChanged=${onChanged}
                  autoEdit=${writingId === x.id} onDone=${() => setWritingId(null)} />`}
          </div>`);
      }
    } else if (isLive(e) && !(e.narrative || '').trim()) {
      body.push(html`<p key="live" class="work-hint muted small">Running — files at the next stop.</p>`);
    } else {
      body.push(html`<${InlineNarrative} key="narr" entry=${e} onChanged=${onChanged}
        autoEdit=${writingId === e.id} onDone=${() => setWritingId(null)} />`);
    }
    if (e.status === 'draft' && !running) {
      // "Narrative is empty" and "No matter" already have their own affordances
      // on this row (the Write-narrative control and the Assign-matter button)
      // — repeating them as red findings is the same defect stated twice.
      const findings = e.validation.filter((f) => f.code !== 'narrative_empty' && f.code !== 'no_matter');
      if (findings.length) body.push(html`<${ValidationList} key="valid" compact=${true} findings=${findings} />`);
    }

    // THE THIRD STEP: what only an expanded row shows. Only a SPLIT is worth a
    // line — a lone task code is in the entry editor and in every export.
    const extra = [];
    if (es.length === 1 && e.tasks.length > 1) {
      extra.push(html`<div key="tasks" class="muted small work-tasks">
        ${e.tasks.map((t) => `${t.task_code || '—'} ${fmtHours(t.duration, increment)}`).join(' · ')}</div>`);
    }

    const stateClass = running ? ' running' : needsNarrative ? ' needs-narrative' : ' worked';

    return html`
      <div key=${c.key} class=${'entry-card work-row entry-row ' + (e.billable ? 'billable' : 'nonbillable') + stateClass
        + (isOpen ? ' expanded' : '')}
        data-entry-id=${e.id} aria-expanded=${isOpen ? 'true' : 'false'}
        onClickCapture=${(ev) => {
          if (ev.target.closest('button, input, select, textarea, a')) return;
          toggleExpand(c.key);
        }}>

        ${/* LINE ONE IS IDENTITY: the matter, its number, its exceptions. It
              never wraps — an ellipsis is a truncation you can see, a wrap is a
              row that is silently 40px taller than the one above it. */''}
        <div class="work-main">
          ${name ? html`
            <button class="timer-name entry-open" title="Open this entry"
              onClick=${() => openEditor({ id: e.id })}>${name}</button>` : html`
            <strong class="muted work-noname">No matter yet</strong>`}
          ${cmNumber ? html`<span class="work-cm muted mono small">${cmNumber}</span>` : null}
          ${/* CHIPS ARE FOR THE EXCEPTION, NOT THE RULE (reference-analysis
                §3). Billable is the default state and carries the figure's
                colour; only non-billable is called out. "draft" is the default
                status, so only finalized and exported earn a chip. */''}
          ${e.billable ? null : html`<${BillableBadge} billable=${0} />`}
          ${e.status === 'draft' ? null : html`<${StatusChip} entry=${e} />`}
          ${e.exported_at ? html`<span class="chip chip-exported" title=${'Exported ' + fmtStamp(e.exported_at)}>
            <${Icon} name="export" size=${12} /> exported</span>` : null}
          ${/* With the narrative in the expandable half, the compact row has to
                say that one is missing — the row still carries the matter, the
                state, the hours and the transport control. */''}
          ${needsNarrative ? html`
            <span class="chip chip-todo" title="This entry cannot be finalized until it has a billing narrative">
              no narrative</span>` : null}
        </div>

        ${/* LINE TWO IS THE CONTROL STRIP: transport, the day's one figure, the
              disclosure, the overflow. Same four things in the same order on
              every row, so a thumb learns one place. */''}
        <div class="work-controls">
          ${/* THE ONLY VARIANT BETWEEN THIS ROW AND THE TODAY ROW: a day that is
                over has nothing to start. Present-but-disabled where the row is
                on today and finalized, exactly as the Today row is, so the two
                screens do not disagree about whether a row has a control. */''}
          ${isToday ? (timer && timer.running ? html`
            <button class="btn btn-sm work-toggle timer-stop-btn entry-timer-btn running"
              title=${`Stop "${timer.name}" & file time`}
              onClick=${() => stopTimer(timer)}>
              <${Icon} name="stop" size=${15} /><span class="work-toggle-label">Stop</span></button>` : html`
            <button class="btn btn-sm work-toggle timer-start-btn entry-timer-btn"
              disabled=${!(timer || e.status === 'draft')}
              title=${timer ? `Resume "${timer.name}" on this entry`
                : e.status === 'draft' ? 'Start a timer on this entry (links back to its timer)'
                  : 'Finalized — unlock this entry before recording more time against it'}
              onClick=${() => startTimer(e)}>
              <${Icon} name="play" size=${15} /><span class="work-toggle-label">Start</span></button>`) : null}
          ${!name ? html`
            <button class="btn btn-sm work-assign"
              title="Assign a client/matter — required before this entry can finalize or export"
              onClick=${() => openEditor({ id: e.id })}>Assign matter</button>` : null}

          ${/* ONE NUMBER PER ROW — the hours recorded on it — with the live
                HH:MM:SS beside it only while the clock is actually running,
                which is the one moment two figures say two different things.
                A row whose record is still zero because the clock has not been
                filed yet shows the clock alone: "0.0" next to a ticking counter
                is the two-numbers-one-of-them-zero defect in another costume. */''}
          <div class="work-figures">
            <span class="timer-clock-pair">
              ${running && secs != null ? html`
                <span class="timer-clock-raw mono" title=${`${fmtClock(secs)} on the clock`}>${fmtClock(secs)}</span>` : null}
              ${!running || filed > 0 ? html`
                <span class=${'work-hours-static mono' + (running ? ' active' : '')}
                  title=${`${fmtHours(filed, increment)}h recorded on this ${es.length > 1 ? 'matter' : 'entry'} today`}>
                  ${fmtHours(filed, increment)}</span>` : null}
            </span>
          </div>

          <button class="btn btn-ghost btn-sm work-expand" aria-controls=${bodyId}
            aria-expanded=${isOpen ? 'true' : 'false'}
            title=${isOpen ? 'Hide the narrative and the task split' : 'Show the narrative and the task split'}
            aria-label=${`${isOpen ? 'Collapse' : 'Expand'} — ${name || 'this entry'}`}
            onClick=${() => toggleExpand(c.key)}>
            <${Icon} name=${isOpen ? 'chevronUp' : 'chevronDown'} size=${16} /></button>

          ${/* The trigger stores the ELEMENT, not a pair of coordinates: it is
                what the popover hangs off, what edge-collision measures against,
                and what focus returns to when the menu closes. */''}
          ${/* Keyed, not object-identified: `cardsFor` rebuilds these rows on
                every render, so `menu.card === c` went false the instant the menu
                opened and the ⋯ reported aria-expanded="false" underneath its own
                open menu. `c.key` is `t<timer id>` / `e<entry id>`. */''}
          <button class="btn btn-ghost btn-sm entry-more timer-more" title="Row menu"
            aria-label=${`Row menu — ${name || 'this entry'}`}
            ...${menuTriggerProps(!!menu && menu.key === c.key)}
            onClick=${(ev) => setMenu({ anchor: ev.currentTarget, key: c.key })}>
            <${Icon} name="more" size=${16} /></button>
        </div>

        <div class="work-body" id=${bodyId}>${body}</div>
        ${extra.length ? html`<div class="work-extra">${extra}</div>` : null}
      </div>`;
  };

  const confirmDelete = deleting ? html`
    <${Confirm} title="Delete entry" danger confirmLabel="Delete"
      message=${`Delete this ${fmtHours(deleting.total, increment)}h entry${deleting.cm ? ` for ${deleting.cm.short_name}` : ''}? You'll have a few seconds to undo from the toast.`}
      onConfirm=${() => del(deleting)}
      onClose=${() => setDeleting(null)} />` : null;

  // The open menu is re-read from the CURRENT rows, so an entry finalized or
  // given a narrative while its menu is open rewrites the menu instead of
  // acting on the row as it was when it opened. If the row is gone, so is the
  // menu.
  const openCard = menu
    ? (showDate
      ? dayGroups.flatMap((g) => cardsFor(g.entries, g.date))
      : cardsFor(entries, entries[0].date)).find((c) => c.key === menu.key)
    : null;
  const rowMenu = openCard ? html`
    <${Menu} anchor=${menu.anchor} title=${rowMenuTitle(openCard)} items=${cardMenuItems(openCard)}
      onClose=${() => setMenu(null)} />` : null;

  if (!showDate) {
    return html`<div class=${`entry-list work-rows density-${density}`}>${cardsFor(entries, entries[0].date).map(card)}${confirmDelete}${rowMenu}</div>`;
  }

  return html`
    <div class=${`entry-list work-rows density-${density}`}>
      ${dayGroups.map((g, gi) => {
        const total = g.entries.reduce((a, e) => a + e.total, 0);
        const newWeek = gi > 0 && mondayOf(dayGroups[gi - 1].date) !== mondayOf(g.date);
        return html`
          <div key=${g.date}>
            ${newWeek ? html`<div class="entry-week-divider" role="separator"></div>` : null}
            <div class="entry-day-head">
              <span>${fmtDateFull(g.date)}</span>
              <span class="muted small">${g.entries.length} ${g.entries.length === 1 ? 'entry' : 'entries'} · ${fmtHours(total, increment)}h</span>
            </div>
            ${cardsFor(g.entries, g.date).map(card)}
          </div>`;
      })}
      ${confirmDelete}
      ${rowMenu}
    </div>`;
}

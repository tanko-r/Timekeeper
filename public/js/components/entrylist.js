import { api } from '/js/api.js';
import {
  html, useState, useEffect, fmtHours, fmtTenths, emitToast, BillableBadge, StatusChip,
  ValidationList, fmtStamp, Icon, markJustFinalized, fmtDateFull, Confirm, ContextMenu,
} from '/js/ui.js';
import { startAlignedTick, liveTimerSeconds } from '/js/lib/tick.js';
import { parseNarrativeEdit } from '/js/lib/narrativesync.js';
import { GhostInput, useMatterSuggestions } from '/js/components/ghosttext.js';
import { useShortcuts } from '/js/components/shortcuts.js';
import { expandShortcuts } from '/js/lib/expand.js';

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

// Card list of entries with ONE inline action plus an overflow (teardown §6 /
// E8: five unlabelled ghost icons per row was the finding). The matter name is
// the row's open affordance; everything rare — finalize one, unlock, copy to
// today, delete — lives behind the labelled "⋯" menu.
// `timers` enables the per-entry start/stop-timer button — it resumes the timer
// linked to the entry (or links/creates one server-side).
export function EntryList({
  entries, openEditor, onChanged, settings, showDate = false,
  runningIds = null, timers = null, fetchedAt = null, emptyAction = null,
}) {
  const increment = (settings?.rounding?.increment) || 0.1;
  const [deleting, setDeleting] = useState(null);
  const [menu, setMenu] = useState(null); // {x, y, entry}

  const timerFor = (entry) => (timers || []).find((t) => t.linked_entry_id === entry.id);

  // A running timer's time reaches its entry only when the timer stops, so the
  // filed total sat still while the clock climbed (2026-08-14 feedback: "These
  // numbers don't update live when the timer is running"). Tick once a second
  // while any linked timer runs and show what the entry is worth right now,
  // rounded exactly like the timer row.
  const roundMode = settings?.rounding?.enabled === false ? 'nearest' : (settings?.rounding?.mode || 'up');
  const anyRunning = (timers || []).some((t) => t.running && t.linked_entry_id);
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!anyRunning || !fetchedAt) return undefined;
    return startAlignedTick(fetchedAt, () => forceTick((x) => x + 1));
  }, [anyRunning, fetchedAt]);

  const hoursLabel = (entry) => {
    const t = timerFor(entry);
    const secs = t && t.running ? liveTimerSeconds(t, fetchedAt) : null;
    return secs == null ? fmtHours(entry.total, increment) : fmtTenths(secs, roundMode);
  };

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

  // Every capability the old five-icon cluster carried, one menu deep and
  // labelled. Nothing was dropped: view/edit became the row's name button and
  // the first menu item.
  const entryMenuItems = (e) => [
    { label: e.status === 'draft' ? 'Open entry…' : 'View entry…', icon: 'eye', onClick: () => openEditor({ id: e.id }) },
    ...(e.status === 'draft' ? [
      { label: 'Finalize this entry', icon: 'lock', onClick: () => finalize(e) },
    ] : [
      { label: 'Unlock for editing', icon: 'unlock', onClick: () => unlock(e) },
    ]),
    { label: 'Copy to today', icon: 'copy', onClick: () => openEditor({ copyFrom: e.id }) },
    ...(e.status === 'draft' ? [
      { hr: true },
      { label: 'Delete entry', icon: 'trash', danger: true, onClick: () => setDeleting(e) },
    ] : []),
  ];

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

  const card = (e) => {
    const running = !!(runningIds && runningIds.has(e.id));
    const needsNarrative = e.status === 'draft' && !(e.narrative || '').trim() && !running;
    return html`
        <div key=${e.id} class=${'entry-card ' + (e.billable ? 'billable' : 'nonbillable')
          + (needsNarrative ? ' needs-narrative' : '')}>
          <div class="body">
            <div class="entry-meta">
              ${e.cm ? html`
                <button class="entry-open" title="Open this entry"
                  onClick=${() => openEditor({ id: e.id })}>${e.cm.short_name}</button>
                <span class="muted mono small">${e.cm.cm_number}</span>` : html`
                <strong class="muted">No matter yet</strong>
                <button class="btn btn-sm" title="Assign a client/matter — required before this entry can finalize or export"
                  onClick=${() => openEditor({ id: e.id })}>Assign matter</button>`}
              ${/* CHIPS ARE FOR THE EXCEPTION, NOT THE RULE (reference-analysis
                    §3: six-plus hues live on one screen where no reference
                    exceeds two or three). Billable is the default state and
                    carries the figure's colour; only non-billable is called
                    out. "draft" is the default status, so only finalized and
                    exported earn a chip. The bare "created by a timer" glyph
                    was an unlabelled, pointer-only chip carrying nothing a
                    lawyer acts on — it is gone. */''}
              ${e.billable ? null : html`<${BillableBadge} billable=${0} />`}
              ${e.status === 'draft' ? null : html`<${StatusChip} entry=${e} />`}
              ${e.exported_at ? html`<span class="chip chip-exported" title=${'Exported ' + fmtStamp(e.exported_at)}>
                <${Icon} name="export" size=${12} /> exported</span>` : null}
              ${running ? html`
                <span class="chip chip-running" title="Timer running — the hours tick live and file at the next stop">
                  <${Icon} name="timer" size=${12} /> running</span>` : null}
            </div>
            <${InlineNarrative} entry=${e} onChanged=${onChanged} />
            ${e.tasks.length > 1 ? html`
              <div class="muted small">
                ${e.tasks.map((t) => `${t.task_code || '—'} ${fmtHours(t.duration, increment)}`).join(' · ')}
              </div>` : e.tasks.length === 1 && e.tasks[0].task_code ? html`
              <div class="muted small">${e.tasks[0].task_code}</div>` : null}
            ${/* "Narrative is empty" and "No matter" already have their own
                  affordances on this row (the Write-narrative control and the
                  Assign-matter button) — repeating them as red findings is the
                  same defect stated twice. */''}
            ${e.status === 'draft' ? html`<${ValidationList} compact=${true}
              findings=${e.validation.filter((f) => f.code !== 'narrative_empty' && f.code !== 'no_matter')} />` : null}
          </div>
          <div class="entry-side">
            <div class=${'hours' + (running ? ' active' : '')}
              title=${running ? `Running — ${fmtHours(e.total, increment)}h filed so far` : null}>${hoursLabel(e)}</div>
            <div class="entry-actions">
              ${timers && e.status === 'draft' ? (() => {
                const t = timerFor(e);
                return t && t.running ? html`
                  <button class="btn btn-sm entry-timer-btn running" title=${`Stop "${t.name}" & file time`}
                    onClick=${() => stopTimer(t)}><${Icon} name="stop" size=${15} /> Stop</button>` : html`
                  <button class="btn btn-sm entry-timer-btn"
                    title=${t ? `Resume "${t.name}" on this entry` : 'Start a timer on this entry (links back to its timer)'}
                    onClick=${() => startTimer(e)}><${Icon} name="play" size=${15} /> Start</button>`;
              })() : null}
              <button class="btn btn-ghost btn-sm entry-more" title="More actions for this entry"
                aria-label="More actions for this entry"
                onClick=${(ev) => {
                  const r = ev.currentTarget.getBoundingClientRect();
                  setMenu({ x: r.left, y: r.bottom + 2, entry: e });
                }}><${Icon} name="more" size=${16} /></button>
            </div>
          </div>
        </div>`;
  };

  const confirmDelete = deleting ? html`
    <${Confirm} title="Delete entry" danger confirmLabel="Delete"
      message=${`Delete this ${fmtHours(deleting.total, increment)}h entry${deleting.cm ? ` for ${deleting.cm.short_name}` : ''}? You'll have a few seconds to undo from the toast.`}
      onConfirm=${() => del(deleting)}
      onClose=${() => setDeleting(null)} />` : null;

  const rowMenu = menu ? html`
    <${ContextMenu} x=${menu.x} y=${menu.y} items=${entryMenuItems(menu.entry)}
      onClose=${() => setMenu(null)} />` : null;

  if (!showDate) return html`<div class="entry-list">${entries.map(card)}${confirmDelete}${rowMenu}</div>`;

  return html`
    <div class="entry-list">
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
            ${g.entries.map(card)}
          </div>`;
      })}
      ${confirmDelete}
      ${rowMenu}
    </div>`;
}

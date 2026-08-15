import { api, downloadText } from '/js/api.js';
import {
  html, React, useState, useEffect, useRef, useMemo, useCallback, Overlay,
  fmtHours, emitToast, Icon, Spinner, ValidationList,
} from '/js/ui.js';
import { GhostInput } from '/js/components/ghosttext.js';
import { useShortcuts } from '/js/components/shortcuts.js';
import { expandShortcuts } from '/js/lib/expand.js';
import { containsTimeAmounts } from '/js/lib/timeamounts.js';

// ===========================================================================
// CLOSE THE DAY — a review LIST, not a card carousel  (teardown §18, wave-1 F2)
//
// The wave-1 review's single biggest number: a five-entry day cost 18
// interactions, and 23 if the lawyer used the new one-tap stop chips — the
// fast path made the day LONGER. The cause was measured and confirmed:
//
//   "The stop chip and the close-out sweep are not connected. An entry that
//    already has a narrative — because you chipped it thirty seconds earlier —
//    still gets its own card in the sweep and still costs an Enter. Close-out
//    charges 1 + N + 2 where N is EVERY draft. The wave's own new capability —
//    the phrasebook pre-fill and the chip — should be able to retire cards,
//    not just pre-fill them."
//
// So the sweep no longer charges for finished work:
//
//   1. A DRAFT THAT ALREADY HAS A NARRATIVE IS NOT A CARD. It goes in the
//      "Ready" list, which the lawyer reads and confirms ONCE with the
//      primary. Chipping an entry now removes a step from the day instead of
//      adding one.
//   2. WHAT IS LEFT IS A LIST, NOT A CAROUSEL. The teardown: "you cannot tell
//      at a glance which of the four drafts still need work, and you cannot
//      skip ahead to the one you know is wrong. For 4 drafts a carousel is
//      fine; for 12 it is a trap." Every remaining draft is on screen with its
//      pre-filled narrative in an editable field. The keyboard contract
//      survives and reads better on a list than it did on a stack: Enter
//      accepts the row and drops to the next, ↑/↓ walk the fields, `e` opens
//      the full editor, Esc quits.
//   3. ACCEPT ALL, for the ordinary day where every suggestion is right.
//   4. EDIT NO LONGER DESTROYS THE SWEEP. It used to call onClose(true), so
//      correcting one entry cost the whole pass — measured: Edit on card 1 of
//      4 unmounted the sweep, and Escape left you on Today with no sweep at
//      all. The editor opens OVER the review now (the overlay primitive is a
//      LIFO stack and handles this natively) and the review is still there,
//      with that row re-read from the server, when the editor closes.
//   5. THE TERMINAL STATE IS A TOAST WHEN IT CARRIES NO DECISION. A dialog is
//      for urgent information or a decision (Material 3); "the day closed and
//      the CSV downloaded" is neither, and charging a tap for `Done` on the
//      clean path is the last fixed cost in the flow. The panel STAYS — and
//      says considerably more than it used to — whenever something is left
//      over, because then there IS a decision.
//
// Phases: loading · empty · review · warn · blocked · closed.
// The summary phase is gone: it existed only to show a count between the last
// card and the commit, and the review list shows that count the whole time.
// ===========================================================================

// A draft is "ready" when it already says what the work was — chipped from the
// stop offer, typed on the row, written in the editor, or built from task
// lines (AUTO). Ready drafts cost nothing at close-out.
const isReady = (d) => (
  d.narrative_auto ? !!String(d.narrative || '').trim() : !!String(d.narrative || '').trim());

export function CloseOut({ onClose, openEditor }) {
  const [drafts, setDrafts] = useState(null); // null = loading; frozen at open
  const [date, setDate] = useState(null);
  const [phase, setPhase] = useState('loading');
  const [texts, setTexts] = useState({});     // entry id → what the field holds
  const [skip, setSkip] = useState({});       // entry id → deliberately left a draft
  const [sugg, setSugg] = useState({});       // cm id → phrasebook lines
  const [readyOpen, setReadyOpen] = useState(true);
  const [warnInfo, setWarnInfo] = useState(null); // { warnOnly, hard, newDrafts? }
  const [closedInfo, setClosedInfo] = useState(null); // { total, blocked: [] }
  const [blockedInfo, setBlockedInfo] = useState(null); // { blocked: [] }
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState(null); // an entry open in the editor OVER this
  const changedRef = useRef(false); // anything saved/finalized/exported/edited
  const savedRef = useRef(0);       // narratives written during this pass

  const shortcuts = useShortcuts();
  const expand = useCallback((t, caret) => expandShortcuts(t, caret, shortcuts), [shortcuts]);

  const ready = useMemo(() => (drafts || []).filter(isReady), [drafts]);
  const needs = useMemo(
    () => (drafts || []).filter((d) => !isReady(d) && !skip[d.id]), [drafts, skip]);
  const parked = useMemo(
    () => (drafts || []).filter((d) => !isReady(d) && skip[d.id]), [drafts, skip]);
  const draftById = useMemo(() => {
    const m = {};
    (drafts || []).forEach((d) => { m[d.id] = d; });
    return m;
  }, [drafts]);

  // The field's value: what the lawyer typed, else the matter's top clean
  // phrasebook line, so the primary CONFIRMS rather than composes. Resolved at
  // render instead of synced by an effect — an effect that pre-fills has to
  // know whether the field was touched, and the touched case is exactly
  // `texts[id] !== undefined`.
  const valueOf = useCallback((d) => {
    if (texts[d.id] !== undefined) return texts[d.id];
    return (sugg[d.cm?.id] || [])[0] || '';
  }, [texts, sugg]);

  // Fresh fetch on open — the dashboard's copy behind this overlay may be
  // stale (a stop-chip pick, another tab, etc.).
  const load = useCallback(async (first) => {
    setPhase('loading');
    try {
      const d = await api.get('/api/dashboard');
      const list = d.entries.filter((e) => e.status === 'draft');
      setDate(d.date);
      setDrafts(list);
      setTexts({});
      setSkip({});
      setWarnInfo(null);
      setPhase(list.length === 0 ? 'empty' : 'review');
    } catch (e) {
      emitToast(e.message, { error: true });
      onClose(first ? false : changedRef.current);
    }
  }, [onClose]);

  useEffect(() => { load(true); }, []); // eslint-disable-line

  // One phrasebook read per matter that still needs a narrative — the same
  // endpoint the entry editor and the stop chips use, asked for the whole list
  // at once because a list of N rows cannot call a per-matter hook N times.
  const needKey = needs.map((d) => d.cm?.id || 0).join(',');
  useEffect(() => {
    const ids = [...new Set(needs.map((d) => d.cm?.id).filter(Boolean))];
    if (ids.length === 0) return undefined;
    let alive = true;
    Promise.all(ids.map((id) => api.get(`/api/matters/${id}/suggestions`)
      .then((r) => [id, r.phrases.map((p) => p.text).filter((t) => !containsTimeAmounts(t))])
      .catch(() => [id, []])))
      .then((pairs) => {
        if (!alive) return;
        setSugg((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const [id, list] of pairs) {
            if (!(id in next)) { next[id] = list; changed = true; }
          }
          return changed ? next : prev;
        });
      });
    return () => { alive = false; };
  }, [needKey]); // eslint-disable-line

  // Keyboard-first on desktop: the caret starts in the first field that still
  // needs words. THUMB-first on a phone — a bottom sheet that throws the soft
  // keyboard up over its own list before the lawyer has read it is the
  // opposite of what this dialog is for, and every action here has a button.
  useEffect(() => {
    if (phase !== 'review') return;
    if (window.matchMedia('(max-width: 767px)').matches) return;
    const el = document.querySelector('.closeout-card .co-item textarea');
    if (el) el.focus();
  }, [phase]);

  // ---------- writes ----------

  async function save(d, text) {
    if (d.narrative_auto) return true;
    if (text === (d.narrative || '')) return true;
    try {
      await api.patch(`/api/entries/${d.id}`, { narrative: text });
      changedRef.current = true;
      savedRef.current += 1;
      setDrafts((list) => list.map((x) => (x.id === d.id ? { ...x, narrative: text } : x)));
      return true;
    } catch (e) {
      emitToast(e.message, { error: true });
      return false;
    }
  }

  // Enter on a row: write it and drop to the next one that still needs words.
  // The row leaves the list the moment it is saved, so the next field has to be
  // chosen before the write and focused after the re-render.
  async function acceptRow(id) {
    const d = draftById[id];
    if (!d) return;
    const i = needs.findIndex((x) => x.id === id);
    const nextId = i > -1 && needs[i + 1] ? needs[i + 1].id : null;
    const text = valueOf(d);
    if (String(text).trim()) await save(d, text);
    requestAnimationFrame(() => {
      const el = nextId
        ? document.querySelector(`.co-item[data-entry-id="${nextId}"] textarea`)
        : document.querySelector('.closeout-card .co-primary');
      if (el) el.focus();
    });
  }

  async function acceptAll() {
    setBusy(true);
    try {
      for (const d of needs) {
        const text = valueOf(d);
        if (String(text).trim()) await save(d, text); // eslint-disable-line no-await-in-loop
      }
    } finally { setBusy(false); }
  }

  // ---------- the editor, OVER the review ----------
  //
  // The overlay primitive is a LIFO stack, so the entry editor opens on top and
  // answers Escape first; this dialog stays mounted underneath with its list,
  // its typed text and its place intact. Two things have to follow from that:
  // this component's capture-phase key handler must stand down while it is
  // covered (below), and the row has to be re-read when the editor closes,
  // because the editor is exactly where its narrative may have been written.
  function editEntry(id) {
    changedRef.current = true;
    setEditingId(id);
    openEditor({ id });
  }

  useEffect(() => {
    if (editingId == null) return undefined;
    let seen = false;
    const iv = setInterval(async () => {
      const open = !!document.querySelector('.ovl-panel.modal');
      if (open) { seen = true; return; }
      if (!seen) return; // the editor has not mounted yet
      clearInterval(iv);
      const id = editingId;
      setEditingId(null);
      try {
        const fresh = await api.get(`/api/entries/${id}`);
        setDrafts((list) => (fresh.status === 'draft' && !fresh.deleted_at
          ? list.map((x) => (x.id === id ? { ...x, ...fresh } : x))
          : list.filter((x) => x.id !== id)));
        setTexts((t) => { const n = { ...t }; delete n[id]; return n; });
      } catch { /* deleted, or offline — leave the row as it stands */ }
    }, 150);
    return () => clearInterval(iv);
  }, [editingId]);

  // ---------- finalize / export ----------

  async function finalizeAndExport(ack) {
    setBusy(true);
    try {
      // Everything the lawyer left in a field is his answer — write it before
      // the day is locked, or the primary would finalize past his own text.
      if (!ack) {
        for (const d of needs) {
          const text = valueOf(d);
          if (String(text).trim()) await save(d, text); // eslint-disable-line no-await-in-loop
        }
      }
      if (ack) {
        // finalize-day applies ack DATE-WIDE, not per-entry (and the plan
        // forbids changing it): a draft filed while this warning card sat on
        // screen (background timer stop, another tab) would get its warnings
        // acknowledged and finalized sight unseen. Guard client-side: only
        // ack if today's draft set is still exactly what this pass reviewed
        // (the frozen list + the blocked ids the warning screen listed).
        const freshD = await api.get('/api/dashboard');
        const reviewed = new Set([
          ...(drafts || []).map((d) => d.id),
          ...(warnInfo ? [...warnInfo.warnOnly, ...warnInfo.hard].map((b) => b.id) : []),
        ]);
        const newDrafts = freshD.entries.filter((e) => e.status === 'draft' && !reviewed.has(e.id));
        if (newDrafts.length > 0) {
          setWarnInfo((w) => ({ ...w, newDrafts }));
          return;
        }
      }
      // Deliberately no markJustFinalized() for the bulk path: the closed
      // moment is its own confirmation here; a row of chips pulsing behind the
      // backdrop would be decoration (spec §7 restraint).
      const r = await api.post('/api/finalize-day', { date, ack });
      changedRef.current = true;
      const warnOnly = r.blocked.filter((b) => b.blocks.length === 0);
      const hard = r.blocked.filter((b) => b.blocks.length > 0);
      if (!ack && warnOnly.length > 0) {
        setWarnInfo({ warnOnly, hard });
        setPhase('warn');
        return;
      }
      await doExport(hard);
    } finally {
      setBusy(false);
    }
  }

  async function doExport(hard) {
    const left = hard || [];
    const r = await api.post('/api/export', { from: date, to: date });
    changedRef.current = true;
    if (r.count === 0) {
      setBlockedInfo({ blocked: left.length ? left : (drafts || []).map((d) => ({ id: d.id, blocks: [] })) });
      setPhase('blocked');
      return;
    }
    downloadText(`timekeeper-${date}.csv`, r.csv);
    const fresh = await api.get('/api/dashboard');
    if (left.length === 0) {
      // NOTHING LEFT TO DECIDE — so this is a snackbar, not a dialog. The
      // export has downloaded and the day behind the scrim is finalized; a
      // modal whose only control is "Done" was the last fixed interaction in
      // the whole flow and it bought the lawyer nothing.
      emitToast(`Day closed — ${fmtHours(fresh.today.total)}h finalized and exported as CSV`);
      onClose(true);
      return;
    }
    setClosedInfo({ total: fresh.today.total, blocked: left });
    setPhase('closed');
  }

  // ---------- keyboard ----------
  //
  // Document-level capture listener (the StopChips pattern). Escape is NOT
  // handled here — the Overlay primitive owns it for every dialog in the app.
  useEffect(() => {
    // While the entry editor (or anything else) is open OVER this dialog, this
    // listener has to be silent: it runs in the CAPTURE phase at document
    // level, so a stray stopPropagation here would swallow keystrokes before
    // the dialog above ever saw them.
    const covered = () => {
      const panels = document.querySelectorAll('.ovl-panel');
      const top = panels[panels.length - 1];
      return !top || !top.classList.contains('closeout-card');
    };
    function onKey(e) {
      if (covered()) return;
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = ['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable;
      // A focused BUTTON owns its own Enter/Space — Accept all, Edit, Skip and
      // the primary are real buttons, and this must not fire twice on top of a
      // button's own click.
      const onButton = !!(e.target.closest && e.target.closest('button'));
      const item = e.target.closest ? e.target.closest('.co-item') : null;

      if (phase === 'review' && e.key === 'Enter' && !e.shiftKey && !onButton) {
        e.preventDefault();
        e.stopPropagation();
        if (item) acceptRow(Number(item.dataset.entryId));
        else if (!busy) finalizeAndExport(false);
        return;
      }

      // ↑/↓ walk the list. Inside a field they only leave it once the caret has
      // no line left to travel to, which is how every list-of-textareas worth
      // copying behaves — a narrative can be two lines and the arrow keys still
      // have to edit it.
      if (phase === 'review' && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey) {
        if (typing) {
          if (!item || tag !== 'textarea') return;
          const v = e.target.value || '';
          const c = e.target.selectionStart;
          const free = e.key === 'ArrowDown'
            ? !v.slice(c).includes('\n')
            : !v.slice(0, c).includes('\n');
          if (!free) return;
        }
        const fields = [...document.querySelectorAll('.closeout-card .co-item textarea')];
        if (fields.length === 0) return;
        const i = fields.indexOf(document.activeElement);
        const next = i < 0 ? (e.key === 'ArrowDown' ? 0 : fields.length - 1) : i + (e.key === 'ArrowDown' ? 1 : -1);
        if (next < 0 || next >= fields.length) return;
        e.preventDefault();
        e.stopPropagation();
        fields[next].focus();
        return;
      }

      if (typing) return; // never fence real typing — the field must see its own keys
      if (!(e.metaKey || e.ctrlKey || e.altKey) && e.key === 'e' && phase === 'review') {
        const id = item ? Number(item.dataset.entryId) : (needs[0] && needs[0].id);
        if (id) {
          e.preventDefault();
          e.stopPropagation();
          editEntry(id);
          return;
        }
      }
      // FENCE: app.js's global shortcut handler (n/t/q/c///g/?) is a
      // document-level BUBBLE listener. It stands down for any open overlay
      // now, but this capture fence predates that and still costs nothing —
      // stop propagation for every key we do not handle when the target is not
      // a form field. No preventDefault: browser defaults (button Enter/Space)
      // survive.
      e.stopPropagation();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [phase, drafts, texts, skip, sugg, needs, busy, editingId]); // eslint-disable-line

  // ---------- render ----------

  const totalOf = (list) => list.reduce((s, d) => s + Number(d.total || 0), 0);
  const label = (d) => (d.cm ? d.cm.short_name : 'No matter yet');

  let body;
  let title = 'Close the day';

  if (phase === 'loading') {
    body = html`<${Spinner} />`;
  } else if (phase === 'empty') {
    body = html`
      <${React.Fragment}>
        <p>Nothing to close — no drafts today.</p>
        <div class="ovl-actions">
          <button class="btn btn-primary" onClick=${() => onClose(changedRef.current)}>Close</button>
        </div>
      <//>`;
  } else if (phase === 'review') {
    const nNeed = needs.length;
    const nReady = ready.length;
    const willSave = needs.filter((d) => String(valueOf(d)).trim()).length;
    const willStay = (nNeed - willSave) + parked.length;
    title = nNeed === 0 ? 'Close the day' : `Close the day — ${nNeed} to write`;

    body = html`
      <${React.Fragment}>
        ${/* THE DAY'S SHAPE, in one line, before anything asks for a decision.
              It replaces the dot pagination, which could only say "card 3 of 5"
              — a position in a stack, never how much work was left. */''}
        <p class="co-shape">
          <strong>${drafts.length} draft${drafts.length === 1 ? '' : 's'}</strong>
          <span class="co-shape-hours mono">${fmtHours(totalOf(drafts))}h</span>
          <span class="muted">${nNeed === 0
            ? 'every one already has a narrative'
            : `${nReady} ready · ${nNeed} still need${nNeed === 1 ? 's' : ''} a narrative`}</span>
        </p>

        ${nNeed > 0 ? html`
          <section class="co-group">
            <div class="co-group-head">
              <h3 class="co-group-title">Needs a narrative <span class="co-count">${nNeed}</span></h3>
              ${willSave > 1 ? html`
                <button class="btn btn-sm co-acceptall" disabled=${busy} onClick=${acceptAll}
                  title="Save every suggestion below as it stands">
                  <${Icon} name="check" size=${14} /> Accept all ${willSave}
                </button>` : null}
            </div>
            <ul class="co-list">
              ${needs.map((d) => html`
                <li key=${d.id} class="co-item" data-entry-id=${d.id}>
                  <div class="co-item-head">
                    <strong>${label(d)}</strong>
                    <span class="co-item-hours mono">${fmtHours(d.total)}h</span>
                  </div>
                  <${GhostInput} multiline rows=${2} value=${valueOf(d)}
                    suggestions=${sugg[d.cm?.id] || []} expand=${expand}
                    aria-label=${`Narrative for ${label(d)}`}
                    placeholder="What did you do?"
                    onChange=${(t) => setTexts((p) => ({ ...p, [d.id]: t }))} />
                  <div class="co-item-acts">
                    <button class="btn btn-sm" onClick=${() => setSkip((s) => ({ ...s, [d.id]: true }))}
                      title="Leave this one as a draft — nothing is lost">Skip</button>
                    <button class="btn btn-sm" onClick=${() => editEntry(d.id)}
                      title="Open the full editor over this review">
                      <${Icon} name="edit" size=${14} /> Edit<kbd class="ovl-kbd" aria-hidden="true">e</kbd>
                    </button>
                  </div>
                </li>`)}
            </ul>
          </section>` : null}

        ${parked.length > 0 ? html`
          <section class="co-group">
            <div class="co-group-head">
              <h3 class="co-group-title">Staying a draft <span class="co-count">${parked.length}</span></h3>
            </div>
            <ul class="co-list co-list-quiet">
              ${parked.map((d) => html`
                <li key=${d.id} class="co-row">
                  <span class="co-row-name">${label(d)}</span>
                  <span class="co-row-hours mono">${fmtHours(d.total)}h</span>
                  <button class="btn btn-sm"
                    onClick=${() => setSkip((s) => { const n = { ...s }; delete n[d.id]; return n; })}
                    title="Put this one back in the list">Undo</button>
                </li>`)}
            </ul>
          </section>` : null}

        ${/* READY — the whole point of this rewrite. A draft that was finished
              at the moment the timer stopped (a stop chip, the row's own field,
              the editor) is not a card to be walked through: it is work already
              done, and it is confirmed once, with everything else, by the
              primary below. */''}
        ${nReady > 0 ? html`
          <section class=${'co-group co-ready' + (readyOpen ? '' : ' co-shut')}>
            <button class="co-disclosure" aria-expanded=${readyOpen ? 'true' : 'false'}
              onClick=${() => setReadyOpen((v) => !v)}>
              <${Icon} name=${readyOpen ? 'chevronDown' : 'chevronRight'} size=${16} />
              <span class="co-group-title">Ready <span class="co-count">${nReady}</span></span>
              <span class="co-row-hours mono">${fmtHours(totalOf(ready))}h</span>
            </button>
            ${readyOpen ? html`
              <ul class="co-list co-list-quiet">
                ${ready.map((d) => html`
                  <li key=${d.id} class="co-row">
                    <span class="co-row-name">
                      ${label(d)}
                      ${d.narrative_auto ? html`<span class="auto-badge">AUTO</span>` : null}
                    </span>
                    <span class="co-row-hours mono">${fmtHours(d.total)}h</span>
                    <span class="co-row-narr" title=${d.narrative}>${d.narrative}</span>
                    <button class="btn btn-sm btn-icon" aria-label=${`Edit ${label(d)}`}
                      title=${`Edit ${label(d)}`} onClick=${() => editEntry(d.id)}>
                      <${Icon} name="edit" size=${14} />
                    </button>
                  </li>`)}
              </ul>` : null}
          </section>` : null}

        ${/* The reassurance goes ABOVE the buttons, not after them: it is what
              makes the primary safe to press, and on a phone the action row is
              lifted out of the scrolling body and pinned to the sheet, so only
              the last child before it is guaranteed to be read. */''}
        <p class="closeout-note muted small">
          ${willStay > 0
            ? `${willStay} will stay ${willStay === 1 ? 'a draft' : 'drafts'} — nothing is lost, and it will be here tomorrow.`
            : 'Nothing is lost either way — a draft left alone stays a draft.'}
        </p>

        <div class="ovl-actions">
          <button class="btn" onClick=${() => onClose(changedRef.current)}>
            Not yet<kbd class="ovl-kbd" aria-hidden="true">Esc</kbd>
          </button>
          <button class="btn btn-primary co-primary" disabled=${busy}
            data-autofocus=${nNeed === 0 ? '' : undefined}
            onClick=${() => finalizeAndExport(false)}>
            <${Icon} name="lock" size=${16} /> Finalize & export<kbd class="ovl-kbd" aria-hidden="true">Enter</kbd>
          </button>
        </div>
      <//>`;
  } else if (phase === 'warn') {
    body = html`
      <${React.Fragment}>
        ${warnInfo.warnOnly.length > 0 ? html`
          <h3 class="closeout-warn-title">Finalize with warnings?</h3>
          <div class="closeout-warnlist">
            ${warnInfo.warnOnly.map((b) => html`
              <div key=${b.id} class="closeout-warnitem">
                <strong>${draftById[b.id] ? label(draftById[b.id]) : `entry #${b.id}`}</strong>
                <${ValidationList} findings=${b.warns} compact />
              </div>`)}
          </div>
          ${warnInfo.newDrafts ? html`
            <div class="closeout-warnitem">
              <strong>New drafts appeared while you reviewed</strong> — reopen
              close-out to include them (the warning ack applies to the whole
              day, so accepting now would finalize them unseen).
              <div class="closeout-warnlist" style=${{ marginTop: '6px' }}>
                ${warnInfo.newDrafts.map((e) => html`
                  <span key=${e.id} class="small">${e.cm ? e.cm.short_name : 'No matter yet'} · ${fmtHours(e.total)}h</span>`)}
              </div>
              <div class="ovl-actions">
                <button class="btn btn-primary" onClick=${() => load(false)}>Start the review again</button>
              </div>
            </div>` : html`
            <div class="ovl-actions">
              <button class="btn" onClick=${() => onClose(changedRef.current)}>Not yet</button>
              <button class="btn btn-primary" disabled=${busy} onClick=${() => finalizeAndExport(true)}>
                Accept warnings & finalize
              </button>
            </div>`}` : null}
        ${warnInfo.hard.length > 0 ? html`
          <h3 class="closeout-warn-title">Cannot finalize yet</h3>
          <div class="closeout-warnlist">
            ${warnInfo.hard.map((b) => html`
              <div key=${b.id} class="closeout-warnitem">
                <span>${draftById[b.id] ? label(draftById[b.id]) : `entry #${b.id}`}</span>
                <${ValidationList} findings=${b.blocks} compact />
                <button class="btn btn-sm" onClick=${() => editEntry(b.id)}>Edit</button>
              </div>`)}
          </div>` : null}
      <//>`;
  } else if (phase === 'blocked' || phase === 'closed') {
    // ONE SCREEN FOR "SOMETHING IS LEFT OVER", and it says what and why.
    // The wave-1 review, D12: the closed panel "reads '1 draft still need
    // attention' — grammar, and a state question: the sweep accepted 5 of 5 and
    // one draft is still outstanding, unexplained." It is explained now: each
    // leftover is named, with the validation finding that blocked it and a
    // button that opens it.
    const info = phase === 'closed' ? closedInfo : blockedInfo;
    const left = info.blocked || [];
    const n = left.length;
    title = phase === 'closed' ? 'Day closed' : 'Nothing exported yet';
    body = html`
      <${React.Fragment}>
        ${phase === 'closed' ? html`
          <p class="closeout-hours mono">Day closed — ${fmtHours(info.total)}h · exported</p>` : null}
        <p>
          ${phase === 'closed'
            ? `Everything else is finalized and in the CSV. ${n} ${n === 1 ? 'draft could' : 'drafts could'} not be finalized:`
            : `Nothing could be finalized, so nothing was exported. ${n} ${n === 1 ? 'draft needs' : 'drafts need'} attention:`}
        </p>
        <div class="closeout-warnlist">
          ${left.map((b) => html`
            <div key=${b.id} class="closeout-warnitem">
              <strong>${draftById[b.id] ? label(draftById[b.id]) : `entry #${b.id}`}</strong>
              ${b.blocks && b.blocks.length ? html`<${ValidationList} findings=${b.blocks} compact />` : null}
              <button class="btn btn-sm" onClick=${() => editEntry(b.id)}>
                <${Icon} name="edit" size=${14} /> Fix it now
              </button>
            </div>`)}
        </div>
        <p class="muted small">
          They stay as drafts on ${date}. Nothing was lost, and closing the day
          again once they are fixed exports just them.
        </p>
        <div class="ovl-actions">
          <button class="btn btn-primary" onClick=${() => onClose(true)}>Done</button>
        </div>
      <//>`;
  }

  // One dialog, every phase. The panel keeps `closeout-card` (this component's
  // own key handler and the e2e suite both select by it) and carries the phase
  // as data, where the backdrop used to.
  return html`
    <${Overlay} title=${title} onClose=${() => onClose(changedRef.current)}
      className=${'closeout-card' + (phase === 'closed' ? ' closeout-closed' : '')}
      panelAttrs=${{ 'data-phase': phase }}
      initialFocus=".co-item textarea">
      ${body}
    <//>`;
}

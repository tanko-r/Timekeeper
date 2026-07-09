import { api, downloadText } from '/js/api.js';
import {
  html, useState, useEffect, useRef, useMemo, useCallback, createPortal,
  fmtHours, emitToast, Icon, Spinner, ValidationList,
} from '/js/ui.js';
import { GhostInput, useMatterSuggestions } from '/js/components/ghosttext.js';
import { useShortcuts } from '/js/components/shortcuts.js';
import { expandShortcuts } from '/js/lib/expand.js';
import { containsTimeAmounts } from '/js/lib/timeamounts.js';

// One-sweep close-out (spec §7): silent drafts → one card at a time,
// centered, pre-filled from memory — Enter confirms and advances. At the
// end, a single Finalize & export action closes the day. Keys: Enter accept
// · e edit (opens the full editor, closes the sweep) · ↓ skip · Esc quit
// (nothing lost — drafts stay drafts either way).
export function CloseOut({ onClose, openEditor }) {
  const [cards, setCards] = useState(null); // null = loading; frozen at open
  const [date, setDate] = useState(null);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState('loading');
  // sweep totals — for the summary card's "X drafts narrated · Y skipped"
  const [accepted, setAccepted] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [text, setText] = useState('');
  const [warnInfo, setWarnInfo] = useState(null); // { warnOnly, hard, newDrafts? }
  const [closedInfo, setClosedInfo] = useState(null); // { total, stillBlocked }
  const [blockedInfo, setBlockedInfo] = useState(null); // { n }
  const [busy, setBusy] = useState(false);
  const changedRef = useRef(false); // anything saved/finalized/exported/edited
  const prevIdxRef = useRef(-1);
  const lastAutoRef = useRef(''); // last programmatically-set text (vs. user edits)

  const current = cards && phase === 'sweep' ? cards[idx] : null;
  const cardById = useMemo(() => {
    const m = {};
    (cards || []).forEach((c) => { m[c.id] = c; });
    return m;
  }, [cards]);

  // Ghost-text suggestions for the current card's matter (Task 4's phrasebook,
  // same component the entry editor uses); expand wired exactly like it too.
  const phrases = useMatterSuggestions(current && !current.narrative_auto ? current.cm.id : null);
  const shortcuts = useShortcuts();
  const expand = useCallback((t, caret) => expandShortcuts(t, caret, shortcuts), [shortcuts]);

  // Fresh fetch on open — the dashboard's copy behind this overlay may be
  // stale (a stop-chip pick, another tab, etc.).
  useEffect(() => {
    let alive = true;
    api.get('/api/dashboard').then((d) => {
      if (!alive) return;
      const drafts = d.entries.filter((e) => e.status === 'draft');
      setDate(d.date);
      setCards(drafts);
      setPhase(drafts.length === 0 ? 'empty' : 'sweep');
    }).catch((e) => {
      emitToast(e.message, { error: true });
      onClose(false);
    });
    return () => { alive = false; };
  }, []); // eslint-disable-line

  // Pre-fill the field: the stored narrative, or — when blank — the matter's
  // top clean suggestion, so Enter-through confirms rather than composes.
  // Re-syncs when phrases finish loading (async) as long as the user hasn't
  // typed anything of their own yet; always resets on a new card.
  useEffect(() => {
    if (!current) return;
    const isNewCard = prevIdxRef.current !== idx;
    prevIdxRef.current = idx;
    const base = current.narrative_auto
      ? (current.narrative || '')
      : (String(current.narrative || '').trim()
          ? current.narrative
          : (phrases.find((p) => !containsTimeAmounts(p)) || ''));
    setText((prev) => {
      if (isNewCard || prev === lastAutoRef.current) {
        lastAutoRef.current = base;
        return base;
      }
      return prev;
    });
  }, [idx, current, phrases]); // eslint-disable-line

  function advance(wasAccepted) {
    if (wasAccepted) setAccepted((c) => c + 1); else setSkipped((c) => c + 1);
    setIdx((i) => {
      const next = i + 1;
      if (!cards || next >= cards.length) setPhase('summary');
      return next;
    });
  }

  async function acceptCurrent() {
    const c = cards[idx];
    if (!c.narrative_auto && text !== (c.narrative || '')) {
      try {
        await api.patch(`/api/entries/${c.id}`, { narrative: text });
        changedRef.current = true;
      } catch (e) {
        emitToast(e.message, { error: true });
      }
    }
    advance(true);
  }

  function skipCurrent() { advance(false); }

  function editCurrent() {
    const c = cards[idx];
    changedRef.current = true;
    openEditor({ id: c.id });
    onClose(true);
  }

  function editBlocked(id) {
    changedRef.current = true;
    openEditor({ id });
    onClose(true);
  }

  async function finalizeAndExport(ack) {
    setBusy(true);
    try {
      if (ack) {
        // finalize-day applies ack DATE-WIDE, not per-entry (and the plan
        // forbids changing it): a draft filed while this warning card sat on
        // screen (background timer stop, another tab) would get its warnings
        // acknowledged and finalized sight unseen. Guard client-side: only
        // ack if today's draft set is still exactly what this sweep reviewed
        // (the frozen cards + the blocked ids the warning screen listed).
        const freshD = await api.get('/api/dashboard');
        const reviewed = new Set([
          ...(cards || []).map((c) => c.id),
          ...(warnInfo ? [...warnInfo.warnOnly, ...warnInfo.hard].map((b) => b.id) : []),
        ]);
        const newDrafts = freshD.entries.filter((e) => e.status === 'draft' && !reviewed.has(e.id));
        if (newDrafts.length > 0) {
          setWarnInfo((w) => ({ ...w, newDrafts }));
          return;
        }
      }
      // Deliberately no markJustFinalized() for the bulk path: the closed-
      // moment card is the confirmation here; a row of chips pulsing behind
      // the backdrop would be decoration (spec §7 restraint).
      const r = await api.post('/api/finalize-day', { date, ack });
      changedRef.current = true;
      const warnOnly = r.blocked.filter((b) => b.blocks.length === 0);
      const hard = r.blocked.filter((b) => b.blocks.length > 0);
      if (!ack && warnOnly.length > 0) {
        setWarnInfo({ warnOnly, hard });
        setPhase('warn');
        return;
      }
      await doExport(hard.length);
    } finally {
      setBusy(false);
    }
  }

  // Re-run the whole sweep from a fresh snapshot (used when new drafts
  // appeared mid-sweep and the warning ack was refused).
  async function restartSweep() {
    setPhase('loading');
    setWarnInfo(null);
    setAccepted(0);
    setSkipped(0);
    setIdx(0);
    prevIdxRef.current = -1;
    lastAutoRef.current = '';
    try {
      const d = await api.get('/api/dashboard');
      const drafts = d.entries.filter((e) => e.status === 'draft');
      setDate(d.date);
      setCards(drafts);
      setPhase(drafts.length === 0 ? 'empty' : 'sweep');
    } catch (e) {
      emitToast(e.message, { error: true });
      onClose(changedRef.current);
    }
  }

  async function doExport(stillBlocked) {
    const r = await api.post('/api/export', { from: date, to: date });
    changedRef.current = true;
    if (r.count === 0) {
      setBlockedInfo({ n: stillBlocked || cards.length });
      setPhase('blocked');
      return;
    }
    downloadText(`timekeeper-${date}.csv`, r.csv);
    const fresh = await api.get('/api/dashboard');
    setClosedInfo({ total: fresh.today.total, stillBlocked });
    setPhase('closed');
  }

  // Document-level capture-phase listener (StopChips pattern): guards
  // e/ArrowDown/Escape while typing, EXCEPT Enter — which must accept the
  // card even while the GhostInput textarea has focus (Shift+Enter still
  // inserts a newline, since multiline narratives are expected here).
  useEffect(() => {
    function onKey(e) {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = ['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable;
      if (e.key === 'Enter' && phase === 'sweep' && !e.shiftKey
          && (!typing || e.target.closest('.closeout-card'))) {
        e.preventDefault();
        e.stopPropagation();
        acceptCurrent();
        return;
      }
      if (typing) return; // never fence real typing — the field must see its own keys
      if (!(e.metaKey || e.ctrlKey || e.altKey)) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose(changedRef.current);
          return;
        }
        if (e.key === 'e' && phase === 'sweep') {
          e.preventDefault();
          e.stopPropagation();
          editCurrent();
          return;
        }
        if (e.key === 'ArrowDown' && phase === 'sweep') {
          e.preventDefault();
          e.stopPropagation();
          skipCurrent();
          return;
        }
      }
      // FENCE: app.js's global shortcut handler (n/t/q/c///g/?) is a
      // document-level BUBBLE listener that only knows to stand down for the
      // editor and quick-capture — this overlay is dashboard-local state it
      // can't see, so without this a stray `n` would open the entry editor
      // invisibly UNDER the close-out backdrop (z-index 100 vs 300). Stop
      // propagation (capture runs before bubble) for every key we don't
      // explicitly handle when the target isn't a form field. No
      // preventDefault — browser defaults (button Enter/Space, etc.) survive.
      e.stopPropagation();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [phase, idx, cards, text]); // eslint-disable-line

  // ---------- render ----------

  let body;
  if (phase === 'loading') {
    body = html`<div class="closeout-card"><${Spinner} /></div>`;
  } else if (phase === 'empty') {
    body = html`
      <div class="closeout-card">
        <p>Nothing to close — no drafts today.</p>
        <div class="row-end">
          <button class="btn btn-primary" onClick=${() => onClose(false)}>Close</button>
        </div>
      </div>`;
  } else if (phase === 'sweep') {
    // the dashboard's cm object carries no client_name (see enrich()); the
    // short name alone matches how EntryList labels entries today
    const label = current.cm.short_name;
    body = html`
      <div class="closeout-card">
        <div class="closeout-dots">
          ${cards.map((_, i) => html`<span key=${i} class=${'closeout-dot' + (i <= idx ? ' on' : '')}></span>`)}
        </div>
        <div class="closeout-head">
          <strong>${label}</strong>
          <span class="closeout-hours mono">${fmtHours(current.total)}h</span>
        </div>
        ${current.narrative_auto ? html`
          <div class="narrative-preview">
            <span class="auto-badge">AUTO</span>
            <textarea readOnly value=${current.narrative || ''}></textarea>
          </div>` : html`
          <${GhostInput} multiline rows=${3} value=${text} suggestions=${phrases} expand=${expand}
            placeholder="What did you do?" onChange=${setText} />`}
        <div class="closeout-keys muted small">
          <kbd>Enter</kbd> accept · <kbd>e</kbd> edit · <kbd>↓</kbd> skip · <kbd>Esc</kbd> quit
        </div>
      </div>`;
  } else if (phase === 'summary') {
    body = html`
      <div class="closeout-card">
        <p>${accepted} draft${accepted === 1 ? '' : 's'} narrated · ${skipped} skipped</p>
        <div class="row-end">
          <button class="btn btn-primary" disabled=${busy} onClick=${() => finalizeAndExport(false)}>
            <${Icon} name="lock" size=${16} /> Finalize & export
          </button>
        </div>
      </div>`;
  } else if (phase === 'warn') {
    body = html`
      <div class="closeout-card">
        ${warnInfo.warnOnly.length > 0 ? html`
          <h3 class="closeout-warn-title">Finalize with warnings?</h3>
          <div class="closeout-warnlist">
            ${warnInfo.warnOnly.map((b) => html`
              <div key=${b.id} class="closeout-warnitem">
                <strong>${cardById[b.id]?.cm.short_name || `entry #${b.id}`}</strong>
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
                  <span key=${e.id} class="small">${e.cm.short_name} · ${fmtHours(e.total)}h</span>`)}
              </div>
              <div class="row-end">
                <button class="btn btn-primary" onClick=${restartSweep}>Restart the sweep</button>
              </div>
            </div>` : html`
            <div class="row-end">
              <button class="btn btn-primary" disabled=${busy} onClick=${() => finalizeAndExport(true)}>
                Accept warnings & finalize
              </button>
            </div>`}` : null}
        ${warnInfo.hard.length > 0 ? html`
          <h3 class="closeout-warn-title">Cannot finalize yet</h3>
          <div class="closeout-warnlist">
            ${warnInfo.hard.map((b) => html`
              <div key=${b.id} class="closeout-warnitem">
                <span>${cardById[b.id]?.cm.short_name || `entry #${b.id}`}</span>
                <${ValidationList} findings=${b.blocks} compact />
                <button class="btn btn-sm" onClick=${() => editBlocked(b.id)}>Edit</button>
              </div>`)}
          </div>` : null}
      </div>`;
  } else if (phase === 'blocked') {
    body = html`
      <div class="closeout-card">
        <p>Nothing exported — ${blockedInfo.n} draft${blockedInfo.n === 1 ? '' : 's'} still need attention.</p>
        <div class="row-end">
          <button class="btn btn-primary" onClick=${() => onClose(true)}>Done</button>
        </div>
      </div>`;
  } else if (phase === 'closed') {
    body = html`
      <div class="closeout-card closeout-closed">
        <p class="closeout-hours mono">Day closed — ${fmtHours(closedInfo.total)}h · exported</p>
        ${closedInfo.stillBlocked ? html`
          <p class="muted small">${closedInfo.stillBlocked} draft${closedInfo.stillBlocked === 1 ? '' : 's'} still need attention.</p>` : null}
        <div class="row-end">
          <button class="btn btn-primary" onClick=${() => onClose(true)}>Done</button>
        </div>
      </div>`;
  }

  return createPortal(html`
    <div class="closeout-backdrop" data-phase=${phase}
      onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(changedRef.current); }}>
      ${body}
    </div>`, document.body);
}

// ============================================================================
// Menu — the app's ONE menu primitive, and the ONE row menu that rides on it.
//
// WHAT WAS HERE BEFORE. Wave 0b's rule was "every dialog goes through one
// overlay primitive". The menus never joined it, and by the wave-1 review there
// were three of them, measured on the live app:
//
//   .ovl sheets     44px rows   Today's row menu on mobile, the Day ⋯ on
//                               mobile, the CMS list ⋯ on mobile
//   .ctx-menu       28px rows   Today's row menu on desktop, the ledger row ⋯
//                               on both, the Day ⋯ on desktop
//   .act-menu       36px rows   the CMS list ⋯ on desktop
//
// Three critics reported the symptom (28px rows under a thumb); the disease was
// that there were three menus. This file is the cure: ONE component, two
// shapes, every call site converted.
//
//   ≥1024px   an anchored popover — Primer ActionMenu / Polaris ActionList /
//             Fluent ContextualMenu / Radix DropdownMenu, and the shape in
//             shots/refs-v2/attio-overflow-settings-menu.desktop.png: plain
//             text rows, a quiet icon column, a hairline between groups, the
//             panel hung off the right edge of the ⋯ that opened it. Full
//             WAI-ARIA menu-button keyboard: roving focus, Home/End, type-
//             ahead, Escape and Tab both close and hand focus back to the
//             trigger, aria-haspopup / aria-expanded / role=menu / menuitem.
//   <1024px   a bottom sheet through the SHARED overlay primitive
//             (components/overlay.js) — Material 3's answer for a menu on a
//             phone and Apple's action sheet, and the shape in
//             shots/refs-v2/mercury-transaction-detail-and-category-picker
//             .mobile.jpg: a grip, a title naming what the menu acts on, and
//             full-width rows no shorter than the 44px touch floor. The scrim,
//             the focus trap, the scroll lock, Escape, hardware Back and the
//             safe-area inset all come from the one place every dialog gets
//             them.
//
// The class names on the popover are deliberately the OLD ones (.ctx-menu /
// .ctx-item / .ctx-hr / .ctx-custom / .ctx-inline) and on the sheet the old
// sheet ones (.menu-sheet / .sheet-menu / .sheet-item / .sheet-hr /
// .sheet-custom): those are the hooks the e2e suite binds to, and a menu
// unification that renamed everything would have been indistinguishable from a
// menu unification that broke everything.
//
// GROUPING. A flat list of seventeen is not a menu (teardown §5). An item may
// be `{ section: 'Label' }`, which opens a labelled group; rare items go after
// the common ones and destructive items go last, visually distinct. Empty
// groups, leading/trailing rules and doubled rules are pruned here rather than
// at each call site, so a state-driven menu never paints a stray hairline.
//
// ITEM SHAPES — the union of everything the three old menus carried, so nothing
// had to be dropped to convert a call site:
//   { label, icon?, onClick, disabled?, danger?, hidden? }   a plain item
//   { hr: true }                                             a rule
//   { section: 'Label' }                                     a labelled group
//   { custom: () => vnode }                                  a row of controls
// ============================================================================
import htm from '/vendor/htm.module.js';
import { Icon } from '/js/icons.js';
import { Overlay, useDismissLayer } from '/js/components/overlay.js';

const React = window.React;
const html = htm.bind(React.createElement);
const { createPortal } = window.ReactDOM;
const { useState, useEffect, useRef, useLayoutEffect } = React;

// ONE BREAKPOINT FOR THE SHAPE. 1024px, not the app's 767px phone breakpoint:
// between the two sits the tablet, a coarse pointer with a wide screen, and a
// 28px popover row is exactly as unhittable there as it is on a phone. The
// sheet is the safe shape for every pointer that is not a mouse.
const POPOVER_MQ = '(min-width: 1024px)';

export function useMenuPopover() {
  const [wide, setWide] = useState(() => (
    typeof window.matchMedia === 'function' ? window.matchMedia(POPOVER_MQ).matches : true));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(POPOVER_MQ);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

// ---------------------------------------------------------------------------
// Normalising the item list.
//
// Call sites build their items with conditionals, so the raw list arrives with
// holes: a section whose only member turned out to be hidden, a rule at the top
// because the item above it was for timers and this row has none, two rules in
// a row. Rendering those honestly is how a menu ends up looking broken on
// exactly the states nobody photographed.
// ---------------------------------------------------------------------------
function normalise(items) {
  const live = (items || []).filter((it) => it && !it.hidden);
  // group the flat list into { label, rows } blocks split on `section`
  const blocks = [];
  let current = { label: null, rows: [] };
  for (const it of live) {
    if (it.section) {
      if (current.rows.length) blocks.push(current);
      current = { label: it.section, rows: [] };
      continue;
    }
    current.rows.push(it);
  }
  if (current.rows.length) blocks.push(current);
  // strip leading/trailing/doubled rules inside each block
  for (const b of blocks) {
    const out = [];
    for (const row of b.rows) {
      if (row.hr && (out.length === 0 || out[out.length - 1].hr)) continue;
      out.push(row);
    }
    while (out.length && out[out.length - 1].hr) out.pop();
    b.rows = out;
  }
  return blocks.filter((b) => b.rows.length > 0);
}

// Everything the arrow keys walk. Plain items AND the controls inside a custom
// row: the backdate chips and the list's Show/Group/Order switches live in
// custom rows, and a keyboard user who could not reach them would have lost a
// capability the popover used to give away by accident (Tab used to walk into
// them because nothing closed the menu).
const NAV = [
  '.ctx-item:not([disabled])',
  '.ctx-custom button:not([disabled])',
  '.ctx-custom select:not([disabled])',
  '.ctx-custom input:not([disabled])',
].join(',');

const isTextish = (el) => {
  if (!el) return false;
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  return tag === 'select' || tag === 'textarea'
    || (tag === 'input' && !/^(checkbox|radio|button|submit)$/.test(el.type || ''));
};

// ---------------------------------------------------------------------------
// The ≥1024px anchored popover.
// ---------------------------------------------------------------------------
function MenuPopover({ blocks, anchor, x, y, title, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const typed = useRef({ buf: '', at: 0 });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Escape rides the shared dismissal stack (overlay.js) rather than a private
  // listener, so a menu opened from inside a dialog closes itself first and
  // leaves the dialog standing.
  useDismissLayer(true, () => closeRef.current(), ref);

  // First paint is anchored from the trigger alone — the panel has to be in the
  // document before it can be measured. The layout effect corrects it before
  // the browser paints, so nothing flashes.
  const guess = useRef(null);
  if (!guess.current) {
    if (anchor && anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect();
      guess.current = { left: Math.max(8, r.right - 264), top: r.bottom + 4 };
    } else {
      guess.current = { left: Math.max(8, (x || 0)), top: (y || 0) };
    }
  }

  // PLACEMENT AND EDGE COLLISION, measured rather than assumed. The menu that
  // this replaces clamped against a guess of 34px per row, so any change to row
  // height could push a menu opened near the bottom of the window off screen.
  // This one asks the DOM how tall it actually is, flips above its trigger when
  // there is no room below, and clamps into the viewport in both axes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const PAD = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const maxL = Math.max(PAD, window.innerWidth - w - PAD);
    const maxT = Math.max(PAD, window.innerHeight - h - PAD);
    let left;
    let top;
    if (anchor && anchor.getBoundingClientRect && anchor.isConnected) {
      const r = anchor.getBoundingClientRect();
      // Right edges aligned — the Attio reference, and the only alignment that
      // keeps a menu under a right-hand ⋯ instead of across the screen from it.
      left = Math.min(Math.max(PAD, r.right - w), maxL);
      const below = r.bottom + 4;
      const above = r.top - h - 4;
      top = below + h <= window.innerHeight - PAD ? below : above >= PAD ? above : maxT;
    } else {
      left = Math.min(Math.max(PAD, x || 0), maxL);
      const below = y || 0;
      const above = (y || 0) - h;
      top = below + h <= window.innerHeight - PAD ? below : above >= PAD ? above : maxT;
    }
    setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
  }, [anchor, x, y, blocks.length]);

  // The menu-button contract: focus moves into the menu on open, and back to the
  // trigger when it closes, however it closed.
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const first = el.querySelector(NAV);
    (first || el).focus({ preventScroll: true });
    return () => {
      if (anchor && anchor.isConnected && typeof anchor.focus === 'function') {
        anchor.focus({ preventScroll: true });
      }
    };
  }, []); // eslint-disable-line

  useEffect(() => {
    const away = (e) => {
      if (ref.current && !ref.current.contains(e.target)) closeRef.current();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('contextmenu', away);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('contextmenu', away);
    };
  }, []);

  const onKeyDown = (e) => {
    const el = ref.current;
    if (!el) return;
    const rows = [...el.querySelectorAll(NAV)];
    if (rows.length === 0) return;
    const i = rows.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); rows[n].focus(); };
    // A <select> owns its own arrow keys — stepping the menu's focus off it
    // would make the Only filter unusable with a keyboard.
    const onField = isTextish(e.target);
    if (e.key === 'ArrowDown' && !onField) return go(i < 0 ? 0 : (i + 1) % rows.length);
    if (e.key === 'ArrowUp' && !onField) return go(i <= 0 ? rows.length - 1 : i - 1);
    if (e.key === 'Home') return go(0);
    if (e.key === 'End') return go(rows.length - 1);
    // Tab out of a menu closes it (WAI-ARIA APG, Primer, Polaris all agree) —
    // it must never be left standing while focus walks the page behind it.
    if (e.key === 'Tab') { e.preventDefault(); closeRef.current(); return; }
    // TYPE-AHEAD. Letters jump to the next item whose label starts with what
    // has been typed; the buffer expires after 700ms, so "de" finds "Delete
    // entry" and a later "d" starts again.
    if (onField) return;
    if (e.key.length !== 1 || e.altKey || e.ctrlKey || e.metaKey) return;
    const now = Date.now();
    typed.current.buf = (now - typed.current.at < 700 ? typed.current.buf : '') + e.key.toLowerCase();
    typed.current.at = now;
    const labelled = rows.filter((r) => r.classList.contains('ctx-item'));
    const from = labelled.indexOf(document.activeElement);
    const search = [...labelled.slice(from + 1), ...labelled.slice(0, from + 1)];
    const hit = search.find((r) => (r.dataset.label || '').startsWith(typed.current.buf));
    if (hit) { e.preventDefault(); hit.focus(); }
  };

  const p = pos || guess.current;
  let key = 0;
  return createPortal(html`
    <div class="ctx-menu tk-menu" ref=${ref} role="menu" aria-orientation="vertical"
      aria-label=${title || 'Menu'} tabIndex=${-1} onKeyDown=${onKeyDown}
      style=${{ left: `${p.left}px`, top: `${p.top}px` }}>
      ${blocks.map((b, bi) => {
        const labelId = b.label ? `tkm-${bi}-label` : undefined;
        const body = b.rows.map((item) => {
          key += 1;
          if (item.hr) return html`<div key=${key} class="ctx-hr" role="separator"></div>`;
          if (item.custom) {
            return html`<div key=${key} class="ctx-custom" role="group">${item.custom()}</div>`;
          }
          return html`
            <button key=${key} type="button" role="menuitem" tabIndex=${-1}
              class=${'ctx-item' + (item.danger ? ' danger' : '')}
              data-label=${String(item.label || '').toLowerCase()}
              disabled=${item.disabled} title=${item.title || undefined}
              onClick=${() => { closeRef.current(); item.onClick(); }}>
              ${item.icon
                ? html`<${Icon} name=${item.icon} size=${16} className="ctx-ico" />`
                : html`<span class="ctx-spacer" aria-hidden="true"></span>`}
              <span class="ctx-label">${item.label}</span>
            </button>`;
        });
        if (!b.label) return html`<${React.Fragment} key=${`b${bi}`}>${body}<//>`;
        return html`
          <div key=${`b${bi}`} class="ctx-group" role="group" aria-labelledby=${labelId}>
            <div class="ctx-section" id=${labelId}>${b.label}</div>
            ${body}
          </div>`;
      })}
    </div>`, document.body);
}

// ---------------------------------------------------------------------------
// The <1024px bottom sheet. Everything except the rows comes from the shared
// overlay primitive — including the return of focus to the trigger on Escape.
// ---------------------------------------------------------------------------
function MenuSheet({ blocks, title, onClose }) {
  let key = 0;
  return html`
    <${Overlay} title=${title || 'Actions'} onClose=${() => onClose()} size="sm"
      className="menu-sheet tk-menu-sheet">
      <div class="sheet-menu" role="menu" aria-label=${title || 'Actions'}>
        ${blocks.map((b, bi) => {
          const labelId = b.label ? `tkms-${bi}-label` : undefined;
          const body = b.rows.map((item) => {
            key += 1;
            if (item.hr) return html`<div key=${key} class="sheet-hr" role="separator"></div>`;
            if (item.custom) {
              return html`<div key=${key} class="sheet-custom" role="group">${item.custom()}</div>`;
            }
            return html`
              <button key=${key} type="button" role="menuitem"
                class=${'sheet-item' + (item.danger ? ' danger' : '')}
                disabled=${item.disabled}
                onClick=${() => { onClose(); item.onClick(); }}>
                ${item.icon
                  ? html`<${Icon} name=${item.icon} size=${18} />`
                  : html`<span class="sheet-spacer" aria-hidden="true"></span>`}
                <span class="sheet-label">${item.label}</span>
              </button>`;
          });
          if (!b.label) return html`<${React.Fragment} key=${`b${bi}`}>${body}<//>`;
          return html`
            <div key=${`b${bi}`} class="sheet-group" role="group" aria-labelledby=${labelId}>
              <div class="sheet-section" id=${labelId}>${b.label}</div>
              ${body}
            </div>`;
        })}
      </div>
    <//>`;
}

// `anchor` is the trigger element and is what the popover hangs off and what
// focus returns to. `x`/`y` are the fallback for the one caller that has no
// trigger at all — a right-click on a work row.
export function Menu({ anchor = null, x = 0, y = 0, items, title, onClose }) {
  const popover = useMenuPopover();
  const blocks = normalise(items);
  if (blocks.length === 0) return null;
  if (!popover) return html`<${MenuSheet} blocks=${blocks} title=${title} onClose=${onClose} />`;
  return html`
    <${MenuPopover} blocks=${blocks} anchor=${anchor} x=${x} y=${y}
      title=${title} onClose=${onClose} />`;
}

// The attributes every trigger owes its menu. Spread onto the button so no call
// site has to remember aria-haspopup or, the one they all forgot, aria-expanded.
export function menuTriggerProps(open) {
  return { 'aria-haspopup': 'menu', 'aria-expanded': open ? 'true' : 'false' };
}

// ===========================================================================
// THE ROW MENU — one menu, state-driven, for every row that carries work.
//
// Wave-1 review, D7: "Two different overflow menus hang off visually identical
// rows. `Timer menu` (10 items) versus `Entry menu` (6). `Delete entry` exists
// in one and not the other. Nothing on the row tells the lawyer which he is
// about to get."
//
// There is now one. The items are decided by what the row IS, not by which
// component rendered it, and the three groups say so out loud:
//
//   Timer    what the clock can do — the owner constraint's first claim on the
//            row, so it leads (BRIEF: "when a judgement call could go either
//            way, it goes the timer's way"). On a row with no timer this is
//            the one item that makes it one.
//   Entry    what the recorded time can do — open it, write its narrative,
//            finalize or unlock it, copy it forward.
//   Manage   rare timer maintenance: the Edit-timer dialog, which is where
//            duplicate / group / reorder / pin / zero / delete live.
//   then     Delete entry, alone under a rule, in the danger colour, LAST —
//            and present on EVERY row that has an entry. On a finalized entry
//            the server refuses (entries.js: "unlock it before deleting"), so
//            the row is present and disabled and says why, rather than being
//            absent on half the list.
//
// `actions` is a bag of callbacks; an item whose callback the caller cannot
// supply is simply not built. Only the calendar day panel's list is in that
// position, and only for `Edit timer…` and the backdate chips — neither of
// which its rows have ever offered.
// ===========================================================================
export function rowMenuItems(row, actions) {
  const a = actions || {};
  const timer = row.timer || null;
  const entries = row.entries || [];
  const focus = row.focus || null;
  const running = !!(timer && timer.running);
  const fmt = row.fmtHours || ((h) => Number(h || 0).toFixed(1));
  const items = [];

  // ---- Timer ----
  items.push({ section: 'Timer' });
  if (timer) {
    items.push(running
      ? { label: 'Stop & file time', icon: 'stop', onClick: () => a.stop(timer) }
      : { label: 'Start', icon: 'play', onClick: () => a.start(timer) });
    if (a.startBackdated) {
      items.push({
        custom: () => html`
          <div class="ctx-inline">
            <span class="muted small">Start</span>
            ${[10, 30].map((m) => html`
              <button key=${m} class="btn btn-sm" disabled=${running}
                title=${`Start as if it had begun ${m} minutes ago`}
                onClick=${() => a.startBackdated(timer, { minutesAgo: m })}>${m}m ago</button>`)}
            <button class="btn btn-sm" disabled=${running || !timer.last_stopped_at}
              title="Start as if it had begun the moment this timer last stopped"
              onClick=${() => a.startBackdated(timer, { atLastStop: true })}>at last stop</button>
          </div>`,
      });
    }
  } else if (focus && a.startForEntry) {
    items.push({
      label: 'Start a timer on this matter',
      icon: 'play',
      onClick: () => a.startForEntry(focus),
    });
  }

  // ---- Entry ----
  items.push({ section: 'Entry' });
  if (entries.length > 1) {
    // A matter can carry more than one entry today (one the timer filed, one
    // keyed by hand). The row states the total; the menu opens them one by one
    // rather than splitting the matter back into two rows.
    for (const e of entries) {
      const snippet = (e.narrative || '').trim().replace(/\s+/g, ' ').slice(0, 32);
      items.push({
        label: `Open ${fmt(row.liveTotal ? row.liveTotal(e) : e.total)}h${e.status === 'draft' ? '' : ` · ${e.status}`} — ${snippet || 'no narrative yet'}`,
        icon: 'eye',
        onClick: () => a.openEntry(e),
      });
    }
  } else if (focus) {
    items.push({
      label: focus.status === 'draft' ? 'Open entry…' : 'View entry…',
      icon: 'eye',
      onClick: () => a.openEntry(focus),
    });
  } else if (timer) {
    items.push({
      label: 'Open today’s entry',
      icon: 'eye',
      disabled: !timer.linked_entry_id,
      onClick: () => a.openEntry({ id: timer.linked_entry_id }),
    });
  }
  if (focus) {
    if (focus.status === 'draft') {
      if (a.writeNarrative) {
        items.push({ label: 'Write narrative here', icon: 'edit', onClick: () => a.writeNarrative(focus) });
      }
      items.push({ label: 'Finalize this entry', icon: 'lock', onClick: () => a.finalize(focus) });
    } else {
      items.push({ label: 'Unlock for editing', icon: 'unlock', onClick: () => a.unlock(focus) });
    }
    items.push({ label: 'Copy to today', icon: 'copy', onClick: () => a.copyToToday(focus) });
  }

  // ---- Manage, then the destructive item, last and alone ----
  if (timer && a.editTimer) {
    items.push({ section: 'Manage' });
    items.push({ label: 'Edit timer…', icon: 'edit', onClick: () => a.editTimer(timer) });
  }
  if (focus && a.deleteEntry) {
    const draft = focus.status === 'draft';
    items.push({ hr: true });
    items.push({
      label: draft ? 'Delete entry' : 'Delete entry — unlock it first',
      icon: 'trash',
      danger: true,
      disabled: !draft,
      title: draft ? undefined : 'A finalized entry cannot be deleted until it is unlocked',
      onClick: () => a.deleteEntry(focus),
    });
  }
  return items;
}

// The name a row menu answers to. The sheet covers the row it acts on, so the
// title has to say which row that was; on a desktop it is the popover's
// accessible name.
export function rowMenuTitle(row) {
  const timer = row.timer || null;
  const focus = row.focus || null;
  if (timer) return timer.name;
  if (focus && focus.cm) return focus.cm.short_name;
  return 'This row';
}

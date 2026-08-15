// ============================================================================
// Overlay — the app's ONE modal primitive.
//
// Every dialog in Timekeeper goes through this: the entry editor (via Modal in
// ui.js), the close-out sweep, quick capture, the keyboard-shortcut sheet, the
// confirms, the summary. Before this there were four hand-rolled backdrops
// (.modal-backdrop, .qc-backdrop, .closeout-backdrop, .navsheet-backdrop) that
// each re-implemented a different SUBSET of what a modal owes its user, and the
// wave-0 critic found the gaps: a dialog you could tab out of, a page that
// scrolled behind it, a bottom navigation bar left live and undimmed under it,
// and — on the close-out sweep — a phone dialog whose only interactive element
// was a textarea.
//
// component.gallery §3 (Radix Dialog + Primer Dialog + Material 3 bottom
// sheets) is the bar this is built to, and its central lesson is the reason
// this file exists at all: build ONE dialog with a responsive position, never a
// desktop modal and a mobile sheet that drift apart. So:
//
//   - modal by behaviour, not just by looks: focus moves in on open, Tab and
//     Shift+Tab cycle inside the panel, Escape closes and returns focus to
//     whatever opened it, role="dialog" + aria-modal="true".
//   - the scrim paints above EVERY fixed bar the shell owns (--z-overlay is
//     above --z-nav and --z-sticky), and the background — .shell and .botnav —
//     is made `inert` + aria-hidden, so nothing behind the scrim can be
//     tapped, focused or read out.
//   - background scroll is locked while any layer is open (see the
//     .tk-overlay-open rules in shell.css).
//   - one panel, two shapes: a centred dialog at ≥768px, a full-width bottom
//     sheet with a grabber below it. Same component, same markup, CSS decides.
//
// Layers are a LIFO stack: only the topmost overlay answers Escape or traps
// Tab, so a Confirm opened from inside the entry editor closes itself first
// and leaves the editor standing.
// ============================================================================
import htm from '/vendor/htm.module.js';
import { Icon } from '/js/icons.js';

const React = window.React;
const html = htm.bind(React.createElement);
const { createPortal } = window.ReactDOM;
const { useEffect, useRef } = React;

// The open DIALOG layers, oldest first — each { panel }. Module state on
// purpose: the background lock is a document-level fact, not a per-component
// one.
const stack = [];

// THE DISMISSAL STACK.
//
// A dialog is not the only thing Escape can mean. The entry editor opens with
// the client/matter picker's listbox already down (six options), and the
// wave-0b critic measured what one Escape did there: it closed the listbox AND
// the whole editor, in a single press. "I pressed n, saw the suggestions,
// tapped Esc to dismiss just the list" is the most ordinary thing a user can
// do, and it threw away the dialog. Every mature combobox-in-dialog (Radix,
// Primer, Material) makes the first Escape close only the listbox.
//
// So transient layers — popover, menu, in-panel picker — register here through
// useDismissLayer, and Escape pops ONE layer: the topmost. Registration order
// alone cannot decide which that is (a picker inside a dialog registers BEFORE
// the dialog does, because React runs child effects before parent effects), so
// the containing panel decides instead: a transient answers Escape only while
// it lives inside the topmost dialog, or outside every dialog when none is
// open. A picker still registered inside a LOWER dialog is covered by the one
// above it and stays out of the way.
const transients = [];

function escapeTarget() {
  const topDialog = stack[stack.length - 1] || null;
  for (let i = transients.length - 1; i >= 0; i -= 1) {
    const layer = transients[i];
    const el = layer.elRef && layer.elRef.current;
    if (!el || !el.isConnected) continue;
    const host = el.closest('.ovl-panel');
    if (topDialog ? host === topDialog.panel : !host) return layer;
  }
  return topDialog;
}

// Register a transient layer for as long as `open` is true. `elRef` is a ref to
// the layer's root element — it is what places the layer in the stack, so it is
// required. onDismiss is read fresh on every keypress, so a caller may pass an
// inline arrow.
//
// The layer keeps its own listener rather than being called by the dialog's:
// popovers exist on plain pages too (the search filters' matter picker), where
// there is no dialog to do the calling and Escape must still close just the
// listbox.
export function useDismissLayer(open, onDismiss, elRef) {
  const ref = useRef(onDismiss);
  ref.current = onDismiss;
  useEffect(() => {
    if (!open) return undefined;
    const layer = { elRef };
    transients.push(layer);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (escapeTarget() !== layer) return; // something is above us
      e.preventDefault();
      e.stopPropagation();
      ref.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const i = transients.indexOf(layer);
      if (i > -1) transients.splice(i, 1);
    };
  }, [open]); // eslint-disable-line
}

// True while ANY dialog is open. app.js consults this before running a global
// shortcut — a modal owns the keyboard while it is up.
//
// Deliberately asked of the DOM rather than of `stack`: this answer gates every
// global shortcut in the app, so it must be self-healing. A counter that ever
// failed to decrement (an unmount path nobody thought of) would leave `n`, `t`,
// `q`, `/` and the rest silently dead for the whole session, with nothing on
// screen to explain why. A panel that is not in the document cannot be open.
export function overlayOpen() {
  return !!document.querySelector('.ovl-panel');
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => (
    !el.hasAttribute('hidden') && el.getClientRects().length > 0
  ));
}

// Focus something inside the panel without letting the PAGE move (the lock has
// already pinned it, and a focus that scrolls the document fights the restore
// on close) — but do bring it into the panel's OWN scroll box. On a phone the
// sheet is a scrolling body with a pinned action row over it, so the entry
// editor's narrative field can sit below the fold the moment the dialog opens:
// preventScroll alone would put the caret somewhere the reader cannot see.
// A phone sheet does not open with the caret in a text field. The brief is
// keyboard-first on desktop, THUMB-first on a phone, and auto-focusing a
// textarea there raises the soft keyboard over half the sheet before the
// reader has seen what they opened. So the primitive's own pick never lands on
// a text field at phone width — it parks on the panel, which still answers
// Escape and still holds the trap, and the first tap does what a first tap
// does everywhere else on a phone. A dialog whose whole job IS "type this now"
// (quick capture, the close-out sweep) claims focus itself with autoFocus
// during commit and is left alone.
const TYPING_FIELD = /^(text|search|number|email|password|tel|url|date|time|)$/;
function keyboardShy(el) {
  if (!el || !window.matchMedia('(max-width: 767px)').matches) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  return tag === 'input' && TYPING_FIELD.test(el.getAttribute('type') || '');
}

function focusInPanel(el, panel) {
  el.focus({ preventScroll: true });
  if (el === panel) return;
  const r = el.getBoundingClientRect();
  const p = panel.getBoundingClientRect();
  const hidden = r.bottom > Math.min(p.bottom, window.innerHeight) - 4
    || r.top < Math.max(p.top, 0) + 4;
  if (hidden) el.scrollIntoView({ block: 'nearest' });
}

// Everything behind the scrim. .shell holds the whole app (the day footer
// included, since it is rendered inside the dashboard view); .botnav is the
// phone navigation bar, which is a sibling of the shell.
const BACKGROUND = '.shell, .botnav';
const INERT_SUPPORTED = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;

// Where the page was when the first layer opened, so it can be put back.
let savedScrollY = 0;

// The browser must not ALSO try to restore the scroll position, because its
// idea of where the page was is wrong by construction. app.js pushes a marker
// history entry for every overlay (useBackDismiss — hardware Back dismisses
// the dialog instead of leaving the screen behind it), and that push happens
// after lockBackground has already pinned the body, so the offset the browser
// files against the entry it is leaving is 0, not where the reader actually
// was. Closing the dialog consumes the marker with history.back(), and ~800ms
// later Chrome "restored" that 0 straight over the top of our own restore —
// measured: the shortcuts sheet put the page back to 201 at 6ms and the
// browser dragged it to 0 at 795ms. `manual` makes this file the single owner
// of the page's scroll position, which is what the rest of the lock already
// assumes. Set once, at import, so it cannot lose a race with the first push.
if (typeof history !== 'undefined' && 'scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

function lockBackground() {
  // `overflow: hidden` alone is not a scroll lock: it stops the wheel and the
  // finger, but the spec still allows PROGRAMMATIC scrolling, and the critic's
  // test — window.scrollTo while the dialog was open — moved the page behind
  // it from 0 to 400. Pinning the body and offsetting it by the current scroll
  // is the lock that actually holds: with the body out of flow the document
  // has nothing left to scroll, so nothing can scroll it.
  savedScrollY = window.scrollY;
  document.documentElement.classList.add('tk-overlay-open');
  document.body.style.top = `${-savedScrollY}px`;
  for (const el of document.querySelectorAll(BACKGROUND)) {
    el.setAttribute('data-tk-inert', '');
    el.setAttribute('aria-hidden', 'true');
    if (INERT_SUPPORTED) el.inert = true;
  }
}

function unlockBackground() {
  // ORDER MATTERS HERE, and it is measurable. While the lock is on, the body
  // is out of flow and the document collapses to viewport height (measured at
  // 390×844: scrollHeight 1457 → 844). A scroll offset written into a document
  // that short is CLAMPED — to 0 — so the restore has to come after the pin is
  // gone and after the layout that removing it invalidated has been flushed.
  // Undo, flush, restore, all in one synchronous block; nothing is left to the
  // browser and nothing waits for a frame.
  const y = savedScrollY;
  document.documentElement.classList.remove('tk-overlay-open');
  document.body.style.top = '';
  // Reading a layout-dependent property is the flush: the document is full
  // height again from here on, so the write below is not clamped.
  void document.documentElement.scrollHeight;
  const doc = document.scrollingElement || document.documentElement;
  doc.scrollTop = y;
  // Belt and braces for engines where the scrolling element is <body> instead
  // (quirks mode, older WebKit): a no-op when the line above already landed.
  if (Math.abs(window.scrollY - y) > 0.5) window.scrollTo(0, y);
  for (const el of document.querySelectorAll('[data-tk-inert]')) {
    el.removeAttribute('data-tk-inert');
    el.removeAttribute('aria-hidden');
    if (INERT_SUPPORTED) el.inert = false;
  }
}

// `onClose` is called with the gesture that fired it — 'escape', 'scrim' or
// 'close' (Primer's onClose(gesture) contract), so a dialog with unsaved text
// can treat a stray scrim click differently from a deliberate ✕ without
// growing a second callback.
export function Overlay({
  onClose,
  title,            // string, or null for a dialog that draws its own header
  label,            // accessible name when there is no visible title
  size,             // 'sm' | 'md' (default) | 'lg'
  className = '',   // extra classes on the panel (.modal, .qc-card, …)
  panelAttrs,       // extra attributes on the panel (data-phase, …)
  initialFocus,     // selector, focused on open when nothing else claimed it
  dismissible = true, // scrim click / Escape close it
  children,
}) {
  const panelRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // WHO OPENED THIS, captured during render rather than in the effect below.
  // React applies a child's `autoFocus` while it commits the panel — which is
  // BEFORE any passive effect runs — so by effect time `document.activeElement`
  // can already be the dialog's own first field. Reading it in the effect made
  // quick capture and the feedback note (both `autoFocus`) adopt their own
  // textarea as their opener; on close that element was already detached, the
  // restore was skipped, and focus fell to <body> — a keyboard user was
  // dropped at the top of the document every time they pressed Escape.
  // Render runs before commit, so this still sees the real opener.
  const openerRef = useRef(undefined);
  if (openerRef.current === undefined) openerRef.current = document.activeElement;

  useEffect(() => {
    const panel = panelRef.current;
    // Belt and braces: if anything still managed to hand us an element inside
    // this panel, restoring to it would be meaningless.
    const captured = openerRef.current;
    const opener = captured && !panel.contains(captured) ? captured : null;
    const token = { panel };
    stack.push(token);
    if (stack.length === 1) lockBackground();

    // Initial focus. If a child already claimed it (React's autoFocus runs
    // during commit, before this effect) leave it alone — the client/matter
    // picker in the entry editor is the one control that matters there.
    //
    // NEVER the ✕. The header's close button is the first focusable element in
    // every titled dialog, so "first focusable" handed the opening keystroke to
    // the dismiss control: the wave-0b critic opened an existing entry, pressed
    // Space — the most natural first keystroke — and the editor vanished, with
    // a focus ring painted on the ✕ as the dialog's opening image. A dialog
    // asks for the first MEANINGFUL control (Radix/Primer both), and where
    // there is none, the panel itself: Tab then reaches the ✕ in its own time.
    if (!panel.contains(document.activeElement)) {
      // A disabled match is no match: the entry editor asks for its narrative
      // field, and on a FINALIZED entry that field is disabled — focusing it
      // would silently leave focus on <body>, outside the trap.
      const live = (el) => (el && !el.disabled ? el : null);
      const target = live(initialFocus && panel.querySelector(initialFocus))
        || live(panel.querySelector('[data-autofocus]'))
        || focusables(panel).find((el) => !el.classList.contains('ovl-close'))
        || panel;
      focusInPanel(keyboardShy(target) ? panel : target, panel);
    }

    const onKey = (e) => {
      if (e.key === 'Escape') {
        // The dismissal stack decides: a picker's listbox inside this panel
        // outranks the panel, and the dialog only closes once nothing is left
        // above it.
        if (escapeTarget() !== token) return;
        if (!dismissible) return;
        e.preventDefault();
        e.stopPropagation();
        closeRef.current('escape');
        return;
      }
      if (stack[stack.length - 1] !== token) return; // a layer above us owns it
      if (e.key !== 'Tab') return;
      const list = focusables(panel);
      if (list.length === 0) { e.preventDefault(); panel.focus({ preventScroll: true }); return; }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      // `active === panel` is the dialog that opened onto its own panel (a
      // dialog with no meaningful first control). Tab has to be caught there
      // too: the panel is the LAST thing in the document, so a Shift+Tab left
      // to the browser walks straight out of the bottom of the page.
      if (!panel.contains(active) || active === panel) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);

    return () => {
      document.removeEventListener('keydown', onKey, true);
      const i = stack.indexOf(token);
      if (i > -1) stack.splice(i, 1);
      if (stack.length === 0) unlockBackground();
      // Focus goes back where it came from (Radix/Primer's contract). The
      // opener can be gone — a row that was deleted by the dialog itself.
      if (opener && opener.isConnected && typeof opener.focus === 'function') {
        opener.focus({ preventScroll: true });
      }
    };
  }, []); // eslint-disable-line

  // LATE CONTENT. A dialog that has to fetch its subject renders a spinner
  // first — the entry editor is up on screen a full network round trip before
  // it knows which entry it is editing — so the effect above ran against an
  // empty panel and parked focus on the panel itself. When the real first
  // control finally appears, take it: measured on the existing-entry editor,
  // focus was still sitting on the panel when the narrative field had been on
  // screen for half a second. Only while focus is STILL parked, though; never
  // out from under someone who has already started tabbing or typing.
  useEffect(() => {
    const panel = panelRef.current;
    if (!initialFocus || !panel || document.activeElement !== panel) return;
    const el = panel.querySelector(initialFocus);
    if (el && !el.disabled && !keyboardShy(el)) focusInPanel(el, panel);
  }, [initialFocus]);

  const cls = ['ovl-panel', size ? `ovl-${size}` : '', className].filter(Boolean).join(' ');

  return createPortal(html`
    <div class="ovl"
      onMouseDown=${(e) => {
        if (dismissible && e.target === e.currentTarget) closeRef.current('scrim');
      }}>
      <div ref=${panelRef} class=${cls} tabIndex=${-1}
        role="dialog" aria-modal="true" aria-label=${label || title || undefined}
        ...${panelAttrs || {}}>
        <div class="ovl-grip" aria-hidden="true"></div>
        ${title == null ? null : html`
          <div class="ovl-head">
            <h3 class="ovl-title">${title}</h3>
            <button type="button" class="btn btn-ghost btn-icon ovl-close" aria-label="Close"
              onClick=${() => closeRef.current('close')}><${Icon} name="x" size=${18} /></button>
          </div>`}
        <div class="ovl-body">${children}</div>
      </div>
    </div>`, document.body);
}

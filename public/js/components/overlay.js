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

// The open layers, oldest first. Module state on purpose: the background lock
// is a document-level fact, not a per-component one.
const stack = [];

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

// Everything behind the scrim. .shell holds the whole app (the day footer
// included, since it is rendered inside the dashboard view); .botnav is the
// phone navigation bar, which is a sibling of the shell.
const BACKGROUND = '.shell, .botnav';
const INERT_SUPPORTED = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;

// Where the page was when the first layer opened, so it can be put back.
let savedScrollY = 0;

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
  document.documentElement.classList.remove('tk-overlay-open');
  document.body.style.top = '';
  window.scrollTo(0, savedScrollY);
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

  useEffect(() => {
    const panel = panelRef.current;
    const opener = document.activeElement;
    const token = {};
    stack.push(token);
    if (stack.length === 1) lockBackground();

    // Initial focus. If a child already claimed it (React's autoFocus runs
    // during commit, before this effect) leave it alone — the client/matter
    // picker in the entry editor is the one control that matters there.
    if (!panel.contains(document.activeElement)) {
      const target = (initialFocus && panel.querySelector(initialFocus))
        || panel.querySelector('[data-autofocus]')
        || focusables(panel)[0]
        || panel;
      target.focus({ preventScroll: true });
    }

    const onKey = (e) => {
      if (stack[stack.length - 1] !== token) return; // a layer above us owns it
      if (e.key === 'Escape') {
        if (!dismissible) return;
        e.preventDefault();
        e.stopPropagation();
        closeRef.current('escape');
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables(panel);
      if (list.length === 0) { e.preventDefault(); panel.focus({ preventScroll: true }); return; }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
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

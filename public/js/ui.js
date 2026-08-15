// Shared UI toolkit: htm binding, hooks, formatting, and small widgets.
import htm from '/vendor/htm.module.js';
import { Icon } from '/js/icons.js';
import { Overlay } from '/js/components/overlay.js';

export const React = window.React;
export const html = htm.bind(React.createElement);
export const { useState, useEffect, useRef, useMemo, useCallback } = React;
export const { createPortal } = window.ReactDOM;
export { Icon };
// Re-exported so a dialog can reach the primitive through the same toolkit it
// already imports (and so nothing is tempted to hand-roll a fifth backdrop).
export { Overlay };

// ---------- events (toasts, undo) ----------

export function emitToast(message, opts = {}) {
  window.dispatchEvent(new CustomEvent('tk:toast', { detail: { message, ...opts } }));
}

// ---------- formatting ----------

export function fmtHours(h, increment = 0.1) {
  const s = String(increment);
  const decimals = s.includes('.') ? Math.max(1, s.length - s.indexOf('.') - 1) : 1;
  return Number(h || 0).toFixed(decimals);
}

export function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

const pad = (n) => String(n).padStart(2, '0');

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n, 12);
  return todayStr(dt);
}

export function fmtDateLong(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

// Full spelling for day-group headers ("Thursday, June 18, 2026").
export function fmtDateFull(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

export function fmtStamp(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// Display label for anything carrying client fields: prefer the client's
// name, fall back to the 6-digit client number (migrated clients start with
// blank names). Accepts matter/timer payloads ({ client_name, client_number })
// and /api/clients rows ({ name, client_number }). NOTE: when a `client_name`
// key exists it wins even when blank — never falls through to an unrelated
// `name` field (e.g. a timer's button name).
export function clientLabel(x) {
  if (!x) return '';
  const name = x.client_name !== undefined ? x.client_name : x.name;
  return name || x.client_number || '';
}

// ---------- hooks ----------

export function useAsync(fn, deps) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const reload = useCallback(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    Promise.resolve(fn()).then(
      (data) => alive && setState({ loading: false, data, error: null }),
      (error) => alive && setState({ loading: false, data: null, error }),
    );
    return () => { alive = false; };
  }, deps); // eslint-disable-line
  useEffect(() => reload(), deps); // eslint-disable-line
  return { ...state, reload };
}

export function useDebounced(fn, ms) {
  const timer = useRef(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const cancel = useCallback(() => clearTimeout(timer.current), []);
  const run = useCallback((...args) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => fnRef.current(...args), ms);
  }, [ms]);
  useEffect(() => cancel, [cancel]);
  return [run, cancel];
}

// ---------- widgets ----------

export function Spinner() {
  return html`<div class="spinner" aria-label="Loading"></div>`;
}

export function ErrorBox({ error }) {
  return html`<div class="error-box">${String(error && error.message || error)}</div>`;
}

export function BillableBadge({ billable }) {
  return billable
    ? html`<span class="badge badge-billable">billable</span>`
    : html`<span class="badge badge-nonbillable">non-billable</span>`;
}

// Fresh-finalize marker (spec §7 motion: the lock chip confirms a real
// finalize transition, never decorates a mere mount). Deliberately imperative
// module state, mirroring timergrid's just-started pattern: finalize call
// sites mark the entry id, and for a moment StatusChip renders the chip with
// .just-finalized so the lock animation fires once — then the mark expires
// and plain re-mounts of an already-finalized chip stay still.
const justFinalized = new Set();
export function markJustFinalized(id) {
  justFinalized.add(id);
  setTimeout(() => justFinalized.delete(id), 600);
}

export function StatusChip({ entry }) {
  if (entry.status === 'finalized') {
    const cls = 'chip chip-finalized' + (justFinalized.has(entry.id) ? ' just-finalized' : '');
    return html`<span class=${cls} title=${'Finalized ' + fmtStamp(entry.finalized_at)}>
      <${Icon} name="lock" size=${12} /> finalized</span>`;
  }
  return html`<span class="chip chip-draft">draft</span>`;
}

// Decimal-hours label for a live clock. Default mirrors the house rule: round
// UP to the next tenth, so the card shows exactly what a stop would file.
export function fmtTenths(seconds, mode = 'up') {
  const h = seconds / 3600;
  const t = mode === 'up' ? Math.ceil(h * 10 - 1e-9) / 10 : Math.round(h * 10) / 10;
  return Math.max(0, t).toFixed(1);
}

// The app's titled dialog. It is a thin wrapper over the shared Overlay
// primitive (public/js/components/overlay.js) — the portal, the scrim above
// the shell's fixed bars, the focus trap, aria-modal, Escape, the scroll lock
// and the phone bottom-sheet shape all live there, so every dialog in the app
// gets them from one place. `.modal` / `.modal-wide` stay on the panel: they
// are the hooks the e2e suite and a few feature modules select by.
export function Modal({ title, onClose, children, wide }) {
  return html`
    <${Overlay} title=${title} onClose=${() => onClose()}
      size=${wide ? 'lg' : 'md'} className=${'modal' + (wide ? ' modal-wide' : '')}>
      ${children}
    <//>`;
}

// Right-click menu at a fixed position. items: {label, icon?, onClick,
// disabled?, danger?, hr?, custom? (render fn — row supplies its own content)}
export function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('contextmenu', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('contextmenu', away);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);

  // keep the menu on-screen
  const style = {
    left: Math.min(x, window.innerWidth - 280) + 'px',
    top: Math.min(y, window.innerHeight - Math.min(items.length * 34 + 16, 480)) + 'px',
  };

  return createPortal(html`
    <div class="ctx-menu" ref=${ref} style=${style} role="menu">
      ${items.map((item, i) => {
        if (item.hr) return html`<div key=${i} class="ctx-hr"></div>`;
        if (item.custom) return html`<div key=${i} class="ctx-custom">${item.custom()}</div>`;
        return html`
          <button key=${i} class=${'ctx-item' + (item.danger ? ' danger' : '')}
            disabled=${item.disabled}
            onClick=${() => { onClose(); item.onClick(); }}>
            ${item.icon ? html`<${Icon} name=${item.icon} size=${16} />` : html`<span class="ctx-spacer"></span>`}
            <span>${item.label}</span>
          </button>`;
      })}
    </div>`, document.body);
}

// Even split helper mirroring the server's tenth allocation.
export function splitTenthsEvenly(total, n) {
  if (n <= 0) return [];
  const units = Math.max(0, Math.round(total * 10));
  const base = Math.floor(units / n);
  const extra = units - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i < extra ? 1 : 0)) / 10);
}

export function Confirm({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  return html`
    <${Modal} title=${title} onClose=${onClose}>
      <p class="confirm-message">${message}</p>
      <div class="row-end">
        <button class="btn" onClick=${onClose}>Cancel</button>
        <button class=${'btn ' + (danger ? 'btn-danger' : 'btn-primary')}
          onClick=${() => { onConfirm(); onClose(); }}>${confirmLabel}</button>
      </div>
    <//>`;
}

export function Field({ label, children, hint }) {
  return html`
    <label class="field">
      <span class="field-label">${label}</span>
      ${children}
      ${hint ? html`<span class="field-hint">${hint}</span>` : null}
    </label>`;
}

// Validation findings list for an entry.
export function ValidationList({ findings, compact }) {
  if (!findings || findings.length === 0) return null;
  return html`
    <div class=${'validation-list' + (compact ? ' compact' : '')}>
      ${findings.map((f) => html`
        <div key=${f.code + f.message} class=${'validation-item level-' + f.level}>
          <span class="validation-icon">${f.level === 'block' ? '⛔' : '⚠️'}</span>
          <span>${f.message}</span>
        </div>`)}
    </div>`;
}

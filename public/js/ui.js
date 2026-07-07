// Shared UI toolkit: htm binding, hooks, formatting, and small widgets.
import htm from '/vendor/htm.module.js';

export const React = window.React;
export const html = htm.bind(React.createElement);
export const { useState, useEffect, useRef, useMemo, useCallback } = React;

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
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
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

export function fmtStamp(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// Client mirror of the server's narrative generator, for live preview between autosaves.
export function previewNarrative(tasks, increment = 0.1) {
  const clean = (t) => String(t || '').trim().replace(/[.;\s]+$/, '');
  const subst = (tasks || [])
    .map((l) => ({ text: clean(l.fragment) || clean(l.task_code), duration: Number(l.duration) || 0 }))
    .filter((l) => l.text || l.duration > 0);
  if (subst.length < 2) return null;
  return subst.map((l, i) => {
    let text = l.text || 'Time';
    if (i === 0) text = text.charAt(0).toUpperCase() + text.slice(1);
    return `${text} (${fmtHours(l.duration, increment)})`;
  }).join('; ') + '.';
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

export function StatusChip({ entry }) {
  if (entry.status === 'finalized') {
    return html`<span class="chip chip-finalized" title=${'Finalized ' + fmtStamp(entry.finalized_at)}>🔒 finalized</span>`;
  }
  return html`<span class="chip chip-draft">draft</span>`;
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return html`
    <div class="modal-backdrop" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class=${'modal' + (wide ? ' modal-wide' : '')} role="dialog" aria-label=${title}>
        <div class="modal-head">
          <h3>${title}</h3>
          <button class="btn btn-ghost" onClick=${onClose} aria-label="Close">✕</button>
        </div>
        <div class="modal-body">${children}</div>
      </div>
    </div>`;
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

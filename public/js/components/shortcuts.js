import { api } from '/js/api.js';
import { html, useState, useEffect, emitToast } from '/js/ui.js';

// Text-expansion shortcut kit (spec §6). The dictionary is built IN-FLOW:
// select text in a narrative/fragment field → "save as shortcut". The
// Settings chip-management screen is deliberately paused — Settings only
// lists and deletes (ShortcutsCard in views/settings.js).

let cached = null; // module-level dictionary shared by every consumer

export async function refreshShortcuts() {
  cached = await api.get('/api/shortcuts');
  window.dispatchEvent(new CustomEvent('tk:shortcuts-changed'));
}

export function useShortcuts() {
  const [list, setList] = useState(cached || []);
  useEffect(() => {
    const sync = () => setList(cached || []);
    window.addEventListener('tk:shortcuts-changed', sync);
    if (cached == null) refreshShortcuts().catch(() => {});
    else sync();
    return () => window.removeEventListener('tk:shortcuts-changed', sync);
  }, []);
  return list;
}

// In-flow capture: appears when ≥3 chars are selected in a GhostInput
// (wired via its onSelectionChange). Inline — deliberately NOT a Modal, so
// Escape semantics inside the entry editor stay untouched.
export function SaveShortcutBar({ selection }) {
  const [open, setOpen] = useState(false);
  const [abbrev, setAbbrev] = useState('');
  const [error, setError] = useState(null);
  const phrase = String(selection || '').replace(/\s+/g, ' ').trim();
  useEffect(() => { setOpen(false); setAbbrev(''); setError(null); }, [phrase]);
  if (phrase.length < 3) return null;

  async function save() {
    try {
      await api.post('/api/shortcuts', { abbrev, phrase });
      await refreshShortcuts();
      emitToast(`Shortcut saved: ${abbrev} → ${phrase}`);
      setOpen(false);
    } catch (e) {
      setError(e.message);
    }
  }

  const label = phrase.length > 26 ? `${phrase.slice(0, 26)}…` : phrase;
  return html`
    <span class="shortcut-save" data-shortcut-save>
      ${open ? html`
        <input type="text" placeholder="abbreviation" value=${abbrev} autoFocus
          style=${{ width: '110px' }}
          onInput=${(e) => setAbbrev(e.target.value.replace(/\s/g, ''))}
          onKeyDown=${(e) => { if (e.key === 'Enter' && abbrev) { e.preventDefault(); save(); } }} />
        <button type="button" class="btn btn-sm btn-primary" disabled=${!abbrev} onClick=${save}>Save</button>
        <button type="button" class="btn btn-sm" onClick=${() => setOpen(false)}>Cancel</button>
        ${error ? html`<span class="small" style=${{ color: 'var(--status-critical)' }}>${error}</span>` : null}` : html`
        <button type="button" class="btn btn-sm" title=${`Save "${phrase}" as a text-expansion shortcut`}
          onClick=${() => setOpen(true)}>＋ shortcut: “${label}”</button>`}
    </span>`;
}

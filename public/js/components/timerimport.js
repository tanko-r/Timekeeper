import { api } from '/js/api.js';
import {
  html, useState, useCallback,
  Modal, Field, Spinner, ErrorBox, BillableBadge, emitToast,
} from '/js/ui.js';

// CSV → batch timer import. Read the file in the browser, ask the server to
// map columns and plan the import (dry run), let the user fix the mapping, then
// commit. The server re-plans on commit, so the preview is advisory only.

const FIELDS = [
  ['cm_number', 'CM Number'],
  ['client_name', 'Client Name'],
  ['matter_name', 'Matter Name'],
  ['group', 'Group'],
];

export function TimerImport({ onClose, onDone }) {
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState(null); // { headers, mapping, plan, counts }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const runPreview = useCallback(async (text, mapping) => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.post('/api/timers/import/preview', { csv: text, mapping }));
    } catch (e) {
      setError(e.message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const onFile = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      setCsv(text);
      runPreview(text);
    };
    reader.onerror = () => setError('Could not read that file.');
    reader.readAsText(file);
  }, [runPreview]);

  const setMap = (field, idx) => {
    const mapping = { ...preview.mapping, [field]: idx };
    setPreview({ ...preview, mapping });
    runPreview(csv, mapping);
  };

  const doImport = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/timers/import', { csv, mapping: preview.mapping });
      emitToast(`Imported ${r.created} timer${r.created === 1 ? '' : 's'}`
        + (r.skipped ? `, skipped ${r.skipped}.` : '.'));
      onDone();
    } catch (e) {
      emitToast(e.message, { error: true });
      setBusy(false);
    }
  }, [csv, preview, onDone]);

  return html`
    <${Modal} title="Import timers from CSV" onClose=${onClose} wide=${true}>
      ${!preview && !busy ? html`
        <p class="muted" style=${{ marginTop: 0 }}>
          Upload a CSV with columns for CM Number, Matter Name, and Group —
          plus, optionally, Client Name (fills in clients that don't have a
          name yet; never renames). New matters are created automatically;
          matters already in the system are skipped. Groups named for the firm
          are imported as non-billable.
        </p>
        <input type="file" accept=".csv,text/csv"
          onChange=${(e) => onFile(e.target.files && e.target.files[0])} />
        ${error ? html`<${ErrorBox} error=${{ message: error }} />` : null}
      ` : null}

      ${preview ? html`
        <div class="import-map">
          ${FIELDS.map(([field, label]) => html`
            <${Field} key=${field} label=${label}>
              <select value=${preview.mapping[field]}
                onChange=${(e) => setMap(field, Number(e.target.value))}>
                <option value=${-1}>— none —</option>
                ${preview.headers.map((h, i) => html`
                  <option key=${i} value=${i}>${h || `Column ${i + 1}`}</option>`)}
              </select>
            <//>`)}
        </div>

        <p class="import-summary">
          <strong>${preview.counts.create}</strong> new ·
          <strong>${preview.counts.skip}</strong> skipped
        </p>

        <div class="table-wrap" style=${{ maxHeight: '340px', overflowY: 'auto' }}>
          <table class="tk">
            <thead><tr>
              <th>Row</th><th>CM Number</th><th>Client</th><th>Matter Name</th>
              <th>Group</th><th>Billing</th><th>Status</th>
            </tr></thead>
            <tbody>
              ${preview.plan.map((p) => html`
                <tr key=${p.rowNum} class=${p.action === 'skip' ? 'import-skip' : ''}>
                  <td>${p.rowNum}</td>
                  <td>${p.cm_number}</td>
                  <td>${p.client_name}</td>
                  <td>${p.matter_name}</td>
                  <td>${p.group}</td>
                  <td>${p.action === 'create' ? html`<${BillableBadge} billable=${p.billable} />` : ''}</td>
                  <td>${p.action === 'create'
                    ? html`<span class="import-new">New</span>`
                    : html`<span class="muted">${p.reason}</span>`}</td>
                </tr>`)}
            </tbody>
          </table>
        </div>
        ${error ? html`<${ErrorBox} error=${{ message: error }} />` : null}

        <div class="row-end">
          <button class="btn" onClick=${onClose}>Cancel</button>
          <button class="btn btn-primary"
            disabled=${busy || preview.counts.create === 0}
            onClick=${doImport}>
            Import ${preview.counts.create} timer${preview.counts.create === 1 ? '' : 's'}
          </button>
        </div>
      ` : null}

      ${busy && !preview ? html`<${Spinner} />` : null}
    <//>`;
}

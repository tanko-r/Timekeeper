import { api } from '/js/api.js';
import { html, useState, useEffect, Field, emitToast } from '/js/ui.js';

export function SettingsView({ settings, reloadSettings, authState, reloadAuth }) {
  return html`
    <div class="page-head"><h1>Settings</h1></div>
    <div class="grid" style=${{ maxWidth: '760px' }}>
      <${GeneralCard} settings=${settings} reloadSettings=${reloadSettings} />
      <${TaskCodesCard} />
      <${ValidationCard} settings=${settings} reloadSettings=${reloadSettings} />
      <${RemoteCard} authState=${authState} reloadAuth=${reloadAuth} />
      <${BackupCard} settings=${settings} reloadSettings=${reloadSettings} />
    </div>`;
}

// Small helper: PATCH one settings key (merged server-side) and confirm.
async function save(patch, reloadSettings) {
  await api.patch('/api/settings', patch);
  await reloadSettings();
  emitToast('Saved');
}

function GeneralCard({ settings, reloadSettings }) {
  const s = settings;
  return html`
    <div class="card">
      <h2>General</h2>
      <div class="grid" style=${{ gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <${Field} label="Theme">
          <select value=${s.theme || 'auto'} onChange=${(e) => save({ theme: e.target.value }, reloadSettings)}>
            <option value="auto">Follow system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        <//>
        <${Field} label="Daily target (hours)" hint="Colors the calendar and dashboard meter">
          <input type="number" min="0" step="0.5" defaultValue=${s.targets?.dailyHours ?? 8}
            onBlur=${(e) => save({ targets: { dailyHours: Number(e.target.value) || 0 } }, reloadSettings)} />
        <//>
        <${Field} label="When a timer stops" hint="Where the time lands">
          <select value=${s.timerStopAction} onChange=${(e) => save({ timerStopAction: e.target.value }, reloadSettings)}>
            <option value="ask">Ask me each time</option>
            <option value="new">Always create a new entry</option>
            <option value="append">Append to today’s draft for that CM</option>
          </select>
        <//>
        <${Field} label="Idle timer nudge (hours)" hint="Flag a running timer after this long">
          <input type="number" min="0.5" step="0.5" defaultValue=${s.idleNudgeHours ?? 3}
            onBlur=${(e) => save({ idleNudgeHours: Number(e.target.value) || 3 }, reloadSettings)} />
        <//>
        <${Field} label="Rounding">
          <select value=${s.rounding?.enabled ? s.rounding.mode : 'off'}
            onChange=${(e) => {
              const v = e.target.value;
              save({ rounding: v === 'off' ? { enabled: false } : { enabled: true, mode: v } }, reloadSettings);
            }}>
            <option value="nearest">Round timers to nearest increment</option>
            <option value="up">Always round timers up</option>
            <option value="off">No rounding (raw hours)</option>
          </select>
        <//>
        <${Field} label="Increment (hours)" hint="0.1 = 6-minute units">
          <input type="number" min="0.01" step="0.01" defaultValue=${s.rounding?.increment ?? 0.1}
            onBlur=${(e) => save({ rounding: { increment: Number(e.target.value) || 0.1 } }, reloadSettings)} />
        <//>
      </div>
    </div>`;
}

function TaskCodesCard() {
  const [codes, setCodes] = useState(null);
  const [newName, setNewName] = useState('');

  const reload = () => api.get('/api/task-codes?includeInactive=1').then(setCodes);
  useEffect(() => { reload(); }, []);

  async function add(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      await api.post('/api/task-codes', { name: newName.trim() });
      setNewName('');
      await reload();
    } catch (err) { emitToast(err.message, { error: true }); }
  }

  async function move(i, dir) {
    const ids = codes.map((c) => c.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api.put('/api/task-codes/order', { ids });
    await reload();
  }

  if (!codes) return html`<div class="card"><h2>Task codes</h2></div>`;
  return html`
    <div class="card">
      <h2>Task codes</h2>
      <p class="muted small">Used in task lines and timers. Renaming or removing a code never rewrites past entries.</p>
      <div class="grid" style=${{ gap: '6px' }}>
        ${codes.map((c, i) => html`
          <div key=${c.id} class="row" style=${{ flexWrap: 'nowrap' }}>
            <div class="reorder" style=${{ display: 'flex', flexDirection: 'column' }}>
              <button class="btn btn-ghost btn-sm" style=${{ padding: '0 6px' }} onClick=${() => move(i, -1)}>▲</button>
              <button class="btn btn-ghost btn-sm" style=${{ padding: '0 6px' }} onClick=${() => move(i, 1)}>▼</button>
            </div>
            <input type="text" defaultValue=${c.name} style=${{ opacity: c.active ? 1 : 0.5 }}
              onBlur=${async (e) => {
                if (e.target.value.trim() && e.target.value !== c.name) {
                  try { await api.patch(`/api/task-codes/${c.id}`, { name: e.target.value.trim() }); await reload(); }
                  catch (err) { emitToast(err.message, { error: true }); e.target.value = c.name; }
                }
              }} />
            <button class="btn btn-sm" title=${c.active ? 'Hide from pickers' : 'Reactivate'}
              onClick=${async () => { await api.patch(`/api/task-codes/${c.id}`, { active: c.active ? 0 : 1 }); await reload(); }}>
              ${c.active ? 'Active' : 'Hidden'}
            </button>
            <button class="btn btn-ghost btn-sm" title="Delete"
              onClick=${async () => {
                try { await api.del(`/api/task-codes/${c.id}`); await reload(); }
                catch (err) { emitToast(err.message, { error: true }); }
              }}>🗑</button>
          </div>`)}
      </div>
      <form class="row" style=${{ marginTop: '10px' }} onSubmit=${add}>
        <input type="text" placeholder="New task code…" value=${newName} onInput=${(e) => setNewName(e.target.value)} />
        <button class="btn">Add</button>
      </form>
    </div>`;
}

function ValidationCard({ settings, reloadSettings }) {
  const v = settings.validation;
  const [phrase, setPhrase] = useState('');

  async function addPhrase(e) {
    e.preventDefault();
    const p = phrase.trim().toLowerCase();
    if (!p) return;
    await save({ validation: { bannedPhrases: [...v.bannedPhrases, p] } }, reloadSettings);
    setPhrase('');
  }

  return html`
    <div class="card">
      <h2>Narrative validation</h2>
      <div class="grid" style=${{ gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
        <${Field} label="Min narrative length" hint="warn under N characters">
          <input type="number" min="0" defaultValue=${v.minNarrativeChars}
            onBlur=${(e) => save({ validation: { minNarrativeChars: Number(e.target.value) || 0 } }, reloadSettings)} />
        <//>
        <${Field} label="Block-billing threshold" hint="warn on a single line over N hours">
          <input type="number" min="0.5" step="0.5" defaultValue=${v.blockBillingHours}
            onBlur=${(e) => save({ validation: { blockBillingHours: Number(e.target.value) || 3 } }, reloadSettings)} />
        <//>
        <${Field} label="Minimum increment" hint="warn on durations under this">
          <input type="number" min="0.01" step="0.01" defaultValue=${v.minIncrement}
            onBlur=${(e) => save({ validation: { minIncrement: Number(e.target.value) || 0.1 } }, reloadSettings)} />
        <//>
      </div>
      <${Field} label="Banned vague phrases" hint="warned when a narrative contains one">
        <div>
          ${v.bannedPhrases.map((p) => html`
            <span key=${p} class="banned-chip">${p}
              <button title="Remove" onClick=${() => save({
                validation: { bannedPhrases: v.bannedPhrases.filter((x) => x !== p) },
              }, reloadSettings)}>✕</button>
            </span>`)}
        </div>
      <//>
      <form class="row" onSubmit=${addPhrase}>
        <input type="text" placeholder="Add phrase, e.g. “misc work”…" value=${phrase}
          onInput=${(e) => setPhrase(e.target.value)} />
        <button class="btn">Add</button>
      </form>
    </div>`;
}

function RemoteCard({ authState, reloadAuth }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [mode, setMode] = useState(null);
  const [status, setStatus] = useState(null);

  const reload = () => api.get('/api/auth/status').then(setStatus);
  useEffect(() => { reload(); }, []);

  const st = status || authState;

  async function setPassword(e) {
    e.preventDefault();
    try {
      await api.post('/api/auth/password', { current: current || undefined, next });
      setCurrent(''); setNext('');
      emitToast(st.passwordSet ? 'Password changed — other sessions signed out.' : 'Password set — remote access enabled.');
      await reload();
      await reloadAuth();
    } catch (err) {
      emitToast(err.status === 401 ? 'Current password is wrong.' : err.message, { error: true });
    }
  }

  async function saveMode(m) {
    setMode(m);
    await api.post('/api/auth/mode', { mode: m });
    emitToast('Saved');
    await reload();
  }

  return html`
    <div class="card">
      <h2>Remote access</h2>
      <p class="muted small">
        Reachable at <a href="https://time.example.com" target="_blank">time.example.com</a>
        through the Cloudflare tunnel. Remote requests require the app password; home-network
        (LAN) use never asks by default.
      </p>
      <div class="row">
        <span class=${'chip ' + (st.passwordSet ? 'chip-finalized' : '')}>
          ${st.passwordSet ? '🔐 password set' : '⚠️ no password — remote disabled'}
        </span>
        <span class="chip">${st.sessionCount ?? 0} active session${(st.sessionCount ?? 0) === 1 ? '' : 's'}</span>
        <button class="btn btn-sm" onClick=${async () => {
          await api.post('/api/auth/sessions/revoke');
          emitToast('All sessions revoked');
          await reload();
        }}>Sign out everywhere</button>
      </div>
      <form class="grid" style=${{ gridTemplateColumns: '1fr 1fr auto', gap: '10px', alignItems: 'end', marginTop: '10px' }}
        onSubmit=${setPassword}>
        ${st.passwordSet ? html`
          <${Field} label="Current password">
            <input type="password" value=${current} onInput=${(e) => setCurrent(e.target.value)} />
          <//>` : html`<div></div>`}
        <${Field} label=${st.passwordSet ? 'New password' : 'Set a password (8+ chars)'}>
          <input type="password" value=${next} onInput=${(e) => setNext(e.target.value)} />
        <//>
        <button class="btn btn-primary" disabled=${next.length < 8}>
          ${st.passwordSet ? 'Change' : 'Enable remote'}
        </button>
      </form>
      <${Field} label="Require login"
        hint=${st.passwordSet ? null : '"Always" unlocks once a password is set'}>
        <select value=${mode ?? st.mode} onChange=${(e) => saveMode(e.target.value)}>
          <option value="remote-only">Remote connections only (recommended)</option>
          <option value="always" disabled=${!st.passwordSet}>Always, including LAN</option>
          <option value="off">Never (LAN-only use!)</option>
        </select>
      <//>
    </div>`;
}

function BackupCard({ settings, reloadSettings }) {
  const [backups, setBackups] = useState([]);
  useEffect(() => { api.get('/api/backup/list').then(setBackups).catch(() => {}); }, []);

  return html`
    <div class="card">
      <h2>Backups</h2>
      <p class="muted small">
        A snapshot of the database is written nightly to <code>data/backups/</code> and pruned to the
        most recent ${settings.backup?.keep ?? 14}.
      </p>
      <div class="row">
        <a class="btn" href="/api/backup/db">⬇ Download database (.db)</a>
        <a class="btn" href="/api/backup/json">⬇ Download JSON dump</a>
        <${Field} label="Keep N nightly backups">
          <input type="number" min="1" style=${{ width: '90px' }} defaultValue=${settings.backup?.keep ?? 14}
            onBlur=${(e) => save({ backup: { keep: Number(e.target.value) || 14 } }, reloadSettings)} />
        <//>
      </div>
      ${backups.length > 0 ? html`
        <p class="muted small" style=${{ marginBottom: 0 }}>
          On disk: ${backups.slice(0, 3).map((b) => b.name).join(', ')}${backups.length > 3 ? ` … +${backups.length - 3} more` : ''}
        </p>` : null}
    </div>`;
}

import { api } from '/js/api.js';
import { html, useState, Field } from '/js/ui.js';

export function LoginView({ passwordSet, onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { password });
      await onLogin();
    } catch (err) {
      setError(err.status === 429
        ? 'Too many failed attempts — wait 15 minutes.'
        : 'Wrong password.');
    } finally {
      setBusy(false);
    }
  }

  if (!passwordSet) {
    return html`
      <div class="login-wrap"><div class="card login-card">
        <div class="brand">⏱ Time<span>keeper</span></div>
        <p>Remote access is disabled until a password is set.</p>
        <p class="muted small">Open Timekeeper from your home network and set one under
          Settings → Remote access.</p>
      </div></div>`;
  }

  return html`
    <div class="login-wrap"><div class="card login-card">
      <div class="brand">⏱ Time<span>keeper</span></div>
      <p class="muted small">You’re connecting remotely — enter your app password.</p>
      <form onSubmit=${submit}>
        <${Field} label="Password">
          <input type="password" value=${password} autoFocus
            onInput=${(e) => setPassword(e.target.value)} />
        <//>
        ${error ? html`<p class="error-box">${error}</p>` : null}
        <div class="row-end">
          <button class="btn btn-primary btn-lg" disabled=${busy || !password}>Sign in</button>
        </div>
      </form>
    </div></div>`;
}

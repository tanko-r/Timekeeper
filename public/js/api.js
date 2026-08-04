// Thin JSON API client. 401s flip the app into the login screen via an event.
// Errors reject with ApiError; handlers that don't catch are backstopped by
// the global unhandledrejection → toast bridge in app.js.

export class ApiError extends Error {
  constructor(status, body) {
    super((body && (body.message || body.error)) || `HTTP ${status}`);
    this.status = status;
    this.body = body || {};
  }
}

// Cross-surface sync: the timer grid, entry cards, and the PiP float all
// mutate through this client, so a successful write is announced as a window
// event and every surface refreshes instantly — no waiting out a 5s poll
// (which Chrome throttles hard in a tab hidden behind other windows, exactly
// when the float is in use). Pure — unit-tested in test/apisync.test.js.
// `body` is the response payload: an entry write reports timers_synced when it
// re-based a timer's day clock (2026-07-24 feedback), which the timer surfaces
// have to hear about as well.
export function changeEventsFor(method, path, body) {
  if (method === 'GET') return [];
  if (/^\/api\/timers(\/|$)/.test(path)) return ['tk:timers-changed'];
  if (/^\/api\/entries(\/|$)/.test(path)) {
    return (body && body.timers_synced && body.timers_synced.length)
      ? ['tk:entries-changed', 'tk:timers-changed']
      : ['tk:entries-changed'];
  }
  return [];
}

// Remotely, Cloudflare Access fronts time.*. Once its session lapses it
// answers every request with a 302 to tanko-r.cloudflareaccess.com — another
// origin, which fetch() can't follow, so the call rejects with TypeError
// "Failed to fetch" and the app reports a server outage while the server is
// fine (2026-08-02; hit again on mobile 2026-08-03). Measured against the live
// tunnel: Access returns a plain 401 instead of the redirect when the request
// says it's XHR. A same-origin 401 is a response we can read and act on.
// Same-origin requests never preflight, so this custom header costs nothing.
export function apiHeaders(body) {
  const h = { 'X-Requested-With': 'XMLHttpRequest' };
  if (body !== undefined) h['content-type'] = 'application/json';
  return h;
}

// Distinguishes "Cloudflare says sign in again" (HTML 401 + a Cloudflare-Access
// challenge) from the app's own 401, which means the app password.
export function isAccessChallenge(status, headers) {
  if (status !== 401 || !headers || typeof headers.get !== 'function') return false;
  return /^Cloudflare-Access\b/i.test(headers.get('www-authenticate') || '');
}

// Where "Sign in again" goes. NOT location.reload(): a cache-first service
// worker answers the same URL from cache, so the Access redirect never fires
// and the button does nothing — which is precisely how the installed PWA
// deadlocked (the old worker served the shell forever, and it could never
// update out of it because a script fetch fails outright on a redirect). A URL
// that was never cached always misses and falls through to the network. Hash
// routing ignores the query, so the app reopens on the same route.
export function accessSignInUrl(now, hash) {
  return `/?cf=${now}${hash || ''}`;
}

function throwIfAccessExpired(res) {
  if (!isAccessChallenge(res.status, res.headers)) return;
  window.dispatchEvent(new CustomEvent('tk:access-expired'));
  const err = new ApiError(401, { error: 'access_expired' });
  err.accessExpired = true;
  throw err;
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: apiHeaders(body),
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  throwIfAccessExpired(res);
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('tk:auth-required'));
    throw new ApiError(res.status, json);
  }
  if (!res.ok) throw new ApiError(res.status, json);
  for (const ev of changeEventsFor(method, path, json)) window.dispatchEvent(new CustomEvent(ev));
  return json;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
};

// Streaming POST for NDJSON endpoints (/api/ai/narrate): calls onLine(obj)
// per line as tokens arrive. Non-2xx rejects with ApiError before any line
// is delivered (the server only streams after committing to 200). An
// optional AbortSignal cancels mid-stream (rejects with AbortError) — the
// server aborts its Ollama fetch on disconnect, so this stops generation.
export async function streamNdjson(path, body, onLine, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: apiHeaders(body),
    body: JSON.stringify(body),
    credentials: 'same-origin',
    signal,
  });
  throwIfAccessExpired(res);
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('tk:auth-required'));
    throw new ApiError(401, null);
  }
  if (!res.ok) {
    let json = null;
    try { json = await res.json(); } catch { /* keep null */ }
    throw new ApiError(res.status, json);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onLine(JSON.parse(line));
      }
    }
  } finally {
    // onLine can throw (e.g. a mid-stream {"error":"ai_stream_failed"} line);
    // cancel so the reader/underlying connection doesn't linger open.
    reader.cancel().catch(() => {});
  }
}

export function downloadText(filename, text, mime = 'text/csv') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

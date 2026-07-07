import { randomUUID } from 'node:crypto';

// DTE Axiom / Intapp TimeSaver .TIM export — field set and order copied
// verbatim from David's working prototype (legal-timekeeper-pro). One line per
// entry, pipe-delimited key=value pairs.

function two(n) {
  return String(n).padStart(2, '0');
}

// "7/6/2026 9:14:30 PM" in server-local time.
function fmtStamp(date) {
  let h = date.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()} ` +
    `${h}:${two(date.getMinutes())}:${two(date.getSeconds())} ${ampm}`;
}

// Work date: the entry's date at midnight, formatted without TZ conversion.
function fmtWorkDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}/${y} 12:00:00 AM`;
}

function sanitize(text) {
  return String(text || '').replace(/\|/g, '/').replace(/[\r\n]+/g, ' ');
}

export function formatTimEntries(entries, cfg, opts = {}) {
  const rng = opts.rng || Math.random;
  const uuid = opts.uuid || randomUUID;
  const fallbackWhen = opts.now ? new Date(opts.now) : new Date();

  return entries.map((e) => {
    const when = e.finalized_at ? new Date(e.finalized_at) : fallbackWhen;
    const stamp = fmtStamp(when);
    const fields = {
      am: String(Math.round((Number(e.total) || 0) * 3600)),
      ar: String(Math.floor(300000000 + rng() * 90000000)),
      billed: 'N',
      billing: 'N',
      cl: e.cm.cm_number.slice(0, 6),
      closed: 'N',
      co: 'N',
      createdintimesaver: 'Y',
      del: 'N',
      ed: stamp,
      ex: 'N',
      f: 'TIME',
      lmb: cfg.email || '',
      ma: e.cm.cm_number,
      md: stamp,
      na: sanitize(e.narrative),
      op: cfg.email || '',
      originapplication: 'DTE Axiom',
      re: 'N',
      ref: String(uuid()),
      releasable: 'Y',
      shortref: String(Math.floor(7000000 + rng() * 900000)),
      ss: rng().toString(36).substring(2, 15) + rng().toString(36).substring(2, 15),
      st: 'Ready to be closed',
      tk: cfg.timekeeperId || '',
      u2: cfg.u2 || '',
      unconver: 'N',
      version: '9.10.39.5',
      wd: fmtWorkDate(e.date),
    };
    return Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('|');
  }).join('\n');
}

import { createHash, randomUUID } from 'node:crypto';

// DTE Axiom / Intapp TimeSaver .TIM export — field set and order copied
// verbatim from David's working prototype (legal-timekeeper-pro). One line per
// entry, pipe-delimited key=value pairs.

function two(n) {
  return String(n).padStart(2, '0');
}

// "07/06/2026 9:14:30 PM" in server-local time. Month/day are zero-padded:
// verified against Intapp's real importer 2026-07-10 — it silently ignores an
// unpadded work date and files the entry on whatever day is open on screen.
function fmtStamp(date) {
  let h = date.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${two(date.getMonth() + 1)}/${two(date.getDate())}/${date.getFullYear()} ` +
    `${h}:${two(date.getMinutes())}:${two(date.getSeconds())} ${ampm}`;
}

// Work date: the entry's date at midnight, formatted without TZ conversion.
function fmtWorkDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${m}/${d}/${y} 12:00:00 AM`;
}

function sanitize(text) {
  return String(text || '').replace(/\|/g, '/').replace(/[\r\n]+/g, ' ');
}

// The four per-line identifiers (ref, shortref, ss, ar) are the only fields a
// receiving system could use to recognise a second copy of one entry. Minted
// fresh per render they identify nothing: the same hour exported twice imports
// as two billable entries and the client pays for it twice. Derived from the
// entry's stored tim_ref they are stable for the life of the entry, so a
// re-export is recognisably the same work. SHA-256 only for a stable spread —
// nothing here is a secret.
function identityFrom(ref) {
  const h = createHash('sha256').update(`tim:${ref}`).digest();
  return {
    ref: String(ref),
    ar: String(300000000 + (h.readUInt32BE(0) % 90000000)),
    shortref: String(7000000 + (h.readUInt32BE(4) % 900000)),
    ss: h.toString('hex').slice(8, 34), // 26 chars, same shape as the old pair
  };
}

export function formatTimEntries(entries, cfg, opts = {}) {
  const rng = opts.rng || Math.random;
  const uuid = opts.uuid || randomUUID;
  const fallbackWhen = opts.now ? new Date(opts.now) : new Date();

  return entries.map((e) => {
    const when = e.finalized_at ? new Date(e.finalized_at) : fallbackWhen;
    const stamp = fmtStamp(when);
    // An entry with no tim_ref yet (a caller that never persisted one, and the
    // injected-randomness path the unit tests drive) falls back to the old
    // per-render values.
    const ident = e.tim_ref ? identityFrom(e.tim_ref) : {
      ar: String(Math.floor(300000000 + rng() * 90000000)),
      ref: String(uuid()),
      shortref: String(Math.floor(7000000 + rng() * 900000)),
      ss: rng().toString(36).substring(2, 15) + rng().toString(36).substring(2, 15),
    };
    const fields = {
      am: String(Math.round((Number(e.total) || 0) * 3600)),
      ar: ident.ar,
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
      ref: ident.ref,
      releasable: 'Y',
      shortref: ident.shortref,
      ss: ident.ss,
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

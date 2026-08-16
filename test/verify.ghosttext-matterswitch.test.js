// ===========================================================================
// DATA-INTEGRITY PROOF — the ghost-text phrase list survives a matter change,
// so one client's billing sentence completes, and Tab-writes, into another
// client's entry.
//
// READ THIS BEFORE "FIXING" A RED RUN. Both tests here are PROOFS OF A DEFECT.
// They are written to FAIL while the defect is present and to pass once it is
// fixed. A red result is the finding. Do not delete the assertion, do not
// relax it, and do not make it pass by changing the test.
//
// The standard is docs/ui/BRIEF.md, "Data integrity: non-negotiable":
//
//   "A narrative written for matter A may never be shown as belonging to,
//    suggested for, pre-filled into, or written onto an entry for matter B.
//    Not across clients, and not between two matters of the SAME client."
//
// WHAT IS *NOT* BEING CLAIMED. Ghost text as a mechanism is shared by design
// and is not a defect; neither is the phrasebook nor text expansion. The brief
// is explicit that reusable wording is shared. The string this file tracks is
// a whole client-facing sentence naming a street, a document and a legal
// argument — squarely on the other side of that line — and it appears under a
// DIFFERENT CLIENT, so the server's own sibling-blending (matterSuggestions'
// THIN_PHRASES borrow, which only ever reaches inside one client) cannot be
// its source. Test 0 asserts that, so a red run here can never be blamed on it.
//
// THE DEFECT
//   public/js/components/ghosttext.js:14-38
//
//     export function useMatterSuggestions(cmId) {
//       const [phrases, setPhrases] = useState([]);
//       useEffect(() => {
//         if (!cmId) { setPhrases([]); return undefined; }
//         const hit = cache.get(cmId);
//         if (hit && hit.phrases.length > 0 && …) { setPhrases(hit.phrases); … }
//         let alive = true;
//         api.get(`/api/matters/${cmId}/suggestions`)
//           .then((r) => { … if (alive) setPhrases(texts); })
//   …
//   `setPhrases` is reached only on a falsy cmId, on a cache hit, or inside the
//   promise. On a change from matter A to an uncached matter B, `phrases` keeps
//   A's sentences for the whole round trip. entryeditor.js:156 re-reads
//   `local?.cm?.id` live and feeds the result to the narrative box (:783) and
//   to every task-fragment field (:919), all of which stay mounted across the
//   change — so during that round trip the completion pool belongs to the
//   matter the entry NO LONGER points at.
//
// MEASURED (this machine, real server, real shipped UI in headless Chromium;
// two matters under two different clients; typed the two characters "Re",
// which matches Acme's sentence and none of Verity's six own phrases):
//
//   link              /suggestions in flight   first keystroke   result
//   localhost          +5ms → +25ms             +89ms            clean
//   120ms RTT          +2ms → +174ms            +296ms           clean
//   300ms RTT          +3ms → +692ms            +332ms           LEAK
//   300ms RTT          +5ms → +642ms            +677ms           LEAK
//   300ms RTT          +4ms → +733ms            +1251ms          clean
//
//   The window is exactly the request. It is ~20ms on the LAN, where no human
//   keystroke can land inside it, and ~700ms over a 300ms round trip — the
//   remote cloudflared path and the phone PWA — where an ordinary beat between
//   clicking a matter and typing lands inside it every time.
//
// AND THE PART THAT MAKES IT MATTER: once the grey completion is painted it
// NEVER EXPIRES. GhostInput recomputes `ghost` only on input, select and blur;
// nothing recomputes it when `suggestions` changes underneath. Measured: with
// the completion on screen, four seconds after the correct list had arrived,
// Tab still accepted the stale sentence. So the race is only to get the ghost
// painted; after that it sits there waiting for Tab. Verified end to end — the
// entry's stored narrative became Acme Holdings' sentence under Verity Health.
//
// THE FIX is two lines, not one:
//   1. clear on the change itself — `setPhrases([])` before the fetch (the
//      correctly-keyed 60s cache repopulates a revisit synchronously, so this
//      costs nothing on the common path); and
//   2. drop a painted completion when its pool changes — in GhostInput,
//      `useEffect(() => setGhost(null), [suggestions])`, so a completion can
//      never outlive the list it came from.
//
// Set TK_SKIP_UI_PROOF=1 to skip (the same switch integrity.stalestate.test.js
// uses) — e.g. while a screenshot run already owns the cores.
// ===========================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SKIP = process.env.TK_SKIP_UI_PROOF === '1';

// House fictional names only (BRIEF: no real client/matter data in the repo).
// A whole billing sentence: a street, a document, a legal argument.
const ACME_NARRATIVE =
  'Review the Harbor Street lease termination notice and analyze the landlord\'s cure period argument';
// Verity's own history — six phrases, so it is nowhere near "thin" and borrows
// nothing, and not one of them begins with "Re". So a "Re" completion under
// Verity can only have come from Acme.
const VERITY_PHRASES = [
  'Draft the payer audit response letter',
  'Telephone conference with the compliance director',
  'Assemble the sampled claims index',
  'Outline the appeal timeline',
  'Summarize the coding guidance for the physician group',
  'Prepare the rebuttal exhibit list',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayLocal = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1)
  .padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------------------------------------------------------------------------
// One server + one browser for the file.
// ---------------------------------------------------------------------------
let ui = null;

async function bootUi() {
  if (ui) return ui;
  process.env.TZ = process.env.TZ || 'America/Los_Angeles';
  const { openDb } = await import('../server/db.js');
  const { createApp } = await import('../server/app.js');
  const puppeteer = (await import('puppeteer-core')).default;

  const dir = mkdtempSync(join(tmpdir(), 'tk-ghostswitch-'));
  const db = openDb(join(dir, 'ui.db'));
  const app = createApp({ db, config: { DATA_DIR: dir, TRUST_LAN: true }, clock: () => new Date() });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    assert.ok(res.ok, `${method} ${path} -> ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  // Two matters under two DIFFERENT clients — the widest possible boundary.
  const today = todayLocal();
  const acme = await api('POST', '/api/cms', {
    cm_number: '100001-000012', short_name: 'Acme lease dispute', client_name: 'Acme Holdings', billable: 1,
  });
  const verity = await api('POST', '/api/cms', {
    cm_number: '100333-000004', short_name: 'Verity payer audit', client_name: 'Verity Health', billable: 1,
  });
  await api('POST', '/api/entries', {
    date: today, cm_id: acme.id, narrative: ACME_NARRATIVE,
    tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
  });
  for (const n of VERITY_PHRASES) {
    // eslint-disable-next-line no-await-in-loop
    await api('POST', '/api/entries', {
      date: today, cm_id: verity.id, narrative: n,
      tasks: [{ task_code: 'Draft', duration: 0.2, fragment: '' }],
    });
  }
  // One blank Acme entry per test — the record the lawyer opens and re-points.
  const work = [];
  for (let i = 0; i < 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    work.push(await api('POST', '/api/entries', {
      date: today, cm_id: acme.id, narrative: '',
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
    }));
  }

  ui = {
    base,
    api,
    db,
    browser,
    today,
    acme,
    verity,
    work,
    close: async () => {
      await browser.close();
      await new Promise((r) => server.close(r));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return ui;
}

after(async () => { if (ui) await ui.close(); });

// A launch failure is an environment problem, not a finding.
async function bootOrSkip(t) {
  try {
    return await bootUi();
  } catch (e) {
    t.skip(`could not boot headless Chromium (/usr/bin/chromium): ${e.message}`);
    return null;
  }
}

// --- driving the real UI ---------------------------------------------------

// A real reload before each test: fresh module instances, so ghosttext.js's
// module-level phrase cache is empty. That is the state a lawyer's tab is in
// the first time he touches a matter in a session — and a cached matter is
// exactly the case that does NOT leak, because a cache hit sets the list
// synchronously inside the effect.
async function freshEditor(u, page, entryId) {
  await page.goto(`${u.base}/#/day/${u.today}`, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(700);
  await page.waitForSelector('.entry-card .entry-open', { timeout: 15_000 });
  const opened = await page.evaluate((id) => {
    const card = [...document.querySelectorAll('.entry-card')]
      .find((c) => c.getAttribute('data-entry-id') === String(id));
    const btn = card && card.querySelector('.entry-open');
    if (!btn) return false;
    btn.click();
    return true;
  }, entryId);
  assert.ok(opened, `could not open the editor for entry ${entryId}`);
  await page.waitForSelector('.narrative-preview textarea', { timeout: 15_000 });
  await sleep(400);
}

const readGhost = (page) => page.evaluate(() => ({
  hint: document.querySelector('.narrative-preview .ghost-hint')?.textContent ?? null,
  field: document.querySelector('.narrative-preview textarea')?.value ?? null,
  matter: document.querySelector('.ed-row-matter .cm-value-name')?.textContent ?? null,
}));

async function typeRe(page) {
  await page.focus('.narrative-preview textarea');
  await page.keyboard.type('Re', { delay: 10 });
}

async function clearNarrative(page) {
  await page.focus('.narrative-preview textarea');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await sleep(200);
}

// The ordinary correction: open the matter row's picker, search, pick. The row
// selects on mousedown, which is what a click does.
async function pickVerity(page) {
  await page.click('.ed-row-matter .cm-value');
  await page.waitForSelector('.cmpicker input[type=search]', { timeout: 8000 });
  await page.click('.cmpicker input[type=search]');
  await page.keyboard.type('Verity payer', { delay: 8 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.cmpicker-item')].some((i) => /Verity payer/.test(i.textContent)),
    { timeout: 10_000 },
  );
  await page.evaluate(() => {
    [...document.querySelectorAll('.cmpicker-item')]
      .find((i) => /Verity payer/.test(i.textContent))
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
}

// ===========================================================================
// 0 — the server is clean, so nothing below can be pinned on it.
// ===========================================================================
test('sanity: the server never offers Verity Health anything of Acme Holdings\'',
  { skip: SKIP }, async (t) => {
    const u = await bootOrSkip(t);
    if (!u) return;
    const sug = await u.api('GET', `/api/matters/${u.verity.id}/suggestions`);
    assert.equal(sug.borrowed, false, 'Verity has its own history; nothing is borrowed');
    assert.equal(
      sug.phrases.some((p) => /harbor/i.test(p.text)), false,
      'the server does not put Acme\'s sentence in Verity\'s phrasebook',
    );
    assert.equal(
      sug.phrases.some((p) => /^re/i.test(p.text)), false,
      'no Verity phrase begins with "Re" — so a "Re" completion under Verity is Acme\'s',
    );
  });

// ===========================================================================
// 1 — MECHANISM: the open window is exactly the phrasebook request.
//
// `/api/matters/:id/suggestions` is held open, and nothing else is touched.
// Held, the field is asked to complete and answers with the PREVIOUS matter's
// sentence. Released, the completion already on screen does not go away by
// itself. One further keystroke, and it does — which is the control that proves
// the pool really did correct itself and that this file's discriminator ("Re"
// matches Acme and nothing of Verity's) is sound.
//
// Why the request is held rather than raced: on the LAN the window is real but
// ~20ms wide (measured: request in flight +5ms → +25ms), which no human
// keystroke can land inside and no test can race without flaking. Over a 300ms
// round trip — the remote cloudflared path and the phone PWA — the same request
// was measured in flight for ~690ms, and an ordinary beat lands inside it every
// time. The hold stands in for that link. It does not create the defect; it
// holds the window open long enough to photograph.
// ===========================================================================
test('LEAK (expected to fail until fixed): while the new matter\'s phrasebook is in flight, the field completes the old matter\'s sentence',
  { skip: SKIP }, async (t) => {
    const u = await bootOrSkip(t);
    if (!u) return;
    const page = await u.browser.newPage();
    t.after(() => page.close());
    await page.setViewport({ width: 1440, height: 900 });

    await freshEditor(u, page, u.work[0].id);

    // Warm Acme's pool the way the lawyer does — by typing in Acme's entry.
    await typeRe(page);
    await sleep(400);
    const warm = await readGhost(page);
    assert.equal(warm.matter, 'Acme lease dispute', 'sanity: the editor is on Acme');
    assert.ok(
      warm.hint && warm.hint.includes('Harbor Street'),
      `sanity: ghost text completes Acme's own sentence under Acme (got ${JSON.stringify(warm.hint)})`,
    );
    await clearNarrative(page);

    let hold = 0;
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (hold && /\/suggestions/.test(req.url())) setTimeout(() => req.continue().catch(() => {}), hold);
      else req.continue().catch(() => {});
    });
    hold = 2500;

    // Wrong matter. Fix it in the picker — the ordinary correction.
    await pickVerity(page);
    await sleep(300);
    await typeRe(page);
    await sleep(150);
    const inFlight = await readGhost(page);

    // Verity's real list lands. Nobody touches the keyboard.
    hold = 0;
    await sleep(3000);
    const afterArrival = await readGhost(page);

    // One more character — the first thing that recomputes the completion.
    await page.focus('.narrative-preview textarea');
    await page.keyboard.type('v', { delay: 10 });
    await sleep(200);
    const afterKeystroke = await readGhost(page);

    console.log('  observed — while the request was in flight:', JSON.stringify(inFlight.hint));
    console.log('  observed — after the correct list arrived:  ', JSON.stringify(afterArrival.hint));
    console.log('  observed — after one more keystroke:        ', JSON.stringify(afterKeystroke.hint));

    assert.equal(inFlight.matter, 'Verity payer audit', 'sanity: the entry now points at Verity');
    assert.equal(
      afterKeystroke.hint, null,
      'control: once the completion is recomputed against Verity\'s own list there is no "Re…" '
      + 'completion at all — so anything seen above came from Acme, not from Verity',
    );
    assert.equal(
      inFlight.hint, null,
      'LEAK: with the entry pointing at Verity payer audit (Verity Health), the field offers '
      + `${JSON.stringify(`Re${inFlight.hint}`)} — Acme Holdings' billing sentence, in `
      + 'undifferentiated grey, with nothing marking whose it is. Tab writes it in.',
    );
    assert.equal(
      afterArrival.hint, null,
      'LEAK: the borrowed completion outlives the list it came from — three seconds after Verity\'s '
      + 'own phrases arrived it is still on screen, because GhostInput recomputes only on input, '
      + 'select and blur and nothing watches `suggestions`',
    );
  });

// ===========================================================================
// 2 — REACHABILITY, end to end, at a human tempo.
//
// The only thing simulated here is the link. `/api/matters/:id/suggestions` is
// held for 800ms; everything else runs at full speed. That stands in for the
// remote cloudflared path and the phone PWA, where the same request was
// measured in flight for ~690ms behind a 300ms round trip. The lawyer's beat
// between clicking the matter and typing is 350ms — a slow one, if anything.
//
// Then it does what the claimant's version did not: it waits. Once the grey
// text is painted, nothing recomputes it, so the correct list arriving does not
// take it away. Three seconds later the lawyer presses Tab, and the sentence
// lands in the database.
// ===========================================================================
test('LEAK (expected to fail until fixed): over a slow link, Tab writes another client\'s narrative into this entry',
  { skip: SKIP }, async (t) => {
    const u = await bootOrSkip(t);
    if (!u) return;
    const page = await u.browser.newPage();
    t.after(() => page.close());
    await page.setViewport({ width: 1440, height: 900 });

    await freshEditor(u, page, u.work[1].id);
    await typeRe(page);
    await sleep(400);
    const warm = await readGhost(page);
    assert.ok(warm.hint && warm.hint.includes('Harbor Street'), 'sanity: ghost works under Acme');
    await clearNarrative(page);

    // Only now slow the phrasebook request down — the app's own traffic is
    // untouched, so nothing else about this run is unusual.
    let slow = false;
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (slow && /\/suggestions/.test(req.url())) setTimeout(() => req.continue().catch(() => {}), 800);
      else req.continue().catch(() => {});
    });
    slow = true;

    await pickVerity(page);
    await sleep(350);           // a human beat between the click and the keys
    await typeRe(page);
    await sleep(150);
    const typed = await readGhost(page);

    // He reads it, thinks, and only then reaches for Tab. By now Verity's real
    // phrase list has been in state for seconds.
    slow = false;
    await sleep(3000);
    const later = await readGhost(page);
    await page.focus('.narrative-preview textarea');
    await page.keyboard.press('Tab');
    await sleep(2500);          // the editor's 600ms autosave debounce + save

    const row = u.db.prepare(`
      SELECT e.narrative, m.short_name, c.name AS client
      FROM entries e JOIN matters m ON m.id = e.cm_id
      LEFT JOIN clients c ON c.id = m.client_id WHERE e.id = ?
    `).get(u.work[1].id);

    // All three observations, so a red run shows the whole chain and not just
    // the first assertion that trips.
    console.log('  observed — on screen when he typed:', JSON.stringify(typed.hint));
    console.log('  observed — on screen 3s later:     ', JSON.stringify(later.hint));
    console.log('  observed — stored in the database: ', JSON.stringify(row));

    assert.equal(typed.matter, 'Verity payer audit', 'sanity: the entry points at Verity');
    // The outcome first: what a lawyer's bill would carry.
    assert.equal(
      row.narrative, '',
      `LEAK: the entry stored against ${row.client} · ${row.short_name} now reads `
      + `${JSON.stringify(row.narrative)} — Acme Holdings' billing sentence, on Verity Health's bill`,
    );
    assert.equal(
      later.hint, null,
      'LEAK: three seconds after Verity\'s own phrase list arrived, the borrowed completion is STILL '
      + 'on screen — nothing recomputes a painted ghost when its pool changes, so the accept window '
      + 'is unbounded',
    );
    assert.equal(
      typed.hint, null,
      'LEAK: on a slow link the narrative field offers Acme Holdings\' sentence under Verity Health '
      + `— ${JSON.stringify(typed.hint)}`,
    );
  });

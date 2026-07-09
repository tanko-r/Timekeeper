// End-to-end smoke test: boots the real server on a scratch database, drives
// the SPA in headless Chromium, and fails on any console/page error.
// Usage: node scripts/e2e-smoke.mjs [--screenshots DIR]
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

process.env.TZ = process.env.TZ || 'America/Los_Angeles';

const shotDirArg = process.argv.indexOf('--screenshots');
const SHOT_DIR = shotDirArg > -1 ? process.argv[shotDirArg + 1] : null;
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });

const { openDb } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { startJobs } = await import('../server/jobs.js');

const dir = mkdtempSync(join(tmpdir(), 'tk-e2e-'));
const db = openDb(join(dir, 'e2e.db'));
const config = { DATA_DIR: dir, PUBLIC_HOSTNAME: 'time.example.test' };
const deps = { db, config, clock: () => new Date() };
const app = createApp(deps);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
startJobs(deps);

const problems = [];
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
page.on('console', (msg) => {
  if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
});
page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
page.on('requestfailed', (req) => problems.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`));

const step = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (e) {
    problems.push(`step "${name}": ${e.message}`);
    console.log(`  ✖ ${name}: ${e.message}`);
  }
};

const shot = async (name) => {
  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: false });
};

const waitFor = (sel, t = 5000) => page.waitForSelector(sel, { timeout: t });
const type = async (sel, text) => { await waitFor(sel); await page.type(sel, text, { delay: 5 }); };
const clickText = async (selector, text) => {
  await page.waitForFunction((sel, t) =>
    [...document.querySelectorAll(sel)].some((el) => el.textContent.trim().includes(t)),
  { timeout: 5000 }, selector, text);
  const box = await page.evaluate((sel, t) => {
    const el = [...document.querySelectorAll(sel)].find((x) => x.textContent.trim().includes(t));
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector, text);
  await page.mouse.click(box.x, box.y);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

console.log(`E2E against ${base}`);

await step('app shell renders (dashboard, SVG icons)', async () => {
  await page.goto(base, { waitUntil: 'networkidle0' });
  await waitFor('.sidebar .brand svg');
  await waitFor('.timer-new');
});

await step('create client+matter through picker (client→matter path, prefilled)', async () => {
  await page.keyboard.press('n');
  await waitFor('.modal .cmpicker input');
  await type('.modal .cmpicker input', '100001-000012');
  await clickText('.cmpicker-item .name', 'New client/matter');
  await waitFor('[data-nc-matter]');
  // typed CM number pre-splits into client + matter numbers
  const cpre = await page.$eval('[data-nc-client]', (el) => el.value);
  if (cpre !== '100001') throw new Error(`client prefill wrong: ${cpre}`);
  const mpre = await page.$eval('[data-nc-matter]', (el) => el.value);
  if (mpre !== '000012') throw new Error(`matter prefill wrong: ${mpre}`);
  // deliberately leave the client UNNAMED (blank names must render as the number)
  await type('[data-nc-name]', 'Acme lease dispute');
  await clickText('.modal button', 'Create matter');
  await sleep(400);
});

await step('entry: total + task line + narrative autosave, allocation chip', async () => {
  // total drives the single line
  await page.evaluate(() => {
    const modal = document.querySelector('.modal-wide');
    const total = modal.querySelector('.total-input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(total, '1.2');
    total.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // task code is hidden behind a "+ code" affordance by default (no <select>
  // until it's clicked) — click it, choose a code, and it collapses to a chip
  if (await page.$('.modal-wide .task-line select')) throw new Error('task-code <select> must be hidden by default');
  await page.click('.modal-wide .task-code-add');
  await waitFor('.modal-wide .task-line select');
  await page.evaluate(() => {
    const modal = document.querySelector('.modal-wide');
    const select = modal.querySelector('.task-line select');
    select.value = 'Review';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitFor('.modal-wide .task-code-chip');
  await page.type('.modal-wide textarea', 'Reviewed lease agreement and drafted renewal-terms summary for client.');
  await page.waitForFunction(
    () => document.querySelector('.saving-dot')?.textContent.includes('Saved'),
    { timeout: 6000 });
  // second line defaults to the remainder → allocation stays clean
  await clickText('.modal-wide button', 'Add task line');
  await page.waitForFunction(() => document.querySelectorAll('.modal-wide .task-line').length === 2);
  const lineVal = await page.$eval('.modal-wide .task-line:nth-of-type(2) input[type="number"]',
    (el) => el.value);
  if (Number(lineVal) !== 0) throw new Error(`remainder default wrong: ${lineVal}`);
  await page.evaluate(() => { // remove it again
    [...document.querySelectorAll('.modal-wide .task-line')][1]
      .querySelector('button[title="Remove line"]').click();
  });
  await shot('editor');
});

await step('finalize entry from editor', async () => {
  await clickText('.modal-wide button', 'Finalize');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });
});

await step('dashboard shows the entry and meter', async () => {
  await page.waitForFunction(
    () => document.body.textContent.includes('Acme lease dispute'), { timeout: 5000 });
  await waitFor('.meter-bar');
});

await step('persistent today footer: live total, ticking clock, close-the-day button', async () => {
  await waitFor('.today-footer');
  await page.waitForFunction(
    () => /\d+(\.\d+)?h/.test(document.querySelector('.today-footer .tf-total')?.textContent || ''),
    { timeout: 4000 });
  const hasCloseBtn = await page.evaluate(() =>
    [...document.querySelectorAll('.today-footer button')].some((b) => b.textContent.includes('Close the day')));
  if (!hasCloseBtn) throw new Error('today footer missing the "Close the day" button');

  // the running clock actually ticks: start a scratch timer via the API,
  // reload so the dashboard payload sees it running, watch the clock move,
  // then delete the timer so later steps see the same timer counts.
  const cms = await (await fetch(`${base}/api/cms`)).json();
  const scratch = await (await fetch(`${base}/api/timers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '__footer-tick__', cm_id: cms[0].id }),
  })).json();
  await fetch(`${base}/api/timers/${scratch.id}/start`, { method: 'POST' });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor('.today-footer .tf-running .mono');
  const before = await page.$eval('.today-footer .tf-running .mono', (el) => el.textContent.trim());
  await page.waitForFunction((prev) =>
    document.querySelector('.today-footer .tf-running .mono')?.textContent.trim() !== prev,
  { timeout: 4000 }, before);
  const del = await fetch(`${base}/api/timers/${scratch.id}`, { method: 'DELETE' });
  if (!del.ok) throw new Error(`scratch timer cleanup failed: ${del.status}`);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor('.today-footer');
});

await step('create timer; a sub-2s stop reverts as if nothing happened', async () => {
  await page.click('.timer-new');
  await type('.modal input[placeholder="e.g. Acme — research"]', 'Acme research');
  await page.click('.modal .cmpicker input');
  await sleep(250);
  await clickText('.cmpicker-item .name', 'Acme');
  await clickText('.modal button', 'Create');
  await waitFor('.timer-card');
  await page.click('.timer-card button[title="Start"]');
  await sleep(1200);
  await page.click('.timer-card button[title="Stop & file time"]');
  await sleep(500);
  const clock = await page.$eval('.timer-clock', (el) => el.textContent.trim());
  if (clock !== '0.0') throw new Error(`expected 0.0 tenths after misclick, got ${clock}`);
  const title = await page.$eval('.timer-clock', (el) => el.title);
  if (!title.startsWith('00:00')) throw new Error(`misclick must fully revert, got ${title}`);
});

await step('backdated start (10m ago) → stop → non-blocking chips; picking one opens the entry editor', async () => {
  await page.click('.timer-card button[title="Timer menu"]');
  await waitFor('.ctx-menu');
  await clickText('.ctx-menu .ctx-inline button', '10m');
  await page.waitForFunction(() => document.querySelector('.timer-card.running'), { timeout: 4000 });
  await page.click('.timer-card button[title="Stop & file time"]');
  await waitFor('.stop-chips'); // lightweight affordance…
  if (await page.$('.modal')) throw new Error('stop must not open a modal'); // …not a blocking one
  await shot('stop-chips');
  // one-tap narrative from the matter's history (the finalized Acme entry)
  // opens the entry editor with that narrative already filed.
  await clickText('.stop-chips .chip-btn', 'Reviewed lease agreement');
  await waitFor('.modal-wide .narrative-preview textarea');
  await page.waitForFunction(() => !document.querySelector('.stop-chips'), { timeout: 4000 });
  const narrative = await page.$eval('.modal-wide .narrative-preview textarea', (el) => el.value);
  if (!narrative.startsWith('Reviewed lease agreement')) {
    throw new Error(`chip narrative did not land in the editor: "${narrative}"`);
  }
  await clickText('.modal-wide button', 'Save & close');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });
  await sleep(400);
  const entries = await page.$$eval('.entry-card', (els) => els.length);
  if (entries < 2) throw new Error(`expected 2 entries on dashboard, got ${entries}`);
});

await step('quick-capture palette (q): "call re acme .3" parses clean and files', async () => {
  await page.evaluate(() => { document.activeElement?.blur(); });
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const before = await (await fetch(`${base}/api/entries?date=${today}`)).json();

  await page.keyboard.press('q');
  await waitFor('.qc-card input');
  await page.type('.qc-card input', 'call re acme .3', { delay: 20 });
  await page.waitForFunction(() => !document.querySelector('.qc-chip.miss')
    && !!document.querySelector('button.qc-chip.on'), { timeout: 4000 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.body.textContent.includes('Filed'), { timeout: 4000 });
  await page.waitForFunction(() => !document.querySelector('.qc-card'), { timeout: 4000 });

  const after = await (await fetch(`${base}/api/entries?date=${today}`)).json();
  if (after.length !== before.length + 1) {
    throw new Error(`quick-capture did not file exactly one entry: before=${before.length} after=${after.length}`);
  }
  const filed = after.find((e) => !before.some((b) => b.id === e.id));
  if (!filed) throw new Error('could not identify the filed quick-capture entry');
  // clean up so the day's data matches what later steps expect
  const del = await fetch(`${base}/api/entries/${filed.id}`, { method: 'DELETE' });
  if (!del.ok) throw new Error(`quick-capture cleanup delete failed: ${del.status}`);
});

await step('timer clock is editable in place', async () => {
  await page.click('.timer-clock');
  await waitFor('.clock-input');
  await page.evaluate(() => {
    const inp = document.querySelector('.clock-input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(inp, '1.4');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('.timer-clock')?.textContent.trim() === '1.4',
    { timeout: 4000 });
});

await step('ghost-text: phrasebook completion in the entry editor, Tab accepts', async () => {
  await page.keyboard.press('n');
  await waitFor('.modal .cmpicker input');
  await page.click('.modal .cmpicker input');
  await clickText('.cmpicker-item .name', 'Acme');
  await waitFor('.modal-wide .narrative-preview textarea');
  await page.click('.modal-wide .narrative-preview textarea');
  await page.type('.modal-wide .narrative-preview textarea', 'Rev', { delay: 30 });
  await page.waitForFunction(() => {
    const hint = document.querySelector('.modal-wide .ghost-hint');
    return hint && hint.textContent.startsWith('iewed lease agreement');
  }, { timeout: 4000 });
  await page.keyboard.press('Tab');
  const val = await page.$eval('.modal-wide .narrative-preview textarea', (el) => el.value);
  if (val !== 'Reviewed lease agreement and drafted renewal-terms summary for client') {
    throw new Error(`Tab did not accept the ghost: "${val}"`);
  }
  await shot('ghost-text');
  // the editor autosaved an entry while we typed — delete it to leave the day clean
  await page.waitForFunction(() => document.querySelector('.saving-dot')?.textContent.includes('Saved'), { timeout: 6000 });
  await clickText('.modal-wide button', 'Delete');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });
});

await step('shortcuts: save-from-selection, inline expansion, settings list', async () => {
  await page.keyboard.press('n');
  await waitFor('.modal .cmpicker input');
  await page.click('.modal .cmpicker input');
  await clickText('.cmpicker-item .name', 'Acme');
  await waitFor('.modal-wide .narrative-preview textarea');
  await page.type('.modal-wide .narrative-preview textarea', 'Interconnect Agreement');
  await page.evaluate(() => {
    const ta = document.querySelector('.modal-wide .narrative-preview textarea');
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
    ta.dispatchEvent(new Event('select', { bubbles: true }));
  });
  await waitFor('[data-shortcut-save]');
  await clickText('[data-shortcut-save] button', 'shortcut');
  await type('[data-shortcut-save] input', 'IA');
  await clickText('[data-shortcut-save] button', 'Save');
  await page.waitForFunction(() => document.body.textContent.includes('Shortcut saved'), { timeout: 4000 });
  // expansion: clear the field, then type the abbreviation + space
  await page.evaluate(() => {
    const ta = document.querySelector('.modal-wide .narrative-preview textarea');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.type('.modal-wide .narrative-preview textarea', 'review IA ', { delay: 20 });
  const val = await page.$eval('.modal-wide .narrative-preview textarea', (el) => el.value);
  if (val !== 'review Interconnect Agreement ') throw new Error(`expansion failed: "${val}"`);
  await clickText('.modal-wide button', 'Delete');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });
  // settings shows the minimal list (no management screen beyond list/delete)
  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.textContent.includes('Text-expansion shortcuts')
    && document.body.textContent.includes('Interconnect Agreement'), { timeout: 4000 });
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
});

await step('AUTO narrative: two-way edit-through, structural-break detach, client label', async () => {
  await page.keyboard.press('n');
  await waitFor('.modal .cmpicker input');
  await page.click('.modal .cmpicker input');
  await clickText('.cmpicker-item .name', 'Acme');
  await waitFor('.modal-wide .task-line');

  // client label visible (Acme's client was deliberately left unnamed → renders as the 6-digit number)
  await page.waitForFunction(() =>
    document.querySelector('.modal-wide .cm-client-label')?.textContent.includes('100001'), { timeout: 4000 });

  // fill line 1's fragment + hours (task code already covered by the earlier +code step)
  await page.evaluate(() => {
    const line1 = document.querySelector('.modal-wide .task-line');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const frag = line1.querySelector('input[type="text"]');
    set.call(frag, 'review lease terms');
    frag.dispatchEvent(new Event('input', { bubbles: true }));
    const hours = line1.querySelector('input[type="number"]');
    set.call(hours, '1.2');
    hours.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // second substantive line → AUTO becomes available (≥2 substantive lines)
  await clickText('.modal-wide button', 'Add task line');
  await page.waitForFunction(() => document.querySelectorAll('.modal-wide .task-line').length === 2);
  await page.evaluate(() => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const line2 = [...document.querySelectorAll('.modal-wide .task-line')][1];
    const frag = line2.querySelector('input[type="text"]');
    set.call(frag, 'draft renewal email');
    frag.dispatchEvent(new Event('input', { bubbles: true }));
    const hours = line2.querySelector('input[type="number"]');
    set.call(hours, '0.5');
    hours.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // AUTO box appears, formatted per line (line 1's hours rebalanced down to
  // 0.7 by the hours auto-rebalance: line2 grew from 0→0.5, and the two
  // lines' sum holds steady at 1.2 — the sum before this edit)
  await waitFor('.modal-wide .auto-badge');
  await page.waitForFunction(() => {
    const ta = document.querySelector('.modal-wide .narrative-preview textarea');
    return ta && ta.value === 'Review lease terms (0.7); draft renewal email (0.5).';
  }, { timeout: 4000 });

  // edit-through: rewrite the second fragment inside the AUTO box → task line 2 updates
  await page.evaluate(() => {
    const ta = document.querySelector('.modal-wide .narrative-preview textarea');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, 'Review lease terms (0.7); send renewal email to landlord (0.5).');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const line2 = [...document.querySelectorAll('.modal-wide .task-line')][1];
    return line2.querySelector('input[type="text"]').value === 'send renewal email to landlord';
  }, { timeout: 4000 });
  // …and the edit-through must NOT rewrite line 1's fragment with the AUTO
  // box's display-only capitalization ("Review …" is a render transform of
  // segment 0, not a user edit) — the stored lowercase text stays untouched.
  const line1Frag = await page.evaluate(() =>
    document.querySelector('.modal-wide .task-line input[type="text"]').value);
  if (line1Frag !== 'review lease terms') {
    throw new Error(`display-only casing leaked into line 1's fragment: "${line1Frag}"`);
  }

  // structural break: delete a parenthetical → AUTO turns off, typed text stands as manual
  const detachedText = 'Review lease terms 0.7; send renewal email to landlord (0.5).';
  await page.evaluate((text) => {
    const ta = document.querySelector('.modal-wide .narrative-preview textarea');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, detachedText);
  await page.waitForFunction(() => !document.querySelector('.modal-wide .auto-badge'), { timeout: 4000 });
  const manualText = await page.$eval('.modal-wide .narrative-preview textarea', (el) => el.value);
  if (manualText !== detachedText) {
    throw new Error(`manual text did not survive the detach: "${manualText}"`);
  }

  await shot('auto-narrative-sync');
  await page.waitForFunction(() => document.querySelector('.saving-dot')?.textContent.includes('Saved'), { timeout: 6000 });
  await clickText('.modal-wide button', 'Delete');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });
});

await step('picker: client→matter create + fuzzy client-name search', async () => {
  await clickText('button', 'New timer');
  await waitFor('.modal .cmpicker input');
  await page.click('.modal .cmpicker input');
  await clickText('.cmpicker-item .name', 'New client/matter');
  await waitFor('[data-nc-client]');
  await type('[data-nc-client]', '100004');
  await type('[data-nc-client-name]', 'Meridian'); // appears for new clients
  await type('[data-nc-matter]', '000001');
  await type('[data-nc-name]', 'Harbor Lease');
  await clickText('.modal button', 'Create matter');
  // back in the timer modal with the matter picked — reopen and fuzzy-search
  await waitFor('.modal .cmpicker button[title="Change CM"]');
  await page.click('.modal .cmpicker button[title="Change CM"]');
  await type('.modal .cmpicker input', 'meri harbor');
  await page.waitForFunction(() => [...document.querySelectorAll('.cmpicker-item')]
    .some((el) => el.textContent.includes('Meridian') && el.textContent.includes('Harbor Lease')),
  { timeout: 4000 });
  await clickText('.modal button', 'Cancel'); // no timer created
});

await step('groups: create, assign via menu, collapse; A-Z present', async () => {
  await clickText('button', 'New group');
  await type('.modal input[placeholder="e.g. Litigation"]', 'Litigation');
  await clickText('.modal button', 'Create');
  await page.waitForFunction(() => document.body.textContent.includes('Litigation'), { timeout: 4000 });

  await page.click('.timer-card button[title="Timer menu"]');
  await waitFor('.ctx-menu select');
  await page.evaluate(() => {
    const sel = document.querySelector('.ctx-menu select');
    sel.value = sel.querySelector('option:not([value=""])').value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const sections = [...document.querySelectorAll('.timer-section')];
    const lit = sections.find((s) => s.textContent.includes('Litigation'));
    return lit && lit.querySelector('.timer-card');
  }, { timeout: 4000 });

  // collapse hides the cards
  await page.evaluate(() => {
    const head = [...document.querySelectorAll('.group-head')].find((h) => h.textContent.includes('Litigation'));
    head.querySelector('button').click();
  });
  await page.waitForFunction(() => {
    const sections = [...document.querySelectorAll('.timer-section')];
    const lit = sections.find((s) => s.textContent.includes('Litigation'));
    return lit && !lit.querySelector('.timer-card');
  }, { timeout: 4000 });
  await shot('groups');

  const az = await page.$$eval('button', (els) => els.some((b) => b.textContent.includes('A–Z')));
  if (!az) throw new Error('A–Z button missing');
});

await step('grouping selector: by client / flat / persists across reload', async () => {
  await clickText('.seg button', 'By client');
  // Acme's client is unnamed → its section is labeled by the 6-digit number,
  // with a "· unnamed" hint alongside the group-name span (not inside it).
  await page.waitForFunction(() => [...document.querySelectorAll('.group-head .group-name')]
    .some((el) => el.textContent.trim() === '100001'), { timeout: 4000 });
  const unnamedHint = await page.evaluate(() => {
    const head = [...document.querySelectorAll('.group-head')]
      .find((h) => h.querySelector('.group-name')?.textContent.trim() === '100001');
    return head?.textContent.includes('unnamed');
  });
  if (!unnamedHint) throw new Error('by-client head missing the "unnamed" hint for an unnamed client');
  await clickText('.seg button', 'Flat');
  await page.waitForFunction(() => document.querySelectorAll('.group-head').length === 0
    && document.querySelectorAll('.timer-card').length >= 1, { timeout: 4000 });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor('.timer-card');
  const on = await page.$eval('.seg button.on', (el) => el.textContent.trim());
  if (on !== 'Flat') throw new Error(`grouping did not persist: ${on}`);
  await clickText('.seg button', 'By group');
  await page.waitForFunction(() => [...document.querySelectorAll('.group-name')]
    .some((el) => el.textContent.includes('Litigation')), { timeout: 4000 });
});

await step('client rename: inline on CMs view, reflected in by-client grouping', async () => {
  await page.goto(`${base}/#/cms`, { waitUntil: 'networkidle0' });
  await waitFor('.client-row');
  // client is still unnamed → the affordance is the dashed "+ Name this
  // client" button (B1), not a plain pencil.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.client-row')].find((r) => r.textContent.includes('100001'));
    row.querySelector('.client-name-add').click();
  });
  await type('.client-row input', 'Acme Holdings');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.client-row')]
    .some((r) => r.textContent.includes('Acme Holdings')), { timeout: 4000 });
  // the by-client grouping now shows the name instead of the number
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await clickText('.seg button', 'By client');
  await page.waitForFunction(() => [...document.querySelectorAll('.group-head .group-name')]
    .some((el) => el.textContent.trim() === 'Acme Holdings'), { timeout: 4000 });
  await clickText('.seg button', 'By group'); // restore for later steps
});

await step('client name editable from the matter Edit modal, reflected in C&M row + by-client head', async () => {
  await page.goto(`${base}/#/cms`, { waitUntil: 'networkidle0' });
  await waitFor('.client-row');
  // open the matter's Edit modal (not the client-row inline affordance)
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('table.tk tbody tr')];
    const row = rows.find((r) => r.textContent.includes('Acme lease dispute'));
    row.querySelector('button[title="Edit"]').click();
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.modal .field-label')]
    .some((el) => el.textContent.trim() === 'Client name'), { timeout: 4000 });
  // pre-filled from existing.client_name, hinted with the client number
  const { initial, hint } = await page.evaluate(() => {
    const f = [...document.querySelectorAll('.modal .field')]
      .find((x) => x.querySelector('.field-label')?.textContent.trim() === 'Client name');
    return { initial: f.querySelector('input').value, hint: f.querySelector('.field-hint')?.textContent || '' };
  });
  if (initial !== 'Acme Holdings') throw new Error(`client-name field not pre-filled: ${initial}`);
  if (!hint.includes('100001')) throw new Error(`client-name hint missing client number: ${hint}`);
  await page.evaluate(() => {
    const f = [...document.querySelectorAll('.modal .field')]
      .find((x) => x.querySelector('.field-label')?.textContent.trim() === 'Client name');
    const input = f.querySelector('input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(input, 'Acme Holdings LLC');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clickText('.modal button', 'Save');
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 4000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.client-row')]
    .some((r) => r.textContent.includes('Acme Holdings LLC')), { timeout: 4000 });

  // by-client head picks up the rename after a reload (real /api/timers refetch)
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await clickText('.seg button', 'By client');
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor('.timer-card');
  await page.waitForFunction(() => [...document.querySelectorAll('.group-head .group-name')]
    .some((el) => el.textContent.trim() === 'Acme Holdings LLC'), { timeout: 4000 });
  await clickText('.seg button', 'By group'); // restore for later steps
});

await step('grid keyboard: focus, Alt-nudge, Enter start/stop; worked-today highlight', async () => {
  // Acme research was left inside the collapsed "Litigation" group by the
  // earlier groups step; expand it so its card renders again.
  await page.evaluate(() => {
    const head = [...document.querySelectorAll('.group-head')].find((h) => h.textContent.includes('Litigation'));
    head?.querySelector('button')?.click();
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.timer-section')]
    .some((s) => s.textContent.includes('Litigation') && s.querySelector('.timer-card')), { timeout: 4000 });

  // a second, untouched timer proves the worked/zero distinction
  await clickText('button', 'New timer');
  await type('.modal input[placeholder="e.g. Acme — research"]', 'Harbor drafting');
  await page.click('.modal .cmpicker input');
  await sleep(250);
  await clickText('.cmpicker-item .name', 'Harbor Lease');
  await clickText('.modal button', 'Create');
  await page.waitForFunction(() => document.querySelectorAll('.timer-card').length >= 2, { timeout: 4000 });

  const workedNames = await page.$$eval('.timer-card.worked .timer-name', (els) => els.map((e) => e.textContent));
  if (!workedNames.includes('Acme research')) throw new Error(`Acme not highlighted: ${workedNames}`);
  if (workedNames.includes('Harbor drafting')) throw new Error('zero timer must not be highlighted');

  const focusAcme = () => page.evaluate(() => {
    [...document.querySelectorAll('.timer-card')]
      .find((c) => c.textContent.includes('Acme research')).focus();
  });
  const acmeClockIs = (want) => page.waitForFunction((w) => {
    const card = [...document.querySelectorAll('.timer-card')]
      .find((c) => c.textContent.includes('Acme research'));
    return card && card.querySelector('.timer-clock')?.textContent.trim() === w;
  }, { timeout: 4000 }, want);

  await focusAcme();
  await page.keyboard.down('Alt');
  await page.keyboard.press('ArrowUp');           // +0.1 → 1.5
  await page.keyboard.up('Alt');
  await acmeClockIs('1.5');
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowDown');          // −0.2 → 1.3
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');
  await acmeClockIs('1.3');

  await page.keyboard.press('Enter');              // start
  await page.waitForFunction(() => document.querySelector('.timer-card.running'), { timeout: 4000 });
  await sleep(2500);                               // outlive the 2s misclick grace
  await focusAcme();
  await page.keyboard.press('Enter');              // stop → chips
  await waitFor('.stop-chips');
  await page.keyboard.press('Escape');             // dismiss — the draft is already filed
  await page.waitForFunction(() => !document.querySelector('.stop-chips'), { timeout: 4000 });

  // A4: geometry-aware arrows. The grid is multi-column, so a flat ±1 index
  // (the old behavior) would send ArrowDown sideways instead of to the row
  // below. Force a wrap onto a second row (flat view, several cards), then
  // confirm ArrowRight walks DOM order and ArrowDown lands below.
  for (const name of ['Acme filing', 'Acme calls', 'Acme review']) {
    await clickText('button', 'New timer');
    await type('.modal input[placeholder="e.g. Acme — research"]', name);
    await page.click('.modal .cmpicker input');
    await sleep(250);
    await clickText('.cmpicker-item .name', 'Acme');
    await clickText('.modal button', 'Create');
    await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 4000 });
  }
  await page.waitForFunction(() => document.querySelectorAll('.timer-card').length >= 5, { timeout: 4000 });

  await clickText('.seg button', 'Flat');
  await page.waitForFunction(() => document.querySelectorAll('.group-head').length === 0
    && document.querySelectorAll('.timer-card').length >= 5, { timeout: 4000 });

  // ArrowRight: next card in DOM order (row 1 has multiple columns)
  await page.evaluate(() => document.querySelector('.timer-board .timer-card').focus());
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('.timer-board .timer-card')];
    return document.activeElement === cards[1];
  }, { timeout: 4000 });

  // ArrowDown from the top-left card: must land on a card in the row below,
  // not on cards[1] (which a flat index+1 would incorrectly pick).
  await page.evaluate(() => document.querySelector('.timer-board .timer-card').focus());
  const topBefore = await page.evaluate(() => document.activeElement.getBoundingClientRect().top);
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction((prevTop) => {
    const el = document.activeElement;
    return el && el.classList.contains('timer-card') && el.getBoundingClientRect().top > prevTop + 4;
  }, { timeout: 4000 }, topBefore);

  await clickText('.seg button', 'By group'); // restore for later steps
});

await step('/ opens the timer search bar; narrows in place; Esc restores', async () => {
  // dashboard route, body focus (not a card, not a form field) — `/` must
  // open the search bar rather than jumping to the Search view.
  await page.evaluate(() => { document.activeElement?.blur(); });
  await page.keyboard.press('/');
  await waitFor('.timer-search');
  await page.waitForFunction(() =>
    document.activeElement === document.querySelector('.timer-search'), { timeout: 4000 });

  await page.keyboard.type('meridian', { delay: 20 });
  await page.waitForFunction(() => {
    const names = [...document.querySelectorAll('.timer-card .timer-name')].map((e) => e.textContent);
    return names.length === 1 && names[0] === 'Harbor drafting'; // matched via CLIENT name
  }, { timeout: 4000 });
  const narrowedCount = await page.$eval('.timer-search-wrap .muted', (el) => el.textContent);
  if (narrowedCount !== '1/5') throw new Error(`match count wrong: ${narrowedCount}`);

  // zero matches must not trap the keyboard: over-type past any match, then
  // Backspace back down to a matching query — all via native input editing
  await page.keyboard.type('zzz', { delay: 20 });
  await page.waitForFunction(() => document.querySelectorAll('.timer-card').length === 0, { timeout: 4000 });
  const zeroCount = await page.$eval('.timer-search-wrap .muted', (el) => el.textContent);
  if (zeroCount !== '0/5') throw new Error(`match count wrong: ${zeroCount}`);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => {
    const names = [...document.querySelectorAll('.timer-card .timer-name')].map((e) => e.textContent);
    return names.length === 1 && names[0] === 'Harbor drafting';
  }, { timeout: 4000 });

  // repeat `/` while the bar is already open: click a card (focus leaves the
  // input; the bar stays up because the filter is set), press `/` again — it
  // must refocus the input rather than no-op on unchanged searchOpen state.
  await page.click('.timer-card .timer-name'); // safe spot — not the clock/start buttons
  await page.waitForFunction(() =>
    document.activeElement !== document.querySelector('.timer-search'), { timeout: 4000 });
  await page.keyboard.press('/');
  await page.waitForFunction(() =>
    document.activeElement === document.querySelector('.timer-search'), { timeout: 4000 });

  await page.keyboard.press('Escape'); // bar closes, filter clears, focus lands on a card
  await page.waitForFunction(() => !document.querySelector('.timer-search')
    && document.querySelectorAll('.timer-card').length >= 5, { timeout: 4000 });
  await page.waitForFunction(() =>
    document.activeElement && document.activeElement.classList.contains('timer-card'), { timeout: 4000 });
});

await step('calendar renders month grid with data', async () => {
  await page.goto(`${base}/#/calendar`, { waitUntil: 'networkidle0' });
  await waitFor('.cal-grid');
  await page.waitForFunction(() => document.querySelectorAll('.cal-day').length === 42);
});

await step('search finds the entry', async () => {
  await page.goto(`${base}/#/search`, { waitUntil: 'networkidle0' });
  await type('[data-search-q]', 'lease');
  await page.waitForFunction(
    () => document.querySelectorAll('table.tk tbody tr').length >= 1
      && document.body.textContent.includes('Acme'),
    { timeout: 5000 });
});

await step('stats renders bars', async () => {
  await page.goto(`${base}/#/stats`, { waitUntil: 'networkidle0' });
  await waitFor('.stat-tiles');
  await waitFor('.bar-row');
});

await step('export view offers CSV, .TIM, and text', async () => {
  await page.goto(`${base}/#/export`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.textContent.includes('.TIM'));
  await page.waitForFunction(() => document.body.textContent.includes('CSV'));
  await shot('export');
});

await step('export view: This month preset sets from=1st, to=today', async () => {
  await clickText('button', 'This month');
  const { fromVal, toVal, today } = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[type="date"]');
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return { fromVal: inputs[0].value, toVal: inputs[1].value, today: `${y}-${m}-${d}` };
  });
  if (!fromVal.endsWith('-01')) throw new Error(`This month "from" should be the 1st, got ${fromVal}`);
  if (toVal !== today) throw new Error(`This month "to" should be today (${today}), got ${toVal}`);
});

await step('settings shows AI + .TIM cards', async () => {
  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.textContent.includes('AI narrative assist'));
  await page.waitForFunction(() => document.body.textContent.includes('.TIM export'));
  await page.waitForFunction(() => document.body.textContent.includes('Task codes'));
  await shot('settings');
});

await step('dark mode applies', async () => {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await waitFor('.meter-bar');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  if (bg !== 'rgb(18, 18, 17)') throw new Error(`dark surface not applied: ${bg}`);
  await shot('dashboard-dark');
});

// Last data-mutating step (per plan): finalizes and exports today's drafts,
// so it runs after everything else that reads today's entry/timer state.
await step('one-sweep close-out: card stack finalizes & exports the day (c)', async () => {
  const cms = await (await fetch(`${base}/api/cms`)).json();
  const acme = cms.find((c) => c.short_name === 'Acme lease dispute') || cms[0];
  const seeded = await (await fetch(`${base}/api/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: todayLocal(),
      cm_id: acme.id,
      narrative: 'Reviewed the closing checklist and confirmed signature pages with opposing counsel.',
      tasks: [{ task_code: 'Review', duration: 0.4, fragment: '' }],
    }),
  })).json();

  await page.evaluate(() => { document.activeElement?.blur(); });
  await page.keyboard.press('c');
  await waitFor('.closeout-card');
  // the just-seeded draft is the newest (highest id) → first card in the sweep
  await page.waitForFunction((name) => document.querySelector('.closeout-card')?.textContent.includes(name),
    { timeout: 4000 }, acme.short_name);

  // global-shortcut fence: while the sweep is up, `n` must NOT open the entry
  // editor underneath the overlay (CloseOut's capture listener stops
  // propagation of unhandled keys before app.js's bubble handler sees them)
  await page.keyboard.press('n');
  await sleep(300);
  if (await page.$('.modal-backdrop')) throw new Error('global `n` leaked under the close-out overlay');
  if (!(await page.$('.closeout-card'))) throw new Error('close-out vanished after the fence check');

  // sweep through every draft card (Enter accepts and advances) until the summary
  for (let i = 0; i < 20; i++) {
    const phase = await page.$eval('.closeout-backdrop', (el) => el.dataset.phase);
    if (phase !== 'sweep') break;
    const before = await page.$$eval('.closeout-dot.on', (els) => els.length);
    await page.keyboard.press('Enter');
    await page.waitForFunction((prevOn) => {
      const backdrop = document.querySelector('.closeout-backdrop');
      if (!backdrop || backdrop.dataset.phase !== 'sweep') return true;
      return document.querySelectorAll('.closeout-dot.on').length > prevOn;
    }, { timeout: 4000 }, before);
  }
  const afterSweep = await page.$eval('.closeout-backdrop', (el) => el.dataset.phase);
  if (afterSweep !== 'summary') throw new Error(`expected the summary card after sweeping, got phase="${afterSweep}"`);

  await clickText('.closeout-card button', 'Finalize & export');
  await page.waitForFunction(() => {
    const p = document.querySelector('.closeout-backdrop')?.dataset.phase;
    return p === 'closed' || p === 'warn' || p === 'blocked';
  }, { timeout: 6000 });

  let phase = await page.$eval('.closeout-backdrop', (el) => el.dataset.phase);
  if (phase === 'warn') {
    // the harness's entries must be clean to reach here on a warning, not a
    // hard block — assert the warning card, then accept and finalize anyway.
    const hasAccept = await page.evaluate(() => [...document.querySelectorAll('.closeout-card button')]
      .some((b) => b.textContent.includes('Accept warnings & finalize')));
    if (!hasAccept) throw new Error('warn phase reached without an "Accept warnings & finalize" button (hard block?)');
    await clickText('.closeout-card button', 'Accept warnings & finalize');
    await page.waitForFunction(() => {
      const p = document.querySelector('.closeout-backdrop')?.dataset.phase;
      return p === 'closed' || p === 'blocked';
    }, { timeout: 6000 });
    phase = await page.$eval('.closeout-backdrop', (el) => el.dataset.phase);
  }
  if (phase !== 'closed') throw new Error(`expected the closed card, got phase="${phase}"`);
  await page.waitForFunction(() => document.body.textContent.includes('Day closed'), { timeout: 4000 });
  await shot('closeout-closed');
  await clickText('.closeout-card button', 'Done');
  await page.waitForFunction(() => !document.querySelector('.closeout-backdrop'), { timeout: 4000 });

  const after = await (await fetch(`${base}/api/entries/${seeded.id}`)).json();
  if (after.status !== 'finalized') throw new Error(`seeded draft was not finalized: status=${after.status}`);
  if (!after.exported_at) throw new Error('seeded draft was finalized but never marked exported');
});

await browser.close();
server.close();
db.close();
rmSync(dir, { recursive: true, force: true });

const real = problems.filter((p) => !p.includes('favicon'));
if (real.length) {
  console.error(`\nE2E PROBLEMS (${real.length}):`);
  for (const p of real) console.error('  - ' + p);
  process.exit(1);
}
console.log('\nE2E SMOKE: ALL CLEAR');

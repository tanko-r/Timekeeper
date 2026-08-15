// Overlay fences — behavioural proof that every dialog in the app is modal.
//
// The wave-0 critic measured four failures by driving the real DOM: focus
// walked out of the entry editor after 24 Tabs, the page behind it scrolled
// from 0 to 400, the phone bottom bar and the day footer stayed live and
// tappable above the scrim, and close-out offered Accept/Edit/Skip/Quit only
// as non-clickable <kbd> chips. Inspection cannot show any of that is fixed —
// only driving the DOM can. So this script opens EVERY dialog at both
// viewports and asserts, per dialog:
//
//   trap        Tab and Shift+Tab, dozens of times, never leave the panel
//   scroll      the page behind cannot be scrolled, programmatically included
//   aria        role="dialog" + aria-modal="true" + an accessible name
//   inert       .shell and .botnav are inert + aria-hidden behind the scrim
//   hit         document.elementFromPoint at the CENTRE of the bottom nav and
//               the day footer returns the scrim or the panel, never the bar
//   touch       at 390px every dialog has a visible button of at least 44×44
//   escape      Escape closes it and puts focus back on the opener
//   stack       with two dialogs open, Escape closes only the topmost
//   layers      a transient layer inside a dialog (the client/matter listbox)
//               takes the FIRST Escape; the dialog survives it
//   anchor      the page is where the reader left it after the dialog closes,
//               through every close path (see SCROLL ANCHOR below)
//
// Usage: node scripts/overlay-fences.mjs [--only entry-editor,closeout] [--json]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { seedDemo } from './lib/demoseed.mjs';

process.env.TZ = process.env.TZ || 'America/Los_Angeles';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const ONLY = (arg('only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const TAP_MIN = 44;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const TODAY = todayLocal();

const { openDb } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');

const dir = mkdtempSync(join(tmpdir(), 'tk-fences-'));
const db = openDb(join(dir, 'fences.db'));
const app = createApp({
  db,
  config: { DATA_DIR: dir, TRUST_LAN: true, PUBLIC_HOSTNAME: 'time.example.test' },
  clock: () => new Date(),
});
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
await seedDemo(base, { today: TODAY });

// ---------------------------------------------------------------------------
// Opening a dialog. `open` runs after the route has settled; it must leave the
// dialog up and the element that opened it stamped `data-fence-opener`, which
// is what the Escape/focus-restore assertion checks against.
// ---------------------------------------------------------------------------

// Stamp + focus a real, harmless button to stand in as the opener for a
// dialog whose only trigger is a key. Focus restoration is only observable if
// something focusable opened it.
// preventScroll because the scroll-anchor fence below opens every dialog from
// a page that has been scrolled on purpose: a focus() that scrolls the opener
// into view would move the page before the measurement started.
const stampFocus = (page, sel) => page.evaluate((s) => {
  const el = [...document.querySelectorAll(s)].find((e) => e.getClientRects().length);
  if (!el) throw new Error(`no opener matching ${s}`);
  el.setAttribute('data-fence-opener', '');
  el.focus({ preventScroll: true });
  return true;
}, sel);

// Stamp, focus and click — the ordinary "a button opened this" path.
const clickOpener = async (page, sel) => {
  await stampFocus(page, sel);
  await page.evaluate(() => document.querySelector('[data-fence-opener]').click());
};

const byText = (tag, text) => `::-p-xpath(//${tag}[contains(., "${text}")])`;

const DIALOGS = [
  {
    key: 'entry-editor',
    hash: `#/day/${TODAY}`,
    async open(page) {
      await clickOpener(page, '.page-head-actions .btn-primary');
    },
    // The editor opens with the client/matter listbox already down, so the
    // first Escape belongs to the listbox, not the dialog.
    transient: '.cmpicker-menu',
  },
  {
    key: 'entry-editor-existing',
    hash: `#/day/${TODAY}`,
    async open(page) {
      // NB: `.entry-card` is a plain div with no click handler — the editor
      // opens from the row's Edit button. (scripts/uishots.mjs clicks the card
      // and swallows the timeout, so its entry-editor-existing shot never
      // actually opens the editor; flagged, not fixed — that file is out of
      // this task's scope.)
      await page.waitForSelector('.entry-card button[title="Edit"]', { timeout: 5000 });
      await clickOpener(page, '.entry-card button[title="Edit"]');
    },
  },
  {
    key: 'closeout',
    hash: '#/',
    async open(page) {
      await page.waitForSelector('.tf-close', { timeout: 5000 });
      await clickOpener(page, '.tf-close');
    },
  },
  {
    key: 'quick-capture',
    hash: '#/',
    async open(page) {
      await stampFocus(page, '.page-head-actions .btn');
      await page.keyboard.press('q');
    },
  },
  {
    key: 'shortcuts',
    hash: '#/',
    async open(page) {
      await stampFocus(page, '.page-head-actions .btn');
      await page.keyboard.type('?');
    },
  },
  {
    key: 'summary',
    hash: '#/',
    async open(page) {
      await page.waitForSelector('.tf-summary', { timeout: 5000 });
      await clickOpener(page, '.tf-summary');
    },
  },
  {
    key: 'custom-fields',
    hash: '#/cms',
    async open(page) {
      await page.waitForSelector('.cms-table, table', { timeout: 5000 });
      await clickOpener(page, 'button[title^="Custom fields"]');
    },
  },
  {
    key: 'timer-import',
    hash: '#/',
    async open(page) {
      await page.waitForSelector('button[title="Batch-create timers from a CSV"]', { timeout: 5000 });
      await clickOpener(page, 'button[title="Batch-create timers from a CSV"]');
    },
  },
  {
    key: 'narrative-history',
    hash: `#/day/${TODAY}`,
    async open(page) {
      await page.waitForSelector('.entry-card button[title="Edit"]', { timeout: 5000 });
      await page.evaluate(() => document.querySelector('.entry-card button[title="Edit"]').click());
      await page.waitForSelector('.ovl-panel', { timeout: 5000 });
      await page.waitForSelector('button[title^="Reuse a narrative"]', { timeout: 5000 });
      await clickOpener(page, 'button[title^="Reuse a narrative"]');
      // two panels are up now; the assertions run against the topmost
    },
    stacked: true,
  },
  {
    key: 'feedback',
    hash: '#/',
    async open(page) {
      await stampFocus(page, '.page-head-actions .btn');
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('tk:add-todo')));
    },
  },
  {
    key: 'nav-sheet',
    hash: '#/',
    desktop: false, // the bottom bar, and so the More sheet, is phone-only
    async open(page) {
      await page.waitForSelector('.botnav', { timeout: 5000 });
      await clickOpener(page, '.botnav-item[aria-haspopup], .botnav button.botnav-item:last-child');
    },
  },
].filter((d) => ONLY.length === 0 || ONLY.includes(d.key));

// ---------------------------------------------------------------------------
// The assertions, all measured in the page.
// ---------------------------------------------------------------------------

const describe = (el) => {
  if (!el) return 'null';
  const cls = String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  return el.tagName.toLowerCase() + (cls ? `.${cls}` : '');
};

const probe = (page, tapMin) => page.evaluate((TAP) => {
  const desc = (el) => {
    if (!el) return 'null';
    const cls = String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    return el.tagName.toLowerCase() + (cls ? `.${cls}` : '');
  };
  const panels = [...document.querySelectorAll('.ovl-panel')];
  const panel = panels[panels.length - 1];
  if (!panel) return { missing: true };

  // aria wiring
  const name = panel.getAttribute('aria-label')
    || (panel.getAttribute('aria-labelledby')
      && document.getElementById(panel.getAttribute('aria-labelledby'))?.textContent)
    || '';

  // background inert + aria-hidden
  const bg = ['.shell', '.botnav'].map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, present: false };
    return {
      sel,
      present: true,
      inert: el.inert === true || el.hasAttribute('inert'),
      ariaHidden: el.getAttribute('aria-hidden') === 'true',
    };
  });

  // hit test at the CENTRE of every fixed bar behind the scrim
  const hits = ['.botnav', '.today-footer'].map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, present: false };
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { sel, present: true, visible: false };
    const cx = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
    const hit = document.elementFromPoint(cx, cy);
    return {
      sel,
      present: true,
      visible: true,
      point: `${Math.round(cx)},${Math.round(cy)}`,
      hit: desc(hit),
      // the scrim itself, or the panel sitting on it, is the only acceptable answer
      ok: !!hit && (hit.classList.contains('ovl') || !!hit.closest('.ovl')),
      z: getComputedStyle(el).zIndex,
    };
  });

  // touch affordance: a visible, enabled button of at least 44×44 in the panel
  const buttons = [...panel.querySelectorAll('button:not([disabled])')]
    .filter((b) => {
      const cs = getComputedStyle(b);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && b.getClientRects().length > 0;
    })
    .map((b) => {
      const r = b.getBoundingClientRect();
      const chain = [];
      for (let p = b.parentElement; p && p !== panel && chain.length < 3; p = p.parentElement) chain.push(desc(p));
      return {
        el: desc(b),
        where: chain.join(' < '),
        text: (b.getAttribute('aria-label') || b.title || b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
        w: Math.round(r.width * 10) / 10,
        h: Math.round(r.height * 10) / 10,
        ok: r.width >= TAP - 0.5 && r.height >= TAP - 0.5,
        // Inside the sheet's own scroll box a button below the fold still has
        // a client rect. "Visible" has to mean on screen, or a Save button
        // three screens down the body counts as an affordance it isn't.
        onScreen: r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.left >= 0 && r.right <= innerWidth + 0.5,
      };
    });

  // every <kbd> hint inside the panel must have a real control beside it
  const orphanKbd = [...panel.querySelectorAll('kbd')]
    .filter((k) => getComputedStyle(k).display !== 'none' && k.getClientRects().length > 0)
    .filter((k) => !k.closest('button, a[href], label, tr, table'))
    .map((k) => k.textContent.trim());

  return {
    missing: false,
    panels: panels.length,
    role: panel.getAttribute('role'),
    ariaModal: panel.getAttribute('aria-modal'),
    name: String(name).trim(),
    scrimZ: getComputedStyle(panel.closest('.ovl')).zIndex,
    bg,
    hits,
    buttons,
    bigButtons: buttons.filter((b) => b.ok),
    orphanKbd,
  };
}, tapMin);

async function tabWalk(page, key, steps) {
  for (let i = 0; i < steps; i += 1) {
    if (key === 'shift') {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
    } else {
      await page.keyboard.press('Tab');
    }
    const out = await page.evaluate(() => {
      const panels = [...document.querySelectorAll('.ovl-panel')];
      const panel = panels[panels.length - 1];
      const a = document.activeElement;
      const cls = a ? String(a.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
      return {
        inside: !!(panel && a && panel.contains(a)),
        active: a ? a.tagName.toLowerCase() + (cls ? `.${cls}` : '') : 'none',
      };
    });
    if (!out.inside) return { escapedAt: i + 1, active: out.active };
  }
  return null;
}

// ---------------------------------------------------------------------------

const VIEWPORTS = [
  { key: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { key: 'mobile', width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
});

const results = [];
const fail = (r, msg) => { r.failures.push(msg); };

for (const vp of VIEWPORTS) {
  for (const spec of DIALOGS) {
    if (vp.key === 'desktop' && spec.desktop === false) continue;
    const r = { dialog: spec.key, viewport: vp.key, failures: [], notes: [] };
    results.push(r);
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    try {
      await page.setViewport(vp);
      await page.goto(`${base}/${spec.hash}`, { waitUntil: 'networkidle0' });
      await page.evaluate((h) => { window.location.hash = h; }, spec.hash);
      await sleep(600);
      await page.evaluate(() => document.activeElement?.blur?.());

      // Was the page behind actually scrollable? A scroll-lock assertion on a
      // page that could never scroll proves nothing, so record it either way.
      const scrollable = await page.evaluate(() => (
        document.documentElement.scrollHeight > window.innerHeight + 4
      ));
      r.notes.push(`page scrollable before open: ${scrollable}`);

      await spec.open(page);
      await page.waitForSelector('.ovl-panel', { timeout: 6000 });
      await sleep(450);

      const p = await probe(page, TAP_MIN);
      if (p.missing) { fail(r, 'no .ovl-panel after open'); throw new Error('no panel'); }

      // --- aria ---
      if (p.role !== 'dialog') fail(r, `role="${p.role}" (want dialog)`);
      if (p.ariaModal !== 'true') fail(r, `aria-modal="${p.ariaModal}" (want true)`);
      if (!p.name) fail(r, 'panel has no accessible name');
      r.aria = `role=${p.role} aria-modal=${p.ariaModal} name="${p.name}"`;
      r.panels = p.panels;
      r.scrimZ = p.scrimZ;

      // --- background inert ---
      for (const b of p.bg) {
        if (!b.present) continue;
        if (!b.inert) fail(r, `${b.sel} is not inert behind the scrim`);
        if (!b.ariaHidden) fail(r, `${b.sel} is not aria-hidden behind the scrim`);
      }
      r.inert = p.bg.filter((b) => b.present).map((b) => `${b.sel}:inert=${b.inert},aria-hidden=${b.ariaHidden}`).join(' ');

      // --- hit test on the bars behind ---
      r.hits = p.hits.map((h) => {
        if (!h.present) return `${h.sel}:absent`;
        if (!h.visible) return `${h.sel}:not rendered`;
        if (!h.ok) fail(r, `${h.sel} is hittable at its centre (${h.point}) — elementFromPoint = ${h.hit}, z-index ${h.z}`);
        return `${h.sel}@${h.point}→${h.hit} z=${h.z} ${h.ok ? 'OK' : 'HITTABLE'}`;
      }).join(' | ');

      // --- focus trap ---
      const fwd = await tabWalk(page, 'tab', 40);
      if (fwd) fail(r, `Tab left the panel after ${fwd.escapedAt} presses → ${fwd.active}`);
      const back = await tabWalk(page, 'shift', 40);
      if (back) fail(r, `Shift+Tab left the panel after ${back.escapedAt} presses → ${back.active}`);
      r.trap = fwd || back ? 'ESCAPED' : '40 Tab + 40 Shift+Tab stayed inside';

      // --- scroll lock ---
      const scroll = await page.evaluate(() => {
        const before = window.scrollY;
        window.scrollTo(0, 400);
        document.documentElement.scrollTop = 400;
        document.body.scrollTop = 400;
        return { before, after: window.scrollY };
      });
      await page.mouse.move(vp.width / 2, 40);
      await page.mouse.wheel({ deltaY: 500 }).catch(() => {});
      await sleep(120);
      const afterWheel = await page.evaluate(() => window.scrollY);
      if (scroll.after !== scroll.before) fail(r, `programmatic scroll moved the page ${scroll.before} → ${scroll.after}`);
      if (afterWheel !== scroll.before) fail(r, `wheel moved the page ${scroll.before} → ${afterWheel}`);
      r.scroll = `scrollY ${scroll.before} → ${scroll.after} (programmatic) / ${afterWheel} (wheel)`;

      // --- touch affordance ---
      if (vp.key === 'mobile') {
        // The committing action must be reachable without hunting: on a phone
        // the sheet's action row is what the thumb goes for.
        const reachable = p.bigButtons.filter((b) => b.onScreen);
        if (reachable.length === 0) {
          fail(r, `no ≥${TAP_MIN}×${TAP_MIN} button is ON SCREEN when the sheet opens — all of [${p.bigButtons.map((b) => `"${b.text}"`).join(', ')}] sit outside the viewport`);
        }
        r.reach = `${reachable.length}/${p.bigButtons.length} of the ≥44px buttons are on screen — ${reachable.map((b) => `"${b.text}"`).join(', ') || 'none'}`;
        if (p.bigButtons.length === 0) {
          fail(r, `no visible button ≥ ${TAP_MIN}×${TAP_MIN} — buttons: ${p.buttons.map((b) => `${b.text || b.el} ${b.w}×${b.h}`).join(', ') || 'none'}`);
        }
        // Under-floor CONTENT controls are reported, not failed: this task owns
        // the dialog shell and its action row, and another wave owns what the
        // panels put inside them. The shell's own contract — at least one real
        // ≥44×44 control per dialog — is the assertion above.
        const under = p.buttons.filter((b) => !b.ok);
        if (under.length) {
          r.notes.push(`WARN content buttons under the ${TAP_MIN}px floor: ${under.map((b) => `"${b.text}" ${b.w}×${b.h} [in ${b.where}]`).join(', ')}`);
        }
        if (p.orphanKbd.length) fail(r, `<kbd> hints with no control of their own, visible on a phone: ${p.orphanKbd.join(', ')}`);
        r.touch = `${p.bigButtons.length}/${p.buttons.length} buttons ≥44×44 — ${p.bigButtons.map((b) => `"${b.text}" ${b.w}×${b.h}`).join(', ') || 'none'}`;
      } else {
        r.touch = `${p.buttons.length} buttons (desktop, floor not asserted)`;
      }

      // --- Escape: pops ONE layer ---
      const before = p.panels;
      // A transient layer (a popover, a menu, an in-panel listbox) is a layer
      // in its own right. The wave-0b critic found one Escape closing the
      // entry editor's matter listbox AND the editor with it: "a user who
      // presses n, sees the suggestion list, and taps Esc to dismiss just the
      // list loses the entire editor." So where a dialog declares one, the
      // first Escape must close the layer and leave the dialog standing.
      if (spec.transient) {
        const openLayer = await page.evaluate((s) => !!document.querySelector(s), spec.transient);
        if (!openLayer) {
          fail(r, `expected the ${spec.transient} layer to be open when this dialog appears`);
        } else {
          await page.keyboard.press('Escape');
          await sleep(300);
          const mid = await page.evaluate((s) => ({
            layer: !!document.querySelector(s),
            panels: document.querySelectorAll('.ovl-panel').length,
          }), spec.transient);
          if (mid.layer) fail(r, `Escape left the ${spec.transient} layer open`);
          if (mid.panels !== before) {
            fail(r, `Escape closed the DIALOG while ${spec.transient} was open — panels ${before} → ${mid.panels}; the first Escape belongs to the layer`);
          }
          r.layers = `first Escape closed ${spec.transient}, ${mid.panels} panel(s) still open`;
        }
      }
      await page.keyboard.press('Escape');
      await sleep(400);
      const after = await page.evaluate(() => ({
        panels: document.querySelectorAll('.ovl-panel').length,
        onOpener: !!(document.activeElement && document.activeElement.hasAttribute
          && document.activeElement.hasAttribute('data-fence-opener')),
        active: (() => {
          const a = document.activeElement;
          if (!a) return 'none';
          const cls = String(a.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
          return a.tagName.toLowerCase() + (cls ? `.${cls}` : '');
        })(),
      }));
      if (after.panels !== before - 1) {
        fail(r, `Escape left ${after.panels} panel(s) open, expected ${before - 1}`);
      }
      if (!after.onOpener) fail(r, `Escape did not restore focus to the opener (focus is on ${after.active})`);
      r.escape = `panels ${before} → ${after.panels}, focus → ${after.active}${after.onOpener ? ' (the opener)' : ''}`;
      if (spec.stacked) {
        r.notes.push(`stacked: Escape closed the top layer only, ${after.panels} still open`);
      }

      if (consoleErrors.length) fail(r, `console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
    } catch (e) {
      fail(r, `threw: ${e.message}`);
      if (consoleErrors.length) r.notes.push(`console: ${consoleErrors.slice(0, 2).join(' | ')}`);
    } finally {
      await page.close();
    }
  }
}

// ---------------------------------------------------------------------------
// SCROLL ANCHOR — the page is still where the reader left it after the dialog
// closes, through EVERY close path.
//
// The wave-0b critic measured a 200px snap to the top of the page on 4 of 10
// dialog×viewport combinations: "open an entry halfway down the day, fix the
// narrative, save, and the lawyer is dumped at the top of the list." The cause
// was inside the primitive's own lock — while the body is pinned the document
// collapses to viewport height, so a scroll offset written before the layout
// recovers is clamped to 0 — and the reason it went unnoticed for a wave is
// that two of the five dialogs happened to restore correctly, which reads as
// "the dialogs are inconsistent" rather than "the primitive is broken".
//
// So this is measured, not reasoned about: scroll the page down, note where
// .page-head sits, open the dialog, close it EVERY WAY IT CAN BE CLOSED, and
// require .page-head to come back to the same viewport top — no rounding, no
// tolerance. It also asserts the position while the dialog is up: a lock that
// jumps the page as it engages is the same defect one frame earlier.
// ---------------------------------------------------------------------------

const ANCHOR_KEYS = ['entry-editor', 'entry-editor-existing', 'shortcuts', 'quick-capture', 'closeout'];
const ANCHOR_Y = 200;
// Comfortably past the ~795ms at which the browser's own history scroll
// restoration used to land on top of ours.
const ANCHOR_SETTLE = 1100;

const headTop = (page) => page.evaluate(() => {
  const h = document.querySelector('.page-head');
  return h ? h.getBoundingClientRect().top : null;
});
const panelCount = (page) => page.evaluate(() => document.querySelectorAll('.ovl-panel').length);

const CLOSERS = [
  {
    key: 'Escape',
    async run(page) {
      // Up to three presses: a dialog with a transient layer down (the entry
      // editor's matter listbox) correctly spends the first one on the layer.
      for (let i = 0; i < 3; i += 1) {
        await page.keyboard.press('Escape');
        await sleep(220);
        if (await panelCount(page) === 0) return `Escape ×${i + 1}`;
      }
      return 'Escape ×3';
    },
  },
  {
    key: 'close button',
    async run(page) {
      const hit = await page.evaluate(() => {
        const b = document.querySelector('.ovl-panel .ovl-close');
        if (!b) return false;
        b.click();
        return true;
      });
      return hit ? 'the ✕' : null; // null → this dialog draws its own header
    },
  },
  {
    key: 'scrim',
    async run(page) {
      const pt = await page.evaluate(() => {
        const tries = [
          { x: Math.round(innerWidth / 2), y: 3 },
          { x: 3, y: Math.round(innerHeight / 2) },
          { x: Math.round(innerWidth / 2), y: innerHeight - 3 },
        ];
        for (const t of tries) {
          const el = document.elementFromPoint(t.x, t.y);
          if (el && el.classList.contains('ovl')) return t;
        }
        return null;
      });
      if (!pt) return null; // the panel covers the whole viewport
      await page.mouse.click(pt.x, pt.y);
      return `a scrim click at ${pt.x},${pt.y}`;
    },
  },
  {
    key: 'Ctrl+Enter',
    only: ['entry-editor', 'entry-editor-existing'],
    async run(page) {
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      return 'Ctrl+Enter';
    },
  },
  {
    key: 'Save & close',
    only: ['entry-editor-existing'],
    async run(page) {
      const hit = await page.evaluate(() => {
        const b = [...document.querySelectorAll('.ovl-panel button')]
          .find((x) => /save\s*&\s*close/i.test(x.textContent || ''));
        if (!b) return false;
        b.click();
        return true;
      });
      return hit ? '"Save & close"' : null;
    },
  },
];

for (const vp of VIEWPORTS) {
  for (const spec of DIALOGS.filter((d) => ANCHOR_KEYS.includes(d.key))) {
    if (vp.key === 'desktop' && spec.desktop === false) continue;
    for (const closer of CLOSERS) {
      if (closer.only && !closer.only.includes(spec.key)) continue;
      const r = { dialog: `scroll anchor: ${spec.key} via ${closer.key}`, viewport: vp.key, failures: [], notes: [] };
      results.push(r);
      const page = await browser.newPage();
      try {
        await page.setViewport(vp);
        await page.goto(`${base}/${spec.hash}`, { waitUntil: 'networkidle0' });
        await page.evaluate((h) => { window.location.hash = h; }, spec.hash);
        await sleep(600);
        await page.evaluate(() => document.activeElement?.blur?.());
        await page.evaluate((y) => window.scrollTo(0, y), ANCHOR_Y);
        await sleep(200);

        const scrollable = await page.evaluate(() => (
          document.documentElement.scrollHeight > window.innerHeight + 4
        ));
        const y0 = await page.evaluate(() => window.scrollY);
        r.notes.push(`page scrollable: ${scrollable}, scrolled to ${y0}`);
        if (!scrollable) r.notes.push('WEAK: this screen fits the viewport, so the assertion is trivially true here');
        const before = await headTop(page);
        if (before == null) { fail(r, 'no .page-head on this screen'); throw new Error('no .page-head'); }

        await spec.open(page);
        await page.waitForSelector('.ovl-panel', { timeout: 6000 });
        await sleep(400);
        const during = await headTop(page);
        if (during !== before) {
          fail(r, `the page moved as the dialog opened: .page-head top ${before} → ${during}`);
        }

        const how = await closer.run(page);
        if (how === null) {
          r.notes.push(`this dialog has no ${closer.key} — nothing to close it with, skipped`);
          continue;
        }
        await page.waitForFunction(() => !document.querySelector('.ovl-panel'), { timeout: 6000 })
          .catch(() => {});
        await sleep(ANCHOR_SETTLE);
        const left = await panelCount(page);
        if (left) fail(r, `${how} left ${left} panel(s) open`);
        const after = await headTop(page);
        if (after !== before) {
          fail(r, `closing with ${how} moved the page: .page-head top ${before} → ${after} (Δ${Math.round((after - before) * 10) / 10}px)`);
        }
        r.anchor = `.page-head ${before} → ${during} (locked) → ${after} after ${how}`;
      } catch (e) {
        fail(r, `threw: ${e.message}`);
      } finally {
        await page.close();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shortcut regression guard. The brief's rule is "preserve every existing
// capability", and a focus trap is exactly the kind of change that silently
// eats a key. `q`, `?` and Escape are already exercised above (they are how
// those dialogs get opened and closed); Ctrl+Enter is not covered anywhere in
// the e2e suite, so it is checked here.
// ---------------------------------------------------------------------------
if (ONLY.length === 0) {
  const r = { dialog: 'Ctrl+Enter saves and closes the editor', viewport: 'desktop', failures: [], notes: [] };
  results.push(r);
  const page = await browser.newPage();
  try {
    await page.setViewport(VIEWPORTS[0]);
    await page.goto(`${base}/#/day/${TODAY}`, { waitUntil: 'networkidle0' });
    await page.evaluate((h) => { window.location.hash = h; }, `#/day/${TODAY}`);
    await sleep(600);
    await page.evaluate(() => document.activeElement?.blur?.());
    await clickOpener(page, '.page-head-actions .btn-primary');
    await page.waitForSelector('.ovl-panel', { timeout: 6000 });
    await sleep(400);
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    await sleep(900);
    const open = await page.evaluate(() => document.querySelectorAll('.ovl-panel').length);
    if (open !== 0) fail(r, `Ctrl+Enter left the editor open (${open} panel(s))`);
    r.escape = `panels 1 → ${open}`;
  } catch (e) {
    fail(r, `threw: ${e.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();
await new Promise((r) => server.close(r));
db.close();
rmSync(dir, { recursive: true, force: true });

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    const ok = r.failures.length === 0;
    console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${r.dialog} @ ${r.viewport}`);
    if (r.aria) console.log(`      aria     ${r.aria}`);
    if (r.trap) console.log(`      trap     ${r.trap}`);
    if (r.scroll) console.log(`      scroll   ${r.scroll}`);
    if (r.inert) console.log(`      inert    ${r.inert}`);
    if (r.hits) console.log(`      hit      ${r.hits}`);
    if (r.touch) console.log(`      touch    ${r.touch}`);
    if (r.reach) console.log(`      reach    ${r.reach}`);
    if (r.layers) console.log(`      layers   ${r.layers}`);
    if (r.escape) console.log(`      escape   ${r.escape}`);
    if (r.anchor) console.log(`      anchor   ${r.anchor}`);
    for (const n of r.notes) console.log(`      note     ${n}`);
    for (const f of r.failures) console.log(`      ✖ ${f}`);
  }
  const failed = results.filter((r) => r.failures.length);
  console.log(`\n${results.length - failed.length}/${results.length} dialog×viewport cases pass`);
  if (failed.length) {
    console.log(`FAILING: ${failed.map((f) => `${f.dialog}@${f.viewport}`).join(', ')}`);
  }
}
process.exitCode = results.some((r) => r.failures.length) ? 1 : 0;

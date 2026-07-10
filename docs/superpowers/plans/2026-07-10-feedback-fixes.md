# UI-Feedback Fixes (2026-07-10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close both open TODO.md UI-feedback items: (1) starting a timer immediately creates its draft entry so Today's entries never says "No entries" while time is accruing, and (2) the New client/matter modal gets an explicit "new client" path so typing an unknown client *name* no longer dead-ends.

**Architecture:** Part B (client modal) is frontend-only — the server already supports naming a brand-new client via `client_name` on `POST /api/cms`; we add an explicit new-client mode to `CreateMatterModal` and make the name **required** for brand-new clients (name+number locked as a pair). Part A (timer→entry) extends the existing day-accumulator model with one new invariant: **a running timer with a matter always has a linked draft entry** — created at start (0.0h is fine), kept in sync at stop/assign/rollover exactly as today. Unassigned quick timers cannot have a DB entry (`entries.cm_id NOT NULL`, and the spec's "never invent an unassignable entry" assumption stands) — they get a frontend-only "ghost row" in Today's entries instead.

**Tech Stack:** Node 24 ESM, Express 5, better-sqlite3, no-build React 18 UMD + htm, `node:test`, headless-Chromium e2e (`scripts/e2e-smoke.mjs`).

## Global Constraints

- Runtime deps are exactly `express` + `better-sqlite3` — add nothing.
- No bundler; browser code is plain ES modules under `public/js/`.
- All server writes via prepared statements; business rules as pure functions where possible.
- **No schema change is needed for this plan** — do not touch `MIGRATIONS`.
- TDD: failing test first; `npm test` (node:test), e2e via `node scripts/e2e-smoke.mjs`.
- After changing any `public/js/**` or `public/css/*.css` file, **bump `CACHE` in `public/sw.js`** in the same commit.
- After server changes land, `systemctl --user restart timekeeper` (final task — the live service runs from this working directory).
- Atomic commits, one logical unit each.
- When a feedback TODO is addressed: check off/remove its line in `TODO.md` **and delete the referenced screenshot** from `feedback/`.

## Design decisions locked in (context for implementers)

1. **Entry-at-start applies to matter timers only.** `entries.cm_id` is `NOT NULL` and the design spec deliberately never invents an entry that can't be assigned. Unassigned quick timers render as a dashed "ghost row" in Today's entries (frontend, from the dashboard payload) with an "Assign matter" button.
2. **A 0.0h start-created entry must never become litter — but midnight NEVER deletes.** On explicit user actions that mean "that start didn't count" (sub-2s misclick grace, "New entry (zero clock)"), an *untouched* empty entry (draft, empty narrative, 0.0 total, no user-edited task lines) is soft-deleted and unlinked. **The midnight reset preserves every linked entry unconditionally** (David, 2026-07-10: "even when timers reset at midnight … the entries associated with them are preserved") — it banks, unlinks, and touches nothing else; a leftover empty draft surfaces in alerts/close-out for David to handle.
3. **Running-linked entries are exempt from "Needs attention".** A just-started entry has no narrative and 0.0h by definition; alerting on it while its timer runs is noise. The alert fires normally once the timer stops.
4. **Client name is required when creating a brand-new client** ("adding the client locks the client name and number together" — David's words). Existing unnamed clients (from CSV import) keep their optional inline "+ Name this client" flows; imports still never rename.
5. Rounding in this repo rounds timer seconds **up** to the next tenth (see `test/api.timers.test.js` "everything rounds up") — so any elapsed > 0 files ≥ 0.1 at stop; 0.0 totals only occur at the instant of start.

---

## Part B — New-client path in the New client/matter modal (feedback #2, smaller, ships first)

### Task 1: Characterization test — `client_name` locks onto brand-new clients only

The server behavior we're building UI on top of already exists (`POST /api/cms` with `client_name` names a blank client, never renames a named one — `server/routes/cms.js:61-65`). Pin it with a regression test so the modal can rely on it.

**Files:**
- Modify: `test/api.cms.test.js` (append test at end of file)

**Interfaces:**
- Consumes: `startTestServer` from `test/helpers.js` → `{ fetchJson, close, db }`; `POST /api/cms` accepts `{ cm_number, short_name, billable, favorite, client_name }` and its 201 body includes `client_name`.
- Produces: nothing new — regression guard only.

- [ ] **Step 1: Write the test**

Append to `test/api.cms.test.js` (match the file's existing import style — it already imports `test`, `assert`, `startTestServer`):

```js
test('client_name locks to the number at creation — a later matter never renames the client', async () => {
  const t = await startTestServer();
  try {
    const first = await t.fetchJson('POST', '/api/cms', {
      cm_number: '555001-000001', short_name: 'First matter', client_name: 'Initech',
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.client_name, 'Initech');

    const second = await t.fetchJson('POST', '/api/cms', {
      cm_number: '555001-000002', short_name: 'Second matter', client_name: 'Wrong Name LLC',
    });
    assert.equal(second.status, 201);
    assert.equal(second.body.client_name, 'Initech', 'existing client name kept — matters never rename');
  } finally { await t.close(); }
});
```

- [ ] **Step 2: Run it**

Run: `node --test test/api.cms.test.js`
Expected: PASS (this is a characterization test of existing behavior — if it FAILS, stop and investigate `server/routes/cms.js:61-65` before continuing).

- [ ] **Step 3: Commit**

```bash
git add test/api.cms.test.js
git commit -m "test(cms): pin client_name-locks-to-new-clients behavior"
```

### Task 2: New-client mode in `CreateMatterModal` + e2e updates

Today the only way to create a client is to type its unknown 6-digit *number* into the Client field; typing a *name* ("Meridian") that matches nothing silently disables "Create matter". Add an explicit "＋ New client…" row to the dropdown, and require the client name whenever a brand-new client is being created.

**Files:**
- Modify: `public/js/components/cmpicker.js` (function `CreateMatterModal`, lines ~189–287)
- Modify: `scripts/e2e-smoke.mjs` (steps at lines ~124–137 and ~598–609)
- Modify: `public/sw.js` (bump `CACHE`)
- Modify: `TODO.md` (remove the addressed feedback line)
- Delete: `feedback/2026-07-10T10-14-57.png`

**Interfaces:**
- Consumes: `POST /api/cms` with `client_name` (Task 1's guarantee); `GET /api/clients` list shape `{ id, client_number, name, matter_count }`.
- Produces: modal DOM keeps the existing test hooks `[data-nc-client]`, `[data-nc-client-name]`, `[data-nc-matter]`, `[data-nc-name]` (e2e depends on them). New dropdown row text starts with `＋ New client`.

- [ ] **Step 1: Update the e2e expectations first (they are the failing "tests" for this UI change)**

In `scripts/e2e-smoke.mjs`, step `'create client+matter through picker (client→matter path, prefilled)'` (~line 124): the client name is about to become **required** for brand-new clients, but many later steps (lines ~498, ~744–814) depend on client `100001` staying **unnamed** (they test the number-renders-as-label and "+ Name this client" flows, which remain reachable via CSV import). So: keep the modal-prefill assertions, then **cancel the modal and create the matter via the API instead**. Replace the step body's tail (from the `// deliberately leave the client UNNAMED` comment through `await sleep(400);`) with:

```js
  // Client name is now REQUIRED for brand-new clients created via the modal.
  // This scenario needs 100001 to stay UNNAMED (later steps cover the
  // number-as-label and "+ Name this client" flows, still reachable via CSV
  // import) — so verify the prefill, cancel, and seed via the API instead.
  await clickText('.modal button', 'Cancel');
  const seed = await fetch(`${base}/api/cms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cm_number: '100001-000012', short_name: 'Acme lease dispute', billable: 1 }),
  });
  if (seed.status !== 201) throw new Error(`API seed of 100001-000012 failed: ${seed.status}`);
  // the New-entry modal is still open behind the cancelled picker modal —
  // close it too so the next step starts clean, then reopen fresh
  await page.keyboard.press('Escape');
  await sleep(400);
```

Then check the next step (`'entry: total + task line + narrative autosave…'`, ~line 139): it assumed the create-matter flow left the entry modal open with the matter picked. Adjust its opening so it re-opens a new entry and picks the seeded matter through the picker:

```js
  await page.keyboard.press('n');
  await waitFor('.modal .cmpicker input');
  await type('.modal .cmpicker input', 'Acme lease');
  await page.waitForFunction(() => [...document.querySelectorAll('.cmpicker-item .name')]
    .some((el) => el.textContent.includes('Acme lease dispute')), { timeout: 4000 });
  await clickText('.cmpicker-item .name', 'Acme lease dispute');
```

(Read the surrounding code when editing — if the step already navigates/opens on its own, only add what's missing. The invariant to preserve: after this step's opening lines, the wide entry modal is open with `Acme lease dispute` selected.)

In step `'picker: client→matter create + fuzzy client-name search'` (~line 598): no change needed — it already types `[data-nc-client-name]` "Meridian". After the modal edits below, confirm it still passes.

Add a **new step** right after that one, covering the name-first path (the exact bug from the screenshot):

```js
await step('picker: NEW CLIENT by name first (feedback 2026-07-10)', async () => {
  await clickText('button', 'New timer');
  await waitFor('.modal .cmpicker input');
  await page.click('.modal .cmpicker input');
  await clickText('.cmpicker-item .name', 'New client/matter');
  await waitFor('[data-nc-client]');
  await type('[data-nc-client]', 'Globex'); // a NAME, not a number — the old dead-end
  await page.waitForFunction(() => [...document.querySelectorAll('.cmpicker-item .name')]
    .some((el) => el.textContent.includes('New client')), { timeout: 4000 });
  await clickText('.cmpicker-item .name', 'New client');
  // name moved into the (now required) client-name field; number goes in the search box
  const pre = await page.$eval('[data-nc-client-name]', (el) => el.value);
  if (pre !== 'Globex') throw new Error(`client name not carried over: "${pre}"`);
  await type('[data-nc-client]', '414141');
  await type('[data-nc-matter]', '000001');
  await type('[data-nc-name]', 'Globex retainer');
  await clickText('.modal button', 'Create matter');
  await waitFor('.modal .cmpicker button[title="Change CM"]');
  await clickText('.modal button', 'Cancel'); // no timer created
});
```

- [ ] **Step 2: Rework `CreateMatterModal` in `public/js/components/cmpicker.js`**

Five edits inside `CreateMatterModal` (current code at lines 189–287):

**(a)** Add state after the existing `useState` block:

```js
  const [wantNew, setWantNew] = useState(false); // explicit "＋ New client…" mode
```

**(b)** Replace the derivation block

```js
  const newNumber = !effective && SIX_RE.test(clientQ.trim()) ? clientQ.trim() : null;
  const clientNumber = effective ? effective.client_number : newNumber;
  const needsName = !!newNumber || (effective && !effective.name);
  const valid = !!clientNumber && SIX_RE.test(matterNum.trim());
```

with:

```js
  const newNumber = !effective && SIX_RE.test(clientQ.trim()) ? clientQ.trim() : null;
  const clientNumber = effective ? effective.client_number : newNumber;
  const needsName = !!newNumber || (effective && !effective.name);
  // Brand-new client: name and number are entered together, as a locked pair.
  const valid = !!clientNumber && SIX_RE.test(matterNum.trim())
    && (!newNumber || clientName.trim() !== '');
  const qt = clientQ.trim();
  const qIsText = qt !== '' && !/^[\d\s-]+$/.test(qt);

  function startNewClient() {
    if (qIsText) { setClientName(qt); setClientQ(''); }
    setWantNew(true);
    setListOpen(false);
  }
```

**(c)** Update the Client `Field` hint chain to cover the new mode:

```js
        <${Field} label="Client" hint=${effective
          ? `Existing client ${effective.client_number}${effective.name ? '' : ' (unnamed)'}`
          : newNumber ? `New client ${newNumber} — created together with this matter`
          : wantNew ? 'Now type the 6-digit client number'
          : 'Search by name or 6-digit number — or pick “＋ New client…” below'}>
```

**(d)** In the search input + dropdown block: change the placeholder to react to `wantNew`, show the menu even with zero matches, and append the "＋ New client…" row:

```js
            <div class="cmpicker">
              <input type="search" data-nc-client value=${clientQ} autoFocus
                placeholder=${wantNew ? '6-digit client number' : 'e.g. Meridian or 100004'}
                onFocus=${() => setListOpen(true)}
                onInput=${(e) => { setClientQ(e.target.value); setListOpen(true); }}
                onBlur=${() => setTimeout(() => setListOpen(false), 150)} />
              ${listOpen && !exact && (matches.length > 0 || qt !== '') ? html`
                <div class="cmpicker-menu">
                  ${matches.map((c) => html`
                    <div key=${c.id} class="cmpicker-item"
                      onMouseDown=${(ev) => { ev.preventDefault(); setPicked(c); setListOpen(false); }}>
                      <span class="name">${clientLabel(c)}</span>
                      <span class="num">${c.client_number} · ${c.matter_count} matter${c.matter_count === 1 ? '' : 's'}</span>
                    </div>`)}
                  ${!wantNew ? html`
                    <div class="cmpicker-item" onMouseDown=${(ev) => { ev.preventDefault(); startNewClient(); }}>
                      <span class="name" style=${{ color: 'var(--accent)' }}>
                        ＋ New client${qIsText ? ` “${qt}”` : ''}…</span>
                    </div>` : null}
                </div>` : null}
            </div>
```

**(e)** Show the client-name field in `wantNew` mode too, with required-ness reflected in the hint:

```js
        ${needsName || wantNew ? html`
          <${Field} label="Client name"
            hint=${newNumber || wantNew
              ? 'Required — saved together with the client number'
              : 'Optional — shown instead of the bare number everywhere'}>
            <input type="text" data-nc-client-name value=${clientName} placeholder="e.g. Meridian"
              onInput=${(e) => setClientName(e.target.value)} />
          <//>` : null}
```

Leave `save()` as is — `body.client_name` is already sent `if (needsName && clientName.trim())`, and `needsName` is true whenever `newNumber` is (the only case a brand-new client exists to name).

- [ ] **Step 3: Bump the service-worker cache**

In `public/sw.js`, increment the `CACHE` constant (e.g. `tk-v41` → `tk-v42` — use whatever the current value +1 is).

- [ ] **Step 4: Run unit tests, then e2e**

Run: `npm test`
Expected: PASS (no server changes in this task).

Run: `node scripts/e2e-smoke.mjs`
Expected: all steps PASS, including the new `picker: NEW CLIENT by name first` step. If the reworked seeding step fails, debug the modal-close sequencing (the `Escape` + `sleep` at the end of the edited step) before touching the modal code.

- [ ] **Step 5: Manual sanity check of the exact screenshot scenario**

Run: server already running locally (`systemctl --user status timekeeper` — but frontend files are served from disk, so a browser hard-reload against `http://localhost:4747` picks them up; the SW cache bump handles installed clients).
In a browser: Clients/Matters → New CM → type "Meridian" → the dropdown must show `＋ New client "Meridian"…` → click it → name carried over, type number `869938` + matter `000001` → "Create matter" enabled → creates, and the C&M table shows **Meridian** as the client name.

- [ ] **Step 6: Close out the TODO item**

Remove this line from `TODO.md`:

```
- [ ] 2026-07-10 10:14 — There is no way to add a client manually. …(feedback/2026-07-10T10-14-57.png · #/cms)
```

Run: `rm feedback/2026-07-10T10-14-57.png`

- [ ] **Step 7: Commit**

```bash
git add public/js/components/cmpicker.js public/sw.js scripts/e2e-smoke.mjs TODO.md
git commit -m "feat(cms): explicit new-client path in the matter modal — name+number locked"
```

---

## Part A — A running timer's entry exists from the moment it starts (feedback #1)

### Task 3: Server — start (and running-assign) creates the linked entry immediately

**Files:**
- Modify: `server/routes/timers.js` (`/:id/start` route ~line 335–391; `PATCH /:id` ~line 259–273)
- Modify: `test/api.timers.test.js` (add 1 test; rewrite the `'assigning a matter while RUNNING does not file yet'` test at ~line 366)

**Interfaces:**
- Consumes: existing `syncToEntry(db, timer, hours, dateStr, nowIso)` and `loadEntry(db, id)`.
- Produces: `POST /api/timers/:id/start` response gains `entry` (the linked entry object, or `null` for quick timers / already-running). `PATCH /api/timers/:id` now returns `entry` for a **running** timer gaining a matter (previously paused-only). Task 6's frontend relies on both.

- [ ] **Step 1: Write the failing tests**

In `test/api.timers.test.js`, add (using the file's existing `withServer`/`makeClock` helpers):

```js
test('start creates the linked entry immediately (0.0h draft, visible on the dashboard)', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme research', cm_id: cm.id, task_code: 'Research',
    })).body;

    const started = (await t.fetchJson('POST', `/api/timers/${timer.id}/start`)).body;
    assert.ok(started.entry, 'start returns the created entry');
    assert.equal(started.entry.total, 0);
    assert.equal(started.entry.status, 'draft');
    assert.equal(started.timer.linked_entry_id, started.entry.id);

    const dash = (await t.fetchJson('GET', '/api/dashboard')).body;
    assert.equal(dash.entries.length, 1, 'Today’s entries shows it while running');

    clock.advance(1200); // 20 min
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop.entry.id, started.entry.id, 'stop settles the SAME entry');
    assert.equal(stop.entry.total, 0.4);

    // a re-start later the same day does not spawn a second entry
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    const dash2 = (await t.fetchJson('GET', '/api/dashboard')).body;
    assert.equal(dash2.entries.length, 1);
  }));
```

And REWRITE the existing test at ~line 366 (`'quick timer: assigning a matter while RUNNING does not file yet (next stop does)'`) — the behavior it pins is the one David rejected:

```js
test('quick timer: assigning a matter while RUNNING creates the entry immediately', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {})).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800); // 30 min

    const patched = (await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      cm_id: cm.id, name: 'Now assigned',
    })).body;
    assert.ok(patched.entry, 'entry exists as soon as the running timer has a matter');
    assert.equal(patched.entry.total, 0.5);
    assert.equal(patched.linked_entry_id, patched.entry.id);

    clock.advance(600); // 10 more min
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop.entry.id, patched.entry.id);
    assert.equal(stop.entry.total, 0.7); // 2400s rounds up
  }));
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/api.timers.test.js`
Expected: the two tests above FAIL (`started.entry` undefined; `patched.entry` null). Everything else still PASSES.

- [ ] **Step 3: Implement in `server/routes/timers.js`**

In the `/:id/start` route, replace the closing lines

```js
    const out = { timer: withElapsed(getTimer.get(timer.id)) };
    if (stopped.length > 0) out.stopped = stopped;
    res.json(out);
```

with:

```js
    // Feedback 2026-07-10: the entry exists from the moment the timer starts,
    // so Today's entries always shows what's accruing. Created at the current
    // clock value — 0.0 for a fresh timer; the first stop lifts it.
    let entry = null;
    if (startMs != null && timer.cm_id) {
      const freshTimer = getTimer.get(timer.id);
      const hours = secondsToHours(elapsedSeconds(freshTimer, clock().getTime()), roundingCfg(db));
      const synced = syncToEntry(db, freshTimer, hours, todayLocal(clock()), now());
      entry = loadEntry(db, synced.entryId);
    }

    const out = { timer: withElapsed(getTimer.get(timer.id)), entry };
    if (stopped.length > 0) out.stopped = stopped;
    res.json(out);
```

(Place it AFTER the existing suggested-narrative block so `getTimer.get` sees the updated row. `elapsedSeconds`, `secondsToHours`, `todayLocal`, `loadEntry` are already imported.)

In `PATCH /:id`, replace the quick-timer completion block

```js
    let entry = null;
    const fresh = getTimer.get(timer.id);
    if (cmChanged && fresh.cm_id && !fresh.running) {
      const hours = secondsToHours(elapsedSeconds(fresh, clock().getTime()), roundingCfg(db));
      if (hours >= minIncrement(db) - 1e-9 && hours > 0) {
        const synced = syncToEntry(db, fresh, hours, todayLocal(clock()), now());
        entry = loadEntry(db, synced.entryId);
      }
    }
```

with:

```js
    let entry = null;
    const fresh = getTimer.get(timer.id);
    if (cmChanged && fresh.cm_id) {
      const hours = secondsToHours(elapsedSeconds(fresh, clock().getTime()), roundingCfg(db));
      if (fresh.running) {
        // Running: the entry exists the moment the matter is known — the
        // snapshot total settles at the next stop.
        const synced = syncToEntry(db, fresh, hours, todayLocal(clock()), now());
        entry = loadEntry(db, synced.entryId);
      } else if (hours >= minIncrement(db) - 1e-9 && hours > 0) {
        // Paused: unchanged — files the settled held time (stop → assign →
        // narrate flow); below-increment still holds without filing.
        const synced = syncToEntry(db, fresh, hours, todayLocal(clock()), now());
        entry = loadEntry(db, synced.entryId);
      }
    }
```

- [ ] **Step 4: Run the timer tests**

Run: `node --test test/api.timers.test.js`
Expected: the two new/rewritten tests PASS. Some neighbors may now fail on side effects (misclick/rollover tests) — those are Task 4's subject; if any fail, confirm they fail ONLY on the entry-litter/rollover-linking behaviors Task 4 introduces, and proceed (or fix trivial assertion drift like start responses now carrying `entry: null`).

- [ ] **Step 5: Commit**

```bash
git add server/routes/timers.js test/api.timers.test.js
git commit -m "feat(timers): a running timer's entry exists from start (and from running assign)"
```

### Task 4: Server — no 0.0h litter (misclick / fresh only) + rollover links today's entry, preserving yesterday's

**Files:**
- Modify: `server/routes/timers.js` (`stopAndFile` misclick branch ~line 296–307; `/:id/fresh` route ~line 403–411; `applyRollovers` ~line 85–113)
- Modify: `test/api.timers.test.js` (3 new tests; update the misclick test ~line 161 and midnight-rollover test ~line 222 if their assertions drift)

**Interfaces:**
- Consumes: Task 3's start-creates-entry behavior.
- Produces: module-level `deleteIfUntouched(db, entryId, nowIso) → boolean` in `server/routes/timers.js` (soft-deletes an untouched empty entry). `/:id/fresh` response gains `entry` (re-created for a running matter timer) — Task 6 ignores it, no frontend contract change needed.

- [ ] **Step 1: Write the failing tests**

Add to `test/api.timers.test.js`:

```js
test('misclick after a fresh start removes the just-created empty entry', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme research', cm_id: cm.id,
    })).body;
    const started = (await t.fetchJson('POST', `/api/timers/${timer.id}/start`)).body;
    assert.ok(started.entry);
    clock.advance(1);
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop.discarded, true);
    const dash = (await t.fetchJson('GET', '/api/dashboard')).body;
    assert.equal(dash.entries.length, 0, 'as if nothing happened — no 0.0h litter');
    const after = (await t.fetchJson('GET', '/api/timers')).body.find((x) => x.id === timer.id);
    assert.equal(after.linked_entry_id, null);
  }));

test('fresh removes an untouched empty entry instead of keeping it', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme research', cm_id: cm.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1); // still running, nothing settled
    await t.fetchJson('POST', `/api/timers/${timer.id}/fresh`);
    // running matter timer keeps the invariant: a NEW linked entry exists
    const after = (await t.fetchJson('GET', '/api/timers')).body.find((x) => x.id === timer.id);
    assert.ok(after.linked_entry_id, 'fresh re-links a running timer to a new entry');
    const dash = (await t.fetchJson('GET', '/api/dashboard')).body;
    assert.equal(dash.entries.length, 1, 'old empty entry deleted, exactly one remains');
  }));

test('midnight rollover: a running timer starts the new day with its own linked entry', () =>
  withServer('2026-07-06T23:50:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Late night', cm_id: cm.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.set('2026-07-07T00:05:00-07:00');
    const rolled = (await t.fetchJson('GET', '/api/timers')).body.find((x) => x.id === timer.id); // GET triggers rollover
    const yesterday = t.db.prepare("SELECT * FROM entries WHERE date='2026-07-06' AND deleted_at IS NULL").all();
    assert.equal(yesterday.length, 1);
    assert.equal(yesterday[0].total_override, 0.2, '10 min banked to the accrual day (rounds up)');
    const today = t.db.prepare("SELECT * FROM entries WHERE date='2026-07-07' AND deleted_at IS NULL").all();
    assert.equal(today.length, 1, 'the new day has its own entry from the first moment');
    assert.equal(rolled.linked_entry_id, today[0].id);
    assert.notEqual(today[0].id, yesterday[0].id);
  }));

test('midnight reset preserves linked entries of paused timers — even when nothing banks', () =>
  withServer('2026-07-06T22:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Evening work', cm_id: cm.id,
    })).body;
    // paused timer with a settled entry
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1200);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    // second timer: filed 0.2h, then clock zeroed → at midnight its bank is 0
    // (the else-branch that must NOT touch the linked entry)
    const t2 = (await t.fetchJson('POST', '/api/timers', {
      name: 'Zeroed out', cm_id: cm.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${t2.id}/start`);
    clock.advance(600);
    await t.fetchJson('POST', `/api/timers/${t2.id}/stop`);
    await t.fetchJson('PUT', `/api/timers/${t2.id}/clock`, { hours: 0 });

    clock.set('2026-07-07T00:10:00-07:00');
    await t.fetchJson('GET', '/api/timers'); // triggers rollover
    const kept = t.db.prepare("SELECT * FROM entries WHERE date='2026-07-06' AND deleted_at IS NULL").all();
    assert.equal(kept.length, 2, 'midnight deletes nothing — both entries preserved');
    const list = (await t.fetchJson('GET', '/api/timers')).body;
    for (const x of list) assert.equal(x.linked_entry_id, null, 'paused timers unlink for the new day');
  }));
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/api.timers.test.js`
Expected: all three FAIL (litter remains / no new-day link).

- [ ] **Step 3: Implement in `server/routes/timers.js`**

Add module-level helper right after `syncToEntry`:

```js
// A start-created entry that never got real content (no time, no narrative,
// no user-touched task lines) is noise — remove it wherever the flow would
// otherwise leave it behind (misclick grace, "fresh", empty midnight reset).
function deleteIfUntouched(db, entryId, nowIso) {
  if (!entryId) return false;
  const e = db.prepare(`SELECT id FROM entries WHERE id=? AND deleted_at IS NULL
    AND status='draft' AND ever_finalized=0 AND narrative=''
    AND COALESCE(total_override, 0) = 0`).get(entryId);
  if (!e) return false;
  const touched = db.prepare(`SELECT COUNT(*) c FROM entry_tasks
    WHERE entry_id=? AND (COALESCE(duration, 0) != 0 OR COALESCE(fragment, '') != '')`).get(entryId).c;
  if (touched > 0) return false;
  db.prepare('UPDATE entries SET deleted_at=?, updated_at=? WHERE id=?').run(nowIso, nowIso, entryId);
  return true;
}
```

**Misclick branch** of `stopAndFile` — replace the running-≤2s block's UPDATE with:

```js
    if (timer.running && timer.last_started_at
      && clock().getTime() - Date.parse(timer.last_started_at) <= 2000) {
      const removedEmpty = deleteIfUntouched(db, timer.linked_entry_id, now());
      db.prepare(`UPDATE timers SET running=0, last_started_at=NULL${removedEmpty ? ', linked_entry_id=NULL' : ''} WHERE id=?`)
        .run(timer.id);
      return {
        entry: null, hours: 0, discarded: true,
        seconds: timer.accumulated_seconds,
        timer: withElapsed(getTimer.get(timer.id)),
      };
    }
```

**`/:id/fresh` route** — replace the body with:

```js
    applyRollovers(db, clock);
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    // an untouched empty entry isn't "kept" — it never had anything to keep
    deleteIfUntouched(db, timer.linked_entry_id, now());
    db.prepare(
      'UPDATE timers SET accumulated_seconds=0, last_started_at=?, linked_entry_id=NULL WHERE id=?'
    ).run(timer.running ? now() : null, timer.id);
    // invariant: a RUNNING matter timer always has a linked entry
    let entry = null;
    const freshTimer = getTimer.get(timer.id);
    if (freshTimer.running && freshTimer.cm_id) {
      const synced = syncToEntry(db, freshTimer, 0, todayLocal(clock()), now());
      entry = loadEntry(db, synced.entryId);
    }
    res.json({ timer: withElapsed(getTimer.get(timer.id)), entry });
```

**`applyRollovers`** — in the assigned-timer branch, replace

```js
    const hours = secondsToHours(r.bankSeconds, rounding);
    if (hours >= minInc - 1e-9 && hours > 0) {
      syncToEntry(db, timer, hours, r.bankDate, nowIso);
    } else if (r.bankSeconds > 0) {
      console.log(`timer ${timer.id} (${timer.name}): dropped ${r.bankSeconds}s below minimum increment at midnight reset`);
    }
    db.prepare(
      'UPDATE timers SET accumulated_seconds=0, last_started_at=?, last_reset_date=?, linked_entry_id=NULL WHERE id=?'
    ).run(timer.running ? r.restartIso : null, today, timer.id);
```

with:

```js
    const hours = secondsToHours(r.bankSeconds, rounding);
    if (hours >= minInc - 1e-9 && hours > 0) {
      syncToEntry(db, timer, hours, r.bankDate, nowIso);
    } else if (r.bankSeconds > 0) {
      console.log(`timer ${timer.id} (${timer.name}): dropped ${r.bankSeconds}s below minimum increment at midnight reset`);
    }
    // NOTE: the midnight reset never deletes — banked or not, whatever entry
    // the timer was linked to is preserved (David's explicit requirement).
    db.prepare(
      'UPDATE timers SET accumulated_seconds=0, last_started_at=?, last_reset_date=?, linked_entry_id=NULL WHERE id=?'
    ).run(timer.running ? r.restartIso : null, today, timer.id);
    if (timer.running) {
      // running through midnight: the new day's entry exists from its first
      // moment, same as a fresh start
      const freshTimer = db.prepare(`SELECT ${TIMER_COLS} FROM timers WHERE id=?`).get(timer.id);
      const hoursToday = secondsToHours(elapsedSeconds(freshTimer, clock().getTime()), rounding);
      syncToEntry(db, freshTimer, hoursToday, today, nowIso);
    }
```

- [ ] **Step 4: Run the whole timer suite; reconcile drifted assertions**

Run: `node --test test/api.timers.test.js`
Expected: the three new tests PASS. Known candidates for assertion drift (update the ASSERTIONS to the new model, do not weaken the behaviors they otherwise pin):
- `'misclick grace: stop within 2s of starting reverts as if nothing happened'` (~line 161) — "nothing happened" now also means no leftover entry; if it asserts `linked_entry_id` unchanged after a first-ever start, update it to expect `null`.
- `'midnight rollover: final sync to yesterday via linked entry, clock zeroed and unlinked'` (~line 222) — if its timer is RUNNING across midnight, it now ends linked to a NEW today-entry; if paused, unchanged.
- Exclusive-start tests (~lines 417–466) — start responses now carry `entry`; totals/entry counts unchanged for the stopped timer, but the starting timer now has its own 0.0h entry: entry-count assertions may need +1.

Then run: `npm test`
Expected: full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/timers.js test/api.timers.test.js
git commit -m "feat(timers): rollover links the new day's entry; empty start-entries never linger"
```

### Task 5: Server — dashboard: quick timers in payload, running entries exempt from alerts

**Files:**
- Modify: `server/routes/dashboard.js` (timers query line 34–36; `invalid` filter line 29–32)
- Modify: `test/api.timers.test.js` (2 new tests — they use `/api/dashboard`, and this file already has the timer scaffolding)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /api/dashboard` → `timers` now includes cm-less quick timers (`cm_number`/`cm_short_name` null); `alerts.invalidDrafts`/`alerts.backlog` exclude entries linked to a currently-running timer. Task 6's frontend depends on both.

- [ ] **Step 1: Write the failing tests**

Add to `test/api.timers.test.js`:

```js
test('dashboard alerts skip entries whose timer is running; they surface on stop', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme research', cm_id: cm.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(60);
    let dash = (await t.fetchJson('GET', '/api/dashboard')).body;
    assert.equal(dash.alerts.invalidDrafts.length, 0, 'work in progress is not "needs attention"');
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    dash = (await t.fetchJson('GET', '/api/dashboard')).body;
    assert.equal(dash.alerts.invalidDrafts.length, 1, 'stopped: the empty narrative surfaces normally');
  }));

test('dashboard timers include unassigned quick timers (for the ghost row + footer)', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t) => {
    const quick = (await t.fetchJson('POST', '/api/timers', {})).body;
    await t.fetchJson('POST', `/api/timers/${quick.id}/start`);
    const dash = (await t.fetchJson('GET', '/api/dashboard')).body;
    const row = dash.timers.find((x) => x.id === quick.id);
    assert.ok(row, 'quick timer present in dashboard payload');
    assert.equal(row.cm_number, null);
    assert.equal(row.running, 1);
  }));
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/api.timers.test.js`
Expected: both FAIL (alert count 1 while running; quick timer absent).

- [ ] **Step 3: Implement in `server/routes/dashboard.js`**

Replace the `invalid` computation:

```js
    // Any draft with validation findings needs attention before finalizing —
    // except one whose timer is running right now (a start-created entry has
    // no narrative and 0.0h by definition; it alerts once the timer stops).
    const runningLinked = new Set(db.prepare(
      'SELECT linked_entry_id FROM timers WHERE running=1 AND linked_entry_id IS NOT NULL'
    ).all().map((x) => x.linked_entry_id));
    const draftRows = db.prepare(
      "SELECT * FROM entries WHERE deleted_at IS NULL AND status='draft' AND date <= ?"
    ).all(today).map((row) => enrich(db, row));
    const invalid = draftRows.filter((e) => e.validation.length > 0 && !runningLinked.has(e.id));
```

Replace the timers query's `JOIN` with `LEFT JOIN` (quick timers must reach the footer and the ghost row):

```js
    const timers = db.prepare(`SELECT timers.*, matters.cm_number, matters.short_name AS cm_short_name
      FROM timers LEFT JOIN matters ON matters.id = timers.cm_id ORDER BY timers.sort_order, timers.id`).all()
      .map((t) => ({ ...t, elapsed_seconds: elapsedSeconds(t, clock().getTime()) }));
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/dashboard.js test/api.timers.test.js
git commit -m "feat(dashboard): quick timers in payload; running-linked entries exempt from alerts"
```

### Task 6: Frontend — running chip, quick-timer ghost row, wiring

**Files:**
- Modify: `public/js/views/dashboard.js` (compute running ids; ghost rows above `EntryList`)
- Modify: `public/js/components/entrylist.js` (accept `runningIds`, render chip)
- Modify: `public/js/components/timergrid.js` (start → `onEntryChanged`; `tk:edit-timer` listener; don't auto-open editor after a *running* assign)
- Modify: `public/css/app.css` (chip + ghost styles)
- Modify: `public/sw.js` (bump `CACHE`)

**Interfaces:**
- Consumes: Task 5's dashboard payload (`timers` incl. quick, `running`, `linked_entry_id`, `elapsed_seconds`); Task 3's `start`/PATCH responses carrying `entry`.
- Produces: `EntryList` gains optional prop `runningIds` (a `Set` of entry ids, default `null`). Window event `tk:edit-timer` with `detail: { id }` opens a timer's edit modal from anywhere on the dashboard.

- [ ] **Step 1: `EntryList` — running chip**

In `public/js/components/entrylist.js`, change the signature:

```js
export function EntryList({ entries, openEditor, onChanged, settings, showDate = false, runningIds = null }) {
```

and in the `entry-meta` row, replace the `source === 'timer'` chip line with:

```js
              ${runningIds && runningIds.has(e.id) ? html`
                <span class="chip chip-running" title="Timer running — the total settles at the next stop">
                  <${Icon} name="timer" size=${12} /> running</span>`
              : e.source === 'timer' ? html`<span class="chip" title="Created by a timer"><${Icon} name="timer" size=${12} /></span>` : null}
```

- [ ] **Step 2: `DashboardView` — running ids + ghost rows**

In `public/js/views/dashboard.js`, after `const d = data;` add:

```js
  const runningEntryIds = new Set((d.timers || [])
    .filter((t) => t.running && t.linked_entry_id).map((t) => t.linked_entry_id));
  const unassignedRunning = (d.timers || []).filter((t) => t.running && !t.cm_id);
```

In the Today's-entries panel, insert the ghost rows between the `section-title` div and the `EntryList`, and pass the new prop:

```js
      ${unassignedRunning.map((t) => html`
        <div key=${'ghost-' + t.id} class="entry-card running-ghost">
          <div class="body">
            <div class="entry-meta">
              <span class="chip chip-running"><${Icon} name="timer" size=${12} /> running</span>
              <strong>${t.name}</strong>
            </div>
            <p class="narrative"><em class="muted">No matter yet — this time becomes an entry once one is assigned.</em></p>
          </div>
          <div style=${{ textAlign: 'right' }}>
            <div class="hours muted">${fmtHours(Math.ceil((t.elapsed_seconds / 3600) * 10) / 10)}</div>
            <button class="btn btn-sm"
              onClick=${() => window.dispatchEvent(new CustomEvent('tk:edit-timer', { detail: { id: t.id } }))}>
              Assign matter
            </button>
          </div>
        </div>`)}
      <${EntryList} entries=${d.entries} openEditor=${openEditor} onChanged=${bumpRefresh}
        settings=${settings} runningIds=${runningEntryIds} />
```

(`fmtHours` and `Icon` are already imported in this file; the ceil-to-tenths mirrors the round-up filing rule so the ghost never understates.)

- [ ] **Step 3: `TimerGrid` — three small wirings**

In `public/js/components/timergrid.js`:

**(a)** In the `start` callback, after `await reload();` add:

```js
    if (r.entry) onEntryChanged(); // start now creates the entry — refresh Today's entries
```

**(b)** Next to the component's other `useEffect`s, add the ghost-row bridge:

```js
  // "Assign matter" on the dashboard's ghost row opens this grid's edit modal.
  useEffect(() => {
    const onEditTimer = (e) => {
      const t = timers.find((x) => x.id === e.detail.id);
      if (t) setEditing(t);
    };
    window.addEventListener('tk:edit-timer', onEditTimer);
    return () => window.removeEventListener('tk:edit-timer', onEditTimer);
  }, [timers]);
```

**(c)** Find the timer-edit `onDone` handler (~line 648: `if (saved && saved.entry) { … openEditor({ id: saved.entry.id }); }`) — a RUNNING assign now also returns an entry, but the narrative editor should only auto-open for the settled (paused) flow:

```js
          if (saved && saved.entry && !saved.running) {
```

(keep the body unchanged; when running, the reload alone is right — the entry shows up in Today's entries with the running chip).

- [ ] **Step 4: CSS**

Append to `public/css/app.css`:

```css
/* Running-entry cue (feedback 2026-07-10): the entry exists from start */
.chip.chip-running {
  color: var(--accent);
  border-color: var(--accent);
  animation: tk-running-pulse 2s ease-in-out infinite;
}
@keyframes tk-running-pulse { 50% { opacity: 0.55; } }
.entry-card.running-ghost { border-style: dashed; opacity: 0.9; }
```

(If `.chip` uses a different border convention in this file, match it — check the existing `.chip-exported` rule and mirror its approach.)

- [ ] **Step 5: Bump `CACHE` in `public/sw.js`** (current value +1).

- [ ] **Step 6: Manual verification of the exact screenshot scenario**

Restart to pick up the server half: `systemctl --user restart timekeeper`. Then in a browser on `http://localhost:4747`:
1. Start a matter timer → its entry appears in Today's entries immediately at 0.0 with a pulsing "running" chip; "Needs attention" stays quiet.
2. Start a Quick timer (no matter) → dashed ghost row appears; "Assign matter" opens the timer editor; picking a matter converts it to a real entry in place.
3. Stop the matter timer after ~1 min → same entry updates to 0.1; the no-narrative alert appears now.

- [ ] **Step 7: Commit**

```bash
git add public/js/views/dashboard.js public/js/components/entrylist.js public/js/components/timergrid.js public/css/app.css public/sw.js
git commit -m "feat(ui): entries visible from timer start — running chip + quick-timer ghost row"
```

### Task 7: Full verification + close-out

**Files:**
- Modify: `scripts/e2e-smoke.mjs` (only if timer-related steps assert stale expectations)
- Modify: `TODO.md` (remove the addressed feedback line)
- Delete: `feedback/2026-07-10T08-53-54.png`

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 2: E2E**

Run: `node scripts/e2e-smoke.mjs`
Expected: PASS. Timer steps that start a timer and then count Today's entries (or assert "No entries") will see the new start-created entry — update those expectations to the new model (an entry exists from start), never by deleting the step.

- [ ] **Step 3: Restart the live service**

Run: `systemctl --user restart timekeeper && systemctl --user status timekeeper --no-pager | head -5`
Expected: `active (running)`.

- [ ] **Step 4: Close out the TODO item**

Remove this line from `TODO.md`:

```
- [ ] 2026-07-10 08:53 — Starting a timer should automatically create an entry. (feedback/2026-07-10T08-53-54.png · #/)
```

Run: `rm feedback/2026-07-10T08-53-54.png`

- [ ] **Step 5: Commit**

```bash
git add TODO.md scripts/e2e-smoke.mjs
git commit -m "chore: close out 2026-07-10 timer-start feedback item"
```

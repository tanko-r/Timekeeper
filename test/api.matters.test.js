import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

async function withServer(fn) {
  const t = await startTestServer();
  try { await fn(t); } finally { await t.close(); }
}

// Two matters under one client + one matter under a different client.
async function seed(t) {
  const warm = (await t.fetchJson('POST', '/api/cms',
    { cm_number: '100001-000012', short_name: 'Cedar Lease' })).body;
  const cold = (await t.fetchJson('POST', '/api/cms',
    { cm_number: '100001-000099', short_name: 'New sibling' })).body;
  const other = (await t.fetchJson('POST', '/api/cms',
    { cm_number: '100005-000001', short_name: 'Unrelated client matter' })).body;
  return { warm, cold, other };
}

test('suggestions: ranked own fragments; generated narratives not double-counted', () =>
  withServer(async (t) => {
    const { warm } = await seed(t);
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-01', cm_id: warm.id,
      tasks: [
        { task_code: 'Revise', duration: 0.5, fragment: 'revise lease' },
        { task_code: 'Draft', duration: 0.3, fragment: 'draft access agreement' },
      ],
    });
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-02', cm_id: warm.id,
      tasks: [{ task_code: 'Revise', duration: 0.2, fragment: 'revise lease' }],
    });
    const r = await t.fetchJson('GET', `/api/matters/${warm.id}/suggestions`);
    assert.equal(r.status, 200);
    assert.equal(r.body.matter_id, warm.id);
    assert.equal(r.body.borrowed, false);
    const texts = r.body.phrases.map((p) => p.text);
    assert.equal(texts[0], 'revise lease'); // 2 uses beats 1
    assert.ok(texts.includes('draft access agreement'));
    // the auto-generated combined narrative must not appear as a phrase
    assert.ok(!texts.some((x) => x.includes('(0.5)')));
    const top = r.body.phrases[0];
    assert.equal(top.count, 2);
    assert.equal(top.source, 'matter');
    assert.equal(top.last_used, '2026-07-02');
    assert.ok(top.score > 0);
  }));

test('suggestions: single-line free narratives count as phrases', () =>
  withServer(async (t) => {
    const { warm } = await seed(t);
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-03', cm_id: warm.id,
      narrative: 'Review title commitment and survey.',
      tasks: [{ task_code: 'Review', duration: 0.4, fragment: '' }],
    });
    const r = await t.fetchJson('GET', `/api/matters/${warm.id}/suggestions`);
    assert.deepEqual(r.body.phrases.map((p) => p.text),
      ['Review title commitment and survey']);
  }));

test('suggestions: a cold matter borrows client siblings, not strangers', () =>
  withServer(async (t) => {
    const { warm, cold, other } = await seed(t);
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-05', cm_id: warm.id,
      tasks: [{ task_code: 'Negotiate', duration: 0.5, fragment: 'negotiate crossing agreement' }],
    });
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-05', cm_id: other.id,
      tasks: [{ task_code: 'Draft', duration: 0.5, fragment: 'unrelated stranger fragment' }],
    });
    const r = await t.fetchJson('GET', `/api/matters/${cold.id}/suggestions`);
    assert.equal(r.body.borrowed, true);
    const texts = r.body.phrases.map((p) => p.text);
    assert.ok(texts.includes('negotiate crossing agreement'));
    assert.ok(!texts.includes('unrelated stranger fragment'));
    assert.equal(r.body.phrases.find((p) => p.text === 'negotiate crossing agreement').source, 'client');
  }));

test('people: roster ranked by recency; cold sibling borrows; strangers do not', () =>
  withServer(async (t) => {
    const { warm, cold, other } = await seed(t);
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-01', cm_id: warm.id,
      narrative: 'Telephone conference with A. Turner regarding lease.',
      tasks: [{ task_code: 'Call/Conference', duration: 0.3, fragment: '' }],
    });
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-05', cm_id: warm.id,
      narrative: 'Email to B. Novak re access road; call with A. Turner re same.',
      tasks: [{ task_code: 'Correspondence', duration: 0.2, fragment: '' }],
    });
    const own = await t.fetchJson('GET', `/api/matters/${warm.id}/people`);
    assert.equal(own.status, 200);
    assert.equal(own.body.borrowed, false);
    assert.deepEqual(
      own.body.people.map((p) => [p.name, p.count, p.last_seen, p.source]),
      [['A. Turner', 2, '2026-07-05', 'matter'],
       ['B. Novak', 1, '2026-07-05', 'matter']]);

    const borrowed = await t.fetchJson('GET', `/api/matters/${cold.id}/people`);
    assert.equal(borrowed.body.borrowed, true);
    assert.deepEqual(borrowed.body.people.map((p) => [p.name, p.source]),
      [['A. Turner', 'client'], ['B. Novak', 'client']]);

    const stranger = await t.fetchJson('GET', `/api/matters/${other.id}/people`);
    assert.equal(stranger.body.borrowed, false);
    assert.deepEqual(stranger.body.people, []);
  }));

test('404 for unknown matter on both endpoints', () =>
  withServer(async (t) => {
    assert.equal((await t.fetchJson('GET', '/api/matters/9999/suggestions')).status, 404);
    assert.equal((await t.fetchJson('GET', '/api/matters/9999/people')).status, 404);
  }));

test('recent-narratives: newest first, duplicates collapsed, other matters excluded', () =>
  withServer(async (t) => {
    const { warm, other } = await seed(t);
    const add = (cmId, date, narrative) => t.fetchJson('POST', '/api/entries', {
      date, cm_id: cmId, narrative,
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
    });
    await add(warm.id, '2026-07-01', 'Call with W. Hammond regarding the lease.');
    await add(warm.id, '2026-07-02', 'Call with W. Hammond regarding the lease.');
    await add(warm.id, '2026-07-03', 'Draft response to the landlord.');
    await add(other.id, '2026-07-04', 'Unrelated matter narrative.');

    const r = await t.fetchJson('GET', `/api/matters/${warm.id}/recent-narratives`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.entries.map((e) => e.narrative), [
      'Draft response to the landlord.',
      'Call with W. Hammond regarding the lease.',
    ]);
    assert.equal(r.body.entries[1].uses, 2);
    assert.equal(r.body.entries[1].date, '2026-07-02'); // the most recent use
    assert.equal(r.body.entries[0].total, 0.5);
  }));

test('recent-narratives: limit is clamped, and a deleted entry drops out', () =>
  withServer(async (t) => {
    const { warm } = await seed(t);
    const made = [];
    for (const [date, text] of [['2026-07-01', 'One.'], ['2026-07-02', 'Two.'], ['2026-07-03', 'Three.']]) {
      made.push((await t.fetchJson('POST', '/api/entries', {
        date, cm_id: warm.id, narrative: text,
        tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
      })).body);
    }
    const one = await t.fetchJson('GET', `/api/matters/${warm.id}/recent-narratives?limit=1`);
    assert.equal(one.body.entries.length, 1);
    assert.equal(one.body.entries[0].narrative, 'Three.');

    const junk = await t.fetchJson('GET', `/api/matters/${warm.id}/recent-narratives?limit=nonsense`);
    assert.equal(junk.body.entries.length, 3);

    await t.fetchJson('DELETE', `/api/entries/${made[2].id}`);
    const after = await t.fetchJson('GET', `/api/matters/${warm.id}/recent-narratives`);
    assert.deepEqual(after.body.entries.map((e) => e.narrative), ['Two.', 'One.']);
  }));

test('recent-narratives: unknown matter is a 404', () =>
  withServer(async (t) => {
    const r = await t.fetchJson('GET', '/api/matters/9999/recent-narratives');
    assert.equal(r.status, 404);
  }));

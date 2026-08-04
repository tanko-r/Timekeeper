import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiHeaders, isAccessChallenge } from '../public/js/api.js';

// Cloudflare Access sits in front of time.* remotely. When its session lapses
// it answers every request with a 302 to tanko-r.cloudflareaccess.com — a
// different origin, which a JS fetch() cannot follow, so the call rejects with
// TypeError "Failed to fetch" and the app blames the server (2026-08-02, and
// again on mobile 2026-08-03).
//
// Measured against the live tunnel: Access answers 401 instead of 302 when the
// request carries X-Requested-With: XMLHttpRequest. A same-origin 401 is a
// response we can actually read, so the app can say "sign in again" instead of
// dying on an unreadable cross-origin hop.

test('every API request identifies itself as XHR so Access 401s instead of redirecting', () => {
  assert.equal(apiHeaders(undefined)['X-Requested-With'], 'XMLHttpRequest');
  assert.equal(apiHeaders({ a: 1 })['X-Requested-With'], 'XMLHttpRequest');
});

test('a body still gets its JSON content-type; a bodyless request does not', () => {
  assert.equal(apiHeaders({ a: 1 })['content-type'], 'application/json');
  assert.equal('content-type' in apiHeaders(undefined), false);
});

// Header lookup goes through a Headers-like object: same-origin responses
// expose every header to JS, so this is readable in the browser.
const headers = (map) => ({ get: (k) => map[k.toLowerCase()] ?? null });

test('a 401 carrying the Cloudflare-Access challenge is an expired remote session', () => {
  assert.equal(isAccessChallenge(401, headers({
    'www-authenticate': 'Cloudflare-Access resource_metadata="https://time.example.us/.well-known/x"',
  })), true);
});

test("the app's own 401 is NOT an Access challenge — it means the app password", () => {
  assert.equal(isAccessChallenge(401, headers({ 'content-type': 'application/json' })), false);
});

test('non-401 responses are never Access challenges', () => {
  const cf = headers({ 'www-authenticate': 'Cloudflare-Access resource_metadata="x"' });
  assert.equal(isAccessChallenge(200, cf), false);
  assert.equal(isAccessChallenge(500, cf), false);
});

test('an unrelated www-authenticate scheme is not an Access challenge', () => {
  assert.equal(isAccessChallenge(401, headers({ 'www-authenticate': 'Basic realm="x"' })), false);
});

test('missing or headerless responses do not crash the check', () => {
  assert.equal(isAccessChallenge(401, null), false);
  assert.equal(isAccessChallenge(401, headers({})), false);
});

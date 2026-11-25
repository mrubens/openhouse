// Who may add a recipe by its link, ask another app, or keep the screen on hands-free (screens.js, apps.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowed, PHONE_SCOPES } from '../screens.js';
import { appAllowed } from '../apps.js';
import { recipeLinkRefused } from '../app-web.js';
import { readRecipeLink } from '../cooking.js';

test('who may add a recipe by its link, and who may ask another app or be used hands-free', () => {
  assert.ok(allowed(PHONE_SCOPES.grownup, 'POST', '/house/recipe-link'), "a grown-up's phone");
  assert.ok(!allowed(PHONE_SCOPES.kid, 'POST', '/house/recipe-link'), "not a kid's");
  assert.ok(allowed(PHONE_SCOPES.grownup, 'POST', '/phone/album') && !allowed(PHONE_SCOPES.kid, 'POST', '/phone/album'), "an album's link: a grown-up's phone, not a kid's");
  assert.ok(appAllowed('POST', '/house/recipe-link', new Set(['meals'])));
  assert.ok(appAllowed('POST', '/apps/ask', null), "the household's own apps and ours");
  assert.ok(!appAllowed('POST', '/apps/ask', new Set(['meals', 'say'])), 'not a shared one');
  assert.ok(appAllowed('POST', '/home/handsfree', new Set(['say'])) && !appAllowed('POST', '/home/handsfree', new Set(['meals'])));
});

test("a shared app's recipe link is read only from a host its card said it reaches", () => {
  const none = [], some = ['www.example.com', '*.recipes.example'];
  for (const [p, b] of [['/house/recipe-link', { link: 'https://www.example.com/chili' }], ['/house/meal', { recipe: { meal: 'chili', link: 'www.example.com/chili' } }], ['/house/meal', { addText: 'www.example.com/chili' }]]) {
    assert.ok(recipeLinkRefused(p, b, none), `${p}: an app that reaches nothing`);
    assert.equal(recipeLinkRefused(p, b, some), null, `${p}: its own host`);
  }
  assert.ok(recipeLinkRefused('/house/recipe-link', { link: 'https://other.example.org/x' }, some));
  assert.ok(recipeLinkRefused('/house/recipe-link', { link: 'https://www.example.com.evil.example/x' }, some));
  assert.ok(recipeLinkRefused('/house/meal', { addText: 'other.example.org/x' }, some));
  assert.equal(recipeLinkRefused('/house/recipe-link', { link: 'https://a.recipes.example/x' }, some), null);
  assert.equal(recipeLinkRefused('/house/meal', { addText: 'something with leftover chicken' }, none), null, 'not a link');
  assert.equal(recipeLinkRefused('/house/meal', { date: '2026-11-25', meal: 'dinner', text: 'tacos' }, none), null);
});

test("a shared app's recipe link: what's checked is what's read, no sign-in in it, and no redirect off its hosts", async () => {
  const some = ['www.example.com'];
  // The house reads a link's first 400 characters: one that is another host once cut is checked as cut.
  const head = 'https://other.example:';
  const b = { link: head + '0'.repeat(400 - head.length - 3) + '443@www.example.com/chili' };
  assert.ok(recipeLinkRefused('/house/recipe-link', b, some));
  const ok = { link: '  https://www.example.com/' + 'x'.repeat(600) };
  assert.equal(recipeLinkRefused('/house/recipe-link', ok, some), null);
  assert.equal(ok.link.length, 400, 'passed on as cut');
  assert.ok(recipeLinkRefused('/house/recipe-link', { link: 'https://me:pw@www.example.com/chili' }, some));
  assert.ok(recipeLinkRefused('/house/meal', { recipe: { meal: 'chili', link: 'https://x@www.example.com/' } }, some));

  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const get = async (u) => (new URL(u).hostname === 'www.example.com' ? new Response('', { status: 302, headers: { location: 'https://elsewhere.example.org/soup' } })
    : new Response('<title>Soup</title><p>Stir it.</p>', { status: 200, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(readRecipeLink('https://www.example.com/soup', { fetch: get, lookup, reaches: some }), 'a redirect off its hosts');
  assert.ok((await readRecipeLink('https://www.example.com/soup', { fetch: get, lookup })).text, "the household's own link follows it");
});

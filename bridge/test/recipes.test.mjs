// Who may add a recipe by its link, ask another app, or keep the screen on hands-free (screens.js, apps.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowed, PHONE_SCOPES } from '../screens.js';
import { appAllowed } from '../apps.js';
import { recipeLinkRefused } from '../app-web.js';

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

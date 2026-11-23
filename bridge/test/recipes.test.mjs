// Who may add a recipe by its link, ask another app, or keep the screen on hands-free (screens.js, apps.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowed, PHONE_SCOPES } from '../screens.js';
import { appAllowed } from '../apps.js';

test('who may add a recipe by its link, and who may ask another app or be used hands-free', () => {
  assert.ok(allowed(PHONE_SCOPES.grownup, 'POST', '/house/recipe-link'), "a grown-up's phone");
  assert.ok(!allowed(PHONE_SCOPES.kid, 'POST', '/house/recipe-link'), "not a kid's");
  assert.ok(appAllowed('POST', '/house/recipe-link', new Set(['meals'])));
  assert.ok(appAllowed('POST', '/apps/ask', null), "the household's own apps and ours");
  assert.ok(!appAllowed('POST', '/apps/ask', new Set(['meals', 'say'])), 'not a shared one');
  assert.ok(appAllowed('POST', '/door/handsfree', new Set(['say'])) && !appAllowed('POST', '/door/handsfree', new Set(['meals'])));
});

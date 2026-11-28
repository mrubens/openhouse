// Who may add a recipe by its link, ask another app, or keep the screen on hands-free (screens.js, apps.js); and a
// recipe's groceries with no model (house/meals.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowed, PHONE_SCOPES } from '../screens.js';
import { appAllowed } from '../apps.js';
import { recipeLinkRefused } from '../app-web.js';
import { readRecipeLink } from '../cooking.js';
import { houseRoutes } from '../house.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('who may add a recipe by its link, and who may ask another app or be used hands-free', () => {
  assert.ok(allowed(PHONE_SCOPES.grownup, 'POST', '/house/recipe-link'), "an adult's phone");
  assert.ok(!allowed(PHONE_SCOPES.kid, 'POST', '/house/recipe-link'), "not a kid's");
  assert.ok(allowed(PHONE_SCOPES.grownup, 'POST', '/phone/album') && !allowed(PHONE_SCOPES.kid, 'POST', '/phone/album'), "an album's link: an adult's phone, not a kid's");
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

/** A household in a temp folder with tonight's dinner planned and these recipes; asked counts the model's answers. */
function kitchen(recipes, { lists } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'house-')), DIR = path.join(root, 'x'); fs.mkdirSync(DIR);
  const d = new Date(), date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  fs.writeFileSync(path.join(root, 'house.json'), JSON.stringify({ meals: { [date]: { dinner: 'Tacos' } }, recipes, starters: 1,
    ...(lists ? { lists } : {}) }));
  const k = { asked: 0, date };
  const agent = { answer: async () => { k.asked++; return '["Sour cream"]'; } };
  const board = { householdView: () => ({ family: [{ name: 'Sam' }], chores: [], calendars: [] }), saveHousehold: () => {}, calendarEvents: () => [] };
  k.h = houseRoutes({ DIR, json: () => {}, body: async () => ({}), board, currentAgent: async () => agent, agentName: () => 'cloud' });
  k.groceries = () => k.h.view().lists.find((l) => l.id === 'groceries').items.map((i) => i.text.toLowerCase()).sort();
  return k;
}

test("Add to Groceries from a recipe's own ingredients never asks the model", async () => {
  const k = kitchen({ tacos: { text: 'Tacos', notes: 'x', cook: { v: 2, name: 'Tacos', ingredients: [{ item: 'ground beef', amount: '1 lb' }, { item: 'tortillas', amount: '8' }, { item: 'onion, diced', amount: '1' }], steps: [{ text: 'Cook it.' }] } } },
    { lists: [{ id: 'groceries', name: 'Groceries', items: [{ id: 'a', text: 'Tortillas', done: false }] }, { id: 'todo', name: 'To do', items: [] }] });
  const r = await k.h.call('set_meals', { groceries: [{ date: k.date, meal: 'dinner' }] });
  assert.ok(!r.isError, r.content[0].text);
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(k.asked, 0, 'no model call');
  assert.deepEqual(k.groceries(), ['ground beef', 'onion', 'tortillas'], 'what the recipe lists, each once');
});

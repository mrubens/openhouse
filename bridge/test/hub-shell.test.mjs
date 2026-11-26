// A hub's stand-in for the shell (hub-shell.js, docs/hub.md): a card's yes needs the PIN once one is set, and a link from the assistant or a computer is kept only after a person's yes.
//   cd bridge && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubAsks, hubShell } from '../hub-shell.js';

const fakeAsks = (pinSet) => hubAsks({ hasPin: () => pinSet, pinOk: async (p) => p === '4826', log: () => {} });

test('a card that needs the PIN takes a yes only with the right one', async () => {
  const asks = fakeAsks(true);
  const waiting = asks.ask({ title: 'Put it in?', grownup: true, waitMs: 10e3 });
  const [card] = asks.list();
  assert.equal(card.pin, true);
  assert.ok((await asks.answer({ id: card.id, yes: true, pin: '1111' })).error);
  assert.equal(asks.count(), 1); // still waiting
  assert.ok((await asks.answer({ id: card.id, yes: true, pin: '4826' })).ok);
  assert.deepEqual(await waiting, { yes: true, answered: true });
});

test('a calendar the assistant sends reaches the keeper only after a yes; the setup\'s own go straight there', async () => {
  const kept = [];
  const keeper = async (p, b) => { kept.push([p, b.url]); return { ok: true, status: 200, body: { added: true } }; };
  let said = false;
  const asks = { ask: async () => ({ yes: said, answered: true }) };
  const shell = hubShell({ keeper, asks, setup: { step: () => null }, cloud: {} });
  assert.deepEqual((await shell('/calendar', { url: 'https://example.com/a.ics', from: 'Sam' })).body, { added: false });
  assert.equal(kept.length, 0);
  said = true;
  await shell('/calendar', { url: 'https://example.com/a.ics' });
  await shell('/album', { url: 'https://www.icloud.com/sharedalbum/#B0aGWZuqDGKXQ8n', trusted: true });
  assert.deepEqual(kept.map((k) => k[0]), ['/calendar', '/album']);
  // The PIN only during the setup's PIN step.
  assert.equal((await shell('/setup/pin', { pin: '4826' })).status, 409);
  // Anything the shell does that a hub doesn't is "no shell here".
  assert.equal(await shell('/camera', {}), null);
});

// Opie changing the house rules: Opie can't tell an adult from a kid, so nothing changes without a person's yes on the
// tablet's own card (with the PIN when one is set), whatever the PIN choices say.
import test from 'node:test';
import assert from 'node:assert/strict';
import { houseRulesCall } from '../house-rules.js';

function setup({ yes = false, asks = true } = {}) {
  let kept; // (undefined: the defaults)
  const cards = [];
  const host = {
    there: () => true, can: () => true,
    json: async (p) => (p === '/pin-choices' ? { pin: true, choices: [{ key: 'settings', asks }] } : null),
    call: async (p, b) => { if (p === '/approve') cards.push(b); return { ok: true, body: { yes, answered: true } }; },
  };
  const call = houseRulesCall({ read: () => kept, save: (t) => { kept = t; return t; }, host });
  return { call, cards, kept: () => kept };
}
const set = (s, text) => s.call('house_rules', { do: 'set', text });

test('a no on the tablet changes nothing, even with the Change settings switch off', async () => {
  for (const asks of [true, false]) {
    const s = setup({ yes: false, asks });
    const r = await set(s, 'Anything goes.');
    assert.equal(r.isError, true);
    assert.equal(s.kept(), undefined);
    assert.equal(s.cards.length, 1);
    assert.equal(s.cards[0].pin, true);
    assert.equal(s.cards[0].grownup, true, 'a person\'s own tap');
    assert.equal(s.cards[0].for, undefined, 'no PIN choice turns it off');
  }
});

test('a yes on the tablet saves it, and putting back the defaults takes a yes too', async () => {
  const s = setup({ yes: true, asks: false });
  await set(s, 'Adults use this too.');
  assert.equal(s.kept(), 'Adults use this too.');
  await s.call('house_rules', { do: 'defaults' });
  assert.equal(s.kept(), null);
  assert.equal(s.cards.length, 2);
});

test('POST /household/rules (the real route, to the real file): saves the text, and Defaults puts them back', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { boardRoutes } = await import('../board.js');
  const { DEFAULT_RULES } = await import('../house-rules.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-rules-')), DIR = path.join(root, 'chats');
  fs.mkdirSync(DIR);
  fs.writeFileSync(path.join(root, 'household.json'), JSON.stringify({ family: [{ name: 'Sam' }], chores: [] }));
  const json = (res, code, obj) => { res.code = code; res.body = obj; };
  const homeScreen = { migrate() {}, describe: () => '', during: async () => ({ result: { ok: false, text: 'no agent' }, notes: [] }) };
  const board = boardRoutes({ HERE: root, DIR, WORK: root, currentAgent: async () => ({}), agentName: () => 'test', json, body: async (r) => r.body, homeScreen });
  const call = async (method, p, b) => { const res = {}; await board({ method, body: b }, res, new URL('http://x' + p)); return res; };
  assert.equal((await call('GET', '/household/rules')).body.text, DEFAULT_RULES);
  const r = await call('POST', '/household/rules', { text: 'Adults use this too.' });
  assert.equal(r.code, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'household.json'), 'utf8')).rules, 'Adults use this too.');
  await call('POST', '/household/rules', { defaults: true });
  assert.equal((await call('GET', '/household/rules')).body.defaults, true);
});

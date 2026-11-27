// Opie changing the house rules respects the PIN switch (Ask for the PIN → Change settings): with a PIN set and the
// switch on, nothing changes without the tablet's own card saying yes; with it off, or no PIN, it just changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { houseRulesCall } from '../house-rules.js';

function setup({ pin = true, asks = true, yes = false, caps = ['approve', 'pin-choices'] } = {}) {
  let kept = '';
  const cards = [];
  const host = {
    there: () => true, can: (c) => caps.includes(c),
    json: async (p) => (p === '/pin-choices' ? { pin, choices: [{ key: 'settings', asks }, { key: 'apps', asks: false }] } : null),
    call: async (p, b) => { if (p === '/approve') cards.push(b); return { ok: true, body: { yes, answered: true } }; },
  };
  const call = houseRulesCall({ read: () => kept, save: (t) => { kept = t; return t; }, host });
  return { call, cards, kept: () => kept };
}
const set = (s, text) => s.call('house_rules', { do: 'set', text });

test('switch on with a PIN: the card asks for it, and a no changes nothing', async () => {
  const s = setup({ yes: false });
  const r = await set(s, 'Adults use this too.');
  assert.equal(r.isError, true);
  assert.equal(s.kept(), '');
  assert.equal(s.cards.length, 1);
  assert.equal(s.cards[0].pin, true);
  assert.equal(s.cards[0].for, 'settings');
});

test('switch on with a PIN: the PIN typed there saves it', async () => {
  const s = setup({ yes: true });
  await set(s, 'Adults use this too.');
  assert.equal(s.kept(), 'Adults use this too.');
});

test('switch off, or no PIN: saved with no card', async () => {
  for (const o of [{ asks: false }, { pin: false }]) {
    const s = setup(o);
    await set(s, 'The news is fine.');
    assert.equal(s.kept(), 'The news is fine.');
    assert.equal(s.cards.length, 0);
  }
});

test('a host that can\'t say what asks: the card with the PIN, and its no holds', async () => {
  const s = setup({ caps: ['approve'], yes: false });
  await set(s, 'The news is fine.');
  assert.equal(s.kept(), '');
  assert.equal(s.cards[0].pin, true);
});

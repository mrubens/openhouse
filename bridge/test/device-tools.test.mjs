// Opie using other apps (device-tools.js): the calls it makes to the shell's device server, and its own limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceTools, hasCardNumber } from '../device-tools.js';

/** A stand-in for the shell's device server: records what it was asked. */
function fakeShell(answer = () => ({ content: [{ type: 'text', text: 'ok' }] })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body);
    calls.push({ url, ...b });
    if (url.endsWith('/halt')) return { json: async () => ({}) };
    if (b.method === 'initialize') return { json: async () => ({ result: {} }) };
    return { json: async () => ({ result: answer(b.params.name, b.params.arguments) }) };
  };
  return { calls, fetchImpl, server: () => ({ url: 'http://127.0.0.1:8791/mcp', auth: 'Bearer t' }) };
}

test('install asks first, then goes to the shell', async () => {
  const sh = fakeShell();
  const d = deviceTools({ server: sh.server, fetchImpl: sh.fetchImpl });
  const r = await d.call('install_app', { name: 'DoorDash' });
  assert.equal(sh.calls.length, 0);
  await d.call('install_app', { name: 'DoorDash', confirmed: true });
  assert.equal(sh.calls.at(-1).params.name, 'install_app');
});

test('never types a card number; a tap needs a target', async () => {
  const sh = fakeShell();
  const d = deviceTools({ server: sh.server, fetchImpl: sh.fetchImpl });
  const r = await d.call('type', { text: '4111 1111 1111 1111' });
  assert.equal(r.isError, true);
  assert.equal((await d.call('tap', {})).isError, true);
  assert.equal(sh.calls.length, 0);
  assert.equal(hasCardNumber('two large pizzas'), false);
});

test('a tap passes on confirmed only when it is a real true (a spoken yes for something hard to take back)', async () => {
  const sh = fakeShell();
  const d = deviceTools({ server: sh.server, fetchImpl: sh.fetchImpl });
  await d.call('tap', { id: 4, confirmed: true });
  assert.deepEqual(sh.calls.at(-1).params.arguments, { id: 4, confirmed: true });
  await d.call('tap', { id: 4, confirmed: 'yes' }); // only a real true
  assert.deepEqual(sh.calls.at(-1).params.arguments, { id: 4 });
});

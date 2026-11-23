// Phones and screens paired before talking came (2026-11-20) get 'voice' when they may ask (screens.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { screensRoutes } from '../screens.js';

test("a phone or screen that may ask gets 'voice'; a kid's phone, a TV and a computer don't", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-voice-')), FILE = path.join(dir, 'screens.json');
  fs.writeFileSync(FILE, JSON.stringify({ lan: false, screens: [
    { id: 's-sam', kind: 'phone', person: 'Sam', key: 'k', scopes: ['door', 'arrange', 'ask', 'notify'] },
    { id: 's-leo', kind: 'phone', person: 'Leo', key: 'k', scopes: ['door', 'arrange', 'notify'] },
    { id: 's-old', key: 'k', scopes: ['door', 'arrange', 'ask'] },
    { id: 's-tv', kind: 'tv', key: 'k', scopes: ['door'] },
    { id: 'c-mac', kind: 'computer', key: 'k', scopes: ['workshop'] },
  ] }));
  const s = screensRoutes({ HERE: dir, FILE, json: () => {}, body: async () => ({}), dispatch: () => {} });
  try {
    assert.ok(s.who('s-sam').scopes.includes('voice')); assert.equal(s.who('s-sam').person, 'Sam');
    assert.ok(s.who('s-old').scopes.includes('voice'));
    for (const id of ['s-leo', 's-tv', 'c-mac']) assert.ok(!s.who(id).scopes.includes('voice'), id);
    assert.ok(JSON.parse(fs.readFileSync(FILE, 'utf8')).screens[0].scopes.includes('voice')); // kept
  } finally { s.stop?.(); }
});

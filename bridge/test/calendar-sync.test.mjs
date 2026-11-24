// Two-way calendars (calendar-sync.js): a change made on the tablet reaches Google or iCloud once, never twice, and
// isn't lost when the answer is, or when the bridge restarts before it was sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { calendarSync } from '../calendar-sync.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-sync-')), 'calendar-sync.json');

/** A pretend Google Calendar behind a pretend shell. `drop`: the next n answers are lost after the change is made. */
function fakeGoogle() {
  const events = new Map();
  const g = { events, drop: 0, offline: false, calls: 0 };
  g.shell = async (p, b) => {
    if (p === '/calendar/accounts') return { accounts: [{ id: 'a1', provider: 'google', name: 'Sam' }] };
    if (p !== '/calendar/request') return { error: 'no' };
    if (g.offline) return { error: 'The display didn\'t answer.' };
    g.calls++;
    const u = new URL(b.url), m = b.method;
    let out;
    if (u.pathname.endsWith('/users/me/calendarList')) out = { status: 200, body: JSON.stringify({ items: [{ id: 'family@example.com', summary: 'Family', accessRole: 'owner', primary: true }] }) };
    else if (m === 'GET') out = { status: 200, body: JSON.stringify({ items: [...events.values()] }) };
    else if (m === 'POST') {
      const e = JSON.parse(b.body);
      if (events.has(e.id)) out = { status: 409, body: '{}' };
      else { events.set(e.id, { ...e, etag: '"1"', status: 'confirmed' }); out = { status: 200, body: JSON.stringify({ etag: '"1"' }) }; }
    } else out = { status: 405, body: '' };
    if (g.drop > 0 && m !== 'GET') { g.drop--; return { error: 'The display didn\'t answer.' }; } // made, but the answer never came back
    return out;
  };
  return g;
}

const soon = () => { const d = new Date(Date.now() + 2 * 86400e3); d.setHours(16, 0, 0, 0); return d; };
const fields = () => ({ title: 'Swim', start: soon().toISOString(), end: new Date(soon().getTime() + 3600e3).toISOString(), allDay: false, who: null });

test('an event added on the tablet goes into Google once, even when the first answer is lost', async () => {
  const g = fakeGoogle(), FILE = tmp();
  const s = calendarSync({ FILE, shell: g.shell, log: () => {} });
  assert.ok((await s.discover('a1')).ok);
  g.drop = 1;
  const r = s.add(fields());
  assert.ok(r?.ok);
  await s.flush();
  assert.equal(g.events.size, 1);
  assert.equal(s.status().waiting, 1, 'kept to try again: the answer was lost');
  // Tried again: it's already there (the same id), so it isn't added a second time.
  const state = JSON.parse(fs.readFileSync(FILE, 'utf8')); for (const o of state.outbox) o.next = 0; fs.writeFileSync(FILE, JSON.stringify(state));
  const again = calendarSync({ FILE, shell: g.shell, log: () => {} });
  await again.flush();
  assert.equal(g.events.size, 1);
  assert.equal(again.status().waiting, 0);
  await again.pull();
  assert.equal(again.events().filter((e) => e.title === 'Swim').length, 1, 'shown once (not once from Google and once waiting)');
  s.stop(); again.stop();
});

test('a change made while Google can\'t be reached waits, through a restart, and then goes in', async () => {
  const g = fakeGoogle(), FILE = tmp();
  const s = calendarSync({ FILE, shell: g.shell, log: () => {} });
  await s.discover('a1');
  g.offline = true;
  s.add(fields());
  await s.flush();
  assert.equal(g.events.size, 0);
  assert.equal(s.events().filter((e) => e.title === 'Swim').length, 1, 'shown on the tablet meanwhile');
  s.stop();
  // The bridge restarts; then Google answers again.
  g.offline = false;
  const state = JSON.parse(fs.readFileSync(FILE, 'utf8')); for (const o of state.outbox) o.next = 0; fs.writeFileSync(FILE, JSON.stringify(state));
  const after = calendarSync({ FILE, shell: g.shell, log: () => {} });
  await after.flush();
  assert.equal(g.events.size, 1);
  assert.equal(after.status().waiting, 0);
  after.stop();
});

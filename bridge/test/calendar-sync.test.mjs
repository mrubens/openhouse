// Two-way calendars (calendar-sync.js): a change made on the tablet reaches Google or iCloud once, never twice, and
// isn't lost when the answer is, or when the bridge restarts before it was sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { calendarSync } from '../calendar-sync.js';
import { parse } from '../calendar.js';

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

/** A pretend iCloud calendar (CalDAV) holding one event file, behind a pretend shell; the file's text is `ics`. */
function fakeCalDav(ics) {
  const d = { ics, puts: [] };
  const ms = (xml) => ({ status: 207, body: `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${xml}</d:multistatus>` });
  const ok = (href, prop) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  d.shell = async (p, b) => {
    if (p === '/calendar/accounts') return { accounts: [{ id: 'a1', provider: 'caldav', name: 'Alex', server: 'https://caldav.example.com/' }] };
    if (p !== '/calendar/request') return { error: 'no' };
    const u = new URL(b.url);
    if (b.method === 'PROPFIND' && /current-user-principal/.test(b.body)) return ms(ok('/', '<d:current-user-principal><d:href>/1/principal/</d:href></d:current-user-principal>'));
    if (b.method === 'PROPFIND' && /calendar-home-set/.test(b.body)) return ms(ok('/1/principal/', '<c:calendar-home-set><d:href>/1/calendars/</d:href></c:calendar-home-set>'));
    if (b.method === 'PROPFIND') return ms(ok('/1/calendars/home/', '<d:displayname>Home</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'));
    if (b.method === 'REPORT') return ms(ok('/1/calendars/home/swim.ics', `<d:getetag>"${d.puts.length}"</d:getetag><c:calendar-data>${d.ics.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</c:calendar-data>`));
    if (b.method === 'PUT' && u.pathname === '/1/calendars/home/swim.ics') { d.puts.push(b.body); d.ics = b.body; return { status: 204, headers: { etag: `"${d.puts.length}"` } }; }
    return { status: 405, body: '' };
  };
  return d;
}
const series = (rule) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:swim-1', 'DTSTART;TZID=America/Los_Angeles:20261110T170000',
  'DTEND;TZID=America/Los_Angeles:20261110T180000', `RRULE:${rule}`, 'SUMMARY:Swim', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

for (const [rule, kind] of [['FREQ=DAILY', 'daily'], ['FREQ=WEEKLY', 'weekly']]) {
  test(`removing one day of a ${kind} 5 PM event behind UTC takes off that day on iCloud, not the next`, async () => {
    const d = fakeCalDav(series(rule)), FILE = tmp(), now = () => Date.parse('2026-12-01T12:00:00Z');
    const s = calendarSync({ FILE, shell: d.shell, now, log: () => {} });
    assert.ok((await s.discover('a1')).ok);
    await s.pull();
    // Tuesday Dec 8, 5 PM in Los Angeles: already Dec 9 in UTC.
    const one = s.events().find((e) => e.start === '2026-12-09T01:00:00.000Z');
    assert.ok(one?.editable && one.date);
    assert.ok(s.remove(one.id, one.date)?.ok);
    await s.flush();
    assert.equal(d.puts.length, 1);
    assert.match(d.puts[0], /\r\nEXDATE;TZID=America\/Los_Angeles:20261208T170000\r\n/);
    const starts = parse(d.ics, Date.parse('2026-12-01'), Date.parse('2026-12-31')).map((e) => e.start);
    assert.ok(!starts.includes('2026-12-09T01:00:00.000Z'), 'that day is gone');
    assert.ok(starts.includes(kind === 'daily' ? '2026-12-10T01:00:00.000Z' : '2026-12-16T01:00:00.000Z'), 'the next one stays');
    assert.ok(starts.includes(kind === 'daily' ? '2026-12-08T01:00:00.000Z' : '2026-12-02T01:00:00.000Z'), 'the one before stays');
    s.stop();
  });
}

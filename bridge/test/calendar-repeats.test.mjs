// Repeating events changed from one of their times: only that time, that time and every one after, or all of them,
// in Opie's own events, in Google and in iCloud (CalDAV), with made-up series. Nothing else in a series moves or goes.
process.env.TZ = 'America/Los_Angeles'; // the tablet's zone (set before any date is made)
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { calendarSync } from '../calendar-sync.js';
import { parse } from '../calendar.js';
import { houseRoutes } from '../house.js';

const NOW = Date.parse('2026-12-01T12:00:00-08:00');
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-rep-')), 'calendar-sync.json');
const day = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const clock = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const houseWith = (sync = null) => {
  const DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-rep-house-')), 'x'); fs.mkdirSync(DIR);
  const board = { householdView: () => ({ family: [{ name: 'Maya' }], chores: [], calendars: [] }), saveHousehold: () => {}, calendarEvents: () => (sync ? sync.events() : []), ...(sync ? { sync } : {}) };
  const h = houseRoutes({ DIR, json: () => {}, body: async () => ({}), board });
  const call = async (a) => { const r = await h.call('calendar_event', a); assert.ok(!r.isError, r.content[0].text); return JSON.parse(r.content[0].text); };
  return { h, call };
};

// ---- Opie's own events: Maya's swim, Tuesdays at 5 PM from Nov 10 ----
for (const scope of ['one', 'following', 'all']) {
  test(`Opie's own weekly event, moved to 6 PM from Dec 8 (${scope})`, async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    try {
      const { h, call } = houseWith();
      const { event } = await call({ add: { title: 'Swim', start: '2026-11-10T17:00', who: 'Maya', repeat: 'weekly' } });
      await call({ update: { id: event.id, date: '2026-12-08', scope, start: '2026-12-08T18:00' } });
      const at = Object.fromEntries(h.localEvents().filter((e) => e.title === 'Swim').map((e) => [day(e.start), clock(e.start)]));
      const want = { one: ['17:00', '18:00', '17:00'], following: ['17:00', '18:00', '18:00'], all: ['18:00', '18:00', '18:00'] }[scope];
      assert.deepEqual([at['2026-12-01'], at['2026-12-08'], at['2026-12-15']], want);
      assert.equal(Object.keys(at).filter((d) => d === '2026-12-08').length, 1, 'that day once');
      assert.equal(h.localEvents().filter((e) => e.title === 'Swim' && day(e.start) === '2026-12-08').length, 1, 'not twice on that day');
    } finally { mock.timers.reset(); }
  });
}

test('Opie\'s own custom repeat: Tuesdays and Thursdays, every other week, four times', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  try {
    const { h, call } = houseWith();
    await call({ add: { title: 'Piano', start: '2026-12-01T16:00', rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=4' } });
    assert.deepEqual(h.localEvents().filter((e) => e.title === 'Piano').map((e) => day(e.start)), ['2026-12-01', '2026-12-03', '2026-12-15', '2026-12-17']);
  } finally { mock.timers.reset(); }
});

// ---- Google: a pretend Calendar API holding one weekly series; every write is kept to look at ----
function fakeGoogle() {
  const g = { writes: [], series: { id: 'swim1', summary: 'Swim', etag: '"m1"', status: 'confirmed', recurrence: ['RRULE:FREQ=WEEKLY'],
    start: { dateTime: '2026-11-10T17:00:00-08:00', timeZone: 'America/Los_Angeles' }, end: { dateTime: '2026-11-10T18:00:00-08:00', timeZone: 'America/Los_Angeles' } } };
  const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  g.shell = async (p, b) => {
    if (p === '/calendar/accounts') return { accounts: [{ id: 'a1', provider: 'google', name: 'Sam' }] };
    if (p !== '/calendar/request') return { error: 'no' };
    const u = new URL(b.url);
    if (u.pathname.endsWith('/users/me/calendarList')) return { status: 200, body: JSON.stringify({ items: [{ id: 'family@example.com', summary: 'Family', accessRole: 'owner', primary: true }] }) };
    if (b.method === 'GET' && u.searchParams.get('singleEvents') === 'false') return { status: 200, body: JSON.stringify({ items: [g.series] }) };
    if (b.method === 'GET') { // each week's time, from the series
      const s0 = Date.parse(g.series.start.dateTime), items = [];
      for (let i = 0; i < 12; i++) { const t = s0 + i * 7 * 864e5; items.push({ id: `swim1_${stamp(t)}`, recurringEventId: 'swim1', summary: 'Swim', etag: `"i${i}"`, status: 'confirmed', start: { dateTime: new Date(t).toISOString() }, end: { dateTime: new Date(t + 3600e3).toISOString() } }); }
      return { status: 200, body: JSON.stringify({ items }) };
    }
    g.writes.push({ method: b.method, path: decodeURIComponent(u.pathname.split('/events')[1] || ''), body: b.body ? JSON.parse(b.body) : null, ifMatch: b.headers?.['if-match'] || null });
    return { status: 200, body: JSON.stringify({ etag: '"new"' }) };
  };
  return g;
}
async function googleChange(scope) {
  const g = fakeGoogle();
  const s = calendarSync({ FILE: tmp(), shell: g.shell, now: () => NOW, log: () => {} });
  await s.discover('a1'); await s.pull();
  const one = s.events().find((e) => e.title === 'Swim' && e.date === '2026-12-08');
  assert.ok(one?.editable && one.repeat === 'weekly');
  const { call } = houseWith(s);
  await call({ update: { id: one.id, date: one.date, scope, start: '2026-12-08T18:00' } });
  await s.flush();
  s.stop();
  return { g, s };
}
test('Google, this one: only that time is changed (Google\'s exception), the series stays', async () => {
  const { g } = await googleChange('one');
  assert.equal(g.writes.length, 1);
  const [w] = g.writes;
  assert.equal(w.method, 'PATCH'); assert.match(w.path, /^\/swim1_20261209T010000Z$/, 'that time\'s own id');
  assert.equal(w.body.recurrence, undefined, 'nothing about the repeat');
  assert.equal(clock(w.body.start.dateTime), '18:00');
});
test('Google, this and following: a new series from that time, and the old one ends before it', async () => {
  const { g } = await googleChange('following');
  const post = g.writes.find((w) => w.method === 'POST'), patch = g.writes.find((w) => w.method === 'PATCH');
  assert.ok(post && patch, JSON.stringify(g.writes));
  assert.equal(day(post.body.start.dateTime), '2026-12-08'); assert.equal(clock(post.body.start.dateTime), '18:00');
  assert.deepEqual(post.body.recurrence, ['RRULE:FREQ=WEEKLY']);
  assert.equal(patch.path, '/swim1'); assert.equal(patch.ifMatch, '"m1"');
  assert.deepEqual(patch.body.recurrence, ['RRULE:FREQ=WEEKLY;UNTIL=20261209T005959Z'], 'its last time is Dec 1');
  assert.ok(g.writes.indexOf(post) < g.writes.indexOf(patch), 'the new one first: a lost answer never leaves the times after it gone');
});
test('Google, all: the whole series moves by an hour, from its own first time', async () => {
  const { g } = await googleChange('all');
  assert.equal(g.writes.length, 1);
  const [w] = g.writes;
  assert.equal(w.path, '/swim1');
  assert.equal(day(w.body.start.dateTime), '2026-11-10', 'from its first time, not that day'); assert.equal(clock(w.body.start.dateTime), '18:00');
  assert.equal(w.body.recurrence, undefined, 'its rule is left as Google has it');
});

// ---- iCloud (CalDAV): one event file holding a weekly series ----
function fakeCalDav() {
  const d = { files: { '/1/calendars/home/swim.ics': ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:swim-1', 'DTSTART;TZID=America/Los_Angeles:20261110T170000',
    'DTEND;TZID=America/Los_Angeles:20261110T180000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Swim', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n') }, puts: [] };
  const ms = (xml) => ({ status: 207, body: `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${xml}</d:multistatus>` });
  const ok = (href, prop) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  d.shell = async (p, b) => {
    if (p === '/calendar/accounts') return { accounts: [{ id: 'a1', provider: 'caldav', name: 'Alex', server: 'https://caldav.example.com/' }] };
    if (p !== '/calendar/request') return { error: 'no' };
    const u = new URL(b.url);
    if (b.method === 'PROPFIND' && /current-user-principal/.test(b.body)) return ms(ok('/', '<d:current-user-principal><d:href>/1/principal/</d:href></d:current-user-principal>'));
    if (b.method === 'PROPFIND' && /calendar-home-set/.test(b.body)) return ms(ok('/1/principal/', '<c:calendar-home-set><d:href>/1/calendars/</d:href></c:calendar-home-set>'));
    if (b.method === 'PROPFIND') return ms(ok('/1/calendars/home/', '<d:displayname>Home</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'));
    if (b.method === 'REPORT') return ms(Object.entries(d.files).map(([f, ics]) => ok(f, `<d:getetag>"${d.puts.length}"</d:getetag><c:calendar-data>${ics.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</c:calendar-data>`)).join(''));
    if (b.method === 'PUT') { d.puts.push(u.pathname); d.files[u.pathname] = b.body; return { status: 204, headers: { etag: `"${d.puts.length}"` } }; }
    if (b.method === 'GET') return d.files[u.pathname] ? { status: 200, body: d.files[u.pathname] } : { status: 404, body: '' };
    return { status: 405, body: '' };
  };
  /** Every time of every file between Nov 1 and Jan 1, by day: its start time. */
  d.times = () => { const out = {}; for (const ics of Object.values(d.files)) for (const e of parse(ics, Date.parse('2026-11-01T00:00-08:00'), Date.parse('2027-01-01T00:00-08:00'))) (out[day(e.start)] ||= []).push(clock(e.start)); return out; };
  return d;
}
for (const scope of ['one', 'following', 'all']) {
  test(`iCloud, ${scope}: Swim moved to 6 PM from Dec 8, and only the times asked for move`, async () => {
    const d = fakeCalDav();
    const s = calendarSync({ FILE: tmp(), shell: d.shell, now: () => NOW, log: () => {} });
    await s.discover('a1'); await s.pull();
    const one = s.events().find((e) => e.title === 'Swim' && e.date === '2026-12-08');
    assert.ok(one?.editable && one.repeat === 'weekly');
    const { call } = houseWith(s);
    await call({ update: { id: one.id, date: one.date, scope, start: '2026-12-08T18:00' } });
    await s.flush();
    const t = d.times();
    const want = { one: [['17:00'], ['18:00'], ['17:00']], following: [['17:00'], ['18:00'], ['18:00']], all: [['18:00'], ['18:00'], ['18:00']] }[scope];
    assert.deepEqual([t['2026-12-01'], t['2026-12-08'], t['2026-12-15']], want, JSON.stringify(Object.values(d.files)));
    assert.deepEqual(t['2026-11-10'], [scope === 'all' ? '18:00' : '17:00'], 'its first time');
    assert.equal(Object.keys(d.files).length, scope === 'following' ? 2 : 1, 'a new file only for the times after');
    await s.pull();
    assert.equal(s.events().filter((e) => e.title === 'Swim' && e.date === '2026-12-08').length, 1, 'read back: that day once');
    s.stop();
  });
}

test('a calendar read from a link can\'t be changed, by any scope', async () => {
  const synced = [{ title: 'Swim', start: '2026-12-09T01:00:00.000Z', end: '2026-12-09T02:00:00.000Z', allDay: false, who: 'Maya', uid: 'swim@sample|2026-12-09' }];
  const DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-rep-house-')), 'x'); fs.mkdirSync(DIR);
  const board = { householdView: () => ({ family: [{ name: 'Maya' }], chores: [], calendars: [] }), saveHousehold: () => {}, calendarEvents: () => synced };
  const h = houseRoutes({ DIR, json: () => {}, body: async () => ({}), board });
  const r = await h.call('calendar_event', { update: { id: 'swim@sample|2026-12-09', date: '2026-12-08', scope: 'one', start: '2026-12-08T18:00' } });
  assert.ok(r.isError);
});

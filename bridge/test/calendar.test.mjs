// A household's calendar feeds read right (calendar.js parse): every time a repeating event comes up shows once, on
// its day, at its wall-clock time, across the US daylight-saving changes; skipped and moved days stay that way.
// A small made-up corpus in the shape Google, iCloud and Outlook send.
//   cd bridge && npm test
process.env.TZ = 'America/Chicago'; // the tablet's zone (set before any date is made)
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '../calendar.js';
import { houseRoutes } from '../house.js';

const ics = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sample//EN', ...events.flat(), 'END:VCALENDAR', ''].join('\r\n');
const ev = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const local = (s) => new Date(s).getTime(); // "2026-10-20T16:00" in the tablet's zone
const day = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const clock = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const of = (list, title) => list.filter((e) => e.title === title);

const FEED = ics(
  // Maya's swim: Tuesdays and Thursdays at 4, until Nov 12; the 29th off, the Nov 5th one moved to 5:30.
  ev('UID:swim@sample', 'DTSTART;TZID=America/Chicago:20261020T160000', 'DTEND;TZID=America/Chicago:20261020T170000',
    'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261112T220000Z', 'EXDATE;TZID=America/Chicago:20261029T160000', 'SUMMARY:Swim',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT15M', 'END:VALARM'),
  ev('UID:swim@sample', 'RECURRENCE-ID;TZID=America/Chicago:20261105T160000', 'DTSTART;TZID=America/Chicago:20261105T173000',
    'DTEND;TZID=America/Chicago:20261105T183000', 'SUMMARY:Swim (late lane)'),
  // Leo's soccer, from a calendar kept on Pacific time: Sundays at 9 there, five times.
  ev('UID:soccer@sample', 'DTSTART;TZID=America/Los_Angeles:20261018T090000', 'DTEND;TZID=America/Los_Angeles:20261018T100000',
    'RRULE:FREQ=WEEKLY;COUNT=5', 'SUMMARY:Soccer', 'LOCATION:Springfield Park\\, field 2'),
  // Sam's walk, daily at 7 since 2024 (a long series: the window starts near today, not at its first day).
  ev('UID:walk@sample', 'DTSTART;TZID=America/Chicago:20240101T070000', 'DURATION:PT30M', 'RRULE:FREQ=DAILY', 'SUMMARY:Walk'),
  // Alex's class, daily at 8 for 5 days across the change.
  ev('UID:class@sample', 'DTSTART;TZID=America/Chicago:20261030T080000', 'DTEND;TZID=America/Chicago:20261030T090000',
    'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Class'),
  // Trash day: all day, Sundays, through Nov 15 (inclusive), one Sunday skipped.
  ev('UID:trash@sample', 'DTSTART;VALUE=DATE:20261025', 'DTEND;VALUE=DATE:20261026', 'RRULE:FREQ=WEEKLY;UNTIL=20261115',
    'EXDATE;VALUE=DATE:20261108', 'SUMMARY:Trash day'),
  // A one-off in UTC, and a cancelled one.
  ev('UID:call@sample', 'DTSTART:20261103T150000Z', 'DTEND:20261103T153000Z', 'SUMMARY:Call'),
  ev('UID:gone@sample', 'DTSTART:20261104T150000Z', 'STATUS:CANCELLED', 'SUMMARY:Gone'),
);
const ALL = parse(FEED, local('2026-10-01T00:00'), local('2026-12-01T00:00'));

test('a weekly event on two weekdays: each day once at 4 PM across the November change; a skipped day stays off, a moved one moves', () => {
  const swim = of(ALL, 'Swim');
  assert.deepEqual(swim.map((e) => day(e.start)), ['2026-10-20', '2026-10-22', '2026-10-27', '2026-11-03', '2026-11-10', '2026-11-12']);
  assert.ok(swim.every((e) => clock(e.start) === '16:00' && clock(e.end) === '17:00'));
  const moved = of(ALL, 'Swim (late lane)');
  assert.equal(moved.length, 1);
  assert.equal(day(moved[0].start), '2026-11-05'); assert.equal(clock(moved[0].start), '17:30');
  // Every time it comes up has its own id, and the same one at the next sync.
  const ids = [...swim, ...moved].map((e) => e.uid);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(parse(FEED, local('2026-10-01T00:00'), local('2026-12-01T00:00')).map((e) => e.uid), ALL.map((e) => e.uid));
});

test('an event in another zone keeps that zone\'s wall-clock time when both change, and COUNT stops it', () => {
  const soccer = of(ALL, 'Soccer');
  assert.deepEqual(soccer.map((e) => day(e.start)), ['2026-10-18', '2026-10-25', '2026-11-01', '2026-11-08', '2026-11-15']);
  assert.ok(soccer.every((e) => clock(e.start) === '11:00')); // 9 in Los Angeles is 11 here, before and after
  assert.equal(soccer[0].place, 'Springfield Park, field 2');
});

test('a daily series across the fall and spring changes: one a day, same time, no day skipped or repeated', () => {
  const fall = of(parse(FEED, local('2026-10-28T00:00'), local('2026-11-05T00:00')), 'Walk');
  assert.deepEqual(fall.map((e) => day(e.start)), ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
  assert.ok(fall.every((e) => clock(e.start) === '07:00' && clock(e.end) === '07:30'));
  const spring = of(parse(FEED, local('2027-03-12T00:00'), local('2027-03-17T00:00')), 'Walk');
  assert.deepEqual(spring.map((e) => day(e.start)), ['2027-03-12', '2027-03-13', '2027-03-14', '2027-03-15', '2027-03-16']);
  assert.ok(spring.every((e) => clock(e.start) === '07:00'));
  const cls = of(ALL, 'Class');
  assert.deepEqual(cls.map((e) => day(e.start)), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
  assert.ok(cls.every((e) => clock(e.start) === '08:00' && clock(e.end) === '09:00'));
});

test('an all-day series: each day from its midnight to the next, the skipped one off, UNTIL\'s day included', () => {
  const trash = of(ALL, 'Trash day');
  assert.deepEqual(trash.map((e) => day(e.start)), ['2026-10-25', '2026-11-01', '2026-11-15']);
  for (const e of trash) {
    assert.equal(e.allDay, true);
    assert.equal(clock(e.start), '00:00'); assert.equal(clock(e.end), '00:00');
    const next = new Date(e.start); next.setDate(next.getDate() + 1);
    assert.equal(day(e.end), day(next)); // (Nov 1 is 25 hours long: the end is still the next midnight)
  }
  // The spring change: a 23-hour day doesn't spill into Monday.
  const spring = parse(ics(ev('UID:bins@sample', 'DTSTART;VALUE=DATE:20270307', 'DTEND;VALUE=DATE:20270308', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Bins')),
    local('2027-03-01T00:00'), local('2027-04-01T00:00'));
  assert.deepEqual(spring.map((e) => [day(e.start), day(e.end), clock(e.end)]), [['2027-03-07', '2027-03-08', '00:00'], ['2027-03-14', '2027-03-15', '00:00'], ['2027-03-21', '2027-03-22', '00:00']]);
});

test('a one-off in UTC shows at its local time; a cancelled one doesn\'t show', () => {
  const call = of(ALL, 'Call');
  assert.equal(call.length, 1); assert.equal(day(call[0].start), '2026-11-03'); assert.equal(clock(call[0].start), '09:00');
  assert.equal(of(ALL, 'Gone').length, 0);
});

test('events added on the tablet, repeating across the spring change: same time each week, an all-day one on its day only', async () => {
  mock.timers.enable({ apis: ['Date'], now: local('2027-03-01T10:00') });
  try {
    const DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'house-')), 'x'); fs.mkdirSync(DIR);
    const board = { householdView: () => ({ family: [{ name: 'Leo' }], chores: [], calendars: [] }), saveHousehold: () => {}, calendarEvents: () => [] };
    const h = houseRoutes({ DIR, json: () => {}, body: async () => ({}), board });
    for (const add of [{ title: 'Bins', start: '2027-03-07', repeat: 'weekly' }, { title: 'Piano', start: '2027-03-04T16:00', repeat: 'weekly', who: 'Leo' }]) {
      const r = await h.call('calendar_event', { add }); assert.ok(!r.isError, r.content[0].text);
    }
    const bins = h.localEvents().filter((e) => e.title === 'Bins').slice(0, 3);
    assert.deepEqual(bins.map((e) => [day(e.start), clock(e.start), day(e.end), clock(e.end)]),
      [['2027-03-07', '00:00', '2027-03-08', '00:00'], ['2027-03-14', '00:00', '2027-03-15', '00:00'], ['2027-03-21', '00:00', '2027-03-22', '00:00']]);
    const piano = h.localEvents().filter((e) => e.title === 'Piano').slice(0, 3);
    assert.deepEqual(piano.map((e) => [day(e.start), clock(e.start), clock(e.end)]), [['2027-03-04', '16:00', '17:00'], ['2027-03-11', '16:00', '17:00'], ['2027-03-18', '16:00', '17:00']]);
  } finally { mock.timers.reset(); }
});

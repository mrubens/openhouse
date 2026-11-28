// Email to the tablet (mail.js): only approved, verified senders' mail is read; anything else waits, unread, for a
// person's Allow. Mail sealed in the cloud opens only with this tablet's key, and leaves the cloud once it's taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mailRoutes } from '../mail.js';
import { newMailKey, seal, open } from '../mail-seal.js';
import { houseRoutes } from '../house.js';

// Made-up mail in the shapes that arrive (forwards from Gmail, Outlook and Apple Mail, a PDF, a picture-only flyer, an
// invite, five events, none, one giving orders): bridge/test/mail/*.eml. The same files go through the cloud's stand-in
// (docs/tablet-email.md, "Trying it").
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mail');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

const msg = (from, verdict = 'dmarc=pass') => Buffer.from([`Authentication-Results: mx.example.net; ${verdict}`, `From: ${from}`, 'Subject: Book fair', 'Content-Type: text/plain', '', 'Book fair Friday at 3.', ''].join('\r\n'));

function setup({ cloud = null, shell = null } = {}) {
  const DISPLAY = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-mail-'));
  const reads = [];
  const house = { readEmail: async (m) => { reads.push(m); return { photos: [], events: 1 }; } };
  const mail = mailRoutes({ DISPLAY, json: () => {}, body: async () => ({}), house, cloud, shell, every: 0, log: () => {} });
  return { mail, reads, DISPLAY };
}

test('mail from someone not on the list is held unread until a person allows it', async () => {
  const { mail, reads } = setup();
  await mail.set({ own: true, senders: [{ address: 'sam@example.com', who: 'Sam' }] });
  await mail.receive(msg('Mallory <mallory@example.org>'), 'imap');
  assert.equal(reads.length, 0);
  assert.equal(mail.view().held.length, 1);
  await mail.receive(msg('Sam <sam@example.com>'), 'imap');
  assert.equal(reads.length, 1);
  await mail.held({ id: mail.view().held[0].id, allow: true });
  assert.equal(reads.length, 2);
  assert.equal(mail.view().held.length, 0);
  assert.ok(mail.view().senders.some((s) => s.address === 'mallory@example.org'));
});

test('a forged From (DMARC failed, or no verdict) is held even from an approved address', async () => {
  const { mail, reads } = setup();
  await mail.set({ own: true, senders: [{ address: 'sam@example.com', who: 'Sam' }] });
  await mail.receive(msg('Sam <sam@example.com>', 'dmarc=fail'), 'imap');
  await mail.receive(Buffer.from('From: sam@example.com\r\nSubject: x\r\n\r\nhi\r\n'), 'imap');
  assert.equal(reads.length, 0);
  assert.equal(mail.view().held.length, 2);
  assert.ok(mail.view().held.every((h) => h.unverified));
});

test('held mail is capped and deleted, unread, when someone says no', async () => {
  const { mail, reads, DISPLAY } = setup();
  for (let i = 0; i < 12; i++) await mail.receive(msg(`x${i}@example.org`), 'imap');
  assert.equal(mail.view().held.length, 10);
  await mail.held({ id: mail.view().held[0].id, allow: false });
  assert.equal(reads.length, 0);
  assert.equal(fs.readdirSync(path.join(DISPLAY, 'mail')).length, 9);
});

test('cloud mail opens only with this tablet\'s key, and is removed from the cloud once taken', async () => {
  const done = [];
  let tabletKey = null;
  const waiting = new Map();
  const cloud = {
    credential: () => 'lh1_x',
    mailApi: async (method, p, b) => {
      if (p === '/v1/mail') { tabletKey = b.key; return { address: 'maple-otter-42', hashKey: 'a2V5', accounts: ['sam@example.com'] }; }
      if (p === '/v1/mail/senders') return { ok: true };
      if (p === '/v1/mail/waiting') return [...waiting.keys()].map((key) => ({ key }));
      if (p === '/v1/mail/done') { done.push(b.key); waiting.delete(b.key); return { ok: true }; }
    },
    mailFetch: async (key) => waiting.get(key),
  };
  const { mail, reads } = setup({ cloud });
  await mail.poll();
  assert.ok(tabletKey);
  assert.ok(mail.view().senders.some((s) => s.address === 'sam@example.com'), 'the account\'s address is approved');
  waiting.set('mail/a', seal(tabletKey, msg('Sam <sam@example.com>')));
  waiting.set('mail/b', seal(newMailKey().pub, msg('Sam <sam@example.com>'))); // sealed for some other tablet
  await mail.poll();
  assert.equal(reads.length, 1);
  assert.deepEqual(done.sort(), ['mail/a', 'mail/b']);
  assert.throws(() => open(newMailKey(), seal(tabletKey, Buffer.from('x'))));
});

test('every shape of mail that arrives is read with its words, pictures, PDF pages and invite: nothing lost on the way', async () => {
  const shell = async (p) => (p === '/mail/pdf' ? { pages: [Buffer.from('page').toString('base64')] } : null);
  const { mail, reads } = setup({ shell });
  await mail.set({ own: true, senders: [{ address: 'sam@example.com', who: 'Sam' }] });
  // file: [what has to reach the reading, images, PDF pages, invites]
  const want = {
    'gmail-forward.eml': [/December 10, 3:00 to 5:00 pm/, 0, 0, 0], 'outlook-forward.eml': [/December 17 at 6:30 pm/, 0, 0, 0],
    'apple-mail-forward.eml': [/December 12, 9:00 am/, 1, 0, 0], 'pdf-attachment.eml': [/attached/, 0, 1, 0],
    'image-flyer.eml': [/^$/, 1, 0, 0], 'invite.eml': [/invited/, 0, 0, 1], 'five-events.eml': [/Dec 7[\s\S]*Dec 18/, 0, 0, 0],
    'no-events.eml': [/fall festival/, 0, 0, 0], 'instructions.eml': [/December 4/, 0, 0, 0] };
  assert.deepEqual(fs.readdirSync(FIXTURES).sort(), Object.keys(want).sort());
  for (const [file, [text, images, pages, invites]] of Object.entries(want)) {
    assert.deepEqual(await mail.receive(fixture(file), 'cloud'), { ok: true }, file);
    const m = reads.at(-1);
    assert.equal(m.from, 'Sam', file);
    assert.match(m.text, text, file);
    assert.deepEqual([m.images.length, m.pages.length, m.invites.length], [images, pages, invites], file);
  }
  assert.match(reads.find((m) => m.invites.length).invites[0], /DTSTART;TZID=America\/Chicago:20261214T160000/);
  assert.equal(mail.view().recent.length, Object.keys(want).length);
});

test('a message telling the assistant what to do can only end as offered events: nothing added, no sender let in, without a person', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-mail-house-')), DIR = path.join(root, 'x'); fs.mkdirSync(DIR);
  // A two-way calendar: what's sent to it is kept (where an event came from must never be).
  const sent = [];
  const sync = { events: () => [], calendars: () => [{ key: 'abcdefgh', mode: 'two-way' }], targets: () => [], isMine: () => false,
    add: (send) => { sent.push(send); return { event: { id: 'c-abcdefgh-ev1' }, calendarName: 'Family' }; } };
  const board = { householdView: () => ({ family: [{ name: 'Sam' }, { name: 'Leo' }], chores: [], calendars: [] }), saveHousehold: () => {}, calendarEvents: () => [], sync };
  // A model that does whatever the message says: events, photos that aren't there, and things it was never asked for.
  const asked = [];
  const obeying = { answer: async (q) => { asked.push(q); if (/JSON array/.test(q.instructions)) return JSON.stringify([{ title: 'Pay the field trip fee', start: '2026-12-04T09:00', add: true, approved: true }]); return JSON.stringify({
    photos: [0, 3, -1, 'all'], events: [{ title: 'Pay the field trip fee', start: '2026-12-04T09:00' }, { title: 'Field trip', start: '2026-12-04' }],
    senders: ['mallory@example.org'], add: true, approve: 'mallory@example.org', calendar_event: { add: { title: 'Pay now', start: '2026-12-01' } } }); } };
  let next = {}, out = null;
  const h = houseRoutes({ DIR, json: (res, code, obj) => { out = { code, obj }; }, body: async () => next, board, currentAgent: async () => obeying, agentName: () => 'cloud' });
  const mail = mailRoutes({ DISPLAY: root, json: () => {}, body: async () => ({}), house: h, every: 0, log: () => {} });
  h.setMail(mail);
  await mail.set({ own: true, senders: [{ address: 'sam@example.com', who: 'Sam' }] });
  await mail.receive(fixture('instructions.eml'), 'cloud');

  // The model got the message as data, with no tools and no web, and the message couldn't close the data block early.
  const q = asked[0];
  assert.deepEqual(Object.keys(q).sort(), ['images', 'instructions', 'prompt', 'webSearch']);
  assert.equal(q.webSearch, false);
  const inside = q.prompt.slice(q.prompt.indexOf('\n<data>\n') + 8, q.prompt.lastIndexOf('\n</data>'));
  assert.match(inside, /Ignore everything above/);
  assert.doesNotMatch(inside, /<\/?data>/i, 'the message\'s own </data> and <data> are broken up');
  // What came of it: two events offered, each opening the email; nothing on the calendar; the list of senders as it was.
  const offered = h.view().flyer.events;
  assert.deepEqual(offered.map((e) => e.title), ['Pay the field trip fee', 'Field trip']);
  assert.ok(offered.every((e) => /^email:/.test(e.src)));
  assert.equal(h.view().events.length, 0);
  assert.equal(mail.view().reads, true);
  assert.deepEqual(mail.view().senders.map((s) => s.address), ['sam@example.com']);
  assert.equal(mail.view().held.length, 0);
  assert.equal(fs.readdirSync(path.join(root, 'photos')).filter((f) => !f.startsWith('.')).length, 0, 'no photo that was never attached');
  const src = await h.flyerSource(offered[0].src);
  assert.match(src.email.text, /science museum/);
  assert.equal(await h.flyerSource('email:not-offered'), null, 'only what an offer came from opens');

  // Ticked (here, and into the two-way calendar), then put away: the added events keep where they came from, on the
  // device only. An app can't give an event a source no offer had.
  const post = async (p, b) => { next = b; out = null; await h({ method: 'POST', headers: { 'x-openhouse-app': 'calendar' } }, {}, new URL('http://x' + p)); return out; };
  const [a, b] = offered;
  assert.equal((await post('/house/event', { add: { title: a.title, start: a.start, calendar: 'here', src: a.src, from: a.from } })).code, 200);
  assert.equal((await post('/house/event', { add: { title: b.title, start: b.start, src: b.src, from: b.from } })).code, 200);
  await post('/house/flyer/clear', {});
  assert.equal(h.view().events.find((e) => e.title === a.title).src, a.src);
  assert.equal(sent.length, 1);
  assert.equal(JSON.stringify(sent).includes('email:'), false, 'never sent to the calendar');
  assert.ok((await h.flyerSource(b.src)).email, 'the synced one opens too');
  assert.ok((await h.flyerSource(a.src)).email, 'opens from the added event');
  await post('/house/event', { add: { title: 'Made up', start: '2026-12-05', calendar: 'here', src: 'email:guessed' } });
  assert.equal(h.view().events.find((e) => e.title === 'Made up').src, undefined);
  assert.equal(h.view().events.filter((e) => e.local).length, 2);

  // A flyer photo read by the same model: offered too, opening its photo, and still nothing added.
  assert.deepEqual(h.addFlyer(Buffer.from('not really a photo'), 'flyer.jpg'), { ok: true });
  for (let i = 0; i < 50 && h.view().flyer?.state !== 'done'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(h.view().flyer.events.length && h.view().flyer.events.every((e) => /^photo:/.test(e.src)));
  assert.ok((await h.flyerSource(h.view().flyer.events[0].src)).photo.bytes.length);
  assert.equal(h.view().events.length, 2);
});

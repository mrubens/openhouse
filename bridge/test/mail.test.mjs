// Email to the tablet (mail.js): only approved, verified senders' mail is read; anything else waits, unread, for a
// person's Allow. Mail sealed in the cloud opens only with this tablet's key, and leaves the cloud once it's taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mailRoutes } from '../mail.js';
import { newMailKey, seal, open } from '../mail-seal.js';

const msg = (from, verdict = 'dmarc=pass') => Buffer.from([`Authentication-Results: mx.example.net; ${verdict}`, `From: ${from}`, 'Subject: Book fair', 'Content-Type: text/plain', '', 'Book fair Friday at 3.', ''].join('\r\n'));

function setup({ cloud = null } = {}) {
  const DISPLAY = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-mail-'));
  const reads = [];
  const house = { readEmail: async (m) => { reads.push(m); return { photos: [], events: 1 }; } };
  const mail = mailRoutes({ DISPLAY, json: () => {}, body: async () => ({}), house, cloud, every: 0, log: () => {} });
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

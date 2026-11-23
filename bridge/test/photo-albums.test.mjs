// Shared albums kept in step (photo-albums.js, through house.js's routes): what Apple's webstream and webasseturls
// say, read into the household's photos. Apple's answers here are shaped like the real ones (docs/photos.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { houseRoutes } from '../house.js';
import { readAssets } from '../photo-albums.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7)]);
const photo = (guid, at, caption = '', extra = {}) => ({
  photoGuid: guid, batchGuid: 'b-' + guid, caption, batchDateCreated: at, dateCreated: at, width: '4032', height: '3024',
  derivatives: { 342: { checksum: 's-' + guid, fileSize: '20000', width: '342', height: '256' }, 2049: { checksum: 'm-' + guid, fileSize: '400000', width: '2049', height: '1537' } },
  ...extra,
});
const streamOf = (name, photos) => JSON.stringify({ streamName: name, userFirstName: 'Sam', userLastName: 'R', streamCtag: '1', itemsReturned: String(photos.length), photos });
const assetsFor = (sums) => JSON.stringify({
  items: Object.fromEntries(sums.map((s) => [s, { url_expiry: '2026-11-19T20:00:00Z', url_location: 'cvws.icloud-content.com', url_path: `/S/${s}/IMG.JPG?o=x&e=1` }])),
  locations: { 'cvws.icloud-content.com': { hosts: ['cvws.icloud-content.com'], scheme: 'https' } },
});

function house() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'albums-')), DIR = path.join(root, 'x');
  fs.mkdirSync(DIR);
  const board = { householdView: () => ({ family: [], chores: [], calendars: [] }), saveHousehold: () => {}, calendarEvents: () => [] };
  const h = houseRoutes({ DIR, json: () => {}, body: async () => ({}), board });
  return { h, PHOTOS: path.join(root, 'photos'), root };
}
// house.js makes its own albumSync with the real fetch: swap it for one that answers from Apple's content host.
const realFetch = globalThis.fetch;
test.beforeEach(() => { globalThis.fetch = async (url) => {
  const u = new URL(url);
  if (u.hostname !== 'cvws.icloud-content.com') throw new Error('not Apple: ' + url);
  if (u.pathname.includes('/bad-')) return new Response('nope', { status: 403, headers: { 'content-type': 'text/plain' } });
  return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
}; });
test.after(() => { globalThis.fetch = realFetch; });

async function look(h, source, stream) {
  const r = h.albums.stream({ source, stream });
  if (!r.want?.length) return r;
  const v = h.view(), s = v.linked.find((x) => x.id === source);
  assert.ok(s);
  const a = h.albums.assets({ source, assets: assetsFor(r.want.map((g) => 'm-' + g)) });
  await a.done;
  return r;
}

test('readAssets keeps only https addresses on Apple’s content hosts', () => {
  const a = readAssets(JSON.stringify({ items: { ok: { url_location: 'l1', url_path: '/S/a' }, evil: { url_location: 'l2', url_path: '/x' }, plain: { url_location: 'l3', url_path: '/y' } },
    locations: { l1: { hosts: ['p1.icloud-content.com'], scheme: 'https' }, l2: { hosts: ['evil.example.com'], scheme: 'https' }, l3: { hosts: ['p1.icloud-content.com'], scheme: 'http' } } }));
  assert.deepEqual(a, { ok: 'https://p1.icloud-content.com/S/a' });
});

test('Apple changing things is a quiet line on the album, and nothing already here goes', async () => {
  const { h } = house();
  await look(h, 'k1', streamOf('Kitchen', [photo('A1', '2026-01-01T10:00:00Z')]));
  h.albums.stream({ source: 'k1', stream: '<html>new page</html>' });
  let v = h.view();
  assert.equal(v.linked[0].status, 'error');
  assert.equal(v.linked[0].error, 'Couldn’t read the album');
  assert.ok(v.photos.includes('ic-k1-A1.jpg'));
  h.albums.stream({ source: 'k1', error: 'HTTP 404' });
  assert.equal(h.view().linked[0].error, 'HTTP 404');
  // a photo address that doesn't answer with an image is skipped (and asked for again next time)
  const r = h.albums.stream({ source: 'k1', stream: streamOf('Kitchen', [photo('A1', '2026-01-01T10:00:00Z'), photo('bad-1', '2026-02-01T10:00:00Z')]) });
  assert.deepEqual(r.want, ['bad-1']);
  await h.albums.assets({ source: 'k1', assets: JSON.stringify({ items: { 'm-bad-1': { url_location: 'l', url_path: '/S/bad-1' } }, locations: { l: { hosts: ['cvws.icloud-content.com'], scheme: 'https' } } }) }).done;
  assert.equal(h.view().linked[0].coming, 1);
});

test('the link taken off: the album and its photos go, the household’s own stay', async () => {
  const { h, PHOTOS } = house();
  fs.writeFileSync(path.join(PHOTOS, '1-drawing.jpg'), JPEG);
  await look(h, 'k1', streamOf('Kitchen', [photo('A1', '2026-01-01T10:00:00Z')]));
  const id = h.view().albums.find((a) => a.from).id;
  assert.ok(h.changeAlbums({ remove: id }).error); // not from the Photos app: Settings
  h.changeAlbums({ put: { id, photos: ['1-drawing.jpg'] } });
  await look(h, 'k1', streamOf('Kitchen', [photo('A1', '2026-01-01T10:00:00Z')]));
  assert.ok(h.view().albums.find((a) => a.id === id).photos.includes('1-drawing.jpg')); // what the household put in stays
  h.albums.stream({ source: 'k1', gone: true });
  const v = h.view();
  assert.ok(!v.albums.some((a) => a.id === id));
  assert.deepEqual(v.linked, []);
  assert.ok(!v.photos.includes('ic-k1-A1.jpg'));
  assert.ok(fs.existsSync(path.join(PHOTOS, '1-drawing.jpg')));
});

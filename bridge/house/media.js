// Photos and videos (the Photos app and the sleep screen): uploads from a phone, an email or an app, albums, captions,
// those taken off (kept 30 days), videos in parts and played by a signed address, and Opie's photos tool.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { albumSync } from '../photo-albums.js';
import { stillMaker } from '../stills.js';
import { DAY, VIDEO, MEDIA, MAX_VIDEO, MAX_PICTURE, videoKind, localWhen, str, same, arr } from './util.js';

export default function (house) {
  const { data, save, changed, appName, PHOTOS } = house;
  const stills = stillMaker({ photosDir: PHOTOS, onMade: () => changed(), log: (m) => console.log(m) });
  const albums = albumSync({ photosDir: PHOTOS, data, save: () => save(), log: (m) => console.log(m), stills });
  let photoCache = null; // the folder's listing, kept while the folder hasn't changed
  function photos() {
    try {
      const at = fs.statSync(PHOTOS).mtimeMs;
      if (photoCache?.at === at) return photoCache.list;
      const list = fs.readdirSync(PHOTOS).filter((f) => MEDIA.test(f) && !f.startsWith('.'))
        .map((f) => ({ name: f, at: fs.statSync(path.join(PHOTOS, f)).mtimeMs })).sort((a, b) => b.at - a.at).map((p) => p.name);
      photoCache = { at, list };
      return list;
    } catch { return []; }
  }
  // Pictures an app saved before they went into its own album (by the names Whiteboard and Drawing give them), and an
  // album chosen as the whole sleep screen before each album had its own say: once.
  if (!data.settings.appAlbums) { // (after photos() can list them)
    const all = photos();
    for (const [app, re] of [['whiteboard', /^\d+-whiteboard-\d{4}-\d\d-\d\d-\d{4}\.png$/], ['drawing', /^\d+-Drawing-\d+\.png$/]]) {
      const mine = all.filter((n) => re.test(n));
      if (mine.length) for (const n of mine) intoAppAlbum(app, n);
    }
    const only = data.albums.find((a) => a.id === data.settings.slideshow);
    if (only) for (const a of data.albums) if (a !== only) a.sleep = false;
    delete data.settings.slideshow;
    delete data.settings.albumsV2; data.settings.appAlbums = true; // (kept with the next save: running this again changes nothing)
  }
  function removePhoto(name) {
    const n = path.basename(String(name || ''));
    if (!MEDIA.test(n) || n.startsWith('.')) return { error: 'no such photo' };
    const bin = path.join(PHOTOS, '.removed');
    try { fs.mkdirSync(bin, { recursive: true }); fs.renameSync(path.join(PHOTOS, n), path.join(bin, n)); } catch { return { error: 'no such photo' }; }
    try { const t = new Date(); fs.utimesSync(path.join(bin, n), t, t); } catch {} // its 30 days start now (not from when it was taken)
    try { for (const f of fs.readdirSync(bin)) if (fs.statSync(path.join(bin, f)).mtimeMs < Date.now() - 30 * DAY) { fs.unlinkSync(path.join(bin, f)); if (VIDEO.test(f)) stills.drop(f); } } catch {}
    albums.removed(n);
    for (const a of data.albums) a.photos = a.photos.filter((x) => x !== n); delete data.captions[n];
    save(); return { ok: true };
  }
  // ---- photos taken off: kept in photos/.removed for 30 days, and can be put back ----
  let removedCache = null;
  function removedPhotos() {
    const bin = path.join(PHOTOS, '.removed');
    try {
      const at = fs.statSync(bin).mtimeMs;
      if (removedCache?.at !== at) removedCache = { at, list: fs.readdirSync(bin).filter((f) => MEDIA.test(f) && !f.startsWith('.'))
        .map((f) => ({ f, t: fs.statSync(path.join(bin, f)).mtimeMs })).sort((a, b) => b.t - a.t).map((x) => x.f).slice(0, 60) };
      return removedCache.list;
    } catch { return []; }
  }
  function restorePhoto(name) {
    const n = path.basename(String(name || ''));
    if (!MEDIA.test(n) || n.startsWith('.')) return { error: 'no such photo' };
    try { fs.renameSync(path.join(PHOTOS, '.removed', n), path.join(PHOTOS, n)); } catch { return { error: 'That photo isn’t there to put back.' }; }
    if (n.startsWith('ic-')) { albums.restored(n); save(); return { ok: true }; }
    changed(); return { ok: true };
  }

  // ---- albums and captions ----
  /** Photos left out of a place (the sleep screen: 'sleep'; Photos' All: 'all'): those whose albums are all turned off
   *  there. A photo in no album, or in one album that's on, shows. */
  function leftOut(where) {
    const off = new Set(), on = new Set();
    for (const a of data.albums) for (const n of a.photos) (a[where] === false ? off : on).add(n);
    for (const n of on) off.delete(n);
    return off;
  }
  /** The photos the sleep screen shows (none when every one is in an album that's off there: the plain sleep screen). */
  function screensaver() { const out = leftOut('sleep'); return photos().filter((n) => !out.has(n) && (!VIDEO.test(n) || stills.has(n))); } // (a video shows as its still, once it has one)
  /** A picture an app saved goes in the app's own album (made the first time, named after the app; off on the sleep
   *  screen to begin with, so the slideshow stays the family's photos). */
  function intoAppAlbum(app, file) {
    let a = data.albums.find((x) => x.app === app);
    if (!a) {
      let name = str(appName(app) || app, 40) || app;
      if (data.albums.some((x) => same(x.name, name))) name = str(name + ' (app)', 40);
      a = { id: 'a-' + crypto.randomUUID().slice(0, 6), name, photos: [], app, sleep: false };
      data.albums.push(a);
    }
    if (!a.photos.includes(file)) a.photos.push(file);
  }
  const photoName = (n) => { const b = String(n || ''); return b === path.basename(b) && photos().includes(b) ? b : null; }; // one of theirs, by its name
  function changeAlbums(b) {
    if (b.add) {
      const name = str(b.add.name, 40); if (!name) return { error: 'An album needs a name.' };
      if (data.albums.some((x) => same(x.name, name))) return { error: `There's an album called ${name} already.` };
      const a = { id: 'a-' + crypto.randomUUID().slice(0, 6), name, photos: [...new Set(arr(b.add.photos).map(photoName).filter(Boolean))] };
      data.albums.push(a); save(); return { ok: true, album: a };
    }
    const a = data.albums.find((x) => x.id === (b.rename?.id ?? b.put?.id ?? b.show?.id ?? b.remove));
    if (!a) return { error: 'No such album.' };
    if (b.rename) {
      const name = str(b.rename.name, 40); if (!name) return { error: 'An album needs a name.' };
      if (data.albums.some((x) => x !== a && same(x.name, name))) return { error: `There's an album called ${name} already.` };
      a.name = name; albums.renamed(a.id); save(); return { ok: true };
    }
    if (b.show) { // where the album's photos show: the sleep screen, Photos' All
      for (const k of ['sleep', 'all']) if (typeof b.show[k] === 'boolean') { if (b.show[k]) delete a[k]; else a[k] = false; }
      save(); return { ok: true };
    }
    if (b.put) {
      const names = arr(b.put.photos).map(photoName).filter(Boolean);
      a.photos = b.put.on === false ? a.photos.filter((n) => !names.includes(n)) : [...new Set([...a.photos, ...names])];
      save(); return { ok: true };
    }
    if (a.from) return { error: `${a.name} comes from ${a.from}: someone takes it off in the Photos app, the album's card.` };
    data.albums = data.albums.filter((x) => x !== a); // the photos stay: only the album goes
    save(); return { ok: true };
  }
  /** A photo or a video into Photos (a phone's upload page, an email, an app, one shared to Opie: phone-share.js), with a
   *  caption if given. Its file name, or null when it's a video over MAX_VIDEO (or a picture over 25 MB): nothing kept. */
  function addPhoto(bytes, name = 'photo.jpg', text = '', app = null) {
    const kind = videoKind(bytes); // (a video sent as "phone.jpg": the shell's upload page doesn't know which it is)
    if (kind && !VIDEO.test(name)) name = String(name).replace(/\.[^.]*$/, '') + kind;
    if (bytes.length > (VIDEO.test(name) ? MAX_VIDEO : MAX_PICTURE)) return null;
    // The very same picture again (a drawing saved twice unchanged): it's already there, so that one's name comes back.
    const same = samePhoto(bytes);
    if (same) { if (app) intoAppAlbum(app, same); if (str(text, 120) && !data.captions[same]) data.captions[same] = str(text, 120); if (app || str(text, 120)) { save(); changed(); } return same; }
    const file = Date.now() + '-' + String(name).replace(/[^\w.-]/g, '_').slice(-80);
    fs.mkdirSync(PHOTOS, { recursive: true });
    const tmp = path.join(PHOTOS, '.' + file + '.tmp'); // whole or not at all: the folder never shows half a video
    fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, path.join(PHOTOS, file));
    return added(file, text, app);
  }
  function added(file, text = '', app = null) {
    if (str(text, 120)) data.captions[file] = str(text, 120);
    if (app) intoAppAlbum(app, file);
    if (VIDEO.test(file)) stills.want(file);
    save(); changed();
    return file;
  }
  /** A photo already in Photos with exactly these bytes (same size first, then the same SHA-256), or null. */
  function samePhoto(bytes) {
    let names; try { names = fs.readdirSync(PHOTOS).filter((n) => MEDIA.test(n) && !n.startsWith('.')); } catch { return null; }
    let digest = null;
    for (const n of names) {
      let st; try { st = fs.statSync(path.join(PHOTOS, n)); } catch { continue; }
      if (st.size !== bytes.length) continue;
      digest ??= crypto.createHash('sha256').update(bytes).digest('hex');
      try { if (crypto.createHash('sha256').update(fs.readFileSync(path.join(PHOTOS, n))).digest('hex') === digest) return n; } catch {}
    }
    return null;
  }
  // ---- videos from the phone page, in parts (a whole one sealed at once would be too much for the shell) ----
  const INCOMING = path.join(PHOTOS, '.incoming'), parts = new Map(); // id -> { next, size, at }
  function videoPart(q, bytes) {
    const id = String(q.get('id') || ''), n = Number(q.get('n')), of = Number(q.get('of'));
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(id) || !Number.isInteger(n) || !Number.isInteger(of) || n < 0 || of < 1 || n >= of || of > 200) return { error: 'which part?' };
    for (const [k, v] of parts) if (Date.now() - v.at > 3600e3) { parts.delete(k); fs.rmSync(path.join(INCOMING, k), { force: true }); } // (an upload left halfway)
    const file = path.join(INCOMING, id);
    if (n === 0) { if (!videoKind(bytes)) return { error: 'not a video' }; fs.mkdirSync(INCOMING, { recursive: true }); fs.writeFileSync(file, bytes); parts.set(id, { next: 1, size: bytes.length, at: Date.now(), kind: videoKind(bytes) }); }
    else {
      const p = parts.get(id);
      if (!p || p.next !== n) return { error: 'out of order', code: 409 };
      if (p.size + bytes.length > MAX_VIDEO) { parts.delete(id); fs.rmSync(file, { force: true }); return { error: 'too big', code: 413 }; }
      fs.appendFileSync(file, bytes); p.next++; p.size += bytes.length; p.at = Date.now();
    }
    if (n < of - 1) return { ok: true };
    const p = parts.get(id); parts.delete(id);
    const base = String(q.get('name') || 'phone').replace(/\.[^.]*$/, '').replace(/[^\w-]/g, '_').slice(-60) || 'phone';
    const name = Date.now() + '-' + base + p.kind;
    fs.renameSync(file, path.join(PHOTOS, name));
    return { ok: true, name: added(name) };
  }
  // A <video> can't send the app's key, so an app that may see a photo gets an address for it that works for a few
  // hours, on this device only (the bridge listens on loopback), for that one video.
  const playKey = crypto.randomBytes(32);
  const playSig = (name, exp) => crypto.createHmac('sha256', playKey).update(name + '|' + exp).digest('base64url').slice(0, 32);
  function playUrl(name) { const exp = (Date.now() + 6 * 3600e3).toString(36); return `/house/video/${encodeURIComponent(name)}?t=${exp}.${playSig(name, exp)}`; }
  /** GET /house/video/<name>?t=… (server.js, before the callers' keys): the video, with ranges (the WebView seeks). */
  function serveVideo(req, res, url) {
    if (req.method !== 'GET' || !url.pathname.startsWith('/house/video/')) return false;
    let name; try { name = decodeURIComponent(url.pathname.slice('/house/video/'.length)); } catch { name = ''; }
    const [exp, sig] = String(url.searchParams.get('t') || '').split('.');
    const want = VIDEO.test(name) && name === path.basename(name) && !name.startsWith('.') && exp && sig ? playSig(name, exp) : '';
    if (!want || want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig)) || parseInt(exp, 36) < Date.now()) { res.writeHead(403); res.end(); return true; }
    const file = path.join(PHOTOS, name);
    let size; try { size = fs.statSync(file).size; } catch { res.writeHead(404); res.end(); return true; }
    const type = /\.mov$/i.test(name) ? 'video/quicktime' : 'video/mp4';
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    let start = 0, end = size - 1;
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(size - 1, Number(m[2])); } else start = Math.max(0, size - Number(m[2]));
      if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return true; }
      res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'cache-control': 'private, max-age=3600' });
    } else res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size, 'cache-control': 'private, max-age=3600' });
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    return true;
  }
  function caption(b) {
    const n = photoName(b.name); if (!n) return { error: 'no such photo' };
    const t = str(b.text, 120);
    if (t) data.captions[n] = t; else delete data.captions[n];
    save(); return { ok: true };
  }

  /** The photos tool (Opie's): what the Photos app's taps do, by the photos' names. */
  function photosTool(a) {
    const ok = (x) => ({ content: [{ type: 'text', text: typeof x === 'string' ? x : JSON.stringify(x, null, 1) }] });
    const no = (x) => ({ content: [{ type: 'text', text: x }], isError: true });
    const names = arr(a.photos).map((x) => path.basename(String(x || ''))).filter(Boolean);
    const inAlbums = (n) => data.albums.filter((x) => x.photos.includes(n)).map((x) => x.name);
    const when = (n) => { try { return localWhen(new Date(fs.statSync(path.join(PHOTOS, n)).mtimeMs).toISOString()); } catch { return null; } };
    if (a.do === 'list') {
      const all = photos();
      return ok({ photos: all.slice(0, 80).map((n) => ({ name: n, when: when(n), ...(data.captions[n] ? { caption: data.captions[n] } : {}), ...(inAlbums(n).length ? { albums: inAlbums(n) } : {}) })), ...(all.length > 80 ? { more: all.length - 80 } : {}),
        albums: data.albums.map((x) => ({ id: x.id, name: x.name, photos: x.photos.length, ...(x.from ? { from: x.from } : {}), ...(x.sleep === false ? { sleepScreen: false } : {}), ...(x.all === false ? { inAll: false } : {}) })),
        takenOff: removedPhotos().slice(0, 30) });
    }
    if (a.do === 'take_off' || a.do === 'put_back') {
      if (!names.length) return no('Which photos (their names from list)?');
      const done = [], failed = [];
      for (const n of names) { const r = a.do === 'take_off' ? removePhoto(n) : restorePhoto(n); (r.error ? failed : done).push(n); }
      if (done.length && a.do === 'put_back') changed();
      return (done.length ? ok : no)(`${a.do === 'take_off' ? 'Taken off' : 'Put back'}: ${done.length}${failed.length ? `; not found: ${failed.join(', ')}` : ''}.`);
    }
    if (a.do === 'caption') { if (names.length !== 1) return no('Which one photo (its name from list)?'); const r = caption({ name: names[0], text: a.text || '' }); return r.error ? no(r.error) : ok('Caption saved.'); }
    if (a.do === 'album') {
      const b = a.album || {}, q = String(b.album || '').trim();
      const al = data.albums.find((x) => x.id === q) || data.albums.find((x) => same(x.name, q));
      if (b.do !== 'add' && !al) return no(`No album ${q ? `called ${q}` : 'given'}. The albums: ${data.albums.map((x) => x.name).join(', ') || 'none'}.`);
      const r = b.do === 'add' ? changeAlbums({ add: { name: b.name, photos: names } })
        : b.do === 'rename' ? changeAlbums({ rename: { id: al.id, name: b.name } })
        : b.do === 'put_in' || b.do === 'take_out' ? changeAlbums({ put: { id: al.id, photos: names, on: b.do === 'put_in' } })
        : b.do === 'show' ? changeAlbums({ show: { id: al.id, ...(typeof b.sleep === 'boolean' ? { sleep: b.sleep } : {}), ...(typeof b.all === 'boolean' ? { all: b.all } : {}) } })
        : b.do === 'remove' ? changeAlbums({ remove: al.id }) : { error: 'What to do with the album?' };
      return r.error ? no(r.error) : ok('Done.');
    }
    return no('list, take_off, put_back, caption or album?');
  }
  // Photos added straight into the folder (adb push, a file share) show up without a restart.
  let swept = null;
  try { fs.watch(PHOTOS, () => { clearTimeout(swept); swept = setTimeout(() => { changed(); stills.sweep(photos().filter((n) => VIDEO.test(n))); }, 500); }).unref?.(); } catch {}
  setTimeout(() => stills.sweep(photos().filter((n) => VIDEO.test(n))), 5e3).unref?.(); // videos without a still yet (one put in the folder by hand)
  return { stills, albums, photos, removePhoto, removedPhotos, restorePhoto, screensaver, intoAppAlbum, changeAlbums, addPhoto, videoPart, playUrl, serveVideo, caption, photosTool };
}

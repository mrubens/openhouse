// Shared albums the household linked (docs/photos.md): an iCloud shared album with a public website, kept in step
// with the household's photos. The album's link is the shell's (PhotoAlbums.kt: sealed with the Keystore, like the
// calendar links), so the shell makes the two calls that need it and hands what Apple said to the routes here, which
// read it, keep the album and fetch the photos themselves from the short-lived addresses Apple gave (no link in them):
//
//   POST /house/album/stream  { source, stream }   what Apple's webstream said (its JSON), for the album `source` (the
//                                                   shell's id for the link). Takes away photos no longer in it, keeps the
//                                                   album's name and captions; answers { want: [photoGuid] }: the new
//                                                   ones to fetch next (up to WANT a round)
//                             { source, error }    the shell couldn't read it (a quiet line on the album, nothing goes)
//                             { source, gone: true } the link was taken off on the tablet: the album and its photos go
//   POST /house/album/assets  { source, assets }   what Apple's webasseturls said for those: the photos are fetched
//                                                   here, one at a time, and land in the album as they arrive
//
//   POST /house/album/stream  { source, ck }       the same for a new (iOS 27) album, photos.icloud.com/shared/album/…:
//                                                   the shell asked CloudKit (share resolve, then the album's records)
//                                                   and hands over { title, expires, records } (readCloudKit); the
//                                                   records carry short-lived download addresses, so the bridge
//                                                   fetches the new ones straight away (no assets step)
//
// house.json keeps data.synced[source] = { kind, album, name, status, error?, at, photos: {guid: {file, cap}}, skip }
// (no link: the agent reads house.json). The album itself is an ordinary one in data.albums, with `from: 'iCloud'`.
// A photo the household takes off is remembered in `skip`, so the next look doesn't bring it back.
//
// Apple doesn't document any of this (photo frames have used it for years) and can change it: whatever doesn't read
// as an album is "Couldn't read the album", never a crash, and nothing already on the tablet goes because of it.
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const WANT = 40; // new photos fetched per look (the rest come at the next one, a few minutes later)
export const MAX_PHOTOS = 600; // kept from one album: its newest (shared albums go to 5,000)
const MAX_BYTES = 25e6;
export const MAX_VIDEO = 80e6; // (house.js's own cap for a video)
export const MAX_VIDEOS = 50; // videos kept from one album, its newest: a few GB at most (its photos aren't counted in it)
const ID = /^[A-Za-z0-9_-]{1,40}$/, GUID = /^[A-Za-z0-9-]{1,80}$/;
const ASSET_HOST = /(^|\.)icloud-content\.com$|(^|\.)icloud\.com$/i;

/** The largest picture not much bigger than the screen: the smallest at least `want` px on its long side, else the largest. */
export function pickDerivative(derivatives, want = 2000) {
  const list = Object.entries(derivatives || {}).map(([key, d]) => ({ key, checksum: String(d?.checksum || ''), w: Number(d?.width) || 0, h: Number(d?.height) || 0, size: Number(d?.fileSize) || 0 }))
    .filter((d) => d.checksum && d.key !== 'PosterFrame' && d.w > 0 && d.h > 0);
  if (!list.length) return null;
  list.sort((a, b) => Math.max(a.w, a.h) - Math.max(b.w, b.h));
  return list.find((d) => Math.max(d.w, d.h) >= want && d.size < MAX_BYTES) || list.filter((d) => d.size < MAX_BYTES).at(-1) || null;
}

/** A video's size to keep: the largest up to 1080p that's under MAX_VIDEO, else the smallest under it. */
export function pickVideo(derivatives) {
  const list = Object.entries(derivatives || {}).map(([key, d]) => ({ key, checksum: String(d?.checksum || ''), w: Number(d?.width) || 0, h: Number(d?.height) || 0, size: Number(d?.fileSize) || 0 }))
    .filter((d) => d.checksum && d.key !== 'PosterFrame' && d.w > 0 && d.h > 0 && d.size < MAX_VIDEO);
  list.sort((a, b) => Math.max(a.w, a.h) - Math.max(b.w, b.h));
  return list.filter((d) => Math.max(d.w, d.h) <= 1920).at(-1) || list[0] || null;
}

/** What Apple's webstream said, as an album: { name, photos: [{guid, checksum, caption, at}] } (photos only, newest
 *  shared first), or null if it doesn't read as one. */
export function readStream(raw) {
  let j = raw;
  if (typeof raw === 'string') { try { j = JSON.parse(raw); } catch { return null; } }
  if (!j || typeof j !== 'object' || !Array.isArray(j.photos)) return null;
  const photos = [];
  for (const p of j.photos) {
    if (!p || typeof p !== 'object' || !GUID.test(String(p.photoGuid || ''))) continue;
    const at = Date.parse(p.batchDateCreated || p.dateCreated || '') || 0, caption = String(p.caption || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    if (String(p.mediaAssetType || '').toLowerCase() === 'video') { // its playable sizes (720p, 360p…) and Apple's still of it
      const d = pickVideo(p.derivatives), poster = String(p.derivatives?.PosterFrame?.checksum || '');
      if (d) photos.push({ guid: String(p.photoGuid), checksum: d.checksum, caption, at, video: true, ...(poster ? { poster } : {}) });
      continue;
    }
    const d = pickDerivative(p.derivatives);
    if (!d) continue;
    photos.push({ guid: String(p.photoGuid), checksum: d.checksum, caption, at });
  }
  photos.sort((a, b) => b.at - a.at);
  const name = String(j.streamName || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return { name, photos };
}

const SIZES = ['JPEGThumb', 'JPEGMed', 'JPEGLarge', 'JPEGFull', 'Original'];
const B64 = /^[A-Za-z0-9+/=_-]{0,4000}$/;
const text64 = (v) => { if (typeof v !== 'string' || !B64.test(v)) return ''; const t = Buffer.from(v, 'base64').toString('utf8'); return t.startsWith('bplist') || /[\u0000-\u0008]/.test(t) ? '' : t; };

/** A new-style (CloudKit) album, as the shell handed it: { name, expires, photos: [{guid, checksum, caption, at, url}] }
 *  (photos only, newest shared first; checksum is the guid, url the picture to fetch), or null. Each photo is a
 *  CPLAsset (when it was added, its caption) pointing at a CPLMaster (the pictures: a few JPEG sizes and the original). */
export function readCloudKit(ck, want = 2000) {
  if (!ck || typeof ck !== 'object' || !Array.isArray(ck.records)) return null;
  const masters = new Map(), assets = [];
  for (const r of ck.records) {
    if (!r || typeof r !== 'object' || !r.fields) continue;
    if (r.recordType === 'CPLMaster') masters.set(String(r.recordName), r.fields);
    else if (r.recordType === 'CPLAsset' && GUID.test(String(r.recordName || ''))) assets.push(r);
  }
  const photos = [];
  for (const a of assets) {
    const f = a.fields, m = masters.get(String(f.masterRef?.value?.recordName || ''));
    if (!m) continue;
    const kind = String(m.itemType?.value || '');
    const guid = String(a.recordName), caption = text64(f.captionEnc?.value).trim().replace(/\s+/g, ' ').slice(0, 200), at = Number(f.addedDate?.value) || Number(f.assetDate?.value) || 0;
    const res = (k, name) => { // one of the master's files: its address (only on Apple's hosts), size and shape
      const r = m[`res${k}Res`]?.value, url = String(r?.downloadURL || '');
      const w = Number(m[`res${k}Width`]?.value) || 0, h = Number(m[`res${k}Height`]?.value) || 0;
      if (!url || !w || !h) return null;
      let u; try { u = new URL(url.replaceAll('${f}', name)); } catch { return null; }
      return u.protocol === 'https:' && ASSET_HOST.test(u.hostname) ? { url: u.href, w, h, size: Number(r.size) || 0, type: String(m[`res${k}FileType`]?.value || '') } : null;
    };
    if (/movie|video|mpeg|avi/i.test(kind) || Number(f.duration?.value) > 0) { // a video: Apple's playable copies (H.264), else its original
      const vids = ['VidSmall', 'VidMed', 'VidFull'].map((k) => res(k, 'video.mp4')).filter((x) => x && x.size < MAX_VIDEO);
      const orig = res('Original', 'video.mov');
      if (!vids.length && orig && /mpeg-4|quicktime/i.test(orig.type || kind) && orig.size < MAX_VIDEO) vids.push(orig);
      vids.sort((x, y) => Math.max(x.w, x.h) - Math.max(y.w, y.h));
      const v = vids.filter((x) => Math.max(x.w, x.h) <= 1920).at(-1) || vids[0];
      if (!v) continue;
      const stills = SIZES.slice(0, 4).map((k) => res(k, 'still.jpg')).filter((x) => x && x.size < MAX_BYTES).sort((x, y) => Math.max(x.w, x.h) - Math.max(y.w, y.h));
      const still = stills.find((x) => Math.max(x.w, x.h) >= 1200) || stills.at(-1);
      photos.push({ guid, checksum: guid, url: v.url, caption, at, video: true, ...(still ? { poster: guid + '#still', posterUrl: still.url } : {}) });
      continue;
    }
    const list = [];
    for (const k of SIZES) {
      const res = m[`res${k}Res`]?.value, url = String(res?.downloadURL || '');
      const w = Number(m[`res${k}Width`]?.value) || 0, h = Number(m[`res${k}Height`]?.value) || 0;
      if (!url || !w || !h) continue;
      if (k === 'Original' && !/^public\.(jpeg|png)$/.test(String(m.resOriginalFileType?.value || kind))) continue; // (HEIC: the browser can't show it)
      let u; try { u = new URL(url.replaceAll('${f}', 'photo.jpg')); } catch { continue; }
      if (u.protocol !== 'https:' || !ASSET_HOST.test(u.hostname)) continue;
      list.push({ url: u.href, w, h, size: Number(res.size) || 0 });
    }
    list.sort((x, y) => Math.max(x.w, x.h) - Math.max(y.w, y.h));
    const d = list.find((x) => Math.max(x.w, x.h) >= want && x.size < MAX_BYTES) || list.filter((x) => x.size < MAX_BYTES).at(-1);
    if (!d) continue;
    photos.push({ guid, checksum: guid, url: d.url, caption, at });
  }
  photos.sort((a, b) => b.at - a.at);
  const name = String(ck.title || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return { name, expires: Number(ck.expires) || 0, photos };
}

/** Apple's webasseturls: checksum -> an https address for it (only on Apple's own content hosts). */
export function readAssets(raw) {
  let j = raw;
  if (typeof raw === 'string') { try { j = JSON.parse(raw); } catch { return {}; } }
  const out = {};
  for (const [sum, it] of Object.entries(j?.items || {})) {
    const loc = j?.locations?.[it?.url_location];
    const host = String(loc?.hosts?.[0] || it?.url_location || ''), scheme = String(loc?.scheme || 'https');
    const p = String(it?.url_path || '');
    if (scheme !== 'https' || !ASSET_HOST.test(host) || !/^[A-Za-z0-9.-]+$/.test(host) || !p.startsWith('/')) continue;
    out[sum] = `https://${host}${p}`;
  }
  return out;
}

/**
 * The synced albums, over the household's data. [photosDir]: the photos folder; [data]: house.json's data (albums,
 * captions, settings, synced); [save]: keep it and tell the apps; [fetchImpl]: for tests.
 */
export function albumSync({ photosDir, data, save, fetchImpl = fetch, log = () => {}, stills = null }) {
  data.synced ||= {};
  const busy = new Set();
  const fileFor = (source, guid, video = false) => `ic-${source}-${guid}.${video ? 'mp4' : 'jpg'}`; // (Apple's playable copies are mp4)
  const albumOf = (s) => data.albums.find((a) => a.id === s.album);

  function ensureAlbum(source, s, name) {
    let a = albumOf(s);
    if (!a) {
      const taken = (n) => data.albums.some((x) => x.name.toLowerCase() === n.toLowerCase());
      let n = name || 'Shared album', i = 2;
      while (taken(n)) n = `${name || 'Shared album'} ${i++}`;
      a = { id: 'a-' + source, name: n, photos: [], from: 'iCloud' };
      data.albums.push(a); s.album = a.id; s.named = false;
    } else if (name && !s.named && a.name !== name && !data.albums.some((x) => x !== a && x.name.toLowerCase() === name.toLowerCase())) a.name = name; // renamed in iCloud (not on the tablet)
    return a;
  }

  function drop(s, guid) {
    const p = s.photos[guid]; if (!p) return;
    try { fs.unlinkSync(path.join(photosDir, p.file)); } catch {} // a copy of what's still in iCloud
    try { fs.unlinkSync(path.join(photosDir, '.removed', p.file)); } catch {}
    stills?.drop(p.file);
    for (const a of data.albums) a.photos = a.photos.filter((x) => x !== p.file);
    delete data.captions[p.file];
    delete s.photos[guid];
  }

  /** What the webstream said: keep the album in step, answer which new photos to fetch. */
  function stream(b) {
    const source = String(b?.source || '');
    if (!ID.test(source)) return { error: 'which album?' };
    let s = data.synced[source];
    if (b.gone) {
      if (s) { for (const g of Object.keys(s.photos)) drop(s, g); data.albums = data.albums.filter((a) => a.id !== s.album); delete data.synced[source]; save(); }
      return { ok: true };
    }
    s ||= data.synced[source] = { kind: 'icloud', album: null, name: '', status: 'new', at: 0, photos: {}, skip: [] };
    if (b.error || (b.stream == null && b.ck == null)) {
      s.status = 'error'; s.error = String(b.error || 'Couldn’t read the album').slice(0, 120); s.at = Date.now(); save();
      return { ok: true, want: [] };
    }
    const st = b.ck != null ? readCloudKit(b.ck) : readStream(b.stream);
    if (!st) { s.status = 'error'; s.error = 'Couldn’t read the album'; s.at = Date.now(); save(); return { ok: true, want: [] }; }
    const a = ensureAlbum(source, s, st.name);
    s.name = st.name; s.status = 'ok'; delete s.error; s.at = Date.now();
    if (st.expires) s.expires = st.expires; else delete s.expires;
    let videos = 0; // the newest MAX_VIDEOS videos, within the newest MAX_PHOTOS of everything
    const kept = st.photos.slice(0, MAX_PHOTOS).filter((p) => !p.video || ++videos <= MAX_VIDEOS), keep = new Map(kept.map((p) => [p.guid, p]));
    for (const g of Object.keys(s.photos)) if (!keep.has(g)) drop(s, g); // taken out of the album in iCloud
    s.skip = s.skip.filter((g) => keep.has(g));
    for (const [g, p] of Object.entries(s.photos)) { // captions changed in iCloud (unless changed on the tablet since)
      const now = keep.get(g).caption;
      if (now !== p.cap && (data.captions[p.file] || '') === (p.cap || '')) { if (now) data.captions[p.file] = now; else delete data.captions[p.file]; p.cap = now; }
    }
    const have = new Set(fs.existsSync(photosDir) ? fs.readdirSync(photosDir) : []);
    const theirs = kept.filter((p) => s.photos[p.guid] && have.has(s.photos[p.guid].file)).map((p) => s.photos[p.guid].file);
    a.photos = [...theirs, ...a.photos.filter((f) => !f.startsWith(`ic-${source}-`) && !theirs.includes(f))]; // (photos the household put in it stay)
    s.pending = Object.fromEntries(kept.filter((p) => !s.photos[p.guid] && !s.skip.includes(p.guid)).map((p) => [p.guid, p]));
    save();
    const want = Object.keys(s.pending).slice(0, WANT), left = Object.keys(s.pending).length;
    if (b.ck != null) { // the addresses came with the records (and don't last): fetch now
      const urls = Object.fromEntries(st.photos.filter((p) => s.pending[p.guid]).flatMap((p) => [[p.checksum, p.url], ...(p.posterUrl ? [[p.poster, p.posterUrl]] : [])]));
      const { done } = fetchPending(source, s, urls);
      return { ok: true, want, left, getting: want.length, done };
    }
    return { ok: true, want, left };
  }

  /** What webasseturls said: fetch those photos (in the background), each into the album as it lands. */
  function assets(b) {
    const source = String(b?.source || ''), s = data.synced[source];
    if (!ID.test(source) || !s) return { error: 'which album?' };
    return fetchPending(source, s, readAssets(b.assets));
  }

  /** The pending photos that have an address (checksum -> url): fetched in the background, each into the album as it lands. */
  function fetchPending(source, s, urls) {
    const jobs = Object.values(s.pending || {}).filter((p) => urls[p.checksum]).slice(0, WANT).map((p) => ({ p, url: urls[p.checksum] }));
    if (busy.has(source)) return { ok: true, getting: 0 };
    busy.add(source);
    const done = (async () => {
      let n = 0;
      try {
        for (const { p, url } of jobs) {
          if (!data.synced[source] || s.photos[p.guid]) continue; // taken off meanwhile
          try {
            const file = fileFor(source, p.guid, p.video);
            if (p.video) { // streamed to a file (up to MAX_VIDEO), then its still: Apple's, else one made here
              if (!(await fetchTo(url, path.join(photosDir, file), MAX_VIDEO, /^(video\/(mp4|quicktime|x-m4v)|application\/octet-stream)/i)) || !data.synced[source]) continue;
              const still = p.poster && urls[p.poster] && await fetchImpl(urls[p.poster], { signal: AbortSignal.timeout(60e3) }).catch(() => null);
              const jpeg = still?.ok && /^image\//i.test(still.headers.get('content-type') || '') ? Buffer.from(await still.arrayBuffer()) : null;
              if (jpeg && jpeg.length > 100 && jpeg.length < MAX_BYTES) stills?.put(file, jpeg); else stills?.want(file);
            } else {
              const r = await fetchImpl(url, { signal: AbortSignal.timeout(60e3) });
              const type = r.headers.get('content-type') || '';
              if (!r.ok || !/^image\/(jpeg|png|webp|heic|heif)/i.test(type)) { log(`album photo: ${r.status}`); continue; }
              const buf = Buffer.from(await r.arrayBuffer());
              if (buf.length > MAX_BYTES || buf.length < 100) continue;
              if (!data.synced[source]) break;
              fs.writeFileSync(path.join(photosDir, file), buf);
            }
            if (p.at) { const t = new Date(p.at); try { fs.utimesSync(path.join(photosDir, file), t, t); } catch {} } // in the order they were shared
            s.photos[p.guid] = { file, cap: p.caption }; delete s.pending?.[p.guid];
            if (p.caption && !data.captions[file]) data.captions[file] = p.caption;
            const a = albumOf(s); if (a && !a.photos.includes(file)) a.photos.push(file);
            n++;
            if (n % 5 === 0) save();
          } catch (e) { log(`album photo: ${e.name}`); }
        }
      } finally { busy.delete(source); if (n) save(); }
      return n;
    })();
    return { ok: true, getting: jobs.length, done };
  }

  /** A video from Apple's address into [dest], whole or not at all (a part file renamed at the end); false if it isn't one or is too big. */
  async function fetchTo(url, dest, max, type) {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(10 * 60e3) });
    if (!r.ok || !type.test(r.headers.get('content-type') || '') || Number(r.headers.get('content-length')) > max || !r.body) { log(`album video: ${r.status}`); return false; }
    const tmp = path.join(path.dirname(dest), '.' + path.basename(dest) + '.tmp');
    let n = 0;
    const cap = new Transform({ transform(c, _e, cb) { n += c.length; cb(n > max ? new Error('too big') : null, c); } });
    try { await pipeline(Readable.fromWeb(r.body), cap, fs.createWriteStream(tmp)); } catch (e) { fs.rmSync(tmp, { force: true }); log(`album video: ${e.message}`); return false; }
    if (n < 1000) { fs.rmSync(tmp, { force: true }); return false; }
    fs.renameSync(tmp, dest);
    return true;
  }

  /** The household took a photo off: if it came from an album, don't bring it back. */
  function removed(file) {
    for (const s of Object.values(data.synced)) for (const [g, p] of Object.entries(s.photos)) if (p.file === file) { delete s.photos[g]; if (!s.skip.includes(g)) s.skip.push(g); return; }
  }
  /** Put back: it's the album's again. */
  function restored(file) {
    const m = /^ic-([A-Za-z0-9_-]{1,40})-([A-Za-z0-9-]{1,80})\.(jpg|mp4)$/.exec(file); if (!m) return;
    const s = data.synced[m[1]]; if (!s) return;
    s.skip = s.skip.filter((g) => g !== m[2]); s.photos[m[2]] = { file, cap: data.captions[file] || '' };
    const a = albumOf(s); if (a && !a.photos.includes(file)) a.photos.push(file);
  }
  /** An album renamed on the tablet keeps the household's name. */
  function renamed(albumId) { for (const s of Object.values(data.synced)) if (s.album === albumId) s.named = true; }

  /** For view(): the linked albums, without anything Apple handed over. */
  const view = () => Object.entries(data.synced).map(([id, s]) => ({ id, album: s.album, from: 'iCloud', status: s.status, ...(s.error ? { error: s.error } : {}), ...(s.expires ? { expires: s.expires } : {}), at: s.at, photos: Object.keys(s.photos).length, coming: Object.keys(s.pending || {}).length }));

  return { stream, assets, removed, restored, renamed, view };
}

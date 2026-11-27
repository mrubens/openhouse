// The household's own storage bucket as a backup destination (backup.js, docs/backups.md "Your own storage"): anything
// that speaks S3 (Amazon S3, Cloudflare R2, Backblaze B2, MinIO...), for a household that doesn't use Opie cloud. The
// host keeps the bucket's access key and secret (the tablet's OwnStorage.kt, the keeper's hub/s3.mjs: host.js
// 'storage'); the bridge never holds them. For each request the host signs one presigned URL (one method, one object
// under the household's prefix, for a few minutes) and the bridge sends it, streaming the file as the cloud's
// presigned uploads do. The bucket sees only the encrypted backup files, named as on a USB drive or a hub's folder
// (drive.js), so a file copied by hand from one place to another still restores.
import { host } from './host.js';
import { request } from './backup-format.js';
import { driveName, parseName } from './drive.js';

/** The objects in a ListObjectsV2 answer: [{ key, size }], whether there's more, and where it goes on. */
export function parseList(xml) {
  const un = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const items = [...String(xml).matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, c]) => ({ key: un(/<Key>([\s\S]*?)<\/Key>/.exec(c)?.[1] || ''), size: Number(/<Size>(\d+)<\/Size>/.exec(c)?.[1] || 0) }));
  const more = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { items, more, token: token ? un(token) : null };
}

const what = (xml) => /<Code>([^<]{1,80})<\/Code>/.exec(xml || '')?.[1] || null;

export function bucketDestination({ id = 'bucket', label = 'Your own storage', h = host } = {}) {
  const status = async () => { const r = await h.call('/storage/status', {}, { ms: 5000 }); return r?.ok ? r.body : null; };
  /** One presigned URL from the host, or a throw that says why. */
  async function signed(b) {
    const r = await h.call('/storage/sign', b, { ms: 10e3 });
    if (!r) throw Object.assign(new Error('There is no host to keep the storage’s key.'), { code: 'notready' });
    if (r.status === 409) throw Object.assign(new Error('Set up your own storage first.'), { code: 'notready' });
    if (!r.ok || !r.body?.url) throw new Error(r.body?.error || 'the storage request wasn’t signed');
    return r.body.url;
  }
  const failed = (r, doing) => {
    const c = what(r.text);
    // A key that stopped working, or a bucket gone: plain words (Settings shows them), never just "couldn't be reached".
    if (r.status === 403 || ['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied', 'NoSuchBucket'].includes(c)) {
      return Object.assign(new Error(`Your own storage refused to ${doing}${c ? ` (${c})` : ''}. Check it in Backups.`), { code: 'notready' });
    }
    return Object.assign(new Error(`your own storage answered ${r.status}${c ? ` (${c})` : ''}`), { code: 'storage' });
  };
  const d = {
    id, label,
    async ready() {
      if (!h.can('storage')) return { ok: false, why: 'This device can’t keep a storage key.' };
      const s = await status();
      if (!s) return { ok: false, why: 'The storage settings aren’t answering.' };
      if (!s.set) return { ok: false, why: 'Set up your own storage first.' };
      return { ok: true, name: s.bucket + (s.prefix ? `/${s.prefix.replace(/\/$/, '')}` : '') };
    },
    async put(file, meta) {
      const r = await request(await signed({ method: 'PUT', name: driveName(meta) }), { method: 'PUT', file, timeout: 30 * 60e3 });
      if (r.status !== 200) throw failed(r, 'take the backup');
    },
    async list() {
      const s = await status();
      if (!s?.set) throw Object.assign(new Error('Set up your own storage first.'), { code: 'notready' });
      const out = []; let token = null;
      for (let page = 0; page < 50; page++) {
        const r = await request(await signed({ method: 'GET', list: true, token }), { timeout: 30e3 });
        if (r.status !== 200) throw failed(r, 'list the backups');
        const l = parseList(r.text);
        for (const it of l.items) {
          const name = it.key.startsWith(s.prefix) ? it.key.slice(s.prefix.length) : '', p = parseName(name); // (only the prefix's own, not a folder below it)
          if (p) out.push({ id: name, size: it.size, ...p });
        }
        if (!l.more || !l.token) break;
        token = l.token;
      }
      return out;
    },
    async get(item, toFile) {
      if (!parseName(item.id)) throw new Error('no such backup');
      const r = await request(await signed({ method: 'GET', name: item.id }), { saveTo: toFile, timeout: 30 * 60e3 });
      if (r.status !== 200) throw failed(r, 'give the backup back');
    },
    async prune(keepNightly, keepManual) {
      const all = (await d.list()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      for (const [kind, keep] of [['nightly', keepNightly], ['manual', keepManual]]) {
        for (const old of all.filter((x) => x.kind === kind).slice(keep)) {
          const r = await request(await signed({ method: 'DELETE', name: old.id }), { method: 'DELETE', timeout: 30e3 });
          if (r.status !== 204 && r.status !== 200) throw failed(r, 'delete an old backup');
        }
      }
    },
    /** From a settings page (a hub's, or a computer's): straight on to the host, which checks it and keeps it. */
    async setUp(b) {
      const f = (k, n) => String(b?.[k] ?? '').slice(0, n);
      const r = await h.call('/storage/set', { endpoint: f('endpoint', 300), region: f('region', 40), bucket: f('bucket', 63), prefix: f('prefix', 200), keyId: f('keyId', 200), secret: f('secret', 300) }, { ms: 130e3 });
      if (!r) throw new Error('This device can’t keep a storage key.');
      if (!r.ok) throw new Error(r.body?.error || 'That didn’t work.');
      return { ok: true };
    },
    async remove() { await h.call('/storage/remove', {}, { ms: 10e3 }); },
  };
  return d;
}

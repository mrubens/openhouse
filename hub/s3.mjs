// The household's own storage bucket, for the keeper (docs/backups.md, "Your own storage"): anything that speaks
// S3 (Amazon S3, Cloudflare R2, Backblaze B2, MinIO...). The keeper keeps the access key and its secret, and signs
// (AWS Signature V4, query-string presigning) one request at a time for the bridge: one method, one object under the
// household's prefix (or the listing of that prefix), for a few minutes. The bridge sends it and reads the answer; the
// secret never leaves here. The shell's OwnStorage.kt does the same, in Kotlin, with the same answers.
import crypto from 'node:crypto';

const PRIVATE = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\]|[a-z0-9-]+\.local)$/i;
export const NAME = /^[A-Za-z0-9._-]{1,200}$/; // an object's name under the prefix: no slashes, so never outside it
export const EXPIRES = 900;

/** What the household typed, made plain, or { error } in words for them. Endpoint: https (http only at home). */
export function cleanStorage(b = {}) {
  const t = (v, n) => String(v ?? '').trim().slice(0, n);
  const region = t(b.region, 40).toLowerCase() || 'us-east-1';
  if (!/^[a-z0-9-]{2,40}$/.test(region)) return { error: 'That region doesn’t look right (like us-east-1, or auto).' };
  let endpoint = t(b.endpoint, 300) || `https://s3.${region}.amazonaws.com`;
  if (!/^[a-z]+:\/\//i.test(endpoint)) endpoint = `https://${endpoint}`;
  let u; try { u = new URL(endpoint); } catch { return { error: 'That address doesn’t look right (like https://s3.us-east-1.amazonaws.com).' }; }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return { error: 'The address is only the storage’s own, with no bucket or folder in it.' };
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && PRIVATE.test(u.hostname))) return { error: 'The address needs https:// (http:// only for storage on the home network).' };
  const bucket = t(b.bucket, 63);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/.test(bucket)) return { error: 'That bucket name doesn’t look right.' };
  const prefix = t(b.prefix, 200).replace(/^\/+|\/+$/g, '');
  if (prefix && (!/^[A-Za-z0-9._/-]{1,200}$/.test(prefix) || prefix.split('/').some((s) => !s || s === '.' || s === '..'))) return { error: 'A folder may have letters, digits, - _ . and /.' };
  const keyId = t(b.keyId, 200), secret = t(b.secret, 300);
  if (!/^[^\s/]{3,200}$/.test(keyId)) return { error: 'That access key ID doesn’t look right.' };
  if (!/^\S{8,300}$/.test(secret)) return { error: 'That secret doesn’t look right.' };
  return { cfg: { endpoint: `${u.protocol}//${u.host}`, region, bucket, prefix: prefix ? prefix + '/' : '', keyId, secret } };
}

/** The S3 way of escaping (RFC 3986): everything but letters, digits and - _ . ~ ; '/' too unless it's a path's. */
const enc = (s, path = false) => {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return path ? e.replace(/%2F/g, '/') : e;
};
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Amazon's own addresses use the bucket's own name (virtual-hosted); everything else, the bucket in the path. */
function where(cfg, key) {
  const u = new URL(cfg.endpoint);
  if (/(^|\.)amazonaws\.com$/.test(u.hostname) && !cfg.bucket.includes('.')) return { host: `${cfg.bucket}.${u.host}`, path: '/' + enc(key, true), proto: u.protocol };
  return { host: u.host, path: `/${enc(cfg.bucket)}` + (key ? '/' + enc(key, true) : ''), proto: u.protocol };
}

/** A presigned URL: SigV4, signed headers host only, the payload unsigned. */
export function presignRaw(cfg, { method, key = '', query = {}, expires = EXPIRES, now = new Date() }) {
  const { host, path, proto } = where(cfg, key);
  const amz = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'), day = amz.slice(0, 8);
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const q = { ...query, 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${cfg.keyId}/${scope}`, 'X-Amz-Date': amz, 'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': 'host' };
  const qs = Object.keys(q).map((k) => [enc(k), enc(String(q[k]))]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, path, qs, `host:${host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha(canonical)].join('\n');
  const k = hmac(hmac(hmac(hmac('AWS4' + cfg.secret, day), cfg.region), 's3'), 'aws4_request');
  return `${proto}//${host}${path}?${qs}&X-Amz-Signature=${hmac(k, toSign).toString('hex')}`;
}

/** The bridge's request (/storage/sign): only what a backup needs, only under the prefix. { url } or { error }. */
export function sign(cfg, b = {}) {
  const method = String(b.method || '').toUpperCase();
  if (b.list === true) {
    if (method !== 'GET') return { error: 'a listing is a GET' };
    const token = b.token == null ? null : String(b.token).slice(0, 1024);
    return { url: presignRaw(cfg, { method, query: { 'list-type': '2', prefix: cfg.prefix, 'max-keys': '1000', ...(token ? { 'continuation-token': token } : {}) } }) };
  }
  if (!['GET', 'PUT', 'DELETE', 'HEAD'].includes(method)) return { error: 'not a request this route signs' };
  if (!NAME.test(String(b.name || '')) || /^\.+$/.test(b.name)) return { error: 'not a name this route signs' };
  return { url: presignRaw(cfg, { method, key: cfg.prefix + b.name }) };
}

const code = (xml) => /<Code>([^<]{1,80})<\/Code>/.exec(xml || '')?.[1] || '';
/** What the storage's answer means, in words for the household; null when it's fine. */
export function said(status, xml, cfg, step) {
  if (status >= 200 && status < 300) return null;
  const c = code(xml), b = `“${cfg.bucket}”`;
  if (c === 'InvalidAccessKeyId') return 'That access key ID isn’t known there. Check you copied all of it.';
  if (c === 'SignatureDoesNotMatch') return 'The secret doesn’t fit that access key. Check you copied all of it.';
  if (c === 'NoSuchBucket') return `There’s no bucket called ${b} there.`;
  if (status === 301 || c === 'PermanentRedirect' || c === 'AuthorizationHeaderMalformed' || c === 'IllegalLocationConstraintException') {
    const r = /<Region>([^<]{1,40})<\/Region>/.exec(xml || '')?.[1];
    return `${b} is in another region${r ? ` (${r})` : ''}. Check the region.`;
  }
  if (status === 403 || c === 'AccessDenied') return `That key isn’t allowed to ${step === 'write' ? 'write to' : step === 'read' ? 'read from' : 'delete in'} ${b}. It needs to read, write and delete there.`;
  return `The storage answered ${status}${c ? ` (${c})` : ''}. Try again in a minute.`;
}

/** The Check: write a small file, read it back, delete it. null when all three work, else what went wrong. */
export async function check(cfg, { fetch: f = fetch } = {}) {
  const name = `opie-check-${crypto.randomBytes(6).toString('hex')}.txt`, text = `Opie checked this storage at ${new Date().toISOString()}.`;
  const go = async (method, step, body) => {
    let r;
    try { r = await f(sign(cfg, { method, name }).url, { method, body, redirect: 'manual', signal: AbortSignal.timeout(20e3) }); }
    catch { return { why: `Couldn’t reach ${new URL(cfg.endpoint).host}. Check the address and the internet.` }; }
    const t = await r.text().catch(() => '');
    return { why: said(r.status, t, cfg, step), text: t };
  };
  const w = await go('PUT', 'write', text); if (w.why) return w.why;
  const r = await go('GET', 'read'); if (r.why) return r.why;
  if (r.text !== text) return 'What was written didn’t read back the same. Check the address.';
  const d = await go('DELETE', 'delete'); if (d.why) return d.why;
  return null;
}

/** What may be said about it (never the key or the secret). */
export const shown = (cfg) => (cfg ? { set: true, endpoint: cfg.endpoint, region: cfg.region, bucket: cfg.bucket, prefix: cfg.prefix } : { set: false });

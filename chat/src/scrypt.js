// scrypt (RFC 7914) and SHA-256 in plain JS, for a page on plain http (no WebCrypto there): a TV's browser turns the
// pairing code it was given into the pairing id and one-time key, as the tablet does with Node's crypto.scrypt
// (bridge/pair-code.js). N=16384, r=8 is 16 MB and a few seconds on a slow TV, once.
const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
  0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

export function sha256(msg) {
  const len = msg.length, total = ((len + 9 + 63) >> 6) << 6, m = new Uint8Array(total);
  m.set(msg); m[len] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(total - 4, len * 8); dv.setUint32(total - 8, Math.floor(len / 0x20000000));
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), w = new Uint32Array(64);
  const ror = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < total; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = (w[i - 16] + (ror(a, 7) ^ ror(a, 18) ^ (a >>> 3)) + w[i - 7] + (ror(b, 17) ^ ror(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32), ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

function hmac(key, msg) {
  if (key.length > 64) key = sha256(key);
  const k = new Uint8Array(64); k.set(key);
  const inner = new Uint8Array(64 + msg.length), outer = new Uint8Array(96);
  for (let i = 0; i < 64; i++) { inner[i] = k[i] ^ 0x36; outer[i] = k[i] ^ 0x5c; }
  inner.set(msg, 64); outer.set(sha256(inner), 64);
  return sha256(outer);
}
/** PBKDF2-HMAC-SHA256 with one iteration (all scrypt needs). */
function pbkdf2(pass, salt, len) {
  const out = new Uint8Array(len), s = new Uint8Array(salt.length + 4); s.set(salt);
  for (let i = 1, at = 0; at < len; i++, at += 32) {
    new DataView(s.buffer).setUint32(salt.length, i);
    out.set(hmac(pass, s).subarray(0, Math.min(32, len - at)), at);
  }
  return out;
}

function salsa8(B, x) { // B: Uint32Array(16), in place
  x.set(B);
  const R = (a, b) => (a << b) | (a >>> (32 - b));
  for (let i = 0; i < 8; i += 2) {
    x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
    x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
    x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
    x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
    x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
    x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
    x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
    x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
  }
  for (let i = 0; i < 16; i++) B[i] = (B[i] + x[i]) | 0;
}
function blockMix(B, Y, r, x) { // B, Y: Uint32Array(32r)
  const X = B.slice((2 * r - 1) * 16, 2 * r * 16);
  for (let i = 0; i < 2 * r; i++) {
    for (let j = 0; j < 16; j++) X[j] ^= B[i * 16 + j];
    salsa8(X, x);
    Y.set(X, (i % 2 ? r + (i >> 1) : i >> 1) * 16);
  }
  B.set(Y);
}

/** scrypt(password, salt, N, r, p=1, len) -> Uint8Array. Strings are UTF-8. */
export function scrypt(password, salt, { N = 16384, r = 8, len = 32 } = {}) {
  const te = new TextEncoder();
  const P = typeof password === 'string' ? te.encode(password) : password, S = typeof salt === 'string' ? te.encode(salt) : salt;
  const b = pbkdf2(P, S, 128 * r), w = 32 * r;
  const B = new Uint32Array(w), dv = new DataView(b.buffer);
  for (let i = 0; i < w; i++) B[i] = dv.getUint32(i * 4, true);
  const V = new Uint32Array(w * N), Y = new Uint32Array(w), x = new Uint32Array(16);
  for (let i = 0; i < N; i++) { V.set(B, i * w); blockMix(B, Y, r, x); }
  for (let i = 0; i < N; i++) {
    const j = B[(2 * r - 1) * 16] & (N - 1);
    for (let k = 0; k < w; k++) B[k] ^= V[j * w + k];
    blockMix(B, Y, r, x);
  }
  for (let i = 0; i < w; i++) dv.setUint32(i * 4, B[i], true);
  return pbkdf2(P, b, len);
}

// The same as bridge/pair-code.js, for the browser.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function cleanCode(code) {
  const c = String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return c.length === 12 && [...c].every((x) => B32.includes(x)) ? c : null;
}
const b64u = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A typed code -> {pair, key} (both base64url), or null when it isn't a code. */
export function pairingFromCode(code) {
  const c = cleanCode(code);
  if (!c) return null;
  const d = scrypt(c, 'openhouse computer pairing', { N: 16384, r: 8, len: 38 });
  return { pair: b64u(d.subarray(0, 6)), key: b64u(d.subarray(6)) };
}

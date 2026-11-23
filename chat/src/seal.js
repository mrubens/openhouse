// ChaCha20-Poly1305 for the screen page (screen.jsx). Plain http on the home network has no WebCrypto, so the page
// seals and opens with this; the bridge uses Node's own (screens.js). A copy of the phone page's (shell assets/handoff.html),
// kept in step by bridge/test/screens.test.mjs, which checks it against Node both ways.
export const CP = (() => {
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  function block(k, ctr, n) { // k: Uint32Array(8), n: Uint32Array(3) -> 64 bytes
    const s = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574, ...k, ctr, ...n]), x = s.slice();
    const q = (a, b, c, d) => { x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 16); x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 12);
      x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 8); x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 7); };
    for (let i = 0; i < 10; i++) { q(0, 4, 8, 12); q(1, 5, 9, 13); q(2, 6, 10, 14); q(3, 7, 11, 15); q(0, 5, 10, 15); q(1, 6, 11, 12); q(2, 7, 8, 13); q(3, 4, 9, 14); }
    for (let i = 0; i < 16; i++) x[i] += s[i];
    return new Uint8Array(x.buffer);
  }
  const words = (b) => { const w = new Uint32Array(b.length / 4), v = new DataView(b.buffer, b.byteOffset, b.length); for (let i = 0; i < w.length; i++) w[i] = v.getUint32(i * 4, true); return w; };
  function xor(key, nonce, ctr, data) {
    const k = words(key), n = words(nonce), out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 64) { const ks = block(k, ctr++, n); for (let j = 0; j < 64 && i + j < data.length; j++) out[i + j] = data[i + j] ^ ks[j]; }
    return out;
  }
  const num = (b) => { let r = 0n; for (let i = b.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(b[i]); return r; };
  function poly(key, msg) {
    const r = num(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn, s = num(key.subarray(16, 32)), p = (1n << 130n) - 5n;
    let a = 0n;
    for (let i = 0; i < msg.length; i += 16) { const c = msg.subarray(i, i + 16); a = ((a + num(c) + (1n << BigInt(8 * c.length))) * r) % p; }
    a = (a + s) & ((1n << 128n) - 1n);
    const t = new Uint8Array(16); for (let i = 0; i < 16; i++) { t[i] = Number(a & 0xffn); a >>= 8n; } return t;
  }
  function mac(key, nonce, aad, ct) {
    const pad = (n) => (16 - (n % 16)) % 16, m = new Uint8Array(aad.length + pad(aad.length) + ct.length + pad(ct.length) + 16);
    m.set(aad, 0); m.set(ct, aad.length + pad(aad.length));
    const v = new DataView(m.buffer, m.length - 16); v.setUint32(0, aad.length, true); v.setUint32(8, ct.length, true);
    return poly(block(words(key), 0, words(nonce)).subarray(0, 32), m);
  }
  return {
    seal(key, nonce, aad, pt) { const ct = xor(key, nonce, 1, pt), out = new Uint8Array(12 + ct.length + 16); out.set(nonce); out.set(ct, 12); out.set(mac(key, nonce, aad, ct), 12 + ct.length); return out; },
    open(key, aad, box) {
      const nonce = box.subarray(0, 12), ct = box.subarray(12, box.length - 16), tag = box.subarray(box.length - 16);
      const want = mac(key, nonce, aad, ct); let d = 0; for (let i = 0; i < 16; i++) d |= want[i] ^ tag[i];
      return d || box.length < 28 ? null : xor(key, nonce, 1, ct);
    },
  };
})();
export const b64 = { dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
  enc: (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };

// A computer's pairing code (screens.js on the tablet, connect/openhouse-mcp.mjs on the computer, which bundles only
// this file of the bridge): Crockford base32 (no I, L, O, U), 12 characters, shown as XXXX-XXXX-XXXX. A person
// types it, so it's short (60 bits); the pairing id and one-time key come from it through scrypt, so a recorded
// hello can't be guessed back to the code while the pairing lasts (10 minutes, 5 wrong tries).
import crypto from 'node:crypto';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const b64 = (b) => Buffer.from(b).toString('base64url');

export function newCode() {
  const b = crypto.randomBytes(12);
  let c = ''; for (const x of b) c += B32[x & 31];
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}

/** The code as typed ("k7qm 2xd9 hpa4", with O for 0 or I for 1) -> its 12 characters, or null. */
export function cleanCode(code) {
  const c = String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return c.length === 12 && [...c].every((x) => B32.includes(x)) ? c : null;
}

/** The pairing id and one-time key a code stands for (both sides compute it). null: not a code. */
export function pairingFromCode(code) {
  const c = cleanCode(code);
  if (!c) return null;
  const d = crypto.scryptSync(c, 'openhouse computer pairing', 38, { N: 16384, r: 8, p: 1 });
  return { pair: b64(d.subarray(0, 6)), key: d.subarray(6) };
}

/** pairingFromCode off the event loop (a code typed on a public page: scrypt mustn't stall the bridge). */
export async function pairingFromCodeAsync(code) {
  const c = cleanCode(code);
  if (!c) return null;
  const d = await new Promise((resolve, reject) => crypto.scrypt(c, 'openhouse computer pairing', 38, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k))));
  return { pair: b64(d.subarray(0, 6)), key: d.subarray(6) };
}

// Xbox One / Series consoles: SmartGlass discovery and power-on, UDP port 5050. Both are
// unauthenticated. Turning it off needs SmartGlass's encrypted session, which this doesn't do.
import crypto from 'node:crypto';
import { udp, sleep } from '../net.js';

const sgstr = (s) => { const b = Buffer.from(s, 'utf8'); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b, Buffer.from([0])]); };
function packet(type, payload) {
  const h = Buffer.alloc(6); h.writeUInt16BE(type, 0); h.writeUInt16BE(payload.length, 2); h.writeUInt16BE(type === 0xdd02 ? 0 : 0, 4);
  return Buffer.concat([h, payload]);
}
// Discovery request: flags 0, client type 8 (Android), versions 0..2.
const DISCOVER = packet(0xdd00, Buffer.from([0, 0, 0, 0, 0, 8, 0, 0, 0, 2]));

/** Ask the console who it is: { name, uuid, liveId } or null when it doesn't answer (off, or fully off). */
export async function discover(address) {
  const replies = await udp(DISCOVER, [address], 5050, { times: 2, listen: 1500, first: true });
  for (const r of replies) {
    const b = r.data;
    if (b.readUInt16BE(0) !== 0xdd01) continue;
    let o = 6 + 4 + 2; // header, flags, console type
    const str = () => { const l = b.readUInt16BE(o); const s = b.toString('utf8', o + 2, o + 2 + l); o += 3 + l; return s; };
    const name = str(), uuid = str();
    o += 4; // last error
    const cl = b.readUInt16BE(o); const der = b.subarray(o + 2, o + 2 + cl);
    let liveId = null;
    try { liveId = new crypto.X509Certificate(der).subject.match(/CN=(\w+)/)?.[1] || null; } catch {}
    return { name, uuid, liveId };
  }
  return null;
}

export default {
  id: 'xbox', label: 'Xbox',
  match: (d) => d.ssdp.some((s) => /xbox/i.test(`${s.desc?.modelName} ${s.desc?.friendlyName}`)),
  async identify(d, ctx) {
    const x = await discover(d.address).catch(() => null);
    if (x?.liveId) { ctx.pairing.liveId = x.liveId; ctx.save(); }
    const desc = d.ssdp.find((s) => /xbox/i.test(s.desc?.modelName || ''))?.desc;
    const name = x?.name || desc?.friendlyName;
    return { name: !name || name === 'XBOX' ? 'Xbox' : name, maker: 'Microsoft', model: desc?.modelName || 'Xbox', kind: 'console',
      notes: ['openhouse can turn it on (when its power mode is "Sleep"), not off (turning off needs the Xbox app\'s encrypted connection).'] };
  },
  actions: {
    status: {
      says: 'Whether it is on',
      async run(d) { const x = await discover(d.address).catch(() => null); return { power: x ? 'on' : 'off or asleep (not answering)' }; },
    },
    power_on: {
      says: 'Turn the console on', risky: true, // only from the Xbox's "Sleep" power mode, not "Shutdown"
      async run(d, p, ctx) {
        const id = ctx.pairing.liveId;
        if (await discover(d.address).catch(() => null)) return 'The Xbox is already on.';
        if (!id) throw new Error('openhouse has not seen this Xbox switched on yet, so it does not know its id. Turn it on once by hand, then scan again.');
        const pkt = packet(0xdd02, sgstr(id));
        for (let i = 0; i < 5; i++) { await udp(pkt, [d.address, '255.255.255.255'], 5050, { broadcast: true }); await sleep(200); }
        for (let i = 0; i < 10; i++) { if (await discover(d.address).catch(() => null)) return 'The Xbox is on.'; await sleep(1000); }
        return 'Sent the wake signal; the Xbox has not answered yet.';
      },
    },
  },
};

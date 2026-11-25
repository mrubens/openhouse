// The home network listener (screens.js startLan): a connection that sends nothing, or only part of a request, is
// closed, and turning the listener off closes the connections it has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { screensRoutes } from '../screens.js';

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const closed = (sock, ms) => new Promise((r) => { const t = setTimeout(() => r(false), ms); sock.once('close', () => { clearTimeout(t); r(true); }); });
// (each read as it comes: a socket only closes once what came is read)
const connect = (port) => new Promise((r, j) => { const s = net.connect(port, '127.0.0.1', () => r(s)); s.on('error', () => {}); s.on('data', () => {}); s.once('error', j); });

test('a connection on the home network that stalls is closed, and so is every one when it goes off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-lan-')), FILE = path.join(dir, 'screens.json');
  fs.writeFileSync(FILE, JSON.stringify({ lan: true, screens: [] }));
  const PORT = await freePort();
  const s = screensRoutes({ HERE: dir, FILE, PORT, HOST: '127.0.0.1', LAN_MS: { headers: 300, request: 300, idle: 600, tick: 50 },
    json: () => {}, body: async () => ({}), dispatch: () => {} });
  try {
    await new Promise((r) => setTimeout(r, 100));
    const silent = await connect(PORT);
    assert.ok(await closed(silent, 2000), 'nothing sent');
    const half = await connect(PORT); half.write('GET /pair/about HTTP/1.1\r\nHost: x\r\n');
    assert.ok(await closed(half, 2000), 'headers never finished');
    const slow = await connect(PORT); slow.write('POST /pair/x HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nab');
    assert.ok(await closed(slow, 2000), 'body never finished');
    const open = await connect(PORT); open.write('GET /pair/about HTTP/1.1\r\nHost: x\r\n\r\n');
    await new Promise((r) => open.once('data', r)); // answered, kept alive
    const gone = closed(open, 250);
    s.stop();
    assert.ok(await gone, 'closed when the listener went off');
  } finally { s.stop?.(); }
});

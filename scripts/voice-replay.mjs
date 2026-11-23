#!/usr/bin/env node
// Run a test recording from the display (scripts/voice-rec.sh) through the wake listener again, on the Mac: the same
// microphone audio, so a changed wake model or threshold can be compared with when it woke in the room. Prints when it
// woke then next to when it wakes now.
//
//   VOICE_DIR=<dir with models/wake/ and node_modules/onnxruntime-node> node scripts/voice-replay.mjs <recording.jsonl or a folder of them>
//
// With <recording>.truth.txt next to it (when its name was really said, by hand), it scores the replay:
//   0:12.4  yes  hey opie what's the weather tomorrow      said to it: it should wake here
//   0:31.0  no   okay, please pass the peas                not to it: it shouldn't
// A wake from a second before a "yes" line to five seconds after counts for it; any other wake is a false one.
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RATE = 16000, CH = 1600;
const target = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!target) { console.error('usage: voice-replay.mjs <recording.jsonl | folder>'); process.exit(2); }
const VOICE = path.resolve(process.env.VOICE_DIR || path.join(ROOT, 'voice'));
const recs = fs.statSync(target).isDirectory() ? fs.readdirSync(target).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(target, f)) : [target.replace(/\.(pcm|truth\.txt)$/, '.jsonl')];
const mmss = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

let w = null, onMsg = null;
async function listener(level) { // a new one for each recording, starting at the recording's microphone level
  w?.kill();
  w = fork(path.join(ROOT, 'bridge/voice-worker.js'), [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, VOICE_WORKER_DIR: VOICE, ...(level ? { VOICE_LEVEL: String(level) } : {}) } });
  const r = await new Promise((res) => w.on('message', (m) => { if (m.type === 'ready') res(m); else onMsg?.(m); }));
  if (!r.model) { console.error(r.error); process.exit(1); }
}
async function replay(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const head = lines.find((l) => l.start) || {}, b = fs.readFileSync(file.replace(/\.jsonl$/, '.pcm'));
  const audio = new Float32Array(b.length >> 1); for (let i = 0; i < audio.length; i++) audio[i] = b.readInt16LE(i * 2) / 32768;
  await listener(head.level);
  const now = []; let pos = 0, pend = null;
  onMsg = (m) => { if (m.type === 'ack' || m.type === 'flushed') { pend?.(); return; } if (m.type === 'wake') now.push({ at: pos / RATE, p: m.p }); };
  const wait = (msg) => new Promise((r) => { pend = r; w.send(msg); });
  for (; pos < audio.length; pos += CH) { w.send({ type: 'audio', src: 'mic', samples: audio.subarray(pos, pos + CH) }); if ((pos / CH) % 10 === 9) await wait({ type: 'audio', src: 'mic', ack: true }); }
  pos = audio.length; await wait({ type: 'audio', src: 'mic', flush: true });
  const then = lines.filter((l) => l.out?.type === 'wake').map((l) => ({ at: l.at / RATE, p: l.out.p }));
  return { seconds: audio.length / RATE, then, now };
}
function truthOf(file) {
  const f = file.replace(/\.jsonl$/, '.truth.txt'); if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8').split('\n').map((l) => l.match(/^\s*(\d+):(\d+(?:\.\d+)?)\s+(yes|no)\s+(.*)$/i)).filter(Boolean).map((m) => ({ at: +m[1] * 60 + +m[2], forIt: m[3].toLowerCase() === 'yes', text: m[4].trim() }));
}
function score(truth, wakes) {
  const used = new Set(); let got = 0;
  const yes = truth.filter((t) => t.forIt);
  for (const t of yes) { const i = wakes.findIndex((x, k) => !used.has(k) && x.at > t.at - 1 && x.at < t.at + 5); if (i >= 0) { used.add(i); got++; } }
  return `heard ${got}/${yes.length}, false wakes ${wakes.length - used.size}`;
}
for (const file of recs) {
  const name = path.basename(file, '.jsonl'), r = await replay(file), truth = truthOf(file);
  console.log(`\n${name}  (${mmss(r.seconds)})`);
  const rows = [...r.then.map((x) => ({ ...x, who: 'then' })), ...r.now.map((x) => ({ ...x, who: 'now ' }))].sort((a, b) => a.at - b.at);
  for (const x of rows) console.log(`  ${mmss(x.at).padStart(7)}  ${x.who}  woke (${x.p})`);
  console.log(`  woke then ${r.then.length}, now ${r.now.length}`);
  if (truth) console.log(`  against what was really said (${truth.length} lines): then ${score(truth, r.then)}; now ${score(truth, r.now)}`);
}
w?.kill();
process.exit(0);

#!/usr/bin/env node
// The wake-word test set (scripts/wake/testset.py, docs/wake-word.md) through the real listener (bridge/voice-worker.js),
// on the Mac: voices the model never trained on, in four rooms, out of 10 heard; near-miss sentences; and false wakes
// an hour on hours of other sound. Every score is kept in the report, to try thresholds afterwards.
//
//   VOICE_DIR=<dir with models/wake/ and node_modules/onnxruntime-node> node scripts/wake/bench.mjs --set <testset dir>
//     [--skip-voices <file: voices the model trained on>] [--every 4: a quarter of the clips] [--hours 1] [--out report.json]
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RATE = 16000, CH = 1600;
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const VOICE = path.resolve(process.env.VOICE_DIR || path.join(ROOT, 'voice'));
const SET = path.resolve(arg('set', path.join(process.env.HOME, '.cache/openhouse-wake/testset')));
const man = JSON.parse(fs.readFileSync(path.join(SET, 'manifest.json'), 'utf8'));
const T = Number(process.env.VOICE_WAKE_THRESHOLD) || 0.98;

const w = fork(path.join(ROOT, 'bridge/voice-worker.js'), [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, VOICE_WORKER_DIR: VOICE, VOICE_DEBUG_WAKE: '1' } });
let onMsg = null;
const model = await new Promise((r) => w.on('message', (m) => { if (m.type === 'ready') r(m); else onMsg?.(m); }));
if (!model.model) { console.error(model.error); process.exit(1); }
const pcm = (f) => { const b = fs.readFileSync(path.join(SET, f)); const i = new Int16Array(b.buffer, b.byteOffset, b.length >> 1), o = new Float32Array(i.length); for (let k = 0; k < i.length; k++) o[k] = i[k] / 32768; return o; };
/** Stream it through the "microphone", 100 ms at a time, waiting for the scores as real time would. */
let n = 0;
async function run(audio) {
  const src = 'mic', out = []; let sent = 0, wait = null;
  onMsg = (m) => { if (m.type === 'ack' || m.type === 'flushed') { wait?.(m); return; } if (m.type === 'wake-score' || m.type === 'wake') out.push({ ...m, at: sent }); };
  for (let i = 0; i < audio.length; i += CH) {
    w.send({ type: 'audio', src, samples: audio.subarray(i, i + CH) }); sent = i + CH;
    if (++n % 10 === 0) await new Promise((r) => { wait = r; w.send({ type: 'audio', src, ack: true }); });
  }
  await new Promise((r) => { wait = r; w.send({ type: 'audio', src, flush: true }); });
  return out;
}
const every = Number(arg('every', 1));
const skip = new Set(arg('skip-voices') ? fs.readFileSync(arg('skip-voices'), 'utf8').split('\n').filter(Boolean) : []);
const pick = (xs) => xs.filter((x) => !skip.has(String(x.voice).replace(/-kid$/, ''))).filter((_, i) => i % every === 0);
const peak = (evs) => evs.filter((e) => e.type === 'wake-score').reduce((m, e) => Math.max(m, e.p), 0);
const res = { threshold: T, positives: {}, near: {}, streams: {}, scores: { positives: [], near: [], streams: {} } };

const by = {};
for (const p of pick(man.positives)) {
  const evs = await run(pcm(p.file)), woke = evs.some((e) => e.type === 'wake');
  const k = p.voice === 'recorded' ? `recorded-${p.cond}` : p.cond; (by[k] ||= { n: 0, woke: 0 }).n++; if (woke) by[k].woke++;
  res.scores.positives.push({ voice: p.voice, cond: p.cond, p: peak(evs), woke });
}
for (const [k, b] of Object.entries(by)) res.positives[k] = { heard: `${b.woke}/${b.n}`, outOf10: +(10 * b.woke / b.n).toFixed(1) };
let nn = 0, nw = 0;
for (const p of pick(man.near)) { const evs = await run(pcm(p.file)); nn++; if (evs.some((e) => e.type === 'wake')) nw++; res.scores.near.push({ text: p.text, p: peak(evs) }); }
res.near = { woke: `${nw}/${nn}` };
const PIECE = 10 * 60 * RATE, hoursMax = Number(arg('hours', 99));
for (const s of man.streams) {
  const audio = pcm(s.file); let woke = 0, done = 0;
  for (let i = 0; i < audio.length && done < hoursMax * 3600 * RATE; i += PIECE) {
    const evs = await run(audio.subarray(i, i + PIECE)); done += Math.min(PIECE, audio.length - i);
    woke += evs.filter((e) => e.type === 'wake').length;
    (res.scores.streams[s.file] ||= []).push(...evs.filter((e) => e.type === 'wake-score').map((e) => [+((i + e.at) / RATE).toFixed(2), e.p]));
  }
  const h = done / RATE / 3600; res.streams[s.file.replace('.pcm', '')] = { kind: s.kind, hours: +h.toFixed(2), wokePerHour: +(woke / h).toFixed(2) };
  console.log(`  ${s.kind}: ${h.toFixed(1)} h, woke ${woke}`);
}
const H = Object.values(res.streams).reduce((a, s) => a + s.hours, 0);
res.streams.all = { hours: +H.toFixed(2), wokePerHour: +(Object.values(res.streams).reduce((a, s) => a + s.wokePerHour * s.hours, 0) / (H || 1)).toFixed(2) };
console.log(`\nWAKE TEST SET at ${T}: heard out of 10: ${Object.entries(res.positives).map(([k, v]) => `${k} ${v.outOf10}`).join(', ')}; near-misses woke ${res.near.woke}; ${res.streams.all.hours} h of other sound: ${res.streams.all.wokePerHour} false wakes an hour`);
fs.writeFileSync(arg('out', path.join(process.env.HOME, '.cache/openhouse-wake/bench.json')), JSON.stringify(res));
w.kill();

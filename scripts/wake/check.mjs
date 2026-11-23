// Does the display's listener (bridge/wake.js, JavaScript) score sound as the model was trained to (features.py,
// Python)? Scores a clip both ways and prints the largest difference over the 80 ms steps.
//
//   node scripts/wake/check.mjs <dir with node_modules/onnxruntime-node> <models/wake dir> <clip.pcm: 16 kHz s16le> <python scores.json>
//
// scores.json from: python -c "import features..." (see docs/wake-word.md, "Checking the listener").
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { wakeListener } from '../../bridge/wake.js';

const [voiceDir, wakeDir, clip, pyScores] = process.argv.slice(2);
const ort = createRequire(path.join(path.resolve(voiceDir), 'package.json'))('onnxruntime-node');
const b = fs.readFileSync(clip), x = Float32Array.from(new Int16Array(b.buffer, b.byteOffset, b.length >> 1), (v) => v / 32768);
const scores = [];
const listen = (await wakeListener(ort, path.resolve(wakeDir)))((p, end) => scores.push({ p, end }));
for (let i = 0; i < x.length; i += 1600) listen.push(x.subarray(i, i + 1600));
await listen.idle();
const py = pyScores ? JSON.parse(fs.readFileSync(pyScores, 'utf8')) : null;
if (!py) { console.log(JSON.stringify(scores.map((s) => +s.p.toFixed(4)))); process.exit(0); }
// Line up by the sample each window ends at.
const byEnd = new Map(py.map((s) => [s.end, s.p]));
let worst = 0, n = 0;
for (const s of scores) if (byEnd.has(s.end)) { worst = Math.max(worst, Math.abs(s.p - byEnd.get(s.end))); n++; }
const peak = (a) => Math.max(...a.map((s) => s.p));
console.log(`${n} steps compared; largest difference ${worst.toFixed(4)}; peak JS ${peak(scores).toFixed(3)}, Python ${peak(py).toFixed(3)}`);
process.exit(worst < 0.05 ? 0 : 1);

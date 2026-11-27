// The wake word's listener, in a child process so the models never stall the bridge. Audio in (16 kHz mono float),
// per source; the wake model (bridge/wake.js, models/wake/) scores every 80 ms, and a score of at least
// the model's own threshold (models/wake/opie.json, 0.9 without one) is "Hey Opie". That's all it does: nothing is transcribed, kept or sent anywhere. What comes
// after the name is OpenAI's live voice's to hear (shell LiveVoice). docs/wake-word.md
//
// In:  {type: 'audio', src, samples?, flush?, ack?, at?}, {type: 'wake-on', on}, {type: 'mic-level', level},
//      {type: 'check', on}, {type: 'check-get'} (the microphone check: voice.js /voice/check)
// Out: {type: 'ready', model, wake}, {type: 'wake', src, by: 'model', p}, {type: 'model-wake', src, p, what},
//      {type: 'mic-level', level}, {type: 'note', text}, {type: 'ack', at}, {type: 'flushed', src, woke, peak},
//      {type: 'check', ...checkNow()} (to check-get, and when a check ends),
//      and with VOICE_DEBUG_WAKE {type: 'wake-score', src, p} (the bench).
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { wakeListener, WAKE_DIR, WAKE_FILES } from './wake.js';

const dir = process.env.VOICE_WORKER_DIR;
const port = { post: (m) => process.send(m), on: (f) => process.on('message', f) };
process.on('disconnect', () => process.exit(0));
const need = createRequire(path.join(dir, 'package.json'));
const RATE = 16000;
const WAKE_PHRASES = ['hey opie']; // the same in every home (voice.js WAKE_PHRASES)
// The threshold comes with the model (models/wake/opie.json, from the same voice set), so a tablet never runs one
// model at another's threshold while a new set downloads: round 4's scores spread up to 1 and it wakes at 0.98, where
// round 3's would hardly ever. Without the file (voice sets up to 4): 0.9, round 3's. VOICE_WAKE_THRESHOLD overrides
// both (the bench). docs/wake-word.md
// The same file can fix the microphone's gain and set a loudness floor (below): since voice set 6, only someone near
// and clear wakes it (a murmur across the room no longer gets turned up 30 times).
const conf = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'models', WAKE_DIR, 'opie.json'), 'utf8')) || {}; } catch { return {}; } })();
const WAKE_T = Number(process.env.VOICE_WAKE_THRESHOLD) || Number(conf.threshold) || 0.9;
const AGAIN = 1.5 * RATE; // the same name, a frame later, isn't a second wake

let wakeOn = true;

// Microphone gain. Tablet microphones can be very quiet (the Galaxy Tab S10 FE's peaked at 0.026 of full scale for its
// name at arm's length), and the model was trained on sound brought up as this does (scripts/wake/features.py): the
// loud moments of the last minute (each 2 s's peak, if well above the room's own quiet) toward 0.3 of full scale, at
// most 32x, squashed (tanh) so a voice next to it isn't clipped. The level is kept by the bridge across restarts.
const fixedGain = Number(process.env.VOICE_MIC_GAIN) || Number(conf.gain) || 0; // (opie.json "gain": a fixed gain, no learning)
const MAX_GAIN = Number(process.env.VOICE_MAX_GAIN) || 32;
let micGain = fixedGain || 1, level = null, floorPk = null, winPeak = 0, winN = 0, sentLevel = null;
const peaks = []; // the last 30 two-second peaks that were more than the room
function setLevel(l) { if (fixedGain || !(l > 0.002)) return; level = l; micGain = Math.max(1, Math.min(MAX_GAIN, 0.3 / l)); }
if (Number(process.env.VOICE_LEVEL) > 0.002) setLevel(Number(process.env.VOICE_LEVEL)); // (a replay: start where the recording's listener was)
function learn(x) {
  if (fixedGain) return;
  for (let i = 0; i < x.length; i += 1600) { // a tenth of a second at a time: the room's level (down at once, up over minutes)
    let p = 0; const e = Math.min(x.length, i + 1600); for (let j = i; j < e; j += 2) { const a = Math.abs(x[j]); if (a > p) p = a; }
    if (p > winPeak) winPeak = p;
    if (e - i >= 800) floorPk = floorPk == null ? p : p < floorPk ? 0.9 * floorPk + 0.1 * p : 0.999 * floorPk + 0.001 * p;
  }
  winN += x.length; if (winN < 2 * RATE) return;
  if (winPeak >= Math.max(0.004, 3 * (floorPk || 0))) { peaks.push(winPeak); if (peaks.length > 30) peaks.shift(); }
  winN = 0; winPeak = 0;
  if (peaks.length < 3) return;
  const s = [...peaks].sort((a, b) => a - b), l = s[Math.floor(s.length * 0.75)];
  setLevel(level == null ? l : 0.7 * level + 0.3 * l);
  if (sentLevel == null || Math.abs(Math.log(level / sentLevel)) > 0.2) { sentLevel = level; port.post({ type: 'mic-level', level: +level.toFixed(4) }); }
}
// A loudness floor (VOICE_WAKE_FLOOR, of full scale, before the gain; off when 0): a wake needs the microphone's loudest
// moment in the last 1.3 s to reach it, so only someone near and clear wakes it, never a murmur the gain brought up.
const FLOOR = Number(process.env.VOICE_WAKE_FLOOR) || Number(conf.floor) || 0; // (opie.json "floor")
const rawPeaks = new Float32Array(13); let rawI = 0; // (the mic's peak each 0.1 s, the last 1.3 s)
function rawPeak(x) { for (let i = 0; i < x.length; i += 1600) { let p = 0; const e = Math.min(x.length, i + 1600); for (let j = i; j < e; j++) { const a = Math.abs(x[j]); if (a > p) p = a; } rawPeaks[rawI++ % 13] = p; } }
const loudEnough = () => !FLOOR || Math.max(...rawPeaks) >= FLOOR;
const amplify = (x, g) => { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = Math.tanh(x[i] * g); return y; };

// The microphone check (Settings → Voice, or asked of Opie): for a few seconds the microphone's own loudness each 0.1 s
// (before the gain) and the wake model's best score. A "Hey Opie" heard then is the check's, not a wake: nothing opens,
// and it isn't counted with the false wakes. Only numbers are kept, and only until the check ends.
let check = null;
function checkNow(c = check) {
  if (!c) return null;
  const s = [...c.peaks].sort((a, b) => a - b);
  return { heard: c.heard, best: +c.best.toFixed(3), peak: +(s[s.length - 1] || 0).toFixed(4), room: +(s[Math.floor(s.length * 0.2)] || 0).toFixed(4),
    seconds: +(c.n / RATE).toFixed(1), silent: c.n > 0 && !c.sound, floor: FLOOR, threshold: WAKE_T, ready: !!wakeModel };
}
function checkHear(x) {
  check.n += x.length;
  for (let i = 0; i < x.length; i += 1600) { let p = 0; const e = Math.min(x.length, i + 1600); for (let j = i; j < e; j++) { const a = Math.abs(x[j]); if (a > p) p = a; } check.peaks.push(p); if (p > 0) check.sound = true; }
  if (check.peaks.length > 600) check.peaks.splice(0, check.peaks.length - 600);
}

let wakeModel = null, why = null;
const srcs = new Map(); // src -> {listen, n (samples so far), firedAt, peak, woke}
const M = (...p) => path.join(dir, 'models', ...p);
const load = (async () => {
  const d = M(WAKE_DIR);
  if (!WAKE_FILES.every((f) => fs.existsSync(path.join(d, f))) || !fs.existsSync(path.join(dir, 'node_modules', 'onnxruntime-node'))) { why = `no wake model in ${dir}`; return; }
  try { wakeModel = await wakeListener(need('onnxruntime-node'), d); }
  catch (e) { why = `the wake model didn't load (${e.message})`; }
})();

function state(src) {
  if (!srcs.has(src)) { const v = { n: 0, firedAt: -Infinity, peak: 0, woke: 0 }; v.listen = wakeModel((p, end) => heard(src, v, p, end)); srcs.set(src, v); }
  return srcs.get(src);
}
function heard(src, v, p, end) {
  if (p > v.peak) v.peak = p;
  if (process.env.VOICE_DEBUG_WAKE && p >= 0.05) port.post({ type: 'wake-score', src, p: +p.toFixed(3) });
  if (check && src === 'mic') { if (p > check.best) check.best = p; if (p >= WAKE_T && loudEnough()) check.heard = true; return; } // (the check's: no wake)
  if (p < WAKE_T || !wakeOn || end - v.firedAt < AGAIN) return;
  if (src === 'mic' && !loudEnough()) return;
  v.firedAt = end; v.woke++;
  port.post({ type: 'model-wake', src, p: +p.toFixed(3), what: 'wake' }); // (the bridge keeps when and how sure: voice-wakes.jsonl)
  port.post({ type: 'wake', src, by: 'model', p: +p.toFixed(2) });
}

function take(msg) {
  if (msg.type === 'wake-on') { wakeOn = !!msg.on; return; }
  if (msg.type === 'mic-level') { if (level == null) setLevel(Number(msg.level)); return; }
  if (msg.type === 'check') {
    if (msg.on) { check = { peaks: [], best: 0, heard: false, n: 0, sound: false }; return; }
    const was = check, mic = srcs.get('mic'); // (once what it has heard is scored)
    Promise.resolve(mic && wakeModel ? mic.listen.idle() : null).then(() => { if (check === was) check = null; port.post({ type: 'check', ...checkNow(was) }); });
    return;
  }
  if (msg.type === 'check-get') { port.post({ type: 'check', ...checkNow() }); return; }
  if (msg.type === 'audio' && msg.src === 'mic' && check && msg.samples?.length) checkHear(msg.samples);
  if (msg.type !== 'audio' || !wakeModel) return;
  const src = msg.src, v = state(src);
  if (msg.samples?.length) {
    if (src === 'mic') { learn(msg.samples); rawPeak(msg.samples); }
    v.listen.push(src === 'mic' && micGain > 1.05 ? amplify(msg.samples, micGain) : msg.samples); v.n += msg.samples.length;
  }
  if (msg.ack) v.listen.idle().then(() => port.post({ type: 'ack', at: msg.at })); // (a bench or replay waits for the scores, as real time would)
  if (msg.flush) {
    v.listen.push(new Float32Array(RATE / 2)); // (the end of a name said last)
    v.listen.idle().then(() => { port.post({ type: 'flushed', src, woke: v.woke, peak: +v.peak.toFixed(3) }); if (src !== 'mic') srcs.delete(src); else { v.peak = 0; v.woke = 0; } });
  }
}
// A mistake in here must not stop the listening: what it was hearing from that source is dropped, the error is noted
// (at most once every ten seconds), and it listens on.
let erredAt = 0;
port.on((msg) => {
  try { take(msg); } catch (e) {
    if (msg?.src) srcs.delete(msg.src);
    if (Date.now() - erredAt > 10000) { erredAt = Date.now(); port.post({ type: 'note', text: `listening error (it carried on): ${e?.message || e}` }); }
  }
});
load.then(() => port.post(wakeModel ? { type: 'ready', model: 'wake model', wake: WAKE_PHRASES } : { type: 'ready', model: null, error: why, wake: WAKE_PHRASES }));

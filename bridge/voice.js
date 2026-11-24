// Listening for its name. The shell streams the microphone here; a small wake model (bridge/voice-worker.js,
// bridge/wake.js) listens for "Hey Opie" and nothing else: no speech is transcribed, kept or sent anywhere, and no audio is
// stored (except a test recording someone switched on: see `rec` below; the display shows a dot while one runs; and,
// where a household switched it on, a few seconds around each wake: see `clips` below).
// When it hears its name, the display hands the microphone to OpenAI's live voice (shell LiveVoice), which hears the
// request; with the live voice off, the display says how to turn it on. There are no other speech models on the
// tablet (docs/wake-word.md, docs/voice-models.md).
//
// POST /voice/stream            raw s16le 16 kHz mono, one long upload from the shell's microphone
// POST /voice/utterance         a recording (16 kHz wav or raw) fed in as if heard; replies {woke, peak} (a test hook)
// GET  /voice/status            {ready, error, download, listening, wakeOn, ...}
// POST /voice/reload            the display put (new) models in place: start the listener again on them
// POST /voice/wake {on}         wake to "Hey Opie", or only to a tap; remembered
// GET  /voice/wakes?n=          when the wake model fired and how sure it was (no sound or words), with the last hour's
//                               and day's counts; POST /voice/wakes/clear empties it
// POST /voice/say {text}        an app's words: the display says them (its live voice, or the tablet's speech engine)
// POST /voice/log/setting {on}  keep the speech log or not (off deletes it); GET /voice/log?n= reads it
// POST /voice/record {on, minutes?}  test recording (see below): off unless switched on; GET /voice/record lists,
//                               GET /voice/record/<file> reads one, POST /voice/record/clear deletes them all
// POST /voice/clips/setting {on} keep ~3 s around each wake on this tablet, to learn this home's false wakes (off by
//                               default; off deletes them); GET /voice/clips lists, GET /voice/clips/<file> reads one (wav),
//                               POST /voice/clips/clear deletes them all
// GET  /voice/events            SSE: wake, say, recording

import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WAKE_DIR, WAKE_FILES } from './wake.js';

const RATE = 16000;
// The wake word is the same for every household: "Hey Opie" (since voice set 9; "Opie" alone woke it before). docs/wake-word.md
export const WAKE_PHRASES = ['hey opie'];
// What the listening used to need, gone from a tablet when it starts (the models of voice sets 1 and 2, and what the
// bridge kept for them): the speech model, the speaker model, the keyword spotter, the voices, the voice detector, the
// turn model and sherpa-onnx. Only models/wake/ and onnxruntime-node stay.
const KEEP_MODELS = new Set([WAKE_DIR]), KEEP_MODULES = new Set(['onnxruntime-node', 'onnxruntime-common']);
const OLD_FILES = ['voiceprints.json', 'voice-echo.on', 'voice-echo-room.json', 'voice-wake-model.on'];

export function voiceRoutes({ HERE, DIR, json, body }) {
  const VOICE = path.resolve(process.env.VOICE_DIR || path.join(HERE, '../voice'));
  // How the display's download of the models is going (VoiceModels.kt writes it): {state, got, total, error?}.
  const downloading = () => { try { return JSON.parse(fs.readFileSync(path.join(VOICE, 'download.json'), 'utf8')); } catch { return null; } };
  for (const f of OLD_FILES) try { fs.rmSync(path.join(DIR, f), { force: true }); } catch {}
  clearOld();
  function clearOld() {
    if (process.env.VOICE_KEEP_OLD) return; // (a folder of models kept for other work)
    let freed = 0;
    for (const [sub, keep] of [['models', KEEP_MODELS], ['node_modules', KEEP_MODULES]]) {
      let names = []; try { names = fs.readdirSync(path.join(VOICE, sub)); } catch {}
      for (const n of names) if (!keep.has(n) && !n.startsWith('.')) try { fs.rmSync(path.join(VOICE, sub, n), { recursive: true, force: true }); freed++; } catch {}
    }
    if (freed) console.log(`[voice] removed ${freed} of the old speech models' files and folders`);
  }

  let worker = null, ready = false, error = null, model = null;
  let listening = 0, injectN = 0;
  const waiting = new Map(); // src -> resolve
  const clients = new Set();
  // The speech log: what it did, in order (on this device only), so a bad moment can be looked at afterwards. Off
  // unless someone turned it on. GET /voice/log?n=300 reads the end of it.
  const LOG = path.join(DIR, 'voice-log.jsonl'), LOG_ON = path.join(DIR, 'voice-log.on');
  let logOn = fs.existsSync(LOG_ON);
  if (!logOn) for (const f of [LOG, LOG + '.1', path.join(DIR, 'voice-log.off')]) try { fs.rmSync(f, { force: true }); } catch {}
  const vlog = (kind, data = {}) => {
    if (!logOn) return;
    try {
      if (fs.existsSync(LOG) && fs.statSync(LOG).size > 4e6) fs.renameSync(LOG, LOG + '.1');
      fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), kind, ...data }) + '\n');
    } catch {}
  };
  const emit = (ev) => { vlog('to-display', ev); const s = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(s); };
  // How loud speech is at the microphone, kept so the listener doesn't start deaf to quiet speech after a restart.
  const MIC_LEVEL = path.join(DIR, 'voice-mic-level.json');
  const micLevel = () => { try { const j = JSON.parse(fs.readFileSync(MIC_LEVEL, 'utf8')); return typeof j === 'number' ? j : j?.usual ?? null; } catch { return null; } };
  // Waking to "Hey Opie" is a setting, off until a family switches it on: a tap is how it listens.
  const WAKE_ON = path.join(DIR, 'voice-wake.on');
  let wakeOn = process.env.VOICE_WAKE === '1' || (process.env.VOICE_WAKE !== '0' && fs.existsSync(WAKE_ON));
  // Each time the model fires: when and how sure (nothing heard or said is kept), so false wakes can be counted.
  const WAKES = path.join(DIR, 'voice-wakes.jsonl');
  const wakeLog = (o) => { try { if (fs.existsSync(WAKES) && fs.statSync(WAKES).size > 1e6) fs.renameSync(WAKES, WAKES + '.1'); fs.appendFileSync(WAKES, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n'); } catch {} };
  // Clips (a household's choice, off by default): the microphone's last seconds around each wake, kept only on this
  // tablet (voice-clips/, not in backups: backup-format.js INCLUDE), so its own false wakes can be learned from.
  // 2 s before the wake reached here to 1 s after, as streamed (16 kHz mono wav), with when and how sure in
  // clips.jsonl. At most 300, none older than 30 days.
  const CLIPS = path.join(DIR, 'voice-clips'), CLIPS_ON = path.join(DIR, 'voice-clips.on'), CLIP_FILE = /^[\w-]+\.wav$/;
  const CLIP_MAX = 300, CLIP_DAYS = 30, RING = 4 * RATE * 2;
  let clipsOn = fs.existsSync(CLIPS_ON), ring = Buffer.alloc(0);
  const ringAdd = (d) => { if (!clipsOn) return; ring = Buffer.concat([ring, d]); if (ring.length > RING) ring = ring.subarray(ring.length - RING); };
  const wav = (pcm) => { const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]); };
  const clipLines = () => { try { return fs.readFileSync(path.join(CLIPS, 'clips.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  function clipsPrune() {
    const keep = clipLines().filter((c) => Date.now() - Date.parse(c.t) < CLIP_DAYS * 864e5 && fs.existsSync(path.join(CLIPS, c.file))).slice(-CLIP_MAX), names = new Set(keep.map((c) => c.file));
    try { for (const f of fs.readdirSync(CLIPS)) if (CLIP_FILE.test(f) && !names.has(f)) fs.rmSync(path.join(CLIPS, f), { force: true }); } catch {}
    try { fs.writeFileSync(path.join(CLIPS, 'clips.jsonl.tmp'), keep.map((c) => JSON.stringify(c) + '\n').join('')); fs.renameSync(path.join(CLIPS, 'clips.jsonl.tmp'), path.join(CLIPS, 'clips.jsonl')); } catch {}
  }
  function clipWake(p) {
    if (!clipsOn) return;
    const t = new Date();
    setTimeout(() => { // (1 s after: what was said right after the name)
      const pcm = ring.subarray(Math.max(0, ring.length - 3 * RATE * 2));
      if (!clipsOn || pcm.length < RATE) return;
      const file = t.toISOString().replace(/[:.]/g, '-') + '.wav';
      try { fs.mkdirSync(CLIPS, { recursive: true }); fs.writeFileSync(path.join(CLIPS, file), wav(Buffer.from(pcm))); fs.appendFileSync(path.join(CLIPS, 'clips.jsonl'), JSON.stringify({ t: t.toISOString(), p, file, level: micLevel() }) + '\n'); clipsPrune(); } catch {}
    }, 1000);
  }
  const wakeLines = () => { const r = []; for (const f of [WAKES + '.1', WAKES]) try { for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l) try { r.push(JSON.parse(l)); } catch {} } catch {} return r; };

  // A test recording, for whoever is working on the listening, of their own test session: off unless
  // switched on (POST /voice/record {on: true, minutes}), it switches itself off, and it is never on after
  // a restart. It keeps what the microphone heard (<start>.pcm, as streamed) and, by sample position, when it
  // woke (<start>.jsonl) in voice-rec/ on this device, so scripts/voice-replay.mjs can run the same minutes
  // through a changed listener. Recordings older than two weeks are deleted; POST /voice/record/clear deletes them all.
  const REC = path.join(DIR, 'voice-rec'), REC_MAX = 400e6, REC_FILE = /^[\w-]+\.(pcm|jsonl|truth\.txt)$/;
  let rec = null; // {name, pcm, log, samples, until, timer}
  const recFiles = () => { try { return fs.readdirSync(REC).filter((f) => REC_FILE.test(f)).map((f) => { const st = fs.statSync(path.join(REC, f)); return { name: f, bytes: st.size, at: st.mtimeMs }; }); } catch { return []; } };
  const recLine = (o) => { if (rec) try { fs.writeSync(rec.log, JSON.stringify({ at: rec.samples, ...o }) + '\n'); } catch {} };
  function recStop(why) {
    if (!rec) return;
    recLine({ end: why }); clearTimeout(rec.timer);
    for (const fd of [rec.pcm, rec.log]) try { fs.closeSync(fd); } catch {}
    console.log(`[voice] test recording off (${why}): ${rec.name}, ${(rec.samples / RATE).toFixed(0)} s`);
    vlog('test-recording', { on: false, why }); rec = null; emit({ type: 'recording', on: false });
  }
  function recStart(minutes) {
    recStop('restarted');
    for (const f of recFiles()) if (Date.now() - f.at > 14 * 864e5) fs.rmSync(path.join(REC, f.name), { force: true });
    if (recFiles().reduce((n, f) => n + f.bytes, 0) > REC_MAX) return 'the test recordings are full: clear them first';
    const ms = Math.min(60, Math.max(1, Number(minutes) || 15)) * 60e3, name = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[:.]/g, '-');
    try {
      fs.mkdirSync(REC, { recursive: true });
      rec = { name, pcm: fs.openSync(path.join(REC, name + '.pcm'), 'w'), log: fs.openSync(path.join(REC, name + '.jsonl'), 'w'), samples: 0, until: Date.now() + ms, timer: setTimeout(() => recStop('time'), ms) };
    } catch (e) { rec = null; return e.message; }
    recLine({ start: new Date().toISOString(), rate: RATE, model, wake: WAKE_PHRASES, level: micLevel() });
    console.log(`[voice] test recording on for ${ms / 60e3} min: ${name}`);
    vlog('test-recording', { on: true, minutes: ms / 60e3 }); emit({ type: 'recording', on: true, until: rec.until });
    return null;
  }

  const installed = () => WAKE_FILES.every((f) => fs.existsSync(path.join(VOICE, 'models', WAKE_DIR, f))) && fs.existsSync(path.join(VOICE, 'node_modules', 'onnxruntime-node'));
  let lookAgain = null;
  function start() {
    if (worker) return;
    if (!installed()) {
      // Not here yet: the display downloads the wake model itself (VoiceModels.kt) and says /voice/reload when it is;
      // looked for again every half minute too.
      error = `listening isn't installed (${VOICE})`; clearTimeout(lookAgain); lookAgain = setTimeout(start, 30000); return;
    }
    error = null;
    worker = fork(fileURLToPath(new URL('./voice-worker.js', import.meta.url)), [], {
      serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, VOICE_WORKER_DIR: VOICE },
    });
    worker.on('message', onMessage);
    worker.on('error', (e) => { error = e.message; console.error('[voice]', e.message); });
    const began = Date.now();
    worker.on('exit', (code, signal) => {
      // It stopped (a crash, or the system ended it): start again at once, or in ten seconds if it had only just
      // started (not a loop of loading the model).
      worker = null; ready = false; setTimeout(start, Date.now() - began > 30000 ? 500 : 10000);
      console.error(`[voice] the listener stopped (${signal || 'code ' + code}); starting it again`); vlog('listener-stopped', { code, signal });
      for (const [, r] of waiting) r({ error: error || 'listening stopped' }); waiting.clear();
    });
  }

  function onMessage(m) {
    if (rec && m.src === 'mic' && m.type === 'wake') recLine({ out: m });
    if (m.type === 'ready') {
      model = m.model; error = m.error || null; ready = !!m.model;
      worker?.send({ type: 'wake-on', on: wakeOn }); const l = micLevel(); if (l) worker?.send({ type: 'mic-level', level: l });
      console.log(ready ? `[voice] ready (${model})` : `[voice] not ready: ${error}`); return;
    }
    if (m.type === 'model-wake') { const { type, src, ...o } = m; if (src === 'mic') wakeLog(o); return; }
    if (m.type === 'wake') { if (m.src !== 'mic') return; vlog('wake-word', { p: m.p }); clipWake(m.p); handle.onWake?.(); emit({ type: 'wake', at: Date.now(), p: m.p }); return; }
    if (m.type === 'note') { vlog('note', { text: m.text }); console.log('[voice] ' + m.text); return; }
    if (m.type === 'mic-level') { try { fs.writeFileSync(MIC_LEVEL + '.tmp', JSON.stringify({ usual: m.level })); fs.renameSync(MIC_LEVEL + '.tmp', MIC_LEVEL); } catch {} return; }
    if (m.type === 'flushed') { const r = waiting.get(m.src); if (r) { waiting.delete(m.src); r({ woke: m.woke > 0, wakes: m.woke, peak: m.peak }); } }
  }

  // 16-bit PCM from a wav (any header layout) or raw; mono 16 kHz expected.
  function toFloat(buf) {
    let off = 0, len = buf.length;
    if (buf.toString('ascii', 0, 4) === 'RIFF') {
      for (let p = 12; p + 8 <= buf.length;) {
        const id = buf.toString('ascii', p, p + 4), size = buf.readUInt32LE(p + 4);
        if (id === 'fmt ') {
          const ch = buf.readUInt16LE(p + 10), rate = buf.readUInt32LE(p + 12), bits = buf.readUInt16LE(p + 22);
          if (ch !== 1 || rate !== RATE || bits !== 16) throw new Error(`need 16-bit mono ${RATE} Hz, got ${bits}-bit ${ch}ch ${rate} Hz`);
        }
        if (id === 'data') { off = p + 8; len = Math.min(size, buf.length - off); break; }
        p += 8 + size + (size & 1);
      }
    }
    const n = len >> 1, f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = buf.readInt16LE(off + i * 2) / 32768;
    return f;
  }
  const raw = (req) => new Promise((resolve, reject) => { const parts = []; req.on('data', (d) => parts.push(d)); req.on('end', () => resolve(Buffer.concat(parts))); req.on('error', reject); });

  start();

  handle.setNames = () => {}; // (the family's names helped the speech model: there's none now)
  handle.wakeOn = () => wakeOn;
  handle.log = vlog; // the speech log, for what Opie does in other apps (device-tools.js)
  /** Words the display says, as /voice/say (later.js: a follow-up's time came). */
  handle.say = (text) => { const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600); if (t) emit({ type: 'say', text: t }); return !!t; };
  return handle;
  async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith('/voice/')) return false;
    if (req.method === 'GET' && p === '/voice/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n'); clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return true;
    }
    if (req.method === 'GET' && p === '/voice/log') {
      const n = Math.min(3000, Number(url.searchParams.get('n')) || 300);
      let lines = []; try { lines = fs.readFileSync(LOG, 'utf8').trim().split('\n'); } catch {}
      res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.end(lines.slice(-n).join('\n') + '\n'); return true;
    }
    if (req.method === 'GET' && p === '/voice/status') {
      json(res, 200, { ready, error, download: downloading(), model, wake: WAKE_PHRASES, wakeOn, log: logOn, recording: !!rec, echo: false, listening: listening > 0 });
      return true;
    }
    if (req.method === 'GET' && p === '/voice/wakes') {
      const all = wakeLines(), n = Math.min(5000, Number(url.searchParams.get('n')) || 500), ago = (ms) => all.filter((w) => Date.now() - Date.parse(w.t) < ms).length;
      json(res, 200, { total: all.length, lastHour: ago(36e5), lastDay: ago(864e5), wakes: all.slice(-n) }); return true;
    }
    if (req.method === 'GET' && p === '/voice/clips') { json(res, 200, { on: clipsOn, clips: clipLines() }); return true; }
    if (req.method === 'GET' && p.startsWith('/voice/clips/')) {
      const name = p.slice('/voice/clips/'.length), f = path.join(CLIPS, name);
      if (!CLIP_FILE.test(name) || !fs.existsSync(f)) { json(res, 404, { error: 'no such clip' }); return true; }
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': fs.statSync(f).size }); fs.createReadStream(f).pipe(res); return true;
    }
    if (req.method === 'GET' && p === '/voice/record') {
      json(res, 200, { on: !!rec, until: rec?.until || 0, now: rec?.name || null, files: recFiles().map((f) => ({ name: f.name, bytes: f.bytes, ...(f.name.endsWith('.pcm') ? { seconds: Math.round(f.bytes / 2 / RATE) } : {}) })) });
      return true;
    }
    if (req.method === 'GET' && p.startsWith('/voice/record/')) {
      const name = p.slice('/voice/record/'.length), f = path.join(REC, name);
      if (!REC_FILE.test(name) || !fs.existsSync(f)) { json(res, 404, { error: 'no such recording' }); return true; }
      res.writeHead(200, { 'content-type': name.endsWith('.pcm') ? 'application/octet-stream' : 'text/plain; charset=utf-8', 'content-length': fs.statSync(f).size });
      fs.createReadStream(f).pipe(res); return true;
    }
    if (req.method !== 'POST') return false;

    if (p === '/voice/stream') { // the microphone, until the shell hangs up
      listening++; let carry = null;
      console.log('[voice] microphone connected');
      req.on('data', (d) => {
        if (carry) { d = Buffer.concat([carry, d]); carry = null; }
        if (d.length & 1) { carry = d.subarray(d.length - 1); d = d.subarray(0, d.length - 1); }
        if (!worker || !ready || !d.length) return;
        worker.send({ type: 'audio', src: 'mic', samples: toFloat(d) });
        ringAdd(d);
        if (rec) { try { fs.writeSync(rec.pcm, d); rec.samples += d.length >> 1; } catch (e) { recStop(e.message); } if (rec && rec.samples * 2 > REC_MAX) recStop('full'); }
      });
      await new Promise((r) => { req.on('end', r); req.on('close', r); });
      listening--; console.log('[voice] microphone disconnected');
      json(res, 200, { ok: true });
      return true;
    }
    if (p === '/voice/utterance') { // a test: would this recording wake it?
      if (!ready) { json(res, 503, { error: error || 'listening is starting' }); return true; }
      let f; try { f = toFloat(await raw(req)); } catch (e) { json(res, 400, { error: e.message }); return true; }
      const src = 'inject-' + ++injectN;
      const padded = new Float32Array(f.length + RATE); padded.set(f, RATE / 2); // a little silence around it
      const r = await new Promise((resolve) => { waiting.set(src, resolve); worker.send({ type: 'audio', src, samples: padded, flush: true }); });
      json(res, r.error ? 503 : 200, r); return true;
    }
    if (p === '/voice/reload') { // the display put new models in place: load them (the listener starts again)
      clearOld();
      if (worker) worker.kill(); else start();
      json(res, 200, { ok: true }); return true;
    }
    // What the old listening was told (a tap, a follow-up, what it's saying, echo cancelling): nothing to do now.
    if (/^\/voice\/(arm|stop|done|mute|quiet|talking|talk-voice|echo|ref(\/\w+)?)$/.test(p)) { json(res, 200, { ok: true }); return true; }
    const b = await body(req);
    if (p === '/voice/wake' && typeof b.on === 'boolean') { // {"on": true}: wake to "Hey Opie", or only to a tap
      wakeOn = b.on;
      try { if (wakeOn) fs.writeFileSync(WAKE_ON, 'on\n'); else fs.rmSync(WAKE_ON, { force: true }); } catch {}
      worker?.send({ type: 'wake-on', on: wakeOn }); vlog('wake-word-setting', { on: wakeOn });
      json(res, 200, { ok: true, on: wakeOn }); return true;
    }
    if (p === '/voice/clips/setting' && typeof b.on === 'boolean') {
      clipsOn = b.on; ring = Buffer.alloc(0);
      try { if (clipsOn) fs.writeFileSync(CLIPS_ON, 'on\n'); else { fs.rmSync(CLIPS_ON, { force: true }); fs.rmSync(CLIPS, { recursive: true, force: true }); } } catch {}
      vlog('wake-clips-setting', { on: clipsOn }); json(res, 200, { ok: true, on: clipsOn }); return true;
    }
    if (p === '/voice/clips/clear') { try { fs.rmSync(CLIPS, { recursive: true, force: true }); } catch {} json(res, 200, { ok: true }); return true; }
    if (p === '/voice/wakes/clear') { for (const f of [WAKES, WAKES + '.1']) try { fs.rmSync(f, { force: true }); } catch {} json(res, 200, { ok: true }); return true; }
    if (p === '/voice/say') { // an app's words (kit say): the display says them
      const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
      if (!text) { json(res, 400, { error: 'nothing to say' }); return true; }
      emit({ type: 'say', text, ...(b.who ? { who: String(b.who).slice(0, 60) } : {}) }); json(res, 200, { ok: true }); return true;
    }
    if (p === '/voice/log/setting') {
      logOn = b.on !== false;
      try { if (logOn) fs.writeFileSync(LOG_ON, 'on\n'); else { fs.rmSync(LOG_ON, { force: true }); fs.rmSync(LOG, { force: true }); fs.rmSync(LOG + '.1', { force: true }); } } catch {}
      json(res, 200, { ok: true, log: logOn }); return true;
    }
    if (p === '/voice/record') {
      const err = b.on ? recStart(b.minutes) : (recStop('asked'), null);
      json(res, err ? 409 : 200, err ? { error: err } : { ok: true, on: !!rec, until: rec?.until || 0, name: rec?.name || null }); return true;
    }
    if (p === '/voice/record/clear') { recStop('cleared'); try { fs.rmSync(REC, { recursive: true, force: true }); } catch {} json(res, 200, { ok: true }); return true; }
    if (p === '/voice/log') { vlog('display', { event: String(b.event || '').slice(0, 60), text: b.text ? String(b.text).slice(0, 300) : undefined, who: b.who || undefined }); json(res, 200, { ok: true }); return true; }
    return false;
  }
}

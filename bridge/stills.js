// A still for each video in Photos (docs/photos.md, "Videos"): what the grid, the sleep screen, Today's photo and the
// phones show for it. photos/.stills/<video>.jpg. Made by the shell on the tablet (DeviceServer /media/still: Android's
// MediaMetadataRetriever, which decodes what the tablet itself can play), else by ffmpeg when there is one (a laptop
// running the bridge). An iCloud video brings its own (Apple's poster frame, photo-albums.js), so it needs neither.
// One at a time: a decoder is heavy on the tablet.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { shellCall } from './calendar-links.js';

export const STILLS = '.stills';

export function stillMaker({ photosDir, shell = (p, b) => shellCall(p, b, { timeoutMs: 60e3 }), onMade = () => {}, log = () => {} }) {
  const dir = path.join(photosDir, STILLS);
  const fileOf = (name) => path.join(dir, name + '.jpg');
  const has = (name) => fs.existsSync(fileOf(name));
  const queue = [], tried = new Set();
  let running = false;

  /** A still for these bytes (an iCloud poster frame): kept as the video's own. */
  function put(name, jpeg) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(fileOf(name), jpeg); }

  /** Ask for a still for a video that has none (tried once per run; the next start tries again). */
  function want(name) {
    if (has(name) || tried.has(name)) return;
    tried.add(name); queue.push(name);
    if (!running) drain();
  }
  async function drain() {
    running = true;
    try {
      while (queue.length) {
        const name = queue.shift(), src = path.join(photosDir, name);
        if (!fs.existsSync(src) || has(name)) continue;
        let jpeg = null;
        const r = await shell('/media/still', { path: src }).catch(() => null);
        if (r?.jpeg) jpeg = Buffer.from(String(r.jpeg), 'base64');
        if (!jpeg?.length) jpeg = await ffmpeg(src);
        if (jpeg?.length) { put(name, jpeg); onMade(name); } else log(`no still for a video (${r?.error || 'nothing to make one'})`);
      }
    } finally { running = false; }
  }
  /** Every video in the folder without one (at start, and when files appear in it). */
  function sweep(names) { for (const n of names) want(n); }
  /** A video taken off for good: its still goes too. */
  function drop(name) { try { fs.unlinkSync(fileOf(name)); } catch {} }

  return { has, fileOf, put, want, sweep, drop };
}

/** A frame half a second in, at most 1600 px on its long side, as a JPEG; null without ffmpeg. */
function ffmpeg(src) {
  return new Promise((ok) => {
    let p; try { p = spawn('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', src, '-frames:v', '1', '-vf', 'scale=w=1600:h=1600:force_original_aspect_ratio=decrease', '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ok(null); }
    const parts = [];
    p.stdout.on('data', (d) => parts.push(d));
    p.on('error', () => ok(null));
    p.on('close', (c) => ok(c === 0 && parts.length ? Buffer.concat(parts) : null));
    setTimeout(() => p.kill('SIGKILL'), 30e3).unref?.();
  });
}

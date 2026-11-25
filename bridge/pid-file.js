// The bridge's own process id, in BRIDGE_PID_FILE when its start script asks for one (device/runtime-start.sh, which
// stops a bridge that runs but never starts listening). Imported first by server.js, so it's written as the process
// starts, before the rest loads: the file's time is when this bridge began. Removed when it exits, if it's still ours.
import fs from 'node:fs';

const file = process.env.BRIDGE_PID_FILE;
if (file) {
  try {
    fs.writeFileSync(file + '.tmp', `${process.pid}\n`);
    fs.renameSync(file + '.tmp', file);
    process.on('exit', () => {
      try { if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file); } catch {}
    });
  } catch (e) {
    console.error('[bridge] pid file:', e?.message || e);
  }
}

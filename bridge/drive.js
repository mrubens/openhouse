// A drive as a backup destination (backup.js): today a USB drive plugged into the tablet, later a shared folder on
// a home computer or NAS (SMB). The shell owns the drive (Android lets an app at a USB drive only through the folder
// someone picked in the system's picker, BackupDrive.kt), so the bridge asks the shell, on 127.0.0.1 with a
// token the shell leaves in display/.backup/drive.json. Files are copied by path: both see the display folder.
//
// On the drive: a folder "Display backups" with display-backup-<time>-<kind>-<keyId>.backup files, the same
// encrypted format as the cloud's. The newest few of each kind are kept.
import fs from 'node:fs';
import path from 'node:path';
import { request } from './backup-format.js';

const NAME = /^display-backup-(\d{8}T\d{6}Z)-(nightly|manual)-([0-9a-f]{16})\.backup$/;
export const driveName = (meta) => `display-backup-${meta.createdAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${meta.kind}-${meta.keyId}.backup`;
export const parseName = (n) => {
  const m = NAME.exec(n);
  if (!m) return null;
  const t = m[1];
  return { createdAt: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}Z`, kind: m[2], keyId: m[3] };
};

export function driveDestination({ DISPLAY, id = 'drive', label = 'A USB drive' }) {
  const conf = () => { try { return JSON.parse(fs.readFileSync(path.join(DISPLAY, '.backup', 'drive.json'), 'utf8')); } catch { return null; } };
  async function call(p, b = {}, timeout = 30e3) {
    const c = conf();
    if (!c) throw Object.assign(new Error("The tablet's drive helper isn't running."), { code: 'noshell' });
    const r = await request(`http://127.0.0.1:${c.port}${p}`, { method: 'POST', headers: { authorization: `Bearer ${c.token}` }, body: JSON.stringify(b), timeout });
    if (r.status !== 200) throw Object.assign(new Error(r.json?.error || `the drive helper answered ${r.status}`), { code: 'drive' });
    return r.json;
  }
  const d = {
    id, label,
    /** {ok, name}: a drive was chosen and is plugged in now. */
    async ready() {
      const s = await call('/status', {}, 5000).catch((e) => ({ error: e.message }));
      if (s.error) return { ok: false, why: s.error };
      if (!s.chosen) return { ok: false, why: 'No drive is chosen yet.' };
      if (!s.present) return { ok: false, why: `Plug in the drive (${s.name || 'the one chosen'}).` };
      return { ok: true, name: s.name };
    },
    async put(file, meta) { await call('/put', { path: file, name: driveName(meta) }, 30 * 60e3); },
    async list() {
      const r = await call('/list');
      return (r.files || []).map((x) => { const p = parseName(x.name); return p && { id: x.name, size: x.size, ...p }; }).filter(Boolean);
    },
    async get(item, toFile) { await call('/get', { name: item.id, path: toFile }, 30 * 60e3); },
    async prune(keepNightly, keepManual) {
      const all = (await d.list()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      for (const [kind, keep] of [['nightly', keepNightly], ['manual', keepManual]]) {
        for (const old of all.filter((x) => x.kind === kind).slice(keep)) await call('/remove', { name: old.id });
      }
    },
  };
  return d;
}

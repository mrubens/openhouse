// A folder as a backup destination (backup.js): a hub's (docs/hub.md) backups go to a folder on the machine it runs on,
// a USB drive mounted there, a NAS share, or a Docker volume (OPENHOUSE_BACKUP_DIR). The same encrypted files, named the
// same way, as on a USB drive plugged into the tablet (drive.js), so a backup from either restores on the other.
import fs from 'node:fs';
import path from 'node:path';
import { driveName, parseName } from './drive.js';

export function folderDestination({ dir, id = 'folder', label = 'A folder on the hub' }) {
  const root = () => path.join(dir, 'Display backups');
  const d = {
    id, label,
    async ready() {
      try {
        fs.mkdirSync(root(), { recursive: true });
        fs.accessSync(root(), fs.constants.W_OK);
        return { ok: true, name: dir };
      } catch { return { ok: false, why: `The hub can't write to ${dir}.` }; }
    },
    async put(file, meta) {
      const to = path.join(root(), driveName(meta)), tmp = to + '.part';
      fs.copyFileSync(file, tmp); fs.renameSync(tmp, to);
    },
    async list() {
      let names = []; try { names = fs.readdirSync(root()); } catch { return []; }
      return names.map((n) => { const p = parseName(n); return p && { id: n, size: fs.statSync(path.join(root(), n)).size, ...p }; }).filter(Boolean);
    },
    async get(item, toFile) {
      if (!parseName(item.id)) throw new Error('no such backup');
      fs.copyFileSync(path.join(root(), item.id), toFile);
    },
    async prune(keepNightly, keepManual) {
      const all = (await d.list()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      for (const [kind, keep] of [['nightly', keepNightly], ['manual', keepManual]]) {
        for (const old of all.filter((x) => x.kind === kind).slice(keep)) fs.rmSync(path.join(root(), old.id), { force: true });
      }
    },
  };
  return d;
}

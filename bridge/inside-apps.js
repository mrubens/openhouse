// Where a computer's write_file may land (workshop.js): the real path inside the app folder's apps/, or null.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Where a save may land: the real path for `rel` ("apps/<id>/main.js"), or null when that isn't a place inside
 * apps/. Nothing is created or changed here.
 */
export function insideApps(appDir, rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 400 || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const want = path.resolve(appDir, rel); // ".." resolved
  if (!want.startsWith(path.resolve(appDir, 'apps') + path.sep)) return null;
  if (want.split(path.sep).includes('.git')) return null; // never git's own files
  const there = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
  try {
    // Links resolved: the deepest folder that exists must really be inside apps/, and the file itself is no link.
    const apps = fs.realpathSync(path.join(appDir, 'apps'));
    let have = path.dirname(want);
    while (!there(have)) have = path.dirname(have);
    const real = fs.realpathSync(have);
    if (real !== apps && !real.startsWith(apps + path.sep)) return null;
    if (there(want) && fs.lstatSync(want).isSymbolicLink()) return null;
    return path.join(real, path.relative(have, want));
  } catch { return null; }
}


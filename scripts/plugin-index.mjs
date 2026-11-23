#!/usr/bin/env node
// OpenHouse's list of plugins (the gallery in Settings, Opie's find_plugins): index.json, built from plugins/*/package.json
// and the tarballs scripts/plugin-tarballs.sh made. Each tarball is unpacked and checked the way the tablet checks it
// (bridge/plugins.js checkPlugin), and what it may do is written in the card's words. The tablet installs only from the
// tarball address here, and only if its sha256 matches. Uploading (next to the tarballs) is a separate, asked-for step.
//
//   node scripts/plugin-index.mjs [--dir dist/plugins] [--base https://…/releases/plugins/] [--out <dir>/index.json] [name...]
//
// A plugin is listed when its tarball <name>-<version>-<commit>.tgz is in --dir (the newest one, if several). A
// picture: plugins/<name>/preview.png (or .jpg/.webp), copied next to the tarballs as <name>-<version>-<commit>.png.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPlugin, rightsMerged } from '../bridge/plugins.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), names = [];
let dir = path.join(ROOT, 'dist/plugins'), base = 'https://d15yaylh7unz6h.cloudfront.net/releases/plugins/', out = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir') dir = path.resolve(args[++i]);
  else if (args[i] === '--base') base = args[++i].replace(/\/?$/, '/');
  else if (args[i] === '--out') out = path.resolve(args[++i]);
  else names.push(args[i]);
}
out ||= path.join(dir, 'index.json');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tarballs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.tgz$/.test(f)) : [];
const wanted = names.length ? names : fs.readdirSync(path.join(ROOT, 'plugins')).filter((n) => fs.existsSync(path.join(ROOT, 'plugins', n, 'package.json'))).sort();

const plugins = [], skipped = [];
for (const n of wanted) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', n, 'package.json'), 'utf8'));
  const mine = tarballs.filter((f) => f.startsWith(`${pkg.name}-${pkg.version}-`)).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  if (!mine.length) { skipped.push(`${n} (no ${pkg.name}-${pkg.version}-*.tgz in ${path.relative(ROOT, dir) || dir})`); continue; }
  const file = mine[0].f, buf = fs.readFileSync(path.join(dir, file));
  const commit = file.slice(`${pkg.name}-${pkg.version}-`.length, -4);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-index-'));
  let p;
  try {
    execFileSync('tar', ['-xzf', path.join(dir, file), '-C', tmp, '--no-same-owner']);
    const top = fs.readdirSync(tmp);
    p = checkPlugin(top.length === 1 ? path.join(tmp, top[0]) : tmp);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  if (p.name !== pkg.name) throw new Error(`${file} holds ${p.name}, not ${pkg.name}`);
  const entry = { name: p.name, title: p.title, description: p.description, version: p.version, commit, tarball: base + file, sha256: sha(buf),
    rights: [...rightsMerged(p.apps), ...(p.look ? ['Changes the look.'] : []), ...(p.tabs.length ? [`Adds ${p.tabs.length === 1 ? 'a tab' : 'tabs'}.`] : [])] };
  const pic = ['png', 'jpg', 'webp'].map((x) => path.join(ROOT, 'plugins', n, `preview.${x}`)).find((f) => fs.existsSync(f));
  if (pic) {
    const to = `${pkg.name}-${pkg.version}-${commit}${path.extname(pic)}`;
    fs.copyFileSync(pic, path.join(dir, to));
    entry.image = base + to;
  }
  plugins.push(entry);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ made: new Date().toISOString(), plugins }, null, 2) + '\n');
console.log(`${out}: ${plugins.length} plugins (${plugins.map((p) => p.name).join(', ')})`);
if (skipped.length) console.log(`not listed: ${skipped.join('; ')}`);

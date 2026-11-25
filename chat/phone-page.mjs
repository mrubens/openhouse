// The phone page (src/phone.jsx) built as the iPhone app carries it: one HTML file with its script and styles inlined,
// plus an app's frame (src/phone-frame.js) and the icon. The app serves them itself from its own address
// (ios/App/PhonePage.swift), so the code that holds a phone's key is the code Apple signed, not a copy from a server.
// The cloud's /h/ copy is the same page, built the same way (openhouse-cloud scripts/phone-app.ts).
//   node chat/phone-page.mjs <folder>     (needs this folder's packages: cd chat && npm ci)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const CHAT = path.dirname(fileURLToPath(import.meta.url));

export async function phonePage() {
  let esbuild;
  try { esbuild = createRequire(path.join(CHAT, 'package.json'))('esbuild'); }
  catch { throw new Error(`no esbuild: run npm ci in ${CHAT}`); }
  const opts = { bundle: true, minify: true, write: false, legalComments: 'none', absWorkingDir: CHAT, target: ['chrome110', 'safari15'] };
  const out = await esbuild.build({ ...opts, entryPoints: [path.join(CHAT, 'src/phone.jsx')], format: 'esm', jsx: 'automatic' });
  const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = ['phone.css', 'phone-today.css', '../bridge/kit/weather-look.css'].map((f) => fs.readFileSync(path.join(CHAT, f), 'utf8')).join('\n');
  const page = fs.readFileSync(path.join(CHAT, 'phone.html'), 'utf8')
    .replace('<link rel="manifest" href="manifest.webmanifest">\n', '')
    .replace('<link rel="icon" href="icon.svg"', '<link rel="icon" href="/h/icon.svg"')
    .replace('<link rel="apple-touch-icon" href="apple-touch-icon.png">\n', '')
    .replace('<link rel="stylesheet" href="phone.css">', () => `<style>\n${css}</style>`)
    .replace('<script type="module" src="/app/phone.js"></script>', () => `<script type="module">${js}</script>`); // (a function: the code has $' and $&)
  if (!page.includes('<script type="module">') || !page.includes('<style>')) throw new Error('phone.html changed: update chat/phone-page.mjs');
  const frame = await esbuild.build({ ...opts, entryPoints: [path.join(CHAT, 'src/phone-frame.js')], format: 'iife' });
  return {
    'index.html': page,
    'frame.html': fs.readFileSync(path.join(CHAT, 'phone-frame.html'), 'utf8'),
    'frame.js': frame.outputFiles[0].text,
    'icon.svg': fs.readFileSync(path.join(CHAT, 'phone-icon.svg'), 'utf8'),
  };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node chat/phone-page.mjs <folder>'); process.exit(2); }
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(await phonePage())) fs.writeFileSync(path.join(dir, name), body);
  console.log('phone page:', dir, Math.round(fs.statSync(path.join(dir, 'index.html')).size / 1024), 'KB');
}

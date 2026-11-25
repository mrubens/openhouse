// An app checked without running it, for whoever changes apps (the workshop, workshop.js; the tablet's own builder,
// rails.js): each script parses, and the files its index.html loads are there.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** node --check on one script, off the event loop: { status, stderr } (status 0 when it parses). */
export const syntaxCheck = (input) => new Promise((resolve) => {
  let stderr = '', p;
  try { p = spawn(process.execPath, ['--input-type=module', '--check'], { stdio: ['pipe', 'ignore', 'pipe'], timeout: 10e3 }); }
  catch { resolve({ status: null, stderr }); return; } // a check that can't run (or times out) isn't an error
  p.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
  p.on('error', () => resolve({ status: null, stderr }));
  p.on('close', (code) => resolve({ status: code, stderr }));
  p.stdin.on('error', () => {}).end(input);
});

/** The problems found in apps/<app>/ (an empty list when there are none). */
export async function staticCheck(appsDir, app) {
  const dir = path.join(appsDir, app), out = [];
  if (!fs.existsSync(path.join(dir, 'index.html'))) return [`apps/${app}/index.html is missing.`];
  for (const f of fs.readdirSync(dir).filter((x) => /\.m?js$/.test(x))) {
    const r = await syntaxCheck(fs.readFileSync(path.join(dir, f)));
    if (r.status) out.push(`${f}: ${String(r.stderr).split('\n').filter((l) => !/^\s+at /.test(l) && /Error|^\s*\^|:\d+/.test(l)).slice(0, 4).join(' | ').replace(/\[stdin\]/g, f)}`);
  }
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  for (const [, ref] of html.matchAll(/(?:src|href)=["'](\.?\/?[\w.-]+\.(?:js|css|svg))["']/g)) {
    if (ref.startsWith('/')) continue; // the kit and the dev server's own
    if (!fs.existsSync(path.join(dir, ref.replace(/^\.\//, '')))) out.push(`index.html loads ${ref}, which isn't there.`);
  }
  return out;
}

// Plugins: what one family made (apps, a look), picked up by another (docs/plugins.md). A plugin is a pi package with
// an "openhouse" key: a folder with package.json, from a git repo or a tarball, at a pinned commit.
//
// v1 installs apps and a look only. Nothing in a plugin runs outside its app's page: a plugin with code for the
// assistant (pi extensions) is refused, and its skills aren't installed yet. Every install asks someone first (the
// tablet's "Is this OK?" card with the PIN; nothing the assistant sends can answer it), and lands as one change,
// so "undo" takes it back. An app from a plugin gets only the house's data its app.json "uses" names, and reaches only
// the hosts its "reaches" names (the dev server's CSP, device/vite.config.mjs): what the card said.
//
// Every app is a plugin now, ours and the household's too (pluginsRoutes below, docs/plugins.md §11): one manifest per
// plugin in webapp/plugins/<name>.json (in git with the apps, so undo keeps it right; outside apps/, so neither the
// assistant nor a computer can write it). v1's one webapp/plugins.json is moved there once (migrate).
//
// Display only (Settings): GET /plugins, POST /plugins/inspect {source}, /plugins/install {source, tabs} (after the card),
// /plugins/remove {name}. The assistant and a computer: the tools below (install waits on the card).
import { asData } from './as-data.js';
import fs from 'node:fs';
import { writeJson as storeJson } from './store.js';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import zlib from 'node:zlib';
import { execFile, execFileSync } from 'node:child_process';
import { cleanLook, DEFAULT_TABS, isTab } from './home-screen.js';
import { USES } from './apps.js';
import { validateChecks } from './heartbeat-checks.js';
import { publicGet } from './app-web.js';
import { GIT_SAFE } from './edits.js';

const ID = /^[a-z0-9][a-z0-9-]{0,60}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(:\d{1,5})?$/;
/** A host an app may reach: "api.example.com", or "*.example.com" for any name under example.com (app-web.js reachMatches). */
export const reachOk = (h) => HOST.test(String(h).replace(/^\*\./, ''));
/** The most websites an app made on the tablet may be granted (madeHere). */
export const MAX_REACH = 4;
const FILE = /^[\w][\w.-]{0,80}\.(html|js|mjs|css|json|svg|png|jpg|jpeg|webp|gif|mp3|ogg|wav|m4a|woff2|ttf|txt|md)$/i;
const TEXT = /\.(html|js|mjs|css|json|svg|txt|md)$/i;
const MAX_BYTES = 5e6, MAX_FILES = 200, MAX_FILE = 2e6;
const ACTION = /^[a-z][a-z0-9_]{0,30}$/;
const LOOK_KEYS = ['palette', 'colors', 'type', 'density', 'backdrop'];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * Where a plugin comes from, as the family gave it. git: "git:github.com/u/r@v1", "https://github.com/u/r", "…@<ref>";
 * a tarball: "https://…/x.tgz" or ".tar.gz". local (tests, a laptop; never from the tablet's tools): an absolute path.
 */
export function parseSource(s, { local = false } = {}) {
  const src = String(s || '').trim();
  if (!src || src.length > 500 || /\s/.test(src)) return null;
  if (local && path.isAbsolute(src)) return { kind: 'local', dir: src, label: src };
  const tar = src.match(/^https:\/\/[^@\s]+\.(tgz|tar\.gz)$/i);
  if (tar) return { kind: 'tar', url: src, label: src.replace(/^https:\/\//, '') };
  // A folder in a repo, as its web page shows it: github.com/u/r/tree/<ref>/plugins/x (GitLab: /-/tree/; Codeberg: /src/branch/).
  const sub = src.match(/^(?:git:|https:\/\/)?([a-z0-9.-]+\.[a-z]{2,})\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/(?:-\/)?(?:tree|src\/branch|src\/commit)\/([\w.-]{1,100})\/([\w.-]+(?:\/[\w.-]+){0,9})\/?$/i);
  if (sub) {
    if (!HOST.test(sub[1].toLowerCase()) || sub[3].startsWith('-') || sub[4].split('/').some((p) => p === '.' || p === '..')) return null;
    const where = `${sub[1].toLowerCase()}/${sub[2]}`;
    return { kind: 'git', url: `https://${where}.git`, ref: sub[3], sub: sub[4], label: `${where}/${sub[4]}`, key: src.replace(/^(git:|https:\/\/)/, '').replace(/\/$/, '') };
  }
  const m = src.match(/^(?:git:|https:\/\/)?([a-z0-9.-]+\.[a-z]{2,})\/([\w.-]+(?:\/[\w.-]+)+?)(?:\.git)?(?:@([\w./-]{1,100}))?\/?$/i);
  if (!m || !HOST.test(m[1].toLowerCase()) || m[3]?.startsWith('-')) return null; // a ref is never an option to git
  const where = `${m[1].toLowerCase()}/${m[2]}`;
  return { kind: 'git', url: `https://${where}.git`, ref: m[3] || null, label: where, key: `git:${where}` };
}

/** A git or tar run, off the event loop (a slow fetch mustn't stall the bridge: the shell restarts one that stops answering). */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 90e3, maxBuffer: 1e7,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' }, ...opts }, (e, stdout, stderr) => {
      if (e) { e.stdout = stdout; e.stderr = stderr; reject(e); } else resolve(String(stdout).trim());
    }).stdin?.end();
  });
}

/** The plugin's files in a folder of their own (to be thrown away). { dir, commit, done() } */
/**
 * A plugin's tarball opened into out, read here rather than by tar: only folders and plain files, each inside out
 * (never an absolute path or ..). Links of any kind are left out, never made, so nothing is written through one. Throws with words.
 */
export function untar(tgz, out) {
  let buf;
  try { buf = zlib.gunzipSync(tgz, { maxOutputLength: MAX_BYTES * 4 }); } catch { throw new Error("That plugin's tarball couldn't be opened (or is too big)."); }
  const field = (h, at, n) => { const b = h.subarray(at, at + n), z = b.indexOf(0); return (z < 0 ? b : b.subarray(0, z)).toString('utf8'); };
  const octal = (h, at, n) => parseInt(field(h, at, n).trim() || '0', 8);
  const bad = (name) => { throw new Error(`Its tarball has ${String(name).slice(0, 80)} in it, which a plugin can't have: only plain files and folders.`); };
  let at = 0, longName = null, paxPath = null, entries = 0;
  while (at + 512 <= buf.length) {
    const h = buf.subarray(at, at + 512);
    if (h.every((x) => x === 0)) break; // the end
    const size = octal(h, 124, 12), type = String.fromCharCode(h[156] || 48), body = buf.subarray(at + 512, at + 512 + size);
    if (!Number.isFinite(size) || size < 0 || at + 512 + size > buf.length) throw new Error("That plugin's tarball is cut short.");
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') continue; // a pax note for the whole archive (GitHub's commit): nothing to write
    if (type === 'x') { const m = body.toString('utf8').match(/(?:^|\n)\d+ path=([^\n]*)\n/); paxPath = m ? m[1] : null; continue; }
    if (type === 'L') { longName = field(body, 0, body.length); continue; }
    if (/(^|\/)\._[^/]*\/?$/.test(paxPath ?? longName ?? field(h, 0, 100))) { paxPath = longName = null; continue; } // a Mac's ._ notes about a file: not part of it
    const prefix = field(h, 257, 6).startsWith('ustar') ? field(h, 345, 155) : '';
    const name = paxPath ?? longName ?? (prefix ? prefix + '/' : '') + field(h, 0, 100);
    paxPath = longName = null;
    if (++entries > MAX_FILES * 5) throw new Error('That plugin has too many files.');
    if (type === '1' || type === '2') continue; // a link: left out, never made (so nothing can be written through one)
    if (type !== '0' && type !== '5' && type !== '7') bad(name);
    const rel = name.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (!rel) continue;
    if (path.isAbsolute(rel) || rel.includes('\0') || rel.split('/').some((p) => p === '..')) bad(name);
    const dest = inside(out, rel);
    if (!dest || dest === out) bad(name);
    if (type === '5') { fs.mkdirSync(dest, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body, { flag: 'wx', mode: 0o644 }); // (wx: never onto something already there)
  }
}

async function fetchSource(src, fetchImpl = fetch, web = {}) {
  if (src.kind === 'local') return { dir: src.dir, commit: null, done: () => {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-'));
  const done = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    if (src.kind === 'git') {
      const g = (...a) => run('git', ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'core.hooksPath=/dev/null', '-c', 'core.symlinks=false', ...a], { cwd: tmp });
      await g('init', '-q');
      if (src.sub) { // a folder in a bigger repo: only that folder's files are fetched
        await g('config', 'core.sparseCheckout', 'true');
        fs.mkdirSync(path.join(tmp, '.git', 'info'), { recursive: true });
        fs.writeFileSync(path.join(tmp, '.git', 'info', 'sparse-checkout'), `/${src.sub}/\n`);
        await g('remote', 'add', 'origin', src.url);
      }
      try { await g('fetch', '-q', '--depth', '1', ...(src.sub ? ['--filter=blob:none', 'origin'] : [src.url]), src.ref || 'HEAD'); }
      catch (e) { throw new Error(`Couldn't get it from ${src.label}${src.ref ? ' at ' + src.ref : ''}: ${String(e.stderr || e.message).split('\n').filter(Boolean).at(-1)?.slice(0, 200)}`); }
      await g('checkout', '-q', 'FETCH_HEAD');
      const commit = await g('rev-parse', 'HEAD');
      fs.rmSync(path.join(tmp, '.git'), { recursive: true, force: true });
      if (src.sub) {
        const d = inside(tmp, src.sub);
        if (!d || !fs.existsSync(d) || !fs.lstatSync(d).isDirectory()) throw new Error(`There's no folder ${src.sub} in ${src.label.slice(0, -src.sub.length - 1)} at ${src.ref}.`);
        return { dir: d, commit, done };
      }
      return { dir: tmp, commit, done };
    }
    // Every hop https, public and connected to at the address checked (app-web.js publicGet), as for any link.
    const r = await publicGet(src.url, { ...web, ipLiterals: false, timeoutMs: 60e3, max: MAX_BYTES * 2, headers: { 'user-agent': 'OpenHouse', accept: '*/*' } });
    if (r.error) throw new Error(`Couldn't get it from ${src.label}${r.error === 'home' ? ': it points into the home network' : r.error === 'protocol' ? ': only https' : ''}.`);
    if (r.status < 200 || r.status >= 300) throw new Error(`Couldn't get it from ${src.label}: ${r.status}`);
    const buf = r.buf;
    if (buf.length > MAX_BYTES * 2) throw new Error('That plugin is too big.');
    // From Opie's list (the gallery): only the exact tarball that was reviewed.
    if (src.sha256 && sha(buf) !== src.sha256) throw new Error(`What ${src.label} sent isn't the version that was reviewed for Opie's list, so it wasn't added.`);
    const out = path.join(tmp, 'p'); fs.mkdirSync(out);
    untar(buf, out);
    // npm pack puts everything in package/; GitHub's archives in <repo>-<ref>/
    const top = fs.readdirSync(out);
    const dir = top.length === 1 && fs.statSync(path.join(out, top[0])).isDirectory() ? path.join(out, top[0]) : out;
    return { dir, commit: sha(buf).slice(0, 40), sha256: sha(buf), done };
  } catch (e) { done(); throw e; }
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const list = (v) => (v == null ? null : Array.isArray(v) ? v : [v]);
const inside = (root, rel) => {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  const f = path.resolve(root, rel);
  return f === root || f.startsWith(root + path.sep) ? f : null;
};

/** What's in a plugin's folder, checked: { name, title, version, description, readme, apps: [...], look, tabs, notes }. Throws with words for the family. */
export function checkPlugin(dir) {
  const root = fs.realpathSync(dir);
  let pkg;
  try { pkg = readJson(path.join(root, 'package.json')); } catch { throw new Error("That isn't a plugin: it has no package.json."); }
  const oh = pkg.openhouse && typeof pkg.openhouse === 'object' ? pkg.openhouse : {};
  const name = String(pkg.name || '').replace(/^@[^/]+\//, '').toLowerCase();
  if (!ID.test(name)) throw new Error(`Its name ("${String(pkg.name).slice(0, 60)}") isn't one Opie can use: lowercase letters, digits and dashes.`);
  const notes = [];
  // Code for the assistant runs with its key: never from a plugin (docs/plugins.md §5).
  const ext = list(pkg.pi?.extensions);
  if ((ext && ext.length) || (!ext && fs.existsSync(path.join(root, 'extensions')))) throw new Error('It has code for the assistant (pi extensions), which Opie never installs from a plugin.');
  if (list(pkg.pi?.skills)?.length || fs.existsSync(path.join(root, 'skills'))) notes.push("Its assistant skills aren't installed yet: only its apps and look.");
  for (const k of ['devices', 'data']) if (oh[k]) notes.push(`Its ${k === 'devices' ? 'device recipes' : 'starting data'} aren't installed yet.`);

  let appDirs = list(oh.apps);
  if (!appDirs) { try { appDirs = fs.readdirSync(path.join(root, 'apps')).map((d) => `apps/${d}`).filter((d) => fs.existsSync(path.join(root, d, 'index.html'))); } catch { appDirs = []; } }
  let total = 0, count = 0;
  const apps = appDirs.slice(0, 20).map((rel) => {
    const d = inside(root, rel);
    if (!d || !fs.existsSync(d) || !fs.lstatSync(d).isDirectory()) throw new Error(`It names an app at ${rel} that isn't there.`);
    const id = path.basename(d).toLowerCase();
    if (!ID.test(id) || id === 'home') throw new Error(`An app's folder name ("${path.basename(d)}") isn't one Opie can use.`);
    const files = {};
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f), st = fs.lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`${rel}/${f} is a link: plugins are plain files.`);
      if (st.isDirectory()) { if (f === '.git' || f === 'node_modules') continue; throw new Error(`${rel}/${f} is a folder: an app here is one flat folder of files.`); }
      if (!FILE.test(f)) { notes.push(`Left out ${rel}/${f} (not a kind of file an app uses).`); continue; }
      if (st.size > MAX_FILE) throw new Error(`${rel}/${f} is too big.`);
      total += st.size; count++;
      files[f] = fs.readFileSync(p);
    }
    if (!files['index.html']) throw new Error(`The app in ${rel} has no index.html.`);
    let meta = {};
    try { meta = JSON.parse(files['app.json']?.toString() || '{}'); } catch { throw new Error(`The app in ${rel} has an app.json that isn't JSON.`); }
    const uses = list(meta.uses) || [];
    const bad = uses.filter((u) => !USES.includes(u));
    if (bad.length) throw new Error(`The app in ${rel} asks for ${bad.join(', ')}, which apps can't have. They can use: ${USES.join(', ')}.`);
    if (meta.today && files['widget.html'] && !uses.includes('today-card')) notes.push(`${rel} has a card for Home, but it shows only with "today-card" in its "uses".`);
    // A reach is a host, or a website the household picks when it sets the app up ({setup, why}: a transit agency's
    // feed): no host until someone says yes on the tablet's card for one (askReach), shown on this card as just that.
    const setupReaches = (list(meta.reaches) || []).filter((h) => h && typeof h === 'object').slice(0, 2).map((h) => ({ key: String(h.setup || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'site', why: String(h.why || '').replace(/\s+/g, ' ').trim().slice(0, 120) }));
    if (setupReaches.some((h) => !h.why)) throw new Error(`The app in ${rel} wants a website chosen at setup: say why ("why").`);
    const reaches = (list(meta.reaches) || []).filter((h) => typeof h === 'string').map((h) => String(h).toLowerCase());
    const badHost = reaches.filter((h) => !reachOk(h));
    if (badHost.length) throw new Error(`The app in ${rel} wants to reach ${badHost.join(', ')}: give plain host names like api.example.com (or *.example.com).`);
    let actions;
    try { actions = cleanActions(meta.actions); } catch (e) { throw new Error(`The app in ${rel}: ${e.message}`); }
    // Its heartbeat checks (heartbeat-checks.js): data only; one that doesn't fit is left out, with a note.
    const ck = validateChecks(meta.checks);
    for (const p of ck.problems) notes.push(`Left out of ${rel}: ${p}.`);
    // Fixed by the card, like its rights: whether it keeps running in the background, and whether it's for a TV.
    // (where else it runs, docs/plugins.md "Phones": "tablet", "phone", "tv"; only the TV is a right on the card)
    const screens = [...new Set((list(meta.screens) || []).filter((k) => ['tv', 'tablet', 'phone'].includes(k)))];
    return { id, name: String(meta.name || id).slice(0, 40), uses: [...new Set(uses)], reaches: [...new Set(reaches)].slice(0, 10), ...(setupReaches.length ? { setupReaches } : {}), actions, checks: ck.checks,
      background: meta.background === true, ...(screens.length ? { screens, tablet: meta.tablet === true } : {}), files };
  });
  if (appDirs.length > 20) throw new Error('It has more than 20 apps.');
  if (total > MAX_BYTES || count > MAX_FILES) throw new Error('That plugin is too big.');
  if (new Set(apps.map((a) => a.id)).size !== apps.length) throw new Error('Two of its apps have the same folder name.');

  let look = null;
  const lookFile = list(oh.looks)?.[0] ?? list(oh.look)?.[0] ?? (fs.existsSync(path.join(root, 'looks')) ? fs.readdirSync(path.join(root, 'looks')).filter((f) => f.endsWith('.json')).map((f) => `looks/${f}`)[0] : null);
  if (lookFile) {
    const f = inside(root, String(lookFile));
    let raw; try { raw = readJson(f); } catch { throw new Error(`Its look (${lookFile}) isn't JSON.`); }
    const clean = cleanLook(raw);
    look = Object.fromEntries(LOOK_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, clean[k]]));
    if (look.colors && !Object.keys(look.colors).length) delete look.colors;
    if (!Object.keys(look).length) look = null;
  }
  const tabs = (list(oh.tabs) || []).map((t) => (typeof t === 'string' ? { app: t } : t))
    .filter((t) => t && apps.some((a) => a.id === t.app)).map((t) => ({ app: t.app, ...(t.name ? { name: String(t.name).slice(0, 24) } : {}) }));
  if (!apps.length && !look) throw new Error('It has no apps or look for Opie.');
  let readme = ''; try { readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').slice(0, 1500); } catch {}
  return { name, title: String(oh.title || (apps.length === 1 ? apps[0].name : name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()))).slice(0, 60), version: String(pkg.version || '').slice(0, 20),
    description: String(pkg.description || '').slice(0, 300), readme, apps, look, tabs, notes };
}

/**
 * Voice actions an app declares in its app.json ("actions"): things the household can ask the voice for that the app
 * then does in its own page. Data only: { name, description, parameters: a flat JSON schema (string, number, integer,
 * boolean; enum allowed), reply: what the voice says, open: show the app (its tab, else its window), answer: the app's
 * page answers it (what its onAction handler returns is what the voice says; reply is said if it doesn't in time),
 * wait: how many seconds to wait for that answer (1-30; 6 if not said: a web search takes longer) }.
 * All of its words are what the voice model is told, and all of them are on the card someone approves (actionWords),
 * so each is kept short (ACTION_LIMITS): one over is refused, never cut. Throws with words.
 */
export const ACTION_LIMITS = { actions: 16, description: 600, parameters: 8, parameter: 200, choices: 20, choice: 60, reply: 300 };
export function cleanActions(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('its "actions" should be a list.');
  const L = ACTION_LIMITS;
  if (raw.length > L.actions) throw new Error(`it has more than ${L.actions} voice actions.`);
  const seen = new Set();
  return raw.map((a) => {
    const name = String(a?.name || '');
    if (!ACTION.test(name) || seen.has(name)) throw new Error(`a voice action's name ("${name.slice(0, 40)}") should be lowercase letters, digits and _ , each once.`);
    seen.add(name);
    const description = String(a.description || '').trim();
    if (!description) throw new Error(`the voice action ${name} needs a description.`);
    if (description.length > L.description) throw new Error(`the voice action ${name}'s description is longer than ${L.description} characters.`);
    const props = a.parameters?.properties && typeof a.parameters.properties === 'object' ? a.parameters.properties : {};
    if (Object.keys(props).length > L.parameters) throw new Error(`the voice action ${name} has more than ${L.parameters} parameters.`);
    const properties = {};
    for (const [k, v] of Object.entries(props)) {
      if (!/^[a-z][a-z0-9_]{0,30}$/i.test(k) || !['string', 'number', 'integer', 'boolean'].includes(v?.type)) throw new Error(`the voice action ${name}'s parameter ${k.slice(0, 30)} should be a string, number, integer or boolean.`);
      const about = v.description == null ? '' : String(v.description).trim();
      if (about.length > L.parameter) throw new Error(`the voice action ${name}'s parameter ${k} has a description longer than ${L.parameter} characters.`);
      const choices = Array.isArray(v.enum) ? v.enum.map((x) => (v.type === 'string' ? String(x) : x)) : null;
      if (choices && (choices.length > L.choices || choices.some((x) => typeof x === 'object' || String(x).length > L.choice))) throw new Error(`the voice action ${name}'s parameter ${k} should have at most ${L.choices} choices, each at most ${L.choice} characters.`);
      properties[k] = { type: v.type, ...(about ? { description: about } : {}), ...(choices ? { enum: choices } : {}) };
    }
    const required = (Array.isArray(a.parameters?.required) ? a.parameters.required : []).filter((k) => properties[k]);
    const reply = String(a.reply || '');
    if (reply.length > L.reply) throw new Error(`the voice action ${name}'s reply is longer than ${L.reply} characters.`);
    return { name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) }, reply, open: a.open === true, ...(a.answer === true ? { answer: true } : {}),
      ...(a.answer === true && Number(a.wait) > 0 ? { wait: Math.max(1, Math.min(30, Math.round(Number(a.wait)))) } : {}) };
  });
}
/** An action's arguments checked against its parameters: the cleaned args, or throws. */
export function actionArgs(action, args) {
  const out = {}, props = action.parameters.properties;
  for (const k of action.parameters.required || []) if (args?.[k] === undefined || args[k] === null || args[k] === '') throw new Error(`${k} is needed.`);
  for (const [k, v] of Object.entries(args || {})) {
    const p = props[k]; if (!p || v === undefined || v === null) continue;
    let x = v;
    if (p.type === 'string') x = String(v).slice(0, 500);
    else if (p.type === 'boolean') x = v === true || v === 'true';
    else { x = Number(v); if (!Number.isFinite(x)) throw new Error(`${k} should be a number.`); if (p.type === 'integer') x = Math.round(x); }
    if (p.enum && !p.enum.includes(x)) throw new Error(`${k} should be one of ${p.enum.join(', ')}.`);
    out[k] = x;
  }
  return out;
}

/** Everything a voice action tells the voice model, in the card's words: what it does, the name it is asked by, and
 *  each parameter's name, description and choices. Every card that shows the action shows all of this. */
export function actionWords(a) {
  const flat = (t) => String(t).replace(/\s+/g, ' ').trim();
  const params = Object.entries(a.parameters?.properties || {}).map(([k, v]) => `${k}: ${[v.description && flat(v.description).replace(/\.$/, ''), v.enum && `one of ${v.enum.join(', ')}`].filter(Boolean).join(', ') || v.type}`);
  return `${flat(a.description).replace(/\.$/, '')} (as "${a.name}"${params.length ? `, with ${params.join('; ')}` : ''})`;
}

/**
 * Everything a plugin's apps may do, merged into one list (one line per kind of right, the apps named when there are
 * several): what the install and update cards show first, in full.
 */
export function rightsMerged(apps) { return rightsList(apps).map((r) => r.text); }

/** The same, each line with its kind, for the card's icons (docs/ux.md): data, devices, cloud, web, offline, voice,
 *  watch, background, tv. */
export function rightsList(apps) {
  const words = rightWords, many = apps.length > 1, out = [];
  const of = (pick) => { const m = new Map(); for (const a of apps) for (const x of pick(a)) m.set(x, [...(m.get(x) || []), a.name]); return m; };
  const line = (m, show) => [...m].map(([x, who]) => show(x) + (many ? ` (${who.join(', ')})` : '')).join('; ');
  const own = new Set(['devices', 'decide']);
  const uses = of((a) => a.uses.filter((u) => !own.has(u))), dev = of((a) => a.uses.filter((u) => u === 'devices')), dec = of((a) => a.uses.filter((u) => u === 'decide'));
  const reaches = of((a) => [...a.reaches, ...(a.setupReaches || []).map((s) => `a website you choose when you set it up (${s.why.replace(/\.$/, '')})`), ...(a.chosen || []).map((c) => c.host)]), acts = of((a) => (a.actions || []).map(actionWords)), checks = of((a) => (a.checks || []).map((x) => x.text.replace(/\.$/, '')));
  out.push({ kind: 'data', text: uses.size ? `Uses ${line(uses, (u) => words[u] || u)}.` : "Uses none of the family's things." });
  if (dev.size) out.push({ kind: 'devices', text: `Uses ${line(dev, (u) => words[u])}.` });
  if (dec.size) out.push({ kind: 'cloud', text: `Uses ${line(dec, (u) => words[u])}.` });
  out.push(reaches.size ? { kind: 'web', text: `Reaches ${line(reaches, (h) => h)}.` } : { kind: 'offline', text: "Can't reach the internet." });
  for (const [x, who] of acts) out.push({ kind: 'voice', text: `The voice can ask it to: ${x}${many ? ` (${who.join(', ')})` : ''}.` }); // one line each, all of its words
  if (checks.size) out.push({ kind: 'watch', text: `It looks out for: ${line(checks, (x) => x)}.` });
  const bg = apps.filter((a) => a.background), tv = apps.filter((a) => a.screens?.includes('tv'));
  if (bg.length) out.push({ kind: 'background', text: `Keeps running in the background${many ? ` (${bg.map((a) => a.name).join(', ')})` : ''}.` });
  if (tv.length) out.push({ kind: 'tv', text: `Shows on the TV${many ? ` (${tv.map((a) => a.name).join(', ')})` : ''}.` });
  return out;
}
const rightWords = { lists: 'lists', chores: 'chores', rewards: 'rewards', meals: 'meals', events: 'the calendar', photos: 'photos', family: "the family's names", weather: 'the weather', home: 'the notes on Home', today: 'a line of its own on Home', days: 'notes of its own on the calendar\'s days (lunch, trash day)', 'calendar-events': 'events of its own on the calendar (it can\'t change the family\'s)', 'today-card': 'a card of its own on Home (once you turn it on)', timer: 'timers', say: 'speaking', devices: "the speakers and TVs (it asks before turning one on)", decide: "Opie's cloud for small questions (OpenAI)" };

/** One line per app of what it may do, in the card's words. */
export function rightsText(apps) {
  const words = rightWords;
  return apps.map((a) => {
    const can = a.uses.map((u) => words[u] || u);
    const hosts = [...a.reaches, ...(a.chosen || []).map((c) => c.host), ...(a.setupReaches || []).map((s) => `a website you choose when you set it up (${s.why.replace(/\.$/, '')})`)];
    return `${a.name}: ${can.length ? 'uses ' + can.join(', ') : "uses none of the family's things"}; ${hosts.length ? 'reaches ' + hosts.join(', ') : "can't reach the internet"}${a.actions?.length ? `; the voice can ask it to: ${a.actions.map(actionWords).join('; ')}` : ''}${a.checks?.length ? `; it looks out for: ${a.checks.map((x) => x.text.replace(/\.$/, '')).join('; ')}` : ''}${a.background ? '; keeps running in the background' : ''}${a.screens?.length ? '; shows on the TV' : ''}.`;
  });
}

/** Opie's list of plugins it reviewed (the gallery), published next to their tarballs (scripts/plugin-index.mjs). */
export const CATALOG_URL = 'https://d15yaylh7unz6h.cloudfront.net/releases/plugins/index.json';
const SHA256 = /^[0-9a-f]{64}$/;
/**
 * The list's entries the tablet will use: each tarball and image on the list's own host over https, with a sha256.
 * The rights here are only what the list says, for browsing; the card always says what the tarball itself asks for.
 */
export function cleanCatalog(raw, indexUrl = CATALOG_URL, { http = false } = {}) {
  const home = new URL(indexUrl);
  // http only for trying a list from a laptop (PLUGINS_LOCAL), and then only on the list's own host
  const onHome = (u) => { try { const x = new URL(String(u)); return (x.protocol === 'https:' || (http && x.protocol === 'http:')) && x.host === home.host && !x.username && !x.password ? x.href : null; } catch { return null; } };
  const out = [], seen = new Set();
  for (const e of Array.isArray(raw?.plugins) ? raw.plugins.slice(0, 200) : []) {
    const name = String(e?.name || '');
    const tarball = onHome(e?.tarball);
    if (!ID.test(name) || seen.has(name) || !tarball || !/\.(tgz|tar\.gz)$/i.test(new URL(tarball).pathname) || !SHA256.test(String(e.sha256 || ''))) continue;
    seen.add(name);
    out.push({ name, title: String(e.title || name).slice(0, 60), description: String(e.description || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      version: String(e.version || '').slice(0, 20), commit: /^[0-9a-f]{7,40}$/.test(String(e.commit || '')) ? String(e.commit) : null, tarball, sha256: String(e.sha256),
      ...(e.image && onHome(e.image) && /\.(png|jpe?g|webp)$/i.test(new URL(onHome(e.image)).pathname) ? { image: onHome(e.image) } : {}),
      rights: (Array.isArray(e.rights) ? e.rights : []).slice(0, 12).map((l) => String(l).slice(0, 400)) });
  }
  return out;
}


/**
 * Every app on the tablet belongs to one plugin (docs/plugins.md §11). webapp/plugins/<name>.json, one file per plugin,
 * in git with the apps (so undo keeps them right) and outside apps/ (so neither the assistant nor a computer writes
 * them; the bridge keeps them):
 *   builtin  ours (defaults/apps): { kind, title, version, apps: { id: { files } }, overriddenBy?, removed? }.
 *            Updated with each Opie release while the household never changed it.
 *   local    the household's own: { kind, title, created, apps: { id: {} }, overrides? }. Full ("own") rights. Its
 *            version is the count of its changes (git), so the manifest never changes with an edit.
 *   shared   from a link: { kind, title, source, commit, version, installed, apps: { id: { from, name, uses,
 *            reaches, actions, files } }, look, tabs }. Only what the card granted.
 * A household change to a built-in makes a local plugin that overrides it (the built-in stays listed, overriddenBy),
 * in the same commit as the change (reconcile, edits.js snapshot), so our updates and their changes never collide.
 */
export function pluginsRoutes({ APP_DIR, edits, homeScreen, json, body, approve = null, onChange = () => {}, local = !!process.env.PLUGINS_LOCAL, household = () => ({}),
  DATA = null, DEFAULTS = null, SEEDED = null, answerWaitMs = 6000, log = (...a) => console.log('[plugins]', ...a),
  ai = null, fetchImpl = (...a) => fetch(...a), web = {}, catalogUrl = process.env.PLUGIN_INDEX_URL || CATALOG_URL }) {
  const DIR = path.join(APP_DIR, 'plugins');
  const LEGACY = path.join(APP_DIR, 'plugins.json'); // v1's one lock file, moved into DIR by migrate()
  const MARK = path.join(DIR, '.v1');
  const appsDir = path.join(APP_DIR, 'apps');
  const builtinName = (id) => `openhouse-${id}`;
  const now = () => new Date().toISOString();

  // ---- the registry ----
  const fileOf = (name) => path.join(DIR, name + '.json');
  function readAll() {
    const out = {};
    let names = []; try { names = fs.readdirSync(DIR); } catch {}
    for (const f of names.sort()) {
      if (!f.endsWith('.json') || !ID.test(f.slice(0, -5))) continue;
      try { const e = readJson(path.join(DIR, f)); if (e && typeof e === 'object') out[f.slice(0, -5)] = { kind: 'shared', ...e }; } catch {}
    }
    return out;
  }
  function save(name, e) {
    fs.mkdirSync(DIR, { recursive: true });
    storeJson(fileOf(name), e, { bak: false, space: 2, newline: true }); // (in the apps' git folder: no .bak beside it)
  }
  const drop = (name) => fs.rmSync(fileOf(name), { force: true });
  const owns = (e, id) => !!e?.apps?.[id] && !(e.kind === 'builtin' && (e.overriddenBy || e.removed));
  function ownerOf(id, all = readAll()) { for (const [name, e] of Object.entries(all)) if (owns(e, id)) return { name, e }; return null; }
  const freeName = (want, all) => { const base = ID.test(want) ? want : 'app'; let n = base, i = 2; while (all[n]) n = `${base.slice(0, 56)}-${i++}`; return n; };
  const migrated = () => fs.existsSync(MARK);

  // ---- app folders ----
  const appIds = () => { try { return fs.readdirSync(appsDir).filter((d) => ID.test(d) && d !== 'home' && fs.statSync(path.join(appsDir, d)).isDirectory()); } catch { return []; } };
  const appMeta = (dir) => { try { return readJson(path.join(dir, 'app.json')) || {}; } catch { return {}; } };
  const appName = (id) => String(appMeta(path.join(appsDir, id)).name || id).slice(0, 40);
  /** { "rel/path": sha256 } of an app folder (dotfiles and node_modules left out), or null when it isn't there. */
  function filesOf(dir) {
    const out = {};
    const walk = (d, rel) => {
      for (const f of fs.readdirSync(d).sort()) {
        if (f.startsWith('.') || f === 'node_modules') continue;
        const p = path.join(d, f), st = fs.lstatSync(p);
        if (st.isDirectory()) walk(p, rel + f + '/'); else if (st.isFile()) out[rel + f] = sha(fs.readFileSync(p));
      }
    };
    try { if (!fs.statSync(dir).isDirectory()) return null; walk(dir, ''); } catch { return null; }
    return out;
  }
  const same = (a, b) => !!a && !!b && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);
  function copyApp(src, id) {
    const d = path.join(appsDir, id);
    fs.rmSync(d, { recursive: true, force: true });
    fs.cpSync(src, d, { recursive: true, filter: (f) => !path.basename(f).startsWith('.') || f === src });
  }
  const git = (...a) => edits.git(...a);
  /** A local plugin's version: 1.0.<its changes>, from git, so its manifest never changes with an edit. */
  function localVersion(e) {
    const paths = Object.keys(e.apps || {}).map((id) => `apps/${id}`);
    try { return `1.0.${git('rev-list', '--count', 'HEAD', '--', ...paths) || 0}`; } catch { return '1.0.0'; }
  }

  // ---- ours: defaults/apps ----
  function shipped() {
    if (!DEFAULTS) return [];
    let ids = []; try { ids = fs.readdirSync(DEFAULTS); } catch { return []; }
    return ids.filter((id) => ID.test(id) && id !== 'home' && fs.existsSync(path.join(DEFAULTS, id, 'index.html'))).sort().map((id) => {
      const dir = path.join(DEFAULTS, id), files = filesOf(dir), meta = appMeta(dir);
      return { id, dir, files, title: String(meta.name || id).slice(0, 40), version: String(meta.version || sha(JSON.stringify(files)).slice(0, 7)) };
    });
  }
  const readSeeded = () => { try { return new Set(fs.readFileSync(SEEDED, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)); } catch { return new Set(); } };

  /**
   * The registry follows the files: called with the app ids a commit changes, before it's made (edits.js snapshot).
   * A new app folder becomes a local plugin; a built-in whose files changed becomes a local plugin that overrides it;
   * an app folder that's gone takes its plugin with it (a built-in is marked removed, so it doesn't come back).
   * Returns true when it wrote a manifest.
   */
  function reconcile(ids) {
    if (!migrated()) return false;
    const all = readAll();
    let wrote = false;
    for (const id of ids) {
      if (!ID.test(id) || id === 'home') continue;
      const here = filesOf(path.join(appsDir, id));
      const o = ownerOf(id, all);
      const b = all[builtinName(id)]?.kind === 'builtin' ? all[builtinName(id)] : null;
      if (here && Object.keys(here).length) {
        if (!o || (o.e.kind === 'builtin' && !same(here, o.e.apps[id].files))) {
          const name = freeName(id, all);
          all[name] = { kind: 'local', title: appName(id), created: now(), apps: { [id]: {} }, ...(b ? { overrides: builtinName(id), forkedFrom: b.version } : {}) };
          save(name, all[name]); wrote = true;
          if (b) { b.overriddenBy = name; delete b.removed; save(builtinName(id), b); }
          log(o ? `${id} changed here: it's the household's own now (${name}, over ${builtinName(id)})` : `${id} is a new plugin of the household's (${name})`);
        } else if (o.e.kind === 'local' && o.e.title !== appName(id)) { o.e.title = appName(id); save(o.name, o.e); wrote = true; }
        continue;
      }
      if (!o) continue;
      if (o.e.kind === 'local') {
        drop(o.name); delete all[o.name]; wrote = true;
        const ob = o.e.overrides && all[o.e.overrides];
        if (ob) { delete ob.overriddenBy; ob.removed = true; save(o.e.overrides, ob); }
      } else if (o.e.kind === 'builtin') { o.e.removed = true; save(o.name, o.e); wrote = true; }
      else {
        delete o.e.apps[id]; wrote = true;
        if (!Object.keys(o.e.apps).length && !o.e.look) { drop(o.name); delete all[o.name]; } else save(o.name, o.e);
      }
    }
    if (wrote) cache.stamp = null;
    return wrote;
  }
  edits.setBeforeCommit?.(reconcile);

  /** An app's commits so far all came from us ("Starting apps…"), and nothing in it is uncommitted. */
  function untouched(id) {
    try {
      if (git('status', '--porcelain', '--', `apps/${id}`)) return false;
      return git('log', '--format=%s', '--', `apps/${id}`).split('\n').filter(Boolean).every((m) => /^Starting apps/.test(m));
    } catch { return false; }
  }

  /**
   * Once per tablet: every app in webapp/apps becomes a plugin, nothing else changes (not a file of an app, not
   * appdata/, not the tabs). One commit "Apps became plugins", not on the undo stack; unmigrate() goes back.
   */
  function migrate() {
    if (migrated()) return { already: true };
    const owner = { id: 'migrate', kind: 'plugin', who: null, text: 'Apps became plugins' };
    if (!edits.tryAcquire(owner, { checkpoint: true })) return { error: edits.busyText() || 'Busy', busy: true };
    try {
      try { git('tag', '-f', 'before-plugins', 'HEAD'); } catch {}
      const all = {};
      let legacy = {}; try { legacy = readJson(LEGACY) || {}; } catch {}
      for (const [n, e] of Object.entries(legacy)) if (ID.test(n) && e && typeof e === 'object') all[n] = { kind: 'shared', ...e };
      const taken = new Set(Object.values(all).flatMap((e) => Object.keys(e.apps || {})));
      const ship = new Map(shipped().map((s) => [s.id, s]));
      const seeded = readSeeded();
      const out = { shared: Object.keys(all), builtin: [], local: [], overridden: [], removed: [] };
      for (const id of appIds()) {
        if (taken.has(id)) continue;
        const s = ship.get(id), files = filesOf(path.join(appsDir, id));
        if (s && untouched(id)) {
          all[builtinName(id)] = { kind: 'builtin', title: s.title, version: same(files, s.files) ? s.version : '0', installed: now(), apps: { [id]: { files } } };
          out.builtin.push(id);
          continue;
        }
        const name = freeName(id, all);
        all[name] = { kind: 'local', title: appName(id), created: now(), apps: { [id]: {} }, ...(s ? { overrides: builtinName(id) } : {}) };
        if (s) { all[builtinName(id)] = { kind: 'builtin', title: s.title, version: s.version, apps: { [id]: { files: s.files } }, overriddenBy: name }; out.overridden.push(id); }
        else out.local.push(id);
      }
      for (const [id, s] of ship) if (!all[builtinName(id)] && seeded.has(id) && !fs.existsSync(path.join(appsDir, id))) {
        all[builtinName(id)] = { kind: 'builtin', title: s.title, version: s.version, apps: { [id]: { files: s.files } }, removed: true }; out.removed.push(id);
      }
      for (const [n, e] of Object.entries(all)) save(n, e);
      fs.rmSync(LEGACY, { force: true });
      fs.mkdirSync(DIR, { recursive: true }); // a new tablet has no plugins folder yet
      fs.writeFileSync(MARK, 'Every app in apps/ belongs to one plugin here (bridge/plugins.js, docs/plugins.md).\n');
      cache.stamp = null;
      const sha_ = edits.finish(owner, true, { quiet: true });
      log(`apps became plugins (${sha_?.slice(0, 7)}): built-in ${out.builtin.join(' ') || '-'}; the household's ${out.local.join(' ') || '-'}; theirs over ours ${out.overridden.join(' ') || '-'}; shared ${out.shared.join(' ') || '-'}; taken off before ${out.removed.join(' ') || '-'}`);
      return { ok: true, commit: sha_, ...out };
    } catch (e) { edits.finish(owner, false); return { error: e.message }; }
  }
  /** Back to before plugins: the shared ones in plugins.json again, plugins/ gone. Apps and their data stay as they are. */
  function unmigrate() {
    if (!migrated()) return { error: 'Not moved to plugins.' };
    const owner = { id: 'unmigrate', kind: 'plugin', who: null, text: 'Apps back from plugins' };
    if (!edits.tryAcquire(owner, { checkpoint: true })) return { error: edits.busyText() || 'Busy', busy: true };
    try {
      const shared = Object.fromEntries(Object.entries(readAll()).filter(([, e]) => e.kind === 'shared').map(([n, { kind, ...e }]) => [n, e]));
      fs.rmSync(DIR, { recursive: true, force: true });
      if (Object.keys(shared).length) storeJson(LEGACY, shared, { bak: false, space: 2, newline: true });
      cache.stamp = null;
      return { ok: true, commit: edits.finish(owner, true, { quiet: true }) };
    } catch (e) { edits.finish(owner, false); return { error: e.message }; }
  }

  /**
   * Our apps, as this release ships them (defaults/apps): new ones go in, and a newer one replaces the tablet's copy
   * only while it is still exactly what we put there. One commit, not on the undo stack (undo_plugin can take it back).
   */
  function syncBuiltins() {
    if (!migrated()) return { error: 'not moved to plugins yet' };
    const ship = shipped();
    if (!ship.length) return { added: [], updated: [] };
    const owner = { id: 'openhouse', kind: 'plugin', who: null, text: 'Opie plugins' };
    if (!edits.tryAcquire(owner, { checkpoint: true })) return { error: edits.busyText() || 'Busy', busy: true };
    const added = [], updated = [];
    try {
      const all = readAll();
      for (const s of ship) {
        const name = builtinName(s.id), e = all[name]?.kind === 'builtin' ? all[name] : null, dest = path.join(appsDir, s.id);
        if (!e) {
          if (all[name]) continue; // a shared or household plugin happens to have that name: leave it be
          const o = ownerOf(s.id, all);
          if (fs.existsSync(dest)) {
            let by = o?.name;
            if (!by) { by = freeName(s.id, all); all[by] = { kind: 'local', title: appName(s.id), created: now(), apps: { [s.id]: {} }, overrides: name }; save(by, all[by]); }
            all[name] = { kind: 'builtin', title: s.title, version: s.version, apps: { [s.id]: { files: s.files } }, overriddenBy: by };
          } else {
            copyApp(s.dir, s.id);
            all[name] = { kind: 'builtin', title: s.title, version: s.version, installed: now(), apps: { [s.id]: { files: s.files } } };
            added.push(s.id);
          }
          save(name, all[name]);
          continue;
        }
        if (e.removed || e.overriddenBy) continue; // theirs (or taken off): what we ship now shows as "latest" in list_plugins
        const here = filesOf(dest);
        if (!here || same(here, s.files)) continue;
        if (!same(here, e.apps[s.id]?.files)) continue; // changed and not saved yet: the household's (reconcile makes it theirs)
        copyApp(s.dir, s.id);
        Object.assign(e, { version: s.version, updated: now() });
        e.apps[s.id] = { files: s.files };
        save(name, e);
        updated.push(`${s.id} ${s.version}`);
      }
      owner.text = [added.length && `Opie added: ${added.join(', ')}`, updated.length && `Opie updated: ${updated.join(', ')}`].filter(Boolean).join('; ') || 'Opie plugins';
      cache.stamp = null;
      const c = edits.finish(owner, true, { quiet: true });
      if (c) { log(owner.text); onChange(); }
      return { added, updated, commit: c };
    } catch (e) { edits.finish(owner, false); return { error: e.message }; }
  }
  /**
   * At start-up: the one-time move (if it hasn't happened), then this release's built-ins. When the edit lock is held
   * (a computer's change open since before the restart: server.js takes it back first), both wait for it and run
   * once it's free, rather than committing over that change.
   */
  let retry = null;
  function start() {
    const again = !!retry; clearTimeout(retry); retry = null;
    const m = migrate();
    if (m.error && !(m.busy && again)) log('not moved to plugins:', m.error);
    const s = m.busy ? { error: m.error, busy: true } : syncBuiltins();
    if (s.error && !m.busy && !(s.busy && again)) log('built-ins not updated:', s.error);
    if (m.busy || s.busy) { retry = setTimeout(start, 15e3); retry.unref?.(); }
    return { migrate: m, sync: s };
  }

  // ---- rights ----
  let cache = { stamp: null, rights: new Map() };
  const stampOf = () => { try { return fs.readdirSync(DIR).map((f) => { const st = fs.statSync(path.join(DIR, f)); return `${f}:${st.mtimeMs}:${st.size}`; }).join('|'); } catch { return ''; } };
  /** The groups an app from a shared plugin was granted (a Set), or null for an app with its own rights (ours, the household's). Follows undo. */
  function rightsOf(app) {
    const stamp = stampOf();
    if (stamp !== cache.stamp) {
      const rights = new Map();
      for (const e of Object.values(readAll())) for (const [id, a] of Object.entries(e.apps || {})) {
        // A shared app's card granted its groups; an app made on the tablet (madeHere) only what a parent's yes granted.
        if (e.kind === 'shared' || (e.kind === 'local' && a.limited)) rights.set(id, new Set((a.uses || []).filter((u) => USES.includes(u))));
      }
      cache = { stamp, rights };
    }
    return cache.rights.get(app) || null;
  }

  /** What a shared app's card fixed of its app.json: {background, screens, tablet, reaches}; null for ours and the household's. */
  function frozenOf(app) {
    const o = ownerOf(app);
    if (o?.e.kind === 'local' && o.e.apps[app]?.limited) return { background: false, screens: undefined, tablet: false, reaches: reachesOf(app) }; // made on the tablet: only the sites its card granted
    if (o?.e.kind !== 'shared') return null;
    const a = o.e.apps[app] || {};
    return { background: a.background === true, screens: a.screens?.length ? a.screens : undefined, tablet: a.tablet === true, reaches: reachesOf(app) };
  }

  /** The hosts an app may reach through the bridge (app-web.js): a shared app's, as its card granted; ours and the
   *  household's, from its app.json "reaches". */
  function reachesOf(app) {
    const o = ownerOf(app);
    const raw = o?.e.kind === 'local' && o.e.apps[app]?.limited ? o.e.apps[app].reaches || [] // made on the tablet: only what its card granted, whatever its app.json says
      : o?.e.kind === 'shared' ? [...(o.e.apps[app]?.reaches || []), ...(o.e.apps[app]?.chosen || []).map((c) => c.host)] : appMeta(path.join(appsDir, app)).reaches;
    return (list(raw) || []).filter((h) => typeof h === 'string').map((h) => h.toLowerCase()).filter(reachOk).slice(0, 14);
  }

  /**
   * An app made on the tablet (rails.js), marked before its change is committed, in the same commit (undo takes both):
   * the household's own, but with the rights of one from a link that was granted only [uses] and [reaches] (none by
   * default: exact hosts, no "*."), and its own origin. A change to an app that already has its own rights (ours, the
   * household's) leaves them as they were; one to a limited app adds to what it had. Returns whether the app is limited now.
   */
  function madeHere(id, { uses = [], reaches = [] } = {}) {
    if (!ID.test(id) || id === 'home' || !migrated()) return false;
    const all = readAll(), o = ownerOf(id, all), granted = (Array.isArray(uses) ? uses : []).filter((u) => USES.includes(u));
    const hosts = (Array.isArray(reaches) ? reaches : []).map((h) => String(h).toLowerCase()).filter((h) => !h.startsWith('*.') && reachOk(h));
    if (o && !(o.e.kind === 'local' && o.e.apps[id]?.limited)) return false;
    if (o) { const a = o.e.apps[id]; o.e.apps[id] = { ...a, uses: [...new Set([...(a.uses || []), ...granted])], reaches: [...new Set([...(a.reaches || []), ...hosts])].slice(0, MAX_REACH) }; }
    else { const name = freeName(id, all); all[name] = { kind: 'local', title: appName(id), created: now(), apps: { [id]: { limited: true, uses: granted, reaches: [...new Set(hosts)].slice(0, MAX_REACH) } } }; }
    const name = o ? o.name : Object.keys(all).find((n) => all[n].apps?.[id]);
    save(name, all[name]); cache.stamp = null;
    return true;
  }
  /** A limited app made on the tablet taken off the registry (a change's draft, once it's swapped in: rails.js). */
  function unmake(id) {
    const all = readAll(), o = ownerOf(id, all);
    if (!o || o.e.kind !== 'local' || !o.e.apps[id]?.limited) return false;
    delete o.e.apps[id];
    if (Object.keys(o.e.apps).length) save(o.name, o.e); else drop(o.name);
    cache.stamp = null;
    return true;
  }
  /** Whether an app is one made on the tablet, with only what it was granted. */
  const limited = (id) => { const o = ownerOf(id); return !!(o?.e.kind === 'local' && o.e.apps[id]?.limited); };

  // ---- a website chosen at setup (app.json "reaches": [{setup, why}]) ----
  const asking = new Set(); // one card at a time per app
  /** A host a shared app asks to reach, for one of the websites its card said it would choose at setup: the tablet's
   *  card (with the PIN) names the host and says why in the plugin's own words from when it was added; on a yes the
   *  host is kept in the plugin's manifest (one change), never in the app's files. {ok} or {ok: false, error}. */
  async function askReach(app, host, key = null) {
    const o = ownerOf(app), a = o?.e.kind === 'shared' ? o.e.apps[app] : null;
    const setup = (a?.setupReaches || []).find((s) => !key || s.key === key) || null;
    if (!setup) return { ok: false, error: 'This app can only reach the websites its card named.' };
    const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
    if (!reachOk(h) || h.startsWith('*.') || h.includes(':') || net.isIP(h) || /^(localhost|.*\.(local|lan|home|internal|localhost))$/.test(h)) return { ok: false, error: 'Give a website\'s name, like api.example.com.' };
    if ((a.chosen || []).some((c) => c.host === h) || (a.reaches || []).includes(h)) return { ok: true, already: true };
    if ((a.chosen || []).length >= 4) return { ok: false, error: 'It has four websites already: forget one first.' };
    if (asking.has(app)) return { ok: false, error: 'Someone is being asked already.' };
    if (!approve) return { ok: false, error: 'Nobody here to ask.' };
    asking.add(app);
    let yes = false;
    try { yes = await approve(`Let ${a.name || app} reach ${h}?`, '', true, { rights: [{ kind: 'web', text: `${setup.why.replace(/\.$/, '')}.` }], more: `${a.name || app}${o.e.title && o.e.title !== a.name ? ` (the ${o.e.title} plugin)` : ''} reads from ${h} through the tablet. Settings, Plugins takes it away again.` }); }
    finally { asking.delete(app); }
    if (yes !== true) return { ok: false, error: 'Not this time.' };
    const r = inChange(`Let ${a.name || app} reach ${h}`, null, null, () => {
      const all = readAll(), e = all[o.name], x = e?.apps?.[app];
      if (!x) return { error: 'It was taken off.' };
      x.chosen = [...(x.chosen || []).filter((c) => c.host !== h), { host: h, key: setup.key, at: now() }];
      save(o.name, e);
      return { ok: true };
    });
    return r.error ? { ok: false, error: r.error } : { ok: true };
  }
  /** A chosen website the app no longer needs (the household picked another): gone without asking. */
  function forgetReach(app, host) {
    const o = ownerOf(app), a = o?.e.kind === 'shared' ? o.e.apps[app] : null, h = String(host || '').trim().toLowerCase();
    if (!a?.chosen?.some((c) => c.host === h)) return { ok: true };
    const r = inChange(`${a.name || app} no longer reaches ${h}`, null, null, () => {
      const all = readAll(), e = all[o.name], x = e.apps[app];
      x.chosen = (x.chosen || []).filter((c) => c.host !== h); if (!x.chosen.length) delete x.chosen;
      save(o.name, e); return { ok: true };
    });
    return r.error ? { ok: false, error: r.error } : { ok: true };
  }

  // ---- Opie's list (the gallery): fetched when someone looks, never on its own ----
  let cat = { at: 0, entries: null };
  async function catalog({ fresh = false } = {}) {
    if (!fresh && cat.entries && Date.now() - cat.at < 10 * 60e3) return cat.entries;
    let r;
    try { r = await fetchImpl(catalogUrl, { signal: AbortSignal.timeout(15e3), redirect: 'error' }); } catch { throw new Error("Couldn't reach Opie's list of plugins. Check the Wi-Fi and try again."); }
    if (!r.ok) throw new Error(`Opie's list of plugins didn't come (${r.status}).`);
    const text = await r.text();
    if (text.length > 1e6) throw new Error("Opie's list of plugins is too big.");
    let raw; try { raw = JSON.parse(text); } catch { throw new Error("Opie's list of plugins isn't readable right now."); }
    cat = { at: Date.now(), entries: cleanCatalog(raw, catalogUrl, { http: local }) };
    return cat.entries;
  }
  /** An entry on the list, by its name or title (null when there's none). */
  async function listed(q) {
    const k = String(q || '').trim().toLowerCase();
    if (!k || k.length > 80 || /[/:@]/.test(k)) return null;
    return (await catalog()).find((e) => e.name === k || e.title.toLowerCase() === k || e.name === k.replace(/ +/g, '-')) || null;
  }
  const catalogSource = (c) => ({ kind: 'tar', url: c.tarball, sha256: c.sha256, label: "Opie's plugins", key: `catalog:${c.name}`, catalog: c });
  /** Where the household's plugin from the list (or from a link) is now: the source to look at for an update. */
  // (a tarball's is kept as its label, without https://)
  const sourceOf = (e) => { const s = String(e.source || ''); return s.startsWith('catalog:') ? s.slice(8) : /\.(tgz|tar\.gz)$/i.test(s) ? (s.startsWith('https://') ? s : 'https://' + s) : s.replace(/@[^/]*$/, ''); };

  // ---- shared: from a link ----
  /**
   * Fetch and check, then throw the files away: what the card says. source: a link, or the name of a plugin on
   * Opie's list, which is then fetched only from the tarball the list pins, and only if its sha256 matches.
   */
  async function inspect(source, opts = {}) {
    let src = parseSource(source, { local: local || opts.local });
    if (!src && !/[/:]/.test(String(source || ''))) { const c = await listed(source); if (c) src = catalogSource(c); }
    if (!src) throw new Error('That isn\'t a plugin on Opie\'s list or a link one comes from: give a git link (github.com/someone/something, or with @version) or an https link to a .tgz.');
    const got = await fetchSource(src, fetchImpl, web);
    try {
      const p = { src, commit: src.catalog?.commit || got.commit, ...(got.sha256 ? { sha256: got.sha256 } : {}), ...checkPlugin(got.dir) };
      if (src.catalog && p.name !== src.catalog.name) throw new Error(`Opie's list says ${src.catalog.title}, but that tarball holds ${p.name}.`);
      return p;
    } finally { got.done(); }
  }
  /**
   * What the card says, all of it (never cut): where it's from, then everything it may do, merged, then our notes,
   * and last the plugin's own description, marked as its words (it could say anything).
   */
  const summary = (p, { already = true } = {}) => {
    const lines = [p.src.catalog ? `"${p.title}"${p.version ? ' ' + p.version : ''}, from Opie's list of plugins${p.commit ? ' (' + p.commit.slice(0, 7) + ')' : ''}. Reviewed for the list.`
      : `"${p.title}"${p.version ? ' ' + p.version : ''}, from ${p.src.label}${p.commit ? ' (' + p.commit.slice(0, 7) + ')' : ''}. Not reviewed for Opie's list.`];
    if (p.apps.length) lines.push(`${p.apps.length === 1 ? 'One app' : p.apps.length + ' apps'}${p.apps.length > 1 ? ` (${p.apps.map((a) => a.name).join(', ')})` : ''}. It:`, ...rightsMerged(p.apps).map((l) => '- ' + l));
    if (p.look) lines.push(`- Changes the look: ${lookWords(p.look)}.`);
    if (p.tabs.length) lines.push(`- Adds ${p.tabs.length === 1 ? 'a tab' : 'tabs'}: ${p.tabs.map((t) => t.name || t.app).join(', ')}.`);
    if (already && readAll()[p.name]?.kind === 'shared') lines.push('It is already on this tablet.');
    lines.push(...p.notes);
    if (p.description) lines.push(`In its own words: "${p.description.replace(/\s+/g, ' ').trim()}"`);
    return lines.join('\n');
  };
  const lookWords = (look) => Object.entries(look).map(([k, v]) => (k === 'colors' ? 'its own colors' : `${k} ${v}`)).join(', ');
  /** The tablet's card for a plugin (docs/ux.md): where it's from and everything it may do, each as a short line with
   *  its kind (shown in full, never behind More); the version, our notes and its own words behind More. */
  const card = (p, { already = true } = {}) => {
    const rights = [{ kind: 'from', text: p.src.catalog ? "From Opie's list, reviewed." : `From ${p.src.label}. Not reviewed for Opie's list.` }];
    if (p.apps.length > 1) rights.push({ kind: 'apps', text: `${p.apps.length} apps: ${p.apps.map((a) => a.name).join(', ')}.` });
    if (p.apps.length) rights.push(...rightsList(p.apps));
    if (p.look) rights.push({ kind: 'look', text: `Changes the look: ${lookWords(p.look)}.` });
    if (p.tabs.length) rights.push({ kind: 'tabs', text: `Adds ${p.tabs.length === 1 ? 'a tab' : 'tabs'}: ${p.tabs.map((t) => t.name || t.app).join(', ')}.` });
    const more = [[p.version, p.commit?.slice(0, 7)].filter(Boolean).join(', '), already && readAll()[p.name]?.kind === 'shared' ? 'Already on this tablet.' : '', ...p.notes,
      p.description ? `In its own words: "${p.description.replace(/\s+/g, ' ').trim()}"` : ''].filter(Boolean).join('\n');
    return { rights, more };
  };

  const freeId = (id, taken) => { let n = id, i = 2; while (taken(n)) n = `${id.slice(0, 56)}-${i++}`; return n; };
  /** Hold the edit lock for one change of ours (or join the turn that holds it). */
  function inChange(text, who, by, fn) {
    const holding = !!(by && edits.holder() === by);
    const owner = holding ? by : { id: 'plugin', kind: 'plugin', who, text };
    if (!holding && !edits.tryAcquire(owner, { checkpoint: true })) return { error: edits.busyText() || 'Busy', busy: true };
    try {
      const r = fn(owner);
      if (r?.error) { if (!holding) edits.finish(owner, false); return r; }
      cache.stamp = null;
      if (!holding) edits.finish(owner, true);
      onChange();
      return r;
    } catch (e) { if (!holding) edits.finish(owner, false); return { error: e.message }; }
  }
  const writeFiles = (id, files) => {
    const d = path.join(appsDir, id); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
    const out = {}; for (const [f, b] of Object.entries(files)) { fs.writeFileSync(path.join(d, f), b); out[f] = sha(b); } return out;
  };
  const appEntry = (a, files) => ({ from: a.id, name: a.name, uses: a.uses, reaches: a.reaches, ...(a.setupReaches?.length ? { setupReaches: a.setupReaches } : {}), ...(a.actions?.length ? { actions: a.actions } : {}), ...(a.checks?.length ? { checks: a.checks } : {}),
    ...(a.background ? { background: true } : {}), ...(a.screens?.length ? { screens: a.screens, tablet: a.tablet === true } : {}), files });

  /** Put it in: one change, undoable. by: a turn already holding the lock (its change then includes this). */
  function put(p, { tabs = true, who = null, by = null } = {}) {
    const all = readAll();
    if (all[p.name]?.kind === 'shared') return { error: `The ${p.title} plugin is already on this tablet. update_plugin brings a newer version.` };
    return inChange(`Add the ${p.title} plugin (${p.src.label}${p.commit ? ' @ ' + p.commit.slice(0, 7) : ''})`, who, by, (owner) => {
      const name = all[p.name] ? freeName(p.name, all) : p.name;
      const entry = { kind: 'shared', source: p.src.key || p.src.label, commit: p.commit, ...(p.sha256 ? { sha256: p.sha256 } : {}), ...(p.src.catalog ? { reviewed: true } : {}),
        version: p.version, title: p.title, installed: now(), apps: {}, look: !!p.look, tabs: [] };
      const ids = {};
      for (const a of p.apps) {
        const id = freeId(a.id, (n) => fs.existsSync(path.join(appsDir, n)) || Object.values(all).some((x) => x.apps?.[n]) || n === 'home');
        ids[a.id] = id;
        entry.apps[id] = appEntry(a, writeFiles(id, a.files));
        keepBase(id, a.files);
      }
      const look = { ...(p.look || {}) };
      if (tabs && p.tabs.length) {
        const cur = (homeScreen.style().tabs || DEFAULT_TABS).map((t) => (typeof t === 'string' || t.name ? t : t.id));
        const add = p.tabs.map((t) => (t.name ? { id: ids[t.app], name: t.name } : ids[t.app])).filter((t) => !cur.some((x) => (x.id || x) === (t.id || t)));
        const at = cur.indexOf('apps') >= 0 ? cur.indexOf('apps') : cur.length;
        look.tabs = [...cur.slice(0, at), ...add, ...cur.slice(at)];
        entry.tabs = add.map((t) => t.id || t);
      }
      save(name, entry);
      if (Object.keys(look).length) { const r = homeScreen.setLook(look, owner, who); if (r.error) throw new Error(r.error); }
      log(`added ${name} from ${entry.source}${p.commit ? ' @ ' + p.commit.slice(0, 7) : ''}: ${Object.keys(entry.apps).join(', ') || 'a look'}`);
      return { ok: true, name, apps: Object.keys(entry.apps), tabs: entry.tabs };
    });
  }

  /** A newer version of a shared plugin, from the same place: what changes, and new rights it asks for. */
  function updateDiff(name, p) {
    const e = readAll()[name], out = { changedHere: [], newRights: [] };
    for (const [id, a] of Object.entries(e.apps || {})) {
      if (!same(filesOf(path.join(appsDir, id)), a.files)) out.changedHere.push(a.name || id);
      const n = p.apps.find((x) => x.id === a.from);
      if (!n) continue;
      // Anything the card didn't show before asks again, with the PIN: a right, a host, a voice action, a check,
      // running in the background, being for a TV.
      const had = (xs, k) => new Set((xs || []).map((x) => x[k]));
      const acts = had(a.actions, 'name'), cks = had(a.checks, 'text');
      const more = [...n.uses.filter((u) => !(a.uses || []).includes(u)), ...n.reaches.filter((h) => !(a.reaches || []).includes(h)).map((h) => 'reaching ' + h),
        ...(n.setupReaches || []).filter((s) => !(a.setupReaches || []).some((x) => x.key === s.key && x.why === s.why)).map((s) => `reaching a website you choose when you set it up (${s.why.replace(/\.$/, '')})`),
        ...(n.actions || []).filter((x) => !acts.has(x.name) || JSON.stringify(x) !== JSON.stringify(a.actions.find((y) => y.name === x.name))).map((x) => 'the voice asking it to ' + actionWords(x)),
        ...(n.checks || []).filter((x) => !cks.has(x.text)).map((x) => 'looking out for ' + x.text.replace(/\.$/, '')),
        ...(n.background && !a.background ? ['running in the background'] : []), ...(n.screens?.includes('tv') && !a.screens?.includes('tv') ? ['showing on the TV'] : [])];
      if (more.length) out.newRights.push(`${n.name}: ${more.join(', ')}`);
    }
    const from = new Set(Object.values(e.apps || {}).map((a) => a.from));
    for (const n of p.apps) if (!from.has(n.id)) out.newRights.push(`a new app, ${rightsText([n])[0]}`);
    return out;
  }
  function update(name, p, { who = null, by = null, keepTheirs = true, source = null } = {}) {
    const e = readAll()[name];
    if (e?.kind !== 'shared') return { error: `No plugin from a link called ${name} is on this tablet.` };
    const d = updateDiff(name, p);
    if (d.changedHere.length && keepTheirs) return { error: `${d.changedHere.join(', ')} changed here since it was added, so it's the household's version now. Taking the new one replaces their changes (one undo brings them back): ask, then update again with replace.`, changedHere: d.changedHere };
    return inChange(`Update the ${e.title || name} plugin to ${p.version || p.commit?.slice(0, 7)}`, who, by, () => {
      const { skip, merged, ...rest } = e;
      // From another place (its card said so): that is where it comes from now, reviewed only if it's Opie's list.
      if (source) { rest.source = source.key || source.label; delete rest.reviewed; if (source.catalog) rest.reviewed = true; }
      const next = { ...rest, commit: p.commit, ...(p.sha256 ? { sha256: p.sha256 } : {}), version: p.version, title: p.title, updated: now(), apps: {} };
      const byFrom = new Map(Object.entries(e.apps || {}).map(([id, a]) => [a.from || id, id]));
      for (const a of p.apps) {
        const id = byFrom.get(a.id) || freeId(a.id, (n) => fs.existsSync(path.join(appsDir, n)) || n === 'home');
        next.apps[id] = appEntry(a, writeFiles(id, a.files));
        // the websites the household chose for it stay, as long as the new version still chooses that kind at setup
        const kept = (e.apps[id]?.chosen || []).filter((c) => (a.setupReaches || []).some((s) => s.key === c.key));
        if (kept.length) next.apps[id].chosen = kept;
        keepBase(id, a.files);
      }
      for (const id of Object.keys(e.apps || {})) if (!next.apps[id]) { fs.rmSync(path.join(appsDir, id), { recursive: true, force: true }); dropBase(id); }
      save(name, next);
      return { ok: true, name, version: p.version, apps: Object.keys(next.apps) };
    });
  }

  // ---- the version a shared app came as (its base), kept beside the manifests: to put two versions together ----
  const BASE = path.join(DIR, '.base');
  const baseDir = (id) => path.join(BASE, id);
  function keepBase(id, files) {
    const d = baseDir(id); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
    for (const [f, b] of Object.entries(files)) fs.writeFileSync(path.join(d, f), b);
  }
  const dropBase = (id) => fs.rmSync(baseDir(id), { recursive: true, force: true });
  function readFlat(d) {
    const out = {};
    try { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (!f.startsWith('.') && fs.lstatSync(p).isFile()) out[f] = fs.readFileSync(p); } } catch { return null; }
    return out;
  }
  const hashes = (files) => Object.fromEntries(Object.entries(files).map(([f, b]) => [f, sha(b)]));
  /** The files a shared app came as (its manifest's hashes), or null when they can't be found. */
  function baseOf(id, a) {
    const kept = readFlat(baseDir(id));
    if (kept && same(hashes(kept), a.files)) return kept;
    try { // added before bases were kept: the commit that put that version in, from git
      for (const h of git('log', '-40', '--format=%H', '--', `apps/${id}`).split('\n').filter(Boolean)) {
        const names = git('ls-tree', '--name-only', h, `apps/${id}/`).split('\n').filter(Boolean).map((x) => path.basename(x));
        if (names.length !== Object.keys(a.files || {}).length || !names.every((n) => a.files[n])) continue;
        const files = Object.fromEntries(names.map((n) => [n, execFileSync('git', [...GIT_SAFE, 'show', `${h}:apps/${id}/${n}`], { cwd: APP_DIR, maxBuffer: 1e7 })]));
        if (same(hashes(files), a.files)) return files;
      }
    } catch {}
    return null;
  }

  /** The household chose to keep their version: this update isn't offered again (a newer one is). Not a change of theirs. */
  function keepOurs(name, p) {
    const e = readAll()[name];
    if (e?.kind !== 'shared') return { error: `No plugin from a link called ${name} is on this tablet.` };
    const owner = { id: 'plugin', kind: 'plugin', who: null, text: `Keep the household's ${e.title || name} (not ${p.version || p.commit?.slice(0, 7)})` };
    if (!edits.tryAcquire(owner, { checkpoint: true })) return { error: edits.busyText() || 'Busy', busy: true };
    try { save(name, { ...e, skip: p.sha256 || p.commit }); cache.stamp = null; edits.finish(owner, true, { quiet: true }); return { ok: true, kept: true, title: e.title || name }; }
    catch (err_) { edits.finish(owner, false); return { error: err_.message }; }
  }

  const MERGE = `You put two versions of a small web app together. A household changed their copy ("yours") of an app that someone else made; then its maker published a new version ("theirs"). For each file, you get the version both started from ("base", when known), "yours" and "theirs". Make one version that keeps every change the household made and adds every change the maker made. Keep the code working: one coherent file, nothing duplicated. If the two changes contradict each other so that one must be dropped, or you aren't sure the result works, don't guess: say it can't be done cleanly.
Answer with JSON only, no other text: {"ok": true, "files": {"<file name>": "<the whole merged file>"}, "note": "<one short sentence for the household on what their copy now has>"} or {"ok": false, "reason": "<one short sentence>"}. Give every file you were asked about, whole.`;
  const textOut = (out) => (out || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');

  /**
   * Their new version's changes put onto the household's copy ("both"): files only one side changed are taken from that
   * side; files both changed go to the cloud's model with the version they started from. One change, undoable. If it
   * can't be done cleanly, nothing changes and the household's version stays. Rights: only what the update's card
   * approved (the new version's, from its own package), never what the household's or the merged app.json says.
   */
  async function merge(name, p, { who = null, by = null, model = ai } = {}) {
    const e = readAll()[name];
    if (e?.kind !== 'shared') return { error: `No plugin from a link called ${name} is on this tablet.` };
    const plan = [], ask = [], before = {};
    for (const [id, a] of Object.entries(e.apps || {})) {
      const n = p.apps.find((x) => x.id === a.from);
      if (!n) continue; // gone in theirs: the household's copy stays as it is
      const ours = readFlat(path.join(appsDir, id)) || {}, base = baseOf(id, a), theirs = n.files;
      before[id] = JSON.stringify(hashes(ours));
      const eq = (x, y) => (x == null && y == null) || (!!x && !!y && x.equals(y));
      const out = {}, conflicts = [];
      for (const f of new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base || {})])) {
        const o = ours[f], b = base?.[f], t = theirs[f];
        if (eq(o, t)) { if (o) out[f] = o; }
        else if (base && eq(o, b)) { if (t) out[f] = t; }
        else if (base && eq(t, b)) { if (o) out[f] = o; }
        else if (!TEXT.test(f)) return { error: `Both versions changed ${n.name}'s ${f}, which isn't text, so they can't be put together. Yours stays as it is.`, kept: true };
        else conflicts.push(f);
      }
      for (const f of conflicts) ask.push({ id, f, base: base?.[f]?.toString('utf8') ?? null, yours: ours[f]?.toString('utf8') ?? null, theirs: theirs[f]?.toString('utf8') ?? null });
      plan.push({ id, a, n, out });
    }
    let note = '';
    if (ask.length) {
      if (!model) return { error: "Putting the two versions together needs Opie's cloud, which isn't set up here. Yours stays as it is.", kept: true };
      const input = ask.map((x) => `=== ${x.id}/${x.f}\n--- base${x.base == null ? ' (not known)' : ''}\n${x.base ?? ''}\n--- yours${x.yours == null ? ' (removed)' : ''}\n${x.yours ?? ''}\n--- theirs${x.theirs == null ? ' (removed)' : ''}\n${x.theirs ?? ''}`).join('\n\n');
      if (input.length > 300e3) return { error: 'The two versions are too far apart to put together here. Yours stays as it is.', kept: true };
      let r;
      try { r = await model({ instructions: MERGE, input: [{ role: 'user', content: `Files to put together, as "app/file":\n\n${input}` }] }); }
      catch (x) { return { error: `Couldn't put the two versions together right now (${x.message}). Yours stays as it is.`, kept: true }; }
      let ans; try { ans = JSON.parse(textOut(r?.output).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { ans = null; }
      if (!ans?.ok || typeof ans.files !== 'object') return { error: `They couldn't be put together cleanly${ans?.reason ? ': ' + String(ans.reason).slice(0, 200).replace(/\.$/, '') : ''}. Yours stays as it is.`, kept: true };
      for (const x of ask) {
        const v = ans.files[`${x.id}/${x.f}`] ?? (Object.keys(e.apps).length === 1 ? ans.files[x.f] : undefined);
        if (typeof v !== 'string' || v.length > MAX_FILE) return { error: `They couldn't be put together cleanly (${x.f} was missing). Yours stays as it is.`, kept: true };
        plan.find((q) => q.id === x.id).out[x.f] = Buffer.from(v);
      }
      note = String(ans.note || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    }
    for (const q of plan) if (!q.out['index.html']) return { error: `The result has no ${q.n.name} page. Yours stays as it is.`, kept: true };
    return inChange(`Bring ${p.title} ${p.version || p.commit?.slice(0, 7)} into the household's version`, who, by, () => {
      if (plan.some((q) => JSON.stringify(hashes(readFlat(path.join(appsDir, q.id)) || {})) !== before[q.id])) return { error: 'It changed here while the two were being put together. Try again.' };
      const { skip, ...rest } = e;
      const next = { ...rest, commit: p.commit, ...(p.sha256 ? { sha256: p.sha256 } : {}), version: p.version, title: p.title, updated: now(), merged: true, apps: { ...e.apps } };
      for (const q of plan) {
        writeFiles(q.id, q.out);
        // Theirs is the new base, so the household's version still shows as theirs ("Yours, based on …").
        next.apps[q.id] = appEntry(q.n, hashes(q.n.files));
        const kept = (e.apps[q.id]?.chosen || []).filter((c) => (q.n.setupReaches || []).some((x) => x.key === c.key)); // as update() does
        if (kept.length) next.apps[q.id].chosen = kept;
        keepBase(q.id, q.n.files);
      }
      const had = new Set(Object.values(e.apps || {}).map((a) => a.from));
      for (const n of p.apps) if (!had.has(n.id)) {
        const id = freeId(n.id, (x) => fs.existsSync(path.join(appsDir, x)) || x === 'home');
        next.apps[id] = appEntry(n, writeFiles(id, n.files)); keepBase(id, n.files);
      }
      save(name, next);
      return { ok: true, name, version: p.version, note, merged: plan.map((q) => q.id) };
    });
  }

  // ---- every kind: take off, put back ours, take back its latest change ----
  function find(name) {
    const all = readAll(), q = String(name || '').toLowerCase();
    if (all[q]) return { name: q, e: all[q], all };
    const hit = Object.entries(all).find(([, v]) => !(v.kind === 'builtin' && (v.overriddenBy || v.removed)) && ((v.title || '').toLowerCase() === q || Object.keys(v.apps || {}).includes(q)));
    return hit ? { name: hit[0], e: hit[1], all } : null;
  }
  function remove(name, { who = null, by = null } = {}) {
    const f = find(name);
    if (!f || (f.e.kind === 'builtin' && f.e.removed)) return { error: `No plugin called ${name} is on this tablet.` };
    const { e } = f;
    const ids = Object.keys(e.apps || {}).filter((id) => owns(e, id) || e.kind !== 'builtin');
    return inChange(`Remove the ${e.title || f.name} plugin`, who, by, (owner) => {
      for (const id of ids) if (ID.test(id) && id !== 'home') { fs.rmSync(path.join(appsDir, id), { recursive: true, force: true }); dropBase(id); }
      const gone = new Set(ids);
      const tabs = homeScreen.style().tabs;
      if (tabs && tabs.some((t) => gone.has(t.id || t))) { const r = homeScreen.setLook({ tabs: tabs.filter((t) => !gone.has(t.id || t)).map((t) => (typeof t === 'string' || t.name ? t : t.id)) }, owner, who); if (r.error) throw new Error(r.error); }
      if (e.kind === 'builtin') { e.removed = true; save(f.name, e); }
      else {
        drop(f.name);
        const b = e.overrides && f.all[e.overrides];
        if (b) { delete b.overriddenBy; b.removed = true; save(e.overrides, b); }
      }
      return { ok: true, removed: e.title || f.name };
    });
  }
  /** Opie's version of a built-in back in place of the household's (theirs is one undo away), or after it was taken off. */
  function reset(name, { who = null, by = null } = {}) {
    const f = find(name);
    if (!f) return { error: `No plugin called ${name} is on this tablet.` };
    const bname = f.e.kind === 'builtin' ? f.name : f.e.overrides;
    const b = bname && f.all[bname];
    if (!b) return { error: `${f.e.title || f.name} isn't one of Opie's own, so there's no version of ours to go back to.` };
    const id = Object.keys(b.apps || {})[0], s = shipped().find((x) => x.id === id);
    if (!s) return { error: `This tablet doesn't have Opie's ${b.title} to put back.` };
    if (!b.overriddenBy && !b.removed && same(filesOf(path.join(appsDir, id)), s.files)) return { ok: true, already: true, title: b.title };
    return inChange(`Put back Opie's ${b.title}`, who, by, () => {
      const theirs = b.overriddenBy;
      if (theirs) drop(theirs);
      copyApp(s.dir, id);
      const next = { kind: 'builtin', title: s.title, version: s.version, installed: b.installed || now(), updated: now(), apps: { [id]: { files: s.files } } };
      save(bname, next);
      return { ok: true, title: s.title, version: s.version };
    });
  }
  /** The latest change to one plugin's apps, taken back (later changes to other plugins stay). Itself a change. */
  function latestChange(e) {
    const paths = Object.keys(e.apps || {}).map((id) => `apps/${id}`);
    if (!paths.length) return null;
    let log_ = ''; try { log_ = git('log', '-40', '--format=%H%x00%s%x00%b%x1e', '--', ...paths); } catch { return null; }
    const skip = new Set();
    for (const rec of log_.split('\x1e')) {
      const [h, subj, b] = rec.replace(/^\n/, '').split('\0');
      if (!h) continue;
      const rv = String(b || '').match(/This reverts commit ([0-9a-f]{40})/);
      if (rv) { skip.add(rv[1]); continue; }
      // Ours (seeding, our updates, the move) aren't the household's changes: taking one back would empty or roll back
      // an app the next start-up puts right again. reset_plugin and remove_plugin are for those.
      if (skip.has(h) || /^(Starting apps|(?:OpenHouse|Opie) (added|updated)|Apps (became|back from) plugins|Moved to web)/.test(subj)) continue;
      return { commit: h, text: subj };
    }
    return null;
  }
  function undoPlugin(name, by = null) {
    const f = find(name);
    if (!f) return { error: `No plugin called ${name} is on this tablet.` };
    const e = f.e.kind === 'builtin' && f.e.overriddenBy ? f.all[f.e.overriddenBy] : f.e;
    const c = latestChange(e);
    if (!c) return { error: `Nothing to take back in ${e.title || f.name}.` };
    const r = edits.undoChange(c.commit.slice(0, 12), by);
    if (!r.ok) return { error: r.error };
    cache.stamp = null; onChange();
    return { ok: true, title: e.title || f.name, undid: c.text };
  }

  /** Every plugin and where it stands. */
  function installed({ all: every = true } = {}) {
    const ship = new Map(shipped().map((s) => [builtinName(s.id), s.version]));
    return Object.entries(readAll()).filter(([, e]) => every || e.kind === 'shared').map(([name, e]) => {
      const apps = Object.entries(e.apps || {}).map(([id, a]) => {
        const here = filesOf(path.join(appsDir, id));
        const changed = e.kind === 'local' ? false : !same(here, a.files);
        return { id, name: a.name || (here ? appName(id) : id), uses: e.kind === 'shared' ? (a.uses || []) : 'own', reaches: e.kind === 'shared' ? [...(a.reaches || []), ...(a.chosen || []).map((c) => c.host)] : 'own', ...(a.setupReaches?.length ? { setupReaches: a.setupReaches } : {}), changed };
      });
      const state = e.kind === 'builtin' ? (e.removed ? 'taken off' : e.overriddenBy ? `the household's version (${e.overriddenBy}) is used` : 'ours') : e.kind === 'local' ? (e.overrides ? `the household's own, over ${e.overrides}` : "the household's own") : 'from a link';
      // "Yours, based on Laundry 1.0.0": a shared plugin the household changed here, or their version of one of ours.
      const ob = e.kind === 'local' && e.overrides ? readAll()[e.overrides] : null;
      const basedOn = e.kind === 'shared' && (apps.some((a) => a.changed) || e.merged) ? `${e.title || name}${e.version ? ' ' + e.version : ''}`
        : ob ? `${ob.title || e.title}${/^\d+\.\d/.test(e.forkedFrom || ob.version || '') ? ' ' + (e.forkedFrom || ob.version) : ''}` : undefined; // ours without a version number: a content hash, not worth saying
      return { name, kind: e.kind, title: e.title || name, source: e.source || (e.kind === 'builtin' ? 'Opie' : 'made here'), commit: e.commit, version: e.kind === 'local' ? localVersion(e) : e.version,
        reviewed: !!e.reviewed, basedOn, skip: e.skip, ...(e.kind === 'shared' ? (() => { const r = rightsList(Object.entries(e.apps || {}).map(([id, a]) => ({ name: a.name || id, uses: a.uses || [], reaches: a.reaches || [], actions: a.actions, checks: a.checks, background: a.background, screens: a.screens }))); return { rights: r.map((x) => x.text), rightsCard: r }; })() : {}),
        latest: e.kind === 'builtin' && ship.get(name) && ship.get(name) !== e.version ? ship.get(name) : undefined, installed: e.installed || e.created, tabs: e.tabs || [], look: !!e.look, state, overrides: e.overrides, overriddenBy: e.overriddenBy, removed: !!e.removed, apps };
    });
  }
  /** Opie's list, each with whether it's on this tablet (and as what) and whether a newer version is there. */
  async function gallery({ fresh = false } = {}) {
    const entries = await catalog({ fresh }), mine = installed().filter((x) => x.kind === 'shared');
    return entries.map((c) => {
      const here = mine.find((x) => x.source === `catalog:${c.name}`) || mine.find((x) => x.name === c.name);
      return { ...c, installed: here ? { name: here.name, version: here.version, basedOn: here.basedOn } : null,
        update: !!here && (here.source === `catalog:${c.name}`) && c.sha256 !== readAll()[here.name]?.sha256 && here.skip !== c.sha256 };
    });
  }
  /** A plugin from the list or a link, looked at again: is there a newer version, what it asks for that's new, and
   *  whether the household changed it here (then they choose: keep yours, take theirs, or both). */
  async function check(name) {
    const f = find(name);
    if (!f || f.e.kind !== 'shared') return { error: f ? `${f.e.title || f.name} doesn't come from a link: ${f.e.kind === 'builtin' ? 'Opie updates it' : "it's the household's own"}.` : `No plugin called ${name} is on this tablet.` };
    if (String(f.e.source || '').startsWith('catalog:')) await catalog({ fresh: true }); // asked for now: the list as it is now
    const p = await inspect(sourceOf(f.e));
    if (p.name !== f.name.replace(/-\d+$/, '') && p.name !== f.name) return { error: `That link has the ${p.title} plugin now, not ${f.e.title}.` };
    const newer = !(p.sha256 && p.sha256 === f.e.sha256) && !(p.commit && p.commit === f.e.commit && !p.sha256);
    const d = updateDiff(f.name, p);
    const text = [`From ${f.e.version || f.e.commit?.slice(0, 7)} to ${p.version || p.commit?.slice(0, 7)}.`, ...(d.newRights.length ? ['It now also asks for:', ...d.newRights.map((l) => '- ' + l)] : []), 'Everything it may do then:', ...rightsMerged(p.apps).map((l) => '- ' + l)].join('\n');
    return { p, f, newer, changedHere: d.changedHere, newRights: d.newRights, text, rightsCard: [...d.newRights.map((t) => ({ kind: 'new', text: `New: ${t}` })), ...rightsList(p.apps)] };
  }
  /** One fetched version of a plugin, as a hash of everything that would be put in (its files, look and tabs). */
  const contentHash = (p) => sha(JSON.stringify({ name: p.name, commit: p.commit || null, sha256: p.sha256 || null, look: p.look || null, tabs: p.tabs || [],
    apps: p.apps.map((a) => ({ id: a.id, meta: { ...a, files: undefined }, files: Object.keys(a.files).sort().map((k) => [k, sha(a.files[k])]) })) }));
  // What Settings' check showed, by its hash, for a few minutes: its Update puts in exactly that, never a second fetch.
  const CHECKED_MS = 5 * 60e3;
  const checked = new Map(); // hash -> { name, was: { sha256, commit }, p, at }
  function keepChecked(c) {
    const t = Date.now();
    for (const [h, x] of checked) if (t - x.at > CHECKED_MS) checked.delete(h);
    while (checked.size >= 20) checked.delete(checked.keys().next().value);
    const hash = contentHash(c.p);
    checked.set(hash, { name: c.f.name, was: { sha256: c.f.e.sha256 || null, commit: c.f.e.commit || null }, p: c.p, at: t });
    return hash;
  }
  /** The checked version under this hash, while it's fresh and the plugin is still as it was then; else null. */
  function takeChecked(name, hash) {
    const x = checked.get(String(hash || ''));
    if (!x || x.name !== name || Date.now() - x.at > CHECKED_MS) return null;
    const f = find(name);
    if (!f || f.e.kind !== 'shared' || (f.e.sha256 || null) !== x.was.sha256 || (f.e.commit || null) !== x.was.commit) return null;
    return { f, p: x.p };
  }
  /** The tablet's card for an update: what's new, everything it may do then, and where it's from when that isn't
   *  where it came from before (then the PIN, always). */
  function askUpdate(f, p, d, choice, { pin = false, source = null } = {}) {
    const from = f.e.version || f.e.commit?.slice(0, 7), to = p.version || p.commit?.slice(0, 7);
    const moved = !!source && sourceOf({ source: p.src.key || p.src.label }) !== sourceOf(f.e);
    const rights = [...(moved ? [{ kind: 'from', text: p.src.catalog ? `From Opie's list, reviewed, not ${sourceOf(f.e)} as before.` : `From ${p.src.label}, not ${sourceOf(f.e)} as before. Not reviewed for Opie's list.` }] : []),
      ...d.newRights.map((t) => ({ kind: 'new', text: `New: ${t}` })), ...rightsList(p.apps)];
    return approve(`Update ${f.e.title}?`, choice === 'both' ? 'Their new version, with the household\'s changes kept.' : '', pin || moved || d.newRights.length > 0,
      { yes: 'Update', rights, more: [from, to].filter(Boolean).join(' to ') }).then((yes) => ({ yes, moved }));
  }
  /** One of the household's choices for an update: 'theirs' (replaces their changes), 'both' (merge), 'keep' (skip it). */
  async function choose(name, p, choice, ctx) {
    if (choice === 'keep') return keepOurs(name, p);
    if (choice === 'both') return merge(name, p, ctx);
    return update(name, p, { ...ctx, keepTheirs: false });
  }

  /** The plugins a commit touched, in a line: what done_editing says. */
  function describe(ids) {
    const all = readAll();
    return [...new Set([...ids].map((id) => ownerOf(id, all)).filter(Boolean).map(({ name, e }) => `${e.title || name} (${e.kind === 'local' ? "the household's own" : e.kind === 'shared' ? 'from a link' : "Opie's"}, version ${e.kind === 'local' ? localVersion(e) : e.version})`))].join(', ');
  }

  // ---- voice actions: declared by an app (app.json "actions"), done by its page ----
  function actionsOf(id, e) {
    if (e.kind === 'shared') return (e.apps[id]?.actions || []).filter((a) => { try { return cleanActions([a]).length === 1; } catch { return false; } }); // what the card showed (an edit can't add one); one added before the limits, over them, is left out
    try { return cleanActions(appMeta(path.join(appsDir, id)).actions); } catch { return []; }
  }
  /** A shared app's heartbeat checks, as its card showed them (null: the family's own or ours, read live from app.json). */
  function checksOf(id) { const o = ownerOf(id); return o?.e.kind === 'shared' ? o.e.apps[id]?.checks || [] : null; }
  const toolName = (id, a) => `${id.replace(/-/g, '_')}__${a}`.slice(0, 64);
  function voiceActions() {
    const out = [], all = readAll();
    for (const id of appIds()) {
      const o = ownerOf(id, all); if (!o) continue;
      for (const a of actionsOf(id, o.e)) out.push({ id, a, name: toolName(id, a.name), title: appName(id), shared: o.e.kind === 'shared' });
    }
    return out;
  }
  /** The voice's tools from plugins (live-tools.js): {name, description, inputSchema}. */
  const voiceTools = () => voiceActions().map((x) => ({ name: x.name, description: `${x.title}: ${x.a.description}`, inputSchema: x.a.parameters }));
  /** One asked for: into the app's inbox (appdata/<id>/actions.json), which its page reads with the kit's onAction. */
  async function callVoice(name, args) {
    const x = voiceActions().find((v) => v.name === name);
    if (!x) return { text: `${name} isn't one of the apps' voice actions.`, isError: true };
    let clean; try { clean = actionArgs(x.a, args); } catch (e) { return { text: e.message, isError: true }; }
    if (!DATA) return { text: "The apps can't take voice actions here.", isError: true };
    const f = path.join(DATA, x.id, 'actions.json');
    let box = { next: 1, items: [] }; try { const v = readJson(f); if (v && Array.isArray(v.items)) box = v; } catch {}
    const id = box.next;
    box.items = [...box.items, { id, action: x.a.name, args: clean, at: now(), ...(x.a.answer ? { answer: true } : {}) }].slice(-20); box.next += 1;
    fs.mkdirSync(path.dirname(f), { recursive: true }); storeJson(f, box, { bak: false }); // (an app's data folder: no .bak among its files)
    if (x.a.open) (homeScreen.showApp || homeScreen.showTab)?.(x.id); // its tab, or (not a tab) its own window (home-screen.js showApp)
    // What the app says (its reply in app.json, or what its page answers) is its words, not ours: `said` marks it, and
    // the voice (live-tools.js) hands it to the model as data (as-data.js). An app's page can hold anyone's words (a
    // recipe's, a web page's), and an app from a link is someone else's code. text: the same, for /apps/ask.
    const words = (t) => { const w = x.shared ? t.replace(/\s+/g, ' ').trim().slice(0, 300) : t; return { text: w, said: w, app: x.title, shared: x.shared, isError: false }; };
    if (!x.a.answer) return x.a.reply ? words(x.a.reply) : { text: `Asked ${x.title} to do that.`, isError: false };
    // Its page answers (the kit's onAction writes appdata/<app>/replies.json): what it says is what the voice says.
    const said = await replyFrom(x.id, id, x.a.wait ? x.a.wait * 1000 : answerWaitMs);
    if (said != null) return words(said);
    return x.a.reply ? words(x.a.reply) : { text: `${x.title} didn't answer: it may not be open.`, isError: true };
  }
  /** An app page's answer to one of its voice actions, waited for a little (null if none came). */
  async function replyFrom(app, id, ms) {
    const f = path.join(DATA, app, 'replies.json'), until = Date.now() + ms;
    for (;;) {
      try { const r = readJson(f)?.items?.find((i) => i.id === id); if (r) return String(r.text ?? '').slice(0, 2000); } catch {}
      if (Date.now() > until) return null;
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  /** A folder's worth of files for a plugin made from the household's own apps (export_plugin): sharing one. */
  function exportFiles({ name, apps = [], description = '', look = false, plugin = null }) {
    let version = '1.0.0';
    if (plugin) {
      const f = find(plugin);
      if (!f || (f.e.kind === 'builtin' && (f.e.removed || f.e.overriddenBy))) throw new Error(`No plugin ${plugin}.`);
      apps = Object.keys(f.e.apps || {}); name ||= f.name; description ||= f.e.description || '';
      version = f.e.kind === 'local' ? localVersion(f.e) : (f.e.version || version);
    }
    const pname = String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (!ID.test(pname)) throw new Error('Give it a name: lowercase letters, digits and dashes.');
    const out = {}, warn = [], ids = list(apps) || [];
    if (!ids.length && !look) throw new Error('Which apps? Give their ids, or a plugin.');
    const h = household() || {};
    const words = [...(h.family || []).map((f) => f?.name), ...String(h.location || '').split(',').map((x) => x.trim()), h.assistant].filter((w) => typeof w === 'string' && w.trim().length >= 3).map((w) => w.trim());
    for (const id of ids) {
      if (!ID.test(id) || id === 'home' || !fs.existsSync(path.join(appsDir, id, 'index.html'))) throw new Error(`No app ${id}.`);
      for (const f of fs.readdirSync(path.join(appsDir, id))) {
        const p = path.join(appsDir, id, f);
        if (!fs.statSync(p).isFile() || !FILE.test(f)) continue;
        if (!TEXT.test(f)) { warn.push(`apps/${id}/${f} isn't text, so it's left out: copy it into the folder yourself.`); continue; }
        const text = fs.readFileSync(p, 'utf8');
        out[`apps/${id}/${f}`] = text;
        text.split('\n').forEach((line, i) => { for (const w of words) if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(line)) warn.push(`apps/${id}/${f}:${i + 1} has "${w}" (this family's): make it general before sharing?`); });
      }
    }
    const oh = { apps: ids.map((id) => `apps/${id}`) };
    if (look) { const st = homeScreen.style(); out['looks/look.json'] = JSON.stringify(Object.fromEntries(LOOK_KEYS.filter((k) => st[k] !== undefined).map((k) => [k, st[k]])), null, 2) + '\n'; oh.looks = ['looks/look.json']; }
    out['package.json'] = JSON.stringify({ name: pname, version, description: String(description).slice(0, 300), keywords: ['openhouse-plugin', 'pi-package'], openhouse: oh }, null, 2) + '\n';
    if (!out['README.md']) out['README.md'] = `# ${pname}\n\n${description || 'An Opie plugin.'}\n\nAdd it to an Opie tablet: ask the assistant to "add the plugin from <this repo's link>".\n`;
    return { files: out, warnings: warn.slice(0, 30) };
  }

  const images = new Map();

  // ---- the tools: the assistant's and a computer's (homeScreen.addTools; the workshop adds export_plugin) ----
  const SRC = { type: 'string', description: "The name of a plugin on Opie's list (find_plugins), or where it comes from, as the family gave it: a git link (github.com/someone/thing, optionally @version) or an https link to a .tgz." };
  const NAME = { type: 'string', description: 'The plugin\'s name or title, or one of its app ids (list_plugins).' };
  const tools = [
    { name: 'find_plugins', description: "The plugins on Opie's reviewed list (its gallery): each with its name, what it does, what it may use, and whether it's on this tablet. For \"what plugins are there?\" or finding one by what it does. Add one with add_plugin and its name.", inputSchema: { type: 'object', properties: {} } },
    { name: 'look_at_plugin', description: "See what a plugin (something another family made: apps, a look) has in it before adding it: its apps, what each may use of the family's things and which sites it may reach. Say it back in a sentence or two, then add it with add_plugin if they want it.", inputSchema: { type: 'object', required: ['source'], properties: { source: SRC } } },
    { name: 'add_plugin', description: 'Add a plugin to this tablet. Someone says yes on the tablet first (with the PIN); this waits for them, up to a minute and a half. Its apps go in Apps, and the tabs it suggests are added unless tabs is false.', inputSchema: { type: 'object', required: ['source'], properties: { source: SRC, tabs: { type: 'boolean', description: 'Add the tabs it suggests (default yes).' } } } },
    { name: 'update_plugin', description: "Bring a plugin from a link or Opie's list up to its newest version (or source, a pinned version). Someone says yes on the tablet first (with the PIN when it asks for more). If the household changed its app here, it says so: then ask which they want and call again with choice: keep (theirs stays, this update is skipped), theirs (the new version replaces their changes), or both (the new version's changes put onto theirs; if that can't be done cleanly, theirs stays).", inputSchema: { type: 'object', required: ['name'], properties: { name: NAME, source: SRC, choice: { type: 'string', enum: ['keep', 'theirs', 'both'] }, replace: { type: 'boolean', description: 'The same as choice theirs.' } } } },
    { name: 'list_plugins', description: "Everything that adds apps to this tablet, as plugins: Opie's own (Calendar, Chores…), the household's own (each app made here is one), and ones from a link. Each with its version, where it came from, and whether the household's version is used over ours.", inputSchema: { type: 'object', properties: {} } },
    { name: 'remove_plugin', description: 'Take a plugin off this tablet: its apps and the tabs it added. Someone says yes on the tablet first.', inputSchema: { type: 'object', required: ['name'], properties: { name: NAME } } },
    { name: 'undo_plugin', description: 'Take back the latest change to one plugin (one app), keeping later changes to the others. Itself a change, so it can be undone too.', inputSchema: { type: 'object', required: ['name'], properties: { name: NAME } } },
    { name: 'reset_plugin', description: "Put Opie's own version of a built-in app (Calendar, Chores…) back in place of the household's changed one, or after it was taken off. Their version is one undo away.", inputSchema: { type: 'object', required: ['name'], properties: { name: NAME } } },
  ];
  const ok = (t) => ({ content: [{ type: 'text', text: t }] });
  const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
  const cantAsk = 'Someone has to say yes on the tablet, and this tablet can\'t ask right now.';
  async function call(name, a = {}, ctx = null) {
    const who = ctx?.who || null, by = ctx?.turn || null;
    try {
      if (name === 'look_at_plugin') return ok(asData(summary(await inspect(a.source)), "what a plugin is and may do, made from its own files (its names, descriptions and voice actions are its author's words)")); // to a model: data
      if (name === 'find_plugins') {
        const g = await gallery();
        return ok(g.length ? g.map((c) => `${c.name} ("${c.title}"${c.version ? ' ' + c.version : ''})${c.installed ? (c.installed.basedOn ? ': on this tablet, changed here' : ': on this tablet') + (c.update ? ', a newer version is out' : '') : ''}: ${c.description} ${c.rights.join(' ')}`).join('\n') : "Opie's list of plugins is empty right now.");
      }
      if (name === 'list_plugins') {
        const all = installed().filter((p) => !p.removed);
        return ok(all.length ? all.map((p) => `${p.name} ("${p.title}", ${p.kind}${p.version ? ' ' + p.version : ''}${p.latest ? ', ' + p.latest + ' available' : ''}) ${p.state}${p.kind === 'shared' ? ' from ' + p.source : ''}: ${p.apps.map((x) => `${x.id}${x.changed ? ' (changed here since)' : ''}`).join(', ') || 'a look'}`).join('\n') : 'No plugins on this tablet.');
      }
      if (name === 'add_plugin') {
        const p = await inspect(a.source);
        if (readAll()[p.name]?.kind === 'shared') return err(`The ${p.title} plugin is already on this tablet: update_plugin brings a newer version.`);
        if (!approve) return err(cantAsk);
        const yes = await approve(`Add ${p.title}?`, '', true, { yes: 'Add', ...card(p, { already: false }) });
        if (yes === null) return err(cantAsk);
        if (!yes) return err('Not added: someone said no, or nobody answered.');
        const r = put(p, { tabs: a.tabs !== false, who, by });
        return r.error ? err(r.error) : ok(`Added ${p.title}: ${r.apps.length ? 'apps ' + r.apps.join(', ') : 'its look'}${r.tabs.length ? '; tabs ' + r.tabs.join(', ') : ''}.`);
      }
      if (name === 'update_plugin') {
        const f = find(a.name);
        if (!f || f.e.kind !== 'shared') return err(f ? `${f.e.title || f.name} doesn't come from a link: ${f.e.kind === 'builtin' ? 'Opie updates it' : "it's the household's own"}.` : `No plugin called ${a.name} is on this tablet.`);
        const c = a.source ? null : await check(f.name);
        if (c?.error) return err(c.error);
        const p = c ? c.p : await inspect(a.source);
        if (p.name !== f.name.replace(/-\d+$/, '') && p.name !== f.name) return err(`That link has the ${p.title} plugin, not ${f.e.title}.`);
        if ((p.sha256 && p.sha256 === f.e.sha256) || (!p.sha256 && p.commit && p.commit === f.e.commit)) return ok(`${f.e.title} is already the newest (${f.e.version || p.commit.slice(0, 7)}).`);
        const d = updateDiff(f.name, p);
        const choice = a.choice || (a.replace ? 'theirs' : d.changedHere.length ? null : 'theirs');
        if (!choice) return err(`${d.changedHere.join(', ')} changed here since it was added, so it's the household's version (based on ${f.e.title} ${f.e.version || ''}). Ask which they want: keep theirs and skip this update, take the new version instead of their changes, or both (the new version's changes put onto theirs). Then update_plugin with choice keep, theirs or both.`);
        if (choice === 'keep') { const r = keepOurs(f.name, p); return r.error ? err(r.error) : ok(`Kept the household's ${f.e.title}; ${p.version || 'this version'} is skipped.`); }
        if (!approve) return err(cantAsk);
        const { yes, moved } = await askUpdate(f, p, d, choice, { source: a.source || null });
        if (yes === null) return err(cantAsk);
        if (!yes) return err('Not updated: someone said no, or nobody answered.');
        const r = await choose(f.name, p, choice, { who, by, ...(moved ? { source: p.src } : {}) });
        if (r.error) return err(r.error);
        return ok(choice === 'both' ? `Put ${p.title} ${r.version || ''}'s changes onto the household's version${r.note ? ': ' + r.note : '.'}` : `Updated ${f.e.title} to ${r.version || 'the newest'}.`);
      }
      if (name === 'remove_plugin') {
        const e = installed().find((p) => !p.removed && (p.name === a.name || p.title.toLowerCase() === String(a.name || '').toLowerCase() || p.apps.some((x) => x.id === a.name)));
        if (!e) return err(`No plugin called ${a.name} is on this tablet.`);
        if (!approve) return err(cantAsk);
        const yes = await approve(`Remove ${e.title}?`, e.apps.length > 1 || e.apps[0]?.name !== e.title ? `With ${e.apps.map((x) => x.name).join(', ')}.` : '', false, { yes: 'Remove', danger: true });
        if (yes === null) return err(cantAsk);
        if (!yes) return err('Left as it is: someone said no, or nobody answered.');
        const r = remove(e.name, { who, by });
        return r.error ? err(r.error) : ok(`Took off ${r.removed}.`);
      }
      if (name === 'undo_plugin') { const r = undoPlugin(a.name, by); return r.error ? err(r.error) : ok(`Took back in ${r.title}: ${r.undid}`); }
      if (name === 'reset_plugin') {
        const r = reset(a.name, { who, by });
        return r.error ? err(r.error) : ok(r.already ? `${r.title} is already Opie's own.` : `Opie's ${r.title} (${r.version}) is back.`);
      }
    } catch (e) { return err(e.message); }
    return err(`unknown tool ${name}`);
  }

  async function handle(req, res, url) {
    // One of the household's own apps (or ours) asking another to do one of its voice actions: the Meals app's Cook
    // opens the Recipes app on that recipe. Only those apps reach it (apps.js 'own').
    if (req.method === 'POST' && url.pathname === '/apps/ask') {
      const b = await body(req), app = String(b.app || ''), action = String(b.action || '');
      if (!voiceActions().some((v) => v.id === app && v.a.name === action)) { json(res, 404, { error: `${app || 'That app'} has no ${action || 'such'} action.` }); return true; }
      const r = await callVoice(toolName(app, action), b.args && typeof b.args === 'object' ? b.args : {});
      json(res, r.isError ? 400 : 200, r.isError ? { error: r.text } : { ok: true, text: r.text }); return true;
    }
    if (!url.pathname.startsWith('/plugins')) return false;
    // Settings lists the ones from a link; ?all=1 every plugin (ours and the household's too).
    // Settings lists the ones from a link and the household's versions of ours; ?all=1 every plugin.
    if (req.method === 'GET' && url.pathname === '/plugins') {
      const every = url.searchParams.get('all') === '1';
      let ps = installed({ all: true }).filter((x) => every || x.kind === 'shared' || (x.kind === 'local' && x.overrides));
      // A newer version on Opie's list, when the list is at hand (it's only fetched when someone opens the gallery).
      if (cat.entries) ps = ps.map((x) => { const c = cat.entries.find((y) => x.source === `catalog:${y.name}`); return c && c.sha256 !== readAll()[x.name]?.sha256 && x.skip !== c.sha256 ? { ...x, update: c.version } : x; });
      json(res, 200, { plugins: ps }); return true;
    }
    if (req.method === 'GET' && url.pathname === '/plugins/gallery') {
      try { json(res, 200, { plugins: await gallery({ fresh: url.searchParams.get('fresh') === '1' }) }); } catch (e) { json(res, 200, { plugins: [], error: e.message }); }
      return true;
    }
    // A plugin's picture on the list, from the list's own host only (cleanCatalog), for Settings to show.
    if (req.method === 'GET' && url.pathname === '/plugins/gallery/image') {
      const c = (cat.entries || []).find((x) => x.name === url.searchParams.get('name'));
      if (!c?.image) { json(res, 404, { error: 'no picture' }); return true; }
      try {
        if (!images.has(c.image)) {
          const r = await fetchImpl(c.image, { signal: AbortSignal.timeout(15e3), redirect: 'error' });
          const b = Buffer.from(await r.arrayBuffer());
          if (!r.ok || b.length > 2e6) throw new Error('no picture');
          images.set(c.image, { b, type: /\.png$/i.test(c.image) ? 'image/png' : /\.webp$/i.test(c.image) ? 'image/webp' : 'image/jpeg' });
        }
        const im = images.get(c.image);
        res.writeHead(200, { 'content-type': im.type, 'cache-control': 'max-age=3600' }); res.end(im.b);
      } catch { json(res, 404, { error: 'no picture' }); }
      return true;
    }
    if (req.method !== 'POST') return false;
    const b = await body(req);
    try {
      if (url.pathname === '/plugins/inspect') { const p = await inspect(b.source); json(res, 200, { name: p.name, title: p.title, text: summary(p), ...card(p), already: readAll()[p.name]?.kind === 'shared' }); return true; }
      // Settings' Add: the same card as add_plugin, made from exactly what is put in (a person's own tap, the PIN when
      // it's on), so what someone says yes to is what's added.
      if (url.pathname === '/plugins/install') {
        const p = await inspect(b.source);
        if (readAll()[p.name]?.kind === 'shared') { json(res, 200, { already: true, name: p.name, title: p.title }); return true; }
        const yes = approve ? await approve(`Add ${p.title}?`, '', true, { yes: 'Add', ...card(p, { already: false }) }) : null;
        if (yes === null) { json(res, 409, { error: cantAsk }); return true; }
        if (!yes) { json(res, 200, { declined: true, title: p.title }); return true; }
        const r = put(p, { tabs: b.tabs !== false, who: 'someone' }); json(res, r.error ? 409 : 200, { title: p.title, ...r }); return true;
      }
      // An update from Settings: what it is first (check), then the household's choice (update).
      if (url.pathname === '/plugins/check') {
        const c = await check(String(b.name || ''));
        json(res, c.error ? 409 : 200, c.error ? c : { name: c.f.name, title: c.f.e.title, from: c.f.e.version, version: c.p.version, newer: c.newer, changedHere: c.changedHere, newRights: c.newRights, text: c.text, rights: c.rightsCard, basedOn: `${c.f.e.title} ${c.f.e.version || ''}`.trim(), ...(c.newer ? { hash: keepChecked(c) } : {}) });
        return true;
      }
      // Settings' Update: exactly the version its check fetched (by hash), never another fetch, behind the same card
      // as Add (a person's tap, with the PIN), showing what's new. Keeping the household's own version asks nothing.
      if (url.pathname === '/plugins/update') {
        const name = String(b.name || ''), c = takeChecked(name, b.hash);
        if (!c) { json(res, 409, { error: 'That update needs looking at again: check for it once more.', again: true }); return true; }
        const choice = ['keep', 'theirs', 'both'].includes(b.choice) ? b.choice : 'theirs';
        const d = updateDiff(c.f.name, c.p);
        if (d.changedHere.length && !b.choice) { json(res, 409, { error: 'Changed here: choose keep, theirs or both.', changedHere: d.changedHere }); return true; }
        if (choice !== 'keep') {
          const { yes } = approve ? await askUpdate(c.f, c.p, d, choice, { pin: true }) : { yes: null };
          if (yes === null) { json(res, 409, { error: cantAsk }); return true; }
          if (!yes) { json(res, 200, { declined: true, title: c.f.e.title }); return true; }
        }
        const r = await choose(c.f.name, c.p, choice, { who: 'someone' });
        if (!r.error) checked.delete(String(b.hash));
        json(res, r.error ? 409 : 200, r); return true;
      }
      if (url.pathname === '/plugins/remove') { const r = remove(String(b.name || ''), { who: 'someone' }); json(res, r.error ? 409 : 200, r); return true; }
      if (url.pathname === '/plugins/reset') { const r = reset(String(b.name || ''), { who: 'someone' }); json(res, r.error ? 409 : 200, r); return true; }
      if (url.pathname === '/plugins/undo') { const r = undoPlugin(String(b.name || '')); json(res, r.error ? 409 : 200, r); return true; }
    } catch (e) { json(res, 400, { error: e.message }); return true; }
    return false;
  }

  return { handle, tools, call, card, rightsOf, frozenOf, madeHere, unmake, limited, askReach, forgetReach, inspect, put, update, merge, keepOurs, gallery, check, remove, reset, undoPlugin, installed, describe, exportFiles, summary, reconcile, migrate, unmigrate, syncBuiltins, start, readAll, ownerOf: (id) => ownerOf(id), checksOf, reachesOf, voiceTools, callVoice, DIR, MARK };
}

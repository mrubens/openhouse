// Fixes waiting for whoever builds (docs/heartbeat.md, "Fixing an app"). Apps are plugins now, so the heartbeat doesn't
// change an app's code itself: it writes down what broke ("Chores is broken: here's the error and the log") and the
// household's Claude or Codex sees it through the workshop MCP (pending_fixes), fixes it in an ordinary change opened
// with start_editing {fix}, and the change goes in only after a yes on the tablet's PIN card. One undo.
//
// file: heartbeat-fixes.json next to the chats. A fix: { id, app, name, errors: [text], log: [{at, text}], changes:
// [recent changes], at, seen (the last time the app threw), status: pending | working | done | dismissed, by?, sha? }
import fs from 'node:fs';
import { readJson, writeJson } from './store.js';
import { registered } from './stores.js';
import path from 'node:path';

const KEEP = 30;

export function fixQueue({ DIR, now = () => Date.now() }) {
  const FILE = registered('heartbeat-fixes', path.join(DIR, '../heartbeat-fixes.json'));
  let list = readJson(FILE, []); if (!Array.isArray(list)) list = [];
  const save = () => { try { writeJson(FILE, list); } catch {} };
  const open = () => list.filter((f) => f.status === 'pending' || f.status === 'working');

  /** An app is broken: a fix waits (one per app; the same app breaking again adds to its log). */
  function add({ app, name, errors = [], log = [], changes = [] }) {
    const t = now();
    let f = open().find((x) => x.app === app);
    if (f) {
      f.errors = [...new Set([...f.errors, ...errors])].slice(-5);
      f.log = [...f.log, ...log].slice(-20);
      f.seen = t;
      save();
      return { fix: f, fresh: false };
    }
    f = { id: `fix-${t.toString(36)}`, app, name: name || app, errors: [...new Set(errors)].slice(-5), log: log.slice(-20), changes: changes.slice(0, 5), at: t, seen: t, status: 'pending' };
    list = [f, ...list].slice(0, KEEP);
    save();
    return { fix: f, fresh: true };
  }
  const get = (id) => list.find((f) => f.id === id) || null;
  function set(id, patch) { const f = get(id); if (!f) return null; Object.assign(f, patch, { updated: now() }); save(); return f; }

  const describe = (f) => `${f.id}: ${f.name} (apps/${f.app}) is broken, noticed ${new Date(f.at).toISOString()}${f.status === 'working' ? `, being fixed by ${f.by || 'someone'}` : ''}.\n` +
    `Errors:\n${f.errors.map((e) => `- ${e}`).join('\n')}\n` +
    (f.log.length ? `What the page reported (latest last):\n${f.log.map((l) => `- ${new Date(l.at).toISOString()} ${l.text}`).join('\n')}\n` : '') +
    (f.changes.length ? `Recent changes on the tablet (newest first):\n${f.changes.map((c) => `- ${c.id} ${c.when}: ${c.change}`).join('\n')}\n` : '');

  // The workshop's tools (and the tablet assistant's, while it still has one): see what's waiting, and close one.
  const tools = [
    { name: 'pending_fixes', description: "Apps the tablet noticed are broken, waiting for someone to fix them: each with its id, the errors and the log. To fix one: start_editing with its fix id, read the app, make the smallest change that fixes the cause, check_build, then done_editing. Someone says yes on the tablet before it goes in.",
      inputSchema: { type: 'object', properties: {} } },
    { name: 'close_fix', description: "Close a waiting fix without changing the app: \"dismissed\" (it isn't broken, or not worth fixing) or \"done\" (it was fixed some other way).",
      inputSchema: { type: 'object', required: ['id', 'status'], properties: { id: { type: 'string' }, status: { type: 'string', enum: ['done', 'dismissed'] } } } },
  ];
  async function call(name, a, context) {
    const ok = (t) => ({ content: [{ type: 'text', text: t }] }), err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
    if (name === 'pending_fixes') { const o = open(); return ok(o.length ? o.map(describe).join('\n') : 'Nothing is waiting to be fixed.'); }
    if (name === 'close_fix') {
      const f = get(String(a.id || ''));
      if (!f || !['pending', 'working'].includes(f.status)) return err(`No waiting fix ${a.id}.`);
      if (!['done', 'dismissed'].includes(a.status)) return err('status: done or dismissed');
      set(f.id, { status: a.status, by: context?.who || f.by || null });
      return ok(`Closed ${f.id} (${a.status}).`);
    }
    return err(`unknown tool ${name}`);
  }
  return { add, get, set, open, list: () => list, describe, tools, call };
}

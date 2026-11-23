// Scripted stand-in agent for testing the loop without an AI login (AGENT=fake).
// Emits the same event shapes as a real adapter and makes a small visible CSS change.
//
// chat() (a conversation turn) follows steps written in what was said, in order, e.g.
//   "make it blue [edit:apps/a/x.txt=blue] [wait:300] [note:Blue] [progress:half way] [end]"
//   [edit:path=text]   append text to that file in the app folder, reported as an edit (like Edit/Write)
//   [sh:path=text]     the same, not reported (like a shell command): only the file watcher sees it
//   [wait:ms]          wait (stops early when the turn is stopped)
//   [start_editing] [note:title] [progress:text] [end] [undo:id]   the door tools, as this turn
//   [fail]  return not ok      [throw]  throw
import fs from 'node:fs';
import path from 'node:path';

const wait = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }); });

export async function run({ prompt, cwd, signal, onEvent }) {
  onEvent({ kind: 'phase', name: 'init', model: 'fake' });
  for (const w of "I'll tint the screen to prove the loop works. ".split(' ')) {
    onEvent({ kind: 'delta', text: w + ' ' });
    await wait(40);
  }
  const file = path.join(cwd, 'src/theme.css');
  onEvent({ kind: 'tool', id: 't1', name: 'Read', detail: 'src/theme.css' });
  await wait(Number(process.env.FAKE_RUN_MS || 300), signal);
  onEvent({ kind: 'tool-done', id: 't1', name: 'Read', ok: true });
  if (signal?.aborted) return { ok: false, text: 'Cancelled' };
  onEvent({ kind: 'tool', id: 't2', name: 'Edit', detail: 'src/theme.css' });
  const hue = Math.floor(Math.random() * 360);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `\n/* fake agent: ${prompt.split('\n')[0].slice(0, 60)} */\n.card { border-color: hsl(${hue} 70% 50%); border-width: 4px; }\n`);
  await wait(100);
  onEvent({ kind: 'tool-done', id: 't2', name: 'Edit', ok: true });
  return { ok: true, text: `Tinted the card borders (hue ${hue}). This was the test agent, not an AI.` };
}


async function doorTool(name, args, token) {
  const r = await fetch(process.env.DOOR_MCP_URL, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token || process.env.DOOR_MCP_TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await r.json();
  return j.result?.content?.[0]?.text || JSON.stringify(j);
}

export async function chat({ prompt, signal, onEvent, doorToken }) {
  const said = prompt.split('\n')[0].replace(/^.*? says: /, '');
  const dir = process.env.OPENHOUSE_APP_DIR;
  onEvent({ kind: 'session', id: 'fake-session' });
  const out = [];
  for (const [, step, arg = ''] of said.matchAll(/\[(\w+)(?::(.*?))?\](?=\s|$)/g)) {
    if (signal?.aborted) return { ok: false, text: 'Stopped' };
    if (step === 'wait') await wait(Number(arg) || 0, signal);
    else if (step === 'edit' || step === 'sh') {
      const [p, ...t] = arg.split('='); const f = path.join(dir, p);
      if (step === 'edit') onEvent({ kind: 'edit', paths: [f] });
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, t.join('=') + '\n');
    } else if (step === 'start_editing') out.push(await doorTool('start_editing', {}, doorToken));
    else if (step === 'note') out.push(await doorTool('put_note', { title: arg, content: `${arg}.`, size: 'small', minutes: 5 }, doorToken));
    else if (step === 'progress') out.push(await doorTool('progress', { text: arg }, doorToken));
    else if (step === 'end') out.push(await doorTool('end_conversation', {}, doorToken));
    else if (step === 'undo') out.push(await doorTool('undo_change', { id: arg }, doorToken));
    else if (step === 'fail') return { ok: false, text: 'It went wrong (on purpose).' };
    else if (step === 'throw') throw new Error('thrown on purpose');
  }
  if (signal?.aborted) return { ok: false, text: 'Stopped' };
  const text = `Done: ${said.replace(/\[.*?\]/g, '').trim()}${out.length ? ` (${out.join(' | ')})` : ''}`;
  onEvent({ kind: 'message', text });
  return { ok: true, text, sessionId: 'fake-session' };
}

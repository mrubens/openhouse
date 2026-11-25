// The heartbeat without an agent (heartbeat.js's judge path, heartbeat-judge.js, heartbeat-checks.js,
// heartbeat-fixes.js, docs/heartbeat.md): the decision model and the text model are stand-ins here; the home screen is real.
//   cd bridge && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { heartbeat, JUDGE_CAPS } from '../heartbeat.js';
import { homeScreenRoutes } from '../home-screen.js';
import { fixQueue } from '../heartbeat-fixes.js';
import { thingStore } from '../things.js';
import { workshopRoutes } from '../workshop.js';

const at = (h, m = 0, plus = 0) => +new Date(2026, 10, 17 + plus, h, m);
const iso = (t) => new Date(t).toISOString();
const clash = () => [
  { id: 'e1', title: 'Piano', who: 'Maya', start: iso(at(16, 0, 1)), end: iso(at(17, 0, 1)) },
  { uid: 'g7', title: 'Soccer', who: 'Maya', start: iso(at(16, 30, 1)), end: iso(at(18, 0, 1)) },
];

/** What the stand-in decision model says about every finding. */
const says = ({ worth = 0.9, act = 'notice', who = 'Maya' } = {}) => (input, qs) => ({
  answers: qs.map((q) => q.type === 'predicate' ? { type: 'predicate', name: q.name, probability: worth }
    : q.name.startsWith('act_') ? { type: 'choice', name: q.name, choice: act, confidence: 0.9 } : { type: 'choice', name: q.name, choice: who, confidence: 0.9 }),
});
/** A stand-in text model: first a tool call (if given), then one line. */
const writes = (call, line = 'DID: noted it') => {
  const seen = [];
  const ai = async (q) => {
    seen.push(q);
    const last = q.input[q.input.length - 1];
    if (call && last.role === 'user') return { output: [{ type: 'function_call', call_id: 'c1', name: call.name, arguments: JSON.stringify(call.args) }], usage: { input_tokens: 3000, output_tokens: 80 } };
    return { output: [{ type: 'message', content: [{ type: 'output_text', text: line }] }], usage: { input_tokens: 3200, output_tokens: 20 } };
  };
  return Object.assign(ai, { seen });
};

function setup({ events = [], errors = [], level, decide = says(), ai = writes({ name: 'show_thing', args: { text: 'Maya: piano and soccer overlap Wednesday', until: '2026-11-18T13:00' } }), ready = true, night = { from: '21:30', to: '06:30' }, extraChecks = null, review = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-judge-')), DIR = path.join(root, 'chats');
  fs.mkdirSync(DIR);
  const homeScreen = homeScreenRoutes({ DIR, json: () => {}, body: async () => ({}), edits: null, APP_DIR: root });
  let clock = at(14);
  const decided = [];
  const judge = { name: 'cloud', ready: () => ready, decide: async (i, q) => { decided.push({ input: i, questions: q }); if (decide instanceof Error) throw decide; return decide(i, q); }, ai };
  const fixes = fixQueue({ DIR, now: () => clock });
  homeScreen.addTools(fixes.tools, fixes.call);
  const things = thingStore({ DIR, now: () => clock });
  things.setFixes(() => fixes.open());
  const state = { events, errors };
  const hb = heartbeat({ DIR, HERE: root, homeScreen, house: { view: () => ({ events: state.events, meals: {}, mealSlots: ['dinner'], night, family: [{ name: 'Maya' }, { name: 'Leo' }] }) },
    board: { household: () => 'Family: Maya (9), Leo (6)', householdView: () => ({ calendars: [], calendar: {}, family: [{ name: 'Maya' }, { name: 'Leo' }] }), prefs: () => '' },
    appErrors: () => state.errors,
    now: () => clock, freeBytes: () => 50e9, every: 0, judge, fixes, things, extraChecks, review });
  if (level) hb.state.level = level;
  const shown = () => things.all({}).map((x) => x.text); // the things on Home
  const notes = () => homeScreen.describe().split('\n').filter((l) => l.startsWith('- n-'));
  return { hb, homeScreen, notes, shown, things, decided, fixes, state, root, later: (ms) => { clock += ms; }, set: (t) => { clock = t; } };
}

test('a day\'s spending cap holds the judge', async () => {
  const s = setup({ events: clash() });
  fs.writeFileSync(path.join(s.root, 'chats.jsonl'), JSON.stringify({ at: iso(at(9)), background: 'heartbeat', usage: { cost: JUDGE_CAPS.cost } }) + '\n');
  assert.deepEqual(await s.hb.beat(), { skipped: 'cap' });
  assert.equal(s.decided.length, 0);
});

test('the workshop fixes a waiting fix: it goes in only after someone\'s yes on the tablet', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ws-'));
  fs.mkdirSync(path.join(root, 'chats')); fs.mkdirSync(path.join(root, 'apps/chores'), { recursive: true });
  const fixes = fixQueue({ DIR: path.join(root, 'chats') });
  const { fix } = fixes.add({ app: 'chores', name: 'Chores', errors: ['TypeError'] });
  const ended = []; let answer = false; const asked = [];
  const edits = { begin: (o) => ({ id: `t${ended.length}`, ...o, started: 0 }), startEditing: async () => ({ ok: true }), end: (t, ok) => { ended.push(ok); return ok ? 'abc1234def' : null; }, tryAcquire: () => true, listChanges: () => [] };
  const homeScreen = { tools: () => [], call: async () => ({ content: [{ type: 'text', text: '' }] }), computerNote: () => {}, style: () => ({}), describe: () => '' };
  const handle = workshopRoutes({ HERE: root, APP_DIR: root, homeScreen, edits, fixes, approve: async (title, detail, pin) => { asked.push({ title, pin }); return answer; },
    events: { emit: () => {}, setState: () => {} }, checkBuild: async () => ({ ok: true }), json: (res, code, v) => { res.out = v; }, body: async (req) => req.msg, log: () => {} });
  const call = async (name, args) => { const res = {}; await handle({ method: 'POST', headers: {}, msg: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }, res, new URL('http://x/workshop/mcp')); return res.out.result; };
  assert.equal((await call('start_editing', { what: 'Fix chores', fix: 'fix-nope' })).isError, true);
  assert.equal((await call('start_editing', { what: 'Fix chores', fix: fix.id })).isError, undefined);
  assert.equal(fixes.get(fix.id).status, 'working');
  const no = await call('done_editing', { summary: 'Defined the list' });
  assert.equal(no.isError, true);
  assert.equal(asked[0].pin, true);
  assert.deepEqual(ended, [false, false]); // the bad fix id, then put back out
  assert.equal(fixes.get(fix.id).status, 'pending');
  answer = true;
  await call('start_editing', { what: 'Fix chores', fix: fix.id });
  const yes = await call('done_editing', { summary: 'Defined the list' });
  assert.ok(!yes.isError);
  assert.equal(fixes.get(fix.id).status, 'done'); assert.equal(fixes.get(fix.id).sha, 'abc1234def');
  assert.equal(fixes.open().length, 0);
});

// The heartbeat without an agent (docs/heartbeat.md): a decision model judges what the checks found, a cheap text model
// writes the note with the household's own tools (the same registry the voice uses), and a broken app waits for
// whoever builds (heartbeat-fixes.js). No agent turn, no coding harness.
//
// judge: { decide(input, questions) -> {answers}, ai({instructions, input, tools}) -> {output, usage} } — OpenAI
// Decisions (gpt-6-luna) and the text model, through our cloud (cloud.js) or, later, the household's own key (the shell).

import { asData } from './as-data.js';

// gpt-6-luna, per million tokens (openhouse-cloud/docs/cloud-beta.md): Decisions are input only; the text model is $0.10 in, $0.50 out.
export const PRICE = { decideIn: 0.10, aiIn: 0.10, aiOut: 0.50 };
export const decideCost = (input, questions) => ((String(input).length + JSON.stringify(questions).length) / 4) * PRICE.decideIn / 1e6;
export const aiCost = (u) => ((u?.input_tokens || 0) * PRICE.aiIn + (u?.output_tokens || 0) * PRICE.aiOut) / 1e6;

export const WORTH = 0.6; // how sure "worth acting on" must be
export const STEPS = 4; // the text model's steps for one note

// What each kind of action needs the switch to be at.
export const ACTS = [
  { value: 'notice', description: 'Tell the household: one short line on Home (a reminder or a suggestion)' },
  { value: 'tidy', description: 'A line already on Home is about this: change it (or take it down if it is sorted) instead of adding one' },
  { value: 'fix', description: "One of the household's apps is broken and its code needs fixing" },
];

/** The typed questions about each finding (at most 8 findings a call). people: the household's first names. */
export function questions(findings, people = []) {
  const qs = [];
  findings.forEach((f, i) => {
    const n = i + 1;
    qs.push({ type: 'predicate', name: `worth_${n}`, instructions: `Finding ${n}: is it worth doing something about now, for a household that wants a calm screen? Yes for a real problem or a useful nudge. No if it's trivial, already sorted, or something on Home already says it.` });
    qs.push({ type: 'choice', name: `act_${n}`, instructions: `Finding ${n}: what would help most?`, choices: ACTS });
    if (people.length) qs.push({ type: 'choice', name: `for_${n}`, instructions: `Finding ${n}: who is it for?`,
      choices: [...people.map((p) => ({ value: p, description: `${p} (it's about them, or they'd sort it)` })), { value: 'household', description: 'Whoever looks after the tablet (a setting, the tablet, a link to check)' }, { value: 'everyone', description: 'The whole household' }] });
  });
  return qs;
}

const FOUND = "what the screen's checks found, with apps' and calendars' own error text in it";

/** What the decision model is shown: the time, the household, the notes now, and the findings, numbered. */
export function judgeInput({ findings, when, household = '', notes = '' }) {
  return `It is ${when}. A household's kitchen screen checked on things and found what's listed below.\n\n` +
    `The household:\n${String(household).slice(0, 3000)}\n\n${String(notes).slice(0, 2000)}\n\n` +
    `Found:\n${asData(findings.map((f, i) => `${i + 1}. [${f.kind}] ${f.text}`).join('\n'), FOUND, { max: 8000 })}`;
}

/** The answers, per finding: { worth, act, actSure, for }. */
export function verdicts(findings, answers = []) {
  const by = Object.fromEntries((answers || []).map((a) => [a.name, a]));
  return findings.map((f, i) => {
    const n = i + 1, w = by[`worth_${n}`], a = by[`act_${n}`], p = by[`for_${n}`];
    const forWho = p?.choice && p.choice !== 'everyone' && (p.confidence ?? 1) >= 0.5 ? p.choice : f.for || null;
    return { key: f.key, worth: typeof w?.probability === 'number' ? w.probability : 0, act: ACTS.some((x) => x.value === a?.choice) ? a.choice : 'notice', actSure: a?.confidence ?? 0, for: forWho };
  });
}

// What the text model is told. The same notes rules as the assistant (NOTES.md and the family's preferences follow).
export const NOTE_RULES = `You look after a household's screen in the background. Nobody asked anything and nobody is watching; nothing you write is said aloud. The screen's own checks found one thing worth a line on Home, the short strip everyone sees. Do exactly one small thing with your tools, then reply with one line saying what you did, or NOTHING.

- Read the things on Home first (below). Never put up a line that says what one already says: put up the same words changed instead (it replaces yours).
- A line (show_thing): at most about eight plain words, a reminder or a suggestion ("Leave by 4:50 for Ducks at MSU"). People's names, not pronouns. No emoji. "until" is when its moment passes; it also comes down by itself once what it's about is sorted. Give it what a tap does: "open" its tab (meals, calendar, map...) or "ask" Opie something that settles it.
- By kind: [sync] a calendar's link needs checking in Settings. [morning] only if there's something to get ready ("Pack Leo's swim bag"). [storage] storage is nearly full. [app] what the app's check says, plainly.`;

const textOf = (out) => (out || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');

/**
 * One note (or an update of one), written by the text model with the household's tools. tools: [{type:'function',...}]
 * for this level; callTool(name, args) -> {text, isError}. Returns { ok, said, cost, steps, error? }.
 */
export async function writeNote({ ai, finding, verdict, level, fixQueued = false, rules = '', tools, callTool, when }) {
  const instructions = NOTE_RULES + (rules ? `\n\n---\n\n${rules}` : '');
  const input = [{ role: 'user', content: `It is ${when}. Your level is "${level}"${level === 'notice' ? ' (new lines only)' : ' (lines, and taking down your own)'}.\n\n` +
    `Found:\n${asData(`[${finding.kind}] ${finding.text}`, FOUND, { max: 2000 })}${verdict?.for ? `\nIt's for: ${verdict.for}` : ''}${verdict?.act === 'tidy' ? '\nA line on Home may already be about this: change it rather than add one.' : ''}` }];
  let cost = 0, steps = 0;
  for (; steps < STEPS; steps++) {
    let r;
    try { r = await ai({ instructions, input, tools }); } catch (e) { return { ok: false, error: e.code || e.message, said: '', cost, steps }; }
    cost += aiCost(r.usage);
    const calls = (r.output || []).filter((o) => o.type === 'function_call');
    if (!calls.length) return { ok: true, said: textOf(r.output).trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() || '', cost, steps: steps + 1 };
    for (const c of calls) {
      let args = {}; try { args = JSON.parse(c.arguments || '{}'); } catch {}
      if (c.name === 'put_note' && verdict?.for && !args.for && verdict.for !== 'household') args.for = verdict.for;
      const out = await callTool(c.name, args);
      input.push(c, { type: 'function_call_output', call_id: c.call_id, output: out.text });
    }
  }
  return { ok: true, said: '', cost, steps };
}

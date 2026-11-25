// The tablet's assistant for typed turns, getting to know the family, flyers and recipes, refitting notes and the
// board: the cloud's text model (through our service: cloud.js ai(), once the family chose OpenAI) with the household's
// tools (chat.js textTools: live-tools.js's, plus the household, the home screen's tabs and look, undo) and the
// assistant's own rules (CHAT.md and the family's preferences). Making or changing an app: on the tablet itself, on
// rails (rails.js, run below, through the builder: builder.js), when the household has it on; otherwise, and for
// anything bigger, someone's own Claude or ChatGPT on a computer (the workshop, workshop.js).
let deps = null; // { ai, decide?, tools(), callTool(name, args, homeToken), instructions(), rails?, build?(text) } (server.js, once the home screen and the cloud exist)
// Which way a request goes, decided first (OpenAI Decisions: fast, and about a hundredth of a cent): the household's
// quick things and everyday questions here; making or changing an app is for a computer, said plainly at once.
const ROUTE = [{ type: 'choice', name: 'route', instructions: "A family member said this to their kitchen tablet's assistant. What does it need?",
  choices: [{ value: 'household', description: 'The calendar, lists, chores, stars, rewards, routines, meals, notes, the weather, the family, or an everyday question or chat' },
    { value: 'tablet', description: 'Making a new app, game or tab, or changing how one of the apps looks or works (its text, colors, layout, what it shows or lets them do). Not the home screen\'s tabs, their order or its overall look, and not the family\'s things themselves (an event, a list item, a chore): those are household' },
    { value: 'not_for_it', description: 'Not meant for the assistant (people talking to each other, the TV, a fragment)' }] }];
/** The route question, with what the household's apps offer the voice (plugins' voice actions, <app>__<action>) as household. */
export function routeFor(tools = []) {
  const acts = tools.filter((t) => /__/.test(t.name)).map((t) => String(t.description || '').replace(/\.$/, ''));
  if (!acts.length) return ROUTE;
  const [household, ...rest] = ROUTE[0].choices;
  return [{ ...ROUTE[0], choices: [{ ...household, description: `${household.description}, or something one of the household's apps does: ${acts.join('; ')}` }, ...rest] }];
}
export const NEEDS_COMPUTER = "Making and changing apps happens on a computer: someone connects their own Claude or ChatGPT to the tablet (Settings, then Screens and computers) and asks there. I can help with the calendar, lists, chores, meals, notes, the home screen's tabs and the weather.";
export const BUILDING = "I'm making it; it'll show here when it's ready."; // (no promise: a build can still fail, and then it says so here)
const BUSY = "I'm still making the last thing. Ask me again when it's done.";
export function useCloud(d) { deps = d; }
/** Whether apps are made on the tablet (rails.js): the household has it on and the cloud's model is there. */
export const buildsHere = () => !!deps?.rails;

import { DEVICE_NAMES } from '../device-tools.js';
const textOf = (out) => out.filter((o) => o.type === 'message').flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');

/**
 * One turn: prompt (with the household's context), history [{role, text}] (this conversation's earlier turns),
 * systemPrompt (the rules; the household's own by default), homeToken (the turn's run, so its tools act as part of it),
 * route false for a background turn or the first conversation (no "is this for me?" question first), request {text, who,
 * app} what was asked on its own (a request to make an app goes to the builder as it was asked, the prompt as its context).
 */
export async function chat({ prompt, onEvent = () => {}, signal, homeToken = null, route = true, history = [], systemPrompt = null, request = null }) {
  if (!deps) return { ok: false, text: "I can't think right now: the cloud assistant isn't ready." };
  const before = (Array.isArray(history) ? history : []).filter((t) => t && t.text).map((t) => ({ role: t.role === 'assistant' ? 'assistant' : 'user', content: String(t.text) }));
  const input = [...before, { role: 'user', content: String(prompt || '') }], tools = deps.tools(), instructions = systemPrompt || deps.instructions();
  onEvent({ kind: 'model', id: 'cloud' });
  if (deps.decide && route) {
    const a = await deps.decide(String(prompt || ''), routeFor(tools)).catch(() => null);
    const r = a?.answers?.[0];
    // (only when it's clear: anything less goes to the model, which has make_app and the household's tools both)
    if (r?.choice === 'tablet' && (r.confidence ?? 1) >= 0.7) {
      // Made here, on rails (builder.js shows it working and opens the app); a computer when building here is off.
      const started = deps.build ? await deps.build(String(request?.text || prompt || ''), { who: request?.who || null, app: request?.app || null, context: request ? String(prompt || '') : null, conversation: request?.conversation || null }).catch(() => null) : null;
      const text = started?.ok ? BUILDING : started?.busy ? BUSY : NEEDS_COMPUTER;
      onEvent({ kind: 'delta', text }); return { ok: true, text };
    }
    if (r?.choice === 'not_for_it' && (r.confidence ?? 1) >= 0.8) return { ok: true, text: '[quiet]', quiet: true };
  }
  // A few steps for the household's things; using an app for someone (device-tools.js) takes more: one per tap.
  let limit = 8;
  for (let step = 0; step < limit; step++) {
    if (signal?.aborted) return { ok: false, text: 'Stopped.' };
    let r;
    try { r = await deps.ai({ instructions, input, tools }); } catch (e) { return { ok: false, text: e.code === 'http429' ? "I've used this month's allowance. Someone can see it on the family's account page." : `I can't think right now (${e.message}).` }; }
    const calls = (r.output || []).filter((o) => o.type === 'function_call');
    if (calls.some((c) => DEVICE_NAMES.includes(c.name))) limit = 40;
    if (!calls.length) { const text = textOf(r.output || []).trim() || 'Done.'; onEvent({ kind: 'delta', text }); return { ok: true, text }; }
    for (const c of calls) {
      onEvent({ kind: 'status', text: c.name.replace(/_/g, ' ') });
      let args = {}; try { args = JSON.parse(c.arguments || '{}'); } catch {}
      const out = await deps.callTool(c.name, args, homeToken);
      input.push(c, { type: 'function_call_output', call_id: c.call_id, output: out.text });
    }
  }
  return { ok: false, text: 'That took too many steps. Try asking it a simpler way.' };
}
/** The builder's agent (builder.js): an app made or changed on the tablet, on rails (rails.js), when that's on. */
export async function run(opts) { return deps?.rails ? deps.rails.run(opts) : { ok: false, text: NEEDS_COMPUTER }; }

/**
 * One answer with no tools (the Meals app's buttons, a flyer or a recipe photo, finding recipes on the web): instructions,
 * the request, and any photos (JPEG/PNG/WebP bytes) for the model to look at. Resolves to the text.
 */
export async function answer({ instructions = '', prompt, images = [], webSearch = false }) {
  if (!deps) throw new Error("the cloud assistant isn't ready");
  const content = [{ type: 'input_text', text: String(prompt || '') },
    ...images.map((im) => ({ type: 'input_image', image_url: `data:${im.type || 'image/jpeg'};base64,${Buffer.from(im.bytes).toString('base64')}` }))];
  // webSearch: OpenAI's own web search for this answer (finding recipes: house.js findRecipes), counted by the cloud
  const r = await deps.ai({ instructions: String(instructions), input: [{ role: 'user', content }], tools: [], ...(webSearch ? { webSearch: true } : {}) });
  const text = textOf(r.output || []).trim();
  if (!text) throw new Error('no answer');
  return text;
}

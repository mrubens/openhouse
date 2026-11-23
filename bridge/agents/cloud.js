// The tablet's assistant for typed turns, getting to know the family, flyers and recipes, refitting notes and the
// board: the cloud's text model (through our service: cloud.js ai(), once the family chose OpenAI) with the household's
// tools (chat.js textTools: live-tools.js's, plus the household, the home screen's tabs and look, undo) and the
// assistant's own rules (CHAT.md and the family's preferences). There's no coding agent on the tablet: making or changing
// an app is someone's own Claude or ChatGPT on a computer (the workshop, workshop.js).
let deps = null; // { ai, decide?, tools(), callTool(name, args, doorToken), instructions() } (server.js, once the door and the cloud exist)
// Which way a request goes, decided first (OpenAI Decisions: fast, and about a hundredth of a cent): the household's
// quick things and everyday questions here; making or changing an app is for a computer, said plainly at once.
const ROUTE = [{ type: 'choice', name: 'route', instructions: "A family member said this to their kitchen tablet's assistant. What does it need?",
  choices: [{ value: 'household', description: 'The calendar, lists, chores, stars, rewards, routines, meals, notes, the weather, the family, or an everyday question or chat' },
    { value: 'tablet', description: 'Making, building or changing the code of an app or a game (not the home screen\'s tabs, order or look: those are household)' },
    { value: 'not_for_it', description: 'Not meant for the assistant (people talking to each other, the TV, a fragment)' }] }];
/** The route question, with what the household's apps offer the voice (plugins' voice actions, <app>__<action>) as household. */
export function routeFor(tools = []) {
  const acts = tools.filter((t) => /__/.test(t.name)).map((t) => String(t.description || '').replace(/\.$/, ''));
  if (!acts.length) return ROUTE;
  const [household, ...rest] = ROUTE[0].choices;
  return [{ ...ROUTE[0], choices: [{ ...household, description: `${household.description}, or something one of the household's apps does: ${acts.join('; ')}` }, ...rest] }];
}
export const NEEDS_COMPUTER = "Making and changing apps happens on a computer: someone connects their own Claude or ChatGPT to the tablet (Settings, then Screens and computers) and asks there. I can help with the calendar, lists, chores, meals, notes, the home screen's tabs and the weather.";
export function useCloud(d) { deps = d; }

import { DEVICE_NAMES } from '../device-tools.js';
const textOf = (out) => out.filter((o) => o.type === 'message').flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');

/**
 * One turn: prompt (with the household's context), history [{role, text}] (this conversation's earlier turns),
 * systemPrompt (the rules; the household's own by default), doorToken (the turn's run, so its tools act as part of it),
 * route false for a background turn or the first conversation (no "is this for me?" question first).
 */
export async function chat({ prompt, onEvent = () => {}, signal, doorToken = null, route = true, history = [], systemPrompt = null }) {
  if (!deps) return { ok: false, text: "I can't think right now: the cloud assistant isn't ready." };
  const before = (Array.isArray(history) ? history : []).filter((t) => t && t.text).map((t) => ({ role: t.role === 'assistant' ? 'assistant' : 'user', content: String(t.text) }));
  const input = [...before, { role: 'user', content: String(prompt || '') }], tools = deps.tools(), instructions = systemPrompt || deps.instructions();
  onEvent({ kind: 'model', id: 'cloud' });
  if (deps.decide && route) {
    const a = await deps.decide(String(prompt || ''), routeFor(tools)).catch(() => null);
    const r = a?.answers?.[0];
    if (r?.choice === 'tablet' && (r.confidence ?? 1) >= 0.6) { onEvent({ kind: 'delta', text: NEEDS_COMPUTER }); return { ok: true, text: NEEDS_COMPUTER }; }
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
      const out = await deps.callTool(c.name, args, doorToken);
      input.push(c, { type: 'function_call_output', call_id: c.call_id, output: out.text });
    }
  }
  return { ok: false, text: 'That took too many steps. Try asking it a simpler way.' };
}
export async function run() { return { ok: false, text: NEEDS_COMPUTER }; }

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

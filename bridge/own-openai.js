// The household's own OpenAI key (docs/assistant.md): Opie's voice, its assistant and Decisions on the household's
// own OpenAI account, with nothing through Opie's cloud. The same requests the cloud makes (openhouse-cloud
// lambda/speech.ts and app.ts, copied here 2026-11-26 with the owner's yes), sent through the shell's route to OpenAI
// (DeviceServer /openai, OwnKey.kt), which adds the key: the bridge never has it. No allowance here: OpenAI bills the
// household, and the key's own budget at OpenAI is the stop.

/** GPT-Live's voices (the cloud's LIVE_VOICES). */
export const LIVE_VOICES = ['marin', 'gleam', 'meridian', 'quartz', 'ripple', 'vesper', 'willow', 'stone', 'delta', 'cinder', 'beacon',
  'bossa', 'tempo', 'nuri', 'juni', 'flitz', 'brise', 'sillage', 'nira', 'harema', 'shida', 'noeul'];
export const MODELS = { live: 'gpt-live-1.1', backend: 'gpt-6-luna', text: 'gpt-6-luna', decide: 'gpt-6-luna' };
const AI_MAX_OUTPUT = 16_000;

// What the household's own key costs them, estimated from OpenAI's list prices as the cloud's are (openhouse-cloud
// lambda/app.ts VOICE and PRICES, 2026-11-24): only for Settings → Voice's "This month" (usage.js); OpenAI's bill is the
// real one. In millicents; text prices in cents per 1M tokens, short context (at most 272K input tokens) and long.
export const COSTS = { livePerSecond: 5000 / 60, searchPerCall: 1000, decideInPerM: 10 * 1000 };
export const PRICES = {
  'gpt-6-luna': [{ in: 10, cached: 1, w30: 12.5, w12: 25, out: 50 }, { in: 20, cached: 2, w30: 25, w12: 50, out: 75 }],
  'gpt-6.1-terra': [{ in: 100, cached: 5, w30: 125, w12: 250, out: 500 }, { in: 200, cached: 10, w30: 250, w12: 500, out: 750 }],
};
/** What a response's tokens cost, in millicents (a model not listed: the dearest). */
export function tokensMc(model, u = {}, flex = false) {
  const known = Object.keys(PRICES).find((m) => model === m || String(model || '').startsWith(`${m}-`));
  const p = PRICES[known || 'gpt-6.1-terra'][(u.input_tokens || 0) > 272_000 ? 1 : 0];
  const cached = u.cached_tokens || 0, w12 = u.ttl_12h_tokens || 0, w30 = Math.max(0, (u.cache_write_tokens || 0) - w12);
  const plain = Math.max(0, (u.input_tokens || 0) - cached - w30 - w12);
  return (plain * p.in + cached * p.cached + w30 * p.w30 + w12 * p.w12 + (u.output_tokens || 0) * p.out) * 1000 / 1e6 * (flex ? 0.5 : 1);
}

// OpenAI's own web search for the live voice's text model: directions, travel times, hours, anything outside the
// household. Its words override the household rules' "you can't search".
export const LIVE_SEARCH = `In this spoken conversation you can search the web (web_search), which the household's rules may say you can't. ` +
  `Use it for directions, how long it takes to get somewhere and when to leave, opening hours, and other things outside the household. ` +
  `Start from the household's town or address. Travel times from a search are typical ones, without live traffic: say so in a few words, ` +
  `and for "when should we leave", count back from the event's time with a few minutes to spare. ` +
  `If you can't do something or don't know, say so plainly in a sentence; never answer a different question instead.`;

/** The live voice's own words: with the household's tools its backend does the work; without, everything is handed
 *  to the tablet. (OpenAI: when it delegates is set only here, in a "Delegation policy" block.) */
export function liveInstructions(name, withTools) {
  const said = withTools
    ? `You are the voice of ${name}, a household's home-screen assistant. You only listen and speak; your backend has the household's tools and does the work. ` +
      `Delegation policy:\nDelegate to the backend at once, before saying anything else, when: someone asks about the household, its people, calendar, schedule, ` +
      `lists, chores, stars, meals, notes, routines, the weather or the time; asks you to add, change, remember or do anything, including opening, installing or using one of the tablet's apps for them; or asks anything you'd have to look up. ` +
      `Also delegate at once, saying nothing at all, when they want the conversation over: "go away", "hang up", "stop", "be quiet", "that's all", "never mind", "bye", "we're done"; the backend ends it. ` +
      `When unsure, delegate.\nDo not delegate when: it's only a greeting or thanks; reply in a few words.\n` +
      `While the backend works, say nothing, or at most a few words. Never make up an answer about the household. Keep replies short. ` +
      `If someone talks over you, stop and listen. If people are talking to each other and not to you, stay quiet.`
    : `You are the voice of ${name}, a family's kitchen assistant. You only listen and speak; the family's own assistant does the thinking. ` +
      `Delegate every request, question or task to the client, and never answer from your own knowledge. While you wait, say at most a few words. ` +
      `When the client gives you something to say, say it naturally and briefly, in its words. Keep replies short; this is a busy kitchen. ` +
      `If someone talks over you, stop and listen. If people are talking to each other and not to you, stay quiet.`;
  // The session hears what was said from its name on (the shell keeps it while connecting: LiveVoice).
  const woke = `People wake you by saying "Opie" or "Hey Opie"; what you hear first may start with that, often with the request in the same breath. ` +
    `Answer the request; if it was only your name, greet them in a few words and listen.`;
  return `${said}\n${woke}`;
}

/** Function tools, with names OpenAI accepts; strict: false (a strict call fills in every part of the schema). */
export function cleanTools(t) {
  if (!Array.isArray(t)) return [];
  return t.filter((x) => x && x.type === 'function' && /^[A-Za-z0-9_-]{1,64}$/.test(String(x.name)) && x.parameters && typeof x.parameters === 'object')
    .map((x) => ({ type: 'function', name: String(x.name), description: String(x.description || ''), parameters: x.parameters, strict: false }));
}
/** What was said lately, newest last, within OpenAI's limits (128 messages, about 8,192 tokens). */
export function cleanInput(x) {
  if (!Array.isArray(x)) return [];
  const out = []; let n = 0;
  for (const m of x.slice(-128).reverse()) {
    const role = m?.role === 'user' || m?.role === 'assistant' ? m.role : null, text = String(m?.text || '').trim().slice(0, 2000);
    if (!role || !text) continue;
    if ((n += text.length) > 24000) break;
    out.unshift({ role, text });
  }
  return out;
}

const fail = (what, r) => Object.assign(new Error(`openai ${what} ${r.status || ''}${r.body?.error?.code ? ' ' + r.body.error.code : ''}`.trim()),
  { code: r.body?.error === 'no_key' ? 'no_key' : r.status === 401 ? 'own_key_refused' : r.status === 429 ? 'own_key_limit' : `http${r.status || 502}` });

/**
 * [openai](kind, body) -> {status, body}: the shell's route (kinds: live, responses, decisions). The three calls as the
 * cloud's answers look, so the rest of the bridge can't tell which way they went. spent(mc): what a call cost, estimated.
 */
export function ownOpenAI({ openai, spent = () => {} }) {
  async function liveStart({ sdp, name, instructions, tools, idleTimeoutS, voice, earlier }) {
    if (!/^v=0\r?\n/.test(String(sdp || '')) || String(sdp).length > 20000) throw Object.assign(new Error('sdp'), { code: 'http400' });
    const fns = cleanTools(tools), rules = String(instructions || '');
    const who = String(name || 'Opie').replace(/[^\p{L}\p{N} '’-]/gu, '').slice(0, 30) || 'Opie';
    const session = {
      model: MODELS.live, instructions: liveInstructions(who, fns.length > 0), store: false,
      audio: { output: { voice: LIVE_VOICES.includes(voice) ? voice : 'marin' } },
      delegation: fns.length
        ? { type: 'responses', responses: { model: MODELS.backend, instructions: `${rules}\n\n${LIVE_SEARCH}`, tools: [...fns, { type: 'web_search' }], tool_choice: 'auto' } }
        : { type: 'client', acknowledgement_delay_ms: 800 },
      idle_timeout_s: Math.max(5, Math.min(60, Math.round(Number(idleTimeoutS) || 20))),
    };
    const input = cleanInput(earlier);
    const go = (s) => openai('live', { session: s, transport: { type: 'webrtc', sdp: String(sdp) } });
    // What was said lately goes first; if OpenAI won't take it, the session starts without it.
    let r = input.length ? await go({ ...session, input: input.map((m) => ({ type: 'message', role: m.role, content: [{ type: m.role === 'user' ? 'input_text' : 'output_text', text: m.text }] })) }) : null;
    if (!r || r.status >= 300) r = await go(session);
    if (r.status >= 300 || !r.body?.transport?.sdp) throw fail('live', r);
    return { sessionId: String(r.body.session?.id || ''), sdp: r.body.transport.sdp, vendor: 'OpenAI', own: true };
  }

  /** The assistant's next step: {instructions, input, tools, tier?, webSearch?} -> {output, usage, tier}. */
  async function respond(q) {
    const flex = q?.tier === 'flex';
    const r = await openai('responses', { model: MODELS.text, instructions: String(q?.instructions || ''), input: Array.isArray(q?.input) ? q.input : [],
      tools: [...cleanTools(q?.tools), ...(q?.webSearch === true ? [{ type: 'web_search' }] : [])], store: false, max_output_tokens: AI_MAX_OUTPUT, ...(flex ? { service_tier: 'flex' } : {}) });
    if (flex && r.status === 429) throw Object.assign(new Error('flex unavailable'), { code: 'flex_unavailable' });
    if (r.status >= 300) throw fail('responses', r);
    const u = r.body?.usage || {}, d = u.input_tokens_details || {};
    const output = r.body?.output || [], usage = { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cached_tokens: d.cached_tokens || 0, cache_write_tokens: d.cache_write_tokens || 0 };
    const searches = output.filter((o) => o?.type === 'web_search_call').length;
    spent(tokensMc(r.body?.model || MODELS.text, usage, flex) + searches * COSTS.searchPerCall);
    return { output, tier: r.body?.service_tier === 'flex' ? 'flex' : 'standard', usage };
  }

  /** Decisions: {answers}. Questions in the shape OpenAI accepts, else refused. */
  async function decide(input, questions) {
    const qs = cleanQuestions(questions);
    if (!String(input || '') || !qs) throw Object.assign(new Error('questions'), { code: 'http400' });
    const r = await openai('decisions', { model: MODELS.decide, input: String(input), questions: qs });
    if (r.status >= 300) throw fail('decisions', r);
    // (OpenAI's count of what it read; without one, each question as if it read all of it, at about 2 characters a token)
    const read = Number(r.body?.usage?.input_tokens) || Math.ceil((String(input).length + JSON.stringify(qs).length) / 2) * qs.length;
    spent(read * COSTS.decideInPerM / 1e6);
    return { answers: r.body?.answers || [] };
  }
  return { liveStart, respond, decide };
}

/** OpenAI Decisions' shape: 1-400 questions; 2-255 choices; 2-10 levels. */
export function cleanQuestions(q) {
  if (!Array.isArray(q) || !q.length || q.length > 400) return null;
  const out = [];
  for (const [i, x] of q.entries()) {
    const name = x?.name != null ? String(x.name) : `q${i}`, instructions = String(x?.instructions || '');
    if (!instructions) return null;
    if (x.type === 'predicate') out.push({ type: 'predicate', name, instructions });
    else if (x.type === 'choice' && Array.isArray(x.choices) && x.choices.length >= 2 && x.choices.length <= 255)
      out.push({ type: 'choice', name, instructions, choices: x.choices.map((c) => ({ value: typeof c?.value === 'boolean' ? c.value : String(c?.value ?? ''), ...(c?.description ? { description: String(c.description) } : {}) })) });
    else if (x.type === 'score' && Array.isArray(x.levels) && x.levels.length >= 2 && x.levels.length <= 10)
      out.push({ type: 'score', name, instructions, levels: x.levels.map((l) => ({ label: String(l?.label ?? ''), ...(l?.description ? { description: String(l.description) } : {}) })) });
    else return null;
  }
  return out;
}

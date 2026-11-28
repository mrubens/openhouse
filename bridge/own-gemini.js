// The household's own Gemini key (docs/assistant.md): Opie's voice on Google's Gemini Live, on the household's own
// Google account, with nothing through Opie's cloud. Only the voice: typed questions, the heartbeat and Decisions stay
// where they are (the household's OpenAI key, or Opie cloud). The shell keeps the key (GeminiKey.kt) and, through its
// route (DeviceServer /gemini), asks Google for a one-use token for each conversation; the session's page connects to
// Google with that token (chat/live/gemini-session.cjs). The bridge never has the key, and the token works for one
// conversation of this model only. Google bills the household; cloud.js stops the spending with this key's own monthly
// stop (checked before each start) and the day's cap on minutes "Hey Opie" opened, as for the OpenAI key.
//
// Google's pages (aistudio.google.com/docs/live-api, /docs/live-api/ephemeral-tokens, /docs/pricing), checked 2026-11-28.

/** Gemini Live's stable model, the one Google recommends for voice agents (released 2026-09-15, no shutdown date). */
export const MODEL = 'gemini-3.8-live';
/** Where a session connects with a one-use token (v1beta only; the token goes as access_token). */
export const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
/** Google's prebuilt voices that Live speaks with (lower case here; Google's own spelling is capitalised: voiceId). */
export const GEMINI_VOICES = ['kore', 'puck', 'charon', 'aoede', 'leda', 'orus', 'zephyr', 'fenrir', 'callirrhoe', 'autonoe', 'enceladus', 'iapetus', 'umbriel',
  'algieba', 'despina', 'erinome', 'algenib', 'rasalgethi', 'laomedeia', 'achernar', 'alnilam', 'schedar', 'gacrux', 'pulcherrima', 'achird',
  'zubenelgenubi', 'vindemiatrix', 'sadachbia', 'sadaltager', 'sulafat'];
export const DEFAULT_VOICE = 'kore';
export const isGeminiVoice = (v) => GEMINI_VOICES.includes(String(v || '').toLowerCase());
const voiceId = (v) => { const x = isGeminiVoice(v) ? String(v).toLowerCase() : DEFAULT_VOICE; return x[0].toUpperCase() + x.slice(1); };

// What a conversation costs the household, estimated from Google's list prices (paid tier, per 1M tokens): audio in
// $3, audio out $12, text in $0.75, text out (and the transcripts) $4.50; Google Search past 5,000 a month $14 per
// 1,000. Google bills each turn for the whole conversation so far, so usage comes from Google's own counts
// (usageMetadata, gemini-session.cjs); livePerSecond is only for how long a conversation may run before the stop
// ($0.03 a minute, above Google's ~$0.023 for a minute heard and spoken, since earlier turns are billed again).
// In millicents; prices in cents per 1M tokens.
export const PRICES = { audioIn: 300, audioOut: 1200, textIn: 75, textOut: 450 };
export const COSTS = { livePerSecond: 50, searchPerCall: 1400 };
/** What a session's counted tokens cost, in millicents: {audio_in, audio_out, text_in, text_out, searches}. */
export function geminiMc(u = {}) {
  const n = (k) => Math.max(0, Number(u[k]) || 0);
  return (n('audio_in') * PRICES.audioIn + n('audio_out') * PRICES.audioOut + n('text_in') * PRICES.textIn + n('text_out') * PRICES.textOut) * 1000 / 1e6
    + n('searches') * COSTS.searchPerCall;
}

/** The voice's own words for Gemini: it calls the household's tools itself (no backend in between), then the household's
 *  instructions (live-tools.js setupFor: the same as OpenAI's voice gets). */
export function geminiInstructions(name, rules, withTools) {
  const head = withTools
    ? `You are the voice of ${name}, a household's home-screen assistant, and you have the household's tools. ` +
      `For anything about the household, its people, calendar, schedule, lists, chores, stars, meals, notes, routines, the weather or the time, and for anything they ask you to add, change, remember or do (including opening, installing or using one of the device's apps), call the tool at once, before saying anything else; then say what happened in a sentence. ` +
      `When they want the conversation over ("go away", "stop", "that's all", "never mind", "bye"), call go_away and say nothing. ` +
      `Use Google Search for directions, travel times, opening hours and other things outside the household, starting from the household's town; travel times from a search are typical ones, without live traffic: say so in a few words. ` +
      `Never make up an answer about the household. Keep replies short. If someone talks over you, stop and listen. If people are talking to each other and not to you, stay quiet.`
    : `You are the voice of ${name}, a household's assistant at home. Keep replies short. If someone talks over you, stop and listen.`;
  const woke = `People wake you by saying "Opie" or "Hey Opie"; what you hear first may start with that, often with the request in the same breath. ` +
    `Answer the request; if it was only your name, greet them in a few words and listen.`;
  return `${head}\n${woke}\n\n${String(rules || '')}`;
}

/** A tool's schema as Gemini takes it: the parts OpenAI's strict calls needed (tool-args.js forModel: every optional
 *  part nullable) taken back out, since Gemini fills in only what it means. */
export function plainSchema(s) {
  if (Array.isArray(s)) return s.map(plainSchema);
  if (!s || typeof s !== 'object') return s;
  const o = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type' && Array.isArray(v)) { const t = v.filter((x) => x !== 'null'); o.type = t.length === 1 ? t[0] : t; }
    else if (k === 'enum' && Array.isArray(v)) o.enum = v.filter((x) => x !== null);
    else if (k === 'description' && typeof v === 'string') o.description = v.replace(/\s*\(null when not asked for\)$/, '');
    else o[k] = plainSchema(v);
  }
  return o;
}

/** Function tools as Gemini's functionDeclarations. The household's are quick, so the model waits for each (BLOCKING). */
export function geminiTools(t) {
  if (!Array.isArray(t)) return [];
  return t.filter((x) => x && x.type === 'function' && /^[A-Za-z0-9_.:-]{1,64}$/.test(String(x.name)) && x.parameters && typeof x.parameters === 'object')
    .map((x) => ({ name: String(x.name), description: String(x.description || ''), parametersJsonSchema: plainSchema(x.parameters), behavior: 'BLOCKING' }));
}

/** The session's setup (its first message to Google, BidiGenerateContentSetup). */
export function geminiSetup({ name, instructions, tools, voice }) {
  const fns = geminiTools(tools);
  const who = String(name || 'Opie').replace(/[^\p{L}\p{N} '’-]/gu, '').slice(0, 30) || 'Opie';
  return {
    model: `models/${MODEL}`,
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceId(voice) } } } },
    systemInstruction: { parts: [{ text: geminiInstructions(who, instructions, fns.length > 0) }] },
    tools: fns.length ? [{ functionDeclarations: fns }, { googleSearch: {} }] : [],
    // what was heard and said, as words: the bubble, the speech log and the next conversation (live-tools.js /live/said)
    inputAudioTranscription: {}, outputAudioTranscription: {},
    // Google bills each turn for all of the conversation so far: past about a minute of talk, the oldest goes.
    contextWindowCompression: { triggerTokens: 25000, slidingWindow: { targetTokens: 8000 } },
  };
}

// Google's answer to a call with the key, as the household's words say it (usage.js OWN_WORDS).
function fail(r) {
  const e = r.body?.error || {}, why = JSON.stringify(e.details || []) + ' ' + String(e.status || '') + ' ' + String(e.message || '');
  const code = r.body?.error === 'no_key' ? 'gemini_no_key'
    : /API_KEY_INVALID|API key not valid/i.test(why) || r.status === 401 ? 'gemini_key_refused'
      : r.status === 403 ? 'gemini_key_refused'
        : /FAILED_PRECONDITION|billing/i.test(why) ? 'gemini_key_billing'
          : r.status === 429 || r.status === 402 ? 'gemini_key_limit' : `http${r.status || 502}`;
  return Object.assign(new Error(`gemini token ${r.status || ''}`.trim()), { code });
}

/**
 * [gemini](kind, body) -> {status, body}: the shell's route (kinds: token). liveStart answers as a live start does
 * (sessionId, vendor), with what the page needs to connect: Google's address, the one-use token and the setup.
 */
export function ownGemini({ gemini, now = Date.now }) {
  async function liveStart({ name, instructions, tools, voice }) {
    const setup = geminiSetup({ name, instructions, tools, voice });
    const at = (ms) => new Date(now() + ms).toISOString();
    // One use, for this model only; a new conversation must start within a minute, and the token is no good after 30.
    const r = await gemini('token', { uses: 1, expireTime: at(30 * 60e3), newSessionExpireTime: at(60e3),
      liveConnectConstraints: { model: setup.model, config: { responseModalities: ['AUDIO'] } } });
    const token = r.status < 300 ? String(r.body?.name || '') : '';
    if (!token) throw fail(r);
    const sessionId = `g${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return { sessionId, vendor: 'Google', own: true, gemini: { url: LIVE_URL, token, setup } };
  }
  return { liveStart };
}

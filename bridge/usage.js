// What this tablet used of the AI this month, in the household's words (Settings → Voice's "This month", Opie's
// how_much_used, the account page): minutes talking to Opie, questions answered when typed, apps made or changed, and,
// on the household's own OpenAI key, what it cost them (estimated from OpenAI's list prices, own-openai.js PRICES). With
// Opie cloud's voice the cloud counts the minutes and the cost itself (it has the bill); this tablet tells it its
// questions and apps (cloud.js reportUse), which only the tablet knows.
//
// file: display/.cloud/usage.json {month: 'yyyy-mm' (UTC, as the cloud's), liveSecs, questions, apps, mc (millicents)}
import path from 'node:path';
import { readJson, writeJson } from './store.js';

const FIELDS = ['liveSecs', 'questions', 'apps', 'mc'];

export function usageCounter({ DIR, now = Date.now }) {
  const FILE = path.join(DIR, 'usage.json');
  const month = () => new Date(now()).toISOString().slice(0, 7);
  /** This month's counts (a new month starts from nothing). */
  function read() {
    const u = readJson(FILE, null, { bak: false }) || {};
    const m = month();
    return { month: m, ...Object.fromEntries(FIELDS.map((f) => [f, u.month === m ? Math.max(0, Number(u[f]) || 0) : 0])) };
  }
  /** Adds to this month's counts: {liveSecs?, questions?, apps?, mc?}. */
  function add(p) {
    const u = read();
    for (const f of FIELDS) if (Number(p?.[f]) > 0) u[f] += Number(p[f]);
    try { writeJson(FILE, u, { bak: false, mode: 0o600 }); } catch (e) { console.error('[usage]', e.message); }
    return u;
  }
  return { read, add, month };
}

/** About how much, as people say it: "about 40¢", "about $9", "nothing yet". */
export function aboutCost(cents) {
  const c = Math.max(0, Math.round(Number(cents) || 0));
  if (c === 0) return 'nothing yet';
  if (c < 100) return `about ${c}¢`;
  return `about $${Math.round(c / 100)}`;
}

/**
 * The month in plain words: {minutes, questions, apps, cents, text}. text is two lines: what was done, and the cost
 * ("This month: 42 minutes talking to Opie, 12 typed questions, 2 apps made or changed." / "About $3 so far.").
 */
export function monthWords({ liveSecs = 0, questions = 0, apps = 0, cents = 0, stopCents = 0 }, name = 'Opie') {
  const minutes = Math.round((Number(liveSecs) || 0) / 60);
  const n = (x, one, many) => `${x} ${x === 1 ? one : many}`;
  const parts = [`${n(minutes, 'minute', 'minutes')} talking to ${name}`, n(questions, 'typed question', 'typed questions'), n(apps, 'app made or changed', 'apps made or changed')];
  const cost = aboutCost(cents);
  const stop = stopCents > 0 ? `, of the $${Math.round(stopCents / 100)} monthly stop` : ''; // (the household's own key: cloud.js stopCents)
  const text = !minutes && !questions && !apps && cost === 'nothing yet' ? 'Nothing used yet this month.'
    : `This month: ${parts.join(', ')}.${cost === 'nothing yet' ? '' : `\n${cost[0].toUpperCase()}${cost.slice(1)} so far${stop}.`}`;
  return { minutes, questions, apps, cents: Math.round(Number(cents) || 0), text };
}

/** On the household's own OpenAI key (own-openai.js, cloud.js), why a call didn't go: OpenAI refused the key, its
 *  account is out of credit or over its limit, the device has no key, the monthly stop set in Settings is reached, or
 *  today's minutes opened by "Hey Opie" are used (cloud.js WAKE_DAY_SECS). The voice and a typed question say the same. */
export const OWN_WORDS = {
  own_key_refused: "OpenAI stopped accepting the household's key. An adult can put in a new one in Settings, Opie, Voice.",
  own_key_limit: "OpenAI says the household's account is out of credit or over its limit. Add credit on OpenAI's site, then try again.",
  no_key: 'The device has no OpenAI key. An adult can add one in Settings, Opie, Voice.',
  own_stop: "This month's spending stop for the OpenAI key is reached. An adult can raise it in Settings, Opie, Voice.",
  wake_cap: "I've talked for an hour today after hearing my name, the most for one day. Tap me to talk.",
};

/** What to say when Opie's service said no to a call for what it costs (its 429 `over`): the credit ran out, or the
 *  month's limit was reached; on the household's own key, OWN_WORDS. null for anything else. */
export function overWords(e) {
  if (OWN_WORDS[e?.code]) return OWN_WORDS[e.code];
  if (e?.over === 'credit') return "Opie's credit has run out. Someone can add more on the account page.";
  if (e?.code === 'http429') return "I've used this month's allowance. Someone can see it on the household's account page.";
  return null;
}

// Anything in the bridge notes a typed question answered or an app made or changed (chat.js, builder.js); cloud.js
// counts it (its counted), once it's up.
let counter = null;
export function onUse(f) { counter = f; }
export function noteUse(p) { try { counter?.(p); } catch (e) { console.error('[usage]', e.message); } }

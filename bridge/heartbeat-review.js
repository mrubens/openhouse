// The heartbeat's hourly review (docs/heartbeat.md): once an hour in waking hours, the cloud's text model (gpt-6-luna,
// on OpenAI's Flex tier) gets a compact picture of today and tomorrow (calendar, lists, chores, meals, Today's notes)
// and whatever the checks found that nobody has looked at, and does at most one small thing: a note, tidying one of its
// own notes, or queueing a fix for whoever builds. Or nothing, which is the usual answer. It never speaks.
//
// The instant findings (an app crashing, a calendar that stopped syncing) don't wait for it: the decision model judges
// those as soon as a check fires (heartbeat-judge.js), on the standard tier.

// gpt-6-luna per million tokens (OpenAI's pricing page, 2026-11-20, short context): standard $0.10 in, $0.01 cached,
// $0.50 out; Flex half that. A Flex request OpenAI can't take answers 429 and costs nothing: that hour is skipped.
export const RATES = { standard: { in: 0.10, cached: 0.01, out: 0.50 }, flex: { in: 0.05, cached: 0.005, out: 0.25 } };
/** What a response cost, by the tier it ran on (standard unless the service says otherwise). */
export function reviewCost(usage, tier = 'standard') {
  const r = RATES[tier] || RATES.standard, u = usage || {};
  const cached = u.input_tokens_details?.cached_tokens || 0, fresh = Math.max(0, (u.input_tokens || 0) - cached);
  return (fresh * r.in + cached * r.cached + (u.output_tokens || 0) * r.out) / 1e6;
}
export const STEPS = 4; // model calls in one review
export const WRITES = new Set(['show_thing', 'take_down_thing', 'put_note', 'update_note', 'take_down_note', 'queue_fix']);

export const REVIEW_RULES = `You look after a household's screen in the background, now and then. Nobody asked anything and nobody is watching; nothing you write is said aloud. Below is today and tomorrow as the screen knows it, the things on Home (the short strip everyone sees, one line each), and anything its checks found.
Most hours the right answer is NOTHING. Do at most one small thing, and only when it clearly helps someone in the next day:
- one line on Home with show_thing: a reminder or a suggestion with its moment ("Leave by 4:50 for Ducks at MSU", "Pack Leo's swim bag tonight");
- take down one of your own lines that no longer matters;
- queue_fix for an app the checks found broken (only at Fix things; whoever builds the household's apps fixes it).
Be helpful, never pushy: no nudges about chores, meals or plans they haven't made (Home already shows dinner, the weather, the groceries and the calendar). Never say what a line on Home already says, never touch the household's notes, never change their calendar, lists, chores or meals, and never more than one thing.
A line: at most about eight plain words; people's names, not pronouns; no emoji; "until" is when its moment passes (the time to leave, tonight, the start of the thing). Give it what a tap does: "open" the tab it's about (meals, calendar, map, lists, chores), or "ask" Opie something that settles it.
When you're done, reply with one line saying what you did, or NOTHING.`;

const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const cut = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * The picture the model gets: compact, today and tomorrow only. hv: house.js view(); notes: homeScreen.describe();
 * findings: the checks' unhandled findings (null: none asked for, as for the live voice); household: board.household().
 */
export function snapshot({ hv = {}, notes = '', findings = [], household = '', now = new Date() }) {
  const today = day(now), tmw = day(new Date(+now + 864e5));
  const when = now.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  // Times in the household's own clock: an event's start is UTC ("2026-11-22T18:00:00.000Z"), and cut to "18:00" it
  // read as 6 PM for a 1 PM practice. An all-day one is its local day (its start is local midnight, a UTC day
  // earlier east of Greenwich).
  const local = (e) => { const s = String(e.start || ''); if (s.length <= 10) return s; const d = new Date(s); if (e.allDay) return day(d); return `${day(d)} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`; };
  const ev = (hv.events || []).filter((e) => [today, tmw].includes(local(e).slice(0, 10)) || (e.start && new Date(e.start) >= now && new Date(e.start) < new Date(+now + 2 * 864e5)))
    .slice(0, 30).map((e) => `- ${local(e)}${e.allDay ? ' (all day)' : ''} ${cut(e.title, 60)}${e.who ? ` (${cut(e.who, 30)})` : ''}${e.appName ? ` [from ${cut(e.appName, 30)}]` : ''}`);
  const lists = (hv.lists || []).map((l) => { const open = (l.items || []).filter((i) => !i.done); return open.length ? `- ${cut(l.name, 30)}: ${open.slice(0, 12).map((i) => cut(i.text, 30)).join(', ')}${open.length > 12 ? ` and ${open.length - 12} more` : ''}` : null; }).filter(Boolean);
  const chores = (() => { try { return JSON.stringify(hv.chores).slice(0, 800); } catch { return ''; } })();
  const meal = (d) => { const m = hv.meals?.[d] || {}; return (hv.mealSlots || ['dinner']).map((s) => `${s}: ${cut(m[s], 40) || 'not planned'}`).join('; '); };
  return `It is ${when}.\n\nThe household:\n${cut(household, 1500)}\n\n` +
    `Calendar, today and tomorrow:\n${ev.join('\n') || '- nothing'}\n\n` +
    `Lists (still to do):\n${lists.join('\n') || '- nothing'}\n\n` +
    (chores && chores !== '[]' && chores !== '{}' ? `Chores: ${chores}\n\n` : '') +
    `Meals: today ${meal(today)}. Tomorrow ${meal(tmw)}.\n\n` +
    `${String(notes).slice(0, 2500)}` +
    (hv.things ? `\n\nThe things on Home (one line each, ids for take_down_thing):\n${hv.things.map((x) => `- ${x.id} [${x.kind}] ${x.text}`).join('\n') || '- none'}` : '') +
    (findings ? `\n\nFound by the screen's checks, not looked at yet:\n${findings.map((f) => `- [${f.kind}] ${f.text}`).join('\n') || '- nothing'}` : '');
}

const textOf = (out) => (out || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');

/**
 * One review: ai({instructions, input, tools, tier}) -> {output, usage, tier?}; callTool(name, args) -> {text, isError}.
 * At most one write (WRITES) takes effect; a second is refused. Returns { ok, said, wrote, cost, tokens, tier, error? }.
 * A failed call (Flex busy, the service down) ends it: { ok: false, error }, and the hour is skipped.
 */
export async function runReview({ ai, instructions, input, tools, callTool, tier = 'flex' }) {
  const msgs = [{ role: 'user', content: input }];
  let cost = 0, wrote = null, ran = tier;
  const tokens = { input: 0, cached: 0, output: 0 };
  for (let step = 0; step < STEPS; step++) {
    let r;
    try { r = await ai({ instructions, input: msgs, tools, tier }); }
    catch (e) { return { ok: false, error: e.code || e.message || 'failed', said: '', wrote, cost, tokens, tier: ran }; }
    ran = r.tier || 'standard'; // a service that doesn't say ran it on standard
    cost += reviewCost(r.usage, ran);
    tokens.input += r.usage?.input_tokens || 0; tokens.cached += r.usage?.input_tokens_details?.cached_tokens || 0; tokens.output += r.usage?.output_tokens || 0;
    const calls = (r.output || []).filter((o) => o.type === 'function_call');
    if (!calls.length) return { ok: true, said: textOf(r.output).trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() || '', wrote, cost, tokens, tier: ran };
    for (const c of calls) {
      let args = {}; try { args = JSON.parse(c.arguments || '{}'); } catch {}
      let out;
      if (WRITES.has(c.name) && wrote) out = { text: 'Not now: one thing per hour, and you did yours.', isError: true };
      else { out = await callTool(c.name, args); if (WRITES.has(c.name) && !out.isError) wrote = c.name; }
      msgs.push(c, { type: 'function_call_output', call_id: c.call_id, output: out.text });
    }
  }
  return { ok: true, said: '', wrote, cost, tokens, tier: ran };
}

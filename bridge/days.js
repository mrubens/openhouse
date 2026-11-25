// Each day's conversations, boiled down to a few lines and kept a week, so "what did I ask you yesterday?" works.
// What was said (by voice or typed: live-tools.js recentTalk) is written to chats/talk/<day>.jsonl as it happens; about
// once an hour, when there's something new, the text model on OpenAI's Flex tier (half price; a busy Flex skips the
// hour) rewrites that day's few lines in chats/days.json. A day's talk is deleted once it's two days old and summed up.
// Both are on the tablet only (and in its backups, with the rest of chats/); they go to OpenAI only as context.
import fs from 'node:fs';
import { readJson, writeJson } from './store.js';
import { registered } from './stores.js';
import path from 'node:path';
import { reviewCost } from './heartbeat-review.js';
import { dayKey } from './dates.js';

const DAY = 86400e3;
export const SUMMARY_RULES = 'You keep a household assistant\'s diary. Below is what was said with it on one day, by voice or typed ' +
  '(they: the household; you: the assistant), and that day\'s lines so far if there are any. Write that day\'s lines again, in at most five short ' +
  'lines, plain text, one thing per line, newest last: what they asked or told you and what came of it ("Asked how Skylight shares a ' +
  'Google calendar: it can\'t edit synced events either", "Added Dolly to daycare at 12:30, once"). Keep names, times and places. Leave ' +
  'out greetings, small talk, and anything sensitive (health, money, passwords, arguments) unless they asked you to remember it. ' +
  'Nothing worth keeping: answer with one dash.';

const textOf = (out) => (out || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');

export function dayMemory({ DIR, clock = () => Date.now(), keepDays = 7 }) {
  const TALK = path.join(DIR, 'talk'), FILE = registered('days', path.join(DIR, 'days.json'));
  let days = {};
  days = readJson(FILE, {})?.days || {};
  // The error when a save is refused or fails (marked unsaved: store.js unsaved says what to answer), else null.
  const save = () => { try { writeJson(FILE, { days }); return null; } catch (e) { console.error('[days]', e.message); return Object.assign(e, { unsaved: true }); } };
  const lines = (day) => { try { return fs.readFileSync(path.join(TALK, `${day}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

  /** One thing said or found (recentTalk's onAdd). */
  function log(x) {
    try { fs.mkdirSync(TALK, { recursive: true }); fs.appendFileSync(path.join(TALK, `${dayKey(new Date(x.at))}.jsonl`), JSON.stringify(x) + '\n'); } catch (e) { console.error('[days]', e.message); }
  }

  /** Each day with talk not yet summed up: its lines rewritten. ai({instructions, input, tools, tier}) as the hourly review's.
   *  Returns [{day, ok, cost, tier, error?}]; the caller logs the cost. */
  async function summarize({ ai, tier = 'flex' }) {
    const done = [], summed = [];
    let files = []; try { files = fs.readdirSync(TALK).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort(); } catch {}
    for (const f of files) {
      const day = f.slice(0, 10), all = lines(day), d = days[day];
      const fresh = all.filter((x) => !d || x.at > d.upto);
      if (fresh.length) {
        const talk = all.map((x) => x.role === 'tool' ? `(${x.name || 'a tool'} found: ${String(x.text).replace(/\s+/g, ' ').slice(0, 200)})` : `${x.role === 'user' ? 'They' : 'You'}: ${x.text}`).join('\n');
        let r;
        try { r = await ai({ instructions: SUMMARY_RULES, input: [{ role: 'user', content: `The day: ${day}\n\n${d?.text ? `Its lines so far:\n${d.text}\n\n` : ''}What was said:\n${talk.slice(-40000)}` }], tools: [], tier }); }
        catch (e) { done.push({ day, ok: false, cost: 0, tier, error: e.code || e.message || 'failed' }); break; } // (Flex busy: the next hour)
        const ran = r.tier || 'standard', text = textOf(r.output).trim().split('\n').map((l) => l.replace(/^[-*•]\s*/, '').trim()).filter((l) => l && l !== '-').slice(0, 5).join('\n');
        days[day] = { text, at: clock(), upto: all.at(-1).at };
        done.push({ day, ok: true, cost: reviewCost(r.usage, ran), tier: ran, tokens: r.usage });
      }
      if (clock() - new Date(`${day}T00:00:00`).getTime() > 2 * DAY && days[day]?.upto >= (all.at(-1)?.at || 0)) summed.push(f);
    }
    const oldest = dayKey(new Date(clock() - keepDays * DAY));
    for (const k of Object.keys(days)) if (k < oldest) delete days[k];
    // A day's talk goes only once its lines are on disk; lines that couldn't be saved stay in memory and are saved
    // the next time, their talk kept till then.
    if (!save()) for (const f of summed) try { fs.unlinkSync(path.join(TALK, f)); } catch {}
    return done;
  }

  /** For a conversation's instructions: today's lines, then one line for each earlier day, newest first. */
  function describe() {
    const today = dayKey(new Date(clock())), yesterday = dayKey(new Date(clock() - DAY));
    const out = [];
    for (const k of Object.keys(days).sort().reverse()) {
      const text = String(days[k].text || '').trim(); if (!text) continue;
      const name = k === today ? 'Today' : k === yesterday ? 'Yesterday' : new Date(`${k}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      out.push(k === today ? `${name}:\n${text.split('\n').map((l) => '  - ' + l).join('\n')}` : `${name}: ${text.split('\n').join('; ')}`);
    }
    return out.join('\n');
  }
  /** A day's lines taken out (Settings), and its talk with them. A save that's refused or fails changes nothing and
   *  throws (marked unsaved). */
  function forget(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || (!days[day] && !fs.existsSync(path.join(TALK, `${day}.jsonl`)))) return false;
    const was = days[day];
    delete days[day];
    const e = save(); if (e) { if (was) days[day] = was; throw e; }
    try { fs.unlinkSync(path.join(TALK, `${day}.jsonl`)); } catch {}
    return true;
  }
  return { log, summarize, describe, forget, all: () => ({ ...days }) };
}

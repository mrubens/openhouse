// Which way the typed assistant sends each request in prompts.mjs (bridge/agents/cloud.js: its first question, OpenAI
// Decisions with gpt-6-luna): to the builder ("tablet") or the household's own tools. An app's code should go to the
// builder; Grandma's birthday is a calendar event. About a hundredth of a cent each.
//   OPENAI_API_KEY=... node scripts/eval/route-check.mjs   (run.sh loads the key: SCRIPT=route-check.mjs)
import { PROMPTS } from './prompts.mjs';
import { routeFor } from '../../bridge/agents/cloud.js';

// And everyday requests that must stay the household's (a broader route mustn't pull them into the builder).
const EVERYDAY = [
  { id: 'milk', who: 'Sam', text: 'Add milk and eggs to the grocery list.', want: 'household' },
  { id: 'practice', who: 'Alex', text: 'Put soccer practice on Tuesday at 5.', want: 'household' },
  { id: 'warmer', who: 'Maya', text: 'Make the home screen warmer.', want: 'household' },
  { id: 'dinner', who: 'Leo', text: "What's for dinner tonight?", want: 'household' },
  { id: 'chore', who: 'Sam', text: 'Give Leo a new chore: feed the fish on Mondays.', want: 'household' },
  { id: 'tab-order', who: 'Alex', text: 'Move the Meals tab before Chores.', want: 'household' },
];
const want = (p) => p.want || (p.event ? 'household' : 'tablet');
let right = 0;
for (const p of [...PROMPTS, ...EVERYDAY]) {
  const r = await fetch('https://api.openai.com/v1/decisions', { method: 'POST', headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-6-luna', input: `${p.who} says: ${p.text}`, questions: routeFor([]) }), signal: AbortSignal.timeout(20e3) });
  const j = await r.json().catch(() => ({}));
  const a = j.answers?.[0];
  // Forced: the route sends it straight to the builder (tablet, sure enough: agents/cloud.js). Anything else goes to the
  // typed model, which has make_app and the household's tools both: a missed build isn't lost, a wrong one is a build.
  const forced = a?.choice === 'tablet' && (a.confidence ?? 1) >= 0.7;
  const ok = want(p) === 'tablet' ? forced : !forced;
  if (ok) right++;
  console.log(`${ok ? 'right' : want(p) === 'tablet' ? 'to the model' : 'WRONG BUILD'}  ${p.id}: ${a?.choice ?? `(${r.status} ${j.error?.message || ''})`} ${a?.confidence ?? ''}  (want ${want(p)})`);
}
console.log(`${right}/${PROMPTS.length + EVERYDAY.length} as they should be (a build forced only when it should be one)`);

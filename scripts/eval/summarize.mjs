// Tables for docs/luna-build-eval.md from one or more results.jsonl files (luna-build.mjs):
//   node scripts/eval/summarize.mjs <results.jsonl> [more...]   (rows: one per run; then rates per variant, model, kind)
import fs from 'node:fs';

const rows = process.argv.slice(2).flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const short = (m) => (m.includes('luna') ? 'Luna' : 'Terra');
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const k = (n) => `${Math.round(n / 1000)}k`;

console.log('| variant | model | request | builds | steps | in / cached / out tokens | ¢ | s |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.variant} | ${short(r.model)} | ${r.id} | ${r.builds ? 'yes' : 'no'}${r.stop ? ` (${r.stop})` : ''} | ${r.steps} | ${k(r.tokens.input)} / ${k(r.tokens.cached)} / ${(r.tokens.output / 1000).toFixed(1)}k | ${r.cents.toFixed(2)} | ${r.sec} |`);

console.log('\n| variant | model | kind | runs | builds | median ¢ | median s | median steps |');
console.log('|---|---|---|---|---|---|---|---|');
const groups = new Map();
for (const r of rows) for (const kind of [r.kind, 'all']) { const key = `${r.variant}|${short(r.model)}|${kind}`; groups.set(key, [...(groups.get(key) || []), r]); }
for (const [key, g] of [...groups].sort()) {
  const [v, m, kind] = key.split('|');
  console.log(`| ${v} | ${m} | ${kind} | ${g.length} | ${g.filter((r) => r.builds).length}/${g.length} | ${median(g.map((r) => r.cents)).toFixed(2)} | ${median(g.map((r) => r.sec))} | ${median(g.map((r) => r.steps))} |`);
}
console.log(`\nTotal: ${rows.length} runs, ${rows.reduce((s, r) => s + r.cents, 0).toFixed(1)}¢`);

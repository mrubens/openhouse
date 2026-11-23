// Makes phone-today.css from screen.css: Today's rules (between its <today> marks), each under .ptoday, so the phone's
// Today (phone.jsx) is the tablet's own at phone size. Run after changing those rules: node scripts/phone-today.mjs
// What's below the "the phone's own" line in phone-today.css is written by hand and kept.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('..', import.meta.url));
const css = fs.readFileSync(here + 'screen.css', 'utf8');
const body = css.slice(css.indexOf('/*<today>*/') + 11, css.indexOf('/*</today>*/')).replace(/\/\*[\s\S]*?\*\//g, '');
const MARK = "/* ---- the phone's own: one column, each card as tall as it needs ---- */";
const old = fs.readFileSync(here + 'phone-today.css', 'utf8');
const own = old.includes(MARK) ? old.slice(old.indexOf(MARK)) : MARK + '\n';
// a selector under .ptoday: ".dark .x" and ".hand-type .x" are states of the home screen itself, so of .ptoday here
const under = (sel) => sel.split(/,(?![^(]*\))/).map((x) => x.trim()).filter(Boolean)
  .map((x) => (/^\.(dark|hand-type|snug)\b/.test(x) ? '.ptoday' + x : '.ptoday ' + x)).join(', ');
const rules = [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, decl]) => `${under(sel)} {${decl}}`);
fs.writeFileSync(here + 'phone-today.css', `/* Today on the phone (docs/phones.md): the tablet's own Today (home.jsx Today), its rules from screen.css at phone size.
   Made by scripts/phone-today.mjs from screen.css's Today rules (.ptoday before each); don't edit above the phone's own. */
.ptoday { --u: .88px; --s: 1; --h-bg: var(--bg); --h-sheet: var(--card); --h-ink: var(--ink); --h-accent: #e2452f;
  --h-soft: color-mix(in srgb, var(--h-ink) 62%, transparent); --h-faint: color-mix(in srgb, var(--h-ink) 40%, transparent);
  --h-line: color-mix(in srgb, var(--h-ink) 10%, transparent); --h-tint: color-mix(in srgb, var(--h-ink) 6%, transparent);
  --h-shadow: 0 20px 40px -26px rgba(40,30,10,.45), 0 0 0 1px color-mix(in srgb, var(--h-ink) 4.5%, transparent); --h-lift: 0 40px 80px -20px rgba(30,20,0,.6); color: var(--h-ink); }
.ptoday.dark { --h-shadow: 0 20px 40px -24px rgba(0,0,0,.7), inset 0 0 0 1px color-mix(in srgb, var(--h-ink) 7%, transparent); }
${rules.join('\n')}
${own}`);
console.log('phone-today.css:', rules.length, 'rules');

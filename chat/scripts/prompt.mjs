import { catalog } from '../src/catalog.js';
import fs from 'node:fs';
const out = new URL('../../bridge/chat-prompt.md', import.meta.url);
// Notes show on Today (a title and their first words) and open in full: elements need no "show".
const show = 'WHERE AN ELEMENT SHOWS:\nLeave out "show" on elements: a note on Today shows its title and first words, and all of it when opened.\n\n';
fs.writeFileSync(out, catalog.prompt({ mode: 'inline' }).replace('VISIBILITY CONDITIONS:', show + 'VISIBILITY CONDITIONS:'));
console.log('wrote', out.pathname, fs.statSync(out).size, 'bytes');

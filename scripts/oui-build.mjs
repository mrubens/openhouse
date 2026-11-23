#!/usr/bin/env node
// Builds bridge/devices/oui.txt.gz (MAC prefix -> short maker name) from the IEEE registry.
//   curl -o /tmp/oui.csv https://standards-oui.ieee.org/oui/oui.csv
//   node scripts/oui-build.mjs /tmp/oui.csv
import fs from 'node:fs';
import zlib from 'node:zlib';

const csv = fs.readFileSync(process.argv[2] || '/tmp/oui.csv', 'utf8');
const rows = [];
for (const line of csv.split('\n').slice(1)) {
  const m = line.match(/^MA-L,([0-9A-F]{6}),("([^"]*)"|[^,]*)/);
  if (!m) continue;
  const name = (m[3] ?? m[2]).trim()
    .replace(/\b(co\.?,?\s*ltd\.?|corporation|corp\.?|incorporated|inc\.?|ltd\.?|limited|llc|gmbh|s\.?a\.?|ag|b\.?v\.?|pty|plc|technologies|technology|electronics|co\.)\b/gi, '')
    .replace(/[.,]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (name) rows.push(`${m[1]}\t${name.slice(0, 40)}`);
}
rows.sort();
fs.writeFileSync(new URL('../bridge/devices/oui.txt.gz', import.meta.url), zlib.gzipSync(rows.join('\n') + '\n', { level: 9 }));
console.log(`${rows.length} prefixes`);

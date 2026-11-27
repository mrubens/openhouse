#!/usr/bin/env node
// The Opie plugin for ChatGPT and the Claude apps (docs/workshop-mcp.md, "The Opie plugin"), made from the
// workshop's guide (bridge/workshop-guide.js), the same source as get_guide and the skills the connector serves:
//   connect/plugin/                       the plugin: skills/<name>/..., the connector (cloud.opie.house/mcp)
//     .claude-plugin/plugin.json          Claude's manifest            .mcp.json   Claude's connector
//     plugin.json                         OpenAI's portable manifest   mcp.json    OpenAI's connector
//   .claude-plugin/marketplace.json       the repo as a marketplace for Claude (and OpenAI's Claude-compatible reading)
//   .agents/plugins/marketplace.json      the repo as a marketplace for ChatGPT and Codex
// Only the bridge's own text goes in: nothing of a household. Its version is the guide's (a hash of the skills), so the
// connector can tell a model its copy is old.
//   node scripts/build-plugin.mjs           write them
//   node scripts/build-plugin.mjs --check   exit 1 if what's committed isn't what the guide makes now
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workshopGuide } from '../bridge/workshop-guide.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'bridge');
const read = (f) => fs.readFileSync(path.join(BRIDGE, f), 'utf8');
const g = workshopGuide({ read, homeNow: () => { throw new Error('the plugin never carries the home screen'); } });

const NAME = 'openhouse';
const VERSION = `1.0.0+${g.version()}`;
const CONNECTOR = 'https://cloud.opie.house/mcp';
const DESCRIPTION = "Change your household's Opie from ChatGPT or Claude: how its apps, tabs and notes are made (skills) and the connector to your tablet.";
const REPO = 'https://github.com/mrubens/opie';
const author = { name: 'Opie', url: 'https://openhouse.computer' };
const json = (o) => JSON.stringify(o, null, 2) + '\n';

const files = {};
const put = (rel, text) => { files[rel] = text; };
for (const [rel, text] of Object.entries(g.pluginSkills())) put(`connect/plugin/skills/${rel}`, text);
put('connect/plugin/.claude-plugin/plugin.json', json({ name: NAME, version: VERSION, description: DESCRIPTION, author, homepage: 'https://openhouse.computer', repository: REPO, license: 'MIT', keywords: ['openhouse', 'household', 'tablet'] }));
put('connect/plugin/.mcp.json', json({ mcpServers: { openhouse: { type: 'http', url: CONNECTOR } } }));
put('connect/plugin/plugin.json', json({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: NAME, version: VERSION, description: DESCRIPTION, author, homepage: 'https://openhouse.computer', repository: REPO, license: 'MIT', keywords: ['openhouse', 'household', 'tablet'],
  extensions: { 'com.openai': { interface: { displayName: 'Opie', shortDescription: 'Change your Opie tablet', longDescription: DESCRIPTION, developerName: 'Opie', category: 'Productivity', capabilities: ['Read', 'Write'], websiteURL: 'https://openhouse.computer' } } },
}));
put('connect/plugin/mcp.json', json({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: { openhouse: { type: 'streamable-http', url: CONNECTOR, extensions: { 'com.openai': { auth: { type: 'oauth', client: { mode: 'dcr' }, registrationUrl: 'https://cloud.openhouse.computer/oauth/register' } } } } },
}));
put('connect/plugin/README.md', `# The Opie plugin

Made by \`scripts/build-plugin.mjs\` from the tablet's guide (\`bridge/workshop-guide.js\`); don't edit it by hand.
Guide version ${g.version()}. How it works: [docs/workshop-mcp.md](../../docs/workshop-mcp.md).

Claude Code (which also gets these skills from the connector itself, so it needs this only for the connector):

    /plugin install openhouse --marketplace mrubens/opie

The Claude apps: Customize > Plugins > Add marketplace, \`mrubens/opie\`. ChatGPT: a workspace admin imports the
marketplace from this repository (Plugins > Add > Import marketplace). Codex: \`codex plugin marketplace add mrubens/opie\`.
`);
put('.claude-plugin/marketplace.json', json({ name: 'openhouse', description: 'Opie, the household tablet', owner: author, plugins: [{ name: NAME, source: './connect/plugin', description: DESCRIPTION }] }));
put('.agents/plugins/marketplace.json', json({ name: 'openhouse', interface: { displayName: 'Opie' }, plugins: [{ name: NAME, source: { source: 'local', path: './connect/plugin' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }));

const check = process.argv.includes('--check');
const dir = path.join(ROOT, 'connect/plugin/skills');
const old = [];
(function walk(d) { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : old.push(path.relative(ROOT, p)); } })(dir);
const stale = [...Object.entries(files).filter(([rel, t]) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8') !== t; } catch { return true; } }).map(([r]) => r), ...old.filter((r) => !(r in files))];
if (check) { if (stale.length) { console.log(`The plugin is out of date (node scripts/build-plugin.mjs): ${stale.join(', ')}`); process.exit(1); } console.log(`The plugin is up to date (guide ${g.version()}).`); process.exit(0); }
for (const r of old.filter((r) => !(r in files))) fs.rmSync(path.join(ROOT, r));
for (const [rel, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true }); fs.writeFileSync(path.join(ROOT, rel), t); }
console.log(`Wrote the Opie plugin, guide ${g.version()} (${stale.length} files changed).`);

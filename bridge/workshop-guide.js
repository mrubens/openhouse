// The workshop's guidance, from one source for both ways a computer's AI reads it (docs/workshop-mcp.md, "Skills"):
//   get_guide {topic}   a tool, for every client: the topic's text, and for "start" the home screen as it is now.
//   skills              MCP's skills extension (io.modelcontextprotocol/skills, revision 2026-07-28): each topic as a
//                       skill://<name>/SKILL.md the client loads only when it needs it, with supporting files.
// A skill is only the bridge's own files (WORKSHOP.md, AGENT.md, NOTES.md, PLUGINS.md, DESIGN.md, the quiet kit): nothing
// of the household, so it can't tell a caller more than get_guide does. What is the household's (its tabs, look and apps)
// stays in get_guide, which every topic's text points to.
import crypto from 'node:crypto';

const HOME_SECTIONS = ["Change what's there first", 'The home screen'];
const APP_SECTIONS = ['The screen', 'Note or app', "The family's things", 'Icons', 'Apps and games'];
const sha = (t) => `sha256:${crypto.createHash('sha256').update(t, 'utf8').digest('hex')}`;
const NOW = 'For the home screen as it is now (its tabs, look and apps, and which tab the tablet is showing), call get_guide with topic "home".';

export function workshopGuide({ read, homeNow }) {
  // The tablet assistant's rules (AGENT.md), as they apply on a computer: by section, without the ones about the tablet
  // itself (its other apps and devices, its own reply rules, the code layout it sees), and with no Edit tool to use.
  function agentSections(names) {
    const parts = read('AGENT.md').split(/^(?=## )/m);
    return parts.filter((p) => names.some((n) => p.startsWith(`## ${n}`))).join('\n')
      .replace(/ The message tells you what they're\s+looking at \(([^)]*)\); "this" and "it" mean that\./, ' The home screen as it is now (get_guide) says which tab the tablet is showing ($1); "this" and "it" usually mean that.')
      .replace(/\(the current one is in the message\)/, '(the current ones are in get_guide)')
      .replace(/write them all in one turn, so it appears\s+right away; then improve it with Edit\./, 'write them all first, so it appears right away; then improve it.')
      .replace(/ It runs\s+full screen as its own installed Android app with an icon on the board, and opens automatically while you build it\./, '');
  }
  const css = () => read('kit/quiet.css');

  // Each topic: its skill (name, description, body, files) and its get_guide text. `files` are paths in the skill's
  // folder; get_guide gives the same text inline.
  const TOPICS = {
    start: {
      skill: 'working-here',
      description: "How to work on this household's OpenHouse tablet from a computer: which tools to use, in what order, for the tabs and look, notes, an app, waiting fixes, undo and devices, and the rules. Load before changing anything on the OpenHouse.",
      body: () => [read('WORKSHOP.md'), '# Changing the home screen\n\n' + agentSections(HOME_SECTIONS), NOW,
        'How notes on Today should read: the notes skill. Making or changing an app: the apps skill.'].join('\n\n---\n\n'),
      guide: () => [read('WORKSHOP.md'), '# The home screen right now\n\n' + homeNow(), '# Changing the home screen\n\n' + agentSections(HOME_SECTIONS),
        '# Notes on Today\n\n' + read('NOTES.md')].join('\n\n---\n\n'),
    },
    apps: {
      skill: 'apps',
      description: "How apps are made on OpenHouse, before making or changing one: everyday tools that fit a tab, games, the kit for the household's data, icons, app.json, the quiet kit's CSS and how a tab should look.",
      body: () => ['# How apps are made on OpenHouse (paths are relative to the apps folder)\n\n' + agentSections(APP_SECTIONS),
        'The quiet kit (`/kit/quiet.css`, linked after `/kit/openhouse.css` in an everyday tool) is in references/quiet.css: read it before writing one. ' +
        'How a tab should look is in references/design.md: check what you made against it before calling it done. ' + NOW].join('\n\n---\n\n'),
      files: { 'references/quiet.css': css, 'references/design.md': () => read('DESIGN.md') },
      guide: () => ['# How apps are made on OpenHouse (paths are relative to the apps folder)\n\n' + agentSections(APP_SECTIONS),
        read('DESIGN.md'), '# /kit/quiet.css (link it after /kit/openhouse.css in an everyday tool)\n\n```css\n' + css() + '\n```'].join('\n\n---\n\n'),
    },
    notes: {
      skill: 'notes',
      description: 'How a note on the OpenHouse Today tab should read (title, first line, what to leave out), before putting one up or changing one.',
      body: () => read('NOTES.md'),
    },
    plugins: {
      skill: 'plugins',
      description: "OpenHouse plugins: finding, adding, updating and removing them, OpenHouse's own apps versus the household's versions, and sharing the household's apps as a plugin.",
      body: () => read('PLUGINS.md'),
    },
    design: {
      skill: 'design',
      description: 'How an OpenHouse tab or everyday app should look (color, accents, buttons, panels, type sizes, touch targets), for restyling one or checking a new one.',
      body: () => read('DESIGN.md'),
    },
  };
  const TOPIC_NAMES = [...Object.keys(TOPICS), 'home'];

  /** get_guide's answer for a topic ("start" when unknown). */
  function guide(topic) {
    if (topic === 'home') return '# The home screen right now\n\n' + homeNow();
    const t = TOPICS[topic] || TOPICS.start;
    return (t.guide || t.body)();
  }

  // ---- skills (MCP skills extension) ----
  const yaml = (s) => JSON.stringify(s); // a JSON string is a valid YAML double-quoted scalar
  /** Every file of every skill: uri -> { text, mimeType }. Made on each call, from the files as they are now. */
  function files() {
    const out = new Map();
    for (const t of Object.values(TOPICS)) {
      const root = `skill://${t.skill}`;
      out.set(`${root}/SKILL.md`, { text: `---\nname: ${t.skill}\ndescription: ${yaml(t.description)}\n---\n\n${t.body()}\n`, mimeType: 'text/markdown' });
      for (const [p, f] of Object.entries(t.files || {})) out.set(`${root}/${p}`, { text: f(), mimeType: p.endsWith('.css') ? 'text/css' : 'text/markdown' });
    }
    return out;
  }
  function entry(t, all) {
    const root = `skill://${t.skill}/`;
    return { uri: `${root}SKILL.md`, frontmatter: { name: t.skill, description: t.description },
      resources: [...all].filter(([u]) => u.startsWith(root)).map(([uri, f]) => ({ uri, digest: sha(f.text), size: Buffer.byteLength(f.text) })) };
  }
  const skills = {
    list: () => { const all = files(); return Object.values(TOPICS).map((t) => entry(t, all)); },
    get: (uri) => { const t = Object.values(TOPICS).find((x) => `skill://${x.skill}/SKILL.md` === uri); return t ? entry(t, files()) : null; },
    read: (uri) => files().get(uri) || null,
    /** The topic a skill's file belongs to (to know a computer read how apps are made). */
    topicOf: (uri) => Object.entries(TOPICS).find(([, t]) => String(uri).startsWith(`skill://${t.skill}/`))?.[0] || null,
  };
  return { guide, topics: TOPIC_NAMES, skills, agentSections };
}

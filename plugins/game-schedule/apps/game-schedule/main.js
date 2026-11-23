// Game days: each team's games from its calendar link, on the family's calendar as events of this app's own
// (kit events.set: read-only there, "From Game days"), with the kid's name and the place; and on a game day a line
// on Today with when to leave ("Sam's soccer: leave by 5:35 for 6:00 at Lincoln Park"), from the drive time the
// household gives each team. The voice answers "when's the next game?". Runs in the background, reading the feeds a
// few times a day.
import { house, store, today, events, web, onAction } from '/kit/openhouse.js';
import { h, sheet, field, dayKey, addDays, hm, whenDay, monthDay, weekday, and, put, whenShown } from './ui.js';
import { feedUrl, readIcs } from './ics.js';

const $app = document.getElementById('app');
let teams = [];   // [{id, name, who, link, drive (minutes), early (minutes)}] (store "teams")
let games = {};   // {teamId: {list: [...], at, error}} (store "games")
let family = [], loading = false;

const startOf = (g) => new Date(g.start.at || `${g.start.date}T12:00`);
const upcoming = () => teams.flatMap((t) => (games[t.id]?.list || []).map((g) => ({ ...g, team: t })))
  .filter((g) => (g.start.at ? startOf(g).getTime() > Date.now() - 3 * 3600e3 : g.start.date >= dayKey())).sort((a, b) => startOf(a) - startOf(b));
const leaveBy = (g) => (g.start.at && g.team.drive ? new Date(Math.floor((startOf(g) - (g.team.drive + (g.team.early || 0)) * 60e3) / 300e3) * 300e3) : null);
const label = (t) => (t.who ? `${t.who}’s ${t.name}` : t.name);

async function refresh({ force = false } = {}) {
  if (loading || !teams.length) { update(); return; }
  if (!force && teams.every((t) => games[t.id]?.at && Date.now() - games[t.id].at < 4 * 3600e3)) { update(); return; }
  loading = true; draw();
  for (const t of teams) {
    try {
      const r = await web.get(feedUrl(t.link));
      if (r.status !== 200 || !/BEGIN:VCALENDAR/.test(r.text)) throw new Error('not a calendar');
      games[t.id] = { list: readIcs(r.text).filter((g) => (g.start.date || g.start.at.slice(0, 10)) >= addDays(dayKey(), -14)).slice(0, 200), at: Date.now() };
    } catch (e) { games[t.id] = { ...(games[t.id] || { list: [] }), error: String(e.message || e).slice(0, 120) }; }
  }
  for (const k of Object.keys(games)) if (!teams.some((t) => String(t.id) === k)) delete games[k];
  loading = false;
  await store.set('games', games);
  update();
}

// ---- the calendar and Today ----
let evFor = null, lineFor = null;
function update() {
  const list = teams.flatMap((t) => (games[t.id]?.list || []).map((g) => ({
    ...(g.start.at ? { start: g.start.at, ...(g.end?.at ? { end: g.end.at } : {}) } : { date: g.start.date, allDay: true }),
    title: `${t.name}: ${g.title}`.slice(0, 120), ...(g.place ? { place: g.place } : {}), ...(t.who ? { who: t.who } : {}) })));
  const k = JSON.stringify(list);
  if (k !== evFor) { evFor = k; events.set(list); }
  // a game today: when to leave (or when it is, with no drive time), until it starts
  const g = upcoming().find((x) => x.start.at && x.start.at.slice(0, 10) === dayKey() && startOf(x) > Date.now());
  let text = '';
  if (g) { const lb = leaveBy(g); text = `${label(g.team)}: ${lb ? `leave by ${hm(lb)} for ${hm(startOf(g))}` : `${g.title} at ${hm(startOf(g))}`}${g.place ? ` at ${g.place.split(',')[0]}` : ''}`.slice(0, 80); }
  if (text !== lineFor) { lineFor = text; if (text) today.show(text, startOf(g)); else today.clear(); }
  draw();
}

// ---- the page ----
function draw() {
  const top = h('div', { class: 'top' }, h('h1', { class: 'title' }, 'Game days'), h('button', { class: teams.length ? 'btn soft' : 'btn', tap: openTeams }, teams.length ? 'Teams' : 'Add a team'));
  if (!teams.length) {
    put($app, top, h('div', { class: 'empty' },
      h('p', { class: 'lead' }, 'Every game on the calendar, and when to leave.'),
      h('p', { class: 'soft' }, 'Team apps like TeamSnap, GameChanger and SportsEngine give each team a calendar link (Export, Subscribe or Sync to calendar). Paste it here with whose team it is, and how long the drive usually takes.'),
      h('button', { class: 'btn', tap: openTeams }, 'Add a team')));
    return;
  }
  const list = upcoming().slice(0, 14), err = teams.find((t) => games[t.id]?.error);
  put($app, top, h('div', { class: 'body' }, list.length ? list.map((g) => { const lb = leaveBy(g); const day = g.start.at ? g.start.at.slice(0, 10) : g.start.date;
    return h('div', { class: 'line' },
      h('span', { class: 'when' }, whenDay(day).replace(/^./, (c) => c.toUpperCase()), h('span', { class: 'side' }, ` ${g.start.at ? hm(startOf(g)) : ''}`)),
      h('span', { class: 'grow' }, h('span', { class: 'dot', style: `background:${house.color(g.team.who)}` }), `${label(g.team)}: ${g.title}`, g.place ? h('span', { class: 'side' }, ` · ${g.place}`) : null),
      lb ? h('span', { class: 'side' }, `leave ${hm(lb)}`) : null); })
    : h('p', { class: 'soft' }, loading ? 'Reading the schedules…' : 'No games coming up.')),
  h('div', { class: 'foot' }, err ? `Couldn’t read ${err.name}’s calendar link (${games[err.id].error}).` : 'Games are on the Calendar too, from Game days. Leave-by times use the drive you gave each team.'));
}

function openTeams() {
  const rows = h('div', { class: 'row' });
  const drawRows = () => put(rows, ...teams.map((t) => h('div', { class: 'line' }, h('span', { class: 'grow' }, label(t)), h('span', { class: 'side' }, t.drive ? `${t.drive} min drive` : 'no drive time'),
    h('button', { class: 'x', 'aria-label': 'Take off', tap: async () => { teams = teams.filter((x) => x !== t); await store.set('teams', teams); drawRows(); refresh({ force: true }); } }, '×'))));
  drawRows();
  const who = h('select', { class: 'field' }, ['', ...family].map((n) => h('option', { value: n }, n || 'Nobody in particular')));
  const name = h('input', { class: 'field', placeholder: 'Soccer' });
  const link = h('input', { class: 'field', placeholder: 'webcal://… or https://…', autocapitalize: 'off', spellcheck: 'false' });
  const drive = h('input', { class: 'field', type: 'number', inputmode: 'numeric', placeholder: '15', min: '0', max: '240' });
  const early = h('input', { class: 'field', type: 'number', inputmode: 'numeric', value: '15', min: '0', max: '120' });
  const msg = h('span', { class: 'hint' });
  sheet('Teams', [rows, h('div', { class: 'pair' }, field('Whose', who), field('The team', name)), field('Its calendar link', link, 'In TeamSnap: Schedule, then Export or Subscribe. GameChanger: Schedule, Sync to calendar. SportsEngine and LeagueApps: Subscribe to calendar. A Google Calendar’s secret address in iCal format works too.'),
    h('div', { class: 'pair' }, field('Drive there, minutes', drive), field('Be there early by, minutes', early)), msg], [
    { text: 'Done', soft: true, tap: (c) => c() },
    { text: 'Add team', tap: async () => {
      const url = feedUrl(link.value);
      if (!url || !name.value.trim()) { msg.textContent = 'Give the team a name and its calendar link.'; msg.classList.add('bad'); return; }
      msg.textContent = 'Reading it…'; msg.classList.remove('bad');
      try { const r = await web.get(url); if (!/BEGIN:VCALENDAR/.test(r.text)) throw 0; }
      catch { msg.textContent = 'Couldn’t read a calendar from that link. Team apps from TeamSnap, GameChanger, SportsEngine, LeagueApps, Google, iCloud and Outlook work.'; msg.classList.add('bad'); return; }
      teams.push({ id: Date.now(), name: name.value.trim().slice(0, 30), who: who.value, link: link.value.trim(), drive: Math.round(Number(drive.value) || 0), early: Math.round(Number(early.value) || 0) });
      await store.set('teams', teams); name.value = ''; link.value = ''; msg.textContent = 'Added.'; drawRows(); refresh({ force: true });
    } }]);
}

// ---- the voice ----
async function answer({ who }) {
  if (!teams.length) return 'No teams are set up in Game days yet.';
  for (let i = 0; loading && i < 40; i++) await new Promise((r) => setTimeout(r, 250)); // the schedules being read now
  if (teams.some((t) => !games[t.id]?.at)) await refresh({ force: true });
  const w = String(who || '').toLowerCase().split(' ')[0];
  const g = upcoming().find((x) => !w || x.team.who.toLowerCase().startsWith(w) || x.team.name.toLowerCase().includes(w));
  if (!g) return `No games coming up${who ? ` for ${who}` : ''}.`;
  const day = g.start.at ? g.start.at.slice(0, 10) : g.start.date, lb = leaveBy(g);
  return `${label(g.team)}: ${g.title}, ${whenDay(day)}${g.start.at ? ` at ${hm(startOf(g))}` : ''}${g.place ? `, at ${g.place}` : ''}.${lb ? ` Leave by ${hm(lb)}.` : ''}`;
}

(async () => {
  teams = (await store.get('teams')) || [];
  games = (await store.get('games')) || {};
  house.subscribe((hv) => { family = (hv.family || []).map((p) => p.name).filter(Boolean); });
  update();
  whenShown(() => onAction((name, args) => (name === 'next_game' ? answer(args) : null)));
  refresh();
  setInterval(refresh, 20 * 60e3);
})();

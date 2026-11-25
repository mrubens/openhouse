// Bedtime: at the household's bedtime, Today asks ("Bedtime at 7:30: tap to start", and a card with a button). On a yes
// the scene runs: the speakers turn down, the TV goes off, lights dim, each through the tablet's own device drivers
// (kit devices). The tablet asks the people here the first time this app controls a device, and every time for
// anything risky; this app never answers for them. Then the bedtime routine from Chores shows, to tick through.
import { house, store, today, devices, onAction } from '/kit/openhouse.js';
import { h, sheet, field, hm, at, dayKey, put, whenShown } from './ui.js';
import { choicesFor, runScene } from './scene.js';

const $app = document.getElementById('app');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let setup = null;  // {time: 'HH:MM', days, routine: checklist id | null, steps: {deviceId: {choice, level}}}
let ran = null;    // {day, results: [{name, ok, text}]} (store "ran")
let list = [], checklists = [], family = [], running = false;

const bedtime = (d = new Date()) => setup && at(setup.time, d);
const near = (d = new Date()) => setup && setup.days.includes(d.getDay()) && d >= new Date(bedtime(d) - 15 * 60e3) && d < new Date(bedtime(d).getTime() + 90 * 60e3);
const doneToday = () => ran?.day === dayKey();
const routine = () => checklists.find((c) => c.id === setup?.routine) || null;

// ---- Today asks ----
let lineFor = null;
function line() {
  const text = near() && !doneToday() ? `Bedtime at ${hm(bedtime())}: tap to start the bedtime scene` : '';
  if (text === lineFor) return;
  lineFor = text;
  if (text) today.show(text, new Date(bedtime().getTime() + 90 * 60e3), { sleep: false }); else today.clear(); // a button to press: Home only, not the sleep screen
}

async function run() {
  if (running || !setup) return null;
  running = true; draw();
  const results = await runScene(devices, setup);
  ran = { day: dayKey(), results };
  await store.set('ran', ran);
  running = false; lineFor = null; line(); draw();
  return results;
}

function draw() {
  const top = h('div', { class: 'top' }, h('h1', { class: 'title' }, 'Bedtime'), h('button', { class: setup ? 'btn soft' : 'btn', tap: openSetup }, setup ? 'Scene and time' : 'Set up'));
  if (!setup) {
    put($app, top, h('div', { class: 'empty' },
      h('p', { class: 'lead' }, 'One tap at bedtime: the speakers down, the TV off, and the routine up.'),
      h('p', { class: 'soft' }, 'Pick the time, what each speaker and TV should do, and the bedtime routine from Chores. At bedtime Today asks; nothing changes until someone says yes.'),
      h('button', { class: 'btn', tap: openSetup }, 'Set up bedtime')));
    return;
  }
  const r = routine();
  put($app, top, h('div', { class: 'cols', style: '--n:2' },
    h('section', { class: 'part' },
      h('div', { class: 'label' }, `Bedtime ${setup.days.map((d) => DAYS[d]).join(', ')}`), h('div', { class: 'big' }, hm(bedtime())),
      h('button', { class: 'btn go', disabled: running, tap: run }, running ? 'Starting…' : doneToday() ? 'Run it again' : 'Start bedtime'),
      doneToday() ? h('div', { class: 'results' }, ran.results.length ? ran.results.map((x) => h('div', { class: 'line' }, h('span', { class: 'grow' }, x.name), h('span', { class: 'side' + (x.ok ? '' : ' bad') }, x.text))) : h('p', { class: 'soft' }, 'No devices in the scene: Scene and time picks them.')) : null,
      h('p', { class: 'hint' }, 'The tablet asks before this app controls a device the first time, and every time before turning anything on.')),
    h('section', { class: 'part' }, h('div', { class: 'label' }, r ? r.name : 'The routine'),
      r ? r.steps.map((s, i) => { const whoFor = r.who?.length ? r.who : family.slice(0, 1);
        return h('div', { class: 'step' }, h('span', { class: 'grow' }, s.text), whoFor.map((w) => { const done = (r.done || []).includes(`${i}|${w}`);
          return h('button', { class: 'chip' + (done ? ' on' : ''), tap: () => house.checkStep(r.id, i, w, !done) }, w); })); })
        : h('p', { class: 'soft' }, checklists.length ? 'Pick a routine in Scene and time.' : 'Make a bedtime routine in Chores (Routines), then pick it here.'))));
}

async function openSetup() {
  list = await devices.list();
  const s = setup ? structuredClone(setup) : { time: '19:30', days: [0, 1, 2, 3, 4, 5, 6], routine: null, steps: {} };
  const time = h('input', { class: 'field', type: 'time', value: s.time });
  const days = h('div', { class: 'actions' }, DAYS.map((d, i) => { const b = h('button', { class: 'chip' + (s.days.includes(i) ? ' on' : ''), tap: () => { s.days = s.days.includes(i) ? s.days.filter((x) => x !== i) : [...s.days, i].sort(); b.classList.toggle('on'); } }, d); return b; }));
  const devs = list.filter((d) => choicesFor(d).length > 1).map((d) => { const st = (s.steps[d.id] ||= { choice: '', level: 15 });
    const lv = h('input', { class: 'field', type: 'number', min: '0', max: '100', value: String(st.level), hidden: !['quiet', 'dim'].includes(st.choice), oninput: (e) => { st.level = Math.max(0, Math.min(100, Number(e.target.value) || 0)); } });
    return h('div', { class: 'pair' }, h('span', {}, d.name, h('span', { class: 'hint' }, d.room ? ` · ${d.room}` : '')),
      h('select', { class: 'field', onchange: (e) => { st.choice = e.target.value; lv.hidden = !['quiet', 'dim'].includes(st.choice); } }, choicesFor(d).map((c) => h('option', { value: c.value, selected: c.value === st.choice }, c.text))), lv); });
  const rt = h('select', { class: 'field' }, [h('option', { value: '' }, 'None'), ...checklists.map((c) => h('option', { value: c.id, selected: c.id === s.routine }, c.name))]);
  sheet('Bedtime', [h('div', { class: 'pair' }, field('Bedtime', time), field('Routine from Chores', rt)), field('Days', days),
    field('The scene', h('div', { class: 'row' }, devs.length ? devs : h('span', { class: 'hint' }, 'The tablet doesn’t control any speakers, TVs or lights yet: add them in Settings, Devices.')), 'For Turn down and Dim, the number is the volume or brightness, 0 to 100.'),
    setup ? h('button', { class: 'btn soft', tap: async () => { setup = null; await store.set('setup', null); document.querySelector('.scrim')?.remove(); lineFor = null; today.clear(); draw(); } }, 'Stop bedtime') : null], [
    { text: 'Cancel', soft: true, tap: (c) => c() },
    { text: 'Save', tap: async (c) => { setup = { ...s, time: time.value || '19:30', routine: rt.value || null, days: s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6] }; await store.set('setup', setup); c(); lineFor = null; line(); draw(); } }]);
}

(async () => {
  setup = await store.get('setup');
  ran = await store.get('ran');
  draw();
  house.subscribe((hv) => { checklists = hv.checklists || []; family = (hv.family || []).map((p) => p.name).filter(Boolean); draw(); });
  list = await devices.list();
  whenShown(() => onAction(async (name) => {
    if (name !== 'start') return null;
    if (!setup) return 'Bedtime isn’t set up yet: pick the scene in the Bedtime app.';
    const r = await run();
    const ok = (r || []).filter((x) => x.ok).length;
    return r?.length ? `Bedtime: ${ok} of ${r.length} done${routine() ? `, and the ${routine().name} routine is up` : ''}. Sleep well.` : `Bedtime${routine() ? `: the ${routine().name} routine is up` : ''}. Sleep well.`;
  }));
  line();
  setInterval(line, 60e3);
  setInterval(async () => { const r = await store.get('ran'); if (r?.day !== ran?.day) { ran = r; draw(); } }, 60e3);
})();

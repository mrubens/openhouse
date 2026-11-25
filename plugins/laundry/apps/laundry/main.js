// Laundry: says when the wash is done. With a smart plug the tablet can read (a device whose state reports its power),
// it watches the washer's or dryer's power and knows by itself: running, then done (watch.js). Without one, "the
// washer's on" (or a tap) starts a timer for the usual cycle. Either way, when it's done: a line on Home, and the
// tablet says so out loud. Runs in the background.
import { store, today, devices, say, timer, onAction } from '/kit/openhouse.js';
import { h, sheet, field, hm, put, whenShown } from './ui.js';
import { wattsOf, isPlug, step } from './watch.js';

const $app = document.getElementById('app');
const MACHINES = { washer: 'The wash', dryer: 'The dryer' };
let setup = { washer: { plug: null, minutes: 55 }, dryer: { plug: null, minutes: 60 }, aloud: true };
let state = {};   // {washer: {phase, since, endsAt?}, dryer: …} (store "state")
let plugs = [];   // devices that report power
let watts = {};   // latest reading per machine

async function look() {
  state = (await store.get('state')) || {};
  const all = await devices.list({ state: true });
  plugs = all.filter(isPlug);
  for (const m of Object.keys(MACHINES)) {
    const p = setup[m].plug && all.find((d) => d.id === setup[m].plug);
    const now = Date.now(), s = state[m] || { phase: 'idle', since: now };
    if (p) {
      watts[m] = wattsOf(p.state);
      const next = step(s, watts[m], now);
      if (next.phase === 'done' && s.phase !== 'done') finished(m);
      state[m] = next;
    } else if (s.phase === 'running' && s.endsAt && now >= s.endsAt) { state[m] = { phase: 'done', since: now }; finished(m); }
  }
  await store.set('state', state);
  line(); draw();
}

function finished(m) { if (setup.aloud) say(`${MACHINES[m]} is done.`); }
function line() {
  const done = Object.keys(MACHINES).filter((m) => state[m]?.phase === 'done' && Date.now() - state[m].since < 3 * 3600e3);
  const text = done.length ? `${done.map((m) => MACHINES[m]).join(' and ')} ${done.length > 1 ? 'are' : 'is'} done (${hm(state[done[0]].since)})` : '';
  if (text !== lineFor) { lineFor = text; if (text) today.show(text, state[done[0]].since + 3 * 3600e3); else today.clear(); }
}
let lineFor = null;

async function started(m, minutes = null) {
  state = (await store.get('state')) || {};
  const min = minutes || setup[m].minutes;
  state[m] = { phase: 'running', since: Date.now(), ...(setup[m].plug ? {} : { endsAt: Date.now() + min * 60e3 }) };
  if (!setup[m].plug) timer.start(m === 'washer' ? 'Wash' : 'Dryer', min * 60);
  await store.set('state', state); line(); draw();
}
async function emptied(m) { state = (await store.get('state')) || {}; state[m] = { phase: 'idle', since: Date.now() }; await store.set('state', state); line(); draw(); }

function draw() {
  const top = h('div', { class: 'top' }, h('h1', { class: 'title' }, 'Laundry'), h('button', { class: 'btn soft', tap: openSetup }, 'Plugs and times'));
  put($app, top, h('div', { class: 'cols', style: '--n:2' }, Object.keys(MACHINES).map((m) => {
    const s = state[m] || { phase: 'idle' }, plug = setup[m].plug && plugs.find((d) => d.id === setup[m].plug);
    return h('section', { class: 'part' }, h('div', { class: 'label' }, m === 'washer' ? 'Washer' : 'Dryer'),
      h('div', { class: 'big' }, s.phase === 'running' ? 'Running' : s.phase === 'done' ? 'Done' : 'Off'),
      h('p', { class: 'soft' }, s.phase === 'running' ? (s.endsAt ? `Done about ${hm(s.endsAt)}` : `Since ${hm(s.since)}`) : s.phase === 'done' ? `Since ${hm(s.since)}` : ''),
      plug ? h('p', { class: 'soft' }, `Watching ${plug.name}${watts[m] != null ? `: ${Math.round(watts[m])} W now` : ''}.`) : h('p', { class: 'hint' }, `No plug: tap Started, or say “the ${m} is on”, for a ${setup[m].minutes} minute timer.`),
      h('div', { class: 'actions' },
        !plug && s.phase !== 'running' ? h('button', { class: 'btn', tap: () => started(m) }, 'Started') : null,
        s.phase !== 'idle' ? h('button', { class: 'btn soft', tap: () => emptied(m) }, s.phase === 'done' ? 'Emptied' : 'Stop') : null));
  })), h('div', { class: 'foot' }, plugs.length ? `${plugs.length} plug${plugs.length > 1 ? 's' : ''} the tablet can read.` : 'The tablet doesn’t know a smart plug that reports power yet. When one is added (Settings, Devices), pick it in Plugs and times and this watches it by itself.'));
}

async function openSetup() {
  plugs = (await devices.list({ state: true })).filter(isPlug);
  const s = structuredClone(setup);
  const row = (m) => h('div', { class: 'pair' }, field(m === 'washer' ? 'Washer’s plug' : 'Dryer’s plug', h('select', { class: 'field', onchange: (e) => { s[m].plug = e.target.value || null; } },
    [h('option', { value: '' }, 'None (a timer)'), ...plugs.map((p) => h('option', { value: p.id, selected: p.id === s[m].plug }, p.name))])),
    field('Usual cycle, minutes', h('input', { class: 'field', type: 'number', min: '10', max: '240', value: String(s[m].minutes), oninput: (e) => { s[m].minutes = Math.max(10, Math.min(240, Number(e.target.value) || 55)); } })));
  const aloud = h('select', { class: 'field' }, h('option', { value: 'yes', selected: s.aloud }, 'Say it out loud too'), h('option', { value: 'no', selected: !s.aloud }, 'Only on Home'));
  sheet('Plugs and times', [row('washer'), row('dryer'), field('When it’s done', aloud),
    h('p', { class: 'hint' }, plugs.length ? 'A plug is watched for its power: running once it uses more than a few watts for two minutes, done once it’s used almost nothing for four.' : 'No smart plug that reports power yet, so both use a timer.')], [
    { text: 'Cancel', soft: true, tap: (c) => c() },
    { text: 'Save', tap: async (c) => { setup = { ...s, aloud: aloud.value === 'yes' }; await store.set('setup', setup); c(); look(); } }]);
}

(async () => {
  setup = { ...setup, ...((await store.get('setup')) || {}) };
  state = (await store.get('state')) || {};
  draw();
  whenShown(() => onAction(async (name, { machine = 'washer', minutes } = {}) => {
    const m = MACHINES[machine] ? machine : 'washer';
    if (name === 'started') {
      if (setup[m].plug) return `I’m watching the ${m}’s plug, so I’ll know when it’s done.`;
      await started(m, minutes); return `OK, the ${m} should be done about ${hm(state[m].endsAt)}.`;
    }
    if (name === 'status') {
      state = (await store.get('state')) || {};
      const s = state[m] || { phase: 'idle' };
      return s.phase === 'running' ? `The ${m} is running${s.endsAt ? `, done about ${hm(s.endsAt)}` : ` since ${hm(s.since)}`}.` : s.phase === 'done' ? `The ${m} finished at ${hm(s.since)}.` : `The ${m} isn’t running.`;
    }
    if (name === 'emptied') { await emptied(m); return `OK.`; }
    return null;
  }));
  look();
  setInterval(look, 30e3);
})();

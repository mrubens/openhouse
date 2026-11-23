// For the sitter: one page with what someone looking after the kids needs, written by the parents: who to call, each
// kid's bedtime and anything to know about them, allergies, the Wi-Fi, and the rest. Big enough to read from across
// the room. The voice brings it up ("show the babysitter card"). Nothing leaves the tablet.
import { house, store, onAction } from '/kit/openhouse.js';
import { h, sheet, field, put, whenShown } from './ui.js';

const $app = document.getElementById('app');
let card = null; // {contacts: [{name, phone, note}], kids: {name: {bed, note}}, allergies, wifi: {name, password}, notes}
let family = [];

const blank = () => ({ contacts: [{ name: '', phone: '', note: '' }], kids: {}, allergies: '', wifi: { name: '', password: '' }, address: '', notes: '' });
const has = (s) => String(s || '').trim().length > 0;

function draw() {
  const top = h('div', { class: 'top' }, h('h1', { class: 'title' }, 'For the sitter'), card ? h('button', { class: 'btn soft', tap: openEdit }, 'Change') : null);
  if (!card) {
    put($app, top, h('div', { class: 'empty' },
      h('p', { class: 'lead' }, 'Everything a babysitter needs, on one page.'),
      h('p', { class: 'soft' }, 'Who to call, bedtimes, allergies and the Wi-Fi, written once by you. When the sitter comes, say “show the babysitter card”.'),
      h('button', { class: 'btn', tap: openEdit }, 'Write it')));
    return;
  }
  const kids = Object.entries(card.kids || {}).filter(([n, k]) => family.includes(n) && (has(k.bed) || has(k.note)));
  put($app, top, h('div', { class: 'body' },
    h('div', { class: 'cols', style: '--n:2' },
      h('section', { class: 'part' }, h('div', { class: 'label' }, 'Who to call'),
        (card.contacts || []).filter((c) => has(c.name) || has(c.phone)).map((c) => h('div', { class: 'contact' },
          h('div', { class: 'cname' }, c.name, has(c.note) ? h('span', { class: 'soft' }, ` · ${c.note}`) : null), h('div', { class: 'phone' }, c.phone))),
        h('div', { class: 'contact' }, h('div', { class: 'cname' }, 'Emergency'), h('div', { class: 'phone' }, '911')),
        has(card.address) ? h('p', { class: 'soft' }, `The address here: ${card.address}`) : null),
      h('section', { class: 'part' },
        kids.length ? [h('div', { class: 'label' }, 'Bedtimes'), kids.map(([n, k]) => h('div', { class: 'kidrow' },
          h('span', { class: 'kname' }, h('span', { class: 'dot', style: `background:${house.color(n)}` }), n),
          h('span', { class: 'bed' }, has(k.bed) ? k.bed : ''), has(k.note) ? h('div', { class: 'soft knote' }, k.note) : null))] : null,
        has(card.allergies) ? [h('div', { class: 'label gap' }, 'Allergies'), h('p', { class: 'allergy' }, card.allergies)] : null,
        has(card.wifi?.name) ? [h('div', { class: 'label gap' }, 'Wi-Fi'), h('div', { class: 'wifi' }, h('div', {}, card.wifi.name), h('div', { class: 'pw' }, card.wifi.password || ''))] : null)),
    has(card.notes) ? h('section', { class: 'part' }, h('div', { class: 'label' }, 'Good to know'), h('p', { class: 'notes' }, card.notes)) : null));
}

function openEdit() {
  const c = structuredClone(card || blank());
  const contacts = h('div', { class: 'row' });
  const drawContacts = () => put(contacts, ...c.contacts.map((x, i) => h('div', { class: 'pair', style: '--n:3' },
    h('input', { class: 'field', placeholder: 'Name (Mom, Grandma)', value: x.name, oninput: (e) => { x.name = e.target.value; } }),
    h('input', { class: 'field', placeholder: 'Phone', inputmode: 'tel', value: x.phone, oninput: (e) => { x.phone = e.target.value; } }),
    h('input', { class: 'field', placeholder: 'Note (at dinner downtown)', value: x.note, oninput: (e) => { x.note = e.target.value; } }),
    h('button', { class: 'x', 'aria-label': 'Take off', tap: () => { c.contacts.splice(i, 1); drawContacts(); } }, '×'))),
  h('button', { class: 'btn soft', tap: () => { c.contacts.push({ name: '', phone: '', note: '' }); drawContacts(); } }, 'Add someone'));
  drawContacts();
  const kids = family.map((n) => { const k = (c.kids[n] ||= { bed: '', note: '' }); return h('div', { class: 'pair' },
    h('input', { class: 'field', placeholder: `${n}’s bedtime (7:30)`, value: k.bed, oninput: (e) => { k.bed = e.target.value; } }),
    h('input', { class: 'field', placeholder: `About ${n} (reads first, a night light)`, value: k.note, oninput: (e) => { k.note = e.target.value; } })); });
  const ta = (v, set, ph) => h('textarea', { class: 'field', placeholder: ph, oninput: (e) => set(e.target.value) }, v || '');
  sheet('For the sitter', [
    field('Who to call', contacts),
    field('Bedtimes and each kid', h('div', { class: 'row' }, kids.length ? kids : h('span', { class: 'hint' }, 'Add the family in Settings to give each kid a row.')), 'Leave a kid’s row empty and they aren’t shown.'),
    field('Allergies', ta(c.allergies, (v) => { c.allergies = v; }, 'Peanuts (the EpiPen is in the top drawer)')),
    h('div', { class: 'pair' }, field('Wi-Fi name', h('input', { class: 'field', value: c.wifi.name, oninput: (e) => { c.wifi.name = e.target.value; } })),
      field('Wi-Fi password', h('input', { class: 'field', value: c.wifi.password, autocapitalize: 'off', spellcheck: 'false', oninput: (e) => { c.wifi.password = e.target.value; } }))),
    field('The address here (for 911)', h('input', { class: 'field', value: c.address, oninput: (e) => { c.address = e.target.value; } })),
    field('Good to know', ta(c.notes, (v) => { c.notes = v; }, 'Screens off at 7. Pizza money on the counter.')),
    h('p', { class: 'hint' }, 'It stays on this tablet. Anyone at the tablet can see this page, so keep it to what a sitter should know.'),
  ], [
    ...(card ? [{ text: 'Clear it', soft: true, tap: async (close) => { card = null; await store.set('card', null); close(); draw(); } }] : []),
    { text: 'Cancel', soft: true, tap: (close) => close() },
    { text: 'Save', tap: async (close) => { card = c; await store.set('card', card); close(); draw(); } }]);
}

(async () => {
  card = await store.get('card');
  draw();
  house.subscribe((hv) => { const f = (hv.family || []).map((p) => p.name).filter(Boolean); if (f.join() !== family.join()) { family = f; draw(); } });
  whenShown(() => onAction((name) => (name === 'show' ? (card ? 'Here’s the babysitter card.' : 'There’s no babysitter card yet: a parent can write it in the For the sitter app.') : null)));
})();

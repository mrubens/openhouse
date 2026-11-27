// Photos: all of them at a glance, a mosaic (a hold on one takes it off), one of them big (tap it: the next and the
// last beside it, a strip of its neighbours under it, its card behind the dots: a caption, its albums, take it off),
// and a slideshow. Albums gather some of them (each can be left off the sleep screen or All; an app saves into its own). "Add photos" shows a code a
// phone on the home Wi-Fi scans to send photos from its camera roll. The same photos show on the display when nobody's around,
// because app.json says "screensaver": true (take that out to stop it), except at night (the hours are set in the display's Settings).
// Videos are in it too: their still everywhere (a play mark on it here), played with sound on a tap in the one view, and
// muted, once through, in the slideshow. The sleep screen and Today show only their stills.
import { house, timer, say, phone, shell, h, press } from '/kit/openhouse.js';

// ---- drawing: small helpers (no framework) ----------------------------------------------------------------
const $app = document.getElementById('app');
const $over = document.body.appendChild(document.createElement('div'));

const ICONS = { more: '<circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/>', plus: '<path d="M12 4.5v15M4.5 12h15"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', left: '<path d="M14.5 5.5L8 12l6.5 6.5"/>', right: '<path d="M9.5 5.5L16 12l-6.5 6.5"/>', x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>', picture: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l4.5-4 3.5 3 3-2.5 5 4"/>' };
const icon = (name, cls = '') => h('span', { class: 'icon ' + cls, 'aria-hidden': 'true',
  html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>` });
const STAR = [...Array(10)].map((_, i) => { const a = Math.PI / 5 * i - Math.PI / 2, r = i % 2 ? 22.5 : 50; return `${(50 + r * Math.cos(a)).toFixed(1)},${(50 + r * Math.sin(a)).toFixed(1)}`; }).join(' ');
const star = (color, size) => h('span', { class: 'star', style: `width:calc(${size} * var(--u));height:calc(${size} * var(--u))`, 'aria-hidden': 'true',
  html: `<svg viewBox="0 0 100 100"><polygon fill="${color}" points="${STAR}"/></svg>` });

/** A pill: the ink one, a soft one, or (warn) the one that takes something away; ic: an icon before its words. */
const btn = (label, tap, { soft = false, warn = false, disabled = false, cls = '', ic = null } = {}) =>
  h('button', { class: `btn ${soft ? 'soft' : ''} ${warn ? 'warn' : ''} ${ic ? 'ic' : ''} ${cls}`, disabled, 'aria-label': ic ? label : null, tap: disabled ? null : tap }, ic && icon(ic), ic ? h('span', { class: 'lbl' }, label) : label);
const chip = (label, on, tap, dot = null) => h('button', { class: 'chip' + (on ? ' on' : ''), tap }, dot && h('span', { class: 'dot', style: `background:${dot}` }), label);
const round = (name, tap, { dark = false, disabled = false, label = null } = {}) =>
  h('button', { class: 'round' + (dark ? ' dark' : ''), disabled, 'aria-label': label, tap: disabled ? null : tap }, icon(name));
/** A color with some see-through: alpha('#e9b949', .32). */
const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/** Redraw an element's insides, keeping where each [data-keep] part was scrolled to. */
function keepScroll(root, fn) {
  const at = {};
  root.querySelectorAll('[data-keep]').forEach((e) => { at[e.dataset.keep] = [e.scrollLeft, e.scrollTop]; });
  fn();
  root.querySelectorAll('[data-keep]').forEach((e) => { const v = at[e.dataset.keep]; if (v) { e.scrollLeft = v[0]; e.scrollTop = v[1]; } });
}

// ---- cards over the app (a stack: a card can open another) ----
const sheets = [];
function openSheet(el, redraw = null) {
  const s = { el, redraw: () => redraw?.(s), close: () => { const i = sheets.indexOf(s); if (i >= 0) sheets.splice(i, 1); el.remove(); } };
  sheets.push(s); $over.append(el); s.redraw();
  return s;
}
/** A card in the middle; render(close) gives its insides (drawn again when the house changes). Tapping outside closes it. */
function openCard(render, { width = 720, onOutside = null } = {}) {
  const card = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', style: `width:calc(${width} * var(--u))`, tap: () => {} });
  let s;
  const scrim = h('div', { class: 'scrim', role: 'none', tap: () => (onOutside ? onOutside(s.close) : s.close()) }, card);
  s = openSheet(scrim, (me) => keepScroll(card, () => card.replaceChildren(...[render(me.close)].flat().filter(Boolean))));
  return s;
}
/** "Take it off?": a question, the kind answer, and the other one. */
function confirmCard(title, yes, onYes, no = 'Keep it', onNo = null) {
  return openCard((close) => [
    h('h2', { class: 'big' }, title),
    h('div', { class: 'actions' }, btn(no, () => { close(); onNo?.(); }, { soft: true }), btn(yes, () => { close(); onYes(); }, { warn: true })),
  ], { onOutside: (close) => { close(); onNo?.(); } });
}
/** Asks for a few words with the keyboard (an item, a chore, a meal). extra(): more choices under the field. */
function ask({ title, hint = '', initial = '', extra = null, onDone }) {
  const input = h('input', { class: 'field', placeholder: hint, enterkeyhint: 'done', autocapitalize: 'sentences', autocomplete: 'off', spellcheck: 'false' });
  input.value = initial;
  const more = h('div', { class: 'extra' });
  let s;
  const finish = () => { const t = input.value.trim(); if (!t) return; input.blur(); s.close(); onDone(t); };
  const done = btn('Done', null, { disabled: !initial.trim() });
  input.addEventListener('input', () => { done.disabled = !input.value.trim(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(); } });
  const cancel = btn('Cancel', () => { input.blur(); s.close(); }, { soft: true });
  // (Done is re-armed as the text changes, so its tap reads the field when pressed.)
  press(done, () => { if (!done.disabled) finish(); });
  const card = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', tap: () => {} }, h('h2', null, title), input, more, h('div', { class: 'actions' }, cancel, done));
  const scrim = h('div', { class: 'scrim high', tap: () => { input.blur(); s.close(); } }, card);
  s = openSheet(scrim, (me) => keepScroll(more, () => more.replaceChildren(...[extra?.(me)].flat().filter(Boolean))));
  input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  return s;
}

// ---- the photos --------------------------------------------------------------------------------------------
/** Seconds each photo stays up. */
const SECONDS = 10;

let H = null, grid = true;
/** The photo being looked at on its own (its name), or null. */
let one = null;
/** The album being looked at (its id), or null for all of them. */
let album = null;
const albumOf = () => (album && H?.albums?.find((a) => a.id === album)) || null;
/** The photos in view: the album's (those still there), else all. */
const shownPhotos = () => { const all = H?.photos || [], a = albumOf(); return a ? a.photos.filter((n) => all.includes(n)) : all.filter((n) => !hidden().has(n)); };
/** Left out of All: photos whose albums are all turned off there (album.all === false). */
function hidden() {
  const off = new Set(), on = new Set();
  for (const a of H?.albums || []) for (const n of a.photos) (a.all === false ? off : on).add(n);
  for (const n of on) off.delete(n);
  return off;
}
const captionOf = (n) => H?.captions?.[n] || '';
/** Grid photos load as they come into view (a few hundred photos no longer load at once). */
const seen = new IntersectionObserver((list) => {
  for (const e of list) if (e.isIntersecting) { const img = e.target; seen.unobserve(img); house.thumb(img.dataset.name, Number(img.dataset.px) || undefined).then((src) => { img.src = src; }).catch(() => {}); }
}, { rootMargin: '400px' });

const isVideo = (n) => house.isVideo(n);
/** A video in the grid plays silently on a loop over its still (the user), only while it's in view; its mark goes once it plays. */
const clipSeen = new IntersectionObserver((es) => es.forEach((e) => {
  const cell = e.target;
  if (!e.isIntersecting) { cell.querySelector('video')?.pause(); return; }
  const v = cell.querySelector('video');
  if (v) { v.play().catch(() => {}); return; }
  if (cell.dataset.clip === 'asked') return;
  cell.dataset.clip = 'asked';
  house.video(cell.dataset.name).then((url) => {
    if (!url || !cell.isConnected) return;
    const clip = h('video', { class: 'cell-clip', muted: true, loop: true, playsinline: true, preload: 'auto', poster: BLANK });
    clip.muted = true; clip.src = url;
    clip.addEventListener('playing', () => { clip.classList.add('on'); cell.querySelector('.vid-mark')?.remove(); }, { once: true });
    cell.append(clip); clip.play().catch(() => {});
  }).catch(() => {});
}), { threshold: 0.3 });
function gridClip(cell, name) { cell.dataset.name = name; clipSeen.observe(cell); }
/** A see-through poster: without one, Android's WebView paints its own grey poster with a big play button first. */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
/** The small play mark on a video's still. */
const vidMark = () => h('span', { class: 'vid-mark', 'aria-hidden': 'true' }, icon('play'));
/** The video playing in the one view (only ever one: let go of as soon as it's off screen). */
let playing = null;
function stopVideo() { if (!playing) return; const v = playing; playing = null; v.pause(); v.removeAttribute('src'); v.load(); v.remove(); }
/** One of the family's photos, as an <img> (filled in when it arrives). small: true, or how wide a copy in px. */
function photo(name, cls = '', small = false) {
  const img = h('img', { class: 'photo ' + cls, alt: '', draggable: 'false' });
  if (small) { // in the grid: a small copy, and only once it scrolls into view
    seen.observe(img); img.dataset.name = name; if (small !== true) img.dataset.px = small;
  } else house.photo(name).then((src) => { img.src = src; }).catch(() => {});
  return img;
}
/** Ways in: a phone on the Wi-Fi now; the household's phones any time; an iCloud shared album that keeps them coming;
 *  picked in Google Photos. All but the first are behind the PIN (the display asks). */
function addPhotos() {
  const later = (call, what) => () => { if (!call()) openCard((c) => [h('h2', null, what), h('p', { class: 'note' }, 'That’s on the display itself, with the PIN.'), h('div', { class: 'actions' }, btn('OK', c))]); };
  const way = (title, line, tap) => h('div', { class: 'way', tap }, h('div', { class: 'way-title' }, title), h('div', { class: 'note small' }, line));
  openCard((close) => [
    h('h2', { class: 'big' }, 'Add photos'),
    way('From a phone, now', 'Scan a code with a phone on the home Wi-Fi and pick photos or videos.', () => { close(); phone.photos(); }),
    way('From the household’s phones, any time', 'A page each phone keeps. On Android it’s in the share sheet.', () => { close(); later(() => phone.sharePhotos(), 'Photos from phones')(); }),
    way('An iCloud shared album', 'Photos added to it on any iPhone show up here by themselves.', () => { close(); if (!phone.addAlbum()) albumByLink(); }),
    way('Pick in Google Photos', 'Sign in to Google on a phone and choose the photos to copy here.', () => { close(); later(() => phone.googlePhotos(), 'Google Photos')(); }),
    h('div', { class: 'actions' }, btn('Cancel', close, { soft: true })),
  ], { width: 860 });
}
/** On a phone: the album's public link, pasted here (a grown-up's phone adds it with no PIN; the bridge says no to others). */
function albumByLink() {
  ask({ title: 'An iCloud shared album', hint: 'Paste its public link', extra: () => h('p', { class: 'note small' }, 'In Photos, the album’s sharing settings: turn on Public Website, then copy the link.'), onDone: async (link) => {
    const r = await house.addAlbumLink(link);
    openCard((c) => [h('h2', null, r?.added ? 'Added' : 'Not added'), h('p', { class: 'note' }, r?.added ? 'Its photos come in over the next few minutes, and new ones within half an hour.' : r?.error || 'It wasn’t added.'), h('div', { class: 'actions' }, btn('OK', c))]);
  } });
}
const linkOf = (a) => (a?.from && H?.linked?.find((l) => l.album === a.id)) || null;
/** A linked album's line: how it's doing. */
function linkedLine(a) {
  const l = linkOf(a); if (!l) return null;
  if (l.status === 'error') return `From ${a.from}. Last look: ${l.error || 'couldn’t read the album'}. The photos here stay.`;
  if (l.coming) return `From ${a.from}. ${l.coming} more on the way.`;
  const soon = l.expires && l.expires - Date.now() < 10 * 864e5 // new iCloud albums' public links can run out
    ? ` Its link runs out ${new Date(l.expires).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}: before then, make a new public link for the album on the iPhone and add it here again.` : '';
  return `From ${a.from}: photos added to it there show up here by themselves.${soon}`;
}

function draw() {
  if (album && !albumOf()) album = null; // taken away meanwhile
  const photos = shownPhotos();
  $app.className = '';
  if (one && !photos.includes(one)) one = null; // taken off meanwhile
  if (!one) { alone = null; stopVideo(); }
  if (!H) { stopShow(); $app.replaceChildren(); }
  else if (!(H.photos || []).length) { stopShow(); $app.replaceChildren(empty()); }
  else if (!photos.length) { stopShow(); keepScroll($app, () => $app.replaceChildren(gridView(photos))); } // an empty album
  else if (one) { stopShow(); $app.className = 'bare'; single(photos); }
  else if (grid) { stopShow(); keepScroll($app, () => $app.replaceChildren(gridView(photos))); }
  else { $app.className = 'bare'; slideshow(photos); }
  for (const s of sheets) s.redraw?.();
}

function empty() {
  return h('div', { class: 'empty' },
    h('span', { class: 'mark' }, icon('picture')),
    h('h1', null, 'No photos yet'),
    h('p', null, 'Photos added to the display show here, and when nobody’s using it.'),
    btn('Add photos', addPhotos, { ic: 'plus' }),
    unread());
}
/** Linked albums that have never read (no album here yet, so nothing else shows them): why, and a way to take each off. */
function unread() {
  const stuck = (H?.linked || []).filter((l) => l.status === 'error' && !(H.albums || []).some((a) => a.id === l.album));
  if (!stuck.length || !phone.stopAlbum) return null;
  return h('div', { class: 'unread' }, stuck.map((l) => h('div', { class: 'unread-row' },
    h('p', { class: 'note small' }, `An iCloud album can’t be read: ${(l.error || 'couldn’t read the album').replace(/^\p{Lu}(?!\p{Lu})/u, (c) => c.toLowerCase()).replace(/\.$/, '')}.`),
    btn('Remove', () => confirmCard('Remove this album link?', 'Remove', () => { H.linked = H.linked.filter((x) => x !== l); draw(); phone.stopAlbum(l.id); }), { soft: true }))));
}

/** Choosing several photos to take off: the names picked (null when not choosing). */
let picking = null;
function gridView(photos) {
  const top = h('div', { class: 'top' });
  const a = albumOf(), albums = H.albums || [];
  const drawTop = () => top.replaceChildren(...(picking ? [
    h('span', { class: 'picked-count' }, picking.size ? `${picking.size} chosen` : a ? 'Tap the photos' : 'Tap the photos to take off or put in an album'),
    btn('Cancel', () => { picking = null; draw(); }, { soft: true }),
    a ? btn('Take out of album', () => { const n = [...picking]; picking = null; a.photos = a.photos.filter((x) => !n.includes(x)); draw(); house.inAlbum(a.id, n, false); }, { soft: true, disabled: !picking.size })
      : btn('Put in an album', () => toAlbum([...picking]), { soft: true, disabled: !picking.size }),
    btn(picking.size ? `Take off ${picking.size}` : 'Take off', () => removingMany([...picking]), { warn: true, disabled: !picking.size }),
  ] : [
    // (Night hours, when the screen goes dark, are in the display's Settings.)
    h('h1', { class: 'title' }, a ? a.name : 'Photos', ' ', h('span', null, String(photos.length))),
    h('div', { class: 'albums hscroll', 'data-keep': 'albums' }, h('div', { class: 'q-seg' },
      h('button', { class: a ? '' : 'on', tap: () => { album = null; draw(); } }, 'All'),
      albums.map((x) => h('button', { class: a === x ? 'on' : '', tap: () => { album = x.id; draw(); } }, x.name)),
      h('button', { 'aria-label': 'New album', tap: () => newAlbum([]) }, icon('plus')))),
    a ? round('more', () => albumCard(a), { label: 'Album' }) : null,
    photos.length ? btn('Slideshow', () => { grid = false; draw(); }, { soft: true, ic: 'play' }) : null,
    photos.length > 1 ? btn('Choose', () => { picking = new Set(); draw(); }, { soft: true }) : null,
    btn('Add photos', addPhotos, { ic: 'plus' }),
  ]).filter(Boolean));
  drawTop();
  // The mosaic: every eleven tiles fill a screen (TILES). With all the photos in view, each album's cover is a big one.
  const covers = !a && !picking ? albums.filter((x) => x.photos.some((n) => photos.includes(n))) : [];
  const tiles = [], rest = [...photos];
  for (let i = 0; rest.length || covers.length; i++) {
    const kind = TILES[i % TILES.length], big = kind === 'b' || kind === 'b2';
    if (big && covers.length) tiles.push(albumTile(covers.shift(), kind, photos));
    else if (rest.length) tiles.push(tile(rest.shift(), kind));
    else if (!big) tiles.push(albumTile(covers.shift(), 'w', photos)); // more albums than photos to go between them
  }
  function tile(p, kind) {
    const cell = h('div', { class: `cell ${kind}` + (picking?.has(p) ? ' picked' : ''), tap: () => {
      if (!picking) { one = p; draw(); return; }
      if (picking.has(p)) picking.delete(p); else picking.add(p);
      cell.classList.toggle('picked', picking.has(p)); drawTop(); // (not the whole grid: its photos stay loaded)
    }, hold: () => (picking ? null : removing(p)) }, photo(p, '', kind === 'b' || kind === 'b2' ? 900 : kind === 'w' ? 600 : true),
    isVideo(p) && !picking ? vidMark() : null, picking ? h('span', { class: 'cell-check' }, icon('check')) : null);
    if (isVideo(p) && !picking) gridClip(cell, p);
    return cell;
  }
  return h('div', { class: 'grid-screen' + (picking ? ' picking' : '') }, top,
    !photos.length ? h('p', { class: 'note' }, 'Nothing in this album yet. Tap a photo in All to put it in, or Choose several there.') : null,
    !a && !picking ? unread() : null,
    h('div', { class: 'grid-scroll vscroll', 'data-keep': 'grid' }, h('div', { class: 'mos' }, tiles)));
}
/** The mosaic's tiles, in turn: b and b2 big (three across, two down), w wide (two across), s small. */
const TILES = ['b', 'w', 's', 's', 's', 's', 's', 'w', 'b2', 'w', 's'];
/** An album in the mosaic: its first photo, its name and how many over it. Tap for the album. */
function albumTile(x, kind, photos) {
  const mine = x.photos.filter((n) => photos.includes(n));
  return h('div', { class: `cell q-scrim ${kind}`, tap: () => { album = x.id; draw(); } }, photo(mine[0], 'q-photo', 900),
    h('div', { class: 'cap' }, x.name, h('small', null, `${mine.length} ${mine.length === 1 ? 'photo' : 'photos'}`)));
}

/** New album (with these photos in it). */
function newAlbum(names) {
  ask({ title: names.length ? `A new album for ${names.length === 1 ? 'this photo' : `these ${names.length}`}` : 'A new album', hint: 'Summer, Grandma, The dog', onDone: async (name) => {
    if ((H.albums || []).some((x) => same(x.name, name))) return openCard((close) => [h('h2', null, `There’s an album called ${name} already.`), h('div', { class: 'actions' }, btn('OK', close))]);
    picking = null;
    const r = await house.addAlbum(name, names);
    if (r?.album) { album = r.album.id; grid = true; }
    draw();
  } });
}
/** Chosen photos into an album: one of theirs, or a new one. */
function toAlbum(names) {
  openCard((close) => [
    h('h2', null, names.length === 1 ? 'Put it in an album' : `Put these ${names.length} in an album`),
    h('div', { class: 'chips wrap' }, (H.albums || []).map((x) => chip(x.name, false, () => {
      close(); picking = null; x.photos = [...new Set([...x.photos, ...names])]; draw(); house.inAlbum(x.id, names, true);
    })), chip('New album', false, () => { close(); newAlbum(names); })),
    h('div', { class: 'actions' }, btn('Cancel', close, { soft: true })),
  ], { width: 860 });
}
/** An album's card: whether it shows on the sleep screen and in All, rename, take it away (its photos stay). */
function albumCard(a) {
  openCard((close) => {
    const x = albumOf() || a, sleep = x.sleep !== false, inAll = x.all !== false;
    const show = (k, v) => { if (v) delete x[k]; else x[k] = false; house.showAlbum(x.id, { [k]: v }); sheets.at(-1)?.redraw(); draw(); };
    return [
      h('h2', { class: 'big' }, x.name),
      h('p', { class: 'note' }, `${x.photos.length} ${x.photos.length === 1 ? 'photo' : 'photos'}`),
      x.from ? h('p', { class: 'note small' }, linkedLine(x)) : null,
      h('div', { class: 'chips wrap' }, chip('On the sleep screen', sleep, () => show('sleep', !sleep)), chip('In All photos', inAll, () => show('all', !inAll))),
      x.app ? h('p', { class: 'note small' }, `Pictures saved in ${x.name} come here.`) : null,
      h('div', { class: 'actions' },
        x.from ? (linkOf(x) ? btn('Stop keeping it here', () => { close(); confirmCard(`Stop keeping ${x.name} here?`, 'Stop', () => { album = null; draw(); phone.stopAlbum(linkOf(x).id); }); }, { soft: true }) : null) : btn('Take the album away', () => { close(); confirmCard(`Take the album ${x.name} away?`, 'Take it away', () => { album = null; H.albums = H.albums.filter((y) => y !== x); draw(); house.removeAlbum(x.id); }, 'Keep it'); }, { soft: true }),
        btn('Rename', () => { close(); ask({ title: 'Rename the album', initial: x.name, onDone: (name) => { x.name = name; draw(); house.renameAlbum(x.id, name); } }); }, { soft: true }),
        btn('Done', close)),
    ];
  }, { width: 860 });
}
/** A photo's card: big, its caption (shown with it in the slideshow and on the sleep screen), its albums. */
function photoCard(p) {
  const field = h('input', { class: 'field', placeholder: 'A caption (optional): who, where, when', enterkeyhint: 'done', autocapitalize: 'sentences', autocomplete: 'off', spellcheck: 'false' });
  field.value = captionOf(p);
  const keep = () => { const t = field.value.trim(); if (t === captionOf(p)) return; H.captions = { ...(H.captions || {}), [p]: t }; if (!t) delete H.captions[p]; house.caption(p, t); draw(); };
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); field.blur(); } });
  field.addEventListener('blur', keep);
  const albums = h('div', { class: 'chips wrap' });
  const drawAlbums = () => albums.replaceChildren(...(H.albums || []).map((x) => chip(x.name, x.photos.includes(p), () => {
    const on = !x.photos.includes(p); x.photos = on ? [...x.photos, p] : x.photos.filter((y) => y !== p); drawAlbums(); house.inAlbum(x.id, [p], on);
  })), chip('New album', false, () => { keep(); s.close(); newAlbum([p]); }));
  drawAlbums();
  const s = openCard((close) => [
    photo(p, 'preview big'),
    field,
    h('div', { class: 'row' }, h('span', { class: 'label' }, 'Albums'), albums),
    h('div', { class: 'actions' },
      btn('Take it off', () => { keep(); close(); removing(p); }, { soft: true }),
      btn('Play from here', () => { keep(); close(); one = null; grid = false; startAt = p; draw(); }, { soft: true }),
      btn('Done', () => { keep(); close(); })),
  ], { width: 1000, onOutside: (close) => { keep(); close(); } });
  s.redraw = () => {}; // (drawn once: the field keeps what's being typed while the house updates)
}


function removingMany(names) {
  openCard((close) => [
    h('h2', { class: 'big' }, names.length === 1 ? 'Take this photo off?' : `Take these ${names.length} photos off?`),
    h('p', null, 'They’re put aside on the display, not deleted.'),
    h('div', { class: 'actions' },
      btn('Keep them', close, { soft: true }),
      btn('Take them off', () => { close(); picking = null; H.photos = H.photos.filter((x) => !names.includes(x)); draw(); for (const n of names) house.removePhoto(n); }, { warn: true })),
  ], { width: 760 });
}

function removing(p) {
  openCard((close) => [
    photo(p, 'preview'),
    h('h2', { class: 'big' }, 'Take this photo off?'),
    h('div', { class: 'actions' },
      btn('Keep it', close, { soft: true }),
      btn('Take it off', () => { close(); H.photos = H.photos.filter((x) => x !== p); draw(); house.removePhoto(p); }, { warn: true })),
  ], { width: 760 });
}

// One photo, filling the pane: the way back, the slideshow from here and its card at the top, the last and the next
// at the sides, its caption and where it is at the foot, over a strip of its neighbours. It stays put while the house
// updates (only its words are drawn again).
let alone = null;
function single(photos) {
  const i = photos.indexOf(one), a = albumOf();
  const go = (n) => { one = photos[(n + photos.length) % photos.length]; draw(); };
  const words = () => [captionOf(one), [a?.name, `${i + 1} of ${photos.length}`].filter(Boolean).join(' · ')];
  if (alone && alone.name === one && alone.key === photos.join('\n') && $app.contains(alone.el)) { const [c, l] = words(); alone.cap.textContent = c; alone.line.textContent = l; return; }
  stopVideo();
  const glass = (label, ic, tap, cls = '') => h('button', { class: `pill glass ${cls}`, 'aria-label': label, tap }, icon(ic), h('span', { class: 'lbl' }, label));
  const [c, l] = words(), cap = h('h1', null, c), line = h('p', null, l);
  const back = h('img', { class: 'one-back', alt: '', draggable: 'false' }), pic = h('img', { class: 'one-pic', alt: '', draggable: 'false' });
  // A picture near the pane's shape fills it; one far from it (a tall one on a wide screen) shows whole, on its own blur.
  pic.addEventListener('load', () => { const r = (pic.naturalWidth / pic.naturalHeight) / (innerWidth / innerHeight); pic.classList.toggle('fill', !isVideo(one) && r > .72 && r < 1.4); }); // (a video's still shows whole, as the video will)
  house.thumb(one).then((src) => { back.src = src; if (!pic.src) pic.src = src; }).catch(() => {});
  house.photo(one).then((src) => { pic.src = src; }).catch(() => {});
  const n = Math.min(photos.length, matchMedia('(max-width: 700px)').matches ? 5 : 11), from = Math.max(0, Math.min(i - (n >> 1), photos.length - n));
  // A video: its still, and a play button; a tap plays it with sound over the still, and a tap on it pauses or plays.
  let play = null;
  if (isVideo(one)) {
    const name = one;
    play = h('button', { class: 'one-play glass', 'aria-label': 'Play the video', tap: async () => {
      if (playing && el.contains(playing)) { playing.play().catch(() => {}); return; } // (paused: on from there)
      const url = await house.video(name).catch(() => null);
      if (!url || one !== name || !$app.contains(el)) return;
      stopVideo();
      // Whole, on the blurred still like a photo; out of sight until its first frame (the WebView's own poster and
      // play button never show), then the still under it goes so it isn't seen around the edges.
      const v = h('video', { class: 'one-pic vid', playsinline: true, preload: 'auto', poster: BLANK, tap: () => { if (v.paused) v.play().catch(() => {}); else v.pause(); } });
      v.addEventListener('playing', () => { v.classList.add('on'); pic.classList.add('under'); }, { once: true });
      v.src = url; v.addEventListener('ended', () => { el.classList.remove('playing'); pic.classList.remove('under'); stopVideo(); play.hidden = false; });
      v.addEventListener('pause', () => { el.classList.remove('playing'); play.hidden = false; }); v.addEventListener('play', () => { el.classList.add('playing'); play.hidden = true; });
      pic.after(v); playing = v; play.hidden = true;
      v.play().catch(() => { stopVideo(); play.hidden = false; });
    } }, icon('play'));
  }
  const el = h('div', { class: 'one' }, back, pic, play, h('div', { class: 'shade' }),
    h('div', { class: 'one-top' },
      glass(a ? a.name : 'All photos', 'left', () => { one = null; grid = true; draw(); }),
      h('span', { class: 'grow' }),
      glass('Slideshow', 'play', () => { const p = one; one = null; grid = false; startAt = p; draw(); }, 'ic'),
      h('button', { class: 'rbtn glass', 'aria-label': 'Caption, albums, take it off', tap: () => photoCard(one) }, icon('more'))),
    photos.length > 1 ? [h('button', { class: 'rbtn arr l glass', 'aria-label': 'The one before', tap: () => go(i - 1) }, icon('left')),
      h('button', { class: 'rbtn arr r glass', 'aria-label': 'The next one', tap: () => go(i + 1) }, icon('right'))] : null,
    h('div', { class: 'capt' }, cap, line),
    photos.length > 1 ? h('div', { class: 'film glass' }, photos.slice(from, from + n).map((p) => h('div', { class: p === one ? 'on' : '', tap: () => { one = p; draw(); } }, photo(p, '', true), isVideo(p) ? vidMark() : null))) : null);
  $app.replaceChildren(el);
  alone = { name: one, key: photos.join('\n'), el, cap, line };
}
addEventListener('keydown', (e) => {
  if (!one || sheets.length || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Escape')) return;
  const photos = shownPhotos(), i = photos.indexOf(one);
  one = e.key === 'Escape' ? null : photos[(i + (e.key === 'ArrowLeft' ? -1 : 1) + photos.length) % photos.length]; draw();
});

// The slideshow: newest first, then shuffled; crossfades every SECONDS. It stays put while the house updates.
let show = null, startAt = null; // startAt: a photo tapped in the grid, shown first
function slideshow(photos) {
  const key = photos.join('\n');
  const line = () => [albumOf()?.name, `${photos.length} photos`].filter(Boolean).join(' · ');
  if (show && show.key === key && $app.contains(show.el) && !startAt) { show.count.textContent = line(); show.cap.textContent = captionOf(show.order[show.i]); return; }
  stopShow();
  const first = startAt && photos.includes(startAt) ? startAt : photos[0]; startAt = null;
  const order = [first, ...photos.filter((x) => x !== first).sort(() => Math.random() - .5)];
  const layers = [h('img', { class: 'slide', alt: '', draggable: 'false' }), h('img', { class: 'slide', alt: '', draggable: 'false' })];
  const count = h('p', null, line());
  const cap = h('h1');
  const el = h('div', { class: 'show', tap: () => { grid = true; draw(); } }, layers, h('div', { class: 'shade' }), h('div', { class: 'capt' }, cap, count));
  $app.replaceChildren(el);
  show = { key, el, count, cap, order, i: 0, front: 0, timer: 0, clip: null };
  const s = show;
  // The next one after SECONDS; a video plays muted over its still, once through (a minute at most), then the next.
  const after = (ms) => { clearTimeout(s.timer); if (order.length > 1 || s.clip) s.timer = setTimeout(() => put((s.i + 1) % order.length), ms); };
  const put = async (i) => {
    const src = await house.photo(order[i]).catch(() => null);
    if (show !== s) return;
    if (!src) { s.i = i; return after(1000); } // (a video still without its still: on to the next)
    const next = layers[1 - s.front];
    next.src = src; await next.decode().catch(() => {});
    if (show !== s) return;
    endClip(s);
    next.classList.add('on'); layers[s.front].classList.remove('on'); s.front = 1 - s.front; s.i = i;
    cap.textContent = captionOf(order[i]);
    after(SECONDS * 1000);
    if (!isVideo(order[i])) return;
    const url = await house.video(order[i]).catch(() => null);
    if (!url || show !== s || s.i !== i) return;
    const v = h('video', { class: 'slide vid', muted: true, playsinline: true, preload: 'auto', poster: BLANK });
    v.muted = true; v.src = url; s.clip = v;
    v.addEventListener('playing', () => { v.classList.add('on'); after(Math.min(60e3, Math.max(SECONDS * 1000, (v.duration || 0) * 1000 + 400))); }, { once: true });
    v.addEventListener('ended', () => { if (s.clip === v) after(0); });
    next.after(v); v.play().catch(() => endClip(s));
  };
  put(0);
}
function endClip(s) { const v = s?.clip; if (!v) return; s.clip = null; v.classList.remove('on'); v.pause(); v.removeAttribute('src'); v.load(); setTimeout(() => v.remove(), 1300); }
function stopShow() { if (show) { clearTimeout(show.timer); endClip(show); show = null; } }

// Opened from Today's photo (add=<when>&photo=<name> in its address, just now): that photo, once.
// From Home's "Add your photos" (add=<when> with do=add): the ways in, once.
let openAsked = (() => { const q = new URLSearchParams(location.hash.slice(1)); return Date.now() - (Number(q.get('add')) || 0) < 15e3 ? q.get('photo') : null; })();
let addAsked = (() => { const q = new URLSearchParams(location.hash.slice(1)); return Date.now() - (Number(q.get('add')) || 0) < 15e3 && q.get('do') === 'add'; })();
house.subscribe((d) => { H = d; if (openAsked && (d.photos || []).includes(openAsked)) { album = null; one = openAsked; } openAsked = null; draw(); if (addAsked) { addAsked = false; addPhotos(); } });

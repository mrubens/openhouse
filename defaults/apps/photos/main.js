// Photos: a slideshow, and all of them at a glance (tap to switch; its × or a hold takes it off). Albums gather some
// of them (one can be what the idle screen shows); a tapped photo opens its card: a caption, its albums, take it off. "Add photos" shows a code a
// phone on the home Wi-Fi scans to send photos from its camera roll. The same photos show on the display when nobody's around,
// because app.json says "screensaver": true (take that out to stop it), except at night (the hours are set in the display's Settings).
import { house, timer, say, phone, shell } from '/kit/openhouse.js';

// ---- drawing: small helpers (no framework) ----------------------------------------------------------------
const $app = document.getElementById('app');
const $over = document.body.appendChild(document.createElement('div'));

/** An element: h('div', { class, style, tap, hold, ...attributes }, ...children). tap/hold are touch-first presses. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false || k === 'tap' || k === 'hold') continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  if (props?.tap || props?.hold) { press(el, props.tap, props.hold); if (tag !== 'button' && tag !== 'input' && props.tap && !props.role) { el.tabIndex = 0; el.setAttribute('role', 'button'); } }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

/** A tap (finger up without moving) and a hold (about half a second), on any element. */
function press(el, tap, hold) {
  let t = 0, x = 0, y = 0, down = false;
  const stop = () => { down = false; clearTimeout(t); };
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); down = true; x = e.clientX; y = e.clientY;
    if (hold) t = setTimeout(() => { down = false; hold(e); }, 550);
  });
  el.addEventListener('pointermove', (e) => { if (down && Math.hypot(e.clientX - x, e.clientY - y) > 14) stop(); });
  el.addEventListener('pointercancel', stop);
  el.addEventListener('pointerleave', stop);
  el.addEventListener('pointerup', (e) => { const was = down; stop(); if (was) { e.stopPropagation(); tap?.(e); } });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  // A tap doesn't move the keyboard's focus (it stays in the field being typed in); Tab still reaches everything.
  el.addEventListener('mousedown', (e) => { if (e.target === el || !e.target.closest?.('input, textarea')) e.preventDefault(); });
  // A keyboard (the cover) works it too: Enter or Space taps.
  if (tap) el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el && !el.disabled) { e.preventDefault(); tap(e); } });
}

const ICONS = { more: '<circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/>', plus: '<path d="M12 4.5v15M4.5 12h15"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', left: '<path d="M14.5 5.5L8 12l6.5 6.5"/>', right: '<path d="M9.5 5.5L16 12l-6.5 6.5"/>', x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>' };
const icon = (name, cls = '') => h('span', { class: 'icon ' + cls, 'aria-hidden': 'true',
  html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>` });
const STAR = [...Array(10)].map((_, i) => { const a = Math.PI / 5 * i - Math.PI / 2, r = i % 2 ? 22.5 : 50; return `${(50 + r * Math.cos(a)).toFixed(1)},${(50 + r * Math.sin(a)).toFixed(1)}`; }).join(' ');
const star = (color, size) => h('span', { class: 'star', style: `width:calc(${size} * var(--u));height:calc(${size} * var(--u))`, 'aria-hidden': 'true',
  html: `<svg viewBox="0 0 100 100"><polygon fill="${color}" points="${STAR}"/></svg>` });

const btn = (label, tap, { soft = false, color = null, disabled = false, cls = '' } = {}) =>
  h('button', { class: `btn ${soft ? 'soft' : ''} ${cls}`, style: color && !soft ? `background:${color}` : null, disabled, tap: disabled ? null : tap }, label);
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
    h('div', { class: 'actions' }, btn(no, () => { close(); onNo?.(); }, { soft: true }), btn(yes, () => { close(); onYes(); }, { color: 'var(--red)' })),
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

let H = null, grid = false;
/** The album being looked at (its id), or null for all of them. */
let album = null;
const albumOf = () => (album && H?.albums?.find((a) => a.id === album)) || null;
/** The photos in view: the album's (those still there), else all. */
const shownPhotos = () => { const all = H?.photos || [], a = albumOf(); return a ? a.photos.filter((n) => all.includes(n)) : all; };
const captionOf = (n) => H?.captions?.[n] || '';
/** Grid photos load as they come into view (a few hundred photos no longer load at once). */
const seen = new IntersectionObserver((list) => {
  for (const e of list) if (e.isIntersecting) { const img = e.target; seen.unobserve(img); house.thumb(img.dataset.name).then((src) => { img.src = src; }).catch(() => {}); }
}, { rootMargin: '400px' });

/** One of the family's photos, as an <img> (filled in when it arrives). */
function photo(name, cls = '', small = false) {
  const img = h('img', { class: 'photo ' + cls, alt: '', draggable: 'false' });
  if (small) { // in the grid: a small copy, and only once it scrolls into view
    seen.observe(img); img.dataset.name = name;
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
    way('From a phone, now', 'Scan a code with a phone on the home Wi-Fi and pick photos.', () => { close(); phone.photos(); }),
    way('From the household’s phones, any time', 'A page each phone keeps. On Android it’s in the share sheet.', () => { close(); later(() => phone.sharePhotos(), 'Photos from phones')(); }),
    way('An iCloud shared album', 'Photos added to it on any iPhone show up here by themselves.', () => { close(); later(() => phone.addAlbum(), 'An iCloud shared album')(); }),
    way('Pick in Google Photos', 'Sign in to Google on a phone and choose the photos to copy here.', () => { close(); later(() => phone.googlePhotos(), 'Google Photos')(); }),
    h('div', { class: 'actions' }, btn('Cancel', close, { soft: true })),
  ], { width: 860 });
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
  if (!H) { stopShow(); $app.replaceChildren(); }
  else if (!(H.photos || []).length) { stopShow(); $app.replaceChildren(empty()); }
  else if (!photos.length) { stopShow(); keepScroll($app, () => $app.replaceChildren(gridView(photos))); } // an empty album
  else if (grid) { stopShow(); keepScroll($app, () => $app.replaceChildren(gridView(photos))); }
  else { $app.className = 'bare'; slideshow(photos); }
  for (const s of sheets) s.redraw?.();
}

function empty() {
  return h('div', { class: 'empty' },
    h('h1', null, 'No photos yet'),
    h('p', null, 'Photos added to the display show here, and when the kitchen is quiet.'),
    btn('Add photos', addPhotos));
}

/** Choosing several photos to take off: the names picked (null when not choosing). */
let picking = null;
function gridView(photos) {
  const top = h('div', { class: 'grid-top' });
  const a = albumOf(), albums = H.albums || [];
  const drawTop = () => top.replaceChildren(...(picking ? [
    h('span', { class: 'picked-count' }, picking.size ? `${picking.size} chosen` : a ? 'Tap the photos' : 'Tap the photos to take off or put in an album'),
    h('span', { class: 'grow' }),
    btn('Cancel', () => { picking = null; draw(); }, { soft: true }),
    a ? btn('Take out of album', () => { const n = [...picking]; picking = null; a.photos = a.photos.filter((x) => !n.includes(x)); draw(); house.inAlbum(a.id, n, false); }, { soft: true, disabled: !picking.size })
      : btn('Put in an album', () => toAlbum([...picking]), { soft: true, disabled: !picking.size }),
    btn(picking.size ? `Take off ${picking.size}` : 'Take off', () => removingMany([...picking]), { color: 'var(--red)', disabled: !picking.size }),
  ] : [
    // (Night hours, when the screen goes dark, are in the display's Settings.)
    h('div', { class: 'chips albums', 'data-keep': 'albums' },
      chip('All photos', !a, () => { album = null; draw(); }),
      albums.map((x) => chip(x.name + (H.slideshow === x.id ? ' · idle screen' : ''), a === x, () => { album = x.id; draw(); })),
      chip('New album', false, () => newAlbum([]))),
    a ? round('more', () => albumCard(a), { label: 'Album' }) : null,
    photos.length > 1 ? btn('Choose', () => { picking = new Set(); draw(); }, { soft: true }) : null,
    !a && H.removed?.length ? btn('Taken off', takenOff, { soft: true }) : null,
    btn('Add photos', addPhotos, { color: 'var(--red)' }),
  ]).filter(Boolean));
  drawTop();
  return h('div', { class: 'grid-screen' + (picking ? ' picking' : '') }, top,
    !photos.length ? h('p', { class: 'note' }, 'Nothing in this album yet. Tap a photo in All photos to put it in, or Choose several there.') : null,
    h('div', { class: 'grid-scroll vscroll', 'data-keep': 'grid' }, h('div', { class: 'grid' },
      photos.map((p) => {
        const cell = h('div', { class: 'cell' + (picking?.has(p) ? ' picked' : ''), tap: () => {
          if (!picking) { photoCard(p); return; }
          if (picking.has(p)) picking.delete(p); else picking.add(p);
          cell.classList.toggle('picked', picking.has(p)); drawTop(); // (not the whole grid: its photos stay loaded)
        }, hold: () => (picking ? null : removing(p)) }, photo(p, '', true),
        picking ? h('span', { class: 'cell-check' }, icon('check'))
          : a && !a.from ? h('button', { class: 'cell-off', 'aria-label': 'Take it out of this album', tap: () => { a.photos = a.photos.filter((x) => x !== p); draw(); house.inAlbum(a.id, [p], false); } }, icon('x')) // (it stays in All photos)
          : h('button', { class: 'cell-off', 'aria-label': 'Take this photo off', tap: () => removing(p) }, icon('x')));
        return cell;
      }))));
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
/** An album's card: show it on the idle screen, rename, take it away (its photos stay). */
function albumCard(a) {
  openCard((close) => {
    const x = albumOf() || a, on = H.slideshow === x.id;
    return [
      h('h2', { class: 'big' }, x.name),
      h('p', { class: 'note' }, `${x.photos.length} ${x.photos.length === 1 ? 'photo' : 'photos'}`),
      x.from ? h('p', { class: 'note small' }, linkedLine(x)) : null,
      h('div', { class: 'chips wrap' }, chip(on ? 'On the idle screen' : 'Show these on the idle screen', on, () => { H.slideshow = on ? null : x.id; house.setSlideshow(H.slideshow); sheets.at(-1)?.redraw(); draw(); })),
      h('p', { class: 'note small' }, on ? 'When nobody’s using the display, it shows this album. Tap again for all the photos.' : 'When nobody’s using the display, it shows all the photos.'),
      h('div', { class: 'actions' },
        x.from ? (linkOf(x) ? btn('Stop keeping it here', () => { close(); confirmCard(`Stop keeping ${x.name} here?`, 'Stop', () => { album = null; draw(); phone.stopAlbum(linkOf(x).id); }); }, { soft: true }) : null) : btn('Take the album away', () => { close(); confirmCard(`Take the album ${x.name} away?`, 'Take it away', () => { album = null; H.albums = H.albums.filter((y) => y !== x); draw(); house.removeAlbum(x.id); }, 'Keep it'); }, { soft: true }),
        btn('Rename', () => { close(); ask({ title: 'Rename the album', initial: x.name, onDone: (name) => { x.name = name; draw(); house.renameAlbum(x.id, name); } }); }, { soft: true }),
        btn('Done', close)),
    ];
  }, { width: 860 });
}
/** A photo's card: big, its caption (shown with it in the slideshow and on the idle screen), its albums. */
function photoCard(p) {
  const field = h('input', { class: 'field', placeholder: 'A caption (optional): who, where, when', enterkeyhint: 'done', autocapitalize: 'sentences', autocomplete: 'off', spellcheck: 'false' });
  field.value = captionOf(p);
  const keep = () => { const t = field.value.trim(); if (t === captionOf(p)) return; H.captions = { ...(H.captions || {}), [p]: t }; if (!t) delete H.captions[p]; house.caption(p, t); };
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
      btn('Play from here', () => { keep(); close(); grid = false; startAt = p; draw(); }, { soft: true }),
      btn('Done', () => { keep(); close(); })),
  ], { width: 1000, onOutside: (close) => { keep(); close(); } });
  s.redraw = () => {}; // (drawn once: the field keeps what's being typed while the house updates)
}

/** Photos taken off in the last 30 days: tap one to put it back. */
function takenOff() {
  openCard((close) => [
    h('h2', null, 'Taken off'),
    h('p', { class: 'note' }, 'Photos taken off stay here for 30 days. Tap one to put it back.'),
    (H.removed || []).length ? h('div', { class: 'grid small vscroll' }, H.removed.map((n) => {
      const img = h('img', { class: 'photo', alt: '', draggable: 'false' });
      house.thumb(n, 240, true).then((src) => { img.src = src; }).catch(() => {});
      return h('div', { class: 'cell', tap: () => { H.removed = H.removed.filter((x) => x !== n); H.photos = [n, ...H.photos]; draw(); house.restorePhoto(n); } }, img);
    })) : h('p', { class: 'note' }, 'Nothing left to put back.'),
    h('div', { class: 'actions' }, btn('Done', close)),
  ], { width: 1000 });
}

function removingMany(names) {
  openCard((close) => [
    h('h2', { class: 'big' }, names.length === 1 ? 'Take this photo off?' : `Take these ${names.length} photos off?`),
    h('p', null, 'They’re put aside on the display, not deleted.'),
    h('div', { class: 'actions' },
      btn('Keep them', close, { soft: true }),
      btn('Take them off', () => { close(); picking = null; H.photos = H.photos.filter((x) => !names.includes(x)); draw(); for (const n of names) house.removePhoto(n); }, { color: 'var(--red)' })),
  ], { width: 760 });
}

function removing(p) {
  openCard((close) => [
    photo(p, 'preview'),
    h('h2', { class: 'big' }, 'Take this photo off?'),
    h('div', { class: 'actions' },
      btn('Keep it', close, { soft: true }),
      btn('Take it off', () => { close(); H.photos = H.photos.filter((x) => x !== p); draw(); house.removePhoto(p); }, { color: 'var(--red)' })),
  ], { width: 760 });
}

// The slideshow: newest first, then shuffled; crossfades every SECONDS. It stays put while the house updates.
let show = null, startAt = null; // startAt: a photo tapped in the grid, shown first
function slideshow(photos) {
  const key = photos.join('\n');
  if (show && show.key === key && $app.contains(show.el) && !startAt) { show.count.textContent = `${photos.length} photos` + (albumOf() ? ` · ${albumOf().name}` : ''); show.cap.textContent = captionOf(show.order[show.i]); return; }
  stopShow();
  const first = startAt && photos.includes(startAt) ? startAt : photos[0]; startAt = null;
  const order = [first, ...photos.filter((x) => x !== first).sort(() => Math.random() - .5)];
  const layers = [h('img', { class: 'slide', alt: '', draggable: 'false' }), h('img', { class: 'slide', alt: '', draggable: 'false' })];
  const count = h('div', { class: 'count' }, `${photos.length} photos` + (albumOf() ? ` · ${albumOf().name}` : ''));
  const cap = h('div', { class: 'caption' });
  const el = h('div', { class: 'show', tap: () => { grid = true; draw(); } }, layers, h('div', { class: 'shade' }), cap, count);
  $app.replaceChildren(el);
  show = { key, el, count, cap, order, i: 0, front: 0, timer: 0 };
  const s = show;
  const put = async (i) => {
    const src = await house.photo(order[i]).catch(() => null);
    if (!src || show !== s) return;
    const next = layers[1 - s.front];
    next.src = src; await next.decode().catch(() => {});
    if (show !== s) return;
    next.classList.add('on'); layers[s.front].classList.remove('on'); s.front = 1 - s.front; s.i = i;
    cap.textContent = captionOf(order[i]);
  };
  put(0);
  if (order.length > 1) s.timer = setInterval(() => put((s.i + 1) % order.length), SECONDS * 1000);
}
function stopShow() { if (show) { clearInterval(show.timer); show = null; } }

house.subscribe((d) => { H = d; draw(); });

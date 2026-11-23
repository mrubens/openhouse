// The weather's look, shared by the Weather tab (defaults/apps/weather) and the Weather card on Today (chat/src/home.jsx):
// a sky that follows the time and the conditions, quiet line icons, the hours on a temperature curve, the week's
// low-to-high bars on one cold-to-warm scale, a sun arc, and the model's lines (GET /weather's `sense`). Plain HTML
// strings from the /weather shape; the styles are weather-look.css, sized in --wu (the tab: its width / 1302; Today: --u).
// Animation is transforms and opacity only, and none at night, when dimmed, or under .paused (hidden).

const pad = (n) => String(n).padStart(2, '0');
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const u = (n) => `calc(${+n.toFixed(2)} * var(--wu))`;
const clock = (d, mins = true) => { const h = d.getHours(), m = d.getMinutes(); return `${h % 12 || 12}${mins && m ? ':' + pad(m) : ''}${h < 12 ? 'a' : 'p'}`; };
const num = (v) => (Number.isFinite(v) ? Math.round(v) : '–');
const isSnow = (c) => (c >= 71 && c <= 77) || c === 85 || c === 86;
const isWet = (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;

/** Which sky: night, dusk (or dawn: within 45 minutes of sunset or sunrise), rain, snow, fog, overcast or clear. */
export function skyOf(w, now = Date.now(), night = false) {
  const c = w.code ?? 3;
  if (night || w.isDay === false) return 'night';
  if (isSnow(c)) return 'snow';
  if (isWet(c)) return 'rain';
  if (c === 45 || c === 48) return 'fog';
  const near = (s) => { if (!s) return false; const t = new Date(s); const d = new Date(now); t.setFullYear(d.getFullYear(), d.getMonth(), d.getDate()); return Math.abs(now - t) < 45 * 60e3; };
  if (c <= 2 && (near(w.sunset) || near(w.sunrise))) return 'dusk';
  return c >= 3 ? 'overcast' : 'clear';
}

// ---- icons: line icons in the text colour (WMO codes) ----
const CLOUD = 'M14 36H34a7 7 0 0 0 1.5-13.9a10 10 0 0 0-19.4-1.6a7.8 7.8 0 0 0-2.1 15.5z';
let uid = 0;
const sun = (s = 1, x = 0, y = 0) => `<g transform="translate(${x} ${y}) scale(${s})"><circle cx="24" cy="24" r="8"/>${[...Array(8)].map((_, i) => { const a = i * Math.PI / 4, c = Math.cos(a), n = Math.sin(a); return `<line x1="${(24 + c * 13).toFixed(2)}" y1="${(24 + n * 13).toFixed(2)}" x2="${(24 + c * 17.5).toFixed(2)}" y2="${(24 + n * 17.5).toFixed(2)}"/>`; }).join('')}</g>`;
const moon = (s = 1, x = 0, y = 0) => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M29 10A14 14 0 1 0 38 32A11.5 11.5 0 0 1 29 10z"/></g>`;
const cloud = (dy = 0) => `<path transform="translate(0 ${dy})" d="${CLOUD}"/>`;
export function icon(code, isDay = true) {
  let inner;
  if (code === 0) inner = isDay ? sun() : moon();
  else if (code === 1 || code === 2) { const id = 'wxm' + (++uid); inner = `<mask id="${id}"><rect width="48" height="48" fill="#fff"/><path d="${CLOUD}" transform="translate(5 6) scale(.9)" fill="#000" stroke="#000" stroke-width="6"/></mask><g mask="url(#${id})">${isDay ? sun(.62, 1, 0) : moon(.66, 3, -1)}</g><g transform="translate(5 6) scale(.9)">${cloud()}</g>`; }
  else if (code === 3) inner = cloud();
  else if (code === 45 || code === 48) inner = cloud(-6) + '<line x1="12" y1="38" x2="36" y2="38"/><line x1="16" y1="44" x2="32" y2="44"/>';
  else if (code >= 51 && code <= 57) inner = cloud(-6) + '<line x1="19" y1="37" x2="18" y2="40"/><line x1="29" y1="37" x2="28" y2="40"/><line x1="24" y1="42" x2="23" y2="45"/>';
  else if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) inner = cloud(-6) + '<line x1="18" y1="36" x2="15" y2="44"/><line x1="26" y1="36" x2="23" y2="44"/><line x1="34" y1="36" x2="31" y2="44"/>';
  else if (isSnow(code)) inner = cloud(-6) + '<circle cx="17" cy="39" r="1.1"/><circle cx="25" cy="42" r="1.1"/><circle cx="33" cy="39" r="1.1"/><circle cx="21" cy="45.5" r="1.1"/><circle cx="29" cy="45.5" r="1.1"/>';
  else if (code >= 95) inner = cloud(-6) + '<path d="M26 34l-5 6h6l-4 6"/>';
  else inner = cloud();
  return `<svg class="ic" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// ---- the sky: the gradient is the state's class (weather-look.css); on it, at most four slow layers ----
const blob = (id, fill, parts, style) => {
  const [r, g, b, al] = fill.match(/[\d.]+/g).map(Number), c = (k) => `rgba(${r},${g},${b},${+(al * k).toFixed(3)})`, k = .6;
  return `<div class="cloud ${id}" style="${style}"><div style="position:absolute;inset:${-(1 / k - 1) * 50}%;background:${parts.map(([x, y, rx, ry]) => `radial-gradient(ellipse ${(rx / 6 * 1.45 * k).toFixed(1)}% ${(ry / 2 * 1.45 * k).toFixed(1)}% at ${(50 + (x / 6 - 50) * k).toFixed(1)}% ${(50 + (y / 2 - 50) * k).toFixed(1)}%, ${c(1)} 0, ${c(.82)} 28%, ${c(.42)} 55%, ${c(.12)} 80%, ${c(0)} 100%)`).join(',')}"></div></div>`;
};
const BANK = [[150, 120, 150, 38], [110, 92, 60, 40], [200, 78, 74, 52], [290, 100, 80, 40], [400, 118, 150, 34], [470, 98, 60, 30]];
const WISP = [[180, 110, 180, 14], [330, 96, 150, 12], [420, 116, 160, 10]];
const tile = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27')}")`;
const streaks = (o) => tile(`<svg xmlns='http://www.w3.org/2000/svg' width='180' height='360'><g stroke='white' stroke-opacity='${o}' stroke-width='1.2' stroke-linecap='round'><path d='M20 10v44M95 120v52M150 40v38M60 230v48M130 280v42M10 150v34M170 200v30'/></g></svg>`);
const flakes = (o) => tile(`<svg xmlns='http://www.w3.org/2000/svg' width='180' height='360'><g fill='white' fill-opacity='${o}'><circle cx='20' cy='30' r='2'/><circle cx='95' cy='140' r='1.6'/><circle cx='150' cy='60' r='2.2'/><circle cx='60' cy='250' r='1.8'/><circle cx='130' cy='300' r='2'/><circle cx='12' cy='170' r='1.5'/><circle cx='170' cy='215' r='1.7'/></g></svg>`);
const STARS = [[8, 12], [17, 30], [26, 8], [33, 44], [41, 17], [12, 58], [22, 74], [37, 66], [6, 84], [48, 34], [58, 9], [71, 5], [90, 7], [29, 90], [44, 82], [3, 40]];
export function sky(kind, w = {}) {
  if (kind === 'clear') return `<div class="sky"><div class="haze"></div><div class="sun"></div>
    ${blob('a', 'rgba(255,255,255,.5)', WISP, 'left:-6%;top:56%;width:70%;height:30%')}${blob('b', 'rgba(255,255,255,.32)', WISP, 'left:30%;top:76%;width:80%;height:26%')}</div>`;
  if (kind === 'overcast') return `<div class="sky">
    ${blob('c', 'rgba(232,236,240,.34)', BANK, 'left:-20%;top:-14%;width:120%;height:52%')}${blob('b', 'rgba(60,72,84,.36)', BANK, 'left:10%;top:16%;width:120%;height:50%')}
    ${blob('a', 'rgba(236,238,240,.3)', BANK, 'left:-30%;top:50%;width:110%;height:52%')}${blob('c', 'rgba(70,80,90,.22)', BANK, 'left:20%;top:70%;width:100%;height:44%')}</div>`;
  if (kind === 'fog') return `<div class="sky">
    ${blob('a', 'rgba(240,242,244,.42)', WISP, 'left:-20%;top:30%;width:140%;height:34%')}${blob('b', 'rgba(240,242,244,.36)', WISP, 'left:-10%;top:58%;width:130%;height:34%')}${blob('c', 'rgba(240,242,244,.3)', WISP, 'left:-30%;top:80%;width:140%;height:30%')}</div>`;
  if (kind === 'rain') return `<div class="sky">
    ${blob('c', 'rgba(16,24,34,.5)', BANK, 'left:-20%;top:-22%;width:130%;height:56%')}${blob('b', 'rgba(150,164,176,.2)', BANK, 'left:-10%;top:30%;width:120%;height:50%')}
    <div class="fall"><i style="background:${streaks(.2)}"></i><i class="b" style="background:${streaks(.12)} 70px 90px / 260px 520px"></i></div></div>`;
  if (kind === 'snow') return `<div class="sky">
    ${blob('c', 'rgba(236,240,246,.34)', BANK, 'left:-20%;top:-18%;width:130%;height:54%')}${blob('b', 'rgba(90,104,122,.22)', BANK, 'left:0%;top:26%;width:120%;height:50%')}
    <div class="fall snow"><i style="background:${flakes(.75)}"></i><i class="b" style="background:${flakes(.5)} 70px 90px / 240px 480px"></i></div></div>`;
  if (kind === 'dusk') return `<div class="sky"><div class="sun"></div>
    ${blob('a', 'rgba(52,34,92,.55)', WISP, 'left:-10%;top:40%;width:86%;height:30%')}${blob('b', 'rgba(255,170,150,.4)', WISP, 'left:-8%;top:45%;width:86%;height:30%')}
    ${blob('c', 'rgba(44,36,96,.5)', WISP, 'left:30%;top:12%;width:90%;height:30%')}</div>`;
  // night: no light and nothing moves; faint stars and a dim moon when it's clear
  const clear = (w.code ?? 3) <= 1;
  return `<div class="sky">${clear ? `<svg class="stars" width="100%" height="100%">${STARS.map(([x, y], i) => `<circle cx="${x}%" cy="${y}%" r="${i % 3 ? 1 : 1.5}" fill="#c9d3e6" opacity="${i % 2 ? .5 : .28}"/>`).join('')}</svg>
    <svg class="moon" viewBox="0 0 48 48"><path d="M29 10A14 14 0 1 0 38 32A11.5 11.5 0 0 1 29 10z" fill="#8f97a8"/></svg>` : ''}</div>`;
}

// ---- the pieces ----
const SCALE = [[5, [120, 150, 255]], [22, [104, 176, 255]], [32, [110, 208, 240]], [41, [128, 222, 190]], [50, [196, 224, 120]], [62, [244, 210, 92]], [76, [246, 165, 74]], [92, [239, 106, 67]]];
function tcol(t) {
  const i = SCALE.findIndex(([x]) => x >= t);
  if (i <= 0) return `rgb(${SCALE[i === 0 ? 0 : SCALE.length - 1][1]})`;
  const [a, ca] = SCALE[i - 1], [b, cb] = SCALE[i], k = (t - a) / (b - a);
  return `rgb(${ca.map((c, j) => Math.round(c + (cb[j] - c) * k))})`;
}
const rainTxt = (p) => (p >= 30 ? Math.round(p / 5) * 5 + '%' : '');

/** The next n hours: time, icon, temperature (on a curve when `curve`), and the rain chance when it's notable. */
export function hoursStrip(w, n, { cls = 'hours', curve = true } = {}) {
  const hs = (w.hours || []).slice(0, n);
  if (!hs.length) return '';
  const tOf = (h, i) => (i ? h.temp : w.temp ?? h.temp), ts = hs.map(tOf), lo = Math.min(...ts), hi = Math.max(...ts), H = 76, top = 34, bot = 6;
  const y = (t) => top + (1 - (t - lo) / Math.max(3, hi - lo)) * (H - top - bot);
  let html = '';
  hs.forEach((h, i) => {
    const col = `grid-column:${i + 1}`;
    html += `<div class="t${i ? '' : ' now'}" style="${col}">${i ? clock(new Date(h.time), false) : 'Now'}</div><div class="i" style="${col}">${icon(h.code, h.isDay !== false)}</div>`;
    html += curve ? `<div class="p" style="${col}"><span style="top:${u(y(tOf(h, i)) - 9)}">${num(tOf(h, i))}°</span></div>` : `<div class="d" style="${col}">${num(tOf(h, i))}°</div>`;
    html += `<div class="r" style="${col}">${rainTxt(h.rain)}</div>`;
  });
  if (curve) {
    const pts = hs.map((h, i) => [(i + .5) * 100, y(tOf(h, i))]);
    pts.unshift([0, pts[0][1]]); pts.push([hs.length * 100, pts.at(-1)[1]]);
    let d = `M${pts[0]}`;
    for (let i = 0; i < pts.length - 1; i++) { const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2; d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0]},${p2[1].toFixed(1)}`; }
    const g = 'wxg' + (++uid);
    html += `<svg class="curve" viewBox="0 0 ${hs.length * 100} ${H}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".2"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
      <path d="${d}L${pts.at(-1)[0]},${H}L${pts[0][0]},${H}Z" fill="url(#${g})"/><path d="${d}" fill="none" stroke="currentColor" stroke-opacity=".7" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
      <i class="nowdot" style="left:calc(${(50 / hs.length).toFixed(3)}% - ${u(5)});top:${u(74 + pts[1][1] - 5)}"></i>`;
  }
  return `<div class="${cls}">${html}</div>`;
}

/** The days from `from`, n of them: name, icon, rain chance, and the low-to-high bar on the whole week's scale. */
export function dayRows(w, n, { from = 0, rain = true, today = new Date() } = {}) {
  const all = w.days || [];
  if (!all.length) return '';
  const lo = Math.min(...all.map((d) => d.low)), hi = Math.max(...all.map((d) => d.high)), span = Math.max(1, hi - lo), pct = (t) => ((t - lo) / span) * 100;
  const stops = [...Array(7)].map((_, i) => `${tcol(lo + span * i / 6)} ${Math.round(i / 6 * 100)}%`).join(',');
  const key = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  return all.slice(from, from + n).map((d) => {
    const L = pct(d.low), W = Math.max(6, pct(d.high) - L), isToday = d.date === key;
    const name = isToday ? 'Today' : new Date(d.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'short' });
    return `<div class="day"><div>${name}</div><div class="i">${icon(d.code, true)}</div>${rain ? `<div class="r">${rainTxt(d.rain)}</div>` : ''}<div class="lo">${num(d.low)}°</div>
      <div class="track"><div class="fill" style="left:${L.toFixed(1)}%;width:${W.toFixed(1)}%"><i style="width:${(10000 / W).toFixed(1)}%;margin-left:${(-L / W * 100).toFixed(1)}%;background:linear-gradient(90deg,${stops})"></i></div>${isToday && Number.isFinite(w.temp) ? `<div class="mark" style="left:${Math.min(100, Math.max(0, pct(w.temp))).toFixed(1)}%"></div>` : ''}</div><div class="hi">${num(d.high)}°</div></div>`;
  }).join('');
}

/** The sun's day as an arc over the horizon, with where it is now and the next sunrise or sunset. */
export function sunTile(w, now = new Date()) {
  if (!w.sunrise || !w.sunset) return '';
  const h = (s) => { const d = new Date(s); return d.getHours() + d.getMinutes() / 60; };
  const r = h(w.sunrise), s = h(w.sunset), n = now.getHours() + now.getMinutes() / 60, noon = (r + s) / 2, W = 240, H = 80, hz = 52, A = 40;
  const f = (x) => Math.cos(2 * Math.PI * (x - noon) / 24) - Math.cos(2 * Math.PI * (r - noon) / 24);
  const mx = f(noon), mn = -f(noon + 12), X = (x) => x / 24 * W, Y = (x) => hz - (f(x) > 0 ? f(x) / mx * A : f(x) / mn * 20);
  const seg = (a, b) => { let p = ''; for (let x = a; x <= b + 1e-6; x += .25) p += `${p ? 'L' : 'M'}${X(x).toFixed(1)},${Y(x).toFixed(1)}`; return p; };
  const up = n >= r && n <= s, next = n < r || n > s ? ['Sunrise', w.sunrise] : ['Sunset', w.sunset];
  return `<div class="tile sunt"><div class="top"><span class="plab">${next[0]}</span><b>${clock(new Date(next[1]))}</b></div>
    <div class="arc"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${seg(0, r)}" fill="none" stroke="currentColor" stroke-opacity=".28" stroke-width="2" vector-effect="non-scaling-stroke"/><path d="${seg(s, 24)}" fill="none" stroke="currentColor" stroke-opacity=".28" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <path d="${seg(r, s)}" fill="none" stroke="currentColor" stroke-opacity=".85" stroke-width="2.4" vector-effect="non-scaling-stroke"/><line x1="0" x2="${W}" y1="${hz}" y2="${hz}" stroke="currentColor" stroke-opacity=".3" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>
    <i class="sundot${up ? ' up' : ''}" style="left:${(X(n) / W * 100).toFixed(1)}%;top:${(Y(n) / H * 100).toFixed(1)}%"></i></div>
    <div class="ends"><span>${clock(new Date(w.sunrise))}</span><span>${clock(new Date(w.sunset))}</span></div></div>`;
}

const senseHtml = (w, n = 2) => (w.sense || []).slice(0, n).map((s) => `<p>${esc(s.text ?? s)}</p>`).join('');
const classes = (w, kind, extra = '') => `wx s-${kind}${extra}`;

/** The Weather tab's page (fills its frame; the bottom-right corner stays open sky for the assistant). */
export function tab(w, { now = new Date(), night = false, nh = 12 } = {}) {
  const kind = skyOf(w, +now, night), d0 = (w.days || [])[0];
  const wet = d0 && isSnow(d0.code) ? 'Snow' : 'Rain';
  return { kind, cls: classes(w, kind), html: `${sky(kind, w)}<div class="wxgrid">
    <section class="hero"><div class="place">${esc(w.place || '')}</div><div class="temp">${num(w.temp)}°</div><div class="cond">${esc(w.condition || '')}</div><div class="hl">High ${num(w.high)}° · Low ${num(w.low)}°</div>
      ${(w.sense || []).length ? `<div class="sense">${senseHtml(w)}</div>` : ''}</section>
    <section class="right">
      <div class="panel"><div class="plab">Next ${nh} hours</div>${hoursStrip(w, nh)}</div>
      <div class="lower"><div class="panel days"><div class="plab">This week</div>${dayRows(w, 7, { today: now })}</div>
        <div class="tiles">${sunTile(w, now)}
          <div class="tile"><div class="plab">Feels like</div><div class="v">${num(w.feels)}°</div><div class="n">${Number.isFinite(w.feels) && w.temp - w.feels >= 5 ? 'Colder in the wind' : Number.isFinite(w.feels) && w.feels - w.temp >= 5 ? 'Warmer than the air' : 'Close to the air'}</div></div>
          <div class="tile"><div class="plab">Wind</div><div class="v">${num(w.wind)}<small>mph</small></div></div>
          <div class="tile"><div class="plab">Humidity</div><div class="v">${num(w.humidity)}<small>%</small></div></div>
          <div class="tile"><div class="plab">${wet} today</div><div class="v">${num(d0?.rain ?? 0)}<small>%</small></div></div>
        </div></div>
    </section></div>` };
}

/** The Weather card on Today: 'cell' (one cell), 'tall' (two rows) or 'wide' (two columns). */
export function card(w, size = 'cell', { now = new Date(), night = false } = {}) {
  const kind = skyOf(w, +now, night), sense = (w.sense || []).length > 0;
  const head = `<div class="place">${esc(w.place || 'Weather')}</div><div class="wc-now"><div class="wc-temp">${num(w.temp)}°</div><div class="wc-words"><b>${esc(w.condition || '')}</b><span>H ${num(w.high)}°&ensp;L ${num(w.low)}°</span></div></div>`;
  const cls = classes(w, kind, ` wcard ${size}`);
  let html;
  if (size === 'wide') html = `${sky(kind, w)}<div class="l">${head}<div class="wc-sense">${senseHtml(w, 1)}</div></div>
    <div class="r2">${hoursStrip(w, 6, { cls: 'wc-hours', curve: false })}<div class="wc-days">${dayRows(w, 4, { from: 1, today: now })}</div></div>`;
  else if (size === 'tall') html = `${sky(kind, w)}${head}<div class="wc-sense">${senseHtml(w)}</div>
    <div class="wc-bottom">${hoursStrip(w, 5, { cls: 'wc-hours', curve: false })}<div class="wc-days">${dayRows(w, 5, { from: 1, rain: false, today: now })}</div></div>`;
  else html = `${sky(kind, w)}${head}${hoursStrip(w, 5, { cls: 'wc-hours', curve: false })}${sense ? `<div class="wc-sense">${senseHtml(w, 1)}</div>` : `<div class="wc-days">${dayRows(w, 2, { from: 1, rain: false, today: now })}</div>`}`;
  return { kind, cls, html };
}

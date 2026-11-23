// The door, drawn from the brain's data: on the display itself (the shell's DoorView, `?display`) and on any other
// screen on the home network (an old tablet, an iPad, a frame with a browser; docs/brain-screens.md).
//
// On the display it talks to the bridge as the display (its secret, from window.OpenhouseDisplay), places anything new
// on the door, and asks the shell for what only it can do (open an app, the settings, the weather sheet, a video); the
// shell's overlay (the assistant's note, typing) sits above it and the shell rings the timers.
// On another screen it pairs once (the QR code from Settings), then every request is sealed with that screen's
// own key (screen-client.js); the brain can remove the screen at any time.
//
// Both move things on the same grid rules as the bridge (bridge/grid.js).
import { createRoot } from 'react-dom/client';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as G from '../../bridge/grid.js';
import { Talk } from './talk.jsx';
import { pair, client, Removed } from './screen-client.js';
import { AnswerBody, Display, page as answerPage } from './answer.jsx';
import { Widget, Fit, IconFill, U } from './door-widgets.jsx';
import { Home as HomeTabs, appOrigin } from './home.jsx';
import { pairingFromCode, cleanCode } from './scrypt.js';

/** A TV's browser (docs/phones-and-tv.md): it joins with a code typed on its remote, and shows the TV layout. */
const TV = new URLSearchParams(location.search).has('tv');

// The shell's object is given to every frame in this page (a live widget, a video), so it answers hello() once, to
// this script as it starts, with the display's secret and a word every later call must carry (shell/DoorView.kt).
const shell = (() => {
  const raw = window.OpenhouseDisplay && new URLSearchParams(location.search).has('display') ? window.OpenhouseDisplay : null;
  let hi = null; try { hi = raw && JSON.parse(raw.hello() || 'null'); } catch {}
  if (!hi?.gate) return null;
  const g = hi.gate;
  return { token: () => hi.token, ui: hi.ui, openApp: (id) => raw.openApp(g, id), settings: () => raw.settings(g), plugins: raw.plugins ? () => raw.plugins(g) : null, type: raw.type ? () => raw.type(g) : undefined, sleep: raw.sleep ? () => raw.sleep(g) : undefined, weather: () => raw.weather(g), touch: () => raw.touch(g),
    idle: () => raw.idle(g), sleeping: () => { try { return !!raw.sleeping(g); } catch { return false; } }, dim: (on) => { try { raw.dim(g, !!on); } catch {} }, ask: (t) => raw.ask(g, t), androidApps: () => raw.androidApps(g), video: (u) => raw.video(g, u),
    phone: raw.phone ? (kind, arg) => raw.phone(g, kind, arg) : null, editing: (on) => { try { raw.editing(g, !!on); } catch {} } };
})();
const STORE = 'openhouse.screen';
const load = () => { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; } };
const keep = (v) => { try { v ? localStorage.setItem(STORE, JSON.stringify(v)) : localStorage.removeItem(STORE); } catch {} };

/** The display's own way to the bridge: plain requests with its secret (same calls as screen-client's). */
function displayClient() {
  const td = new TextDecoder();
  async function request(m, p, b, { signal, onData } = {}) {
    const r = await fetch(p, { method: m, signal, headers: { 'x-openhouse-token': shell.token(), ...(m === 'POST' ? { 'content-type': 'application/json' } : {}) }, body: m === 'POST' ? JSON.stringify(b ?? {}) : undefined });
    const type = r.headers.get('content-type') || '';
    if (onData) { const rd = r.body.getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; onData(value); } return { status: r.status, type, body: new Uint8Array(0) }; }
    return { status: r.status, type, body: new Uint8Array(await r.arrayBuffer()) };
  }
  const json = async (m, p, b, o) => { const r = await request(m, p, b, o); let j = null; try { j = JSON.parse(td.decode(r.body)); } catch {} return { status: r.status, json: j }; };
  const lines = async (m, p, b, onLine, o = {}) => {
    let rest = '';
    const r = await request(m, p, b, { ...o, onData: (d) => { rest += td.decode(d, { stream: true }); let k; while ((k = rest.indexOf('\n')) >= 0) { const l = rest.slice(0, k); rest = rest.slice(k + 1); if (l.trim()) try { onLine(JSON.parse(l)); } catch {} } } });
    return r.status;
  };
  return { request, json, lines };
}

// ---- pairing (another screen) ---------------------------------------------------------------------------
function Pairing({ onJoined, removed }) {
  if (TV && !/^#[\w-]+\.[\w-]{43}$/.test(location.hash)) return <TvPairing onJoined={onJoined} removed={removed} />;
  const [ask] = useState(() => { const m = location.hash.slice(1).match(/^([\w-]+)\.([\w-]{43})$/); return m && { pair: m[1], key: m[2] }; });
  const [name, setName] = useState('');
  const [step, setStep] = useState(ask ? 'name' : 'none'); // name, asked, refused, ended
  useEffect(() => { if (ask) history.replaceState(null, '', location.pathname + location.search); }, []); // the key leaves the address bar
  async function join(e) {
    e.preventDefault();
    try {
      const w = await pair({ ...ask, name: name.trim() || 'Screen', onAsked: () => setStep('asked') });
      if (w.refused) return setStep('refused');
      keep(w); onJoined(w);
    } catch { setStep('ended'); }
  }
  return (
    <div className="pairing">
      {step === 'name' && <form onSubmit={join}>
        <h1>Join the door</h1>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this screen" maxLength={40} />
        <button className="go">Join</button>
      </form>}
      {step === 'asked' && <><h1>Waiting</h1><p className="muted">Say yes on the main display.</p><div className="dots"><i /><i /><i /></div></>}
      {step === 'refused' && <><h1>Not this time</h1><p className="muted">The main display said no.</p></>}
      {(step === 'none' || step === 'ended') && <>
        <h1>{removed ? 'This screen was removed' : 'Scan the code'}</h1>
        <p className="muted">On the main display: Settings, Screens and computers, Add a screen.</p>
      </>}
    </div>
  );
}

/** A TV joins by showing a code that someone types on the tablet (no typing with the remote). The code stays the
 *  same until it's used, so turning the TV off and on shows the same one. */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function tvCode() {
  try { const c = localStorage.getItem('openhouse.tv.code'); if (c && cleanCode(c)) return c; } catch {}
  const r = crypto.getRandomValues(new Uint8Array(12)); let c = ''; for (const x of r) c += B32[x & 31];
  c = `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
  try { localStorage.setItem('openhouse.tv.code', c); } catch {}
  return c;
}
function TvPairing({ onJoined, removed }) {
  const [code] = useState(tvCode), [step, setStep] = useState('show');
  useEffect(() => {
    let stop = false;
    (async () => {
      await new Promise((r) => setTimeout(r, 50));
      const via = pairingFromCode(code); // scrypt: a moment on a slow TV, once
      while (!stop) {
        try {
          const r = await fetch('/pair/ready?pair=' + encodeURIComponent(via.pair), { cache: 'no-store' }).then((x) => x.json());
          if (r.ready) {
            setStep('joining');
            const w = await pair({ ...via, name: 'TV' });
            if (w.refused) { setStep('show'); continue; }
            try { localStorage.removeItem('openhouse.tv.code'); } catch {}
            keep(w); return onJoined(w);
          }
        } catch { setStep('show'); }
        await new Promise((r) => setTimeout(r, 3000));
      }
    })();
    return () => { stop = true; };
  }, []);
  return (
    <div className="tv-pair">
      <div className="brand">OpenHouse</div>
      {step === 'joining' ? <h1>Joining</h1> : <>
        <h1>{removed ? 'This TV was removed. To add it again:' : 'To show the household here:'}</h1>
        <p>On the tablet, open Settings, Screens, Add a screen, A TV, and type</p>
        <div className="tv-code">{code}</div>
      </>}
    </div>
  );
}

// ---- data from the brain ------------------------------------------------------------------------------
function useBrain(c, onRemoved) {
  const [door, setDoor] = useState(null), [house, setHouse] = useState(null), [weather, setWeather] = useState(null), [apps, setApps] = useState(null), [board, setBoard] = useState(null);
  const [up, setUp] = useState(true);
  useEffect(() => {
    let stop = false;
    const guard = (e) => { if (e instanceof Removed) { stop = true; onRemoved(); } else setUp(false); };
    const follow = async (p, set) => { // the brain answers when it changes (25 s at most)
      let v = -1;
      while (!stop) {
        try { const r = await c.json('GET', v < 0 ? p : `${p}/wait?v=${v}`); if (r.status !== 200) throw new Error(); v = r.json.v; set(r.json); setUp(true); }
        catch (e) { guard(e); if (!stop) await new Promise((r) => setTimeout(r, 3000)); }
      }
    };
    const every = async (p, set, ms) => { while (!stop) { try { const r = await c.json('GET', p); if (r.status === 200) set(r.json); } catch (e) { guard(e); } await new Promise((r) => setTimeout(r, ms)); } };
    follow('/door', setDoor); follow('/house', setHouse);
    every('/weather', setWeather, 10 * 60e3); every('/apps', (a) => Array.isArray(a) && setApps(a), 20e3); every('/board', setBoard, 5 * 60e3);
    return () => { stop = true; };
  }, [c]);
  return { door, setDoor, house, weather, apps: apps || [], appsLoaded: apps != null, board, up };
}

/** A photo from the brain (from another screen it comes sealed, so not as a plain <img src>). */
const photoCache = new Map();
function usePhoto(c, name) {
  const [src, setSrc] = useState(() => photoCache.get(name) || null);
  useEffect(() => {
    if (!name) return;
    if (photoCache.has(name)) return setSrc(photoCache.get(name));
    let stop = false;
    c.request('GET', '/house/photo/' + encodeURIComponent(name)).then((r) => {
      if (r.status !== 200) return;
      const url = URL.createObjectURL(new Blob([r.body], { type: r.type }));
      photoCache.set(name, url);
      if (photoCache.size > 40) { const [k, u] = photoCache.entries().next().value; URL.revokeObjectURL(u); photoCache.delete(k); }
      if (!stop) setSrc(url);
    }).catch(() => {});
    return () => { stop = true; };
  }, [name]);
  return src;
}

// ---- the door's things --------------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
const fmt = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`; };
const MAGNETS = ['#d9543f', '#3f74d9', '#4fa87a', '#e2a93b', '#8b5cc9', '#2fa3a8'];
const PEOPLE = ['#d9a441', '#6fae8f', '#d97a5e', '#7d9ad6', '#b689cf', '#d6a86a'];
const hash = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); };
const personColor = (house, who) => { const i = (house?.family || []).findIndex((p) => p.name.toLowerCase() === String(who || '').toLowerCase()); return i < 0 ? null : house.family[i].color || PEOPLE[i % PEOPLE.length]; };
/** An event's color: its person's, or each one's in turn when it's for several (its person and whoever else). */
const eventPaint = (house, e) => { const cs = [e?.who, ...(e?.also || [])].map((n) => n && personColor(house, n)).filter(Boolean); return cs.length > 1 ? `linear-gradient(135deg, ${cs.map((c, i) => `${c} ${i * 100 / cs.length}% ${(i + 1) * 100 / cs.length}%`).join(', ')})` : cs[0] || null; };

/** The family's own small clock (their home style: clock "compact"). */
function CompactClock({ now }) {
  const d = new Date(now);
  return <div className="tile compact-clock"><div className="time">{d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div><div className="date">{d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</div></div>;
}
function Clock({ now, w }) {
  const d = new Date(now);
  return <div className="tile clock"><div className="time">{hm(d)}</div>{w > 1 && <div className="date">{d.toLocaleDateString([], { weekday: 'long' })}</div>}</div>;
}
const SKY_WORDS = (code) => code === 0 ? 'Clear sky' : code === 1 ? 'Mostly clear' : code === 2 ? 'Partly cloudy' : code === 3 ? 'Overcast' : [45, 48].includes(code) ? 'Fog'
  : [51, 53, 55].includes(code) ? 'Drizzle' : [56, 57].includes(code) ? 'Freezing drizzle' : [61, 63, 65].includes(code) ? 'Rain' : [66, 67].includes(code) ? 'Freezing rain'
  : [71, 73, 75, 77].includes(code) ? 'Snow' : [80, 81, 82].includes(code) ? 'Rain showers' : [85, 86].includes(code) ? 'Snow showers' : code >= 95 ? 'Thunderstorms' : '';
/** The family's animated sky (their home style: weather "family"): sun or moon, a drifting cloud, rain, snow, fog, lightning. */
function Sky({ code, day, size }) {
  if (code == null || code < 0) return null;
  const snow = [71, 73, 75, 77, 85, 86].includes(code), wet = code >= 51 && code <= 99;
  return (
    <svg className="sky" viewBox="0 0 100 100" width={size} height={size}>
      {code <= 2 && <g className={day ? 'sun' : ''}>
        <circle cx="48" cy="38" r="21" fill={day ? '#ffda79' : '#d5e7ff'} />
        {!day && <circle cx="58" cy="31" r="19" fill="#172d46" />}
        {day && [...Array(8)].map((_, i) => { const a = (i / 8) * Math.PI * 2; return <line key={i} x1={48 + Math.cos(a) * 27} y1={38 + Math.sin(a) * 27} x2={48 + Math.cos(a) * 33} y2={38 + Math.sin(a) * 33} stroke="#ffda79" strokeWidth="2.5" strokeLinecap="round" />; })}
      </g>}
      {code > 0 && <g className="cloud" fill={wet ? '#a8c1d8' : '#dce8f1'}><ellipse cx="50" cy="54" rx="35" ry="15" /><circle cx="43" cy="39" r="18" /><circle cx="65" cy="44" r="14" /></g>}
      {wet && [0, 1, 2, 3].map((i) => snow
        ? <circle key={i} className="fall" style={{ animationDelay: `${-i * 1.15}s` }} cx={23 + i * 17} cy="72" r="2.5" fill="#fff" />
        : <line key={i} className="fall" style={{ animationDelay: `${-i * 1.15}s` }} x1={23 + i * 17} y1="70" x2={19.5 + i * 17} y2="79" stroke="#8cd5ff" strokeWidth="2.5" strokeLinecap="round" />)}
      {(code === 45 || code === 48) && [0, 1, 2].map((i) => <line key={i} x1="12" x2="88" y1={65 + i * 10} y2={65 + i * 10} stroke="#dce8f1" strokeWidth="3" strokeLinecap="round" />)}
      {code >= 95 && <polyline points="57,55 46,77 57,74 44,95" fill="none" stroke="#ffda79" strokeWidth="6" strokeLinejoin="round" />}
    </svg>
  );
}
function FamilyWeather({ weather, w, h }) {
  if (!weather || weather.error) return <div className="tile family-weather" />;
  const day = weather.isDay !== false, big = w * h >= 8;
  const hours = (weather.hours || []).slice(0, 6);
  return (
    <div className={'tile family-weather' + (day ? '' : ' night')}>
      <div className="fw-head"><div className="fw-place">{weather.place}</div></div>
      <div className="fw-now">
        <div className="fw-temp">{weather.temp}°</div>
        <Sky code={weather.code} day={day} size="1.9em" />
        {w > 1 && <div className="fw-words"><div>{SKY_WORDS(weather.code) || weather.condition}</div>{weather.feels != null && <div className="soft">Feels like {weather.feels}°</div>}<div>H {weather.high}° L {weather.low}°</div>{big && weather.days?.[0]?.rain != null && <div className="soft">Rain / snow {weather.days[0].rain}%</div>}</div>}
      </div>
      {big && <div className="fw-hours">{hours.map((x) => (
        <div key={x.time} className="fw-hour"><div className="soft">{new Date(x.time).toLocaleTimeString('en-US', { hour: 'numeric' }).replace(' ', '')}</div><Sky code={x.code} day={x.isDay} size="1.6em" /><div>{x.temp}°</div>{x.rain != null && <div className="soft small">{x.rain}%</div>}</div>
      ))}</div>}
    </div>
  );
}
function Weather({ weather, w, h, family }) {
  if (family) return <FamilyWeather weather={weather} w={w} h={h} />;
  if (!weather || weather.error) return <div className="tile weather" />;
  return (
    <div className={'tile weather' + (weather.isDay === false ? ' night' : '')}>
      {w * h > 1 && <div className="place">{weather.place}</div>}
      <div className="temp">{weather.temp}°</div>
      <div className="cond">{weather.condition}</div>
      {w * h > 1 && <div className="hilo">H:{weather.high}° L:{weather.low}°</div>}
    </div>
  );
}
function AppIcon({ app, id, name, old, img }) {
  const svg = app?.icon && `data:image/svg+xml,${encodeURIComponent(app.icon)}`;
  const label = name || app?.meta?.name || id;
  return (
    <div className={'tile app' + (old ? ' old' : '')} style={{ '--sticker': MAGNETS[hash(id) % MAGNETS.length] }}>
      {svg ? <img className="icon" src={svg} alt="" draggable={false} />
        : img ? <div className="icon letter"><img className="own" src={img} alt="" draggable={false} /></div> // an Android app's own icon, on its sticker
        : <div className="icon letter hand">{label[0].toUpperCase()}</div>}
      <div className="name hand">{label}</div>
    </div>
  );
}

/** The family's photos, one at a time, edge to edge (the Photos widget). */
function PhotoShow({ c, names, now, seconds = 15 }) {
  const name = names.length ? names[Math.floor(now / (seconds * 1000)) % names.length] : null;
  const src = usePhoto(c, name);
  return <div className="tile photo">{src ? <img src={src} alt="" draggable={false} /> : null}</div>;
}

// Timers ring on the display (the shell rings them) and, on other screens, here. Web Audio needs a tap on the page first.
let audio = null;
const unlock = () => { if (shell) return; try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch {} };
function beep() {
  if (!audio) return;
  const o = audio.createOscillator(), g = audio.createGain();
  o.frequency.value = 880; g.gain.setValueAtTime(0.0001, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.3, audio.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.4);
  o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.45);
}
/**
 * A whiteboard on the door: draw on it with a finger or a pen, right there. The strip along the top holds the pens,
 * undo and wipe, and is where it's picked up to move; the drawing is the brain's (door.js), so every screen has it.
 */
const INKS = ['#24282a', '#d9543f', '#3f76db', '#4fa877'];
function Whiteboard({ c, v }) {
  const pad = useRef(null), live = useRef(null), paintNow = useRef(() => {});
  const [strokes, setStrokes] = useState([]), [ink, setInk] = useState(INKS[0]);
  useEffect(() => {
    let off = false;
    c.json('GET', '/door/sketch').then((r) => { if (!off && r.status === 200 && !live.current) setStrokes(r.json.strokes || []); }).catch(() => {});
    return () => { off = true; };
  }, [c, v]);
  paintNow.current = () => {
    const cv = pad.current; if (!cv) return;
    const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1, W = Math.max(1, Math.round(r.width * d)), H = Math.max(1, Math.round(r.height * d));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d'); g.clearRect(0, 0, W, H); g.lineCap = 'round'; g.lineJoin = 'round';
    for (const s of live.current ? [...strokes, live.current] : strokes) {
      g.strokeStyle = s.c; g.lineWidth = Math.max(1, s.w * Math.min(W, H) / 1000); g.beginPath();
      for (let i = 0; i < s.p.length; i += 2) { const x = s.p[i] * W / 1000, y = s.p[i + 1] * H / 1000; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      if (s.p.length === 2) g.lineTo(s.p[0] * W / 1000 + 0.01, s.p[1] * H / 1000); // a dot
      g.stroke();
    }
  };
  useEffect(() => { paintNow.current(); });
  useEffect(() => { const ro = new ResizeObserver(() => paintNow.current()); ro.observe(pad.current); return () => ro.disconnect(); }, []);
  const at = (e) => { const r = pad.current.getBoundingClientRect(), f = (n) => Math.round(Math.max(0, Math.min(1, n)) * 1000); return [f((e.clientX - r.left) / r.width), f((e.clientY - r.top) / r.height)]; };
  const start = (e) => {
    unlock();
    if (!e.isPrimary) { live.current = null; paintNow.current(); return; } // a second finger: not drawing
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    live.current = { c: ink, w: 9, p: at(e) }; paintNow.current();
  };
  const move = (e) => {
    const s = live.current; if (!s || !e.isPrimary) return;
    for (const ev of (e.nativeEvent.getCoalescedEvents?.() || [e.nativeEvent])) { const [x, y] = at(ev), n = s.p.length; if (Math.abs(x - s.p[n - 2]) + Math.abs(y - s.p[n - 1]) >= 3 && n < 800) s.p.push(x, y); }
    paintNow.current();
  };
  const end = () => { const s = live.current; if (!s) return; live.current = null; setStrokes((a) => [...a, s]); c.json('POST', '/door/sketch', { add: s }).catch(() => {}); };
  const undo = () => { setStrokes((a) => a.slice(0, -1)); c.json('POST', '/door/sketch', { undo: true }).catch(() => {}); };
  const wipe = () => { setStrokes([]); c.json('POST', '/door/sketch', { clear: true }).catch(() => {}); };
  return (
    <div className="tile whiteboard">
      <div className="wb-bar">
        {INKS.map((k) => <button key={k} className={'wb-ink' + (k === ink ? ' on' : '')} style={{ background: k }} onClick={() => setInk(k)} aria-label="Pen" />)}
        <span className="wb-gap" />
        <button className="wb-do" onClick={undo} aria-label="Undo"><svg viewBox="0 0 24 24"><path d="M9 7 4 12l5 5M4 12h10a5 5 0 0 1 0 10h-2" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
        <button className="wb-do" onClick={wipe} aria-label="Wipe"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg></button>
      </div>
      <canvas ref={pad} className="wb-pad" onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
    </div>
  );
}
/**
 * An app's own live widget: its widget.html, running in its cells, so they use it right on the door. Optional: an app
 * without one shows its icon (or the layout its assistant set). The strip along the top is where it's picked up to
 * move, and has the button that opens the app full size. The page gets the app's own key, never the display's.
 */
function LiveWidget({ c, app, w, h }) {
  const [key, setKey] = useState(null);
  const frame = useRef(null);
  useEffect(() => { // its key, by message to its own origin when its kit asks (never in its address)
    const origin = appOrigin(shell, app);
    const on = (e) => { if (key && e.source === frame.current?.contentWindow && e.origin === origin && e.data?.openhouse === 'hello') e.source.postMessage({ openhouse: 'key', key }, origin); };
    addEventListener('message', on); return () => removeEventListener('message', on);
  }, [key, app.id, app.shared]);
  useEffect(() => {
    let off = false;
    c.json('GET', '/apps/key?app=' + encodeURIComponent(app.id)).then((r) => { if (!off && r.status === 200) setKey(r.json.key); }).catch(() => {});
    return () => { off = true; };
  }, [c, app.id]);
  return (
    <div className="tile live">
      <div className="wb-bar">
        <span className="live-name hand">{app.meta?.name || app.id}</span>
        <span className="wb-gap" />
        <button className="wb-do" onClick={() => shell.openApp(app.id)} aria-label="Open"><svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
      </div>
      {key && <iframe ref={frame} className="live-pad" title={app.meta?.name || app.id} sandbox="allow-scripts allow-same-origin" src={`${appOrigin(shell, app)}/apps/${app.id}/widget.html?w=${w}&h=${h}`} />}
    </div>
  );
}
function Timer({ t, now }) {
  const left = Math.max(0, Math.ceil((t.endAt - now) / 1000)), ringing = left === 0;
  useEffect(() => { if (ringing && now - t.endAt < 5 * 60e3) beep(); }, [ringing && Math.floor(now / 1000)]);
  const frac = t.total ? Math.min(1, left / t.total) : 0;
  return (
    <div className={'tile timer' + (ringing ? ' ringing' : '')}>
      <svg viewBox="0 0 100 100" className="dial"><circle cx="50" cy="50" r="44" className="track" /><circle cx="50" cy="50" r="44" className="arc" style={{ strokeDasharray: `${276.5 * frac} 276.5` }} /></svg>
      <div className="left">{ringing ? 'Done!' : fmt(left)}</div><div className="label">{t.label}</div>
    </div>
  );
}
/** Sticky colors the assistant can ask for. */
const STICKY = { pink: 'var(--sticky-pink)', blue: 'var(--sticky-blue)', green: 'var(--sticky-green)', orange: 'var(--sticky-orange)', white: 'var(--paper)', yellow: 'var(--sticky)' };
/** A note: it fills its cells, and what's on it shrinks to fit (not below 0.6; past that it's cut at the bottom, and a
 *  tap opens it whole), like the display's NotePaper. One or two cells: a quick sticky. */
function Note({ n, house }) {
  const color = personColor(house, n.for);
  const { w, h } = G.dims(n.size); const small = w * h <= 2;
  const paper = n.paper || (small ? 'sticky' : 'card');
  const bg = paper === 'sticky' ? (STICKY[n.color] || 'var(--sticky)') : n.color && /^#[0-9a-f]{6}$/i.test(n.color) ? n.color : null;
  return (
    <div className={'tile paper note ' + paper + (small ? ' small' : '')} style={{ ...(bg ? { background: bg } : {}), transform: `rotate(${((hash(n.id) % 5) - 2) * (paper === 'sticky' ? 0.5 : 0.25)}deg)` }}>
      {paper === 'sticky' && <span className="tape" />}
      {paper !== 'sticky' && <span className="magnet" style={{ background: color || MAGNETS[hash(n.id) % MAGNETS.length] }} />}
      <Fit min={0.6}>
        {n.title && n.title !== 'Note' && <div className={'note-title ' + (paper === 'card' ? 'round' : 'hand')}>{n.title}</div>}
        <div className="note-body"><AnswerBody text={n.content} /></div>
      </Fit>
    </div>
  );
}

// ---- the door -----------------------------------------------------------------------------------------
/** What should be on the door that isn't a note: the clock, the weather, every app, the timers. */
function wanted(door, apps, android) {
  const keys = [];
  if (door?.style?.clock !== false) keys.push('clock');
  keys.push('weather');
  if (door?.style?.whiteboard !== false) keys.push('whiteboard');
  for (const a of [...android, ...apps]) keys.push('app:' + a.id);
  for (const t of door?.timers || []) keys.push('timer:' + t.endAt);
  return keys;
}
function itemsOf(door, present) {
  if (!door) return [];
  const out = [];
  for (const [key, p] of Object.entries(door.places || {})) {
    if (p.hidden || p.col == null || !present.has(key)) continue;
    out.push({ key, page: p.page | 0, col: p.col, row: p.row, w: p.w || 1, h: p.h || 1 });
  }
  for (const n of door.notes || []) if (n.col != null) out.push({ key: n.id, page: n.page | 0, col: n.col, row: n.row, ...G.dims(n.size) });
  return out;
}
const defaultShape = (key, door) => key === 'clock' ? '2x1' : key === 'weather' ? '2x2' : key === 'whiteboard' ? '2x2' : key.startsWith('app:') ? (door.widgets?.builtin?.[key.slice(4)] || (door.widgets?.content?.[key.slice(4)] ? '2x2' : '1x1')) : '1x1';

function Door({ c, brain, now, onAsk, idle, embedded = false }) {
  const { setDoor, house, weather, apps, board } = brain;
  // A move made here is drawn at once and held until the brain's door has it (its version), so a late or stale answer
  // can't pull it back; if the brain then has it somewhere else, the brain wins.
  const [pending, setPending] = useState([]); // [{items: [{key, page, col, row, w, h}], v}]
  const live = pending.filter((p) => !(brain.door && brain.door.v >= p.v));
  useEffect(() => { if (live.length !== pending.length) setPending(live); }, [brain.door?.v]);
  const door = useMemo(() => {
    const d = brain.door; if (!d || !live.length) return d;
    const at = new Map(live.flatMap((p) => p.items.map((m) => [m.key, m])));
    return { ...d, notes: d.notes.map((n) => { const m = at.get(n.id); return m ? { ...n, page: m.page, col: m.col, row: m.row, size: `${m.w}x${m.h}` } : n; }),
      places: { ...d.places, ...Object.fromEntries([...at].filter(([k]) => !d.notes.some((n) => n.id === k)).map(([k, m]) => [k, { ...d.places[k], page: m.page, col: m.col, row: m.row, w: m.w, h: m.h }])) } };
  }, [brain.door, pending]);
  const [pg, setPg] = useState(0);
  const [drag, setDrag] = useState(null); // {key, x, y, page, over}: where the dragged thing is (its top-left in the grid, px)
  const [settle, setSettle] = useState(null); // {key, dx, dy}: just dropped, drawn where the finger let go for a frame, then easing into its cell
  const [pinch, setPinch] = useState(null); // {key, wpx, hpx, w, h}: its size under the fingers (px), and the shape it'll snap to
  const [open, setOpen] = useState(null); // a note's id, full screen
  const [old, setOld] = useState(null); // an app from before apps were web pages, tapped
  // A tap opens a full-screen card on its lift; the click that follows the same tap must not close it again.
  const openedAt = useRef(0);
  useEffect(() => { if (open || old) openedAt.current = Date.now(); }, [open, old]);
  const closing = (f) => () => { if (Date.now() - openedAt.current > 400) f(); };
  const [trashed, setTrashed] = useState(null); // {key, at, timer}: the last thing taken off (the arrow puts it back)
  const area = useRef(null);
  const [size, setSize] = useState({ w: innerWidth, h: innerHeight - 60 });
  useEffect(() => { if (!area.current) return; const ro = new ResizeObserver(() => { const r = area.current.getBoundingClientRect(); setSize({ w: r.width, h: r.height }); }); ro.observe(area.current); return () => ro.disconnect(); }, [idle]);
  // Like the display's door: the grid fills the space inside its margins (the right one wider: the gear lives there).
  const u = innerWidth / 1536;
  const cw = Math.max(10, (size.w - 124 * u) / G.COLS), ch = Math.max(10, (size.h - 24 * u) / G.ROWS);
  const timers = door?.timers || [];
  const android = useMemo(() => { try { return shell?.androidApps ? JSON.parse(shell.androidApps() || '[]') : []; } catch { return []; } }, [apps]);
  const want = useMemo(() => wanted(door, apps, android), [door, apps, android]);
  const present = useMemo(() => new Set(want), [want]);
  const items = useMemo(() => itemsOf(door, present), [door, present]);
  // While something's dragged there's one more page (empty) to drag it onto.
  const pages = Math.max(1, G.pages(items)) + (drag ? 1 : 0), page = Math.min(pg, pages - 1);
  const notes = new Map((door?.notes || []).map((n) => [n.id, n]));
  const appBy = new Map(apps.map((a) => [a.id, a])), androidBy = new Map(android.map((a) => [a.id, a]));
  const builtin = door?.widgets?.builtin || {}, own = door?.widgets?.content || {};

  // The display places anything new (an app just made, a timer) in the first free spot, and tells the bridge what's on
  // the door, so the assistant knows which cells are free. Other screens only draw.
  const placed = useRef('');
  useEffect(() => {
    if (!shell || !door || !brain.appsLoaded) return;
    // Two things on the same cells (one came back to the door after the other took its place): notes stay, the
    // other moves to the nearest free spot.
    const all = [], moved = [];
    const order = itemsOf(door, present).sort((a, b) => (notes.has(b.key) - notes.has(a.key)));
    for (const it of order) {
      if (G.fits(all, it)) { all.push(it); continue; }
      const at = G.nearest(all, it.w, it.h, it);
      const m = { ...it, page: at.page, col: at.col, row: at.row }; all.push(m); moved.push(m);
    }
    for (const key of want) {
      const p = door.places?.[key];
      if (p && (p.hidden || p.col != null)) continue;
      const { w, h } = G.dims(defaultShape(key, door));
      const corner = { page: 0, col: G.COLS - 2, row: G.ROWS - 1, w: 1, h: 1 };
      const at = key.startsWith('timer:') && G.fits(all, corner) ? corner : G.firstFree(all, w, h);
      const it = { key, page: at.page, col: at.col, row: at.row, w, h }; all.push(it); moved.push(it);
    }
    const same = JSON.stringify(want) === JSON.stringify(door.present || null);
    if (!moved.length && same) return;
    const sig = JSON.stringify([moved, want]);
    if (sig === placed.current) return;
    placed.current = sig;
    c.json('POST', '/door/arrange', { items: moved, present: want }).catch(() => {});
  }, [door, want, brain.appsLoaded]);

  /** Move or resize [key] to [target]; what's in the way makes room. The brain keeps it, and every screen sees it. */
  function place(key, target) {
    const others = items.filter((i) => i.key !== key);
    const next = G.makeRoom(others, key, G.clamp(target));
    const was = new Map(items.map((i) => [i.key, i]));
    const moved = next.filter((i) => { const o = was.get(i.key); return !o || o.page !== i.page || o.col !== i.col || o.row !== i.row || o.w !== i.w || o.h !== i.h; });
    if (!moved.length) return null;
    const mine = { items: moved.map(({ key, page, col, row, w, h }) => ({ key, page, col, row, w, h })), v: Infinity };
    setPending((p) => [...p, mine]); // drawn now, and held until the brain's door has it
    c.json('POST', '/door/arrange', { items: mine.items })
      .then((r) => { mine.v = r.json?.v || 0; setPending((p) => [...p]); })
      .catch(() => { mine.v = 0; setPending((p) => [...p]); }); // not taken: the brain's door stands
    return next.find((i) => i.key === key);
  }
  /** Off the door: a note to the trash, a timer stopped, anything else hidden. The arrow by the trash puts it back
   *  (and Settings, Removed, or the assistant). */
  function trash(key) {
    const timer = key.startsWith('timer:') ? timers.find((t) => 'timer:' + t.endAt === key) : null;
    if (notes.has(key)) { setDoor((d) => ({ ...d, notes: d.notes.filter((n) => n.id !== key) })); c.json('POST', '/door/remove', { id: key }).catch(() => {}); }
    else if (timer) c.json('POST', '/door/timer', { cancel: timer.endAt }).catch(() => {});
    else { setDoor((d) => ({ ...d, places: { ...d.places, [key]: { ...d.places[key], hidden: true } } })); c.json('POST', '/door/place', { key, hidden: true }).catch(() => {}); }
    setTrashed({ key, at: Date.now(), timer });
  }
  function putBack() {
    const t = trashed; if (!t) return;
    setTrashed(null);
    if (t.timer) { if (t.timer.endAt > Date.now()) c.json('POST', '/door/timer', { start: { label: t.timer.label, total: t.timer.total, endAt: t.timer.endAt } }).catch(() => {}); return; }
    if (!notes.has(t.key)) setDoor((d) => (d.places[t.key] ? { ...d, places: { ...d.places, [t.key]: { ...d.places[t.key], hidden: false } } } : d));
    c.json('POST', '/door/putback', { key: t.key }).catch(() => {});
  }
  useEffect(() => { if (!trashed) return; const k = setTimeout(() => setTrashed(null), 10e3); return () => clearTimeout(k); }, [trashed]);
  const liveApp = (id) => !!shell?.ui && !!appBy.get(id)?.widget; // the app brings its own live widget (widget.html): shown on the display itself
  const resizable = (key) => notes.has(key) || key === 'whiteboard' || (key.startsWith('app:') && liveApp(key.slice(4))) || (key.startsWith('app:') && (builtin[key.slice(4)] || own[key.slice(4)]));
  /** The shape nearest to [w] x [h] cells (a note or a widget; never bigger than the door). */
  const nearestShape = (w, h) => G.SHAPES.map(G.dims).reduce((b, s) => ((s.w - w) ** 2 + (s.h - h) ** 2 < (b.w - w) ** 2 + (b.h - h) ** 2 ? s : b));

  // Touch: drag to move (onto the trash to take it off), pinch with two fingers to resize (it snaps to the nearest
  // shape as they spread), a tap opens. A swipe on empty door turns the page.
  const trashRef = useRef(null);
  const overTrash = (x, y) => { const r = trashRef.current?.getBoundingClientRect(); return !!r && x >= r.left - 20 && x <= r.right + 20 && y >= r.top - 20 && y <= r.bottom + 20; };
  const fingers = useRef(new Map()); // pointer id -> {x, y} on the item being touched
  const gesture = useRef(null); // {key, it, mode: 'tap' | 'drag' | 'pinch', start, d0}
  function down(e, it) {
    unlock(); e.stopPropagation();
    if (e.target.closest?.('.tile button, .tile a, .tile input, .tile iframe, .wtile button, .wb-pad')) return; // a widget's or note's own button, or the whiteboard's drawing
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    if (e.isPrimary) { fingers.current.clear(); gesture.current = null; } // a new touch: nothing left over (a lift the door never saw, as an app opened)
    fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (secondFinger(e)) return;
    if (fingers.current.size > 1) return;
    const grid = gridRef.current.getBoundingClientRect();
    gesture.current = { key: it.key, it, mode: 'tap', start: { x: e.clientX, y: e.clientY }, grab: { x: e.clientX - grid.left - it.col * cw, y: e.clientY - grid.top - it.row * ch } };
  }
  /** A second finger (anywhere on the door) while one is on something resizable: a pinch. Its edges follow the fingers. */
  function secondFinger(e) {
    const g = gesture.current;
    if (e.isPrimary || !g || g.mode === 'pinch' || !resizable(g.key)) return false; // a first finger is never the second
    if (!fingers.current.has(e.pointerId)) { if (fingers.current.size !== 1) return false; }
    else if (fingers.current.size !== 2) return false;
    fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, b] = [...fingers.current.values()];
    gesture.current = { ...g, mode: 'pinch', dx0: Math.abs(a.x - b.x), dy0: Math.abs(a.y - b.y) };
    clearTimeout(edge.current?.timer); edge.current = null;
    setDrag(null); setPinch({ key: g.key, wpx: g.it.w * cw, hpx: g.it.h * ch, w: g.it.w, h: g.it.h });
    return true;
  }
  const gridRef = useRef(null);
  const edge = useRef(null); // {side, timer}: held at an edge while dragging, the page turns
  function atEdge(x) {
    const r = area.current.getBoundingClientRect(), side = x < r.left + 60 * u ? -1 : x > r.right - 60 * u ? 1 : 0;
    if (edge.current?.side === side) return;
    clearTimeout(edge.current?.timer); edge.current = null;
    if (side) edge.current = { side, timer: setTimeout(function turn() {
      setPg((p) => Math.max(0, Math.min(Math.max(1, G.pages(items)), p + side)));
      edge.current.timer = setTimeout(turn, 900); // still held: the next one
    }, 600) };
  }
  function move(e) {
    const g = gesture.current; if (!g || !fingers.current.has(e.pointerId)) return;
    fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.mode === 'pinch') {
      const [a, b] = [...fingers.current.values()]; if (!b) return;
      // The edges follow the fingers: it grows (or shrinks) by as much as they spread, each way; the shape it'll take is the nearest one.
      const wpx = Math.min(Math.max(g.it.w * cw + Math.abs(a.x - b.x) - g.dx0, cw * 0.7), (G.COLS - g.it.col) * cw);
      const hpx = Math.min(Math.max(g.it.h * ch + Math.abs(a.y - b.y) - g.dy0, ch * 0.7), (G.ROWS - g.it.row) * ch);
      setPinch({ key: g.key, wpx, hpx, ...nearestShape(wpx / cw, hpx / ch) });
      return;
    }
    const dx = e.clientX - g.start.x, dy = e.clientY - g.start.y;
    if (g.mode === 'tap' && Math.hypot(dx, dy) > 12) g.mode = 'drag';
    if (g.mode !== 'drag') return;
    const grid = gridRef.current.getBoundingClientRect();
    setDrag({ key: g.key, x: e.clientX - grid.left - g.grab.x, y: e.clientY - grid.top - g.grab.y, over: overTrash(e.clientX, e.clientY) });
    atEdge(e.clientX);
  }
  function up(e) {
    const g = gesture.current; if (!fingers.current.has(e.pointerId)) return;
    fingers.current.delete(e.pointerId);
    if (!g) return;
    const it = g.it;
    if (g.mode === 'pinch') {
      if (fingers.current.size) return; // until the last finger lifts
      gesture.current = null;
      const p = pinchRef.current; setPinch(null); // it eases from the fingers' size into its cells
      if (p && (p.w !== it.w || p.h !== it.h)) place(g.key, { page: it.page, col: it.col, row: it.row, w: p.w, h: p.h });
      return;
    }
    gesture.current = null; clearTimeout(edge.current?.timer); edge.current = null;
    const d = dragRef.current; setDrag(null);
    if (e.type === 'pointercancel') return;
    if (g.mode === 'drag' && overTrash(e.clientX, e.clientY)) trash(g.key);
    else if (g.mode === 'drag' && d) {
      // Into the nearest cell on the page it's over now; it eases there from where the finger let go.
      const at = place(g.key, { page, col: Math.round(d.x / cw), row: Math.round(d.y / ch), w: it.w, h: it.h });
      const to = at || it;
      setSettle({ key: g.key, dx: d.x - to.col * cw, dy: d.y - to.row * ch });
    } else tap(it, e);
  }
  function tap(it, ev) {
    if (ev?.target?.closest?.('button')) return; // a widget's own button (a tick)
    if (notes.has(it.key)) { setOpen(it.key); c.json('POST', '/door/touch', { id: it.key }).catch(() => {}); }
    else if (it.key.startsWith('timer:')) { const t = timers.find((x) => 'timer:' + x.endAt === it.key); if (t && t.endAt <= Date.now()) c.json('POST', '/door/timer', { cancel: t.endAt }); }
    else if (it.key === 'weather') shell?.weather();
    else if (it.key.startsWith('app:')) {
      const a = appBy.get(it.key.slice(4));
      if (a && a.web === false) setOld(a); // from before apps were web pages: it can't open until it's remade
      else shell?.openApp(it.key.slice(4));
    }
  }
  function swipe(e) {
    unlock();
    if (gesture.current) return; // a second finger of a pinch, not a page turn
    const x0 = e.clientX;
    const up = (ev) => { removeEventListener('pointerup', up); const dx = ev.clientX - x0; if (Math.abs(dx) > 80) setPg(Math.max(0, Math.min(pages - 1, page + (dx < 0 ? 1 : -1)))); };
    addEventListener('pointerup', up);
  }
  function remake(a) {
    setOld(null);
    const text = `Remake the ${a.meta?.name || a.id} app (apps/${a.id}) as a web app, the same as it was.`;
    if (shell?.ask) shell.ask(text); else { answerPage.ask(text); onAsk(text); }
  }

  function draw(it, w, h) {
    if (notes.has(it.key)) return <Note n={{ ...notes.get(it.key), size: `${w}x${h}` }} house={house} />;
    if (it.key === 'clock') return door?.style?.clock === 'compact' ? <CompactClock now={now} /> : <Clock now={now} w={w} />;
    if (it.key === 'weather') return <Weather weather={weather} w={w} h={h} family={door?.style?.weather === 'family'} />;
    if (it.key === 'whiteboard') return <Whiteboard c={c} v={door?.sketch} />;
    if (it.key.startsWith('timer:')) { const t = timers.find((x) => 'timer:' + x.endAt === it.key); return t ? <Timer t={t} now={now} /> : null; }
    if (it.key.startsWith('app:android:')) return <AppIcon id={it.key.slice(4)} name={androidBy.get(it.key.slice(4))?.name} img={androidBy.get(it.key.slice(4))?.icon} />;
    if (it.key.startsWith('app:')) {
      const id = it.key.slice(4), wid = own[id], app = appBy.get(id);
      if (w * h > 1 && liveApp(id)) return <LiveWidget c={c} app={app} w={w} h={h} />;
      if (w * h > 1 && (builtin[id] || wid)) return <Widget id={id} app={app} w={w} h={h} house={house} c={c} now={now} Photo={(p) => <PhotoShow c={c} {...p} />} content={wid ? (wid.shapes?.[`${w}x${h}`] || wid.content || '') : null} />;
      return <AppIcon app={app} id={id} old={app?.web === false} />;
    }
    return null;
  }

  // Moves and lifts are followed on the whole page: a pinch's second finger can be anywhere.
  const dragRef = useRef(null), pinchRef = useRef(null), handlers = useRef({});
  dragRef.current = drag; pinchRef.current = pinch; handlers.current = { move, up };
  useEffect(() => {
    const mv = (e) => handlers.current.move(e), lift = (e) => handlers.current.up(e);
    addEventListener('pointermove', mv); addEventListener('pointerup', lift); addEventListener('pointercancel', lift);
    return () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', lift); removeEventListener('pointercancel', lift); };
  }, []);
  useLayoutEffect(() => {
    if (!settle) return;
    let b = 0; const a = requestAnimationFrame(() => { b = requestAnimationFrame(() => setSettle(null)); }); // painted once where it was let go, then eased home
    return () => { cancelAnimationFrame(a); cancelAnimationFrame(b); };
  }, [settle]);
  if (idle) return <Ambient c={c} house={house} apps={apps} board={board} timers={timers} weather={brain.weather} now={now} />;
  // The dragged thing stays drawn on whichever page is showing.
  const shown = items.filter((i) => i.page === page || i.key === drag?.key);
  const note = open && notes.get(open);
  return (
    <div className={'screen' + (door?.style?.scenery?.length ? ' scenic' : '')} style={door?.style?.door ? { '--door': door.style.door } : undefined}>
      {door?.style?.scenery?.length > 0 && <Scenery urls={door.style.scenery} now={now} />}
      <div className="door" ref={area} onPointerDown={swipe} onPointerDownCapture={(e) => { if (secondFinger(e)) e.stopPropagation(); }}>
        <div className="grid" ref={gridRef} style={{ width: cw * G.COLS, height: ch * G.ROWS, left: 40 * u, top: 24 * u }}>
          {shown.map((it) => {
            const ps = pinch?.key === it.key ? pinch : null, w = ps ? ps.w : it.w, h = ps ? ps.h : it.h;
            return (
              <div key={it.key} className={'item' + (drag?.key === it.key ? ' dragging' + (drag.over ? ' over-trash' : '') : '') + (ps ? ' pinching' : '') + (settle?.key === it.key ? ' settling' : '')}
                onPointerDown={(e) => down(e, it)}
                style={{ left: drag?.key === it.key ? drag.x : it.col * cw, top: drag?.key === it.key ? drag.y : it.row * ch,
                  width: ps ? ps.wpx : (drag?.key === it.key ? w : Math.min(w, G.COLS - it.col)) * cw, height: ps ? ps.hpx : (drag?.key === it.key ? h : Math.min(h, G.ROWS - it.row)) * ch,
                  transform: settle?.key === it.key ? `translate(${settle.dx}px, ${settle.dy}px)` : undefined }}>
                {draw(it, w, h)}
              </div>
            );
          })}
          {pinch && (() => { const it = items.find((i) => i.key === pinch.key); return it && <div className="pinch-target" style={{ left: it.col * cw, top: it.row * ch, width: pinch.w * cw, height: pinch.h * ch }} />; })()}
          {!shell && <button className="corner" onPointerDown={(e) => e.stopPropagation()} onClick={() => { unlock(); onAsk(); }}
            style={{ left: (G.COLS - 1) * cw, top: (G.ROWS - 1) * ch, width: cw, height: ch }}><span className="ask-glyph"><Pencil /></span></button>}
        </div>
        {shell && !embedded && <button className="gear" onPointerDown={(e) => e.stopPropagation()} onClick={() => shell.settings()} aria-label="Settings"><Gear /></button>}
      </div>
      <div className="dots-row">
        {drag ? <div ref={trashRef} className={'trash' + (drag.over ? ' over' : '')}><Bin /></div>
          : <>{pages > 1 && [...Array(pages)].map((_, i) => <button key={i} className={'pg' + (i === page ? ' on' : '')} onClick={() => setPg(i)} />)}
            {trashed && <button className="putback" onClick={putBack} aria-label="Put it back"><PutBack /></button>}</>}
      </div>
      {note && <div className="full" onClick={closing(() => setOpen(null))}><div className={'full-in paper ' + (note.paper || 'card')} onClick={(e) => e.stopPropagation()}><h2 className="hand">{note.title}</h2><AnswerBody text={note.content} /></div></div>}
      {old && <div className="full" onClick={closing(() => setOld(null))}><div className="full-in paper card old-app" onClick={(e) => e.stopPropagation()}>
        <h2 className="hand">{old.meta?.name || old.id}</h2>
        <p>This was made before apps were web pages, so it needs remaking before it can open.</p>
        <div className="old-actions"><button className="go" onClick={() => remake(old)}>Ask to remake it</button><button className="later" onClick={() => setOld(null)}>Not now</button></div>
      </div></div>}
    </div>
  );
}

/** The family's pictures behind the door (their home style: scenery), one every 5 minutes, crossfading. */
function Scenery({ urls, now }) {
  const i = Math.floor(now / 300e3) % urls.length;
  const [shown, setShown] = useState([urls[i]]);
  useEffect(() => { const img = new Image(); img.onload = () => setShown((s) => [s[s.length - 1], urls[i]].filter((u, k, a) => a.indexOf(u) === k).slice(-2)); img.src = urls[i]; }, [urls[i]]);
  return <div className="scenery">{shown.map((u, k) => <img key={u} src={u} alt="" className={k === shown.length - 1 ? 'on' : ''} draggable={false} />)}</div>;
}

/** When nobody has touched the display for a while: the family's photos (if an app asks for them, not at night), the time, the day's headline and timers. */
function Ambient({ c, house, apps, board, timers, weather, now }) {
  const wantsPhotos = apps.some((a) => a.meta?.screensaver);
  const night = isNight(house?.night, now) || !!shell?.sleeping?.(); // night hours (or "Sleep now") hold with or without the Photos app
  // At night the backlight goes right down too (the shell), and comes back when someone touches it.
  useEffect(() => { shell?.dim?.(night); return () => shell?.dim?.(false); }, [night]);
  const names = wantsPhotos && !night ? house?.screensaver || house?.photos || [] : []; // the album chosen in Photos, else all
  const shown = names.length ? names[Math.floor(now / 12e3) % names.length] : null;
  const src = usePhoto(c, shown), caption = shown && house?.captions?.[shown];
  const d = new Date(now);
  // The rest of today (once today is done, tomorrow's): its all-day things on one line, then the next few events, the
  // same size, each with its time; and the things on Today (a reminder, a suggestion, a countdown). Readable from across the room.
  const evs = house?.events || [], dayOf = (t) => new Date(t).toDateString(), isPerson = (n) => (house?.family || []).some((p) => p.name === n);
  const timed = evs.filter((e) => !e.allDay && Date.parse(e.start) > now).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const tomorrow = new Date(d); tomorrow.setDate(d.getDate() + 1);
  const showDay = timed.some((e) => dayOf(e.start) === d.toDateString()) ? d.toDateString() : tomorrow.toDateString();
  const coming = timed.filter((e) => dayOf(e.start) === showDay).slice(0, 4);
  const midday = (x) => { const t = new Date(x); t.setHours(12, 0, 0, 0); return +t; };
  const allDay = evs.filter((e) => e.allDay && Date.parse(e.start) <= midday(showDay) && (e.end ? Date.parse(e.end) : Date.parse(e.start) + 864e5) > midday(showDay)).map((e) => e.title).slice(0, 2);
  const tmr = showDay !== d.toDateString();
  const nextWhen = (e) => { const s = new Date(e.start); return `${hm(s)}${s.getHours() < 12 ? ' AM' : ' PM'}${isPerson(e.who) ? ' · ' + e.who : ''}`; };
  const next = coming[0];
  // The weather under the date: now, and the rest of today, or tomorrow's from the evening on (by the clock, not the events:
  // a morning with nothing left on the calendar still wants today's).
  const eve = d.getHours() >= 18;
  // Notes apps put under a day on the calendar ("Lunch: Popcorn Chicken"): today's, or tomorrow's from the evening, as the weather.
  const noteDay = (() => { const x = new Date(d); if (eve) x.setDate(x.getDate() + 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; })();
  const dayNotes = (house?.dayNotes?.[noteDay] || []).filter((n) => n && (n.short || n.text)).slice(0, 3);
  const w = weather && !weather.error && Number.isFinite(weather.temp) ? weather : null, wd = w?.days?.[eve ? 1 : 0];
  const lc = (x) => String(x || '').toLowerCase();
  const sky = w && [`${w.temp}° ${lc(w.condition)}`.trim(),
    wd && (eve ? `tomorrow ${lc(wd.condition)}, ${wd.high}°/${wd.low}°` : Number.isFinite(wd.high) && `high ${wd.high}°`),
    wd?.rain >= 30 && `rain ${wd.rain}%`].filter(Boolean).join(' · ');
  const counting = (house?.things || []).filter((x) => !x.sleepOff && !(x.start && coming.some((e) => x.title === e.title && Date.parse(x.start) === Date.parse(e.start)))); // (not an event shown already)
  return (
    <div className={'ambient' + (night ? ' night' : '')} onPointerDown={() => shell?.touch()}>
      {src && <img src={src} alt="" />}
      {src && caption && <div className="ambient-caption">{caption}</div>}
      <div className="ambient-time"><div className="t">{hm(d)}</div><div className="d">{d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>{sky && <div className="w">{sky}</div>}</div>
      {(next || allDay.length > 0 || dayNotes.length > 0 || counting.length > 0 || board?.headline || timers.length > 0) && <div className="ambient-side">
        {(coming.length > 0 || allDay.length > 0) && tmr && <div className="ambient-day">Tomorrow</div>}
        {allDay.length > 0 && <div className="ambient-allday">{allDay.join(' · ')}</div>}
        {coming.map((e) => <div key={e.id || e.uid || e.start + e.title} className="ambient-ev">{eventPaint(house, e) && <i className="ambient-dot" style={{ background: eventPaint(house, e) }} />}<span>{nextWhen(e).split(' · ')[0]}</span> {e.title}</div>)}
        {dayNotes.map((n, i) => <div key={'n' + i} className="ambient-note"><span>{n.label}</span> {n.short || n.text}</div>)}
        {counting.map((x) => <div key={x.id}>{x.text}</div>)}
        {!next && board?.headline && <div>{board.headline}</div>}
        {timers.map((t) => <div key={t.endAt}>{t.label} · {t.endAt <= now ? '0:00' : fmt(Math.ceil((t.endAt - now) / 1000))}</div>)}
      </div>}
    </div>
  );
}
function isNight(n, now) {
  if (!n?.from || !n?.to) return false;
  const d = new Date(now), m = d.getHours() * 60 + d.getMinutes(), min = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const f = min(n.from), t = min(n.to);
  return f <= t ? m >= f && m < t : m >= f || m < t;
}

const Gear = () => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>;
const Bin = () => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3" /></svg>;
const PutBack = () => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9.5a7 7 0 1 1 1.6 7.6" /><path d="M6 4v5.5h5.5" /></svg>;
const Pencil = () => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></svg>;

// ---- asking (other screens: the display has the shell's own typing and listening) -------------------------
function Ask({ c, onClose, first = '' }) {
  const [text, setText] = useState(first), [turn, setTurn] = useState(null); // {q, a, status, live}
  const ctl = useRef(null), convo = useRef(null);
  async function ask(e) {
    e?.preventDefault();
    const q = text.trim(); if (!q || turn?.live) return;
    setText(''); setTurn({ q, a: '', status: '', live: true });
    ctl.current = new AbortController();
    let said = '';
    try {
      await c.lines('POST', '/chat', { id: convo.current, text: q }, (ev) => {
        if (ev.type === 'start') convo.current = ev.id;
        else if (ev.type === 'status') setTurn((t) => ({ ...t, status: ev.text }));
        else if (ev.type === 'delta') { said += ev.text; setTurn((t) => ({ ...t, a: said })); }
        else if (ev.type === 'reset') { said = ''; setTurn((t) => ({ ...t, a: '' })); }
        else if (ev.type === 'done') setTurn((t) => ({ ...t, a: ev.text || said, live: false, ok: ev.ok }));
      }, { signal: ctl.current.signal });
    } catch { setTurn((t) => ({ ...t, live: false })); }
  }
  answerPage.ask = (q) => { setText(q); };
  return (
    <div className="scrim" onClick={onClose}>
      <div className="ask-panel" onClick={(e) => e.stopPropagation()}>
        {turn && <div className="turn"><div className="you">{turn.q}</div>
          <div className="answer">{turn.a ? <AnswerBody text={turn.a} done={!turn.live} /> : <div className="status"><span className="dots"><i /><i /><i /></span>{turn.status}</div>}</div></div>}
        <form className="ask" onSubmit={ask}>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} />
          {turn?.live
            ? <button type="button" className="send" onClick={() => { ctl.current?.abort(); c.json('POST', '/chat/stop', { id: convo.current }).catch(() => {}); }}>Stop</button>
            : <button className="send" disabled={!text.trim()}>Ask</button>}
        </form>
      </div>
    </div>
  );
}

// ---- the home screen: tabs (home.jsx). The board above (Door) is no longer shown; its notes are on Today. ---------
function Home(props) {
  const { c, brain, now } = props;
  return <HomeTabs {...props} shell={shell}
    ambient={<Ambient c={c} house={brain.house} apps={brain.apps} board={brain.board} timers={brain.door?.timers || []} weather={brain.weather} now={now} />}
    usePhoto={usePhoto} PhotoShow={PhotoShow} Gear={Gear} />;
}

/** Reminders due now ("Swim in 15 minutes") on a screen that isn't the display (there the shell shows them, over
 *  any app). Put away on one screen, they go on all of them. */
function Reminders({ c, house, now }) {
  const [away, setAway] = useState(() => new Set());
  const due = (house?.reminders || []).filter((r) => !away.has(r.key)).slice(0, 3);
  if (!due.length) return null;
  const words = (r) => { const m = Math.ceil((Date.parse(r.start) - now) / 60e3); return `${r.title} ${m <= 0 ? 'now' : m === 1 ? 'in a minute' : m < 60 ? `in ${m} minutes` : 'at ' + new Date(r.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`; };
  return <div className="reminders">{due.map((r) => (
    <div key={r.key} className="reminder">
      <span className="dot" style={{ background: personColor(house, String(r.who || '').split(' & ')[0]) || '#5e6466' }} />
      <div className="what"><div>{words(r)}</div>{(r.who || r.place) && <div className="soft">{[r.who, r.place].filter(Boolean).join(' · ')}</div>}</div>
      <button onClick={() => { setAway(new Set([...away, r.key])); c.json('POST', '/house/remind', { done: r.key }).catch(() => {}); }}>Got it</button>
    </div>))}</div>;
}

// ---- the page -----------------------------------------------------------------------------------------
function App() {
  const [me, setMe] = useState(() => (shell ? { display: true } : load())), [removed, setRemoved] = useState(false), [asking, setAsking] = useState(false);
  const c = useMemo(() => (shell ? displayClient() : me && client({ id: me.id, key: me.key, relay: me.relay || null, onRelay: (r) => keep({ ...(load() || me), relay: r || undefined }) })), [me]);
  const [now, setNow] = useState(Date.now());
  const [idle, setIdle] = useState(false);
  useEffect(() => { const t = setInterval(() => { setNow(Date.now()); if (shell?.idle) setIdle(!!shell.idle()); }, 1000); return () => clearInterval(t); }, []);
  if (!c) return <Pairing removed={removed} onJoined={(w) => { setRemoved(false); setMe(w); }} />;
  const gone = () => { keep(null); setMe(null); setRemoved(true); };
  if ((TV || me?.kind === 'tv') && !shell) return <TvFrame c={c} onRemoved={gone} />;
  return <Joined c={c} scopes={me?.scopes} now={now} idle={idle} asking={asking} setAsking={setAsking} onRemoved={gone} />;
}

/**
 * A TV shows an app made for it (app.json "screens": ["tv"]; ours is openhouse-tv, defaults/apps/tv), not this page's
 * own layout, so the household can change it like any app. It runs in a sandboxed frame, so it never sees this
 * screen's key; the kit in it asks this page for what it reads (GET only), and this page asks the tablet, sealed and
 * marked with the app, so the tablet answers only what that app may see.
 */
function TvFrame({ c, onRemoved }) {
  const [apps, setApps] = useState(null), [up, setUp] = useState(true);
  const frame = useRef(null);
  const app = apps?.[0] || null;
  useEffect(() => { document.documentElement.classList.add('tv'); return () => document.documentElement.classList.remove('tv'); }, []);
  useEffect(() => { // which app, and whether it changed (asked again every minute)
    let stop = false;
    (async () => {
      while (!stop) {
        try {
          const r = await c.json('GET', '/screens/apps');
          if (r.status === 200 && Array.isArray(r.json)) { setApps((a) => (JSON.stringify(a) === JSON.stringify(r.json) ? a : r.json)); setUp(true); }
        } catch (e) { if (e instanceof Removed) { stop = true; return onRemoved(); } setUp(false); }
        await new Promise((r) => setTimeout(r, 60e3));
      }
    })();
    return () => { stop = true; };
  }, [c]);
  useEffect(() => {
    if (!app) return;
    const on = async (e) => {
      const w = frame.current?.contentWindow, m = e.data;
      if (!w || e.source !== w || !m || m.oh !== 'call' || typeof m.p !== 'string') return;
      const reply = (x, t = []) => w.postMessage({ oh: 'reply', id: m.id, ...x }, '*', t);
      if (m.m !== 'GET' || !m.p.startsWith('/')) return reply({ status: 405 }); // a TV only shows
      try {
        const r = await c.request('GET', m.p, undefined, { app: app.id });
        const body = r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.byteLength);
        reply({ status: r.status, type: r.type, body }, [body]); setUp(true);
      } catch (err) { if (err instanceof Removed) onRemoved(); else { setUp(false); reply({ status: 503 }); } }
    };
    // The remote's keys go to the app (they reach this page when the frame doesn't have the focus).
    const key = (e) => { const w = frame.current?.contentWindow; if (!w) return; e.preventDefault(); w.postMessage({ oh: 'key', key: e.key }, '*'); frame.current.focus(); };
    addEventListener('message', on); addEventListener('keydown', key);
    return () => { removeEventListener('message', on); removeEventListener('keydown', key); };
  }, [c, app?.id]);
  if (!apps) return <div className="pairing"><div className="dots"><i /><i /><i /></div>{!up && <div className="offline" />}</div>;
  if (!app) return (
    <div className="tv-pair">
      <div className="brand">OpenHouse</div>
      <h1>Nothing to show on the TV.</h1>
      <p>Ask Opie on the tablet to make a layout for the TV, or to put ours back.</p>
    </div>
  );
  return (
    <>
      <iframe key={app.id + ':' + app.v} ref={frame} className="tv-app" title={app.name} sandbox="allow-scripts" src={`${app.at}index.html#screen=1&kind=tv`} onLoad={() => frame.current?.focus()} />
      {!up && <div className="offline" />}
    </>
  );
}

function Joined({ c, scopes, now, idle, asking, setAsking, onRemoved }) {
  const brain = useBrain(c, onRemoved);
  // A note's Timer button starts a timer for the whole house; on the display, its Video plays full screen.
  Display.startTimer = (label, seconds) => c.json('POST', '/door/timer', { start: { label, seconds } }).catch(() => {});
  if (shell) Display.openApp = (id) => shell.openApp(id);
  // A note's button that asks the assistant something ("Plan tacos for tonight"): on the display it's asked at once,
  // as if typed; on another screen the asking panel opens with it.
  answerPage.ask = (q) => { if (shell?.ask) shell.ask(q); else setAsking(q); };
  return (
    <>
      {brain.door ? <Home c={c} brain={brain} now={now} idle={idle} onAsk={(text) => setAsking(typeof text === 'string' ? text : true)} /> : <div className="pairing"><div className="dots"><i /><i /><i /></div></div>}
      {!brain.up && <div className="offline" />}
      {!shell && <Reminders c={c} house={brain.house} now={now} />}
      {asking && <Ask c={c} first={typeof asking === 'string' ? asking : ''} onClose={() => setAsking(false)} />}
      {!shell && !asking && <Talk c={c} scopes={scopes} />}
    </>
  );
}

if (shell) document.documentElement.classList.add('display');
// u: one pixel of a 1536-wide screen, like the display's sizes.
const setU = () => document.documentElement.style.setProperty('--u', `${innerWidth / 1536}px`);
setU(); addEventListener('resize', setU);
addEventListener('hashchange', () => location.reload()); // a new code opened in this tab: start over with it
createRoot(document.getElementById('root')).render(<App />);

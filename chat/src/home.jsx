// The home screen: a column on the left with the time, the day and the tabs, and the chosen tab beside it, on a world
// of its own faint hue with white panels on it. A tab is Today (a glance at the day, with the notes the assistant put up), Apps (every app that isn't a
// tab of its own, and the Android apps added), or any of the family's apps, the real app running in the
// sheet, so an app the family or the assistant changed shows as they changed it. Today is the glance: the most
// important bit of each tab, each opening its tab.
//
// What's personal is data in apps/home/style.json (bridge/door.js, cleanLook): which tabs and in what order, the
// palette or the family's own colors, the type, the density and a photo backdrop. The assistant edits that file; the
// "Tabs and look" sheet here (hold a tab, or the sliders below the tabs) writes it through POST /door/look, so "undo"
// takes either back.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Widget } from './door-widgets.jsx';
import { AnswerBody } from './answer.jsx';
import { TAB_ICONS, TAB_ICON_BY_ID } from './tab-icons.js';
import { PALETTES, paletteOf, worldOf } from './look.js';
import { card as weatherCard, icon as weatherIcon } from '../../bridge/kit/weather-look.js';

const DEFAULT_TABS = ['today', 'calendar', 'weather', 'map', 'chores', 'lists', 'meals', 'recipes', 'photos', 'whiteboard', 'apps'];
export { PALETTES };
const FACES = { clean: "'Inter', Roboto, system-ui, sans-serif", serif: "'Newsreader', Georgia, serif", round: "'Nunito', system-ui, sans-serif", hand: "'Caveat', cursive" };
const PEOPLE = ['#ffc247', '#56d6a0', '#ff8566', '#74acff', '#c3a0ff', '#ff9ec4'];
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
const clock = (s) => { const m = Math.floor(s / 60), x = s % 60; return `${m}:${pad(x)}`; };
const dayOf = (e) => (e.date ? new Date(e.date + 'T00:00') : (() => { const d = new Date(e.start); d.setHours(0, 0, 0, 0); return d; })());
const timeOf = (e) => (e.allDay ? null : new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(/\s?([AP])M$/i, (_, x) => x.toLowerCase()));
const personColor = (house, who) => { const i = (house?.family || []).findIndex((p) => p.name.toLowerCase() === String(who || '').toLowerCase()); return i < 0 ? null : house.family[i].color || PEOPLE[i % PEOPLE.length]; }; // their own, from /house
/** Everyone an event is for who is in the family (its person, then whoever else), and its color: theirs, or each one's in turn. */
const eventPeople = (house, e) => [e?.who, ...(e?.also || [])].filter((n) => n && personColor(house, n));
const eventPaint = (house, e) => { const cs = eventPeople(house, e).map((n) => personColor(house, n)); return cs.length > 1 ? `linear-gradient(135deg, ${cs.map((c, i) => `${c} ${i * 100 / cs.length}% ${(i + 1) * 100 / cs.length}%`).join(', ')})` : cs[0] || null; };
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

/** The look as CSS variables (the soft text, lines and tints come from its ink); tab: whose world is behind it. */
export function lookVars(st, tab) {
  const p = paletteOf(st);
  return { '--h-bg': worldOf(st, tab), '--h-sheet': p.sheet, '--h-ink': p.ink, '--h-accent': p.accent, '--h-face': FACES[st?.type] || FACES.clean };
}
/** A person's (or an event's people's) round mark: their initial on their color; nobody's is a soft one. */
const Av = ({ paint, name, className = '' }) => (paint
  ? <span className={'h-av ' + className} style={{ background: paint }}>{String(name || '').trim()[0]?.toUpperCase() || ''}</span>
  : <span className={'h-av none ' + className}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="9" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0M15.5 6.2a3.2 3.2 0 0 1 0 5.6M17.5 14.2a5.5 5.5 0 0 1 3 4.8" /></svg></span>);

export function Home({ c, brain, now, idle, onAsk, shell, ambient, usePhoto, PhotoShow, Gear }) {
  const { door, house, weather, apps, appsLoaded } = brain;
  const st = door?.style || {};
  const appBy = useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps]);
  const tabs = useMemo(() => (st.tabs || DEFAULT_TABS.map((id) => ({ id })))
    .map((t) => (t.id === 'board' ? { ...t, id: 'apps' } : t)) // the board this used to be (door.js cleanLook does it too)
    .filter((t) => t.id === 'today' || t.id === 'apps' || appBy.has(t.id) || !appsLoaded), [st.tabs, appBy, appsLoaded]);
  const nameOf = (t) => t.name || (t.id === 'today' ? 'Today' : t.id === 'apps' ? 'Apps' : appBy.get(t.id)?.meta?.name || t.id);
  // Its icon: the app's own pick ("tabIcon" in its app.json), else a starting tab's; none leaves the space, so names line up.
  const iconOf = (t) => TAB_ICONS[appBy.get(t.id)?.meta?.tabIcon] || TAB_ICONS[TAB_ICON_BY_ID[t.id]] || null;
  const [want, setWant] = useState(() => store.get('openhouse.tab') || 'today');
  const cur = tabs.some((t) => t.id === want) ? want : tabs[0]?.id;
  const [seen, setSeen] = useState(() => new Set());
  useEffect(() => { if (cur && !seen.has(cur)) setSeen(new Set([...seen, cur])); }, [cur]);
  // The display tells the bridge which tab is showing, so "make this bigger" is about it (door.js requestApp).
  useEffect(() => { if (shell && cur) c.json('POST', '/door/showing', { tab: cur }).catch(() => {}); }, [cur]);
  const go = (id) => { setWant(id); store.set('openhouse.tab', id); };
  // An app asking for another (the Calendar's "Open School lunch"): its tab, else full screen.
  const openApp = (id) => { if (tabs.some((t) => t.id === id)) go(id); else if (appBy.has(id)) shell?.openApp(id); };
  // A tab that wasn't there a moment ago (the assistant just added it): show it, so they see what they asked for.
  const known = useRef(null);
  useEffect(() => {
    const ids = tabs.map((t) => t.id);
    if (appsLoaded && known.current) { const added = ids.find((id) => !known.current.has(id)); if (added) go(added); }
    if (appsLoaded) known.current = new Set(ids);
  }, [tabs.map((t) => t.id).join(), appsLoaded]);
  // A paired computer checking one of the tabs' apps (workshop.js): show that tab, once per request.
  const showAt = door?.show?.at || 0;
  // (or Opie showing a place on the Map, or a recipe to cook: an app that isn't a tab opens full screen, door.js showApp)
  useEffect(() => { const t = door?.show?.tab; if (!t || Date.now() - showAt >= 60e3) return;
    if (tabs.some((x) => x.id === t)) go(t); else if (door.show.open && appBy.has(t)) shell?.openApp(t); }, [showAt]);
  // Back to the first tab when the screen has rested, as a glance is what it's for.
  useEffect(() => { if (idle && tabs[0]) go(tabs[0].id); }, [idle]);
  const [arranging, setArranging] = useState(false);
  const [timerOpen, setTimerOpen] = useState(null);
  // A minute more or less (or five more): the same timer, ending later or sooner (the shell's ringing follows /door/timer).
  const moveTimer = (t, secs) => {
    const endAt = Math.max(Date.now() + 5e3, t.endAt + secs * 1000), total = Math.max(5, (t.total || 0) + secs);
    setTimerOpen(endAt);
    c.json('POST', '/door/timer', { cancel: t.endAt }).then(() => c.json('POST', '/door/timer', { start: { label: t.label, total, endAt } })).catch(() => {});
  };
  const held = useRef(0);
  const hold = (id) => ({
    onPointerDown: () => { clearTimeout(held.current); held.current = setTimeout(() => { held.current = -1; setArranging(true); }, 650); },
    onPointerUp: () => { if (held.current !== -1) { clearTimeout(held.current); go(id); } held.current = 0; },
    onPointerLeave: () => { if (held.current !== -1) clearTimeout(held.current); },
    onPointerCancel: () => clearTimeout(held.current),
  });
  if (idle) return ambient;
  // Someone's AI (Claude, ChatGPT, a computer) is changing an app (workshop.js): its tab pulses gently, or Apps for
  // one that isn't a tab (a new app goes there first). No words: the family sees where, and it stops when it's done.
  const busy = door?.computer?.apps || [];
  const making = (id) => busy.includes(id) || (id === 'apps' && busy.some((a) => !tabs.some((t) => t.id === a)));
  const d = new Date(now);
  const timers = door?.timers || [];
  return (
    <div className={'home' + (st.density === 'snug' ? ' snug' : '') + (st.type === 'hand' ? ' hand-type' : '') + (st.backdrop === 'photos' ? ' over-photos' : '') + (st.palette === 'dusk' ? ' dark' : '')} data-tab={cur} style={lookVars(st, worldTab(tabs.find((t) => t.id === cur), appBy))}>
      {st.backdrop === 'photos' && <Backdrop c={c} names={house?.screensaver || house?.photos || []} now={now} usePhoto={usePhoto} />}
      <aside className="h-rail">
        <div className="h-time">{hm(d)}</div>
        <div className="h-day">{d.toLocaleDateString([], { weekday: 'long' })}</div>
        <div className="h-day h-date">{d.toLocaleDateString([], { day: 'numeric', month: 'long' })}</div>
        {weather && !weather.error && <div className="h-wx"><span className="h-wx-i" dangerouslySetInnerHTML={{ __html: weatherIcon(weather.code, weather.isDay !== false) }} />{weather.temp}° {String(weather.condition || '').toLowerCase()}</div>}
        {/* Tap a timer to change or clear it (a small sheet over the screen). */}
        {timers.map((t) => <button key={t.endAt} className="h-timer" onClick={() => setTimerOpen(t.endAt)}>{t.label} <b>{t.endAt <= now ? '0:00' : clock(Math.ceil((t.endAt - now) / 1000))}</b></button>)}
        <nav className="h-tabs">
          {tabs.map((t) => { const d = iconOf(t); return <button key={t.id} className={'h-tab' + (t.id === cur ? ' on' : '') + (making(t.id) ? ' making' : '')} {...hold(t.id)}><svg className="h-tab-i" viewBox="0 0 256 256" aria-hidden="true">{d && <path d={d} />}</svg>{nameOf(t)}</button>; })}
        </nav>
        <div className="h-tools">
          {/* On the display there's no assistant button (say "Hey Opie" or just type; the shell shows it only while it's
              busy, Overlay.kt). On another screen this page has its own, which opens the asking panel. */}
          {!shell && <button className="h-voice own" onClick={() => onAsk()} aria-label="Ask"><i /><i /><i /><i /></button>}
          {/* Type a question (no keyboard needed), at the left, where Opie shows up while it's busy; sleep the screen. */}
          {shell?.type && <button className="h-tool h-type" onClick={() => shell.type()} aria-label="Type to Opie"><Keys /></button>}
          {shell?.sleep && <button className="h-tool" onClick={() => shell.sleep()} aria-label="Sleep"><Moon /></button>}
          <button className="h-tool" onClick={() => setArranging(true)} aria-label="Tabs and look"><Sliders /></button>
          {shell && <button className="h-tool" onClick={() => shell.settings()} aria-label="Settings"><Gear /></button>}
        </div>
      </aside>
      <main className="h-sheet">
        {tabs.filter((t) => seen.has(t.id) || t.id === cur).map((t) => (
          <section key={t.id} className="h-page" hidden={t.id !== cur}>
            {t.id === 'today' ? <Today c={c} house={house} now={now} notes={door?.notes || []} weather={weather} tabs={tabs} appBy={appBy} go={go} openApp={openApp} shell={shell} usePhoto={usePhoto} look={st} appsV={door?.appsV || {}} />
              : t.id === 'apps' ? <Apps c={c} shell={shell} apps={apps} tabs={tabs} places={door?.places || {}} cards={st.cards || []} />
              : shell && appBy.get(t.id)?.web !== false ? <AppFrame c={c} shell={shell} app={appBy.get(t.id)} look={st} v={door?.appsV?.[t.id] || 0} onOpen={openApp} />
              : <div className="h-widget"><Widget id={t.id} app={appBy.get(t.id)} w={4} h={4} house={house} c={c} now={now} Photo={(p) => <PhotoShow c={c} {...p} />}
                content={door?.widgets?.content?.[t.id] ? (door.widgets.content[t.id].shapes?.['4x4'] || door.widgets.content[t.id].content || '') : null} /></div>}
          </section>
        ))}
        {/* Apps that keep things up to date in the background ("background": true in app.json: a school lunch menu on the
            calendar) run hidden, even when they aren't a tab. */}
        {shell && apps.filter((a) => a.meta?.background && a.web !== false && !tabs.some((t) => t.id === a.id)).map((a) => (
          <section key={'bg-' + a.id} className="h-page" hidden><AppFrame c={c} shell={shell} app={a} look={st} v={door?.appsV?.[a.id] || 0} onOpen={openApp} /></section>
        ))}
      </main>
      {(() => { const t = timers.find((x) => x.endAt === timerOpen); return t && (
        <div className="h-veil" onClick={() => setTimerOpen(null)}>
          <div className="h-timer-card" onClick={(e) => e.stopPropagation()}>
            <div className="h-timer-name">{t.label}</div>
            <div className="h-timer-left">{t.endAt <= now ? '0:00' : clock(Math.ceil((t.endAt - now) / 1000))}</div>
            <div className="h-timer-do">
              <button onClick={() => moveTimer(t, -60)} disabled={t.endAt <= now + 60e3}>−1 min</button>
              <button onClick={() => moveTimer(t, 60)}>+1 min</button>
              <button onClick={() => moveTimer(t, 300)}>+5 min</button>
            </div>
            <div className="h-timer-do">
              <button className="h-timer-clear" onClick={() => { setTimerOpen(null); c.json('POST', '/door/timer', { cancel: t.endAt }).catch(() => {}); }}>Clear</button>
              <button onClick={() => setTimerOpen(null)}>Done</button>
            </div>
          </div>
        </div>); })()}
      {arranging && <Arrange c={c} st={st} tabs={tabs} apps={apps} nameOf={nameOf} onClose={() => setArranging(false)} />}
    </div>
  );
}

/** The family's photos behind everything, one every 5 minutes, crossfading. */
function Backdrop({ c, names, now, usePhoto }) {
  const name = names.length ? names[Math.floor(now / 300e3) % names.length] : null;
  const src = usePhoto(c, name);
  const [shown, setShown] = useState([]);
  useEffect(() => { if (src) setShown((s) => [...s.filter((x) => x !== src), src].slice(-2)); }, [src]);
  return <div className="h-backdrop">{shown.map((u, k) => <img key={u} src={u} alt="" className={k === shown.length - 1 ? 'on' : ''} draggable={false} />)}</div>;
}

/** Where an app's pages are: a shared one (from a link) on an origin of its own, http://<id>.localhost:<port>, so no
 *  other app's page can reach into it or it into theirs (device/vite.config.mjs); ours and the household's at the dev
 *  server's own (shell.ui). */
export function appOrigin(shell, app) {
  const u = new URL(shell.ui);
  return app?.shared ? `${u.protocol}//${app.id}.localhost${u.port ? ':' + u.port : ''}` : u.origin;
}

/**
 * What an app's frame may ask of the home page, from its own origin only: its key (handed to it by message when its
 * kit asks, never in its address), that a field of its has the keyboard, and (ours and the household's only, not an
 * app from a link) a phone card or opening another app. A shared app may open only itself.
 */
function useAppFrame(frame, shell, app, key, { onPhone, onOpen } = {}) {
  useEffect(() => {
    if (!app || !shell?.ui) return;
    const origin = appOrigin(shell, app);
    let typing = false;
    const on = (e) => {
      if (!frame.current || e.source !== frame.current.contentWindow || e.origin !== origin || !e.data || typeof e.data !== 'object') return;
      const m = e.data;
      if (m.openhouse === 'hello') { if (key) e.source.postMessage({ openhouse: 'key', key }, origin); }
      else if (m.openhouse === 'editing') { typing = !!m.on; shell.editing?.(typing); }
      else if (m.openhouse === 'phone') { if (!app.shared) onPhone?.(String(m.kind || ''), String(m.arg || '')); }
      else if (m.openhouse === 'open' && /^[\w.-]{1,60}$/.test(String(m.app || ''))) { if (!app.shared || m.app === app.id) onOpen?.(String(m.app)); }
    };
    addEventListener('message', on);
    return () => { removeEventListener('message', on); if (typing) shell.editing?.(false); };
  }, [shell, app?.id, app?.shared, key, onPhone, onOpen]);
}

/** One of the family's apps, running in the sheet (its own page and kit, given its key and the look). */
function AppFrame({ c, shell, app, look, v, onOpen }) {
  const [key, setKey] = useState(null);
  const frame = useRef(null);
  // A phone card the app asks for ("Add from phone", "Send to phone", a flyer): the shell shows it over the home.
  useAppFrame(frame, shell, app, key, { onPhone: shell?.phone, onOpen });
  // When the app's files change (the assistant changing it while they watch, an undo), it loads again, once the
  // saves have settled for a moment.
  const [shownV, setShownV] = useState(v);
  useEffect(() => { if (v === shownV) return; const t = setTimeout(() => setShownV(v), 700); return () => clearTimeout(t); }, [v]);
  useEffect(() => {
    if (!app) return;
    let off = false;
    c.json('GET', '/apps/key?app=' + encodeURIComponent(app.id)).then((r) => { if (!off && r.status === 200) setKey(r.json.key); }).catch(() => {});
    return () => { off = true; };
  }, [c, app?.id]);
  if (!app) return null;
  const hash = lookHash(look, shell, null, app);
  return key && <iframe ref={frame} key={shownV} className="h-app" title={app.meta?.name || app.id} sandbox="allow-scripts allow-same-origin allow-forms" src={`${appOrigin(shell, app)}/apps/${app.id}/index.html#${hash}`} />;
}

/** What an app's page is given in its address: the screen's colors and type (the kit takes them). Never its key.
 *  bg is the world its tab sits on, panel the white (or the palette's) its panels are. */
function lookHash(look, shell, paper, app) {
  const p = paletteOf(look);
  return new URLSearchParams({ bg: paper ? paper(p) : worldOf(look, app?.id), panel: p.sheet, ink: p.ink, accent: p.accent, face: look?.type || 'clean', ...(look?.palette === 'dusk' ? { dark: '1' } : {}), ...(shell?.phone && !app?.shared ? { phone: '1' } : {}) });
}
/**
 * An app's own card on Today: its widget.html running in a card like the others ("today": {"size": "small" | "wide"}
 * in its app.json), with its key, so the kit works there as in the app. The widget takes its own taps; the app's name
 * above it opens the app. Shown only once the household turned it on (style.json cards).
 */
function AppCard({ c, shell, app, look, v, openApp, style }) {
  const [key, setKey] = useState(null);
  const frame = useRef(null);
  useEffect(() => {
    let off = false;
    c.json('GET', '/apps/key?app=' + encodeURIComponent(app.id)).then((r) => { if (!off && r.status === 200) setKey(r.json.key); }).catch(() => {});
    return () => { off = true; };
  }, [c, app.id]);
  useAppFrame(frame, shell, app, key, { onOpen: openApp }); // the widget asking to open its app, or another (kit shell.openApp)
  const [shownV, setShownV] = useState(v); // reloads once the app's files have settled after a change
  useEffect(() => { if (v === shownV) return; const t = setTimeout(() => setShownV(v), 700); return () => clearTimeout(t); }, [v]);
  const hash = lookHash(look, shell, (p) => p.sheet, app);
  return <div className="t-card t-app" style={style}>
    <div className="h-label t-app-name" role="button" onClick={() => openApp(app.id)}>{app.meta?.name || app.id}</div>
    {key && <iframe ref={frame} key={shownV} className="t-app-pad" title={app.meta?.name || app.id} sandbox="allow-scripts allow-same-origin allow-forms" src={`${appOrigin(shell, app)}/apps/${app.id}/widget.html?today=${app.today}#${hash}`} />}
  </div>;
}

/** One of the apps' notes on the day (a school lunch, trash day), as a card on Today. With photos of its things (the
 *  day's lunch dishes) it's a picture card: the first dish large, the others small at its corner. Without, a small
 *  panel under the calendar's: its label above, the words below. A tap opens it: all of it, where it's from, where
 *  that app's notes show, and opening the app. */
const notePics = (n) => (n.pics || []).filter((p) => p.image);
function DayNote({ c, house, n, day, openApp, style }) {
  const [open, setOpen] = useState(false), [show, setShown] = useState(null), [bad, setBad] = useState(() => new Set());
  const showNow = show ?? (house?.fromApps || []).find((a) => a.app === n.app)?.show ?? n.show;
  const setShow = (v) => { setShown(v); c.json('POST', '/house/settings', { fromApp: { app: n.app, show: v } }).catch(() => {}); };
  const label = (sep) => <>{n.label}{n.who && <>{sep}{n.who}</>}</>;
  const pics = notePics(n).filter((p) => !bad.has(p.image));
  const img = (p, cls) => <img key={p.image} className={cls} src={p.image} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} onError={() => setBad(new Set([...bad, p.image]))} />;
  return <>
    {pics.length ? <div role="button" tabIndex={0} className="t-card t-lunch t-pic-card" style={style} onClick={() => setOpen(true)}>
      {img(pics[0], 't-cover')}
      {pics.length > 1 && <div className="t-sides">{pics.slice(1, 3).map((p) => img(p))}</div>}
      <div className="t-cap"><div className="h-label">{label(' · ')}</div><div className="t-big">{plain(pics[0].text || n.text)}</div>
        {pics.slice(1, 3).map((p, i) => <div key={i} className="t-or">or {plain(p.text)}</div>)}</div>
    </div> : <div role="button" tabIndex={0} className="t-card t-acts t-daynote" style={style} onClick={() => setOpen(true)}>
      <div className="h-label">{label(' · ')}</div>
      <div className="t-line">{plain(n.text)}</div>
    </div>}
    {open && <div className="h-veil" onClick={() => setOpen(false)}>
      <div className="h-note-full t-nsheet" onClick={(e) => e.stopPropagation()}>
        <div className="t-nk">{label(' · ')} · {day.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        <h2>{plain(n.text)}</h2>
        <div className="t-nfrom">From {n.name || n.app}</div>
        <div className="t-nshow"><span>Show</span>{[['week', 'Week and Today'], ['today', 'Today only'], ['off', 'Nowhere']].map(([k, l]) => (
          <button key={k} className={'h-chip' + (showNow === k ? ' on' : '')} onClick={() => setShow(k)}>{l}</button>))}</div>
        <div className="t-nacts"><button className="h-chip" onClick={() => { setOpen(false); openApp(n.app); }}>Open {n.name || n.app}</button>
          <button className="h-chip on" onClick={() => setOpen(false)}>Done</button></div>
      </div>
    </div>}
  </>;
}

/** Events counted down to (marked in the Calendar app, or by the assistant): the next time of each, soonest first. */
export function countdowns(house, now) {
  // Only ones not over yet (it had kept one a day after it started, which then read "today").
  const seen = new Set(), out = [];
  for (const e of [...(house?.events || [])].filter((x) => x.countdown && new Date(x.end || Date.parse(x.start) + (x.allDay ? 864e5 : 36e5)) > now).sort((a, b) => new Date(a.start) - new Date(b.start))) {
    const k = (e.id || e.uid || e.title) + '';
    if (seen.has(k.split('|')[0])) continue; seen.add(k.split('|')[0]);
    out.push(e);
  }
  return out;
}
/** "today", "tomorrow", "in 6 days", "in 3 weeks". */
export function untilText(start, now) {
  const a = new Date(now); a.setHours(0, 0, 0, 0); const b = new Date(start); b.setHours(0, 0, 0, 0);
  const d = Math.round((b - a) / 864e5);
  return d <= 0 ? 'today' : d === 1 ? 'tomorrow' : d < 21 ? `in ${d} days` : d < 70 ? `in ${Math.round(d / 7)} weeks` : `in ${Math.round(d / 30)} months`;
}

// ---- Today: the most important bit of each tab, at a glance -------------------------------------------------
// Each card is one tab's excerpt and opens that tab. Only the tabs the family has get a card (a renamed or remade app
// still counts by its name), the most useful first, and they share the screen without scrolling: Calendar down the left
// on a white panel, the others in rows beside it (two to a row, three in the last), each in its own color.
const KINDS = ['calendar', 'weather', 'chores', 'meals', 'lists', 'photos'];
/** Which of the starting apps a tab is, by its id or, for one the family remade, its name. */
export function kindOf(t, app) { if (KINDS.includes(t.id)) return t.id; const n = String(t.name || app?.meta?.name || '').toLowerCase(); return KINDS.find((k) => n.includes(k.replace(/s$/, ''))) || null; }
/** Whose world is behind a tab: the starting app it is, else its own id (look.js worldOf). */
const worldTab = (t, appBy) => (t ? kindOf(t, appBy.get(t.id)) || t.id : null);
// Titles from synced calendars can carry emoji ("🤸 Gymnastics"); the home screen draws no emoji as icons, so they go.
const plain = (t) => String(t || '').replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣]/gu, '').replace(/\s+/g, ' ').trim() || t;

/** A box on a Today card that shows as many of its [data-fit] parts as fit, in order (more events, the next days'
 *  weather), the rest left out, and never a day's label without its first row. Measured, so it follows the card. */
function useFit() {
  const ref = useRef(null);
  const fit = () => {
    const box = ref.current; if (!box) return;
    const parts = [...box.querySelectorAll('[data-fit]')];
    for (const x of parts) x.removeAttribute('data-off');
    const bottom = box.getBoundingClientRect().bottom + 1;
    let cut = parts.findIndex((x) => x.getBoundingClientRect().bottom > bottom);
    if (cut < 0) cut = parts.length;
    while (cut > 0 && parts[cut - 1].dataset.fit === 'label') cut--;
    for (const x of parts.slice(cut)) x.setAttribute('data-off', '');
  };
  useLayoutEffect(fit);
  useEffect(() => { const box = ref.current; if (!box) return; const o = new ResizeObserver(fit); o.observe(box); return () => o.disconnect(); }, []);
  return ref;
}

const weekday = (d, long) => d.toLocaleDateString('en-US', { weekday: long ? 'long' : 'short' });

/** The Weather card: its size (one cell, two rows tall, or wide) from its own box; drawn again every few minutes, not
 *  every second, so the sky's slow drift isn't restarted. */
function WeatherCard({ w, now, dim, className, ...rest }) {
  const ref = useRef(null), [size, setSize] = useState('cell');
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const o = new ResizeObserver(() => { const r = el.getBoundingClientRect(); if (r.width && r.height) setSize(r.width > r.height * 1.45 ? 'wide' : r.height > r.width * 1.45 ? 'tall' : 'cell'); });
    o.observe(el); return () => o.disconnect();
  }, []);
  const slot = Math.floor(now / 300e3);
  const look = useMemo(() => weatherCard(w, size, { now: new Date(now) }), [w, size, slot]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={ref} {...rest} className={className + ' ' + look.cls + (dim ? ' dim' : '')} dangerouslySetInnerHTML={{ __html: look.html }} />;
}

/** "in 20 minutes", "in 2 hours", "now": how far off the next thing is (only for one with a time, today). */
const inText = (e, now) => {
  if (!e || e.allDay) return '';
  const m = Math.round((new Date(e.start) - now) / 60e3);
  return m <= 0 ? 'now' : m < 60 ? `in ${m} ${m === 1 ? 'minute' : 'minutes'}` : m < 600 ? `in ${Math.round(m / 60)} ${Math.round(m / 60) === 1 ? 'hour' : 'hours'}` : '';
};
/** A dish's picture: its recipe's own (kept from its page), else a warm tile with its initial. */
function DishPic({ house, name }) {
  const [bad, setBad] = useState(false);
  const src = house?.recipes?.[String(name || '').trim().toLowerCase()]?.image;
  return src && !bad ? <img className="t-dish" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} onError={() => setBad(true)} />
    : <span className="t-dish letter">{String(name || '').trim()[0]?.toUpperCase() || ''}</span>;
}
const Basket = () => <svg className="t-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9.5h18l-1.6 9a1.5 1.5 0 0 1-1.5 1.2H6.1a1.5 1.5 0 0 1-1.5-1.2zM8 9.5l3.2-5.5M16 9.5l-3.2-5.5M9 13v3.5M12 13v3.5M15 13v3.5" /></svg>;
const Check = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;

/** Today (also on someone's phone, phone.jsx, in one column). */
export function Today({ c, house, now, notes, weather, tabs, appBy, go, openApp, shell, usePhoto, look, appsV }) {
  const h = house || {};
  const kinds = new Map(); for (const t of tabs) { const k = kindOf(t, appBy.get(t.id)); if (k && !kinds.has(k)) kinds.set(k, t.id); }
  const t = new Date(now); t.setHours(0, 0, 0, 0);
  const EvAv = ({ e, className }) => <Av paint={eventPaint(h, e)} name={eventPeople(h, e)[0]} className={className} />;
  const card = (kind, open) => ({ role: 'button', tabIndex: 0, className: 't-card t-' + kind, onClick: open || (() => go(kinds.get(kind))) });

  // Calendar: what's next, then the rest of its day, then the days after it, grouped by day, as many as fit (a quiet
  // today and tomorrow showed "Nothing on today or tomorrow" with the week full); under it, the things on Today.
  const tomorrow = new Date(+t + 864e5), weekOut = new Date(+t + 28 * 864e5); // (four weeks: the card fills with what's coming rather than leaving gaps)
  const upcoming = (h.events || []).filter((e) => (e.allDay ? dayOf(e) >= t : new Date(e.end || e.start) >= now) && dayOf(e) < weekOut)
    .sort((a, b) => (dayOf(a) - dayOf(b)) || (b.allDay - a.allDay) || (new Date(a.start) - new Date(b.start)));
  const byDay = []; for (const e of upcoming) { const d = dayOf(e); if (+byDay.at(-1)?.[0] !== +d) byDay.push([d, []]); byDay.at(-1)[1].push(e); }
  const first = upcoming[0], firstDay = first && dayOf(first);
  const dayName = (d) => (+d === +t ? 'Today' : +d === +tomorrow ? 'Tomorrow' : d - t < 7 * 864e5 ? weekday(d, true) : d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }));
  const todays = byDay[0] && +byDay[0][0] === +t ? byDay[0][1] : [];
  // What the household's apps put on the day (a school lunch, trash day): today's, and tomorrow's once today's events
  // are over or it's evening.
  const hadToday = (h.events || []).some((e) => +dayOf(e) === +t);
  const notesDay = !todays.length && (hadToday || new Date(now).getHours() >= 18) ? tomorrow : t;
  const dayNotes = (h.dayNotes?.[dayKey(notesDay)] || []).filter((x) => x.show !== 'off');
  const pictured = dayNotes.find((n) => notePics(n).length); // the one with photos is a card of its own beside the calendar
  const when = (e) => timeOf(e) || 'All day';
  // Chores: each person's today, done and left, and the routine that's on now.
  const mine = new Map();
  for (const ch of h.chores || []) if (ch.today !== false && !ch.skipped) { const k = ch.who || ''; if (!mine.has(k)) mine.set(k, [0, 0]); mine.get(k)[1]++; if (ch.done) mine.get(k)[0]++; }
  const routine = (h.checklists || []).find((r) => r.now);
  // Lists: the groceries (or the first list), what's left, ticked right here with a moment to put it back.
  const list = (h.lists || []).find((l) => l.id === 'groceries') || (h.lists || [])[0];
  const [ticked, setTicked] = useState(null);
  const [gone, setGone] = useState(() => new Set());
  const [adding, setAdding] = useState(null); // the words being added to the list, or null
  const typingIn = adding !== null; useEffect(() => { if (!typingIn) return; shell?.editing?.(true); return () => shell?.editing?.(false); }, [typingIn]); // (the shell's keyboard goes to the box)
  const add = () => { const t = String(adding || '').trim(); setAdding(null); if (t) c.json('POST', '/house/list', { list: list.name, add: [t] }).catch(() => {}); };
  useEffect(() => { if (!ticked) return; const x = setTimeout(() => setTicked(null), 6000); return () => clearTimeout(x); }, [ticked]);
  const items = (list?.items || []).filter((i) => !i.done && !gone.has(i.id));
  const tick = (e, i) => { e.stopPropagation(); setGone(new Set([...gone, i.id])); setTicked({ id: i.id, text: i.text }); c.json('POST', '/house/list', { list: list.name, check: [i.id] }).catch(() => {}); };
  const untick = (e) => { e.stopPropagation(); const i = ticked; setTicked(null); setGone(new Set([...gone].filter((x) => x !== i.id))); c.json('POST', '/house/list', { list: list.name, uncheck: [i.id] }).catch(() => {}); };
  // Meals: tonight's dinner and the next days' planned; unplanned, a few of their favorites and saved recipes to tap
  // for tonight (only ones they have: nothing made up).
  const dinner = (d) => { const v = h.meals?.[dayKey(d)]?.dinner; return v && String(v).trim() ? String(v) : null; };
  const [picked, setPicked] = useState(null); // planned here a moment ago, until /house has it
  const [noPic, setNoPic] = useState(() => new Set()); // a dish whose picture didn't load
  const tonight = dinner(t) || (picked?.day === dayKey(t) ? picked.text : null);
  const coming = [1, 2, 3, 4, 5, 6].map((n) => new Date(+t + n * 864e5)).filter(dinner);
  const picks = [];
  for (const x of [...(h.favorites || []).map((f) => f?.text ?? f), ...Object.values(h.recipes || {}).map((r) => r?.text)]) {
    const v = String(x || '').trim(); if (v && !picks.some((p) => p.toLowerCase() === v.toLowerCase())) picks.push(v);
  }
  const plan = (e, text) => { e.stopPropagation(); setPicked({ day: dayKey(t), text }); c.json('POST', '/house/meal', { date: dayKey(t), meal: 'dinner', text }).catch(() => {}); };
  const calFit = useFit(), mealFit = useFit();
  const photos = h.screensaver?.length ? h.screensaver : h.photos || [];

  const cards = [];
  // Weather: on its sky (the Weather tab's look, /kit/weather-look.js): now, the next hours, and the model's line tying
  // it to the household's plans; with no line, the next days.
  const w = weather && !weather.error ? weather : null;
  if (w) cards.push(<WeatherCard key="weather" w={w} now={now} dim={look?.palette === 'dusk'} {...card('weather', kinds.has('weather') ? null : () => shell?.weather?.())} />);
  if (pictured) cards.push(<DayNote key="lunch" c={c} house={h} n={pictured} day={notesDay} openApp={openApp} />);
  // Dinner: tonight's, on its own picture when its recipe has one; unplanned, three of theirs to tap, each with its picture.
  const tonightPic = tonight && !noPic.has(tonight) && h.recipes?.[tonight.trim().toLowerCase()]?.image;
  if (kinds.has('meals')) cards.push(<div key="meals" {...card('meals')} className={'t-card t-meals' + (tonightPic ? ' t-pic-card' : '')}>
    {tonightPic && <img className="t-cover" src={tonightPic} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} onError={() => setNoPic(new Set([...noPic, tonight]))} />}
    <div className="h-label">Dinner tonight</div>
    {tonight ? <div className="t-big">{tonight}</div> : <div className="t-big">Not planned yet</div>}
    {!tonight && !picks.length && !coming.length && <div className="t-soft">Plan the week in Meals</div>}
    {!tonight && picks.length > 0 && <div className="t-picks">{picks.slice(0, 3).map((p) => (
      <span key={p} role="button" className="t-pick" aria-label={'Have ' + p + ' tonight'} onClick={(e) => plan(e, p)}><DishPic house={h} name={p} /><b>{p}</b></span>))}</div>}
    {(tonight || !picks.length) && <div className="t-fit" ref={mealFit}>
      {coming.length > 0 && <div className="t-rows t-gap-s">{coming.map((d) => <div key={+d} className="t-row" data-fit="">
        <span className="t-when">{+d === +tomorrow ? 'Tomorrow' : weekday(d)}</span><span className="h-grow">{dinner(d)}</span>
      </div>)}</div>}
    </div>}
  </div>);
  // The list: what's left to get, in two columns, eight at most (more than that, seven and a count).
  if (kinds.has('lists') && list) cards.push(<div key="lists" {...card('lists')}>
    <div className="t-top"><Basket /><div className="h-label">{list.name}</div><span className="t-n t-add" role="button" onClick={(e) => { e.stopPropagation(); setAdding(''); }}>+ Add</span></div>
    {items.length || ticked ? <div className={'t-items' + (items.length <= 4 ? ' one' : '')}>{items.slice(0, items.length > 8 ? 7 : 8).map((i) => (
      <div key={i.id} className="t-item"><span className="t-box" role="button" aria-label={'Got ' + i.text} onClick={(e) => tick(e, i)} /><span className="h-grow">{i.text}</span></div>
    ))}{items.length > 8 && <div className="t-item t-more">and {items.length - 7} more</div>}</div>
      : <div className="t-big">Nothing to get</div>}
    {ticked && <span className="t-undo" role="button" onClick={untick}>Got {ticked.text} · Put it back</span>}
    {adding !== null && <div className="h-veil" onClick={(e) => { e.stopPropagation(); setAdding(null); }}>
      <form className="h-note-full t-addsheet" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); add(); }}>
        <h2>Add to {list.name}</h2>
        <input autoFocus value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Milk" aria-label={'Add to ' + list.name} />
        <div className="t-nacts"><button type="button" className="h-chip" onClick={() => setAdding(null)}>Cancel</button><button type="submit" className="h-chip on">Add</button></div>
      </form>
    </div>}
  </div>);
  // Chores: a ring each, filling as theirs get done.
  if (kinds.has('chores') && (mine.size || routine)) cards.push(<div key="chores" {...card('chores')}>
    <div className="h-label">{routine ? `${routine.name} now` : 'Chores today'}</div>
    {mine.size ? <div className="t-rings">{[...mine].slice(0, 4).map(([who, [done, n]]) => { const col = personColor(h, who) || 'var(--h-soft)', all = done === n; return (
      <div key={who} className={'t-ring' + (all ? ' done' : '')}>
        <span className="t-ring-o"><svg viewBox="0 0 58 58"><circle className="t-ring-bg" cx="29" cy="29" r="25" fill="none" strokeWidth="6" />{done > 0 && <circle cx="29" cy="29" r="25" fill={all ? col : 'none'} stroke={col} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${157.1 * done / n} 157.1`} />}</svg>
          <b>{all ? <Check /> : (who || 'A')[0].toUpperCase()}</b></span>
        <span className="t-ring-n">{who || 'Anyone'}</span><em>{all ? 'Done' : `${n - done} left`}</em>
      </div>); })}</div> : <div className="t-line">{routine.steps?.length || 0} steps</div>}
  </div>);
  // The apps' own cards the household turned on, in their order, before the notes and the photo (wide: a row of its own).
  if (notes.length) cards.push(<NotesCard key="notes" c={c} notes={notes} reminders={[]} />); // (reminders due are things on Today)
  if (shell?.ui) for (const id of look?.cards || []) { const a = appBy.get(id); if (a?.today) cards.push(<AppCard key={'app:' + id} c={c} shell={shell} app={a} look={look} v={appsV[id] || 0} openApp={openApp} wide={a.today === 'wide'} />); }
  if (kinds.has('photos') && photos.length) cards.push(<PhotoCard key="photos" c={c} names={photos} captions={h.captions} now={now} usePhoto={usePhoto} {...card('photos')} />);
  // Laid out in rows, three at most: two to a row beside the calendar (three without it), a wide card a row of its own;
  // the last row takes one more, so seven cards share the screen as two, two and three.
  const per = kinds.has('calendar') ? 2 : 3, rows = [];
  { let cur = null; for (const x of cards) { if (x.props.wide) { rows.push([x]); cur = null; } else { if (!cur || cur.length >= per) rows.push(cur = []); cur.push(x); } } }
  if (rows.length > 3 && rows[2].length === per && !rows[2][0].props.wide && !rows[3][0].props.wide) rows[2].push(rows[3][0]);
  rows.length = Math.min(rows.length, 3);
  const tall = rows.length === 3 ? [346, 296, 242] : [1, 1, 1];
  const wide = (x) => (x.key === 'photos' ? 1.5 : x.key === 'notes' ? 1 : 1.25);

  return (
    <div className="h-today">
      {!kinds.has('calendar') && <Things c={c} things={h.things} className="t-things t-things-head" go={go} tabs={tabs} ask={shell?.ask} />}
      <div className={'t-grid' + (kinds.has('calendar') ? ' with-cal' : '')}>
        {kinds.has('calendar') && <div className="t-calcol">
        <div {...card('calendar')}>
          {first ? <>
            <div className="t-hero">
              <div className="h-label">{+firstDay === +t ? ['Next', inText(first, now)].filter(Boolean).join(' · ') : dayName(firstDay)}</div>
              <div className="t-next">{plain(first.title)}</div>
              <div className="t-when-next"><EvAv e={first} className="dark" /><span className="h-grow">{[when(first), eventPeople(h, first).join(' & ') || null, first.place].filter(Boolean).join(' · ')}</span></div>
            </div>
            <div className="t-agenda t-fit" ref={calFit}>{byDay.map(([d, l], k) => { // the rest of its day, then each day after it
              const rest = k ? l : l.slice(1);
              return rest.length > 0 && <div key={+d} className="t-daygroup">
                <div className="h-label" data-fit="label">{k ? dayName(d) : +d === +t ? 'Later today' : 'Then'}</div>
                {rest.map((e, i) => <div key={i} className="t-ev" data-fit=""><span className="t-when">{when(e)}</span><EvAv e={e} /><span className="h-grow">{plain(e.title)}</span></div>)}
              </div>;
            })}</div>
          </> : <div className="t-empty"><div className="h-label">Calendar</div><div className="t-big t-quiet">Nothing on this week</div></div>}
          <Things c={c} things={h.things} go={go} tabs={tabs} ask={shell?.ask} />
        </div>
        {/* the day's other notes from the apps, the next thing under its events */}
        {dayNotes.filter((n) => n !== pictured).map((n, i) => <DayNote key={n.app + i} c={c} house={h} n={n} day={notesDay} openApp={openApp} />)}
        </div>}
        <div className="t-side">{rows.map((r, i) => <div key={i} className="t-siderow" style={{ flexGrow: tall[i], gridTemplateColumns: r.map((x) => `minmax(0, ${wide(x)}fr)`).join(' ') }}>{r}</div>)}</div>
      </div>
    </div>
  );
}

/** The things on Today (the bridge's things.js): a reminder due, a suggestion, a countdown, a broken app; one line
 *  each, at most three, most urgent first, each gone once it no longer matters. A tap does what it's about: its tab
 *  (go), or asks Opie (ask); its x takes it down. */
export function Things({ c, things, className = 't-things', go, tabs, ask }) {
  const [gone, setGone] = useState(() => new Set());
  const shown = (things || []).filter((x) => !gone.has(x.id));
  if (!shown.length) return null;
  const down = (e, x) => { e.stopPropagation(); setGone(new Set([...gone, x.id])); c.json('POST', '/house/thing', { take: x.id }).catch(() => {}); };
  const act = (x) => (x.open && go && tabs?.some((t) => t.id === x.open) ? () => go(x.open) : x.ask && ask ? () => ask(x.ask) : null);
  return <div className={className}>{shown.map((x) => {
    const f = act(x);
    return <div key={x.id} role={f ? 'button' : undefined} className={'t-thing t-' + x.kind + (f ? ' t-acts' : '')} onClick={(e) => { e.stopPropagation(); f?.(); }}>
      <span className="h-grow">{x.text}</span>
      <span className="t-x" role="button" aria-label="Take down" onClick={(e) => down(e, x)}>×</span>
    </div>;
  })}</div>;
}

/** A photo of theirs, a new one every minute, with its caption if it has one, opening Photos. */
function PhotoCard({ c, names, captions, now, usePhoto, ...rest }) {
  const name = names[Math.floor(now / 60e3) % names.length], src = usePhoto(c, name), cap = captions?.[name];
  return <div {...rest} className={rest.className + ' t-photo t-pic-card'}>{src && <img className="t-cover" src={src} alt="" draggable={false} />}{cap && <div className="t-cap"><div className="t-line">{cap}</div></div>}</div>;
}

// ---- Notes: what the assistant put up for them, and reminders due now ------------------------------------------------
/** The note's words without its layout: a line to show under its title. */
const gist = (content) => String(content || '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/[#*_>`|-]+/g, ' ').replace(/\s+/g, ' ').trim();
function NotesCard({ c, notes, reminders, style }) {
  const [open, setOpen] = useState(null), [gone, setGone] = useState(() => new Set());
  // Newest first (the bridge set aside the ones the assistant kept current for the old board).
  const shown = notes.filter((n) => !gone.has(n.id)).reverse().sort((a, b) => (b.at || 0) - (a.at || 0));
  const note = open && notes.find((n) => n.id === open);
  const down = (n) => { setOpen(null); setGone(new Set([...gone, n.id])); c.json('POST', '/door/remove', { id: n.id }).catch(() => {}); };
  const room = Math.max(0, 3 - reminders.length);
  // The newest large, as a note on yellow; the next ones small under it.
  return <div className="t-card t-notes" style={style}>
    <div className="h-label">{reminders.length && !shown.length ? 'Now' : shown.length > 1 ? 'Notes' : 'Note'}</div>
    <div className="t-rows">
      {reminders.slice(0, 3).map((r) => <div key={r.key} className="t-row t-due"><span className="t-when">{timeOf(r)}</span><span className="h-grow">{plain(r.title)}</span></div>)}
      {shown.slice(0, room).map((n, i) => (
        <div key={n.id} role="button" className={'t-note' + (i ? '' : ' first')} onClick={(e) => { e.stopPropagation(); setOpen(n.id); c.json('POST', '/door/touch', { id: n.id }).catch(() => {}); }}>
          <span className="t-note-title">{n.title}</span>{!i && gist(n.content) && <span className="t-note-gist">{gist(n.content)}</span>}
        </div>
      ))}
      {shown.length > room && room > 0 && <div className="t-soft">{shown.length - room} more</div>}
    </div>
    {note && <div className="h-veil" onClick={() => setOpen(null)}>
      <div className="h-note-full" onClick={(e) => e.stopPropagation()}>
        <div className="h-note-head"><h2>{note.title}</h2>
          <button className="h-chip" onClick={() => down(note)}>Take it down</button>
          <button className="h-mini" onClick={() => setOpen(null)} aria-label="Close"><Cross /></button></div>
        <div className="h-note-body"><AnswerBody text={note.content} /></div>
      </div>
    </div>}
  </div>;
}

// ---- Apps: every app that isn't a tab of its own --------------------------------------------------------------------
/** The family's apps that aren't tabs, and the Android apps added (Netflix…), as a calm grid. A tap opens one;
 *  a hold offers to make it a tab or to take it off here (an app taken off comes back when someone asks Opie). */
function Apps({ c, shell, apps, tabs, places, cards }) {
  const android = useMemo(() => { try { return shell?.androidApps ? JSON.parse(shell.androidApps() || '[]') : []; } catch { return []; } }, [apps]);
  const [hid, setHid] = useState({}); // shown at once, until the door has it
  const [menu, setMenu] = useState(null);
  const inTabs = new Set(tabs.map((t) => t.id));
  const all = [...apps.filter((a) => a.id !== 'home' && !inTabs.has(a.id)).map((a) => ({ id: a.id, name: a.meta?.name || a.id, about: a.meta?.description || '', svg: a.icon, web: a.web !== false, today: a.today })),
    ...android.map((a) => ({ id: a.id, name: a.name || a.id, img: a.icon, android: true }))]
    .sort((a, b) => a.name.localeCompare(b.name));
  const off = (a) => hid[a.id] ?? !!places['app:' + a.id]?.hidden;
  const here = all.filter((a) => !off(a));
  const hide = (a, on) => { setMenu(null); setHid({ ...hid, [a.id]: on }); c.json('POST', '/door/place', { key: 'app:' + a.id, hidden: on }).catch(() => {}); };
  const toTab = (a) => { setMenu(null); c.json('POST', '/door/look', { tabs: [...tabs.map((t) => (t.name ? { id: t.id, name: t.name } : { id: t.id })), { id: a.id }] }).catch(() => {}); };
  const [onToday, setOnToday] = useState({}); // shown at once, until the door has it
  const isOn = (a) => onToday[a.id] ?? cards.includes(a.id);
  const toToday = (a, on) => { setMenu(null); setOnToday({ ...onToday, [a.id]: on }); c.json('POST', '/door/look', { cards: on ? [...cards.filter((x) => x !== a.id), a.id] : cards.filter((x) => x !== a.id) }).catch(() => {}); };
  const open = (a) => { if (a.web === false) setMenu({ ...a, old: true }); else shell?.openApp(a.id); };
  const held = useRef(null);
  const press = (a) => ({
    onPointerDown: (e) => { const at = [e.clientX, e.clientY]; clearTimeout(held.current?.t); held.current = { at, t: setTimeout(() => { held.current = { done: true }; setMenu(a); }, 600) }; },
    onPointerMove: (e) => { const h = held.current; if (h?.at && Math.hypot(e.clientX - h.at[0], e.clientY - h.at[1]) > 12) { clearTimeout(h.t); held.current = null; } },
    onPointerUp: () => { const h = held.current; held.current = null; if (h?.at) { clearTimeout(h.t); open(a); } },
    onPointerCancel: () => { clearTimeout(held.current?.t); held.current = null; },
    onContextMenu: (e) => e.preventDefault(),
  });
  const Icon = ({ a }) => a.svg ? <img className="h-app-icon" src={`data:image/svg+xml,${encodeURIComponent(a.svg)}`} alt="" draggable={false} />
    : a.img ? <img className="h-app-icon own" src={a.img} alt="" draggable={false} />
    : <span className="h-app-icon letter">{a.name[0].toUpperCase()}</span>;
  return (
    <div className="h-apps">
      <div className="h-head"><h1 className="h-title">Apps <span>made for this house</span></h1></div>
      {/* Each app a white panel: its icon large, its name and what it says of itself under. */}
      {here.length || shell?.plugins ? <div className="h-app-grid">{here.map((a) => (
        <button key={a.id} className={'h-app-tile' + (a.web === false ? ' old' : '')} {...press(a)}><Icon a={a} /><span className="h-app-name">{a.name}</span><span className="h-app-about">{a.about}</span></button>
      ))}
        {/* OpenHouse's list of plugins (the shell's gallery, as in Settings, Plugins): adding one asks for the PIN */}
        {shell?.plugins && <button className="h-app-tile add" onClick={() => shell.plugins()}>
          <span className="h-app-icon letter add"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg></span>
          <span className="h-app-name">Add apps</span><span className="h-app-about">A gallery of plugins OpenHouse has looked over.</span></button>}</div> : <div className="h-soft">{all.length ? 'Nothing here: every app is a tab or taken off.' : 'No other apps yet. Ask Opie to make one.'}</div>}
      {menu && <div className="h-veil" onClick={() => setMenu(null)}>
        <div className="h-menu" onClick={(e) => e.stopPropagation()}>
          <div className="h-menu-head"><Icon a={menu} /><span>{menu.name}</span></div>
          {menu.old ? <div className="h-soft">This one can't open yet. Ask Opie to remake it.</div> : <>
            {menu.web && <button className="h-menu-row" onClick={() => toTab(menu)}>Make it a tab</button>}
            {menu.today && <button className="h-menu-row" onClick={() => toToday(menu, !isOn(menu))}>{isOn(menu) ? 'Take it off Today' : 'Add to Today'}</button>}
            <button className="h-menu-row" onClick={() => hide(menu, true)}>Take it off Apps</button></>}
          <button className="h-menu-row soft" onClick={() => setMenu(null)}>{menu.old ? 'Close' : 'Cancel'}</button>
        </div>
      </div>}
    </div>
  );
}

// ---- Tabs and look --------------------------------------------------------------------------------------------
function Arrange({ c, st, tabs, apps, nameOf, onClose }) {
  const [mine, setMine] = useState({ tabs: tabs.map((t) => (t.name ? { id: t.id, name: t.name } : { id: t.id })), palette: st.palette, type: st.type, density: st.density, backdrop: st.backdrop, cards: st.cards || [] });
  const [busy, setBusy] = useState(null);
  const save = (part) => {
    const next = { ...mine, ...part }; setMine(next);
    c.json('POST', '/door/look', part).then((r) => setBusy(r.status === 409 ? r.json?.text || 'Busy' : null)).catch(() => {});
  };
  const shown = new Set(mine.tabs.map((t) => t.id));
  const more = [{ id: 'today' }, { id: 'apps' }, ...apps.filter((a) => a.web !== false).map((a) => ({ id: a.id }))].filter((t) => !shown.has(t.id));
  const moved = (list, i, by) => { const l = [...list]; const [x] = l.splice(i, 1); l.splice(Math.max(0, Math.min(l.length, i + by)), 0, x); return l; };
  const move = (i, by) => save({ tabs: moved(mine.tabs, i, by) });
  // The apps' own cards on Today: the ones on, in order, and the others that offer one.
  const offers = apps.filter((a) => a.today), cardName = (id) => offers.find((a) => a.id === id)?.meta?.name || id;
  const onCards = mine.cards.filter((id) => offers.some((a) => a.id === id)), offCards = offers.filter((a) => !onCards.includes(a.id));
  return (
    <div className="h-veil" onClick={onClose}>
      <div className="h-arrange" onClick={(e) => e.stopPropagation()}>
        <div className="h-arr-col">
          <div className="h-label">Tabs</div>
          {mine.tabs.map((t, i) => (
            <div key={t.id} className="h-arr-row">
              <span className="h-grow">{nameOf(t)}</span>
              <button className="h-mini" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Up"><Chevron up /></button>
              <button className="h-mini" disabled={i === mine.tabs.length - 1} onClick={() => move(i, 1)} aria-label="Down"><Chevron /></button>
              <button className="h-mini" disabled={mine.tabs.length < 2} onClick={() => save({ tabs: mine.tabs.filter((x) => x.id !== t.id) })} aria-label="Remove"><Cross /></button>
            </div>
          ))}
          {more.length > 0 && <div className="h-chips">{more.map((t) => <button key={t.id} className="h-chip" onClick={() => save({ tabs: [...mine.tabs, t] })}>+ {nameOf(t)}</button>)}</div>}
          {offers.length > 0 && <>
            <div className="h-label h-gap">Cards on Today</div>
            {onCards.map((id, i) => (
              <div key={id} className="h-arr-row">
                <span className="h-grow">{cardName(id)}</span>
                <button className="h-mini" disabled={i === 0} onClick={() => save({ cards: moved(onCards, i, -1) })} aria-label="Up"><Chevron up /></button>
                <button className="h-mini" disabled={i === onCards.length - 1} onClick={() => save({ cards: moved(onCards, i, 1) })} aria-label="Down"><Chevron /></button>
                <button className="h-mini" onClick={() => save({ cards: onCards.filter((x) => x !== id) })} aria-label="Take off Today"><Cross /></button>
              </div>
            ))}
            {offCards.length > 0 && <div className="h-chips">{offCards.map((a) => <button key={a.id} className="h-chip" onClick={() => save({ cards: [...onCards, a.id] })}>+ {a.meta?.name || a.id}</button>)}</div>}
          </>}
        </div>
        <div className="h-arr-col">
          <div className="h-label">Colour</div>
          <div className="h-swatches">{Object.entries(PALETTES).map(([k, p]) => (
            <button key={k} className={'h-swatch' + (mine.palette === k ? ' on' : '')} style={{ background: p.bg }} onClick={() => save({ palette: k, colors: {} })} aria-label={k}>
              <span style={{ background: p.sheet }} /><i style={{ background: p.accent }} />
            </button>
          ))}</div>
          <div className="h-label h-gap">Type</div>
          <div className="h-swatches">{Object.entries(FACES).map(([k, f]) => (
            <button key={k} className={'h-face' + (mine.type === k ? ' on' : '')} style={{ fontFamily: f }} onClick={() => save({ type: k })}>Aa</button>
          ))}</div>
          <div className="h-label h-gap">Spacing</div>
          <div className="h-seg">{[['calm', 'Roomy'], ['snug', 'Snug']].map(([k, w]) => <button key={k} className={mine.density === k ? 'on' : ''} onClick={() => save({ density: k })}>{w}</button>)}</div>
          <div className="h-label h-gap">Behind</div>
          <div className="h-seg">{[['none', 'Plain'], ['photos', 'Photos']].map(([k, w]) => <button key={k} className={mine.backdrop === k ? 'on' : ''} onClick={() => save({ backdrop: k })}>{w}</button>)}</div>
          {busy && <div className="h-soft h-gap">{busy}</div>}
        </div>
      </div>
    </div>
  );
}

const Keys = () => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" /></svg>;
const Moon = () => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>;
const Sliders = () => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>;
const Chevron = ({ up }) => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d={up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} /></svg>;
const Cross = () => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M7 7l10 10M17 7L7 17" /></svg>;

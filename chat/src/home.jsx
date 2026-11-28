// The home screen: a column on the left with the time, the day and the tabs, and the chosen tab beside it, on a world
// of its own faint hue with white panels on it. A tab is Today (a glance at the day, with the notes the assistant put up), Apps (every app that isn't a
// tab of its own, and the Android apps added), or any of the family's apps, the real app running in the
// sheet, so an app the family or the assistant changed shows as they changed it. Today is the glance: the most
// important bit of each tab, each opening its tab.
//
// What's personal is data in apps/home/style.json (bridge/home-screen.js, cleanLook): which tabs and in what order, the
// palette or the family's own colors, the type, the density and a photo backdrop. The assistant edits that file
// (set_home: "move Meals up", "a darker look"); there's no sheet for it on Home for now (the user: through Opie, not
// a clunky panel).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Widget } from './home-widgets.jsx';
import { SpotifySlot, useSpotifyOn } from './spotify-player.jsx';
import { useNow, smallHours } from './now.js';
import { AlarmsSheet, nextAlarm, ringTime } from './alarms.jsx';
import { AnswerBody } from './answer.jsx';
import { TAB_ICONS, TAB_ICON_BY_ID } from './tab-icons.js';
import { PALETTES, WHITE, paletteOf, worldOf } from './look.js';
import { card as weatherCard, icon as weatherIcon } from '../../bridge/kit/weather-look.js';
import { dishMark, dishOf, dishTint } from '../../bridge/kit/dish-look.js';

const DEFAULT_TABS = ['today', 'calendar', 'weather', 'map', 'chores', 'lists', 'meals', 'recipes', 'photos', 'whiteboard', 'apps'];
const FIRST = typeof location !== 'undefined' && new URLSearchParams(location.search).has('first');
export { PALETTES };
const FACES = { clean: "'Inter', Roboto, system-ui, sans-serif", serif: "'Newsreader', Georgia, serif", round: "'Nunito', system-ui, sans-serif", hand: "'Caveat', cursive" };
const PEOPLE = ['#ffc247', '#56d6a0', '#ff8566', '#74acff', '#c3a0ff', '#ff9ec4'];
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
/** The rail's clock: "3:07pm", or "15:07" when Settings → Screen → Time says 24-hour (the shell's clock24). */
const railTime = (d, h24) => h24 ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : <>{d.getHours() % 12 || 12}:{pad(d.getMinutes())}<small>{d.getHours() < 12 ? 'am' : 'pm'}</small></>;
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

/** The battery, a quiet line in the rail, only when it matters: unplugged, or low. Asked of the shell every 30 seconds. */
function BatteryLine({ shell }) {
  const [b, setB] = useState(null);
  const tick = Math.floor(useNow(30000) / 30000);
  useEffect(() => { if (shell?.battery) setB(shell.battery()); }, [tick, shell]);
  if (!b || b.level < 0) return null;
  if (b.plugged && b.level >= 30) return null;
  const fill = Math.max(1, Math.round(b.level / 100 * 14));
  return <div className={'h-wx h-batt' + (b.level < 15 && !b.charging ? ' low' : '')}>
    <svg className="h-wx-i" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="7" width="17" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><rect x="20.5" y="10" width="1.8" height="4" rx=".9" fill="currentColor" />{b.charging ? <path d="M12.4 8.4 8.6 12.6h3l-1 3 3.8-4.2h-3z" fill="currentColor" /> : <rect x="4.5" y="9" width={fill} height="6" rx="1" fill="currentColor" />}</svg>
    {`${b.level}%`}
  </div>;
}

/** The rail's time and date: drawn again each minute, by itself. */
function RailClock({ shell, onAlarms }) {
  const d = new Date(useNow(60e3));
  return <>
    <div className="h-time" role="button" onClick={onAlarms}>{railTime(d, shell?.clock24?.())}</div>
    <div className="h-day">{d.toLocaleDateString([], { weekday: 'long' })}</div>
    <div className="h-day h-date">{d.toLocaleDateString([], { day: 'numeric', month: 'long' })}</div>
  </>;
}
/** A timer's time left ("4:05"), drawn again each second by itself. */
function TimeLeft({ t }) {
  const now = useNow(1000);
  return t.endAt <= now ? '0:00' : clock(Math.ceil((t.endAt - now) / 1000));
}
/** The next alarm when it rings within a day (a tap opens the alarms), else nothing. */
function NextAlarm({ alarms, children }) {
  const now = useNow(60e3), n = nextAlarm(alarms, now);
  return n && n.at - now < 864e5 ? children(n) : null;
}
/** "−1 min", off once less than a minute is left. */
function LessMinute({ t, onClick }) {
  const now = useNow(1000);
  return <button onClick={onClick} disabled={t.endAt <= now + 60e3}>−1 min</button>;
}

/** CSS colors laid over each other, as one solid "#rrggbb" (the rail's see-through tint on its world). */
const solid = (() => {
  let x = null;
  return (...colors) => {
    try {
      x ||= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
      x.clearRect(0, 0, 1, 1); for (const c of colors) { x.fillStyle = c; x.fillRect(0, 0, 1, 1); }
      const d = x.getImageData(0, 0, 1, 1).data; return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    } catch { return null; }
  };
})();
/** A phone (its short side under 600 px, as the shell's Calm.compact): the glance and a bar of tabs upright, the rail on its side. */
const compactNow = () => Math.min(innerWidth, innerHeight) < 600;
function useCompact() {
  const look = () => ({ compact: compactNow(), upright: innerHeight > innerWidth });
  const [k, setK] = useState(look);
  useEffect(() => { const f = () => setK((was) => { const n = look(); return n.compact === was.compact && n.upright === was.upright ? was : n; }); addEventListener('resize', f); return () => removeEventListener('resize', f); }, []);
  return k;
}

export function Home({ c, brain, idle, onAsk, shell, ambient, usePhoto, PhotoShow, Gear }) {
  const { homeScreen, house, weather, apps, appsLoaded } = brain;
  const st = homeScreen?.style || {};
  const appBy = useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps]);
  const tabs = useMemo(() => (st.tabs || DEFAULT_TABS.map((id) => ({ id })))
    .map((t) => (t.id === 'board' ? { ...t, id: 'apps' } : t)) // the board this used to be (home-screen.js cleanLook does it too)
    .filter((t) => t.id === 'today' || t.id === 'apps' || appBy.has(t.id) || !appsLoaded), [st.tabs, appBy, appsLoaded]);
  const nameOf = (t) => t.name || (t.id === 'today' ? 'Home' : t.id === 'apps' ? 'Apps' : appBy.get(t.id)?.meta?.name || t.id);
  // Its icon: the app's own pick ("tabIcon" in its app.json), else a starting tab's; none leaves the space, so names line up.
  const iconOf = (t) => TAB_ICONS[appBy.get(t.id)?.meta?.tabIcon] || TAB_ICONS[TAB_ICON_BY_ID[t.id]] || null;
  // (`&first` in its address: the shell, as the setup ends, wants it on Home whatever showed during the setup)
  const [want, setWant] = useState(() => { if (FIRST) { store.set('openhouse.tab', 'today'); return 'today'; } return store.get('openhouse.tab') || 'today'; });
  const cur = tabs.some((t) => t.id === want) ? want : tabs[0]?.id;
  const [seen, setSeen] = useState(() => new Set());
  useEffect(() => { if (cur && !seen.has(cur)) setSeen(new Set([...seen, cur])); }, [cur]);
  // The display tells the bridge which tab is showing, so "make this bigger" is about it (home-screen.js requestApp).
  useEffect(() => { if (shell && cur) c.json('POST', '/home/showing', { tab: cur }).catch(() => {}); }, [cur]);
  const go = (id) => { setWant(id); store.set('openhouse.tab', id); };
  // An app asking for another (the Calendar's "Open School lunch"): its tab, else full screen.
  // "+ Add" on a Home card that opens its tab's own add (Calendar's new event): the app is told in its address, once.
  const [addIn, setAddIn] = useState(null);
  const addTo = (id, extra = '') => { setAddIn({ id, at: Date.now(), extra }); go(id); }; // extra: more for its address (Photos: photo=<name>)
  const openApp = (id) => { if (tabs.some((t) => t.id === id)) go(id); else if (appBy.has(id)) shell?.openApp(id); };
  // A tab that wasn't there a moment ago (the assistant just added it): show it, so they see what they asked for. Several
  // at once are the starting apps arriving on a new tablet, not one asked for: those stay where they are.
  const known = useRef(null);
  useEffect(() => {
    const ids = tabs.map((t) => t.id);
    if (appsLoaded && known.current) { const added = ids.filter((id) => !known.current.has(id)); if (added.length === 1) go(added[0]); }
    if (appsLoaded) known.current = new Set(ids);
  }, [tabs.map((t) => t.id).join(), appsLoaded]);
  // A paired computer checking one of the tabs' apps (workshop.js): show that tab, once per request.
  const showAt = homeScreen?.show?.at || 0;
  // (or Opie showing a place on the Map, or a recipe to cook: an app that isn't a tab opens full screen, home-screen.js showApp)
  useEffect(() => { const t = homeScreen?.show?.tab; if (!t || Date.now() - showAt >= 60e3) return;
    if (tabs.some((x) => x.id === t)) go(t); else if (homeScreen.show.open && appBy.has(t)) shell?.openApp(t); }, [showAt]);
  // Back to the first tab when the screen has rested, as a glance is what it's for.
  useEffect(() => { if (idle && tabs[0]) go(tabs[0].id); }, [idle]);
  const [timerOpen, setTimerOpen] = useState(null);
  const [alarmsOpen, setAlarmsOpen] = useState(false);
  const alarms = homeScreen?.alarms?.list || [];
  const { compact, upright } = useCompact(), bar = compact && upright;
  const [more, setMore] = useState(false);
  // On its side, the rail shows the tabs that fit whole; the rest are in More.
  const railTabsRef = useRef(null), [fit, setFit] = useState(99);
  useLayoutEffect(() => {
    if (!compact || bar) { setFit(99); return; }
    const el = railTabsRef.current; if (!el) return;
    const f = () => { const t = el.querySelector('.h-tab'); if (!t) return; const gap = parseFloat(getComputedStyle(el).rowGap) || 0; setFit(Math.max(2, Math.floor((el.clientHeight + gap) / (t.offsetHeight + gap)))); };
    f(); const o = new ResizeObserver(f); o.observe(el); return () => o.disconnect();
  }, [compact, bar]);
  const railShown = !compact || bar || tabs.length <= fit ? tabs.length : fit - 1, inMore = bar ? tabs.slice(4) : tabs.slice(railShown);
  // A minute more or less (or five more): the same timer, ending later or sooner (the shell's ringing follows /home/timer).
  const moveTimer = (t, secs) => {
    const endAt = Math.max(Date.now() + 5e3, t.endAt + secs * 1000), total = Math.max(5, (t.total || 0) + secs);
    setTimerOpen(endAt);
    c.json('POST', '/home/timer', { cancel: t.endAt }).then(() => c.json('POST', '/home/timer', { start: { label: t.label, total, endAt } })).catch(() => {});
  };
  // Talk and Type float in the same places over an app (the shell draws them: HomeView.railTools, RailTools.kt): where
  // they are and in what colors, whenever that changes. Upright on a phone there's no rail, so nothing floats.
  const toolsRef = useRef(null);
  useEffect(() => {
    if (!shell?.railTools) return;
    if (bar) { shell.railTools({}); return; }
    const el = toolsRef.current; if (!el) return;
    const send = () => {
      const t = el.querySelector('[data-tool="talk"]'), y = el.querySelector('[data-tool="type"]'), b = t || y;
      if (!b) return shell.railTools({});
      const at = (x) => { if (!x) return null; const r = x.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10); };
      const cs = getComputedStyle(b), home = el.closest('.home');
      shell.railTools({ dpr: devicePixelRatio, talk: at(t), type: at(y), inset: parseFloat(cs.paddingLeft) / b.offsetWidth || 0.25,
        fill: solid(home ? getComputedStyle(home).backgroundColor : '#fff', cs.backgroundColor), ink: solid(cs.color) });
    };
    send(); const later = setTimeout(send, 500); // (and once the world's color has eased to the tab's)
    const o = new ResizeObserver(send); o.observe(el); addEventListener('resize', send);
    return () => { clearTimeout(later); o.disconnect(); removeEventListener('resize', send); };
  }, [shell, bar, idle, cur, st]);
  if (idle) return ambient;
  // Someone's AI (Claude, ChatGPT, a computer) is changing an app (workshop.js): its tab pulses gently, or Apps for
  // one that isn't a tab (a new app goes there first). No words: the family sees where, and it stops when it's done.
  const busy = homeScreen?.computer?.apps || [];
  const making = (id) => busy.includes(id) || (id === 'apps' && busy.some((a) => !tabs.some((t) => t.id === a)));
  const timers = homeScreen?.timers || [];
  return (
    <div className={'home' + (st.density === 'snug' ? ' snug' : '') + (st.type === 'hand' ? ' hand-type' : '') + (st.backdrop === 'photos' ? ' over-photos' : '') + (st.palette === 'dusk' ? ' dark' : '') + (compact ? ' compact' : '') + (bar ? ' upright' : '')} data-tab={cur} style={lookVars(st, worldTab(tabs.find((t) => t.id === cur), appBy))}>
      {st.backdrop === 'photos' && <Backdrop c={c} names={house?.screensaver || house?.photos || []} usePhoto={usePhoto} />}
      {!bar && <aside className="h-rail">
        <RailClock shell={shell} onAlarms={() => setAlarmsOpen(true)} />
        {weather && !weather.error && <div className="h-wx"><span className="h-wx-i" dangerouslySetInnerHTML={{ __html: weatherIcon(weather.code, weather.isDay !== false) }} />{weather.temp}° {String(weather.condition || '').toLowerCase()}</div>}
        {/* Tap a timer to change or clear it (a small sheet over the screen). */}
        {timers.map((t) => <button key={t.endAt} className="h-timer" onClick={() => setTimerOpen(t.endAt)}>{t.label} <b><TimeLeft t={t} /></b></button>)}
        <NextAlarm alarms={alarms}>{(n) => <button className="h-timer" onClick={() => setAlarmsOpen(true)}>{n.a.label || 'Alarm'} <b>{ringTime(n.at)}</b></button>}</NextAlarm>
        <nav className="h-tabs" ref={railTabsRef}>
          {tabs.slice(0, railShown).map((t) => { const d = iconOf(t); return <button key={t.id} className={'h-tab' + (t.id === cur && !more ? ' on' : '') + (making(t.id) ? ' making' : '')} onClick={() => { setMore(false); go(t.id); }}><svg className="h-tab-i" viewBox="0 0 256 256" aria-hidden="true">{d && <path d={d} />}</svg>{nameOf(t)}</button>; })}
          {railShown < tabs.length && <button className={'h-tab' + (more || inMore.some((t) => t.id === cur) ? ' on' : '')} onClick={() => setMore(!more)}><svg className="h-tab-i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round"><path d="M5.5 12h.01M12 12h.01M18.5 12h.01" /></svg>More</button>}
        </nav>
        <BatteryLine shell={shell} />
        <div className="h-tools" ref={toolsRef}>
          {/* On the display there's no assistant button (say "Hey Opie" or just type; the shell shows it only while it's
              busy, Overlay.kt). On another screen this page has its own, which opens the asking panel. */}
          {!shell && <button className="h-voice own" onClick={() => onAsk()} aria-label="Ask"><i /><i /><i /><i /></button>}
          {/* Talk (no "Hey Opie" needed), type a question (no keyboard needed), sleep the screen, settings: always here.
              Talk and Type float in these same places over an app (the shell, from railTools). */}
          {shell?.talk && <button className="h-tool" data-tool="talk" onClick={() => shell.talk()} aria-label="Talk to Opie"><Bars /></button>}
          {shell?.type && <button className="h-tool h-type" data-tool="type" onClick={() => shell.type()} aria-label="Type to Opie"><Keys /></button>}
          {shell?.sleep && <button className="h-tool" onClick={() => shell.sleep()} aria-label="Sleep"><Moon /></button>}
          {shell && <button className="h-tool" onClick={() => shell.settings()} aria-label="Settings"><Gear /></button>}
        </div>
      </aside>}
      <main className="h-sheet">
        {tabs.filter((t) => seen.has(t.id) || t.id === cur).map((t) => (
          <section key={t.id} className="h-page" hidden={t.id !== cur}>
            {t.id === 'today' && compact ? <Glance c={c} house={house} weather={weather} timers={timers} tabs={tabs} appBy={appBy} go={go} openApp={openApp} shell={shell} handsFree={homeScreen?.handsFree} onTimer={setTimerOpen} onAsk={onAsk} alarms={alarms} onAlarms={() => setAlarmsOpen(true)} />
              : t.id === 'today' ? <Today c={c} house={house} notes={homeScreen?.notes || []} weather={weather} tabs={tabs} appBy={appBy} go={go} addTo={addTo} openApp={openApp} shell={shell} usePhoto={usePhoto} look={st} appsV={homeScreen?.appsV || {}} boardAt={homeScreen?.whiteboard || 0} />
              : t.id === 'apps' ? <Apps c={c} shell={shell} apps={apps} tabs={tabs} places={homeScreen?.places || {}} cards={st.cards || []} family={house?.family || []} />
              : shell && appBy.get(t.id)?.web !== false ? <AppFrame c={c} shell={shell} app={appBy.get(t.id)} look={st} v={homeScreen?.appsV?.[t.id] || 0} onOpen={openApp} add={addIn?.id === t.id ? addIn.at : 0} addExtra={addIn?.id === t.id ? addIn.extra : ''} />
              : <div className="h-widget"><Widget id={t.id} app={appBy.get(t.id)} w={4} h={4} house={house} c={c} Photo={(p) => <PhotoShow c={c} {...p} />}
                content={homeScreen?.widgets?.content?.[t.id] ? (homeScreen.widgets.content[t.id].shapes?.['4x4'] || homeScreen.widgets.content[t.id].content || '') : null} /></div>}
          </section>
        ))}
        {/* Apps that keep things up to date in the background ("background": true in app.json: a school lunch menu on the
            calendar) run hidden, even when they aren't a tab. */}
        {shell && apps.filter((a) => a.meta?.background && a.web !== false && !tabs.some((t) => t.id === a.id)).map((a) => (
          <section key={'bg-' + a.id} className="h-page" hidden><AppFrame c={c} shell={shell} app={a} look={st} v={homeScreen?.appsV?.[a.id] || 0} onOpen={openApp} /></section>
        ))}
      </main>
      {/* Upright on a phone: the first tabs on a bar along the foot, and More (every tab, and the rail's tools). */}
      {bar && <nav className="h-bar">
        {tabs.slice(0, 4).map((t) => { const d = iconOf(t); return <button key={t.id} className={'h-tab' + (t.id === cur && !more ? ' on' : '') + (making(t.id) ? ' making' : '')} onClick={() => { setMore(false); go(t.id); }}><svg className="h-tab-i" viewBox="0 0 256 256" aria-hidden="true">{d && <path d={d} />}</svg><span>{nameOf(t)}</span></button>; })}
        {tabs.length > 4 && <button className={'h-tab' + (more || tabs.slice(4).some((t) => t.id === cur) ? ' on' : '')} onClick={() => setMore(!more)}><svg className="h-tab-i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round"><path d="M5.5 12h.01M12 12h.01M18.5 12h.01" /></svg><span>More</span></button>}
      </nav>}
      {more && inMore.length > 0 && <div className="h-veil h-more-veil" onClick={() => setMore(false)}>
        <div className="h-more" onClick={(e) => e.stopPropagation()}>
          <nav className="h-tabs">{inMore.map((t) => { const d = iconOf(t); return <button key={t.id} className={'h-tab' + (t.id === cur ? ' on' : '')} onClick={() => { setMore(false); go(t.id); }}><svg className="h-tab-i" viewBox="0 0 256 256" aria-hidden="true">{d && <path d={d} />}</svg>{nameOf(t)}</button>; })}</nav>
          {bar && <BatteryLine shell={shell} />}
          {bar && <div className="h-tools">
            {!shell && <button className="h-voice own" onClick={() => { setMore(false); onAsk(); }} aria-label="Ask"><i /><i /><i /><i /></button>}
            {shell?.talk && <button className="h-tool" onClick={() => { setMore(false); shell.talk(); }} aria-label="Talk to Opie"><Bars /></button>}
            {shell?.type && <button className="h-tool h-type" onClick={() => { setMore(false); shell.type(); }} aria-label="Type to Opie"><Keys /></button>}
            {shell?.sleep && <button className="h-tool" onClick={() => { setMore(false); shell.sleep(); }} aria-label="Sleep"><Moon /></button>}
            {shell && <button className="h-tool" onClick={() => { setMore(false); shell.settings(); }} aria-label="Settings"><Gear /></button>}
          </div>}
        </div>
      </div>}
      {alarmsOpen && <AlarmsSheet c={c} alarms={alarms} family={house?.family || []} onClose={() => setAlarmsOpen(false)} />}
      {(() => { const t = timers.find((x) => x.endAt === timerOpen); return t && (
        <div className="h-veil" onClick={() => setTimerOpen(null)}>
          <div className="h-timer-card" onClick={(e) => e.stopPropagation()}>
            <div className="h-timer-name">{t.label}</div>
            <div className="h-timer-left"><TimeLeft t={t} /></div>
            <div className="h-timer-do">
              <LessMinute t={t} onClick={() => moveTimer(t, -60)} />
              <button onClick={() => moveTimer(t, 60)}>+1 min</button>
              <button onClick={() => moveTimer(t, 300)}>+5 min</button>
            </div>
            <div className="h-timer-do">
              <button className="h-timer-clear" onClick={() => { setTimerOpen(null); c.json('POST', '/home/timer', { cancel: t.endAt }).catch(() => {}); }}>Clear</button>
              <button onClick={() => setTimerOpen(null)}>Done</button>
            </div>
          </div>
        </div>); })()}
    </div>
  );
}

/** The family's photos behind everything, one every 5 minutes, crossfading. */
/**
 * Home on a phone: a glance, in big type. The time and the day, the weather, then only what's on now: cooking, timers,
 * the next thing on the calendar, the shopping list; and asking Opie. Each opens its tab.
 */
function Glance({ c, house, weather, timers, tabs, appBy, go, openApp, shell, handsFree, onTimer, onAsk, alarms = [], onAlarms }) {
  const now = useNow(30e3), d = new Date(now), h = house || {};
  const kinds = new Map(); for (const t of tabs) { const k = kindOf(t, appBy.get(t.id)); if (k && !kinds.has(k)) kinds.set(k, t.id); }
  const open = (kind) => kinds.has(kind) ? () => go(kinds.get(kind)) : undefined;
  const w = weather && !weather.error && Number.isFinite(weather.temp) ? weather : null, wd = w?.days?.[0];
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const next = (h.events || []).filter((e) => (e.allDay ? +dayOf(e) >= +day : Date.parse(e.end || e.start) > now))
    .sort((a, b) => (dayOf(a) - dayOf(b)) || (b.allDay - a.allDay) || (Date.parse(a.start) - Date.parse(b.start)))[0];
  const mins = next && !next.allDay ? Math.round((Date.parse(next.start) - now) / 60e3) : null;
  const nextDay = next && Math.round((dayOf(next) - day) / 864e5);
  const nextLabel = !next ? '' : mins != null && mins <= 0 ? 'Now' : mins != null && mins < 60 ? `Next · in ${mins} min` : nextDay === 0 ? 'Next · today'
    : nextDay === 1 && !smallHours(now) ? 'Tomorrow' : weekday(dayOf(next), true);
  const isPerson = (n) => (h.family || []).some((p) => p.name === n);
  const list = (h.lists || []).find((l) => l.id === 'groceries') || (h.lists || [])[0];
  const items = (list?.items || []).filter((i) => !i.done);
  const cooking = handsFree?.app && appBy.get(handsFree.app);
  return (
    <div className="g">
      <div className="g-head">
        <div className="g-time" role="button" onClick={onAlarms}>{railTime(d, shell?.clock24?.())}</div>
        <div className="g-day">{d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        {w && <button className="g-wx" onClick={open('weather') || (() => shell?.weather?.())}><span className="g-wx-i" dangerouslySetInnerHTML={{ __html: weatherIcon(w.code, w.isDay !== false) }} />
          {[`${w.temp}° ${String(w.condition || '').toLowerCase()}`, Number.isFinite(wd?.high) && `high ${wd.high}°`].filter(Boolean).join(' · ')}</button>}
      </div>
      <div className="g-rows">
        {cooking && <button className="g-row" onClick={() => openApp(cooking.id)}><span className="g-label">Cooking</span><span className="g-big">{cooking.meta?.name || cooking.id}</span></button>}
        {timers.map((t) => <button key={t.endAt} className="g-row g-timer" onClick={() => onTimer(t.endAt)}><span className="g-label">{t.label || 'Timer'}</span><span className="g-big"><TimeLeft t={t} /></span></button>)}
        <NextAlarm alarms={alarms}>{(n) => <button className="g-row" onClick={onAlarms}><span className="g-label">{n.a.label || 'Alarm'}</span><span className="g-big">{ringTime(n.at)}</span></button>}</NextAlarm>
        {next && <button className="g-row" onClick={open('calendar')}><span className="g-label">{nextLabel}</span><span className="g-big">{next.title}</span>
          <span className="g-soft">{[timeOf(next) || 'All day', isPerson(next.who) && next.who].filter(Boolean).join(' · ')}</span></button>}
        {list && items.length > 0 && <button className="g-row" onClick={open('lists')}><span className="g-label">{list.name}</span>
          {items.slice(0, 4).map((i) => <span key={i.id} className="g-item">{i.text}</span>)}{items.length > 4 && <span className="g-soft">{items.length - 4} more</span>}</button>}
      </div>
      {(shell?.type || !shell) && <button className="g-ask" onClick={() => (shell?.type ? shell.type() : onAsk())}><span className="g-ask-i"><Keys /></span>{shell?.wakeOn?.() ? 'Say “Hey Opie”, or tap to type' : 'Ask Opie'}</button>}
    </div>
  );
}

function Backdrop({ c, names, usePhoto }) {
  const now = useNow(300e3);
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
  // The callbacks through refs: they're new on every draw (the clock draws the screen each second), and listening again
  // each time said "not typing" to the shell a second after a field got the keyboard (keys went to Opie, the user).
  const cb = useRef({}); cb.current = { onPhone, onOpen };
  useEffect(() => {
    if (!app || !shell?.ui) return;
    const origin = appOrigin(shell, app);
    let typing = false;
    const on = (e) => {
      if (!frame.current || e.source !== frame.current.contentWindow || e.origin !== origin || !e.data || typeof e.data !== 'object') return;
      const m = e.data;
      if (m.openhouse === 'hello') { if (key) e.source.postMessage({ openhouse: 'key', key }, origin); }
      else if (m.openhouse === 'editing') { typing = !!m.on; shell.editing?.(typing); }
      else if (m.openhouse === 'phone') { if (!app.shared) cb.current.onPhone?.(String(m.kind || ''), String(m.arg || '')); }
      else if (m.openhouse === 'open' && /^[\w.-]{1,60}$/.test(String(m.app || ''))) { if (!app.shared || m.app === app.id) cb.current.onOpen?.(String(m.app)); }
    };
    addEventListener('message', on);
    return () => { removeEventListener('message', on); if (typing) shell.editing?.(false); };
  }, [shell, app?.id, app?.shared, key]);
}

/** One of the family's apps, running in the sheet (its own page and kit, given its key and the look). */
function AppFrame({ c, shell, app, look, v, onOpen, add = 0, addExtra = '' }) {
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
  const hash = lookHash(look, shell, null, app) + (add ? `&add=${add}${addExtra ? '&' + addExtra : ''}` : ''); // add: open its add (a Home card's + Add), or what extra says (a photo)
  return key && <iframe ref={frame} key={shownV + hash} className="h-app" title={app.meta?.name || app.id} sandbox="allow-scripts allow-same-origin allow-forms" src={`${appOrigin(shell, app)}/apps/${app.id}/index.html#${hash}`} />;
}

/** What an app's page is given in its address: the screen's colors and type (the kit takes them). Never its key.
 *  bg is the world its tab sits on, panel the white (or the palette's) its panels are. */
function lookHash(look, shell, paper, app) {
  const p = paletteOf(look);
  return new URLSearchParams({ bg: paper ? paper(p) : worldOf(look, app?.id), panel: p.sheet, ink: p.ink, accent: p.accent, face: look?.type || 'clean', ...(look?.palette === 'dusk' ? { dark: '1' } : {}), ...(shell?.phone && !app?.shared ? { phone: '1' } : {}), ...(compactNow() ? { compact: '1' } : {}) }); // compact: a phone (the kit gives the app its phone layout on its side too)
}
/**
 * An app's own card on Home: its widget.html running in a card like the others ("today": {"size": "small" | "wide"}
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
    {key && <iframe ref={frame} key={shownV + hash} className="t-app-pad" title={app.meta?.name || app.id} sandbox="allow-scripts allow-same-origin allow-forms" src={`${appOrigin(shell, app)}/apps/${app.id}/widget.html?today=${app.today}#${hash}`} />}
  </div>;
}

/** One of the apps' notes on the day (a school lunch, trash day), as a card on Home. With photos of its things (the
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
        <div className="t-nshow"><span>Show</span>{[['week', 'Week and Home'], ['today', 'Home only'], ['off', 'Nowhere']].map(([k, l]) => (
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
  if (d <= 1 && smallHours(now)) return `on ${b.toLocaleDateString('en-US', { weekday: 'long' })}`; // (not "today" or "tomorrow" in the small hours)
  return d <= 0 ? 'today' : d === 1 ? 'tomorrow' : d < 21 ? `in ${d} days` : d < 70 ? `in ${Math.round(d / 7)} weeks` : `in ${Math.round(d / 30)} months`;
}

// ---- Today: the most important bit of each tab, at a glance -------------------------------------------------
// Each card is one tab's excerpt and opens that tab. Only the tabs the family has get a card (a renamed or remade app
// still counts by its name), the most useful first, and they share the screen without scrolling: Calendar down the left
// on a white panel, the others in rows beside it (two to a row, three in the last), each in its own color.
const KINDS = ['calendar', 'weather', 'chores', 'meals', 'lists', 'photos', 'whiteboard', 'recipes'];
/** Which of the starting apps a tab is, by its id or, for one the family remade, its name. */
export function kindOf(t, app) { if (KINDS.includes(t.id)) return t.id; const n = String(t.name || app?.meta?.name || '').toLowerCase(); return KINDS.find((k) => n.includes(k.replace(/s$/, ''))) || null; }
/** Whose world is behind a tab: the starting app it is, else its own id (look.js worldOf). */
const worldTab = (t, appBy) => (t ? kindOf(t, appBy.get(t.id)) || t.id : null);
// Titles from synced calendars can carry emoji ("🤸 Gymnastics"); the home screen draws no emoji as icons, so they go.
const plain = (t) => String(t || '').replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣]/gu, '').replace(/\s+/g, ' ').trim() || t;

/** A box on a Home card that shows as many of its [data-fit] parts as fit, in order (more events, the next days'
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

/** Home's own cards (bridge/home-screen.js TODAY_CARDS): every one there is, the order Opie offers them in. */
export const TODAY_CARDS = ['calendar', 'weather', 'lunch', 'whiteboard', 'recipes', 'meals', 'lists', 'chores', 'notes', 'photos'];
/** The ones a household that never arranged its Home sees, in order (home-screen.js TODAY_DEFAULT, version 2): Dinner
 *  is off (it can be added), the Whiteboard and a recipe to try are on, the list comes after them, smaller. Arranging
 *  saves the whole list in style.json, so a new default never moves a household's own. An app's card goes before the photos. */
export const TODAY_DEFAULT = ['calendar', 'weather', 'lunch', 'whiteboard', 'recipes', 'chores', 'photos', 'lists', 'notes'];
export const TODAY_NAMES = { calendar: 'Calendar', weather: 'Weather', lunch: 'App notes with a photo', whiteboard: 'Whiteboard', recipes: 'A recipe to try', meals: 'Dinner', lists: 'Groceries', chores: 'Chores', notes: 'Notes', photos: 'Photos' };
/** The cards Today shows, in order: the look's choice (look.today), with the apps' cards that are on (look.cards). */
export function todayOrder(look) {
  const apps = (look?.cards || []).map((id) => 'app:' + id);
  if (!Array.isArray(look?.today)) { const d = [...TODAY_DEFAULT]; d.splice(d.indexOf('photos'), 0, ...apps); return d; }
  const list = look.today.filter((k) => !k.startsWith('app:') || apps.includes(k));
  return [...list, ...apps.filter((k) => !list.includes(k))];
}
const weekday = (d, long) => d.toLocaleDateString('en-US', { weekday: long ? 'long' : 'short' });

/** The Weather card: its size (one cell, two rows tall, or wide) from its own box; drawn again every few minutes, not
 *  every second, so the sky's slow drift isn't restarted. */
function WeatherCard({ w, now, dim, className, ...rest }) {
  const ref = useRef(null), [size, setSize] = useState('cell');
  useEffect(() => {
    const el = ref.current; if (!el) return;
    // Where its height comes from its own content (a phone's Today, one card under another), a layout changes the
    // height that chose it, and it flipped back and forth many times a second (the user: the screen shook). So a size
    // that would undo the last change within two seconds isn't taken: it stays put.
    // Wide needs room for its two columns too: a page can say how wide that is (--wide-from, px; the phone's Today does,
    // where a card the width of the screen is still too narrow for it).
    let last = 'cell', prev = null, at = 0;
    const from = parseFloat(getComputedStyle(el).getPropertyValue('--wide-from')) || 0;
    const o = new ResizeObserver(() => {
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
      const next = r.width > r.height * 1.45 && r.width >= from ? 'wide' : r.height > r.width * 1.45 ? 'tall' : 'cell';
      if (next === last) return;
      if (next === prev && Date.now() - at < 2000) return;
      prev = last; last = next; at = Date.now(); setSize(next);
    });
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
/** A dish's picture: its recipe's own (kept from its page), else the mark of its kind of dish on a warm tint, as in
 *  Recipes and Meals (/kit/dish-look.js). */
function DishPic({ house, name }) {
  const [bad, setBad] = useState(false);
  const r = house?.recipes?.[String(name || '').trim().toLowerCase()], src = r?.image;
  return src && !bad ? <img className="t-dish" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} onError={() => setBad(true)} />
    : <span className="t-dish letter" style={{ '--c': dishTint(name) }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: dishMark(dishOf(r?.cook)) }} />;
}
const Check = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;

/** Today (also on someone's phone, phone.jsx, in one column). */
/** Today's card while Opie's voice can't answer, by why (house view().voice): its line and its button. */
const VOICE_NEED = {
  no_key: ['Talk to Opie with an OpenAI key', 'Add a key'],
  own_key_refused: ['OpenAI stopped accepting your key', 'Add a new key'],
  own_key_limit: ['Your OpenAI account is out of credit', 'Your key'],
  own_stop: ["This month's spending stop is reached", 'Change the stop'],
  gemini_key_refused: ['Google stopped accepting your Gemini key', 'Add a new key'],
  gemini_key_limit: ['Your Gemini project is over its limit', 'Your key'],
  gemini_key_billing: ['Your Gemini project needs billing turned on', 'Your key'],
  gemini_no_key: ['The Gemini key is gone from this device', 'Add a key'],
  gemini_stop: ["This month's Gemini spending stop is reached", 'Change the stop'],
};

export function Today({ c, house, now: given, notes, weather, tabs, appBy, go, addTo = go, openApp, shell, usePhoto, look, appsV, boardAt = 0 }) {
  // The time: the phone's own (phone.jsx), else the page's, drawn again each minute (not each second: Today is big).
  const clockNow = useNow(60e3), now = given ?? clockNow;
  const spotifyOn = useSpotifyOn(); // (Spotify's own player, over its slot: spotify-player.jsx)
  const h = house || {};
  const kinds = new Map(); for (const t of tabs) { const k = kindOf(t, appBy.get(t.id)); if (k && !kinds.has(k)) kinds.set(k, t.id); }
  const t = new Date(now); t.setHours(0, 0, 0, 0);
  // whose an event is: a small dot in their color; nothing for the household's own (no icon on every row)
  const EvDot = ({ e }) => { const p = eventPaint(h, e); return <i className={'t-dot' + (p ? '' : ' none')} style={p ? { background: p } : undefined} />; };
  const card = (kind, open) => ({ role: 'button', tabIndex: 0, className: 't-card t-' + kind, onClick: open || (() => go(kinds.get(kind))) });

  // Calendar, as a schedule under its label: each day from today with its events, as many as fit in the column (three
  // weeks at most); under it, the things on Home.
  const tomorrow = new Date(+t + 864e5), weekOut = new Date(+t + 21 * 864e5), AGENDA = 30; // (as many as fit fill the column: t-fit)
  // An all-day thing over several days (a school break) is on each of its days, from today.
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const spread = (h.events || []).flatMap((e) => {
    if (!e.allDay || e.date || !e.end) return [e];
    const out = [], end = new Date(e.end);
    for (let d = dayOf(e); d < end && out.length < 31; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) out.push({ ...e, date: key(d) });
    return out.length > 1 ? out.map((x, i) => ({ ...x, part: `Day ${i + 1}/${out.length}` })) : out.length ? out : [e];
  });
  const upcoming = spread.filter((e) => (e.allDay ? dayOf(e) >= t : new Date(e.end || e.start) >= now) && dayOf(e) < weekOut)
    .sort((a, b) => (dayOf(a) - dayOf(b)) || (b.allDay - a.allDay) || (new Date(a.start) - new Date(b.start)));
  const byDay = []; for (const e of upcoming) { const d = dayOf(e); if (+byDay.at(-1)?.[0] !== +d) byDay.push([d, []]); byDay.at(-1)[1].push(e); }
  const first = upcoming[0], firstDay = first && dayOf(first);
  const small = smallHours(now); // (midnight to 4: the weekday's name, not Today or Tomorrow)
  const dayName = (d) => (!small && +d === +t ? 'Today' : !small && +d === +tomorrow ? 'Tomorrow' : d - t < 7 * 864e5 ? weekday(d, true) : d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }));
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
  const [refused, setRefused] = useState(null); // why the tablet didn't add it (the list is full), for a moment
  const add = () => { const t = String(adding || '').trim(); setAdding(null); if (t) c.json('POST', '/house/list', { list: list.name, add: [t] }).then((r) => { if (r?.json?.error) setRefused(r.json.error); }).catch(() => {}); };
  useEffect(() => { if (!refused) return; const x = setTimeout(() => setRefused(null), 8000); return () => clearTimeout(x); }, [refused]);
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
  const photos = h.screensaver || h.photos || []; // the sleep screen's photos (its albums' choice), none when they're all off

  const cards = []; // (each pushed with its key; put in the household's order and choice below: TODAY_CARDS)
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
        <span className="t-when">{+d === +tomorrow && !small ? 'Tomorrow' : weekday(d)}</span><span className="h-grow">{dinner(d)}</span>
      </div>)}</div>}
    </div>}
  </div>);
  // The list: what's left to get, one column that scrolls (the user: not two columns at this width).
  if (kinds.has('lists') && list) cards.push(<div key="lists" {...card('lists')}>
    <div className="t-top"><div className="h-label">{list.name}</div><span className="t-n t-add" role="button" onClick={(e) => { e.stopPropagation(); setAdding(''); }}>+ Add</span></div>
    {items.length || ticked ? <div className="t-items one scrolls">{items.map((i) => (
      <div key={i.id} className="t-item"><span className="t-box" role="button" aria-label={'Got ' + i.text} onClick={(e) => tick(e, i)} /><span className="h-grow">{i.text}</span></div>
    ))}</div>
      : <div className="t-invite"><div className="t-line">Nothing to get</div><div className="t-soft">Add things as you run out</div></div>}
    {ticked && <span className="t-undo" role="button" onClick={untick}>Got {ticked.text} · Put it back</span>}
    {refused && !ticked && <span className="t-undo">{refused}</span>}
    {/* On an iPhone a tap on a button first closes the keyboard, the sheet moves, and the tap lands on the veil (closing
        it, nothing added): the buttons keep the field's focus (no keyboard closing under the finger), and the veil
        closes only for a tap that started on it. */}
    {adding !== null && <div className="h-veil" onPointerDown={(e) => { e.currentTarget.dataset.down = e.target === e.currentTarget ? '1' : ''; }} onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget && e.currentTarget.dataset.down === '1') setAdding(null); }}>
      <form className="h-note-full t-addsheet" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); add(); }}>
        <h2>Add to {list.name}</h2>
        <input autoFocus value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Milk" aria-label={'Add to ' + list.name} />
        <div className="t-nacts"><button type="button" className="h-chip" onPointerDown={(e) => e.preventDefault()} onClick={() => setAdding(null)}>Cancel</button><button type="submit" className="h-chip on" onPointerDown={(e) => e.preventDefault()}>Add</button></div>
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
  // The Whiteboard: what's drawn on it, small and live; blank, its paper and what it's for. A tap opens it.
  if (kinds.has('whiteboard')) cards.push(<BoardCard key="whiteboard" c={c} at={boardAt} {...card('whiteboard')} />);
  // A recipe to try (tonight's when dinner has one in the box), a tap opening it in Recipes.
  if (kinds.has('recipes')) cards.push(<RecipeCard key="recipes" house={h} t={t} dinner={dinner} tonight={tonight} {...card('recipes')}
    onOpen={(k) => addTo(kinds.get('recipes'), k ? 'recipe=' + encodeURIComponent(k) : '')} />);
  // The apps' own cards the household turned on, in their order, before the notes and the photo (wide: a row of its own).
  if (notes.length) cards.push(<NotesCard key="notes" c={c} notes={notes} reminders={[]} />); // (reminders due are things on Home)
  if (shell?.ui) for (const id of look?.cards || []) { const a = appBy.get(id); if (a?.today) cards.push(<AppCard key={'app:' + id} c={c} shell={shell} app={a} look={look} v={appsV[id] || 0} openApp={openApp} wide={a.today === 'wide'} />); }
  // No photos yet: the card's frames, empty, and the ways in (Photos' Add photos).
  if (kinds.has('photos') && !(h.photos || []).length) cards.push(<div key="photos" {...card('photos', () => addTo(kinds.get('photos'), 'do=add'))} className="t-card t-photos-none">
    <div className="h-label">Photos</div>
    <Frames />
    <div className="t-invite"><div className="t-big">Add your photos</div><div className="t-soft">From a phone, or an iCloud shared album</div></div>
  </div>);
  else if (kinds.has('photos') && photos.length) cards.push(<PhotoCard key="photos" c={c} names={photos} captions={h.captions} now={now} usePhoto={usePhoto} {...card('photos')} onOpen={(name) => addTo(kinds.get('photos'), 'photo=' + encodeURIComponent(name))} />);
  // Laid out in rows, three at most: two to a row beside the calendar (three without it), a wide card a row of its own;
  // the last row takes one more, so seven cards share the screen as two, two and three.
  // Which of them show, in what order: the household's choice in the look panel (look.today), else all, as usual. An
  // app's card is on when look.cards has it (Apps can add one); look.today only places it.
  { const byKey = new Map(cards.map((x) => [String(x.key), x]));
    const order = todayOrder(look);
    cards.length = 0; for (const k of order) if (k !== 'calendar' && byKey.has(k)) cards.push(byKey.get(k)); }
  // Events read from a flyer or an email, waiting for a yes on the Calendar: first, whatever the household's order (it
  // goes once they're added or put away), so nobody misses them. A tap opens the Calendar, where they're added.
  const waiting = h.flyer?.state === 'done' ? h.flyer.events || [] : [];
  if (waiting.length) {
    const from = waiting.find((e) => e.from)?.from, n = waiting.length;
    const when = (e) => { const d = new Date(e.allDay ? e.start + 'T12:00' : e.start); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };
    cards.unshift(<div key="waiting" {...card('waiting', () => go(kinds.get('calendar') || 'calendar'))}>
      <div className="h-label">To add to the calendar</div>
      <div className="t-big">{n === 1 ? '1 event' : `${n} events`}{from ? ` from ${from}` : ''}</div>
      <div className="t-rows t-gap-s">{waiting.slice(0, 3).map((e, i) => <div key={i} className="t-row"><span className="t-when">{when(e)}</span><span className="h-grow">{plain(e.title)}</span></div>)}</div>
    </div>);
  }
  // Opie's voice can't answer here (cloud.js voiceNeed): no account and no key, or the household's own key in trouble.
  // First, on the device only (the key goes in there: OwnKey.kt), until it can; the button opens the key's own screen.
  const need = shell?.ownKey && VOICE_NEED[h.voice];
  if (need) cards.unshift(<div key="voice" {...card('voice', () => shell.ownKey(h.voice))}>
    <div className="h-label">Opie's voice</div>
    <div className="t-big">{need[0]}</div>
    <div className="t-nacts"><span role="button" className="h-chip">{need[1]}</span></div>
  </div>);
  const showCal = kinds.has('calendar') && todayOrder(look).includes('calendar');
  const per = showCal ? 2 : 3, rows = [];
  { let cur = null; for (const x of cards) { if (x.props.wide) { rows.push([x]); cur = null; } else { if (!cur || cur.length >= per) rows.push(cur = []); cur.push(x); } } }
  if (rows.length > 3 && rows[2].length === per && !rows[2][0].props.wide && !rows[3][0].props.wide) rows[2].push(rows[3][0]);
  // the list alone in the last row (a new Home's) joins the row before it, three at most; anything else alone keeps a
  // row of its own (a photo is best wide, not a sliver beside two full-height cards)
  { const last = rows.at(-1), prev = rows.at(-2); if (rows.length > 1 && rows.length <= 3 && last.length === 1 && last[0].key === 'lists' && !last[0].props.wide && prev.length < 3 && !prev[0].props.wide) prev.push(rows.pop()[0]); }
  rows.length = Math.min(rows.length, 3);
  // the weather is never a tall column (the user): in one full-height row with others, it gets a row of its own above them
  if (rows.length === 1 && rows[0].length > 1) { const w = rows[0].find((x) => x.key === 'weather'); if (w) rows.splice(0, 1, [w], rows[0].filter((x) => x !== w)); }
  const tall = rows.length === 3 ? [346, 296, 242] : [1, 1, 1];
  // how wide each is beside the others: the list a narrow column (the user: it shouldn't take up as much space)
  const wide = (x) => (x.key === 'photos' ? 1.5 : x.key === 'whiteboard' ? 1.4 : x.key === 'notes' || x.key === 'lists' ? 1 : 1.25);

  return (
    <div className="h-today">
      {!showCal && <Things c={c} things={h.things} className="t-things t-things-head" go={go} tabs={tabs} ask={shell?.ask} />}
      {!showCal && spotifyOn && <SpotifySlot />}
      {!showCal && shell?.media && <NowPlaying shell={shell} />}
      <div className={'t-grid' + (showCal ? ' with-cal' : '')}>
        {showCal && <div className="t-calcol">
        <div {...card('calendar')}>
          <div className="t-top t-cal-label"><div className="h-label">Calendar</div><span className="t-n t-add" role="button" onClick={(e) => { e.stopPropagation(); addTo(kinds.get('calendar')); }}>+ Add</span></div>
          {first ? <>
            <div className="t-agenda t-fit" ref={calFit}>{!todays.length && <div className="t-daygroup t-sday"><div className="t-sdate" data-fit="label"><small>{small ? weekday(t, true).slice(0, 3) : 'Today'}</small><b>{t.getDate()}</b></div><div className="t-sthings"><div className="t-snone" data-fit="">Nothing today</div></div></div>}
              {(() => { let left = AGENDA; return byDay.map(([d, l], k) => { // each day from now, AGENDA events at most
              const rest = l.slice(0, Math.max(0, left)); left -= rest.length; // (the first one like the rest: no big card of its own)
              // as a schedule: the day's weekday and date in a column, its things beside them (all-day ones as slim
              // pills, the others as soft blocks tinted with their person's color, the time under the title)
              const tintOf = (e) => { const c = eventPeople(h, e).map((n) => personColor(h, n))[0] || e.color; return c ? { background: `color-mix(in srgb, ${c} 24%, var(--h-sheet))` } : undefined; };
              return rest.length > 0 && <div key={+d} className="t-daygroup t-sday">
                <div className="t-sdate" data-fit="label"><small>{+d === +t && !small ? 'Today' : weekday(d, true).slice(0, 3)}</small><b>{d.getDate()}</b></div>
                <div className="t-sthings">{rest.map((e, i) => e.allDay
                  ? <div key={i} className="t-spill" data-fit="" style={tintOf(e)}>{plain(e.title)}{e.part ? ` (${e.part})` : ''}</div>
                  : <div key={i} className="t-sev" data-fit="" style={tintOf(e)}><span className="t-sev-t">{plain(e.title)}</span><span className="t-when">{when(e)}</span></div>)}</div>
              </div>;
            }); })()}</div>
          </> : !h.calendars && !(h.events || []).length ? <div className="t-agenda t-invite-cal">
            {/* no calendar yet: the days it will fill, and the way to add one (Calendar's Add a calendar) */}
            {[0, 1, 2, 3, 4, 5, 6].map((n) => { const d = new Date(+t + n * 864e5); return <div key={n} className={'t-daygroup t-sday' + (n ? ' t-later' : '')} style={n ? { opacity: Math.max(0.15, 0.7 - n * 0.1) } : undefined}>
              <div className="t-sdate"><small>{!n && !small ? 'Today' : weekday(d, true).slice(0, 3)}</small><b>{d.getDate()}</b></div>
              <div className="t-sthings">{n ? <>{n % 3 !== 2 && <div className="t-snone t-ghost" />}<div className="t-snone t-ghost short" /></>
                : <div className="t-snone t-ask" role="button" onClick={(e) => { e.stopPropagation(); addTo(kinds.get('calendar'), 'do=link'); }}><b>Add a shared calendar</b><span>Google, iCloud or Outlook: its events show here</span></div>}</div>
            </div>; })}
          </div> : <div className="t-empty"><div className="t-big t-quiet">Nothing coming up</div></div>}
          <Things c={c} things={h.things} go={go} tabs={tabs} ask={shell?.ask} />
        </div>
        {/* the day's other notes from the apps, the next thing under its events */}
        {dayNotes.filter((n) => n !== pictured).map((n, i) => <DayNote key={n.app + i} c={c} house={h} n={n} day={notesDay} openApp={openApp} />)}
        {spotifyOn && <SpotifySlot />}
        {shell?.media && <NowPlaying shell={shell} />}
        </div>}
        <div className="t-side">{rows.map((r, i) => <div key={i} className="t-siderow" style={{ flexGrow: tall[i], maxHeight: rows.length > 1 && r.some((x) => x.key === 'weather') ? '50%' : undefined, gridTemplateColumns: r.map((x) => `minmax(0, ${wide(x)}fr)`).join(' ') }}>{r}</div>)}</div>
      </div>
    </div>
  );
}

/** Now playing (Media.kt forHome): what a media app on the tablet plays, while it plays and for a few minutes after it's
 *  paused, with its cover and buttons; a tap opens the app, its x closes it until something else plays (or the paused
 *  one plays again). Asked every few seconds while Home is up. While the tablet can't see the apps (Advanced → Now
 *  playing off) and something plays, it offers to turn that on, once: closed, it doesn't ask again. The app's titles
 *  are shown as text. */
const PAUSED_FOR = 5 * 60e3;
const isOn = (n) => n?.state === 'playing' || n?.state === 'starting';
const CLOSED = 'openhouse.nowplaying.closed', OFFER = 'openhouse.nowplaying.offer';
function NowPlaying({ shell }) {
  const [r, setR] = useState(null), seen = useRef({}); // when each song was last seen playing here (app|title)
  const [closed, setClosed] = useState(() => { try { return JSON.parse(store.get(CLOSED) || 'null'); } catch { return null; } });
  const [offerGone, setOfferGone] = useState(() => !!store.get(OFFER));
  const keyOf = (n) => (n?.pkg || n?.app) + '|' + (n?.title || '');
  const ask = () => { const x = shell.media('status') || {}; if (isOn(x.now)) seen.current[keyOf(x.now)] = Date.now(); setR(x); };
  useEffect(() => { ask(); const t = setInterval(() => { if (!document.hidden) ask(); }, 4000); return () => clearInterval(t); }, []);
  const now = r?.now && (r.now.title || r.now.app) && !r.now.embed ? r.now : null; // (Spotify's own player shows itself: SpotifySlot)
  const stop = (e) => e.stopPropagation();
  if (!now) {
    if (!r || r.sees !== false || !r.anyPlaying || offerGone) return null;
    const close = (e) => { stop(e); setOfferGone(true); store.set(OFFER, '1'); };
    return <div role="button" tabIndex={0} className="t-card t-now" onClick={() => shell.media('setup')}>
      <span className="t-now-art none"><Note /></span>
      <div className="t-now-text"><div className="h-label">Now playing</div><div className="t-now-title">Show what's playing</div><div className="t-soft">One switch, with the PIN</div></div>
      <div className="t-now-btns"><span role="button" className="t-now-go" onClick={(e) => { stop(e); shell.media('setup'); }}>Turn on</span><span role="button" aria-label="Close" onClick={close}><Cross /></span></div>
    </div>;
  }
  const on = isOn(now), key = keyOf(now);
  // Paused: only what was playing here a little while ago, not an old song another app still holds paused.
  if (!on && (now.state !== 'paused' || Date.now() - (seen.current[key] || 0) > PAUSED_FOR)) return null;
  if (closed?.key === key && !(closed.paused && on)) return null; // (closed while paused, it's back once it plays again)
  const tap = (e, what) => { stop(e); shell.media(what); if (what === 'play') seen.current[key] = Date.now();
    if (what === 'play' || what === 'pause') setR({ ...r, now: { ...now, state: what === 'play' ? 'playing' : 'paused' } }); setTimeout(ask, 700); setTimeout(ask, 2000); };
  const close = (e) => { stop(e); const c = { key, paused: !on }; setClosed(c); store.set(CLOSED, JSON.stringify(c)); };
  const at = now.lengthS > 0 && now.positionS != null ? Math.min(100, (100 * now.positionS) / now.lengthS) : null;
  return <div role="button" tabIndex={0} className="t-card t-now" onClick={() => now.pkg && shell.openApp('android:' + now.pkg)}>
    {now.art ? <img className="t-now-art" src={now.art} alt="" draggable={false} /> : <span className="t-now-art none"><Note /></span>}
    <div className="t-now-text">
      <div className="h-label">{now.app}{now.elsewhere ? ' · on another device' : ''}</div>
      <div className="t-now-title">{now.title || now.app}</div>
      {now.artist && <div className="t-soft">{now.artist}</div>}
    </div>
    <div className="t-now-btns">
      <span role="button" aria-label="Back" onClick={(e) => tap(e, 'previous')}><Skip back /></span>
      <span role="button" className="main" aria-label={on ? 'Pause' : 'Play'} onClick={(e) => tap(e, on ? 'pause' : 'play')}>{on ? <PauseIcon /> : <PlayIcon />}</span>
      <span role="button" aria-label="Next" onClick={(e) => tap(e, 'next')}><Skip /></span>
      <span role="button" className="t-now-close" aria-label="Close" onClick={close}><Cross /></span>
    </div>
    {at != null && <i className="t-now-bar" style={{ width: at + '%' }} />}
  </div>;
}
const PlayIcon = () => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>;
const PauseIcon = () => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></svg>;
const Skip = ({ back }) => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" style={back ? { transform: 'scaleX(-1)' } : undefined}><path d="M5 6v12l9-6z" /><rect x="15.5" y="6" width="3" height="12" rx="1" /></svg>;
const Note = () => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></svg>;

/** The things on Home (the bridge's things.js): a reminder due, a suggestion, a countdown, a broken app; one line
 *  each, at most three, most urgent first, each gone once it no longer matters. A tap does what it's about: its tab
 *  (go), or asks Opie (ask), or for an app made here waiting to be kept (build), opens it to try again; its x
 *  takes it down. */
export function Things({ c, things, className = 't-things', go, tabs, ask }) {
  const [gone, setGone] = useState(() => new Set());
  const shown = (things || []).filter((x) => !gone.has(x.id));
  if (!shown.length) return null;
  const down = (e, x) => { e.stopPropagation(); setGone(new Set([...gone, x.id])); c.json('POST', '/house/thing', { take: x.id }).catch(() => {}); };
  const act = (x) => (x.build ? () => c.json('POST', '/build/open', { id: x.build }).catch(() => {})
    : x.open && go && tabs?.some((t) => t.id === x.open) ? () => go(x.open) : x.ask && ask ? () => ask(x.ask) : null);
  return <div className={className}>{shown.map((x) => {
    const f = act(x);
    return <div key={x.id} role={f ? 'button' : undefined} className={'t-thing t-' + x.kind + (f ? ' t-acts' : '')} onClick={(e) => { e.stopPropagation(); f?.(); }}>
      <span className="h-grow">{x.text}</span>
      <span className="t-x" role="button" aria-label="Take down" onClick={(e) => down(e, x)}>×</span>
    </div>;
  })}</div>;
}

/** The Whiteboard on Home: what's drawn on it (the picture the Whiteboard app keeps for Home, GET /home/whiteboard),
 *  on its own dotted paper, read again whenever it changes (at). Blank, the paper with a pen's line and what it's for. */
function BoardCard({ c, at, ...rest }) {
  const [b, setB] = useState(null);
  useEffect(() => {
    let off = false;
    c.json('GET', '/home/whiteboard').then((r) => { if (!off && r.status === 200 && r.json) setB(r.json); }).catch(() => {});
    return () => { off = true; };
  }, [c, at]);
  return <div {...rest} className={rest.className + (b?.img ? '' : ' blank')}>
    <div className="h-label">Whiteboard</div>
    {b?.img ? <img className="t-board-img" src={b.img} alt="" draggable={false} />
      : <div className="t-board-empty">
        <svg className="t-scribble" viewBox="0 0 220 70" aria-hidden="true"><path d="M8 48c14-22 26-30 34-24s-6 26 4 28 20-34 34-36 4 30 16 31 18-26 30-27 6 22 16 22 16-14 26-20" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <div className="t-line">Leave a note, a drawing, a list</div><div className="t-soft">Everyone sees it here</div></div>}
  </div>;
}

/** A recipe from the box to try: tonight's dinner when it has one, else one ready to cook, a new one each day (not one
 *  they had this past week). With a picture of its own, it's on it; without, its time and what it needs. */
function RecipeCard({ house: h, t, dinner, tonight, onOpen, ...rest }) {
  const ready = Object.entries(h.recipes || {}).filter(([, r]) => r?.cook?.steps?.length).sort((a, b) => a[0].localeCompare(b[0]));
  const tk = String(tonight || '').trim().toLowerCase();
  let key = ready.some(([k]) => k === tk) ? tk : null;
  if (!key && ready.length) {
    const had = new Set(); for (let n = 1; n <= 7; n++) { const v = dinner(new Date(+t - n * 864e5)); if (v) had.add(v.trim().toLowerCase()); }
    const fresh = ready.filter(([k, r]) => !had.has(k) && !had.has(String(r.cook.name || '').toLowerCase()));
    const from = fresh.length ? fresh : ready;
    key = from[Math.round(+t / 864e5) % from.length][0];
  }
  if (!key) return <div {...rest} onClick={() => onOpen(null)}>
    <div className="h-label">Recipes</div>
    <div className="t-invite"><div className="t-big">Find something to cook</div><div className="t-soft">Search the web, or add your own</div></div>
  </div>;
  return <RecipeShown key={key} k={key} r={h.recipes[key]} tonight={key === tk} onOpen={onOpen} {...rest} />;
}
function RecipeShown({ k: key, r, tonight, onOpen, ...rest }) {
  const ck = r.cook, [bad, setBad] = useState(false), fit = useFit();
  const pic = r.image && !bad;
  const time = ck.minutes ? (ck.minutes < 60 ? `${ck.minutes} min` : `${Math.floor(ck.minutes / 60)} hr${ck.minutes % 60 ? ` ${ck.minutes % 60} min` : ''}`) : null;
  const serves = /^\d+(\s*(-|–|to)\s*\d+)?$/.test(String(ck.serves || '').trim()) ? `serves ${String(ck.serves).trim()}` : String(ck.serves || '').trim().toLowerCase();
  return <div {...rest} onClick={() => onOpen(key)} className={rest.className + (pic ? ' t-pic-card' : '')}>
    {pic && <img className="t-cover" src={r.image} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} onError={() => setBad(true)} />}
    <div className="h-label">{tonight ? 'Tonight' : 'A recipe to try'}</div>
    <div className="t-big">{ck.name || r.text}</div>
    <div className="t-facts">{time && <b>{time}</b>}{[serves, `${ck.steps.length} steps`].filter(Boolean).map((x) => <span key={x}>{x}</span>)}</div>
    {!pic && <div className="t-fit t-needs" ref={fit}>{ck.ingredients.filter((i) => !i.part).slice(0, 8).map((i, n) => <div key={n} className="t-row" data-fit=""><span className="h-grow">{i.item}</span><span className="t-when">{i.amount}</span></div>)}</div>}
  </div>;
}

/** Three empty photo frames, a little askew: where the household's photos will be. */
const Frames = () => <svg className="t-frames" viewBox="0 0 300 150" aria-hidden="true">
  <g fill="var(--h-sheet)" stroke="currentColor" strokeWidth="2.5"><rect x="22" y="30" width="96" height="104" rx="8" transform="rotate(-7 70 82)" /><rect x="182" y="26" width="96" height="104" rx="8" transform="rotate(6 230 78)" /><rect x="100" y="14" width="100" height="110" rx="8" /></g>
  <g fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="128" cy="44" r="8" /><path d="M110 104l24-26 18 18 12-12 26 20" /></g>
</svg>;

/**
 * A sideways swipe across photos: [step] gets 1 (to the next) or -1 (back). The tap that ends a swipe doesn't open the
 * photo. Up and down are left to the page (touch-action: pan-y).
 */
export function usePhotoSwipe(step, { onTap } = {}) {
  const at = useRef(null), swiped = useRef(false);
  return {
    style: { touchAction: 'pan-y' },
    onPointerDown: (e) => { at.current = [e.clientX, e.clientY]; swiped.current = false; },
    onPointerUp: (e) => {
      const a = at.current; at.current = null; if (!a) return;
      const dx = e.clientX - a[0], dy = e.clientY - a[1];
      if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) { swiped.current = true; step(dx < 0 ? 1 : -1); }
      else onTap?.();
    },
    onPointerCancel: () => { at.current = null; onTap?.(); },
    onClickCapture: (e) => { if (swiped.current) { swiped.current = false; e.stopPropagation(); e.preventDefault(); } },
  };
}
export const wrap = (i, n) => ((i % n) + n) % n;

/** A photo of theirs, a new one every minute, with its caption if it has one, opening Photos; a swipe moves along. */
function PhotoCard({ c, names, captions, now, usePhoto, onOpen, ...rest }) {
  // A wide card shows a few photos side by side, each about as wide as it is tall, so none is cut to a strip (the
  // user); a card near square shows one. They move on each minute.
  const box = useRef(null), [n, setN] = useState(1);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const o = new ResizeObserver(() => { const r = el.getBoundingClientRect(); if (r.width && r.height) setN(Math.max(1, Math.min(5, Math.round(r.width / r.height / 0.85)))); });
    o.observe(el); return () => o.disconnect();
  }, []);
  const [off, setOff] = useState(0), swipe = usePhotoSwipe((d) => setOff((o) => o + d));
  const k = Math.min(n, names.length), at = (Math.floor(now / 60e3) + off) * k;
  const shown = Array.from({ length: k }, (_, i) => names[wrap(at + i, names.length)]);
  const cap = k === 1 ? captions?.[shown[0]] : null;
  return <div ref={box} {...rest} {...swipe} style={{ ...rest.style, ...swipe.style }} onClick={onOpen ? () => onOpen(shown[0]) : rest.onClick} className={rest.className + ' t-photo t-pic-card' + (k > 1 ? ' t-photos' : '')}>{/* a tap opens a photo in Photos */}
    {k > 1 ? shown.map((name) => <PhotoTile key={name} c={c} name={name} usePhoto={usePhoto} onOpen={onOpen} />) : shown[0] && <PhotoTile c={c} name={shown[0]} usePhoto={usePhoto} onOpen={onOpen} />}
    {cap && <div className="t-cap"><div className="t-line">{cap}</div></div>}</div>;
}
function PhotoTile({ c, name, usePhoto, onOpen }) {
  const src = usePhoto(c, name);
  // A video plays over its still, silently and on a loop (the user); where it can't play (a phone), its still with a play mark.
  const clip = /\.(mp4|mov|m4v)$/i.test(name || '');
  const url = useClipUrl(c, clip ? name : null);
  return <div className="t-tile" onClick={onOpen ? (e) => { e.stopPropagation(); onOpen(name); } : undefined}>{src && <img className="t-cover" src={src} alt="" draggable={false} />}
    {url ? <Clip className="t-cover" url={url} /> : src && clip && <span className="t-vid" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l10.5-6.5z" /></svg></span>}</div>;
}
/** Where a video in Photos plays from, on the tablet (the bridge's signed address, the page's own origin); null elsewhere. */
export function useClipUrl(c, name) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    setUrl(null);
    if (!name || !globalThis.OpenhouseDisplay) return;
    let stop = false;
    c.json('GET', '/house/photo/' + encodeURIComponent(name) + '?play=1').then((r) => { if (!stop && r?.json?.url) setUrl(r.json.url); }).catch(() => {});
    return () => { stop = true; };
  }, [name]);
  return url;
}
/** A video playing silently on a loop, out of sight until its first frame (so no player chrome ever shows). */
export function Clip({ url, className }) {
  const [on, setOn] = useState(false);
  return <video className={className + ' h-clip' + (on ? ' on' : '')} src={url} muted autoPlay loop playsInline preload="auto" disablePictureInPicture onPlaying={() => setOn(true)} ref={(v) => { if (v) v.muted = true; }} />;
}

// ---- Notes: what the assistant put up for them, and reminders due now ------------------------------------------------
/** The note's words without its layout: a line to show under its title. */
const gist = (content) => String(content || '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/[#*_>`|-]+/g, ' ').replace(/\s+/g, ' ').trim();
function NotesCard({ c, notes, reminders, style }) {
  const [open, setOpen] = useState(null), [gone, setGone] = useState(() => new Set());
  // Newest first (the bridge set aside the ones the assistant kept current for the old board).
  const shown = notes.filter((n) => !gone.has(n.id)).reverse().sort((a, b) => (b.at || 0) - (a.at || 0));
  const note = open && notes.find((n) => n.id === open);
  const down = (n) => { setOpen(null); setGone(new Set([...gone, n.id])); c.json('POST', '/home/remove', { id: n.id }).catch(() => {}); };
  const room = Math.max(0, 3 - reminders.length);
  // The newest large, as a note on yellow; the next ones small under it.
  return <div className="t-card t-notes" style={style}>
    <div className="h-label">{reminders.length && !shown.length ? 'Now' : shown.length > 1 ? 'Notes' : 'Note'}</div>
    <div className="t-rows">
      {reminders.slice(0, 3).map((r) => <div key={r.key} className="t-row t-due"><span className="t-when">{timeOf(r)}</span><span className="h-grow">{plain(r.title)}</span></div>)}
      {shown.slice(0, room).map((n, i) => (
        <div key={n.id} role="button" className={'t-note' + (i ? '' : ' first')} onClick={(e) => { e.stopPropagation(); setOpen(n.id); c.json('POST', '/home/touch', { id: n.id }).catch(() => {}); }}>
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
function Apps({ c, shell, apps, tabs, places, cards, family }) {
  const android = useMemo(() => { try { return shell?.androidApps ? JSON.parse(shell.androidApps() || '[]') : []; } catch { return []; } }, [apps]);
  const [hid, setHid] = useState({}); // shown at once, until the home screen has it
  const [menu, setMenu] = useState(null);
  const inTabs = new Set(tabs.map((t) => t.id));
  const all = [...apps.filter((a) => a.id !== 'home' && !inTabs.has(a.id)).map((a) => ({ id: a.id, name: a.meta?.name || a.id, about: a.meta?.description || '', svg: a.icon, web: a.web !== false, today: a.today })),
    ...android.map((a) => ({ id: a.id, name: a.name || a.id, img: a.icon, android: true, video: !!a.video, canFloat: !!a.canFloat }))]
    .sort((a, b) => a.name.localeCompare(b.name));
  const off = (a) => hid[a.id] ?? !!places['app:' + a.id]?.hidden;
  const here = all.filter((a) => !off(a));
  const hide = (a, on) => { setMenu(null); setHid({ ...hid, [a.id]: on }); c.json('POST', '/home/place', { key: 'app:' + a.id, hidden: on }).catch(() => {}); };
  const toTab = (a) => { setMenu(null); c.json('POST', '/home/look', { tabs: [...tabs.map((t) => (t.name ? { id: t.id, name: t.name } : { id: t.id })), { id: a.id }] }).catch(() => {}); };
  const [onToday, setOnToday] = useState({}); // shown at once, until the home screen has it
  const isOn = (a) => onToday[a.id] ?? cards.includes(a.id);
  const toToday = (a, on) => { setMenu(null); setOnToday({ ...onToday, [a.id]: on }); c.json('POST', '/home/look', { cards: on ? [...cards.filter((x) => x !== a.id), a.id] : cards.filter((x) => x !== a.id) }).catch(() => {}); };
  // A video app's video floats over Home when someone goes Home while it plays (shell/VideoFloat.kt). The shell asks
  // for the PIN when Add apps does, so the menu reads it afresh each time it opens.
  const hold = (a) => { if (!a.android) return setMenu(a); let v = a.video; try { v = !!JSON.parse(shell.androidApps() || '[]').find((x) => x.id === a.id)?.video; } catch {} setMenu({ ...a, video: v }); };
  const toVideo = (a, on) => { setMenu(null); shell.videoApp(a.id, on); };
  const open = (a) => { if (a.web === false) setMenu({ ...a, old: true }); else shell?.openApp(a.id); };
  const held = useRef(null);
  const press = (a) => ({
    onPointerDown: (e) => { const at = [e.clientX, e.clientY]; clearTimeout(held.current?.t); held.current = { at, t: setTimeout(() => { held.current = { done: true }; hold(a); }, 600) }; },
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
      <div className="h-head"><h1 className="h-title">Apps</h1></div>
      {/* Each app a white panel: its icon large, its name and what it says of itself under. */}
      {here.length || shell?.plugins ? <div className="h-app-grid">{here.map((a) => (
        <button key={a.id} className={'h-app-tile' + (a.web === false ? ' old' : '')} {...press(a)}><Icon a={a} /><span className="h-app-name">{a.name}</span><span className="h-app-about">{a.about}</span></button>
      ))}
        {/* Asking Opie is the way to a new app (it builds it here, bridge/builder.js): the typing box, ready for it */}
        {shell?.makeApp && <button className="h-app-tile add make" onClick={() => shell.makeApp('Say what app to make')}>
          <span className="h-app-icon letter add"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A1.5 1.5 0 0 1 4 14.5z" /><path d="M12 6.5v6M9 9.5h6" /></svg></span>
          <span className="h-app-name">Make an app</span></button>}
        {/* Opie's list of plugins (the shell's gallery, as in Settings, Plugins): adding one asks for the PIN */}
        {shell?.plugins && <button className="h-app-tile add" onClick={() => shell.plugins()}>
          <span className="h-app-icon letter add"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg></span>
          <span className="h-app-name">Add apps</span><span className="h-app-about">From Opie's list or Google Play.</span></button>}</div> : <div className="h-soft">{all.length ? 'Nothing here: every app is a tab or taken off.' : 'No other apps yet. Ask Opie for one.'}</div>}
      {menu && <div className="h-veil" onClick={() => setMenu(null)}>
        <div className="h-menu" onClick={(e) => e.stopPropagation()}>
          <div className="h-menu-head"><Icon a={menu} /><span>{menu.name}</span></div>
          {menu.old ? <div className="h-soft">This one can't open yet. Ask Opie to remake it.</div> : <>
            {menu.web && <button className="h-menu-row" onClick={() => toTab(menu)}>Make it a tab</button>}
            {menu.android && menu.canFloat && shell?.videoApp && <button className="h-menu-row" onClick={() => toVideo(menu, !menu.video)}>{menu.video ? "Don't float its video" : 'Float its video over Home'}</button>}
            {menu.today && <button className="h-menu-row" onClick={() => toToday(menu, !isOn(menu))}>{isOn(menu) ? 'Take it off Home' : 'Add to Home'}</button>}
            <button className="h-menu-row" onClick={() => hide(menu, true)}>Take it off Apps</button></>}
          <button className="h-menu-row soft" onClick={() => setMenu(null)}>{menu.old ? 'Close' : 'Cancel'}</button>
        </div>
      </div>}
    </div>
  );
}

const Keys = () => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" /></svg>;
// Opie's own mark: the voice pill's four bars.
const Bars = () => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 10.5v3M9.67 7.5v9M14.33 6v12M19 9.5v5" /></svg>;
const Moon = () => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>;
const Chevron = ({ up }) => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d={up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} /></svg>;
const Cross = () => <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M7 7l10 10M17 7L7 17" /></svg>;

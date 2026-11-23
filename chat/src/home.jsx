// The home screen: a column on the left with the time, the day and the tabs, and one calm sheet beside it showing the
// chosen tab. A tab is Today (a glance at the day, with the notes the assistant put up), Apps (every app that isn't a
// tab of its own, and the Android apps added), or any of the family's apps, the real app running in the
// sheet, so an app the family or the assistant changed shows as they changed it. Today is the glance: the most
// important bit of each tab, each opening its tab.
//
// What's personal is data in apps/home/style.json (bridge/door.js, cleanLook): which tabs and in what order, the
// palette or the family's own colors, the type, the density and a photo backdrop. The assistant edits that file; the
// "Tabs and look" sheet here (hold a tab, or the sliders below the tabs) writes it through POST /door/look, so "undo"
// takes either back.
import { cloneElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Widget } from './door-widgets.jsx';
import { AnswerBody } from './answer.jsx';
import { TAB_ICONS, TAB_ICON_BY_ID } from './tab-icons.js';
import { card as weatherCard } from '../../bridge/kit/weather-look.js';

const DEFAULT_TABS = ['today', 'calendar', 'weather', 'map', 'chores', 'lists', 'meals', 'recipes', 'photos', 'whiteboard', 'apps'];
/** bg: behind everything; sheet: the page the tab is on; ink: text; accent: today, the chosen things. */
export const PALETTES = {
  paper: { bg: '#efeae1', sheet: '#fbf9f5', ink: '#2a2826', accent: '#b5562f' },
  linen: { bg: '#e8dac6', sheet: '#fcf5ea', ink: '#35291f', accent: '#b0502a' },
  sage: { bg: '#dce2d8', sheet: '#f7f9f4', ink: '#25302a', accent: '#4f7d5c' },
  mist: { bg: '#dce3ea', sheet: '#f8fafc', ink: '#222b34', accent: '#3d6ea8' },
  dusk: { bg: '#1d1b19', sheet: '#292624', ink: '#eee8df', accent: '#e0a26a' },
};
const FACES = { clean: "'Inter', Roboto, system-ui, sans-serif", serif: "'Newsreader', Georgia, serif", round: "'Nunito', system-ui, sans-serif", hand: "'Caveat', cursive" };
const PEOPLE = ['#d9a441', '#6fae8f', '#d97a5e', '#7d9ad6', '#b689cf', '#d6a86a'];
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

/** The look as CSS variables (the sheet's soft text, lines and tints come from its ink and paper). */
export function lookVars(st) {
  const p = { ...(PALETTES[st?.palette] || PALETTES.paper), ...(st?.colors || {}) };
  return { '--h-bg': p.bg, '--h-sheet': p.sheet, '--h-ink': p.ink, '--h-accent': p.accent, '--h-face': FACES[st?.type] || FACES.clean };
}

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
    <div className={'home' + (st.density === 'snug' ? ' snug' : '') + (st.type === 'hand' ? ' hand-type' : '') + (st.backdrop === 'photos' ? ' over-photos' : '') + (st.palette === 'dusk' ? ' dark' : '')} style={lookVars(st)}>
      {st.backdrop === 'photos' && <Backdrop c={c} names={house?.screensaver || house?.photos || []} now={now} usePhoto={usePhoto} />}
      <aside className="h-rail">
        <div className="h-time">{hm(d)}</div>
        <div className="h-day">{d.toLocaleDateString([], { weekday: 'long' })}</div>
        <div className="h-day h-date">{d.toLocaleDateString([], { day: 'numeric', month: 'long' })}</div>
        {weather && !weather.error && <div className="h-day">{weather.temp}° {String(weather.condition || '').toLowerCase()}</div>}
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

/** What an app's page is given in its address: the screen's colors and type (the kit takes them). Never its key. */
function lookHash(look, shell, paper, app) {
  const p = { ...(PALETTES[look?.palette] || PALETTES.paper), ...(look?.colors || {}) };
  return new URLSearchParams({ bg: paper ? paper(p) : p.sheet, ink: p.ink, accent: p.accent, face: look?.type || 'clean', ...(look?.palette === 'dusk' ? { dark: '1' } : {}), ...(shell?.phone && !app?.shared ? { phone: '1' } : {}) });
}
/** a mixed into b, k of it (#rrggbb): the cards' tint as a color an app's page can take. */
const mixHex = (a, b, k) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * k + parseInt(b.slice(i, i + 2), 16) * (1 - k)).toString(16).padStart(2, '0')).join('');

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
  const hash = lookHash(look, shell, (p) => mixHex(p.ink, p.sheet, 0.05), app);
  return <div className="t-card t-app" style={style}>
    <div className="h-label t-app-name" role="button" onClick={() => openApp(app.id)}>{app.meta?.name || app.id}</div>
    {key && <iframe ref={frame} key={shownV} className="t-app-pad" title={app.meta?.name || app.id} sandbox="allow-scripts allow-same-origin allow-forms" src={`${appOrigin(shell, app)}/apps/${app.id}/widget.html?today=${app.today}#${hash}`} />}
  </div>;
}

/** The apps' notes on the day (a school lunch, trash day): one outlined card under the calendar's, a row each, the label
 *  soft at the left and the whole text at the right. A tap opens it: all of it, where it's from, where that app's notes
 *  show, and opening the app. */
function DayNotes({ c, house, notes, day, openApp }) {
  const [open, setOpen] = useState(null), [shows, setShows] = useState({});
  const showOf = (x) => shows[x.app] ?? (house?.fromApps || []).find((a) => a.app === x.app)?.show ?? x.show;
  const setShow = (x, show) => { setShows({ ...shows, [x.app]: show }); c.json('POST', '/house/settings', { fromApp: { app: x.app, show } }).catch(() => {}); };
  const label = (x, sep) => <>{x.label}{x.who && <>{sep}{personColor(house, x.who) && <span className="h-dot" style={{ background: personColor(house, x.who) }} />}{x.who}</>}</>;
  const x = open;
  // A card like the others on Today (the user: "the same format and style as the other bubbles"): its label small
  // above, the words below; one card for each note.
  return <>
    {notes.map((n, i) => <div key={n.app + i} role="button" tabIndex={0} className="t-card t-acts t-daynote" onClick={() => setOpen(n)}>
      <div className="h-label">{label(n, ' · ')}</div>
      {n.pics?.some((p) => p.image) ? <div className="t-pics">{n.pics.map((p, k) => <div key={k} className="t-pic">
        {p.image && <img src={p.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.remove(); }} />}<span>{plain(p.text)}</span>
      </div>)}</div> : <div className="t-line">{plain(n.text)}</div>}
    </div>)}
    {x && <div className="h-veil" onClick={() => setOpen(null)}>
      <div className="h-note-full t-nsheet" onClick={(e) => e.stopPropagation()}>
        <div className="t-nk">{label(x, ' · ')} · {day.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        <h2>{plain(x.text)}</h2>
        <div className="t-nfrom">From {x.name || x.app}</div>
        <div className="t-nshow"><span>Show</span>{[['week', 'Week and Today'], ['today', 'Today only'], ['off', 'Nowhere']].map(([k, l]) => (
          <button key={k} className={'h-chip' + (showOf(x) === k ? ' on' : '')} onClick={() => setShow(x, k)}>{l}</button>))}</div>
        <div className="t-nacts"><button className="h-chip" onClick={() => { setOpen(null); openApp(x.app); }}>Open {x.name || x.app}</button>
          <button className="h-chip on" onClick={() => setOpen(null)}>Done</button></div>
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
// still counts by its name), the most useful first, and they share the sheet without scrolling: Calendar down the left,
// the others in a grid beside it, at most six.
const KINDS = ['calendar', 'weather', 'chores', 'meals', 'lists', 'photos'];
/** Which of the starting apps a tab is, by its id or, for one the family remade, its name. */
export function kindOf(t, app) { if (KINDS.includes(t.id)) return t.id; const n = String(t.name || app?.meta?.name || '').toLowerCase(); return KINDS.find((k) => n.includes(k.replace(/s$/, ''))) || null; }
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

function Today({ c, house, now, notes, weather, tabs, appBy, go, openApp, shell, usePhoto, look, appsV }) {
  const h = house || {};
  const kinds = new Map(); for (const t of tabs) { const k = kindOf(t, appBy.get(t.id)); if (k && !kinds.has(k)) kinds.set(k, t.id); }
  const t = new Date(now); t.setHours(0, 0, 0, 0);
  const Dot = ({ e }) => { const bg = eventPaint(h, e); return bg ? <span className="h-dot" style={{ background: bg }} /> : <span className="h-dot none" />; };
  const card = (kind, open) => ({ role: 'button', tabIndex: 0, className: 't-card t-' + kind, onClick: open || (() => go(kinds.get(kind))) });

  // Calendar: what's next, then the rest of its day, then the days after it, grouped by day, as many as fit (a quiet
  // today and tomorrow showed "Nothing on today or tomorrow" with the week full); under it, the things on Today.
  const tomorrow = new Date(+t + 864e5), weekOut = new Date(+t + 7 * 864e5);
  const upcoming = (h.events || []).filter((e) => (e.allDay ? dayOf(e) >= t : new Date(e.end || e.start) >= now) && dayOf(e) < weekOut)
    .sort((a, b) => (dayOf(a) - dayOf(b)) || (b.allDay - a.allDay) || (new Date(a.start) - new Date(b.start)));
  const byDay = []; for (const e of upcoming) { const d = dayOf(e); if (+byDay.at(-1)?.[0] !== +d) byDay.push([d, []]); byDay.at(-1)[1].push(e); }
  const first = upcoming[0], firstDay = first && dayOf(first);
  const dayName = (d) => (+d === +t ? 'Today' : +d === +tomorrow ? 'Tomorrow' : weekday(d, true));
  const todays = byDay[0] && +byDay[0][0] === +t ? byDay[0][1] : [];
  // What the household's apps put on the day (a school lunch, trash day): today's, and tomorrow's once today's events
  // are over or it's evening.
  const hadToday = (h.events || []).some((e) => +dayOf(e) === +t);
  const notesDay = !todays.length && (hadToday || new Date(now).getHours() >= 18) ? tomorrow : t;
  const dayNotes = (h.dayNotes?.[dayKey(notesDay)] || []).filter((x) => x.show !== 'off');
  const when = (e) => timeOf(e) || 'All day';
  // Chores: each person's left today, and the routine that's on now.
  const left = new Map();
  for (const ch of h.chores || []) if (ch.today !== false && !ch.skipped) { const k = ch.who || ''; if (!left.has(k)) left.set(k, 0); if (!ch.done) left.set(k, left.get(k) + 1); }
  const routine = (h.checklists || []).find((r) => r.now);
  // Lists: the groceries (or the first list), what's left, ticked right here with a moment to undo.
  const list = (h.lists || []).find((l) => l.id === 'groceries') || (h.lists || [])[0];
  const [ticked, setTicked] = useState(null);
  const [gone, setGone] = useState(() => new Set());
  useEffect(() => { if (!ticked) return; const x = setTimeout(() => setTicked(null), 6000); return () => clearTimeout(x); }, [ticked]);
  const items = (list?.items || []).filter((i) => !i.done && !gone.has(i.id));
  const tick = (e, i) => { e.stopPropagation(); setGone(new Set([...gone, i.id])); setTicked({ id: i.id, text: i.text }); c.json('POST', '/house/list', { list: list.name, check: [i.id] }).catch(() => {}); };
  const untick = (e) => { e.stopPropagation(); const i = ticked; setTicked(null); setGone(new Set([...gone].filter((x) => x !== i.id))); c.json('POST', '/house/list', { list: list.name, uncheck: [i.id] }).catch(() => {}); };
  // Meals: tonight's dinner and the next days' planned; unplanned, a few of their favorites and saved recipes to tap
  // for tonight (only ones they have: nothing made up).
  const dinner = (d) => { const v = h.meals?.[dayKey(d)]?.dinner; return v && String(v).trim() ? String(v) : null; };
  const [picked, setPicked] = useState(null); // planned here a moment ago, until /house has it
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
  if (kinds.has('chores') && (left.size || routine)) cards.push(<div key="chores" {...card('chores')}>
    <div className="h-label">{routine ? `${routine.name} now` : 'Chores left'}</div>
    {left.size ? <div className="t-rows">{[...left].slice(0, 4).map(([who, n]) => (
      <div key={who} className="t-row"><Dot who={who} /><span className="h-grow">{who || 'Anyone'}</span><span className={n ? 't-count' : 't-soft'}>{n || 'done'}</span></div>
    ))}</div> : <div className="t-line">{routine.steps?.length || 0} steps</div>}
  </div>);
  if (kinds.has('meals')) cards.push(<div key="meals" {...card('meals')}>
    <div className="h-label">Dinner tonight</div>
    {tonight ? <div className="t-big">{tonight}</div> : <div className="t-big t-quiet">Not planned</div>}
    {!tonight && !picks.length && !coming.length && <div className="t-soft">Plan the week in Meals</div>}
    <div className="t-fit" ref={mealFit}>
      {!tonight && picks.length > 0 && <div className="t-picks">{picks.slice(0, 8).map((p) => (
        <span key={p} role="button" className="t-pick" data-fit="" aria-label={'Have ' + p + ' tonight'} onClick={(e) => plan(e, p)}>{p}</span>))}</div>}
      {coming.length > 0 && <div className="t-rows t-gap-s">{coming.map((d) => <div key={+d} className="t-row" data-fit="">
        <span className="t-when">{+d === +tomorrow ? 'Tomorrow' : weekday(d)}</span><span className="h-grow">{dinner(d)}</span>
      </div>)}</div>}
    </div>
  </div>);
  if (kinds.has('lists') && list) cards.push(<div key="lists" {...card('lists')}>
    <div className="h-label">{list.name}</div>
    {/* As many as the card has room for (it showed three under "Groceries · 4"); the rest as a count that opens Lists. */}
    {items.length || ticked ? <div className="t-rows">{items.slice(0, items.length > 6 ? 5 : 6).map((i) => (
      <div key={i.id} className="t-row"><span className="t-box" role="button" aria-label={'Got ' + i.text} onClick={(e) => tick(e, i)} /><span className="h-grow">{i.text}</span></div>
    ))}{items.length > 6 && <div className="t-row t-soft">and {items.length - 5} more</div>}{ticked && <span className="t-undo" role="button" onClick={untick}>Got {ticked.text} · Undo</span>}</div>
      : <div className="t-big t-quiet">Nothing to get</div>}
  </div>);
  // The apps' own cards the household turned on, in their order, before the notes and the photo (wide: across two columns).
  if (shell?.ui) for (const id of look?.cards || []) { const a = appBy.get(id); if (a?.today) cards.push(<AppCard key={'app:' + id} c={c} shell={shell} app={a} look={look} v={appsV[id] || 0} openApp={openApp} wide={a.today === 'wide'} />); }
  if (notes.length) cards.push(<NotesCard key="notes" c={c} notes={notes} reminders={[]} />); // (reminders due are things on Today)
  if (kinds.has('photos') && photos.length) cards.push(<PhotoCard key="photos" c={c} names={photos} now={now} usePhoto={usePhoto} {...card('photos')} />);
  // Laid out in order, three rows at most: a wide card that doesn't fit the rest of a row starts the next, and the
  // card before it fills the row instead (no holes); the last card fills its row too.
  const cols = kinds.has('calendar') ? 2 : 3, side = [];
  let col = 0, row = 0;
  for (const x of cards) {
    const span = x.props.wide ? Math.min(2, cols) : 1;
    if (col + span > cols) { side[side.length - 1].span += cols - col; col = 0; row++; }
    if (row >= 3) break;
    side.push({ x, span }); col += span;
    if (col === cols) { col = 0; row++; }
  }
  if (col > 0) { side[side.length - 1].span += cols - col; row++; }
  const rows = Math.max(1, row);
  // Each row as tall as its cards need (a short card doesn't stretch to fill a tall slot); a row with a photo or an
  // app's card takes the rest, else the last row does, so the cards still reach the bottom.
  const sizes = Array(rows).fill('auto'), grow = 'minmax(calc(var(--u) * 180), 1fr)';
  { let r = 0, cc = 0; for (const { x, span } of side) { if (x.key === 'photos' || String(x.key).startsWith('app:')) sizes[r] = grow; cc += span; if (cc >= cols) { cc = 0; r++; } } }
  if (!sizes.includes(grow)) sizes[rows - 1] = grow;

  return (
    <div className="h-today">
      <div className="h-head"><h1 className="h-title">Today</h1>{!kinds.has('calendar') && <Things c={c} things={h.things} className="t-things t-things-head" go={go} tabs={tabs} ask={shell?.ask} />}</div>
      <div className={'t-grid' + (kinds.has('calendar') ? ' with-cal' : '')} style={{ '--rows': rows, '--cols': cols, gridTemplateRows: sizes.join(' ') }}>
        {kinds.has('calendar') && <div className="t-calcol" style={{ gridRow: `span ${rows}` }}>
        <div {...card('calendar')}>
          <div className="h-label">{!first ? 'Calendar' : +firstDay === +t ? 'Next' : dayName(firstDay)}</div>
          {first ? <>
            <div className="t-next">{plain(first.title)}</div>
            <div className="t-soft"><Dot e={first} />{[when(first), eventPeople(h, first).join(' & ') || null, first.place].filter(Boolean).join(' · ')}</div>
            <div className="t-fit" ref={calFit}>{byDay.map(([d, l], k) => { // the rest of its day, then each day after it
              const rest = k ? l : l.slice(1);
              return rest.length > 0 && <div key={+d}>
                <div className="h-label t-gap" data-fit="label">{k ? dayName(d) : +d === +t ? 'Later today' : 'Then'}</div>
                <div className="t-rows">{rest.map((e, i) => <div key={i} className="t-row" data-fit=""><span className="t-when">{when(e)}</span><Dot e={e} /><span className="h-grow">{plain(e.title)}</span></div>)}</div>
              </div>;
            })}</div>
          </> : <div className="t-big t-quiet">Nothing on this week</div>}
          <Things c={c} things={h.things} go={go} tabs={tabs} ask={shell?.ask} />
        </div>
        {/* the day's notes from the apps, the next thing under its events */}
        {dayNotes.length > 0 && <DayNotes c={c} house={h} notes={dayNotes} day={notesDay} openApp={openApp} />}
        </div>}
        {side.map(({ x, span }) => (span > 1 ? cloneElement(x, { style: { gridColumn: `span ${span}` } }) : x))}
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

/** A photo of theirs, a new one every minute, opening Photos. */
function PhotoCard({ c, names, now, usePhoto, ...rest }) {
  const src = usePhoto(c, names[Math.floor(now / 60e3) % names.length]);
  return <div {...rest} className={rest.className + ' t-photo'}>{src && <img src={src} alt="" draggable={false} />}</div>;
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
  return <div className="t-card t-notes" style={style}>
    <div className="h-label">{reminders.length && !shown.length ? 'Now' : 'Notes'}</div>
    <div className="t-rows">
      {reminders.slice(0, 3).map((r) => <div key={r.key} className="t-row t-due"><span className="t-when">{timeOf(r)}</span><span className="h-grow">{plain(r.title)}</span></div>)}
      {shown.slice(0, room).map((n) => (
        <div key={n.id} role="button" className="t-row t-note" onClick={() => { setOpen(n.id); c.json('POST', '/door/touch', { id: n.id }).catch(() => {}); }}>
          <span className="t-note-title">{n.title}</span>{gist(n.content) && <span className="t-note-gist">{gist(n.content)}</span>}
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
  const all = [...apps.filter((a) => a.id !== 'home' && !inTabs.has(a.id)).map((a) => ({ id: a.id, name: a.meta?.name || a.id, svg: a.icon, web: a.web !== false, today: a.today })),
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
      <div className="h-head"><h1 className="h-title">Apps</h1></div>
      {here.length ? <div className="h-app-grid">{here.map((a) => (
        <button key={a.id} className={'h-app-tile' + (a.web === false ? ' old' : '')} {...press(a)}><Icon a={a} /><span className="h-app-name">{a.name}</span></button>
      ))}</div> : <div className="h-soft">{all.length ? 'Nothing here: every app is a tab or taken off.' : 'No other apps yet. Ask the assistant to make one.'}</div>}
      {menu && <div className="h-veil" onClick={() => setMenu(null)}>
        <div className="h-menu" onClick={(e) => e.stopPropagation()}>
          <div className="h-menu-head"><Icon a={menu} /><span>{menu.name}</span></div>
          {menu.old ? <div className="h-soft">This one was made before apps were web pages, so it can't open yet. Ask the assistant to remake it.</div> : <>
            {menu.web && <button className="h-menu-row" onClick={() => toTab(menu)}>Make it a tab</button>}
            {menu.today && <button className="h-menu-row" onClick={() => toToday(menu, !isOn(menu))}>{isOn(menu) ? 'Take it off Today' : 'Add to Today'}</button>}
            <button className="h-menu-row" onClick={() => hide(menu, true)}>Take it off Apps</button></>}
          <button className="h-menu-row soft" onClick={() => setMenu(null)}>{menu.old ? 'OK' : 'Cancel'}</button>
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

// The starting apps' widgets on the home screen (Calendar, Chores, Lists, Meals, Photos), drawn from the house's data the
// way the native home screen drew them (main's ui/Widgets.kt): colored tiles with white text, what's coming up when there's
// nothing today, recently bought things to put back, stars, and the app's own icon when there's nothing at all.
// Sizes are in u (one pixel of a 1536-wide screen: the --u variable), like the display's.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnswerBody } from './answer.jsx';
import { useNow } from './now.js';

export const U = (n) => `calc(var(--wu, var(--u)) * ${n})`; // --wu: a widget on half the page draws everything bigger
const COLORS = { calendar: '#3F76DB', chores: '#4FA877', meals: '#D95740', lists: '#E6B04A', photos: '#8A5CC9' };
const SOFT = 'rgba(255,255,255,.78)', INK = '#24282a';
const PEOPLE = ['#ffc247', '#56d6a0', '#ff8566', '#74acff', '#c3a0ff', '#ff9ec4'];
const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayName = (d, style = 'long') => d.toLocaleDateString([], { weekday: style });
const color = (house, who) => { const i = (house?.family || []).findIndex((p) => p.name.toLowerCase() === String(who || '').toLowerCase()); return i < 0 ? null : house.family[i].color || PEOPLE[i % PEOPLE.length]; };
// "4:30p", "9a": short enough for a row, and morning or afternoon is never a guess.
const time = (e) => (e.allDay ? null : new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(/\s?([AP])M$/i, (_, x) => x.toLowerCase()));
/** The day an event is on (its own date for a repeating one). */
const dayOf = (e) => (e.date ? new Date(e.date + 'T00:00') : (() => { const d = new Date(e.start); d.setHours(0, 0, 0, 0); return d; })());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
/** A day in the coming week by its name; further out, its date ("Nov 26"). */
export const whenLabel = (d, today) => (d - today <= 6 * 864e5 ? dayName(d, 'short') : d.toLocaleDateString([], { month: 'short', day: 'numeric' }));

/**
 * Shrinks what's inside to fit its box, the way the display's FitToBox does: what's inside is laid out at a smaller
 * size (so it still fills the width) until it fits the height, but never below [min]; past that it's cut at the bottom.
 */
export function Fit({ children, min = 0.6 }) {
  const box = useRef(null), inner = useRef(null);
  const [k, setK] = useState(1);
  useLayoutEffect(() => {
    let raf = 0;
    const fit = () => {
      const b = box.current, i = inner.current; if (!b || !i) return;
      let s = 1;
      for (let n = 0; n < 5; n++) { // like FitToBox: a few tries, each closer
        i.style.width = `${b.clientWidth / s}px`; i.style.transform = `scale(${s})`;
        const h = i.scrollHeight * s;
        if (h <= b.clientHeight + 1 || s <= min) break;
        s = Math.max(min, s * Math.sqrt(b.clientHeight / h) * 0.97);
      }
      setK(s);
    };
    fit();
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(fit); });
    ro.observe(box.current); ro.observe(inner.current);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, []);
  return <div className="fit" ref={box}><div className="fit-in" ref={inner} data-scale={k}>{children}</div></div>;
}

function Tile({ id, big, children, style }) {
  return <div className={'wtile' + (big ? ' big' : '')} style={{ background: COLORS[id], ...(big ? { '--wu': 'calc(var(--u) * 1.4)' } : {}), ...style }}>{children}</div>;
}
const Head = ({ children, ink }) => <div className="w-head" style={ink ? { color: 'rgba(36,40,42,.7)' } : undefined}>{children}</div>;
const Line = ({ children, size = 24, color: c = '#fff', weight = 700, lines = 1, style }) => (
  <div className={'w-line' + (lines > 1 ? ' multi' : '')} style={{ fontSize: U(size), color: c, fontWeight: weight, WebkitLineClamp: lines > 1 ? lines : undefined, ...style }}>{children}</div>
);
/** Nothing at all to show yet: the app's own icon, big, on its color (a tap opens the app, like any widget). */
export function IconFill({ app, id }) {
  const svg = app?.icon && `data:image/svg+xml,${encodeURIComponent(app.icon)}`;
  return <div className="w-iconfill">{svg ? <img src={svg} alt="" draggable={false} /> : <Line size={30}>{app?.meta?.name || id}</Line>}</div>;
}

export function Widget({ id, app, w, h, house, c, now: given, content, Photo }) {
  const clockNow = useNow(60e3), now = given ?? clockNow; // a day's things: drawn again each minute, not each second
  if (content != null) return <AgentWidget app={app} id={id} content={content} />;
  const big = h >= 4;
  const props = { id, app, w, h, house: house || {}, c, now, big };
  if (id === 'calendar') return <Calendar {...props} />;
  if (id === 'chores') return <Chores {...props} />;
  if (id === 'lists') return <Lists {...props} />;
  if (id === 'meals') return <Meals {...props} />;
  if (id === 'photos') return (house?.photos || []).length ? <Photo names={house.screensaver || house.photos} seconds={w * h >= 8 ? 10 : 15} /> : <Tile id="photos" big={big}><IconFill app={app} id={id} /></Tile>;
  return <Tile id={id} big={big}><IconFill app={app} id={id} /></Tile>;
}

function Calendar({ id, w, h, house, now, big }) {
  const t = new Date(now); t.setHours(0, 0, 0, 0);
  const events = house.events || [];
  const on = (d) => events.filter((e) => +dayOf(e) === +d).sort((a, b) => (b.allDay - a.allDay) || (new Date(a.start) - new Date(b.start)));
  if (h === 1) {
    const next = events.filter((e) => (e.allDay ? dayOf(e) >= t : new Date(e.end || e.start) >= now))
      .sort((a, b) => (a.allDay ? +dayOf(a) : +new Date(a.start)) - (b.allDay ? +dayOf(b) : +new Date(b.start)))[0];
    return (
      <Tile id={id}>
        <Head>{!next || +dayOf(next) === +t ? dayName(t) : dayOf(next) - t <= 6 * 864e5 ? dayName(dayOf(next)) : whenLabel(dayOf(next), t)}</Head>
        <div className="w-grow" />
        {next ? <>{time(next) && <Line size={20} color={SOFT}>{time(next)}</Line>}<Line size={28}>{next.title}</Line></> : <Line size={52} weight={900}>{t.getDate()}</Line>}
      </Tile>
    );
  }
  if (w <= 2) {
    const rows = big ? 9 : 4, today = on(t);
    // The day column is as wide as its labels: "Wed" needs less than "Nov 26".
    const dayW = (l) => (l.slice(0, rows).some((e) => dayOf(e) - t > 6 * 864e5) ? 74 : 44);
    const later = events.filter((e) => dayOf(e) > t).sort((a, b) => (dayOf(a) - dayOf(b)) || (b.allDay - a.allDay) || (new Date(a.start) - new Date(b.start)));
    return (
      <Tile id={id} big={big}>
        <Head>{dayName(t)}</Head>
        <Line size={56} weight={900}>{t.getDate()}</Line>
        <div style={{ height: U(6) }} />
        {today.length ? today.slice(0, rows).map((e, i) => <EventRow key={i} e={e} house={house} />)
          : later.length ? later.slice(0, rows).map((e, i) => (
            <div key={i} className="w-row"><Line size={18} color={SOFT} weight={800} style={{ width: U(dayW(later)), flex: 'none' }}>{whenLabel(dayOf(e), t)}</Line><Line size={20} style={{ flex: 1 }}>{e.title}</Line>{time(e) && <Line size={18} color={SOFT} style={{ flex: 'none', textAlign: 'right' }}>{time(e)}</Line>}</div>
          )) : <WeekStrip t={t} />}
      </Tile>
    );
  }
  const days = [...Array(7)].map((_, i) => addDays(t, i));
  return (
    <Tile id={id} big={big}>
      <div className="w-week">{days.map((d) => (
        <div key={+d} className="w-day" style={{ background: `rgba(255,255,255,${+d === +t ? 0.2 : 0.08})` }}>
          <Line size={17} color={SOFT} weight={800}>{dayName(d, 'short')}</Line>
          <Line size={30} weight={900}>{d.getDate()}</Line>
          {on(d).slice(0, big ? 6 : 3).map((e, i) => <div key={i} style={{ marginTop: U(4) }}>{time(e) && <Line size={13} color={SOFT} weight={800}>{time(e)}</Line>}<Line size={15} lines={2}>{e.title}</Line></div>)}
        </div>
      ))}</div>
    </Tile>
  );
}
const WeekStrip = ({ t }) => (
  <div className="w-strip">{[1, 2, 3, 4, 5, 6].map((i) => { const d = addDays(t, i); return <div key={i}><Line size={15} color={SOFT} weight={800}>{dayName(d, 'narrow')}</Line><Line size={19} color="rgba(255,255,255,.9)">{d.getDate()}</Line></div>; })}</div>
);
const EventRow = ({ e, house }) => (
  <div className="w-row">
    <span className="w-dot" style={{ width: U(10), height: U(10), background: (e.who && color(house, e.who)) || SOFT, border: 0 }} />
    <Line size={20} style={{ flex: 1 }}>{e.title}</Line>
    {time(e) && <Line size={18} color={SOFT} style={{ flex: 'none', textAlign: 'right' }}>{time(e)}</Line>}
  </div>
);

function Chores({ id, app, w, h, house, now, big }) {
  const chores = house.chores || [];
  const Dot = ({ who }) => <span className="w-dot" style={{ background: color(house, who) || SOFT }} />;
  if (!chores.length) { // none set up yet: the stars each of them has saved, or the app itself
    const stars = (house.family || []).map((p) => [p.name, house.stars?.[p.name] || 0]).filter(([, n]) => n > 0);
    return (
      <Tile id={id} big={big}>
        {stars.length ? stars.slice(0, h === 1 ? 2 : 6).map(([who, n]) => (
          <div key={who} className="w-row"><Dot who={who} /><Line size={22} style={{ flex: 'none' }}>{who}</Line><Line size={22} color={SOFT}>{'★'} {n}</Line></div>
        )) : <IconFill app={app} id={id} />}
      </Tile>
    );
  }
  const left = {};
  for (const x of chores) if (x.today && !x.done) (left[x.who] ||= []).push(x.task);
  const who = Object.keys(left);
  if (!who.length) return <Tile id={id} big={big}><div className="w-check"><svg viewBox="0 0 24 24" style={{ width: U(h === 1 ? 60 : 110), height: U(h === 1 ? 60 : 110) }}><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg></div></Tile>;
  const rows = h === 1 ? 2 : h === 2 ? 4 : 10;
  return (
    <Tile id={id} big={big}>
      {h > 1 && <><Head>{dayName(new Date(now))}</Head><div style={{ height: U(6) }} /></>}
      {who.slice(0, rows).map((p) => (
        <div key={p} className="w-row"><Dot who={p} /><Line size={h === 1 ? 21 : 23} style={{ flex: 'none' }}>{p}</Line>
          <Line size={h === 1 ? 18 : 20} color={SOFT} weight={600} lines={w >= 4 ? 2 : 1}>{left[p].join(', ')}</Line></div>
      ))}
    </Tile>
  );
}

function Lists({ id, app, w, h, house, c, big }) {
  const lists = house.lists || [];
  const groceries = lists.find((l) => l.name.toLowerCase() === 'groceries' || l.id === 'groceries');
  const l = [groceries, ...lists].filter(Boolean).find((x) => x.items.some((i) => !i.done)) || groceries || lists[0];
  if (!l) return <Tile id={id} big={big}><IconFill app={app} id={id} /></Tile>;
  const open = l.items.filter((i) => !i.done);
  const tick = (item, done) => c.json('POST', '/house/list', { list: l.id, [done ? 'check' : 'uncheck']: [item.id] }).catch(() => {});
  const Box = ({ faded, onClick }) => <button className="w-box" onClick={onClick} style={faded ? { background: 'transparent', border: `${U(2)} solid rgba(36,40,42,.3)` } : undefined} />;
  if (!open.length) { // all bought: what was on it lately, faded; a tap puts one back
    const again = l.items.filter((i) => i.done).slice(-(h === 1 ? 2 : 6)).reverse();
    return (
      <Tile id={id} big={big}>
        <Head ink>{l.name}</Head><div style={{ height: U(4) }} />
        {again.length ? again.map((i) => (
          <button key={i.id} className="w-row w-again" onClick={() => tick(i, false)}><Box faded /><Line size={22} color="rgba(36,40,42,.45)">{i.text}</Line></button>
        )) : <IconFill app={app} id={id} />}
      </Tile>
    );
  }
  // As many as fit: 2x2 holds six rows and a "+N" line. One left over takes that line itself, not "+1".
  const fit = h === 1 ? 2 : h === 2 ? 6 : 9, cols = w >= 4 ? 2 : 1;
  const perCol = h > 1 && open.length - fit * cols === 1 ? fit + 1 : fit;
  const shown = open.slice(0, perCol * cols), chunks = [];
  for (let i = 0; i < shown.length; i += perCol) chunks.push(shown.slice(i, i + perCol));
  return (
    <Tile id={id} big={big}>
      <Head ink>{l.name}</Head><div style={{ height: U(4) }} />
      <div className="w-cols">{chunks.map((ch, k) => <div key={k} className="w-col">{ch.map((i) => (
        <div key={i.id} className="w-row"><Box onClick={() => tick(i, true)} /><Line size={22} color={INK}>{i.text}</Line></div>
      ))}</div>)}</div>
      {open.length > shown.length && <Line size={18} color="rgba(36,40,42,.6)">+{open.length - shown.length}</Line>}
    </Tile>
  );
}

function Meals({ id, app, w, h, house, now, big }) {
  const t = new Date(now); t.setHours(0, 0, 0, 0);
  const dinner = (d) => { const m = house.meals?.[dayKey(d)]; const v = m && (m.dinner || Object.values(m)[0]); return v && String(v).trim() ? v : null; };
  const planned = [...Array(7)].map((_, i) => addDays(t, i)).map((d) => [d, dinner(d)]).filter(([, v]) => v);
  const idea = house.favorites?.[0]?.text;
  if (!planned.length && !idea) return <Tile id={id} big={big}><IconFill app={app} id={id} /></Tile>;
  if (w < 4) {
    // Tonight; else the next dinner planned (with its day); else a favorite, as a question.
    const [day, text] = dinner(t) ? [t, dinner(t)] : planned[0] || [null, `${idea}?`];
    return (
      <Tile id={id} big={big}>
        <Head>{dayName(day || t)}</Head>
        <div className="w-grow" />
        <Line size={h === 1 ? 28 : 34} color={day ? '#fff' : SOFT} lines={h === 1 ? 1 : 3}>{text}</Line>
        {h > 1 && <div className="w-grow" />}
      </Tile>
    );
  }
  return (
    <Tile id={id} big={big}>
      {[...Array(big ? 7 : 4)].map((_, i) => { const d = addDays(t, i); return (
        <div key={i} className="w-row"><Line size={20} color={SOFT} weight={800} style={{ width: U(70), flex: 'none' }}>{dayName(d, 'short')}</Line><Line size={24} color={i === 0 ? '#fff' : SOFT}>{dinner(d) || ''}</Line></div>
      ); })}
    </Tile>
  );
}

/** An app the family made: the layout its assistant keeps current, drawn like a note, with the app's name on it. */
function AgentWidget({ app, id, content }) {
  return (
    <div className="wtile agent">
      <div className="hand w-agent-name">{app?.meta?.name || id}</div>
      <Fit min={0.5}><AnswerBody text={content} prose={false} /></Fit>
    </div>
  );
}

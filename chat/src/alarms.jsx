// The alarm clocks, on the tablet's Home and the phone page (bridge/alarms.js keeps them, the tablet's shell rings them:
// Alarms.kt). A sheet: the alarms, each turned on or off with a tap and changed by tapping it; Add for a new one.
import { useEffect, useState } from 'react';
import { Veil } from './sheet.jsx';
import { haptic } from './native.js';

const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** When [a] next rings after [now], in this screen's time (bridge/alarms.js nextRing). */
export function nextRing(a, now) {
  if (!a?.on || !/^\d\d:\d\d$/.test(a.time || '')) return null;
  const [h, m] = a.time.split(':').map(Number);
  if (a.days?.length) {
    for (let i = 0; i <= 7; i++) { const d = new Date(now); d.setDate(d.getDate() + i); d.setHours(h, m, 0, 0); if (+d > now && a.days.includes(d.getDay())) return +d; }
    return null;
  }
  const [y, mo, da] = String(a.date || '').split('-').map(Number);
  const t = y ? +new Date(y, mo - 1, da, h, m) : 0;
  return t > now ? t : null;
}
/** The alarm that rings next, with its time: {a, at}, or null. */
export function nextAlarm(list, now) {
  let best = null;
  for (const a of list || []) { const at = nextRing(a, now); if (at && (!best || at < best.at)) best = { a, at }; }
  return best;
}
export const ringTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const timeText = (time) => ringTime(new Date(`2000-01-01T${time}`));
const daysText = (days) => (!days?.length ? 'Once' : days.length === 7 ? 'Every day' : days.join() === '1,2,3,4,5' ? 'Weekdays' : days.join() === '0,6' ? 'Weekends' : days.map((d) => DAY_NAMES[d]).join(' '));

const S = {
  veil: { position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(40,34,24,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  card: { width: 'min(92vw, 520px)', maxHeight: '86vh', overflow: 'auto', boxSizing: 'border-box', padding: '28px 28px 22px', background: 'var(--h-sheet, #fbf9f5)', color: 'var(--h-ink, #2a2826)', borderRadius: 26, boxShadow: '0 12px 40px rgba(0,0,0,.22)', display: 'flex', flexDirection: 'column', gap: 14, textAlign: 'left' },
  title: { fontSize: 26, fontWeight: 650, margin: 0 },
  row: { display: 'flex', alignItems: 'center', gap: 14, padding: '10px 0', borderTop: '1px solid var(--h-line, #e4e1dc)', cursor: 'pointer' },
  big: (on) => ({ fontSize: 34, fontWeight: 300, fontVariantNumeric: 'tabular-nums', opacity: on ? 1 : 0.4 }),
  soft: { color: 'var(--h-soft, #6e6a65)', fontSize: 15 },
  btns: { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 6 },
  tint: { fontSize: 17, fontWeight: 600, padding: '12px 20px', borderRadius: 999, background: 'var(--h-tint, #f1eee9)', color: 'var(--h-ink, #2a2826)', border: 0 },
  fill: { fontSize: 17, fontWeight: 600, padding: '12px 22px', borderRadius: 999, background: 'var(--h-ink, #2a2826)', color: 'var(--h-sheet, #fbf9f5)', border: 0 },
  sw: (on) => ({ marginLeft: 'auto', flex: 'none', width: 52, height: 30, borderRadius: 15, border: 0, padding: 3, background: on ? 'var(--h-accent, #b5562f)' : 'var(--h-line, #e4e1dc)', display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start' }),
  knob: { width: 24, height: 24, borderRadius: 12, background: '#fff', display: 'block' },
  input: { font: 'inherit', fontSize: 18, padding: '10px 12px', borderRadius: 12, border: '1px solid var(--h-line, #e4e1dc)', background: 'transparent', color: 'inherit', minWidth: 0 },
  day: (on) => ({ width: 40, height: 40, borderRadius: 20, border: 0, fontSize: 16, fontWeight: 600, background: on ? 'var(--h-ink, #2a2826)' : 'var(--h-tint, #f1eee9)', color: on ? 'var(--h-sheet, #fbf9f5)' : 'inherit' }),
};

/** The sheet. [alarms]: the home view's alarms.list; [family]: names for whose; [me]: a phone's person (a new one is theirs). */
export function AlarmsSheet({ c, alarms, family = [], me = null, onClose }) {
  const [edit, setEdit] = useState(null); // an alarm being changed, or {} for a new one
  const [err, setErr] = useState(null);
  // What this sheet changed shows at once (a phone hears of the change only at its next look at the home screen).
  const [mine, setMine] = useState(null);
  useEffect(() => setMine(null), [JSON.stringify(alarms)]);
  const list = mine || alarms || [];
  const send = (b) => c.json('POST', '/home/alarm', b).then((r) => {
    if (r.json?.error || !r.json?.ok) throw new Error(r.json?.error || "That didn't work.");
    const x = r.json.alarm;
    setMine(b.cancel ? list.filter((y) => y.id !== b.cancel) : list.some((y) => y.id === x?.id) ? list.map((y) => (y.id === x.id ? x : y)) : x ? [...list, x] : list);
    return r;
  });
  const toggle = (a) => { haptic(); return send({ change: { id: a.id, on: !a.on } }).catch((e) => setErr(e.message)); };
  return (
    <Veil className="al-veil" style={S.veil} onClose={onClose}>{(close) =>
      <div className="al-card" style={S.card}>
        {edit ? <Edit a={edit} family={family} me={me} send={send} done={() => setEdit(null)} />
          : <>
            <h2 style={S.title}>Alarms</h2>
            {list.map((a) => (
              <div key={a.id} style={S.row} onClick={() => setEdit(a)}>
                <div><div style={S.big(a.on)}>{timeText(a.time)}</div><div style={S.soft}>{[a.label, a.who, daysText(a.days)].filter(Boolean).join(' · ')}</div></div>
                <button style={S.sw(a.on)} aria-label={a.on ? 'Turn off' : 'Turn on'} onClick={(e) => { e.stopPropagation(); toggle(a); }}><i style={S.knob} /></button>
              </div>))}
            {err && <div style={{ ...S.soft, color: '#c8372b' }}>{err}</div>}
            <div style={S.btns}><button style={S.tint} onClick={() => setEdit({})}>Add</button><button style={S.fill} onClick={close}>Done</button></div>
          </>}
      </div>}
    </Veil>
  );
}

function Edit({ a, family, me, send, done }) {
  const fresh = !a.id;
  const [time, setTime] = useState(a.time || '07:00');
  const [days, setDays] = useState(a.days || []);
  const [label, setLabel] = useState(a.label || '');
  const [who, setWho] = useState(a.who || (fresh ? me?.person || '' : ''));
  const [err, setErr] = useState(null);
  const names = [...new Set([...family.map((p) => p.name).filter(Boolean), ...(who ? [who] : [])])];
  const flip = (d) => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort());
  const save = () => send(fresh ? { set: { time, days, label, who } } : { change: { id: a.id, time, days, label, who, on: true } }).then(done, (e) => setErr(e.message));
  const keep = (e) => e.preventDefault(); // (the field keeps its focus: the keyboard doesn't close under the finger, moving the sheet)
  return <>
    <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ ...S.input, fontSize: 40, fontWeight: 300, alignSelf: 'flex-start' }} />
    <div style={{ display: 'flex', gap: 6 }}>{DAYS.map((d, i) => <button key={i} style={S.day(days.includes(i))} aria-label={DAY_NAMES[i]} aria-pressed={days.includes(i)} onClick={() => flip(i)}>{d}</button>)}</div>
    <div style={{ display: 'flex', gap: 10 }}>
      <input placeholder="Label" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} style={{ ...S.input, flex: 1 }} />
      {names.length > 0 && <select value={who} onChange={(e) => setWho(e.target.value)} style={S.input} aria-label="Whose">
        <option value="">Anyone</option>{names.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>}
    </div>
    {err && <div style={{ ...S.soft, color: '#c8372b' }}>{err}</div>}
    <div style={S.btns}>
      {!fresh && <button style={{ ...S.tint, color: '#c8372b', marginRight: 'auto' }} onPointerDown={keep} onClick={() => send({ cancel: a.id }).then(done, (e) => setErr(e.message))}>Delete</button>}
      <button style={S.tint} onPointerDown={keep} onClick={done}>Cancel</button>
      <button style={S.fill} onPointerDown={keep} onClick={() => { haptic(); save(); }}>Save</button>
    </div>
  </>;
}

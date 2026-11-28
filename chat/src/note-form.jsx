// A note for Home, typed (bridge/home-note.js): words, for whom, now or at a time, and whether the device reads it
// aloud. On Home it opens from the Notes card's plus (home.jsx); on a phone it's a box on Today (phone.jsx).
// chip: the class of a pill, on: the chosen one's; the rest of the look is the page's.
import { useState } from 'react';

const MAX = 280;
const localNow = (ms) => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

export function NoteForm({ c, family = [], chip, on, go, chips, area, row, onDone, cancel = null, autoFocus = false }) {
  const [text, setText] = useState(''), [who, setWho] = useState(''), [later, setLater] = useState(false), [at, setAt] = useState(() => localNow(Date.now() + 3600e3));
  const [aloud, setAloud] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [sent, setSent] = useState('');
  const people = family.filter((p) => p.name && p.kind !== 'pet').map((p) => p.name);
  async function put(e) {
    e?.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const r = await c.json('POST', '/home/note', { text: text.trim(), ...(who ? { for: who } : {}), ...(later && at ? { at: +new Date(at) } : {}), aloud });
      if (r.status !== 200) { setError(r.json?.error || 'That didn’t go through.'); return; }
      setText(''); setWho(''); setLater(false); setAloud(false);
      setSent(r.json?.at ? `It goes up ${new Date(r.json.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.` : 'It’s on Home.');
      onDone?.(r.json);
    } catch { setError('Not in touch with home right now.'); }
    finally { setBusy(false); }
  }
  const pick = (v, cur, set) => <button type="button" key={v || 'all'} className={chip + (cur === v ? ' ' + on : '')} onClick={() => set(v)}>{v || 'Everyone'}</button>;
  const open = !!text.trim() || !!cancel;
  return <form onSubmit={put}>
    <textarea className={area} value={text} maxLength={MAX} rows={3} autoFocus={autoFocus} placeholder="A note for Home" onChange={(e) => { setText(e.target.value); setSent(''); }} />
    {sent && !text && <div className="soft">{sent}</div>}
    {open && <>
      {people.length > 0 && <div className={chips}>{['', ...people].map((p) => pick(p, who, setWho))}</div>}
      <div className={chips}>
        <button type="button" className={chip + (later ? '' : ' ' + on)} onClick={() => setLater(false)}>Now</button>
        <button type="button" className={chip + (later ? ' ' + on : '')} onClick={() => setLater(true)}>Later</button>
        <button type="button" className={chip + (aloud ? ' ' + on : '')} aria-pressed={aloud} onClick={() => setAloud(!aloud)}>Say it aloud</button>
      </div>
      {later && <input className={area} type="datetime-local" value={at} min={localNow(Date.now())} onChange={(e) => setAt(e.target.value)} />}
      {error && <div className="soft">{error}</div>}
      <div className={row}>{cancel && <button type="button" className={chip} onClick={cancel}>Cancel</button>}
        <button className={go} disabled={!text.trim() || busy}>Put up</button></div>
    </>}
  </form>;
}

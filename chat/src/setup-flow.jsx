// The setup's steps on the phone or computer it's done from (chat/src/phone.jsx, a tablet's 'setup' scope), and on a
// hub's settings device (chat/src/hub.jsx, docs/hub.md), where the hub's bridge drives the steps itself (bridge/hub-shell.js).
import { useEffect, useState } from 'react';
import { makeExample } from './home.jsx';

/** On a hub there's no tablet: its words and what it can't do yet (signing in to calendars, photos from this device). */
let HUB = false;
export const onTheHub = () => { HUB = true; };
const THE = () => (HUB ? 'the hub' : 'the tablet');
const The = () => (HUB ? 'The hub' : 'The tablet');
const mine = (me, who) => String(who || '').toLowerCase() === String(me?.person || '').toLowerCase();
const kidOrPet = (note) => /^\d{1,2}$/.test(String(note || '').trim()) || /\b(dog|cat|pet|fish|bird|hamster|rabbit)\b/i.test(String(note || ''));
/** The tablet's next setup step after one sent from here (Setup.kt STEPS). */
const AFTER = { calendar: 'photos', photos: 'ai', ai: 'pin', pin: 'voice', voice: 'android' };
export function SetupFlow({ me, c, h, onDone }) {
  const computer = !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  // It carries on the tablet's setup rather than repeating it: the tablet's step ({step, photos?}, GET /setup/step)
  // says what's wanted here now. A calendar or an album: its link is copied on this phone or computer, so the box for it
  // is here while the tablet shows that step. Any other step: carry on at the tablet. Once the tablet's setup is over:
  // what's only for here (invites, apps). undefined: not known yet; null: a tablet from before, with no step to follow
  // (then all four, as before).
  const [tablet, setTablet] = useState(undefined);
  useEffect(() => {
    let live = true, t = null;
    const look = async () => {
      try {
        const r = await c.json('GET', '/setup/step');
        if (live && r.status === 200) setTablet(r.json || { step: null });
        else if (live && (r.status === 403 || r.status === 404)) setTablet(null);
      } catch { if (live) setTablet((x) => (x === undefined ? null : x)); } // not in touch: the four steps, as before
      if (live) t = setTimeout(look, 2500);
    };
    look();
    return () => { live = false; clearTimeout(t); };
  }, []);
  const [i, setI] = useState(0);
  const steps = tablet === null ? ['calendars', 'photos', 'invite', 'apps'] : ['invite', 'apps']; // (then the home screen, as for every phone: AddToHome)
  const next = () => (i + 1 < steps.length ? setI(i + 1) : onDone());
  const family = (h.house?.family || []).filter((f) => !mine(me, f.name));
  const step = tablet?.step;
  if (tablet === undefined) return <main className="join setup"><div className="brand">Opie</div><p className="soft">…</p></main>;
  if (step) return (
    <main className="join setup">
      <div className="brand">Opie</div>
      {step === 'calendar' && <>
        <h1>Your calendars</h1>
        {!HUB && <SignIns c={c} family={h.house?.family || []} />}
        <AddLink c={c} kind="calendar" family={h.house?.family || []} sub={!HUB} />
      </>}
      {step === 'photos' && <>
        <AddLink c={c} kind="album" />
        {!HUB && <>
        <GooglePhotosHere c={c} />
        <h2>Photos from {computer ? 'this computer' : 'this phone'}</h2>
        {tablet.photos
          ? <a className="go act" href={tablet.photos} target="_blank" rel="noopener noreferrer">Choose photos</a>
          : <p className="soft">First tap Let phones send photos on the tablet.</p>}</>}
      </>}
      {step === 'ai' && <AiHere c={c} computer={computer} />}
      {step === 'pin' && <PinHere c={c} />}
      {step === 'voice' && <VoiceHere c={c} />}
      {step === 'android' && <><h1>Last, at the tablet</h1><p>Two Android settings only the tablet can change. Tap Done there when you’re finished.</p></>}
      {step === 'people' && <SetupPeople c={c} />}
      {step === 'place' && <SetupPlace c={c} />}
      {!['calendar', 'photos', 'ai', 'people', 'place', 'pin', 'voice', 'android'].includes(step) && <>
        <h1>Connected</h1>
        <p>{step === 'devices' ? 'Starting…' : `Carry on at ${THE()}.`}</p>
      </>}
      <div className="setuprow">
        <span className="grow" />
        {/* The steps sent from here move the tablet on from here too (the tablet's own Next works as well). */}
        {AFTER[step] && step !== 'pin' && <button className="go small" onClick={() => c.json('POST', '/setup/go', { step: AFTER[step] }).catch(() => {})}>Next</button>}
      </div>
    </main>
  );
  return (
    <main className="join setup">
      <div className="brand">Opie</div>
      <div className="soft step">{i + 1} of {steps.length}</div>
      {steps[i] === 'calendars' && <AddLink c={c} kind="calendar" family={h.house?.family || []} />}
      {steps[i] === 'photos' && <AddLink c={c} kind="album" />}
      {steps[i] === 'invite' && <Invite c={c} family={family} />}
      {steps[i] === 'apps' && <Apps computer={computer} family={h.house?.family || []} />}
      <div className="setuprow">
        {i > 0 && <button className="quiet" onClick={() => setI(i - 1)}>Back</button>}
        <span className="grow" />
        <button className="go small" onClick={next}>{i + 1 < steps.length ? 'Next' : 'Done'}</button>
      </div>
    </main>
  );
}
const HOW = {
  calendar: { title: 'Your calendars', hint: 'Calendar link (iCal)', help: 'Google: the calendar’s settings, Secret address in iCal format. iCloud: share it as Public. Outlook: Publish, ICS link.', path: '/setup/calendar' },
  album: { title: 'Photos', hint: 'iCloud shared album link', help: 'In Photos, turn on Public Website for a shared album and paste its link.', path: '/setup/album' },
};
/** Calendars you sign in to, from here: Google (its sign-in opens here; only on a tablet linked to an Opie account) and
 *  iCloud (the Apple ID and an app-specific password, typed here and sealed to the tablet). Which calendars to show is
 *  chosen at the tablet. */
function SignIns({ c, family = [] }) {
  const [linked, setLinked] = useState(null), [g, setG] = useState(null), [ic, setIc] = useState(false), [f, setF] = useState({ user: '', pass: '', who: '' }), [st, setSt] = useState(null);
  useEffect(() => { c.json('GET', '/setup/household').then((r) => setLinked(!!r.json?.linked)).catch(() => setLinked(false)); }, []);
  async function google() {
    setG('…');
    try {
      const r = await c.json('POST', '/setup/google', {});
      if (r.status !== 200 || !r.json?.url) return setG(r.json?.error || 'That didn’t work.');
      window.open(r.json.url, '_blank', 'noopener'); setG('Sign in to Google on the page that opened, then choose the calendars on the tablet.');
    } catch { setG(`${The()} isn’t in touch right now.`); }
  }
  async function icloud() {
    setSt('sending');
    try {
      const r = await c.json('POST', '/setup/icloud', f);
      if (r.status === 200) { setF({ user: '', pass: '', who: '' }); setIc(false); setSt('Signed in. Choose the calendars on the tablet.'); }
      else setSt(r.json?.error || 'That didn’t work.');
    } catch { setSt(`${The()} isn’t in touch right now.`); }
  }
  return <>
    <div className="setuprow">
      {linked && <button className="quiet" onClick={google}>Sign in with Google</button>}
      <button className="quiet" onClick={() => setIc(!ic)}>{linked ? 'iCloud' : 'Sign in to iCloud'}</button>
    </div>
    {g && <p className="soft">{g}</p>}
    {ic && <>
      <p>Make an app-specific password at appleid.apple.com, under Sign-In and Security. It goes only to the tablet.</p>
      <input value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} placeholder="Apple ID (email)" type="email" autoCapitalize="off" autoComplete="off" />
      <input value={f.pass} onChange={(e) => setF({ ...f, pass: e.target.value })} placeholder="App-specific password" type="password" autoComplete="off" />
      {family.length > 0 && <div className="chips">{family.map((p) => <button key={p.name} className={'chip' + (f.who === p.name ? ' on' : '')} onClick={() => setF({ ...f, who: f.who === p.name ? '' : p.name })}>{p.name}</button>)}</div>}
      <button className="go act" disabled={st === 'sending' || f.user.length < 3 || f.pass.length < 8} onClick={icloud}>{st === 'sending' ? 'Signing in…' : 'Sign in'}</button>
    </>}
    {st && st !== 'sending' && <p className="soft">{st}</p>}
  </>;
}
/** Google Photos, picked from here (the tablet's account linked): its sign-in and picker open here; the tablet copies them. */
function GooglePhotosHere({ c }) {
  const [linked, setLinked] = useState(null), [st, setSt] = useState(null);
  useEffect(() => { c.json('GET', '/setup/household').then((r) => setLinked(!!r.json?.linked)).catch(() => setLinked(false)); }, []);
  if (!linked) return null;
  async function go() {
    setSt('…');
    try {
      const r = await c.json('POST', '/setup/google', { kind: 'photos' });
      if (r.status !== 200 || !r.json?.url) return setSt(r.json?.error || 'That didn’t work.');
      window.open(r.json.url, '_blank', 'noopener'); setSt('Sign in to Google and pick the photos on the page that opened.');
    } catch { setSt(`${The()} isn’t in touch right now.`); }
  }
  return <><h2>Google Photos</h2><button className="quiet" onClick={go}>Pick from Google Photos</button>{st && <p className="soft">{st}</p>}</>;
}
export function AddLink({ c, kind, family = [], sub = false, heading = true }) {
  const how = HOW[kind];
  const [link, setLink] = useState(''), [who, setWho] = useState(''), [state, setState] = useState(null), [added, setAdded] = useState([]);
  async function add() {
    setState('sending');
    try {
      const r = await c.json('POST', how.path, { link: link.trim(), who });
      if (r.status === 200 && r.json?.added !== false) { setAdded([...added, who || (kind === 'album' ? 'An album' : 'A calendar')]); setLink(''); setState(null); }
      else setState(r.json?.error || 'That didn’t work.');
    } catch { setState(`${The()} isn’t in touch right now. Try again at home.`); }
  }
  return <>
    {sub ? <h2>Or a link</h2> : heading ? <h1>{how.title}</h1> : null}
    <p>{how.help}</p>
    <input value={link} onChange={(e) => { setLink(e.target.value); setState(null); }} placeholder={how.hint} inputMode="url" autoCapitalize="off" autoComplete="off" />
    {kind === 'calendar' && family.length > 0 && <div className="chips">{family.filter((f) => !/\b(dog|cat|pet|fish|bird|hamster|rabbit)\b/i.test(String(f.note || ''))).map((f) => <button key={f.name} className={'chip' + (who === f.name ? ' on' : '')} onClick={() => setWho(who === f.name ? '' : f.name)}>{f.name}</button>)}</div>}
    {/* The tablet reads the link once before keeping it: "Added" only when it read, else what went wrong. */}
    <button className="go act" disabled={!/^\S+\.\S+/.test(link.trim()) || state === 'sending'} onClick={add}>{state === 'sending' ? (kind === 'album' ? 'Looking at it…' : 'Reading it…') : 'Add'}</button>
    {state && state !== 'sending' && <p className="soft">{state}</p>}
    {added.map((a, k) => <p key={k} className="soft">Added: {a}</p>)}
  </>;
}
/** Who lives here, typed here for the tablet's setup (bridge /setup/household); Next saves it and moves the tablet on
 *  (/setup/go). What was saved before shows. */
function SetupPeople({ c }) {
  const [rows, setRows] = useState(null), [state, setState] = useState(null);
  // At least five rows, so most households fill it in without adding any.
  // One box for a birth year or a role ("2017", "Mom", "the dog"): a year is kept as one (the age is worked out from it,
  // so it never goes stale), anything else as their note, and whichever wasn't typed over is kept.
  const five = (l) => [...l, ...Array.from({ length: Math.max(0, 5 - l.length) }, () => ({ name: '', note: '' }))];
  const shown = (f) => ({ name: f.name, born: f.born, role: f.born && f.note === String(f.age) ? '' : f.note || '', note: f.born ? String(f.born) : f.note || '' });
  useEffect(() => { c.json('GET', '/setup/household').then((r) => setRows(five((r.json?.family || []).map(shown)))).catch(() => setRows(five([]))); }, []);
  const out = (r) => (/^\d{4}$/.test(r.note.trim()) ? { name: r.name, born: +r.note.trim(), note: r.role || '' } : { name: r.name, note: r.note, ...(r.born ? { born: r.born } : {}) });
  if (!rows) return <p className="soft">…</p>;
  const set = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  async function next() {
    setState('saving');
    try {
      const r = await c.json('POST', '/setup/household', { family: rows.filter((r) => r.name.trim()).map(out) });
      if (r.status !== 200) return setState(r.json?.error || 'That didn’t save.');
      await c.json('POST', '/setup/go', { step: 'place' }); setState(null);
    } catch { setState(`${The()} isn’t in touch right now.`); }
  }
  return <>
    <h1>Who lives here?</h1>
    <p>Names, and a birth year or role if you like.</p>
    {rows.map((r, i) => <div key={i} className="personrow">
      <input value={r.name} onChange={(e) => set(i, 'name', e.target.value)} placeholder="Name" autoCapitalize="words" autoComplete="off" />
      <input value={r.note} onChange={(e) => set(i, 'note', e.target.value)} placeholder="Year or role" autoComplete="off" style={{ maxWidth: '9em' }} />
    </div>)}
    <div className="setuprow">
      <button className="quiet" onClick={() => setRows([...rows, { name: '', note: '' }])}>+ Add someone</button>
      <span className="grow" />
      <button className="go small" disabled={state === 'saving'} onClick={next}>Next</button>
    </div>
    {state && state !== 'saving' && <p className="soft">{state}</p>}
  </>;
}
/** Where the household is: a street address (the tablet's guess first), or just the town or zip code. */
function SetupPlace({ c }) {
  const [v, setV] = useState(null), [state, setState] = useState(null);
  useEffect(() => {
    c.json('GET', '/setup/household').then((r) => { const h = r.json || {}; setV(h.address || h.location || h.guess?.address || h.guess?.town || ''); }).catch(() => setV(''));
  }, []);
  if (v === null) return <p className="soft">…</p>;
  async function next() {
    const t = v.trim(); setState('saving');
    try {
      if (t) {
        // The town or zip on its own is the place; a street address keeps a zip or the part after its first comma.
        const street = /\d/.test(t.split(',')[0]) && t.includes(',');
        const loc = street ? (t.match(/\b\d{5}\b/)?.[0] || t.slice(t.indexOf(',') + 1).trim()) : t;
        const r = await c.json('POST', '/setup/household', { location: loc, address: street ? t : '' });
        if (r.status !== 200) return setState(r.json?.error || 'That didn’t save.');
      }
      await c.json('POST', '/setup/go', { step: 'calendar' }); setState(null);
    } catch { setState(`${The()} isn’t in touch right now.`); }
  }
  return <>
    <h1>Where do you live?</h1>
    <p>For the weather, travel times and the map.</p>
    <input value={v} onChange={(e) => setV(e.target.value)} placeholder="Street address, town or zip" autoComplete="street-address" />
    <div className="setuprow"><span className="grow" /><button className="go small" disabled={state === 'saving'} onClick={next}>Next</button></div>
    {state && state !== 'saving' && <p className="soft">{state}</p>}
  </>;
}
/** Opie's AI: nothing to do when the account's voice is on for the household (or a key is in); else their own OpenAI
 *  key, or linking to an account (whose voice comes once the household is let in). */
function AiHere({ c, computer }) {
  const [v, setV] = useState(undefined);
  useEffect(() => { c.json('GET', '/setup/household').then((r) => setV(r.json?.voice || null)).catch(() => setV(null)); }, []);
  if (v === undefined) return <p className="soft">…</p>;
  if (v?.own) return <><h1>Opie’s AI</h1><p>Using your own OpenAI key.</p></>;
  if (v?.available) return <><h1>Opie’s AI</h1><p>Included with your Opie account.</p></>;
  // (Opie accounts aren't offered in the setup until they're open to everyone: a beta household's tablet comes linked.)
  return <><h1>Opie’s AI</h1><AddKey c={c} computer={computer} /></>;
}
/** The PIN, chosen here: it guards the tablet's Settings and saying yes to new apps. On a tablet without an account, its
 *  recovery code is shown here once, to keep. */
function PinHere({ c }) {
  const [a, setA] = useState(''), [b, setB] = useState(''), [st, setSt] = useState(null), [code, setCode] = useState(null);
  // One button: Next sets the PIN when one's typed (and shows the recovery code, if any, before moving on), or skips.
  const go = () => c.json('POST', '/setup/go', { step: AFTER.pin }).catch(() => {});
  async function next() {
    if (!a && !b) return go();
    if (a.length < 4) return setSt('4 to 8 digits.');
    if (a !== b) return setSt('The two don’t match.');
    setSt('…');
    try {
      const r = await c.json('POST', '/setup/pin', { pin: a });
      if (r.status !== 200) return setSt(r.json?.error || 'That didn’t work.');
      setA(''); setB('');
      if (r.json?.recovery) { setSt('done'); setCode(r.json.recovery); } else { setSt(null); go(); }
    } catch { setSt(`${The()} isn’t in touch right now.`); }
  }
  const row = (f) => <div className="setuprow"><span className="grow" /><button className="go small" disabled={st === '…'} onClick={f}>Next</button></div>;
  if (st === 'done') return <><h1>PIN set</h1>
    <p>If it’s forgotten, this code is the only way back. Keep it somewhere safe, away from the tablet.</p><p className="code">{code}</p>
    {row(go)}</>;
  return <>
    <h1>Choose a PIN</h1>
    <p>It guards Settings and new apps. You can skip it.</p>
    <input value={a} onChange={(e) => { setA(e.target.value.replace(/\D/g, '')); setSt(null); }} placeholder="4 to 8 digits" type="password" inputMode="numeric" maxLength={8} autoComplete="new-password" />
    <input value={b} onChange={(e) => { setB(e.target.value.replace(/\D/g, '')); setSt(null); }} placeholder="Again" type="password" inputMode="numeric" maxLength={8} autoComplete="new-password" />
    {row(next)}
    {st && st !== '…' && <p className="soft">{st}</p>}
  </>;
}
const VOICES = ['marin', 'gleam', 'meridian', 'delta', 'cinder', 'willow', 'stone', 'vesper', 'quartz', 'ripple', 'beacon', 'bossa', 'tempo', 'brise', 'sillage', 'nuri', 'juni', 'flitz', 'nira', 'harema', 'shida', 'noeul'];
/** Opie's voice: pick one (the tablet says a line in it once it's on), then turn it on: what's said after "Hey Opie"
 *  goes to OpenAI. The try is at the tablet, where Opie listens. */
function VoiceHere({ c }) {
  const [v, setV] = useState(undefined), [voice, setVoice] = useState('marin'), [st, setSt] = useState(null);
  useEffect(() => { c.json('GET', '/setup/household').then((r) => setV(r.json?.voice || null)).catch(() => setV(null)); }, []);
  async function on() {
    setSt('…');
    try {
      const r = await c.json('POST', '/setup/voice', { voice });
      if (r.json?.on) { setSt(null); setV({ ...v, on: true }); } else setSt(r.json?.notYet ? 'Opie’s voice isn’t on for your household yet. It comes on by itself once it is.' : r.json?.error || 'That didn’t work.');
    } catch { setSt(`${The()} isn’t in touch right now.`); }
  }
  const pick = (id) => { setVoice(id); if (v?.on) c.json('POST', '/setup/voice', { voice: id, do: 'sample' }).catch(() => {}); };
  if (v === undefined) return <p className="soft">…</p>;
  if (!v?.own && !v?.available) return <><h1>Talk to Opie</h1><p>This needs Opie’s AI. You can add a key later in {HUB ? 'the hub’s settings' : 'the tablet’s Settings, Voice'}.</p></>;
  return <>
    <h1>Talk to Opie</h1>
    <p>{HUB ? 'Tap Opie on a phone or screen, then ask.' : 'Say “Hey Opie” at the tablet, then ask.'} What follows goes to OpenAI.</p>
    <h2>Choose a voice</h2>
    <div className="chips">{VOICES.map((id) => <button key={id} className={'chip' + (voice === id ? ' on' : '')} onClick={() => pick(id)}>{id[0].toUpperCase() + id.slice(1)}</button>)}</div>
    {v?.on ? <p>{HUB ? 'It’s on.' : 'It’s on. Tap a voice to hear it at the tablet.'}</p>
      : <button className="go act" disabled={st === '…'} onClick={on}>Turn on Opie’s voice</button>}
    {st && st !== '…' && <p className="soft">{st}</p>}
  </>;
}
/** The household's own OpenAI key, for the tablet's Opie's AI step: sent straight to the tablet on the home Wi-Fi,
 *  sealed, where it's checked and kept (OwnKey.kt). Never kept on this page, and never shown again. */
export function AddKey({ c, computer }) {
  const [key, setKey] = useState(''), [state, setState] = useState(null);
  async function send() {
    setState('sending');
    try {
      const r = await c.json('POST', '/setup/openai', { key: key.trim() });
      if (r.status === 200 && r.json?.added) { setKey(''); setState('done'); }
      else setState(r.json?.error || 'That didn’t work.');
    } catch { setState(`${The()} isn’t in touch right now. Try again at home.`); }
  }
  if (state === 'done') return <p>Key added. Opie’s AI is on.</p>;
  return <>
    <p>Opie’s voice and assistant run on your OpenAI account. Paste an API key from platform.openai.com, and set a monthly budget there.</p>
    <input type="password" value={key} onChange={(e) => { setKey(e.target.value); setState(null); }} placeholder="sk-…" autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false} />
    <button className="go act" disabled={!/^sk-\S{20,}$/.test(key.trim()) || state === 'sending'} onClick={send}>{state === 'sending' ? 'Checking it…' : 'Add'}</button>
    {state && state !== 'sending' && <p className="soft">{state}</p>}
  </>;
}
function Invite({ c, family }) {
  const [sent, setSent] = useState({}), [link, setLink] = useState(null);
  async function invite(f) {
    try {
      const r = await c.json('POST', '/setup/invite', { person: f.name, grownup: !kidOrPet(f.note) });
      if (r.status !== 200) return;
      // With reaching home from away on, the cloud's page, which joins through the relay from anywhere; else the
      // tablet's own page on the home Wi-Fi.
      const away = r.json.page && r.json.relay;
      const url = away ? `${r.json.page}?for=${encodeURIComponent(f.name)}#${r.json.pair}.${r.json.key}.${r.json.relay}`
        : `${location.origin}/phone/?for=${encodeURIComponent(f.name)}#${r.json.pair}.${r.json.key}`;
      const text = away ? `${f.name}, here's our Opie.` : `${f.name}, here's our Opie. Open it at home, on our Wi-Fi.`;
      setSent({ ...sent, [f.name]: true });
      if (navigator.share) await navigator.share({ title: 'Opie', text, url }).catch(() => setLink({ who: f.name, url }));
      else setLink({ who: f.name, url });
    } catch {}
  }
  const people = family.filter((f) => !/\b(dog|cat|pet|fish|bird|hamster|rabbit)\b/i.test(String(f.note || '')));
  return <>
    <h1>Invite your family</h1>
    <p>Each one gets their own link, for their phone.</p>
    {people.length ? people.map((f) => <div key={f.name} className="inviterow"><span>{f.name}</span><button className="chip" onClick={() => invite(f)}>{sent[f.name] ? 'Send again' : 'Send'}</button></div>)
      : <p className="soft">{HUB ? 'Nobody else yet.' : 'Nobody else yet. Add them on the tablet, in Settings, Family.'}</p>}
    {link && <><p className="soft">Send {link.who} this link:</p><input readOnly value={link.url} onFocus={(e) => e.target.select()} /></>}
  </>;
}
/** A second app to ask for, from who lives here: a rota needs nothing more than their names, so Opie can build it
 *  without asking anything back. */
function rotaExample(family = []) {
  const names = family.filter((f) => String(f.name || '').trim() && !/\b(dog|cat|pet|fish|bird|hamster|rabbit)\b/i.test(String(f.note || ''))).map((f) => String(f.name).trim()).slice(0, 4);
  const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
  return list ? `Make a rota for who sets the table each night: ${list}` : 'Make a rota for who sets the table each night';
}
/** Setup's last step: asking Opie is the way to a new app; a computer's Claude or ChatGPT is for bigger work. */
function Apps({ computer, family }) {
  return <>
    <h1>Make your own apps</h1>
    <p>Ask Opie for one {HUB ? 'on a phone or screen' : 'at the tablet'}, out loud or typed: “{makeExample(family)}”, or “{rotaExample(family)}”. Opie builds it there, and it goes in Apps once a grown-up says yes.</p>
    <p className="soft">For bigger work, connect Claude or ChatGPT{computer ? ' on this computer' : ' on a computer'}: add the connector cloud.opie.house/mcp, then ask it for a game, a tracker or a new tab.</p>
  </>;
}


// The setup's steps on the phone or computer it's done from (chat/src/phone.jsx, a tablet's 'setup' scope), and on a
// hub's settings device (chat/src/hub.jsx, docs/hub.md), where the hub's bridge drives the steps itself (bridge/hub-shell.js).
import { useEffect, useState } from 'react';
import { makeExample } from './home.jsx';

/** On a hub there's no tablet: its words and what it can't do yet (signing in to calendars, photos from this device). */
let HUB = false;
export const onTheHub = () => { HUB = true; };
const THE = () => (HUB ? 'the hub' : 'the device');
const The = () => (HUB ? 'The hub' : 'The device');
/** This page came over plain http (the tablet's address on the Wi-Fi): anyone there could have served it, so the PIN and
 *  iCloud's password are typed at the device instead (bridge brain.js /setup/pin, /setup/icloud). */
const AT_DEVICE = () => !HUB && !window.isSecureContext;
const mine = (me, who) => String(who || '').toLowerCase() === String(me?.person || '').toLowerCase();
/** The tablet's next setup step after one sent from here (Setup.kt STEPS). ai and voice: a tablet from before they
 *  left the setup (this page may be the cloud's copy, newer than the tablet), moved on past them from here. */
const AFTER = { calendar: 'photos', photos: 'pin', pin: 'android', ai: 'pin', voice: 'android' };
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
        else if (live && r.status === 403) setTablet({ step: null }); // the setup is over there: this is a person's own now
        else if (live && r.status === 404) setTablet(null);
      } catch { if (live) setTablet((x) => (x === undefined ? null : x)); } // not in touch: the four steps, as before
      if (live) t = setTimeout(look, 2500);
    };
    look();
    return () => { live = false; clearTimeout(t); };
  }, []);
  const [i, setI] = useState(0);
  // (then the home screen, as for every phone: AddToHome). Invites go while the tablet's setup lasts (its last step).
  const steps = tablet === null ? ['calendars', 'photos', 'invite', 'apps'] : HUB ? ['invite', 'apps'] : ['apps'];
  const next = () => (i + 1 < steps.length ? setI(i + 1) : onDone());
  const family = (h.house?.family || []).filter((f) => !mine(me, f.name));
  const step = tablet?.step;
  if (tablet === undefined) return <main className="join setup"><div className="brand">Opie</div><p className="soft">…</p></main>;
  if (step) return (
    <main className="join setup">
      <div className="brand">Opie</div>
      {step === 'calendar' && <>
        <h1>Your calendars</h1>
        <CalendarsHere c={c} family={h.house?.family || []} computer={computer} />
      </>}
      {step === 'photos' && <>
        <AddLink c={c} kind="album" />
        <GooglePhotosHere c={c} />
        {!HUB && <>
        <h2>Photos from {computer ? 'this computer' : 'this phone'}</h2>
        {tablet.photos
          ? <a className="go act" href={tablet.photos} target="_blank" rel="noopener noreferrer">Choose photos</a>
          : <p className="soft">First tap Let phones send photos on the device.</p>}</>}
      </>}
      {step === 'pin' && <PinHere c={c} />}
      {step === 'android' && <><h1>Last, at the device</h1><p>Two Android settings only the device can change. Tap Done there when you’re finished.</p>
        <Invite c={c} family={family} sub /></>}
      {step === 'people' && <SetupPeople c={c} />}
      {step === 'place' && <SetupPlace c={c} />}
      {!['calendar', 'photos', 'people', 'place', 'pin', 'android'].includes(step) && <>
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
/** A page that opens in its own tab once the tablet says where, after a round trip: the tab is opened at the tap
 *  itself, since a phone's browser blocks one opened later (Safari always), and pointed there once the address comes.
 *  go is false where even that was blocked: then the address is shown as a link to tap. */
function tabForLater() {
  let w = null;
  try { w = window.open('', '_blank'); } catch {}
  return {
    go(url) { try { if (w && !w.closed) { w.opener = null; w.location.href = url; return true; } } catch {} return false; },
    close() { try { w?.close(); } catch {} },
  };
}
/** A sign-in that opened (or a link to it, where the tab couldn't open), and what to do there. */
function Opened({ st }) {
  if (!st) return null;
  return st.url ? <a className="go act" href={st.url} target="_blank" rel="noopener noreferrer">{st.link}</a> : <p className="soft">{st.say}</p>;
}
/** Starts a Google sign-in from here (bridge /setup/google): its page opens in a new tab. */
async function googleFrom(c, body, set, said) {
  const tab = tabForLater();
  set({ say: '…' });
  try {
    const r = await c.json('POST', '/setup/google', { ...body, ...(HUB ? { r: location.origin + '/' } : {}) });
    if (r.status !== 200 || !r.json?.url) { tab.close(); return set({ say: r.json?.error || 'That didn’t work.' }); }
    set(tab.go(r.json.url) ? { say: said } : { url: r.json.url, link: 'Open Google’s sign-in' });
  } catch { tab.close(); set({ say: `${The()} isn’t in touch right now.` }); }
}
/** Calendars you sign in to, from here: Google (its sign-in opens here, in a new tab: the tablet's own page for it, on
 *  the home Wi-Fi, then Google's; only on a tablet linked to an Opie account) and iCloud (the Apple ID and an
 *  app-specific password, typed here and sealed to the tablet). Which calendars to show is chosen at the tablet. */
export function SignIns({ c, family = [], linked: given }) {
  const known = useLinked(c), linked = given ?? known;
  const [g, setG] = useState(null), [ic, setIc] = useState(false), [f, setF] = useState({ user: '', pass: '', who: '' }), [st, setSt] = useState(null);
  const google = () => googleFrom(c, {}, setG, HUB ? 'Sign in to Google in the new tab.' : 'Sign in to Google in the new tab, then choose the calendars on the device.');
  async function icloud(here = false) {
    setSt('sending');
    try {
      const r = await c.json('POST', '/setup/icloud', here ? {} : f);
      if (r.status === 200 && r.json?.here) { setF({ user: '', pass: '', who: '' }); setIc(false); setSt('Sign in on the device.'); }
      else if (r.status === 200) { setF({ user: '', pass: '', who: '' }); setIc(false); setSt(HUB ? 'Signed in.' : 'Signed in. Choose the calendars on the device.'); }
      else setSt(r.json?.error || 'That didn’t work.');
    } catch { setSt(`${The()} isn’t in touch right now.`); }
  }
  return <>
    <div className="setuprow">
      {linked && <button className="quiet" onClick={google}>Sign in with Google</button>}
      <button className="quiet" onClick={() => (AT_DEVICE() ? icloud(true) : setIc(!ic))}>{linked ? 'iCloud' : 'Sign in to iCloud'}</button>
    </div>
    <Opened st={g} />
    {ic && <>
      {/* Apple's own page for it opens in a new tab: an app-specific password is made only there (not in iOS Settings). */}
      <p>Make an app-specific password at <a href="https://account.apple.com/account/manage" target="_blank" rel="noopener noreferrer">account.apple.com</a>, in Sign-In and Security, and paste it here.</p>
      <input value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} placeholder="Apple ID (email)" type="email" autoCapitalize="off" autoComplete="off" />
      <input value={f.pass} onChange={(e) => setF({ ...f, pass: e.target.value })} placeholder="App-specific password" type="password" autoComplete="off" />
      {family.length > 0 && <div className="chips">{family.map((p) => <button key={p.name} className={'chip' + (f.who === p.name ? ' on' : '')} onClick={() => setF({ ...f, who: f.who === p.name ? '' : p.name })}>{p.name}</button>)}</div>}
      <button className="go act" disabled={st === 'sending' || f.user.length < 3 || f.pass.length < 8} onClick={icloud}>{st === 'sending' ? 'Signing in…' : 'Sign in'}</button>
    </>}
    {st && st !== 'sending' && <p className="soft">{st}</p>}
  </>;
}
/** Whether the tablet is linked to an Opie account (Google's sign-ins go through it), or null until it's known. */
function useLinked(c) {
  const [linked, setLinked] = useState(null);
  useEffect(() => { c.json('GET', '/setup/household').then((r) => setLinked(!!r.json?.linked)).catch(() => setLinked(false)); }, []);
  return linked;
}
/** Google Photos, picked from here (the tablet's account linked): its sign-in and picker open here; the tablet copies them. */
export function GooglePhotosHere({ c }) {
  const linked = useLinked(c), [st, setSt] = useState(null);
  if (!linked) return null;
  return <><h2>Google Photos</h2><button className="quiet" onClick={() => googleFrom(c, { kind: 'photos' }, setSt, 'Sign in to Google and pick the photos in the new tab.')}>Pick from Google Photos</button><Opened st={st} /></>;
}
/** The setup's calendar step here: the sign-ins, then a calendar's link. */
export function CalendarsHere({ c, family = [], computer }) {
  const linked = useLinked(c);
  if (linked === null) return <p className="soft">…</p>;
  return <>
    <SignIns c={c} family={family} linked={linked} />
    <AddLink c={c} kind="calendar" family={family} sub help={calendarHelp(linked, computer)} />
  </>;
}
/** Where a calendar's link is: Google's secret address is only in Google Calendar on a computer (its app on a phone has
 *  none), so on a phone it's left out where Google's sign-in is here instead, and said to be on a computer where not. */
function calendarHelp(linked, computer) {
  const rest = 'iCloud: share it as Public. Outlook: Publish, ICS link.';
  if (computer) return `Google: the calendar’s settings, Secret address in iCal format. ${rest}`;
  return linked ? rest : `${rest} Google: on a computer, the calendar’s settings, Secret address in iCal format.`;
}
export function AddLink({ c, kind, family = [], sub = false, heading = true, help }) {
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
    <p>{help || how.help}</p>
    <input value={link} onChange={(e) => { setLink(e.target.value); setState(null); }} placeholder={how.hint} inputMode="url" autoCapitalize="off" autoComplete="off" />
    {kind === 'calendar' && family.length > 0 && <div className="chips">{family.filter((f) => f.kind !== 'pet').map((f) => <button key={f.name} className={'chip' + (who === f.name ? ' on' : '')} onClick={() => setWho(who === f.name ? '' : f.name)}>{f.name}</button>)}</div>}
    {/* The tablet reads the link once before keeping it: "Added" only when it read, else what went wrong. */}
    <button className="go act" disabled={!/^\S+\.\S+/.test(link.trim()) || state === 'sending'} onClick={add}>{state === 'sending' ? (kind === 'album' ? 'Looking at it…' : 'Reading it…') : 'Add'}</button>
    {state && state !== 'sending' && <p className="soft">{state}</p>}
    {added.map((a, k) => <p key={k} className="soft">Added: {a}</p>)}
  </>;
}
/** Who lives here, typed here for the tablet's setup (bridge /setup/household): a name, Adult, Kid or Pet, and their
 *  color (the calendar's, chores' and lists'). Next saves it and moves the tablet on (/setup/go). What was saved before
 *  shows, and what isn't asked here (a note, a birth year) is kept as it was. */
const KINDS = [['adult', 'Adult'], ['kid', 'Kid'], ['pet', 'Pet']];
function SetupPeople({ c }) {
  const [rows, setRows] = useState(null), [colors, setColors] = useState([]), [state, setState] = useState(null);
  // At least five rows, so most households fill it in without adding any. The first is an adult to begin with.
  const blank = (i, cs) => ({ name: '', kind: i === 0 ? 'adult' : '', color: cs[i % cs.length] || '' });
  const five = (l, cs) => [...l, ...Array.from({ length: Math.max(0, 5 - l.length) }, (_, k) => blank(l.length + k, cs))];
  useEffect(() => {
    c.json('GET', '/setup/household').then((r) => {
      const cs = r.json?.colors || [];
      // (a person saved before keeps their note and birth year: sent back as they came, for a tablet from before too)
      setColors(cs); setRows(five((r.json?.family || []).map((f, i) => ({ name: f.name, kind: f.kind || 'adult', color: f.color || cs[i % cs.length] || '', had: { note: f.note || '', ...(f.born ? { born: f.born } : {}) } })), cs));
    }).catch(() => setRows(five([], [])));
  }, []);
  if (!rows) return <p className="soft">…</p>;
  const set = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  // A tap on a color: the next one nobody else here has (any next one once all are taken).
  const recolor = (i) => { const taken = rows.filter((r, j) => j !== i && r.name.trim()).map((r) => r.color), at = colors.indexOf(rows[i].color);
    const order = colors.map((_, k) => colors[(at + 1 + k) % colors.length]); set(i, 'color', order.find((x) => !taken.includes(x)) || order[0]); };
  const out = (r) => ({ name: r.name.trim(), ...(r.kind ? { kind: r.kind } : {}), ...(r.color ? { color: r.color } : {}), ...(r.had || {}) });
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
    {colors.length > 0 && <p>Tap a color to change it.</p>}
    {rows.map((r, i) => <div key={i} className="personrow">
      {colors.length > 0 && <button className="dot" style={{ background: r.color }} aria-label={`${r.name.trim() || 'Their'} color`}
        onClick={() => recolor(i)}>{r.name.trim()[0]?.toUpperCase() || ''}</button>}
      <input value={r.name} onChange={(e) => set(i, 'name', e.target.value)} placeholder="Name" autoCapitalize="words" autoComplete="off" />
      <div className="kinds" role="radiogroup">{KINDS.map(([k, label]) => <button key={k} role="radio" aria-checked={r.kind === k} className={r.kind === k ? 'on' : ''} onClick={() => set(i, 'kind', k)}>{label}</button>)}</div>
    </div>)}
    <div className="setuprow">
      <button className="quiet" onClick={() => setRows([...rows, blank(rows.length, colors)])}>+ Add someone</button>
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
/** The PIN, chosen here: it guards the tablet's Settings and saying yes to new apps. On a tablet without an account, its
 *  recovery code is shown here once, to keep. */
function PinHere({ c }) {
  const [a, setA] = useState(''), [b, setB] = useState(''), [st, setSt] = useState(null), [code, setCode] = useState(null), [here, setHere] = useState(AT_DEVICE);
  // Over plain http: the device's own PIN pad (it moves on by itself once the PIN is set there).
  const pad = () => c.json('POST', '/setup/pin', {}).catch(() => {});
  useEffect(() => { if (here) pad(); }, []);
  // One button: Next sets the PIN (and shows the recovery code, if any, before moving on). A device doesn't go past
  // this step without one (Setup.kt allowed); with nothing typed, Next moves on only where one is set already.
  const go = () => c.json('POST', '/setup/go', { step: AFTER.pin }).catch(() => {});
  async function next() {
    if (!a && !b) { setSt('4 to 8 digits.'); return go(); }
    if (a.length < 4) return setSt('4 to 8 digits.');
    if (a !== b) return setSt('The two don’t match.');
    setSt('…');
    try {
      const r = await c.json('POST', '/setup/pin', { pin: a });
      if (r.status !== 200) return setSt(r.json?.error || 'That didn’t work.');
      setA(''); setB('');
      if (r.json?.here) { setSt(null); return setHere(true); }
      if (r.json?.recovery) { setSt('done'); setCode(r.json.recovery); } else { setSt(null); go(); }
    } catch { setSt(`${The()} isn’t in touch right now.`); }
  }
  const row = (f) => <div className="setuprow"><span className="grow" /><button className="go small" disabled={st === '…'} onClick={f}>Next</button></div>;
  if (here) return <><h1>Choose a PIN</h1><p>Type it on the device.</p><button className="quiet" onClick={pad}>Show it again</button></>;
  if (st === 'done') return <><h1>PIN set</h1>
    <p>If it’s forgotten, this code is the only way back. Keep it somewhere safe, away from the device.</p><p className="code">{code}</p>
    {row(go)}</>;
  return <>
    <h1>Choose a PIN</h1>
    <p>It guards Settings and new apps.</p>
    <input value={a} onChange={(e) => { setA(e.target.value.replace(/\D/g, '')); setSt(null); }} placeholder="4 to 8 digits" type="password" inputMode="numeric" maxLength={8} autoComplete="new-password" />
    <input value={b} onChange={(e) => { setB(e.target.value.replace(/\D/g, '')); setSt(null); }} placeholder="Again" type="password" inputMode="numeric" maxLength={8} autoComplete="new-password" />
    {row(next)}
    {st && st !== '…' && <p className="soft">{st}</p>}
  </>;
}
/** The household's own OpenAI key, from a hub's settings page (hub.jsx; a tablet's is in its Settings, Voice): sent
 *  straight on, sealed, where it's checked and kept. Never kept on this page, and never shown again. */
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
    <p>Opie’s voice and assistant run on your OpenAI account, and stop for the month at $20. Paste an API key from platform.openai.com.</p>
    <input type="password" value={key} onChange={(e) => { setKey(e.target.value); setState(null); }} placeholder="sk-…" autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false} />
    <button className="go act" disabled={!/^sk-\S{20,}$/.test(key.trim()) || state === 'sending'} onClick={send}>{state === 'sending' ? 'Checking it…' : 'Add'}</button>
    {state && state !== 'sending' && <p className="soft">{state}</p>}
  </>;
}
function Invite({ c, family, sub = false }) {
  const [sent, setSent] = useState({}), [link, setLink] = useState(null);
  async function invite(f) {
    try {
      const r = await c.json('POST', '/setup/invite', { person: f.name, grownup: true });
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
  const people = family.filter((f) => (f.kind || 'adult') === 'adult'); // phones are for adults
  return <>
    {sub ? <h2>Invite your household</h2> : <h1>Invite your household</h1>}
    <p>Each one gets their own link, for their phone.</p>
    {people.length ? people.map((f) => <div key={f.name} className="inviterow"><span>{f.name}</span><button className="chip" onClick={() => invite(f)}>{sent[f.name] ? 'Send again' : 'Send'}</button></div>)
      : <p className="soft">{HUB ? 'Nobody else yet.' : 'Nobody else yet. Add them on the device, in Settings, Household.'}</p>}
    {link && <><p className="soft">Send {link.who} this link:</p><input readOnly value={link.url} onFocus={(e) => e.target.select()} /></>}
  </>;
}
/** A second app to ask for, from who lives here: a rota needs nothing more than their names, so Opie can build it
 *  without asking anything back. */
function rotaExample(family = []) {
  const names = family.filter((f) => String(f.name || '').trim() && f.kind !== 'pet').map((f) => String(f.name).trim()).slice(0, 4);
  const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
  return list ? `Make a rota for who sets the table each night: ${list}` : 'Make a rota for who sets the table each night';
}
/** Setup's last step: asking Opie is the way to a new app; a computer's Claude or ChatGPT is for bigger work. */
function Apps({ computer, family }) {
  return <>
    <h1>Make your own apps</h1>
    <p>Ask Opie for one {HUB ? 'on a phone or screen' : 'at the device'}, out loud or typed: “{makeExample(family)}”, or “{rotaExample(family)}”. Opie makes it there, and you try it before it goes in Apps.</p>
    <p className="soft">For bigger work, connect Claude or ChatGPT{computer ? ' on this computer' : ' on a computer'}: add the connector cloud.opie.house/mcp, then ask it for a game, a tracker or a new tab.</p>
  </>;
}


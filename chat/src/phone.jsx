// Someone's phone (docs/phones-and-tv.md): the household's day, lists that work at the shop with no signal, the
// calendar, their chores, and a note from the tablet when it has one for them (Web Push, sent by the tablet itself).
// It pairs like a screen (a QR code from the tablet's Screens > Add a screen > A phone, for one person), then every
// request is sealed with the phone's own key (screen-client.js), on the Wi-Fi or through the relay from away.
// Served by the tablet at /phone/ on the Wi-Fi; installable and with notifications only from an https address
// (the cloud's copy, a next step) or localhost.
import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { pair, client, Removed } from './screen-client.js';
import { Talk, canTalk } from './talk.jsx';
import { pairingFromCode } from './scrypt.js';
import { AppFrame, AppIcon, usePhoneApps, phoneTabs } from './phone-apps.jsx';
import { TAB_ICONS, TAB_ICON_BY_ID } from './tab-icons.js';
import { Today as TabletToday, lookVars } from './home.jsx';

// Served by OpenHouse's cloud (https, installable, notes by push): everything goes through the relay, and the
// pairing comes in the address after # (#<id>.<key>.<relay>.<token>.<about>), handed over by this page on the Wi-Fi.
// It stays in the address so a home-screen copy opens with it (iOS keeps an installed page's storage apart).
const CLOUD_RELAY = document.querySelector('meta[name="openhouse-relay"]')?.content || '';
const STORE = 'openhouse.phone', CACHE = 'openhouse.phone.house', QUEUE = 'openhouse.phone.queue';
const get = (k, d = null) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const put = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const mine = (me, who) => String(who || '').toLowerCase() === String(me?.person || '').toLowerCase();

// ---- joining ----------------------------------------------------------------------------------------------
function Join({ onJoined, removed }) {
  const [ask] = useState(() => { const m = location.hash.slice(1).match(/^([\w-]+)\.([\w-]{43})$/); return m && { pair: m[1], key: m[2] }; });
  const person = new URLSearchParams(location.search).get('for') || '';
  const [step, setStep] = useState(ask ? 'go' : 'none');
  const [code, setCode] = useState('');
  useEffect(() => { if (ask) history.replaceState(null, '', location.pathname + location.search); }, []);
  const computer = !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const [hub, setHub] = useState(false); // on a hub (docs/hub.md) there's no tablet: someone says yes on its settings page
  useEffect(() => { if (!CLOUD_RELAY) fetch('/pair/about').then((r) => r.json()).then((j) => setHub(!!j.hub)).catch(() => {}); }, []);
  async function join(via = ask) {
    try {
      const w = await pair({ ...via, name: person ? `${person}'s phone` : computer ? 'A computer' : 'A phone', onAsked: () => setStep('asked') });
      if (w.refused) return setStep('refused');
      put(STORE, w); onJoined(w);
    } catch { setStep('ended'); }
  }
  // A computer types the code the tablet's setup shows (scrypt makes it the pairing, as a TV's: screen.jsx).
  async function typed() { setStep('joining'); await new Promise((r) => setTimeout(r, 30)); const via = pairingFromCode(code); if (!via) return setStep('none'); await join(via); }
  return (
    <main className="join">
      <div className="brand">OpenHouse</div>
      {step === 'go' && <><h1>{person ? `${person}'s phone` : 'This phone'}</h1><p>The household's day, lists and chores here, and a note when the tablet has one{person ? ` for ${person}` : ''}.</p><button className="go" onClick={() => join()}>Join</button></>}
      {step === 'asked' && <><h1>Waiting</h1><p>{hub ? "Say yes on the hub's settings page." : 'Say yes on the tablet.'}</p></>}
      {step === 'refused' && <><h1>Not this time</h1><p>The tablet said no.</p></>}
      {step === 'joining' && <><h1>Joining</h1><p className="soft">A moment.</p></>}
      {(step === 'none' || step === 'ended') && <><h1>{removed ? 'This was removed' : 'Type the code from the tablet'}</h1>
        <input className="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX" autoCapitalize="characters" autoComplete="off" spellCheck="false" />
        <button className="go" disabled={code.replace(/[^0-9a-z]/gi, '').length !== 12} onClick={typed}>Join</button>
        {step === 'ended' && <p className="soft">That code didn't work. Check it on the {hub ? "hub's settings page" : 'tablet'}.</p>}</>}
    </main>
  );
}

// ---- data: live when it can be, the last copy when it can't, and changes that wait ----------------------
function useHouse(c, onRemoved) {
  const [house, setHouse] = useState(() => get(CACHE)?.house || null), [door, setDoor] = useState(null), [messages, setMessages] = useState([]);
  const [up, setUp] = useState(null), [at, setAt] = useState(() => get(CACHE)?.at || null), [waiting, setWaiting] = useState(() => get(QUEUE, []).length);
  const flushing = useRef(false);
  async function flush() {
    if (flushing.current) return; flushing.current = true;
    try {
      let q = get(QUEUE, []);
      while (q.length) {
        const r = await c.json('POST', q[0].p, q[0].b, q[0].a ? { app: q[0].a } : undefined);
        if (r.status >= 500) throw new Error('later');
        q = get(QUEUE, []).slice(1); put(QUEUE, q); setWaiting(q.length);
        if (r.json?.house) keepHouse(r.json.house);
      }
    } catch (e) { if (e instanceof Removed) onRemoved(); } finally { flushing.current = false; }
  }
  const keepHouse = (h) => { setHouse(h); const t = Date.now(); setAt(t); put(CACHE, { house: h, at: t }); };
  useEffect(() => {
    let stop = false;
    (async () => {
      let v = -1;
      while (!stop) {
        try {
          const r = await c.json('GET', v < 0 ? '/house' : `/house/wait?v=${v}`);
          if (r.status !== 200) throw new Error();
          v = r.json.v; keepHouse(r.json); setUp(true); flush();
        } catch (e) { if (e instanceof Removed) { stop = true; return onRemoved(); } setUp(false); v = -1; if (!stop) await new Promise((r) => setTimeout(r, 4000)); }
      }
    })();
    (async () => { while (!stop) { try { const r = await c.json('GET', '/door'); if (r.status === 200) setDoor(r.json); } catch {} await new Promise((r) => setTimeout(r, 60e3)); } })();
    // What Opie was asked to tell this phone's person lately ("tell Alex dinner's ready"): screens.js /phone/messages.
    (async () => { while (!stop) { try { const r = await c.json('GET', '/phone/messages'); if (r.status === 200) setMessages(r.json.messages || []); } catch {} await new Promise((r) => setTimeout(r, 60e3)); } })();
    const back = () => { if (!document.hidden) flush(); };
    addEventListener('online', back); document.addEventListener('visibilitychange', back);
    return () => { stop = true; removeEventListener('online', back); document.removeEventListener('visibilitychange', back); };
  }, [c]);
  /** A change: shown at once, sent now or when the phone is back in touch. */
  function change(p, b, local, a) {
    if (local && house) keepHouse(local(structuredClone(house)));
    const q = [...get(QUEUE, []), { p, b, ...(a ? { a } : {}) }]; put(QUEUE, q); setWaiting(q.length); flush();
  }
  /** A change an app made with no signal: it goes, marked with that app, when the phone is back in touch. */
  const later = ({ p, b, a }) => { const q = [...get(QUEUE, []), { p, b, a }]; put(QUEUE, q); setWaiting(q.length); setUp(false); };
  return { house, door, messages, up, at, waiting, change, later };
}

// ---- the tabs --------------------------------------------------------------------------------------------
/** A recipe's page shared to OpenHouse from the browser (the manifest's share_target, Android): it opens the Ask
 *  sheet with the link in it, and a link sent there goes to the household's recipe box (the tablet makes it into steps). */
const shared = (() => { const q = new URLSearchParams(location.search); const t = String(q.get('text') || '').trim(), u = String(q.get('url') || '').trim(); return [t, u && !t.includes(u) ? u : ''].filter(Boolean).join(' ').slice(0, 4000); })();
const canAsk = (me) => (me.scopes || []).includes('ask');
/** Opened from a notification of Opie's answer (phone-sw.js): that conversation, to answer back. */
const openedConvo = (() => { const o = new URLSearchParams(location.search).get('open') || ''; return /^opie:[\w-]{1,40}$/.test(o) ? o.slice(5) : null; })();
/** A phone that may ask may talk too (screens.js gives such phones 'voice'); the cloud's copy reads its scopes from the
 *  link it was installed with, which may be from before that. */
const talkScopes = (me) => (canAsk(me) && !me.scopes.includes('voice') ? [...me.scopes, 'voice'] : me.scopes || []);


/** Today: the tablet's own Today (home.jsx), phone-sized, then what's only for this phone's person: what Opie was asked to
 *  tell them, and turning on notes. */
function Today({ me, h, c, onOpen, tabs, apps, go, style }) {
  const { house, door } = h;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30e3); return () => clearInterval(t); }, []);
  const [weather, setWeather] = useState(() => get('openhouse.phone.weather'));
  useEffect(() => { let stop = false; (async () => { while (!stop) { try { const r = await c.json('GET', '/weather'); if (r.status === 200) { setWeather(r.json); put('openhouse.phone.weather', r.json); } } catch {} await new Promise((ok) => setTimeout(ok, 10 * 60e3)); } })(); return () => { stop = true; }; }, [c]);
  const appBy = useMemo(() => new Map((apps || []).map((a) => [a.id, { ...a, meta: { name: a.name } }])), [apps]);
  if (!house) return null;
  return (
    <>
      <div className="date page">{new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      <div className="ptoday" style={lookVars(style)}>
        <TabletToday c={c} house={house} now={now} notes={door?.notes || []} weather={weather} tabs={tabs} appBy={appBy} go={go} openApp={go} shell={null} usePhoto={usePhoto} look={style || {}} appsV={{}} />
      </div>
      <div className="page">
        {(h.messages || []).filter((m) => now - m.at < 12 * 3600e3).slice(-2).reverse().map((m) => <div key={m.id} className="card note" {...(m.open && onOpen ? { role: 'button', onClick: () => onOpen(m.open.slice(5)) } : {})}><div className="t">{m.text}</div><div className="soft">{m.title}, {new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div></div>)}
        <div className="later">
          {(CLOUD_RELAY || !cloudLink(me)) && <PushRow c={c} me={me} />}
          <SendToOpie me={me} c={c} />
        </div>
      </div>
    </>
  );
}
/** One of the family's photos, as a blob: URL (sealed, like everything else). */
const photoCache = new Map();
function usePhoto(c, name) {
  const [src, setSrc] = useState(() => photoCache.get(name) || null);
  useEffect(() => {
    if (!name) return;
    if (photoCache.has(name)) return setSrc(photoCache.get(name));
    let stop = false;
    c.request('GET', '/house/photo/' + encodeURIComponent(name), undefined, { big: true }).then((r) => {
      if (r.status !== 200) return;
      const url = URL.createObjectURL(new Blob([r.body], { type: r.type }));
      photoCache.set(name, url);
      if (photoCache.size > 20) { const [k, u] = photoCache.entries().next().value; URL.revokeObjectURL(u); photoCache.delete(k); }
      if (!stop) setSrc(url);
    }).catch(() => {});
    return () => { stop = true; };
  }, [name]);
  return src;
}

// ---- Opie: the pill at the bottom, and the sheet it opens ------------------------------------------------------
/** An answer's words, plain: paragraphs and list lines, without markdown's marks or the tablet's UI blocks. */
function Said({ text }) {
  const parts = String(text || '').replace(/```[\s\S]*?(```|$)/g, '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return parts.map((p, i) => <p key={i}>{p.split('\n').map((l, k) => <span key={k}>{k > 0 && <br />}{l.replace(/^\s*[-*]\s+/, '').replace(/^#+\s*/, '').replace(/\*\*|__|`/g, '')}</span>)}</p>);
}

/** What someone sent Opie, as they'd recognise it: a turn from the share sheet without its framing for Opie. */
const shownAsked = (t) => String(t || '').replace(/^\(Shared from their phone's share sheet[^)]*\)\s*/, (x) => (x ? 'You shared ' : '')).replace(/\n\n\(Do what they most likely want[\s\S]*$/, '').slice(0, 280);
function Ask({ me, c, onClose, convoId = null }) {
  const [text, setText] = useState(''), [turns, setTurns] = useState([]); // {q, a, status, live, ok}
  const ctl = useRef(null), convo = useRef(convoId), end = useRef(null);
  // Opened onto a conversation (Opie's answer to something shared): what was said in it, to answer back.
  useEffect(() => {
    if (!convoId) return;
    c.json('GET', `/chats/${convoId}`).then((r) => {
      const ts = [];
      for (const x of r.json?.turns || []) { if (x.role === 'user') ts.push({ q: shownAsked(x.text), a: '' }); else if (ts.length) ts[ts.length - 1].a = String(x.text || ''); }
      setTurns(ts.filter((x) => x.a || x.q));
    }).catch(() => {});
  }, []);
  // Shared to OpenHouse from another app (Android's share sheet): it goes to Opie at once, as the iPhone's shortcut does.
  useEffect(() => { if (!shared) return; history.replaceState(null, '', location.pathname + location.hash); send(shared); }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [turns]);
  const live = turns.at(-1)?.live;
  const set = (f) => setTurns((ts) => [...ts.slice(0, -1), { ...ts.at(-1), ...f(ts.at(-1)) }]);
  async function send(q) {
    setTurns((ts) => [...ts, { q, a: '', status: 'Sending to Opie', live: true }]);
    try {
      const r = await c.json('POST', '/phone/share', { text: q });
      if (r.json?.id) convo.current = r.json.id; // (answering back goes on in the same conversation)
      set(() => ({ a: r.json?.text || r.json?.error || 'That didn’t go through.', live: false }));
    } catch { set(() => ({ a: 'Not in touch with home right now. Try again in a moment.', live: false })); }
  }
  async function ask(e) {
    e?.preventDefault();
    const q = text.trim(); if (!q || live) return;
    setText(''); setTurns((ts) => [...ts, { q, a: '', status: '', live: true }]);
    ctl.current = new AbortController();
    let said = '';
    try {
      await c.lines('POST', '/chat', { id: convo.current, text: q, who: me.person || undefined }, (ev) => {
        if (ev.type === 'start') convo.current = ev.id;
        else if (ev.type === 'status') set(() => ({ status: ev.text }));
        else if (ev.type === 'delta') { said += ev.text; set(() => ({ a: said })); }
        else if (ev.type === 'reset') { said = ''; set(() => ({ a: '' })); }
        else if (ev.type === 'done') set(() => ({ a: ev.text || said, live: false, ok: ev.ok }));
      }, { signal: ctl.current.signal });
      set((t) => (t.live ? { live: false, a: t.a || 'No answer came back.' } : {}));
    } catch { set((t) => ({ live: false, a: t.a || 'Not in touch with home right now. Try again in a moment.' })); }
  }
  function stop() { ctl.current?.abort(); c.json('POST', '/chat/stop', { id: convo.current }).catch(() => {}); }
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head"><span className="t">Opie</span><button className="quiet" onClick={onClose}>Done</button></div>
        <div className="turns">
          {!turns.length && <p className="soft">Ask about the day, add to a list or the calendar, or paste a link.</p>}
          {turns.map((t, i) => (
            <div key={i} className="turn">
              <div className="you">{t.q}</div>
              <div className="said">{t.a ? <Said text={t.a} /> : t.live ? <p className="soft">{t.status || 'Thinking'}</p> : null}</div>
            </div>
          ))}
          <div ref={end} />
        </div>
        {/* Talk (the live voice, chat/src/live-voice.js from the hub's work) goes beside Ask once that module is here. */}
        <form className="askrow" onSubmit={ask}>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Opie" enterKeyHint="send" autoComplete="off" />
          {live ? <button type="button" className="go small" onClick={stop}>Stop</button>
            : <button className="go small" disabled={!text.trim()}>Ask</button>}
        </form>
      </div>
    </div>
  );
}


// ---- notes by push -------------------------------------------------------------------------------------
const pushable = () => 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;
function PushRow({ c, me }) {
  const [state, setState] = useState(() => (!me.scopes?.includes('notify') ? 'no' : !pushable() ? 'cant' : Notification.permission === 'denied' ? 'denied' : 'ask'));
  useEffect(() => { if (state === 'ask') c.json('GET', '/phone/push').then((r) => { if (r.json?.on && Notification.permission === 'granted') setState('on'); }).catch(() => {}); }, []);
  async function on() {
    try {
      if (await Notification.requestPermission() !== 'granted') return setState('denied');
      const reg = await navigator.serviceWorker.ready;
      const { json } = await c.json('GET', '/phone/push');
      const key = Uint8Array.from(atob(json.key.replace(/-/g, '+').replace(/_/g, '/')), (x) => x.charCodeAt(0));
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const r = await c.json('POST', '/phone/push', { subscription: sub.toJSON() });
      setState(r.json?.on ? 'on' : 'failed');
    } catch { setState('failed'); }
  }
  if (state === 'no') return null;
  const who = me.person || 'you';
  return (
    <div className="pushrow">
      {state === 'ask' && <><span>Get a buzz here when there's a note or a reminder for {who}.</span><button onClick={on}>Turn on</button></>}
      {state === 'on' && <span className="soft">Notes and reminders for {who} come to this phone.</span>}
      {state === 'denied' && <span className="soft">Notifications are off for this page in the phone's settings.</span>}
      {state === 'failed' && <><span className="soft">That didn't work.</span><button onClick={on}>Try again</button></>}
      {state === 'cant' && <span className="soft">{CLOUD_RELAY ? 'To get notes here, add this page to the home screen (Share, Add to Home Screen) and open it from there.' : 'Notes on this phone come with the app version, once the tablet is reachable from away (Settings, Cloud).'}</span>}
    </div>
  );
}

// ---- setup: from the phone or computer the tablet was set up with (its 'setup' scope) --------------------------
const DONE = 'openhouse.phone.setupDone';
const kidOrPet = (note) => /^\d{1,2}$/.test(String(note || '').trim()) || /\b(dog|cat|pet|fish|bird|hamster|rabbit)\b/i.test(String(note || ''));
function SetupFlow({ me, c, h, onDone }) {
  const computer = !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const [i, setI] = useState(0);
  const steps = ['calendars', 'photos', 'invite', 'apps']; // (then the home screen, as for every phone: AddToHome)
  const next = () => (i + 1 < steps.length ? setI(i + 1) : onDone());
  const family = (h.house?.family || []).filter((f) => !mine(me, f.name));
  return (
    <main className="join setup">
      <div className="brand">OpenHouse</div>
      <div className="soft step">{i + 1} of {steps.length}</div>
      {steps[i] === 'calendars' && <AddLink c={c} kind="calendar" family={h.house?.family || []} />}
      {steps[i] === 'photos' && <AddLink c={c} kind="album" />}
      {steps[i] === 'invite' && <Invite c={c} family={family} />}
      {steps[i] === 'apps' && <Apps computer={computer} />}
      <div className="setuprow">
        {i > 0 && <button className="quiet" onClick={() => setI(i - 1)}>Back</button>}
        <span className="grow" />
        <button className="go small" onClick={next}>{i + 1 < steps.length ? 'Next' : 'Done'}</button>
      </div>
    </main>
  );
}
const HOW = {
  calendar: { title: 'Your calendars', hint: 'Calendar link (iCal)', help: 'Google Calendar: Settings, your calendar, Secret address in iCal format. iCloud: share the calendar as Public, then copy its link. Outlook: Publish a calendar, ICS link.', path: '/setup/calendar' },
  album: { title: 'Photos', hint: 'iCloud shared album link', help: 'In Photos, a shared album, then its sharing settings: turn on Public Website, then copy the link.', path: '/setup/album' },
};
function AddLink({ c, kind, family = [] }) {
  const how = HOW[kind];
  const [link, setLink] = useState(''), [who, setWho] = useState(''), [state, setState] = useState(null), [added, setAdded] = useState([]);
  async function add() {
    setState('sending');
    try {
      const r = await c.json('POST', how.path, { link: link.trim(), who });
      if (r.status === 200 && r.json?.added !== false) { setAdded([...added, who || (kind === 'album' ? 'An album' : 'A calendar')]); setLink(''); setState(null); }
      else setState(r.json?.error || 'That didn’t work.');
    } catch { setState('The tablet isn’t in touch right now. Try again at home.'); }
  }
  return <>
    <h1>{how.title}</h1>
    <p>{how.help}</p>
    <input value={link} onChange={(e) => { setLink(e.target.value); setState(null); }} placeholder={how.hint} inputMode="url" autoCapitalize="off" autoComplete="off" />
    {kind === 'calendar' && family.length > 0 && <div className="chips">{family.filter((f) => !/\b(dog|cat|pet|fish|bird|hamster|rabbit)\b/i.test(String(f.note || ''))).map((f) => <button key={f.name} className={'chip' + (who === f.name ? ' on' : '')} onClick={() => setWho(who === f.name ? '' : f.name)}>{f.name}</button>)}</div>}
    <button className="go" disabled={!/^\S+\.\S+/.test(link.trim()) || state === 'sending'} onClick={add}>Add</button>
    {state && state !== 'sending' && <p className="soft">{state}</p>}
    {added.map((a, k) => <p key={k} className="soft">Added: {a}</p>)}
  </>;
}
function Invite({ c, family }) {
  const [sent, setSent] = useState({}), [link, setLink] = useState(null);
  async function invite(f) {
    try {
      const r = await c.json('POST', '/setup/invite', { person: f.name, grownup: !kidOrPet(f.note) });
      if (r.status !== 200) return;
      const url = `${location.origin}/phone/?for=${encodeURIComponent(f.name)}#${r.json.pair}.${r.json.key}`;
      const text = `${f.name}, here's our OpenHouse. Open it at home, on our Wi-Fi.`;
      setSent({ ...sent, [f.name]: true });
      if (navigator.share) await navigator.share({ title: 'OpenHouse', text, url }).catch(() => setLink({ who: f.name, url }));
      else setLink({ who: f.name, url });
    } catch {}
  }
  const people = family.filter((f) => !/\b(dog|cat|pet|fish|bird|hamster|rabbit)\b/i.test(String(f.note || '')));
  return <>
    <h1>Invite your family</h1>
    <p>Each one gets their own link, for their phone.</p>
    {people.length ? people.map((f) => <div key={f.name} className="inviterow"><span>{f.name}</span><button className="chip" onClick={() => invite(f)}>{sent[f.name] ? 'Send again' : 'Send'}</button></div>)
      : <p className="soft">Nobody else yet. Add them on the tablet, in Settings, Family.</p>}
    {link && <><p className="soft">Send {link.who} this link:</p><input readOnly value={link.url} onFocus={(e) => e.target.select()} /></>}
  </>;
}
function Apps({ computer }) {
  return <>
    <h1>Make your own apps</h1>
    <p>Connect Claude or ChatGPT{computer ? ' on this computer' : ' on your computer'}, then ask it for a game, a tracker or a new tab.</p>
    <a className="go" href="https://openhouse.computer" target="_blank" rel="noreferrer">How to connect</a>
  </>;
}

// ---- Send to Opie from an iPhone's share sheet (docs/phones.md; the cloud's send.ts, the bridge's phone-share.js) ----
/** One row: copy this phone's key, then add the shortcut, which asks for it. Only on the cloud's copy, on an iPhone,
 *  for a phone that may ask Opie, once the service has the signed shortcut. (Android's share sheet already lists OpenHouse.) */
const SHORTCUT = document.querySelector('meta[name="openhouse-shortcut"]')?.content || '';
function SendToOpie({ me, c }) {
  const [key, setKey] = useState(null), [step, setStep] = useState(() => (get('openhouse.phone.shortcut') ? 'done' : 'ask'));
  const can = !!(CLOUD_RELAY && SHORTCUT && /iPhone|iPad|iPod/.test(navigator.userAgent) && canAsk(me) && me.relay?.relay);
  // Fetched before the tap: an iPhone copies only straight from a tap, not after waiting on something.
  useEffect(() => { if (can && step !== 'done') c.json('GET', '/phone/share-key').then((r) => r.json?.key && setKey(`${me.relay.relay}.${me.id}.${me.relay.token}.${r.json.key}`)).catch(() => {}); }, [can]);
  if (!can) return null;
  function add() {
    navigator.clipboard?.writeText(key).catch(() => {});
    put('openhouse.phone.shortcut', true); setStep('copied');
    location.href = SHORTCUT;
  }
  if (step === 'done') return null;
  return (
    <div className="pushrow">
      {step === 'ask' ? <><span>Send links, photos and words to Opie from any app's share sheet. They go through OpenHouse's cloud on their way home.</span>
        <button disabled={!key} onClick={add}>Add Send to Opie</button></>
        : <><span>When it asks for a key, paste. Then Send to Opie is in the share sheet (under More the first time).</span>
          <button onClick={() => setStep('done')}>Done</button></>}
    </div>
  );
}

// ---- onto the home screen ----------------------------------------------------------------------------------
// From scanning to installed (docs/phones.md): the tablet's code joins the phone at once; on the Wi-Fi the page goes
// straight to the installable copy from the cloud (when the household reaches home from away); there, one screen says
// how to put it on the home screen. The home screen copy opens at this same address, the pairing after # and all.
const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent), ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch { return false; } };
let installPrompt = null; const promptWaiters = new Set();
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; promptWaiters.forEach((f) => f(e)); });
const LATER = 'openhouse.phone.homeLater';
const wantsHome = () => !!CLOUD_RELAY && mobile && !standalone() && !get(LATER);
const ShareIcon = () => <svg className="inline-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Share"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" /><path d="M6 11H5v10h14V11h-1" /></svg>;
function AddToHome({ me, onLater }) {
  const [can, setCan] = useState(!!installPrompt), [added, setAdded] = useState(false);
  useEffect(() => { const f = () => setCan(true); promptWaiters.add(f); const done = () => setAdded(true); addEventListener('appinstalled', done); return () => { promptWaiters.delete(f); removeEventListener('appinstalled', done); }; }, []);
  async function add() { try { installPrompt.prompt(); const r = await installPrompt.userChoice; if (r?.outcome === 'accepted') setAdded(true); } catch {} installPrompt = null; setCan(false); }
  return (
    <main className="join home">
      <div className="brand">OpenHouse</div>
      {added ? <><h1>Added</h1><p>Open OpenHouse from your home screen.</p></>
        : <><h1>Put it on your home screen</h1>
          <p>It opens like an app, works away from home, and can tell you when something's for you.</p>
          {can ? <button className="go" onClick={add}>Add to home screen</button>
            : <ol className="steps">
              {ios ? <><li>Tap Share <ShareIcon /></li><li>Tap Add to Home Screen</li></> : <><li>Tap the menu (⋮)</li><li>Tap Add to Home screen</li></>}
              <li>Open OpenHouse from your home screen</li>
            </ol>}</>}
      <button className="quiet later" onClick={onLater}>{added ? 'Keep using it here' : 'Not now'}</button>
    </main>
  );
}

// ---- the page ------------------------------------------------------------------------------------------
// The household's own tabs, in the tablet's order (its home style), each one's app running here in a frame of its own
// (phone-apps.jsx). The first four along the bottom, and More: every tab, in a list that slides in from the side.
const TabIcon = ({ t }) => {
  const d = TAB_ICONS[t.app?.tabIcon] || TAB_ICONS[TAB_ICON_BY_ID[t.id]];
  return d ? <svg className="tab-icon" viewBox="0 0 256 256" aria-hidden="true"><path d={d} fill="currentColor" /></svg> : <span className="tab-icon" />;
};
const MoreIcon = () => <svg className="tab-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
function Phone({ me, c, onRemoved }) {
  const h = useHouse(c, onRemoved);
  const { apps, style } = usePhoneApps(c, h.door);
  const tabs = phoneTabs(style, apps);
  const [setup, setSetup] = useState(() => (me.scopes || []).includes('setup') && !get(DONE));
  const [want, setTab] = useState(() => (shared ? 'today' : get('openhouse.phone.tab') || 'today'));
  const [opened, setOpened] = useState(null); // an app from Apps (or one an app opened) that isn't a tab
  const [more, setMore] = useState(false);
  const [asking, setAsking] = useState(() => (openedConvo && canAsk(me) ? { convo: openedConvo } : !!shared && canAsk(me)));
  useEffect(() => {
    if (openedConvo) history.replaceState(null, '', location.pathname + location.hash);
    const onMsg = (e) => { const o = String(e.data?.open || ''); if (/^opie:[\w-]{1,40}$/.test(o) && canAsk(me)) setAsking({ convo: o.slice(5) }); };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, []);
  const tab = tabs.some((t) => t.id === want) ? want : 'today';
  useEffect(() => put('openhouse.phone.tab', tab), [tab]);
  const [home, setHome] = useState(wantsHome);
  // On the Wi-Fi's page: once it knows the household's installable copy, go there (it works at home too).
  const link = !CLOUD_RELAY && mobile && !setup && cloudLink(me);
  useEffect(() => { if (link) location.replace(link); }, [link]);
  if (link) return <main className="join"><div className="brand">OpenHouse</div><h1>One moment</h1></main>;
  if (setup) return <SetupFlow me={me} c={c} h={h} onDone={() => { put(DONE, true); setSetup(false); }} />;
  if (home) return <AddToHome me={me} onLater={() => { put(LATER, true); setHome(false); }} />;
  const ago = h.at ? Math.round((Date.now() - h.at) / 60e3) : null;
  const go = (id) => { setOpened(null); setMore(false); setTab(id); };
  const open = (id) => { if (tabs.some((t) => t.id === id)) return go(id); const a = (apps || []).find((x) => x.id === id); if (a) { setMore(false); setOpened(a); } };
  const bar = tabs.length > 5 ? tabs.slice(0, 4) : tabs;
  const cur = opened ? null : tabs.find((t) => t.id === tab);
  const frame = (a) => <AppFrame key={a.id} c={c} app={a} style={style} onOpen={open} onClose={() => (opened ? setOpened(null) : go('today'))} onQueue={h.later} onRemoved={onRemoved} />;
  return (
    <div className={'app' + (canAsk(me) ? ' asks' : '') + (opened || cur?.app ? ' framed' : '')}>
      {h.up === false && <div className="status">{h.house ? `Not in touch with home. Showing what was here ${ago < 2 ? 'a moment' : ago < 90 ? `${ago} min` : `${Math.round(ago / 60)} h`} ago` : 'Not in touch with home yet'}{h.waiting ? `; ${h.waiting === 1 ? 'one change waits' : `${h.waiting} changes wait`} and goes when it's back.` : '.'}</div>}
      {opened ? <><div className="openbar"><button className="quiet" onClick={() => setOpened(null)}>Back</button><span>{opened.name}</span></div>{frame(opened)}</>
        : !h.house && tab === 'today' ? <div className="page"><p className="soft">Loading…</p></div>
        : tab === 'today' ? <><header><span className="brand">OpenHouse</span><span className="soft">{me.person}</span></header><Today me={me} h={h} c={c} tabs={tabs} apps={apps} go={open} style={style} onOpen={canAsk(me) ? (id) => setAsking({ convo: id }) : null} /></>
        : tab === 'apps' ? <AppsList apps={apps} tabs={tabs} onOpen={open} />
        : cur?.app ? frame(cur.app) : <div className="page"><p className="soft">Loading…</p></div>}
      {canAsk(me) && !asking && !more && (canTalk(talkScopes(me))
        ? <Talk c={c} scopes={talkScopes(me)} onType={() => setAsking(true)} />
        : <button className="opie" onClick={() => setAsking(true)}><span className="bars"><i /><i /><i /><i /></span>Ask Opie</button>)}
      {asking && <Ask key={asking.convo || 'new'} me={me} c={c} convoId={asking.convo || null} onClose={() => setAsking(false)} />}
      <nav>
        {bar.map((t) => <button key={t.id} className={!opened && tab === t.id ? 'here' : ''} onClick={() => go(t.id)}><TabIcon t={t} /><span>{t.name}</span></button>)}
        {bar.length < tabs.length && <button className={more ? 'here' : ''} onClick={() => setMore(true)}><MoreIcon /><span>More</span></button>}
      </nav>
      <More open={more} tabs={tabs} tab={opened ? null : tab} me={me} onGo={go} onClose={() => setMore(false)} />
    </div>
  );
}

/** Every tab, in a list that slides in from the side. */
function More({ open, tabs, tab, me, onGo, onClose }) {
  return (
    <div className={'more' + (open ? ' open' : '')} aria-hidden={!open}>
      <div className="more-veil" onClick={onClose} />
      <aside className="more-list">
        <div className="more-head"><span className="brand">OpenHouse</span><button className="quiet" onClick={onClose}>Done</button></div>
        {tabs.map((t) => <button key={t.id} className={'more-row' + (tab === t.id ? ' here' : '')} onClick={() => onGo(t.id)}><TabIcon t={t} /><span>{t.name}</span></button>)}
        <div className="soft more-foot">{me.person ? `${me.person}'s phone` : 'This phone'}</div>
      </aside>
    </div>
  );
}

/** The Apps tab: every app on phones that isn't a tab. */
function AppsList({ apps, tabs, onOpen }) {
  const inTabs = new Set(tabs.map((t) => t.id));
  const rest = (apps || []).filter((a) => !inTabs.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="page">
      <h1 className="title">Apps</h1>
      {!apps ? <p className="soft">Loading…</p> : rest.length ? <div className="app-grid">{rest.map((a) => <button key={a.id} className="app-tile" onClick={() => onOpen(a.id)}><AppIcon app={a} /><span>{a.name}</span></button>)}</div>
        : <p className="soft">Every app is a tab.</p>}
    </div>
  );
}

const b64u = { enc: (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), dec: (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))) };
/** The address of this phone's installable page in the cloud, carrying its pairing (only after #). */
export const cloudLink = (me) => me?.relay?.page && `${me.relay.page}#${me.id}.${me.key}.${me.relay.relay}.${me.relay.token}.${b64u.enc(JSON.stringify({ person: me.person, scopes: (me.scopes || []).filter((x) => x !== 'setup' || !get(DONE)), kind: 'phone' }))}`;
function fromCloudHash() {
  const m = location.hash.slice(1).match(/^([\w-]+)\.([\w-]{43})\.([\w-]+)\.([\w-]+)\.([\w-]+)$/);
  if (!m) return null;
  let about = {}; try { about = JSON.parse(b64u.dec(m[5])); } catch {}
  return { id: m[1], key: m[2], person: about.person || '', scopes: about.scopes || [], kind: 'phone', relay: { url: CLOUD_RELAY, relay: m[3], token: m[4] } };
}

function App() {
  const [me, setMe] = useState(() => (CLOUD_RELAY ? fromCloudHash() || get(STORE) : get(STORE))), [removed, setRemoved] = useState(false);
  useEffect(() => { if (CLOUD_RELAY && me) put(STORE, me); }, []);
  const c = useMemo(() => me && (CLOUD_RELAY
    ? client({ id: me.id, key: me.key, relay: me.relay, onlyRelay: true, api: location.origin }) // (the cloud's copy: big replies may come as boxes)
    : client({ id: me.id, key: me.key, relay: me.relay || null, onRelay: (r) => { const n = { ...(get(STORE) || me), relay: r || undefined }; put(STORE, n); setMe(n); } })), [me?.id, me?.relay?.token]);
  if (CLOUD_RELAY && !me) return <main className="join"><div className="brand">OpenHouse</div><h1>Not linked to a home yet</h1><p>On the tablet: Settings, Screens, Add a screen, Someone's phone. Scan the code with this phone's camera.</p></main>;
  if (!c) return <Join removed={removed} onJoined={(w) => { setRemoved(false); setMe(w); }} />;
  return <Phone me={me} c={c} onRemoved={() => { put(STORE, null); put(CACHE, null); put(QUEUE, null); setMe(null); setRemoved(true); }} />;
}

if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register(CLOUD_RELAY ? '/h/sw.js' : 'sw.js').catch(() => {});
addEventListener('hashchange', () => location.reload());
createRoot(document.getElementById('root')).render(<App />);

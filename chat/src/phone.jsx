// Someone's phone (docs/phones-and-tv.md): the household's day, lists that work at the shop with no signal, the
// calendar, their chores, and a note from the tablet when it has one for them (Web Push, sent by the tablet itself).
// It pairs like a screen (a QR code from the tablet's Screens > Add a screen > A phone, for one person), then every
// request is sealed with the phone's own key (screen-client.js), on the Wi-Fi or through the relay from away.
// Served by the tablet at /phone/ on the Wi-Fi; installable and with notifications only from an https address
// (the cloud's copy, a next step) or localhost.
import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pair, relayPair, client, Removed } from './screen-client.js';
import { Talk, canTalk } from './talk.jsx';
import { pairingFromCode } from './scrypt.js';
import { AppFrame, AppIcon, usePhoneApps, phoneTabs, appBundle } from './phone-apps.jsx';
import { TAB_ICONS, TAB_ICON_BY_ID } from './tab-icons.js';
import { Today as TabletToday, lookVars, makeExample } from './home.jsx';
import { paletteOf, worldOf } from './look.js';

// Served by Opie's cloud (https, installable, notes by push): everything goes through the relay, and the
// pairing comes in the address after # (#<id>.<key>.<relay>.<token>.<about>), handed over by this page on the Wi-Fi.
// It stays in the address so a home-screen copy opens with it (iOS keeps an installed page's storage apart).
const CLOUD_RELAY = document.querySelector('meta[name="openhouse-relay"]')?.content || '';
// Inside the iPhone app (ios/, docs/iphone-app.md): it turns on notes, the share sheet and the home screen itself.
const IN_APP = !!window.openhouseApp;
const STORE = 'openhouse.phone', CACHE = 'openhouse.phone.house', CACHE_AT = 'openhouse.phone.house-at', QUEUE = 'openhouse.phone.queue';
const get = (k, d = null) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const put = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
/** A setState updater that keeps the value it has when the new one is the same (a poll's answer, unchanged): no re-render. */
const same = (v) => (was) => (JSON.stringify(was) === JSON.stringify(v) ? was : v);
const mine = (me, who) => String(who || '').toLowerCase() === String(me?.person || '').toLowerCase();

// ---- joining ----------------------------------------------------------------------------------------------
function Join({ onJoined, removed }) {
  // An invite's link: pair.key on the tablet's own page; pair.key.relay on the cloud's (it joins through the relay).
  const [ask] = useState(() => { const m = location.hash.slice(1).match(/^([\w-]+)\.([\w-]{43})(?:\.([\w-]+))?$/); return m && { pair: m[1], key: m[2], ...(m[3] ? { relay: m[3] } : {}) }; });
  const person = new URLSearchParams(location.search).get('for') || '';
  const [step, setStep] = useState(ask ? 'go' : 'none');
  const [code, setCode] = useState('');
  useEffect(() => { if (ask) history.replaceState(null, '', location.pathname + location.search); }, []);
  const computer = !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const [hub, setHub] = useState(false); // on a hub (docs/hub.md) there's no tablet: someone says yes on its settings page
  useEffect(() => { if (!CLOUD_RELAY) fetch('/pair/about').then((r) => r.json()).then((j) => setHub(!!j.hub)).catch(() => {}); }, []);
  async function join(via = ask) {
    try {
      const name = person ? `${person}'s phone` : computer ? 'A computer' : 'A phone';
      const w = via.relay && CLOUD_RELAY ? await relayPair({ url: CLOUD_RELAY, ...via, name, onAsked: () => setStep('asked') })
        : await pair({ ...via, name, onAsked: () => setStep('asked') });
      if (w.refused) return setStep('refused');
      put(STORE, w); onJoined(w);
    } catch { setStep('ended'); }
  }
  // A computer types the code the tablet's setup shows (scrypt makes it the pairing, as a TV's: screen.jsx).
  async function typed() { setStep('joining'); await new Promise((r) => setTimeout(r, 30)); const via = pairingFromCode(code); if (!via) return setStep('none'); await join(via); }
  return (
    <main className="join">
      <div className="brand">Opie</div>
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
  const [house, setHouse] = useState(() => get(CACHE)?.house || null), [homeScreen, setHomeScreen] = useState(null), [messages, setMessages] = useState([]);
  // (when what it shows was last so: a ref, not state, as it changes with every answer and only shows when home is out of touch)
  const [up, setUp] = useState(null), at = useRef(get(CACHE_AT) || get(CACHE)?.at || null), [waiting, setWaiting] = useState(() => get(QUEUE, []).length);
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
  const keepHouse = (h) => { setHouse(h); const t = Date.now(); at.current = t; put(CACHE, { house: h, at: t }); put(CACHE_AT, t); };
  useEffect(() => {
    let stop = false;
    (async () => {
      let v = -1;
      while (!stop) {
        try {
          const r = await c.json('GET', v < 0 ? '/house' : `/house/wait?v=${v}&same=1`);
          if (r.status !== 200) throw new Error();
          v = r.json.v;
          // Nothing changed: what it shows is still so. (Only the time is kept, not the whole house again: this comes often.)
          if (r.json.same) { const t = Date.now(); at.current = t; put(CACHE_AT, t); }
          else keepHouse(r.json);
          setUp(true); flush();
        } catch (e) { if (e instanceof Removed) { stop = true; return onRemoved(); } setUp(false); v = -1; if (!stop) await new Promise((r) => setTimeout(r, 4000)); }
      }
    })();
    (async () => { while (!stop) { try { const r = await c.json('GET', '/home'); if (r.status === 200) setHomeScreen(same(r.json)); } catch {} await new Promise((r) => setTimeout(r, 60e3)); } })();
    // What Opie was asked to tell this phone's person lately ("tell Alex dinner's ready"): screens.js /phone/messages.
    (async () => { while (!stop) { try { const r = await c.json('GET', '/phone/messages'); if (r.status === 200) setMessages(same(r.json.messages || [])); } catch {} await new Promise((r) => setTimeout(r, 60e3)); } })();
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
  return { house, homeScreen, messages, up, at: at.current, waiting, change, later };
}

// ---- the tabs --------------------------------------------------------------------------------------------
/** A recipe's page shared to Opie from the browser (the manifest's share_target, Android): it opens the Ask
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
  const { house, homeScreen } = h;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30e3); return () => clearInterval(t); }, []);
  const [weather, setWeather] = useState(() => get('openhouse.phone.weather'));
  useEffect(() => { let stop = false; (async () => { while (!stop) { try { const r = await c.json('GET', '/weather'); if (r.status === 200) { setWeather(r.json); put('openhouse.phone.weather', r.json); } } catch {} await new Promise((ok) => setTimeout(ok, 10 * 60e3)); } })(); return () => { stop = true; }; }, [c]);
  const appBy = useMemo(() => new Map((apps || []).map((a) => [a.id, { ...a, meta: { name: a.name } }])), [apps]);
  if (!house) return null;
  return (
    <>
      <header className="phead"><div><div className="lab">{new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div><h1>Today</h1></div><span className="soft">{me.person}</span></header>
      <div className={'ptoday' + (style?.palette === 'dusk' ? ' dark' : '')} style={lookVars(style, 'today')}>
        <TabletToday c={c} house={house} now={now} notes={homeScreen?.notes || []} weather={weather} tabs={tabs} appBy={appBy} go={go} openApp={go} shell={null} usePhoto={usePhoto} look={style || {}} appsV={{}} />
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
  // Shared to Opie from another app (Android's share sheet): it goes to Opie at once, as the iPhone's shortcut does.
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
  if (state === 'no' || IN_APP) return null;
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
/** The tablet's next setup step after one sent from here (Setup.kt STEPS). */
const AFTER = { calendar: 'photos', photos: 'ai', ai: 'pin', pin: 'voice', voice: 'android' };
function SetupFlow({ me, c, h, onDone }) {
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
        <SignIns c={c} family={h.house?.family || []} />
        <AddLink c={c} kind="calendar" family={h.house?.family || []} sub />
      </>}
      {step === 'photos' && <>
        <AddLink c={c} kind="album" />
        <GooglePhotosHere c={c} />
        <h2>Photos from {computer ? 'this computer' : 'this phone'}</h2>
        {tablet.photos
          ? <a className="go" href={tablet.photos} target="_blank" rel="noopener noreferrer">Choose photos</a>
          : <p className="soft">To send photos from here, tap Let phones send photos on the tablet.</p>}
      </>}
      {step === 'ai' && <AiHere c={c} computer={computer} />}
      {step === 'pin' && <PinHere c={c} />}
      {step === 'voice' && <VoiceHere c={c} />}
      {step === 'android' && <><h1>Last, at the tablet</h1><p>Two of Android’s own settings, which only the tablet can change: letting Opie use other apps, and stopping charging at 80%. The tablet shows how; tap Done there when you’re finished.</p></>}
      {step === 'people' && <SetupPeople c={c} />}
      {step === 'place' && <SetupPlace c={c} />}
      {!['calendar', 'photos', 'ai', 'people', 'place', 'pin', 'voice', 'android'].includes(step) && <>
        <h1>Connected</h1>
        <p>{step === 'devices' ? 'Starting…' : 'Now at the tablet: it shows what to do. This page follows along.'}</p>
      </>}
      <div className="setuprow">
        <span className="grow" />
        {/* The steps sent from here move the tablet on from here too (the tablet's own Next works as well). */}
        {AFTER[step] && <button className="go small" onClick={() => c.json('POST', '/setup/go', { step: AFTER[step] }).catch(() => {})}>Next</button>}
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
  calendar: { title: 'Your calendars', hint: 'Calendar link (iCal)', help: 'Google Calendar: Settings, your calendar, Secret address in iCal format. iCloud: share the calendar as Public, then copy its link. Outlook: Publish a calendar, ICS link.', path: '/setup/calendar' },
  album: { title: 'Photos', hint: 'iCloud shared album link', help: 'In Photos, a shared album, then its sharing settings: turn on Public Website, then copy the link.', path: '/setup/album' },
};
/** Linking the tablet to an Opie account, from here: its link page opens here (the code never shows on the tablet). */
function LinkAccount({ c, onLinked }) {
  const [state, setState] = useState(null);
  async function go() {
    setState('…');
    try {
      const r = await c.json('POST', '/setup/link', {});
      if (r.json?.linked) { setState('Linked.'); onLinked?.(); return; }
      if (r.status !== 200 || !r.json?.url) return setState(r.json?.error || 'That didn’t work.');
      window.open(r.json.url, '_blank', 'noopener');
      setState('Sign in on the page that opened. The tablet links once you have.');
    } catch { setState('The tablet isn’t in touch right now.'); }
  }
  return <>
    <button className="quiet" onClick={go}>Link to your Opie account</button>
    {state && <p className="soft">{state}</p>}
  </>;
}
/** Calendars you sign in to, from here: Google (its sign-in opens here; the tablet's account must be linked) and
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
    } catch { setG('The tablet isn’t in touch right now.'); }
  }
  async function icloud() {
    setSt('sending');
    try {
      const r = await c.json('POST', '/setup/icloud', f);
      if (r.status === 200) { setF({ user: '', pass: '', who: '' }); setIc(false); setSt('Signed in. Choose the calendars on the tablet.'); }
      else setSt(r.json?.error || 'That didn’t work.');
    } catch { setSt('The tablet isn’t in touch right now.'); }
  }
  return <>
    <div className="setuprow">
      {linked ? <button className="quiet" onClick={google}>Sign in with Google</button> : linked === false && <LinkAccount c={c} onLinked={() => setLinked(true)} />}
      <button className="quiet" onClick={() => setIc(!ic)}>iCloud</button>
    </div>
    {linked === false && <p className="soft">Google Calendar signs in through your Opie account (two-way). Without one, add its secret iCal address below (read only).</p>}
    {g && <p className="soft">{g}</p>}
    {ic && <>
      <p>Make an app-specific password at appleid.apple.com (Sign-In and Security). It goes straight to the tablet, sealed, and only reaches iCloud’s calendars.</p>
      <input value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} placeholder="Apple ID (email)" type="email" autoCapitalize="off" autoComplete="off" />
      <input value={f.pass} onChange={(e) => setF({ ...f, pass: e.target.value })} placeholder="App-specific password" type="password" autoComplete="off" />
      {family.length > 0 && <div className="chips">{family.map((p) => <button key={p.name} className={'chip' + (f.who === p.name ? ' on' : '')} onClick={() => setF({ ...f, who: f.who === p.name ? '' : p.name })}>{p.name}</button>)}</div>}
      <button className="go" disabled={st === 'sending' || f.user.length < 3 || f.pass.length < 8} onClick={icloud}>{st === 'sending' ? 'Signing in…' : 'Sign in to iCloud'}</button>
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
    } catch { setSt('The tablet isn’t in touch right now.'); }
  }
  return <><h2>Google Photos</h2><button className="quiet" onClick={go}>Pick from Google Photos</button>{st && <p className="soft">{st}</p>}</>;
}
function AddLink({ c, kind, family = [], sub = false }) {
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
    {sub ? <h2>Or a calendar's link</h2> : <h1>{how.title}</h1>}
    <p>{how.help}</p>
    <input value={link} onChange={(e) => { setLink(e.target.value); setState(null); }} placeholder={how.hint} inputMode="url" autoCapitalize="off" autoComplete="off" />
    {kind === 'calendar' && family.length > 0 && <div className="chips">{family.filter((f) => !/\b(dog|cat|pet|fish|bird|hamster|rabbit)\b/i.test(String(f.note || ''))).map((f) => <button key={f.name} className={'chip' + (who === f.name ? ' on' : '')} onClick={() => setWho(who === f.name ? '' : f.name)}>{f.name}</button>)}</div>}
    {/* The tablet reads the link once before keeping it: "Added" only when it read, else what went wrong. */}
    <button className="go" disabled={!/^\S+\.\S+/.test(link.trim()) || state === 'sending'} onClick={add}>{state === 'sending' ? (kind === 'album' ? 'Looking at it…' : 'Reading it…') : 'Add'}</button>
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
    } catch { setState('The tablet isn’t in touch right now.'); }
  }
  return <>
    <h1>Who lives here?</h1>
    <p>Names, and a birth year or a role if you like (“2017”, “Mom”, “the dog”). Opie uses them to know who’s who.</p>
    {rows.map((r, i) => <div key={i} className="personrow">
      <input value={r.name} onChange={(e) => set(i, 'name', e.target.value)} placeholder="Name" autoCapitalize="words" autoComplete="off" />
      <input value={r.note} onChange={(e) => set(i, 'note', e.target.value)} placeholder="Born or role" autoComplete="off" style={{ maxWidth: '9em' }} />
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
    } catch { setState('The tablet isn’t in touch right now.'); }
  }
  return <>
    <h1>Where do you live?</h1>
    <p>A street address, or just the town or zip code. It’s for the weather, travel times and the map.</p>
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
  if (v?.own) return <><h1>Opie’s AI</h1><p>Opie uses your own OpenAI key. You can change it later in the tablet’s Settings, Voice.</p></>;
  if (v?.available) return <><h1>Opie’s AI</h1><p>It comes with your Opie account: nothing to set up.</p></>;
  return <><AddKey c={c} computer={computer} /><h2>Or Opie's voice through an account</h2><LinkAccount c={c} /></>;
}
/** The PIN, chosen here: it guards the tablet's Settings and saying yes to new apps. On a tablet without an account, its
 *  recovery code is shown here once, to keep. */
function PinHere({ c }) {
  const [a, setA] = useState(''), [b, setB] = useState(''), [st, setSt] = useState(null), [code, setCode] = useState(null);
  async function keep() {
    if (a !== b) return setSt('The two don’t match.');
    setSt('…');
    try {
      const r = await c.json('POST', '/setup/pin', { pin: a });
      if (r.status !== 200) return setSt(r.json?.error || 'That didn’t work.');
      setA(''); setB(''); setSt('done'); setCode(r.json?.recovery || null);
    } catch { setSt('The tablet isn’t in touch right now.'); }
  }
  if (st === 'done') return <><h1>PIN set</h1>
    {code ? <><p>If it’s ever forgotten, this recovery code is the only way back. Keep it somewhere safe, away from the tablet (a password manager is good).</p><p className="code">{code}</p></>
      : <p>If it’s forgotten, your Opie account can reset it.</p>}</>;
  return <>
    <h1>Choose a PIN</h1>
    <p>It guards the tablet’s Settings and saying yes to new apps. Without one, anyone at the tablet can. You can skip it.</p>
    <input value={a} onChange={(e) => { setA(e.target.value.replace(/\D/g, '')); setSt(null); }} placeholder="4 to 8 digits" type="password" inputMode="numeric" maxLength={8} autoComplete="new-password" />
    <input value={b} onChange={(e) => { setB(e.target.value.replace(/\D/g, '')); setSt(null); }} placeholder="Again" type="password" inputMode="numeric" maxLength={8} autoComplete="new-password" />
    <button className="go" disabled={a.length < 4 || b.length < 4 || st === '…'} onClick={keep}>Set the PIN</button>
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
      if (r.json?.on) { setSt(null); setV({ ...v, on: true }); } else setSt(r.json?.notYet ? 'Opie’s voice isn’t on for your household yet. You can carry on: it comes on by itself once it is.' : r.json?.error || 'That didn’t work.');
    } catch { setSt('The tablet isn’t in touch right now.'); }
  }
  const pick = (id) => { setVoice(id); if (v?.on) c.json('POST', '/setup/voice', { voice: id, do: 'sample' }).catch(() => {}); };
  if (v === undefined) return <p className="soft">…</p>;
  if (!v?.own && !v?.available) return <><h1>Talk to Opie</h1><p>Opie’s voice needs its AI, which you skipped. You can set it up later in the tablet’s Settings, Voice.</p></>;
  return <>
    <h1>Talk to Opie</h1>
    <p>Say “Hey Opie”, then what you’d like, at the tablet. What’s said after “Hey Opie” goes to OpenAI.</p>
    <h2>Choose a voice</h2>
    <div className="chips">{VOICES.map((id) => <button key={id} className={'chip' + (voice === id ? ' on' : '')} onClick={() => pick(id)}>{id[0].toUpperCase() + id.slice(1)}</button>)}</div>
    {v?.on ? <p>It’s on. Tap a voice to hear it at the tablet. Try it there: say “Hey Opie, what’s the weather?”</p>
      : <button className="go" disabled={st === '…'} onClick={on}>Turn on Opie’s voice</button>}
    {st && st !== '…' && <p className="soft">{st}</p>}
  </>;
}
/** The household's own OpenAI key, for the tablet's Opie's AI step: sent straight to the tablet on the home Wi-Fi,
 *  sealed, where it's checked and kept (OwnKey.kt). Never kept on this page, and never shown again. */
function AddKey({ c, computer }) {
  const [key, setKey] = useState(''), [state, setState] = useState(null);
  async function send() {
    setState('sending');
    try {
      const r = await c.json('POST', '/setup/openai', { key: key.trim() });
      if (r.status === 200 && r.json?.added) { setKey(''); setState('done'); }
      else setState(r.json?.error || 'That didn’t work.');
    } catch { setState('The tablet isn’t in touch right now. Try again at home.'); }
  }
  if (state === 'done') return <><h1>Your OpenAI key</h1><p>The tablet has it and it works. Carry on at the tablet.</p></>;
  return <>
    <h1>Your OpenAI key</h1>
    <p>Make a key at platform.openai.com, under API keys{computer ? '' : ' (on this phone, in a browser)'}, copy it, and paste it here. It goes straight to the tablet; OpenAI bills your account. Set a monthly budget for it at OpenAI too.</p>
    <input type="password" value={key} onChange={(e) => { setKey(e.target.value); setState(null); }} placeholder="sk-…" autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false} />
    <button className="go" disabled={!/^sk-\S{20,}$/.test(key.trim()) || state === 'sending'} onClick={send}>{state === 'sending' ? 'Checking it…' : 'Send to the tablet'}</button>
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
      : <p className="soft">Nobody else yet. Add them on the tablet, in Settings, Family.</p>}
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
    <p>Ask Opie for one at the tablet, out loud or typed: “{makeExample(family)}”, or “{rotaExample(family)}”. Opie builds it there, and it goes in Apps once a grown-up says yes.</p>
    <p className="soft">For bigger work, connect Claude or ChatGPT{computer ? ' on this computer' : ' on a computer'}: add the connector cloud.opie.house/mcp, then ask it for a game, a tracker or a new tab.</p>
  </>;
}

// ---- Send to Opie from an iPhone's share sheet (docs/phones.md; the cloud's send.ts, the bridge's phone-share.js) ----
/** One row: copy this phone's key, then add the shortcut, which asks for it. Only on the cloud's copy, on an iPhone,
 *  for a phone that may ask Opie, once the service has the signed shortcut. (Android's share sheet already lists Opie.) */
const SHORTCUT = document.querySelector('meta[name="openhouse-shortcut"]')?.content || '';
function SendToOpie({ me, c }) {
  const [key, setKey] = useState(null), [step, setStep] = useState(() => (get('openhouse.phone.shortcut') ? 'done' : 'ask'));
  const can = !!(CLOUD_RELAY && SHORTCUT && !IN_APP && /iPhone|iPad|iPod/.test(navigator.userAgent) && canAsk(me) && me.relay?.relay);
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
      {step === 'ask' ? <><span>Send links, photos and words to Opie from any app's share sheet. They go through Opie's cloud on their way home.</span>
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
const wantsHome = () => !!CLOUD_RELAY && mobile && !IN_APP && !standalone() && !get(LATER);
const ShareIcon = () => <svg className="inline-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Share"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" /><path d="M6 11H5v10h14V11h-1" /></svg>;
function AddToHome({ me, onLater }) {
  const [can, setCan] = useState(!!installPrompt), [added, setAdded] = useState(false);
  useEffect(() => { const f = () => setCan(true); promptWaiters.add(f); const done = () => setAdded(true); addEventListener('appinstalled', done); return () => { promptWaiters.delete(f); removeEventListener('appinstalled', done); }; }, []);
  async function add() { try { installPrompt.prompt(); const r = await installPrompt.userChoice; if (r?.outcome === 'accepted') setAdded(true); } catch {} installPrompt = null; setCan(false); }
  return (
    <main className="join home">
      <div className="brand">Opie</div>
      {added ? <><h1>Added</h1><p>Open Opie from your home screen.</p></>
        : <><h1>Put it on your home screen</h1>
          <p>It opens like an app, works away from home, and can tell you when something's for you.</p>
          {can ? <button className="go" onClick={add}>Add to home screen</button>
            : <ol className="steps">
              {ios ? <><li>Tap Share <ShareIcon /></li><li>Tap Add to Home Screen</li></> : <><li>Tap the menu (⋮)</li><li>Tap Add to Home screen</li></>}
              <li>Open Opie from your home screen</li>
            </ol>}</>}
      <button className="quiet later" onClick={onLater}>{added ? 'Keep using it here' : 'Not now'}</button>
    </main>
  );
}

/** The page's own colors from the household's look (look.js): the world behind this tab, the panels' white, the ink. */
const phoneVars = (style, tab) => { const p = paletteOf(style); return { '--bg': worldOf(style, tab), '--card': p.sheet, '--ink': p.ink }; };

// ---- the page ------------------------------------------------------------------------------------------
// The household's own tabs, in the tablet's order (its home style), each one's app running here in a frame of its own
// (phone-apps.jsx). The first four along the bottom, and More: every tab, in a list that slides in from the side.
const TabIcon = ({ t }) => {
  const d = TAB_ICONS[t.app?.tabIcon] || TAB_ICONS[TAB_ICON_BY_ID[t.id]];
  return d ? <svg className="tab-icon" viewBox="0 0 256 256" aria-hidden="true"><path d={d} fill="currentColor" /></svg> : <span className="tab-icon" />;
};
const MoreIcon = () => <svg className="tab-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round"><path d="M5.5 12h.01M12 12h.01M18.5 12h.01" /></svg>;
function Phone({ me, c, onRemoved }) {
  const h = useHouse(c, onRemoved);
  const { apps, style } = usePhoneApps(c, h.homeScreen);
  const tabs = phoneTabs(style, apps);
  const [setup, setSetup] = useState(() => (me.scopes || []).includes('setup') && !get(DONE));
  const [want, setTab] = useState(() => (shared ? 'today' : get('openhouse.phone.tab') || 'today'));
  const [opened, setOpened] = useState(null); // an app from Apps (or one an app opened) that isn't a tab
  const [more, setMore] = useState(false);
  // Each app's own background (its frame tells it), painted round its frame: under the status bar and the tabs.
  const [bgs, setBgs] = useState(() => get('openhouse.phone.bgs', {}));
  const onBg = useCallback((id, bg) => setBgs((b) => { if (b[id] === bg) return b; const n = { ...b, [id]: bg }; put('openhouse.phone.bgs', n); return n; }), []);
  const [asking, setAsking] = useState(() => (openedConvo && canAsk(me) ? { convo: openedConvo } : !!shared && canAsk(me)));
  useEffect(() => {
    if (openedConvo) history.replaceState(null, '', location.pathname + location.hash);
    const onMsg = (e) => { const o = String(e.data?.open || ''); if (/^opie:[\w-]{1,40}$/.test(o) && canAsk(me)) setAsking({ convo: o.slice(5) }); };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, []);
  const tab = tabs.some((t) => t.id === want) ? want : 'today';
  useEffect(() => put('openhouse.phone.tab', tab), [tab]);
  // The app showing, and the last few shown: they stay running, hidden, so going back to one is instant (four at most).
  const showing = opened || tabs.find((t) => t.id === tab)?.app || null;
  const [alive, setAlive] = useState([]);
  useEffect(() => { if (showing) setAlive((l) => [showing, ...l.filter((a) => a.id !== showing.id)].slice(0, 4)); }, [showing?.id, showing?.v]);
  // Each tab's app files, fetched in the background a moment after the page opens (kept by version, so only what
  // changed), one at a time: a tab opened the first time doesn't wait for them.
  const tabApps = tabs.map((t) => t.app).filter(Boolean).map((a) => `${a.id}@${a.v}`).join(',');
  useEffect(() => {
    if (!tabApps) return;
    let stop = false;
    const t = setTimeout(async () => { for (const t of tabs) if (t.app && !stop) await appBundle(c, t.app).catch(() => {}); }, 2500);
    return () => { stop = true; clearTimeout(t); };
  }, [c, tabApps]);
  const [home, setHome] = useState(wantsHome);
  // On the Wi-Fi's page: once it knows the household's installable copy, go there (it works at home too).
  const link = !CLOUD_RELAY && mobile && !setup && cloudLink(me);
  useEffect(() => { if (link) location.replace(link); }, [link]);
  if (link) return <main className="join"><div className="brand">Opie</div><h1>One moment</h1></main>;
  if (setup) return <SetupFlow me={me} c={c} h={h} onDone={() => { put(DONE, true); setSetup(false); }} />;
  if (home) return <AddToHome me={me} onLater={() => { put(LATER, true); setHome(false); }} />;
  const ago = h.at ? Math.round((Date.now() - h.at) / 60e3) : null;
  const go = (id) => { setOpened(null); setMore(false); setTab(id); };
  const open = (id) => { if (tabs.some((t) => t.id === id)) return go(id); const a = (apps || []).find((x) => x.id === id); if (a) { setMore(false); setOpened(a); } };
  const bar = tabs.length > 5 ? tabs.slice(0, 4) : tabs;
  const cur = opened ? null : tabs.find((t) => t.id === tab);
  const frames = alive.map((a) => <AppFrame key={a.id} c={c} app={(apps || []).find((x) => x.id === a.id) || a} style={style} hidden={showing?.id !== a.id} onOpen={open} onClose={() => (opened ? setOpened(null) : go('today'))} onQueue={h.later} onRemoved={onRemoved} onBg={onBg} />);
  return (
    <div className={'app' + (canAsk(me) ? ' asks' : '') + (showing ? ' framed' : '') + (style?.palette === 'dusk' ? ' dark' : '')} style={{ ...phoneVars(style, opened ? opened.id : tab), ...(showing && bgs[showing.id] ? { '--fbg': bgs[showing.id] } : {}) }}>
      {h.up === false && <div className="status">{h.house ? `Not in touch with home. Showing what was here ${ago < 2 ? 'a moment' : ago < 90 ? `${ago} min` : `${Math.round(ago / 60)} h`} ago` : 'Not in touch with home yet'}{h.waiting ? `; ${h.waiting === 1 ? 'one change waits' : `${h.waiting} changes wait`} and goes when it's back.` : '.'}</div>}
      {opened && <div className="openbar"><button className="quiet" onClick={() => setOpened(null)}>Back</button><span>{opened.name}</span></div>}
      {frames}
      {showing ? (alive.some((a) => a.id === showing.id) ? null : <div className="page"><p className="soft">Loading…</p></div>)
        : !h.house && tab === 'today' ? <div className="page"><p className="soft">Loading…</p></div>
        : tab === 'today' ? <><Today me={me} h={h} c={c} tabs={tabs} apps={apps} go={open} style={style} onOpen={canAsk(me) ? (id) => setAsking({ convo: id }) : null} /></>
        : tab === 'apps' ? <AppsList apps={apps} tabs={tabs} onOpen={open} />
        : <div className="page"><p className="soft">Loading…</p></div>}
      {canAsk(me) && !asking && !more && (canTalk(talkScopes(me))
        ? <Talk c={c} scopes={talkScopes(me)} onType={() => setAsking(true)} />
        : <button className="opie" onClick={() => setAsking(true)}><span className="bars"><i /><i /><i /><i /></span>Ask Opie</button>)}
      {asking && <Ask key={asking.convo || 'new'} me={me} c={c} convoId={asking.convo || null} onClose={() => setAsking(false)} />}
      <nav>
        {bar.map((t) => <button key={t.id} className={!opened && !more && tab === t.id ? 'here' : ''} onClick={() => go(t.id)}><TabIcon t={t} /><span>{t.name}</span></button>)}
        {bar.length < tabs.length && <button className={more || opened || !bar.some((t) => t.id === tab) ? 'here' : ''} onClick={() => setMore(true)}><MoreIcon /><span>More</span></button>}
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
        <div className="more-head"><div><span className="brand">Opie</span><div className="soft more-foot">{me.person ? `${me.person}'s phone` : 'This phone'}</div></div><button className="quiet" onClick={onClose}>Done</button></div>
        {tabs.map((t) => <button key={t.id} className={'more-row' + (tab === t.id ? ' here' : '')} onClick={() => onGo(t.id)}><TabIcon t={t} /><span>{t.name}</span></button>)}
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
export const cloudLink = (me) => me?.relay?.page && `${me.relay.page}#${pairingHash(me)}`;
const pairingHash = (me) => `${me.id}.${me.key}.${me.relay.relay}.${me.relay.token}.${b64u.enc(JSON.stringify({ person: me.person, scopes: (me.scopes || []).filter((x) => x !== 'setup' || !get(DONE)), kind: 'phone' }))}`;
/** In the iPhone app (its own copy of this page, ios/App/PhonePage.swift): an invite joined here, so the app keeps the
 *  pairing too (its widgets, notes and share sheet use it). */
const tellApp = (w) => { if (IN_APP && w?.relay?.token) try { window.webkit.messageHandlers.joined.postMessage(pairingHash(w)); } catch {} };
function fromCloudHash() {
  const m = location.hash.slice(1).match(/^([\w-]+)\.([\w-]{43})\.([\w-]+)\.([\w-]+)\.([\w-]+)$/);
  if (!m) return null;
  let about = {}; try { about = JSON.parse(b64u.dec(m[5])); } catch {}
  return { id: m[1], key: m[2], person: about.person || '', scopes: about.scopes || [], kind: 'phone', relay: { url: CLOUD_RELAY, relay: m[3], token: m[4] } };
}

function App() {
  const [me, setMe] = useState(() => (CLOUD_RELAY ? fromCloudHash() || get(STORE) : get(STORE))), [removed, setRemoved] = useState(false);
  const [invite] = useState(() => !!CLOUD_RELAY && /^#[\w-]+\.[\w-]{43}\.[\w-]+$/.test(location.hash)); // (Join takes it off the address)
  useEffect(() => { if (CLOUD_RELAY && me) put(STORE, me); }, []);
  const c = useMemo(() => me && (CLOUD_RELAY
    ? client({ id: me.id, key: me.key, relay: me.relay, onlyRelay: true, api: location.origin }) // (the cloud's copy: big replies may come as boxes)
    : client({ id: me.id, key: me.key, relay: me.relay || null, onRelay: (r) => { const n = { ...(get(STORE) || me), relay: r || undefined }; put(STORE, n); setMe(n); } })), [me?.id, me?.relay?.token]);
  if (CLOUD_RELAY && !me && invite) return <Join onJoined={(w) => { put(STORE, w); setMe(w); tellApp(w); }} />; // an invite, opened anywhere
  if (CLOUD_RELAY && !me) return <main className="join"><div className="brand">Opie</div><h1>Not linked to a home yet</h1><p>On the tablet: Settings, Screens, Add a screen, Someone's phone. Scan the code with this phone's camera.</p></main>;
  if (!c) return <Join removed={removed} onJoined={(w) => { setRemoved(false); setMe(w); }} />;
  return <Phone me={me} c={c} onRemoved={() => { put(STORE, null); put(CACHE, null); put(QUEUE, null); setMe(null); setRemoved(true); }} />;
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register(CLOUD_RELAY ? '/h/sw.js' : 'sw.js').then((reg) => {
    // Look for a new version whenever the page comes back (an installed copy is often resumed, not reopened).
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
  // A new version took over (its worker skips waiting and claims this page): load it, but never under someone's hands.
  // Not while a sheet, More or a field (here or in an app's frame) is open; then when the page is next hidden, or idle.
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!had) return; // (the first worker taking over a fresh page: nothing new to load)
    const busy = () => !!document.querySelector('.scrim, .more.open') || /^(INPUT|TEXTAREA|IFRAME)$/.test(document.activeElement?.tagName || '');
    const go = () => { if (document.hidden || !busy()) location.reload(); };
    go();
    const t = setInterval(go, 15e3);
    document.addEventListener('visibilitychange', go);
    void t;
  });
}
addEventListener('hashchange', () => location.reload());
createRoot(document.getElementById('root')).render(<App />);

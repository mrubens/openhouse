// A hub's settings (docs/hub.md, bridge/hub.js): what the tablet's Settings do, in a browser on a device paired as the
// hub's settings device (scope 'admin'). The first one types the code the hub printed when it started; it can add more.
// Every request is sealed to the hub like a screen's (screen-client.js). First the setup (setup-flow.jsx, the steps a
// tablet's phone shows, driven by the hub's bridge: hub-shell.js), then: the "Is this OK?" cards, the household's
// devices, calendars and albums, the Opie account and live voice, their own OpenAI key, the PIN, backups, reaching it
// from away, and updates. With a PIN set, changing settings asks for it first (for 10 minutes).
import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useState } from 'react';
import { pair, client, Removed } from './screen-client.js';
import { pairingFromCode } from './scrypt.js';
import { Asks } from './asks.jsx';
import { SetupFlow, AddLink, AddKey, SignIns, GooglePhotosHere, onTheHub } from './setup-flow.jsx';

onTheHub();

const STORE = 'openhouse.hub';
const get = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const put = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const ago = (t) => { if (!t) return 'not yet'; const m = Math.round((Date.now() - t) / 60e3); return m < 2 ? 'just now' : m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

function Join({ onJoined }) {
  const [code, setCode] = useState(''), [step, setStep] = useState('none');
  async function go(e) {
    e.preventDefault();
    const via = pairingFromCode(code); if (!via) return setStep('bad');
    setStep('joining');
    try {
      const w = await pair({ ...via, name: /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'A phone' : 'A computer' });
      if (w.refused) return setStep('bad');
      put(STORE, w);
      if (!get('openhouse.screen')) put('openhouse.screen', w); // the home screen on this device too, with the same pairing
      onJoined(w);
    } catch { setStep('bad'); }
  }
  return (
    <main className="join">
      <div className="brand">Opie hub</div>
      <h1>Type the hub's code</h1>
      <p>It's in the hub's log when it starts (<code>docker logs openhouse</code>, or <code>journalctl -u openhouse</code> on a Pi), and in <code>hub-setup.txt</code> in its data folder.</p>
      <form onSubmit={go}>
        <input className="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX" autoCapitalize="characters" autoComplete="off" spellCheck="false" />
        <button className="go" disabled={step === 'joining' || code.replace(/[^0-9a-z]/gi, '').length !== 12}>{step === 'joining' ? 'Joining…' : 'Join'}</button>
      </form>
      {step === 'bad' && <p className="soft">That code didn't work. A code works once; the hub prints a new one each time it starts while it has no settings device, or run <code>hub/owner-code.sh</code>.</p>}
    </main>
  );
}

/** One GET, again every few seconds; and a POST that then reloads it. */
function useGet(c, p, every = 0, onRemoved) {
  const [v, setV] = useState(null), [n, setN] = useState(0);
  useEffect(() => {
    let stop = false, t = null;
    const load = async () => {
      try { const r = await c.json('GET', p); if (!stop) setV(r.status === 200 ? r.json : { error: r.json?.error || r.status }); }
      catch (e) { if (e instanceof Removed) return onRemoved(); if (!stop) setV((x) => x || { error: 'offline' }); }
      if (every && !stop) t = setTimeout(load, every);
    };
    load();
    return () => { stop = true; clearTimeout(t); };
  }, [c, p, n]);
  return [v, () => setN((x) => x + 1)];
}

function Devices({ c, onRemoved }) {
  const [s, reload] = useGet(c, '/screens', 4000, onRemoved);
  const [adding, setAdding] = useState(null), [who, setWho] = useState(''), [grown, setGrown] = useState(true), [tv, setTv] = useState(''), [err, setErr] = useState('');
  const base = location.origin;
  async function add(kind) {
    setErr('');
    const b = kind === 'phone' ? { kind: 'phone', person: who.trim(), grownup: grown, code: true } : kind === 'tv' ? { kind: 'tv', code: tv } : kind === 'computer' ? { kind: 'computer' } : { code: true, ...(kind === 'admin' ? { admin: true } : {}) };
    const r = await c.json('POST', '/screens/pair', b);
    if (r.status !== 200) return setErr(r.json?.error || 'That didn\'t work.');
    if (kind === 'tv') { setTv(''); setAdding(null); return reload(); }
    if (kind === 'computer') return setAdding({ kind, code: r.json.code, link: null, page: null });
    const page = kind === 'phone' ? `/phone/?for=${encodeURIComponent(who.trim())}` : kind === 'admin' ? '/hub/' : '/screen/';
    setAdding({ kind, code: r.json.code, link: `${base}${page}#${r.json.pair}.${r.json.key}`, page: base + page.replace(/\?.*$/, '') });
  }
  const answer = async (p, yes) => { await c.json('POST', '/screens/answer', { pair: p, yes }); reload(); };
  const revoke = async (id, name) => { if (!confirm(`Remove ${name}? It stops reaching the hub at once.`)) return; await c.json('POST', '/screens/revoke', { id }); reload(); };
  return (
    <section>
      <h2>Phones, computers and TVs</h2>
      {(s?.asking || []).map((a) => (
        <div className="card ask" key={a.pair}><div className="t">{a.name} asks to join{a.person ? ` as ${a.person}'s phone` : ''}</div>
          <div className="btns"><button className="go small" onClick={() => answer(a.pair, true)}>Allow</button><button className="plain" onClick={() => answer(a.pair, false)}>Not now</button></div></div>
      ))}
      <ul className="list">
        {(s?.screens || []).map((d) => (
          <li key={d.id}><div><div>{d.name}{d.scopes?.includes('admin') ? ' (settings)' : ''}</div><div className="soft small">{d.kind === 'phone' ? `${d.person}'s phone` : d.kind === 'computer' ? 'AI app on a computer' : d.kind === 'tv' ? 'TV' : 'Screen'} · seen {ago(d.seen)}{d.scopes?.includes('voice') ? ' · can talk to Opie' : ''}</div></div>
            <button className="plain" onClick={() => revoke(d.id, d.name)}>Remove</button></li>
        ))}
      </ul>
      {adding?.code ? (
        <div className="card">
          <div className="t">{adding.kind === 'phone' ? `${who}'s phone` : adding.kind === 'admin' ? 'Another settings device' : adding.kind === 'computer' ? "Someone's AI app" : 'A screen or computer'}</div>
          {adding.kind === 'computer' ? <p>In Claude or ChatGPT's Opie connector (docs/workshop-mcp.md), pair with <b className="mono">{adding.code}</b>.</p> : <>
          <p>On it, open <b>{adding.page}</b> and type <b className="mono">{adding.code}</b>, or open this link there:</p>
          <p className="mono small break">{adding.link}</p></>}
          <p className="soft small">For 10 minutes. {adding.kind === 'admin' ? 'It joins as soon as the code is typed.' : 'Then say yes here when it asks.'}</p>
          <button className="plain" onClick={() => { setAdding(null); setWho(''); }}>Done</button>
        </div>
      ) : adding === 'phone' ? (
        <div className="card">
          <div className="t">Whose phone?</div>
          <input className="field" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Name" />
          <label className="check"><input type="checkbox" checked={grown} onChange={(e) => setGrown(e.target.checked)} /> A grown-up (asks and talks to Opie; a kid's phone only sees and ticks)</label>
          <div className="btns"><button className="go small" disabled={!who.trim()} onClick={() => add('phone')}>Make a code</button><button className="plain" onClick={() => setAdding(null)}>Cancel</button></div>
        </div>
      ) : adding === 'tv' ? (
        <div className="card">
          <div className="t">A TV</div>
          <p className="soft small">On the TV's browser open {base}/tv, then type the code it shows.</p>
          <input className="field mono" value={tv} onChange={(e) => setTv(e.target.value)} placeholder="XXXX-XXXX-XXXX" autoCapitalize="characters" />
          <div className="btns"><button className="go small" onClick={() => add('tv')}>Add the TV</button><button className="plain" onClick={() => setAdding(null)}>Cancel</button></div>
        </div>
      ) : (
        <div className="btns wrap">
          <button className="pill" onClick={() => setAdding('phone')}>Someone's phone</button>
          <button className="pill" onClick={() => add('screen')}>A screen or laptop</button>
          <button className="pill" onClick={() => setAdding('tv')}>A TV</button>
          <button className="pill" onClick={() => add('admin')}>Another settings device</button>
          <button className="pill" onClick={() => add('computer')}>Claude or ChatGPT on a computer</button>
        </div>
      )}
      {err && <p className="soft">{err}</p>}
    </section>
  );
}

function Account({ c, onRemoved }) {
  const [s, reload] = useGet(c, '/cloud/status', 0, onRemoved), [v, reloadV] = useGet(c, '/cloud/voice', 0, onRemoved), [relay, reloadR] = useGet(c, '/relay', 0, onRemoved);
  const [err, setErr] = useState('');
  useEffect(() => { if (!s?.linking) return; const t = setInterval(reload, 3000); return () => clearInterval(t); }, [s?.linking?.display]);
  const post = async (p, b, then) => { setErr(''); const r = await c.json('POST', p, b); if (r.status !== 200) setErr(r.json?.error || 'That didn\'t work.'); then(); };
  return (
    <section>
      <h2>Opie account</h2>
      {!s ? <p className="soft">…</p> : s.linked ? (
        <div className="card"><div className="t">Linked{s.family ? ` to ${s.family.name || 'your family'}` : ''}</div>
          <p className="soft small">Live voice, typed questions, cloud backups and reaching the hub from away go through it.</p>
          <label className="check"><input type="checkbox" checked={!!v?.on} onChange={(e) => post('/cloud/voice', { on: e.target.checked }, reloadV)} /> Live voice: talk to Opie from phones and computers</label>
          <label className="check"><input type="checkbox" checked={!!relay?.on} onChange={(e) => post('/relay', { on: e.target.checked }, reloadR)} /> Reach the hub from away from home</label>
          <button className="plain" onClick={() => confirm('Unlink the hub from the account? Live voice and cloud backups stop.') && post('/cloud/unlink', {}, reload)}>Unlink</button></div>
      ) : s.linking?.confirm ? (
        <div className="card"><div className="t">Link to {s.linking.confirm.family || 'this account'}?</div>
          <p className="soft small">{s.linking.confirm.by || 'Someone'} entered the code.</p>
          <button className="go small" onClick={() => post('/cloud/link/confirm', { ok: true }, reload)}>Link</button>
          <button className="plain" onClick={() => post('/cloud/link/confirm', { ok: false }, reload)}>No</button></div>
      ) : s.linking ? (
        <div className="card"><div className="t">Type this code at {s.linking.url}</div><p className="mono big">{s.linking.display}</p>
          <button className="plain" onClick={() => post('/cloud/link/cancel', {}, reload)}>Cancel</button></div>
      ) : (
        <div className="card"><p className="soft small">Optional. Without it the hub still keeps the household's day, lists and apps, on the home network.</p>
          <button className="go small" onClick={() => post('/cloud/link/start', { name: 'Home hub' }, reload)}>Link to an account</button></div>
      )}
      <OwnAddress c={c} onRemoved={onRemoved} />
      {err && <p className="soft">{err}</p>}
    </section>
  );
}

/** Claude and ChatGPT's connector at the household's own https address, with no Opie cloud (web-mcp.js). */
function OwnAddress({ c, onRemoved }) {
  const [w, reload] = useGet(c, '/webmcp', 0, onRemoved), [addr, setAddr] = useState('');
  if (!w || w.error) return null;
  const set = async (on) => { await c.json('POST', '/webmcp', on ? { on: true, url: addr.trim() } : { on: false }); reload(); };
  return w.on
    ? <div className="card"><div className="t">The connector at {w.url}</div><p className="soft small">Claude and ChatGPT reach the hub there (port {w.port} on this machine).</p><button className="plain" onClick={() => set(false)}>Turn off</button></div>
    : <div className="card"><div className="t">Or at your own address</div><p className="soft small">For Claude or ChatGPT with no account: an https address that reaches port {w.port} here (a Tailscale Funnel, a tunnel).</p>
      <input className="field" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="https://hub.example.ts.net" /><button className="pill" disabled={!/^https:\/\//.test(addr.trim())} onClick={() => set(true)}>Use it</button></div>;
}

function Backups({ c, onRemoved }) {
  const [s, reload] = useGet(c, '/backup/status', 0, onRemoved), [code, setCode] = useState(null), [list, setList] = useState(null), [err, setErr] = useState('');
  useEffect(() => { if (!s?.job) return; const t = setTimeout(reload, 2000); return () => clearTimeout(t); }, [s?.job?.step]);
  const post = async (p, b) => { setErr(''); const r = await c.json('POST', p, b); if (r.status !== 200) setErr(r.json?.error || 'That didn\'t work.'); reload(); return r; };
  async function turn(id, on) { await post('/backup/dest', { id, on }); if (on) { const r = await c.json('GET', '/backup/recovery-code'); if (r.status === 200 && r.json?.code) setCode(r.json.code); } }
  return (
    <section>
      <h2>Backups</h2>
      {code && <div className="card"><div className="t">The recovery code</div><p className="mono big">{code}</p>
        <p className="soft small">Backups are locked with it, here on the hub. Write it down and keep it away from the hub: without it, no one can open them, us included.</p>
        <button className="go small" onClick={async () => { await post('/backup/recovery-code/confirmed', {}); setCode(null); }}>I've written it down</button></div>}
      {(s?.dests || []).map((d) => (
        <label className="check" key={d.id}><input type="checkbox" checked={d.on} onChange={(e) => turn(d.id, e.target.checked)} /> {d.label}{d.name ? ` (${d.name})` : ''}{!d.ready && d.why ? <span className="soft small"> · {d.why}</span> : ''}{d.last ? <span className="soft small"> · last {d.last.ok ? 'backed up' : 'failed'} {ago(Date.parse(d.last.at))}</span> : ''}</label>
      ))}
      <OwnStorage d={(s?.dests || []).find((d) => d.id === 'bucket')} post={post} onOn={() => turn('bucket', true)} />
      {s?.key?.has && !s.key.confirmed && !code && <button className="plain" onClick={async () => { const r = await c.json('GET', '/backup/recovery-code'); if (r.json?.code) setCode(r.json.code); }}>Show the recovery code</button>}
      <div className="btns">
        <button className="pill" disabled={!!s?.job || !(s?.dests || []).some((d) => d.on)} onClick={() => post('/backup/now', {})}>{s?.job ? 'Backing up…' : 'Back up now'}</button>
        <button className="pill" onClick={async () => { const r = await c.json('GET', '/backup/list'); setList(r.json?.backups || r.json?.items || r.json || []); }}>Backups kept</button>
      </div>
      {Array.isArray(list) && <ul className="list">{list.length ? list.map((b) => <li key={b.dest + b.id}><div>{new Date(b.createdAt).toLocaleString()} <span className="soft small">{b.kind} · {Math.round(b.size / 1024)} KB · {b.dest}</span></div>
        <button className="plain" onClick={() => confirm('Put the household back as it was then? What is here now is kept aside until the next backup.') && post('/backup/restore', { dest: b.dest, id: b.id, deviceId: b.deviceId })}>Restore</button></li>) : <li className="soft">None yet.</li>}</ul>}
      {err && <p className="soft">{err}</p>}
    </section>
  );
}

/** The household's own storage bucket (S3 and the like): typed here, then checked and kept by the hub's keeper, never
 *  here or in the bridge (hub/s3.mjs). Its secret isn't shown again. */
const STORAGE_FIELDS = [['endpoint', 'Address, like https://s3.us-east-1.amazonaws.com'], ['region', 'Region (us-east-1)'], ['bucket', 'Bucket'],
  ['prefix', 'Folder (optional)'], ['keyId', 'Access key ID'], ['secret', 'Secret access key']];
function OwnStorage({ d, post, onOn }) {
  const [f, setF] = useState({}), [open, setOpen] = useState(false), [st, setSt] = useState(null);
  if (!d) return null;
  if (d.ready) return <button className="plain" onClick={() => confirm('Forget your own storage? Backups already there stay there.') && post('/backup/storage/remove', {})}>Forget your own storage</button>;
  if (!open) return <button className="plain" onClick={() => setOpen(true)}>Set up your own storage</button>;
  async function check() {
    setSt('…');
    const r = await post('/backup/storage', f);
    setSt(null); if (r.status === 200) { setF({}); setOpen(false); onOn(); } // (else Backups says what's wrong)
  }
  return <div className="card"><div className="t">Your own storage</div>
    <p className="soft small">Any storage that works like Amazon S3: a bucket, and a key that can read, write and delete in it.</p>
    {STORAGE_FIELDS.map(([k, label]) => <input key={k} className="field" type={k === 'secret' ? 'password' : 'text'} value={f[k] || ''} onChange={(e) => { setF({ ...f, [k]: e.target.value }); setSt(null); }}
      placeholder={label} autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false} />)}
    <button className="pill" disabled={st === '…' || !f.endpoint || !f.bucket || !f.keyId || !f.secret} onClick={check}>{st === '…' ? 'Checking…' : 'Check and use it'}</button>
    </div>;
}

function Updates({ c, onRemoved }) {
  const [h, reload] = useGet(c, '/hub', 0, onRemoved), [msg, setMsg] = useState('');
  if (!h || h.error) return null;
  return (
    <section>
      <h2>This hub</h2>
      <p>Version {h.version}{h.https ? ' · https' : ''}</p>
      {h.back && !h.updating && <button className="plain" onClick={async () => { if (!confirm('Go back to the version before the last update? The hub restarts.')) return; const r = await c.json('POST', '/hub/update', { back: true }); setMsg(r.json?.ok ? 'Going back. This page comes back by itself.' : r.json?.error || 'That didn\'t work.'); setTimeout(reload, 15e3); }}>Go back to the version before</button>}
      {h.update?.how === 'git' ? <button className="pill" disabled={!!h.updating && !h.updating.failed} onClick={async () => { const r = await c.json('POST', '/hub/update', {}); setMsg(r.json?.ok ? 'Updating. The hub restarts when it has the new version; this page comes back by itself.' : r.json?.error || 'That didn\'t work.'); setTimeout(reload, 15e3); }}>Update now</button>
        : h.update?.how === 'image' ? <p className="soft small">It runs from a Docker image: update it where it runs, with <code>{h.update.command}</code>.</p> : null}
      {h.updating?.failed && <p className="soft">The last update didn't finish: see update.log in the hub's data folder.</p>}
      {msg && <p className="soft">{msg}</p>}
    </section>
  );
}

/** The calendars and iCloud albums the keeper holds (without their links), and adding one by its link. */
function Calendars({ c, k, onRemoved }) {
  const [l, reload] = useGet(c, '/hub/calendars', 0, onRemoved), [h] = useGet(c, '/house', 0, onRemoved), [sync, reloadSync] = useGet(c, '/calendar/sync', 0, onRemoved), [adding, setAdding] = useState(null);
  const remove = async (what, id, name) => { if (!confirm(`Remove ${name}?`)) return; await c.json('POST', `/hub/${what}/remove`, { id }); reload(); };
  if (k?.error) return <section><h2>Calendars and photos</h2><p className="soft">{k.error}</p></section>;
  return (
    <section className="setup">
      <h2>Calendars and photos</h2>
      <ul className="list">
        {(l?.calendars || []).map((x) => <li key={x.id}><div><div>{x.name || (x.who ? `${x.who}'s calendar` : 'A calendar')}</div>{x.problem && <div className="soft small">{x.problem}</div>}</div><button className="plain" onClick={() => remove('calendar', x.id, x.name || 'this calendar')}>Remove</button></li>)}
        {(l?.albums || []).map((x, i) => <li key={x.id}><div><div>{(l.albums.length > 1 ? `Shared album ${i + 1}` : 'A shared album')}</div>{x.problem && <div className="soft small">{x.problem}</div>}</div><button className="plain" onClick={() => remove('album', x.id, 'this album')}>Remove</button></li>)}
      </ul>
      {(l?.accounts || []).map((a) => <CalendarAccount key={a.id} c={c} a={a} sync={sync} reload={() => { reload(); reloadSync(); }} />)}
      {adding === 'signin' ? <><SignIns c={c} family={h?.family || []} /><button className="plain" onClick={() => { setAdding(null); reload(); reloadSync(); }}>Done</button></>
        : adding === 'google' ? <><GooglePhotosHere c={c} /><button className="plain" onClick={() => setAdding(null)}>Done</button></>
        : adding ? <><AddLink c={c} kind={adding} family={h?.family || []} heading={false} /><button className="plain" onClick={() => { setAdding(null); reload(); }}>Done</button></>
        : <div className="btns wrap"><button className="pill" onClick={() => setAdding('signin')}>Sign in to a calendar</button><button className="pill" onClick={() => setAdding('calendar')}>Add a calendar link</button><button className="pill" onClick={() => setAdding('album')}>Add an iCloud album</button><button className="pill" onClick={() => setAdding('google')}>Photos from Google</button></div>}
    </section>
  );
}

/** A signed-in calendar account (two-way, calendar-sync.js): each of its calendars shown, only read, or off; and signing out. */
const MODES = [['two-way', 'Shown, two-way'], ['read', 'Shown'], ['off', 'Off']];
function CalendarAccount({ c, a, sync, reload }) {
  const cals = (sync?.calendars || []).filter((x) => x.account === a.id);
  const set = async (key, mode) => { await c.json('POST', '/calendar/sync/set', { key, mode }); reload(); };
  const out = async () => { if (!confirm(`Sign out of ${a.name}? Its calendars leave the hub.`)) return; await c.json('POST', '/hub/calendar/account/remove', { id: a.id }); reload(); };
  return (
    <div className="card">
      <div className="t">{a.name}</div>
      <ul className="list">{cals.map((x) => <li key={x.key}><div>{x.name}</div>
        <select value={x.mode} onChange={(e) => set(x.key, e.target.value)}>{MODES.filter(([m]) => m !== 'two-way' || x.canWrite).map(([m, t]) => <option key={m} value={m}>{t}</option>)}</select></li>)}</ul>
      <button className="plain" onClick={out}>Sign out</button>
    </div>
  );
}

/** Google's sign-in, back on this device (chat/hub-back.js sent it here as #gc=… or #g=…): handed to the hub, sealed. */
function GoogleBack({ c, hash, onDone }) {
  const [st, setSt] = useState({ state: 'sending' });
  useEffect(() => {
    let stop = false;
    (async () => {
      if (hash === 'g-no') return setSt({ state: 'error', error: 'Google said no, or it was cancelled.' });
      const cal = hash.startsWith('gc='), v = decodeURIComponent(hash.slice(cal ? 3 : 2));
      const r = await c.json('POST', '/hub/google', cal ? { refresh: v } : { token: v }).catch(() => null);
      if (!r || r.status !== 200) return setSt({ state: 'error', error: r?.json?.error || 'That didn’t work. Try again.' });
      if (cal) return setSt({ state: 'calendars' });
      setSt(r.json);
      while (!stop) { // the photos: picked there, copied here
        await new Promise((ok) => setTimeout(ok, 2500));
        const s = await c.json('GET', '/hub/google-photos').catch(() => null);
        if (s?.json) setSt(s.json);
        if (['done', 'error', 'none'].includes(s?.json?.state)) break;
      }
    })();
    return () => { stop = true; };
  }, []);
  return (
    <main className="join setup">
      <div className="brand">Opie hub</div>
      <h1>Google</h1>
      {st.state === 'sending' || st.state === 'starting' ? <p className="soft">…</p>
        : st.state === 'calendars' ? <p>Signed in. Its calendars show on the hub; choose which in the hub’s settings.</p>
        : st.state === 'picking' ? <><p>Now choose the photos in Google Photos, then come back here.</p><a className="go" href={st.pickerUri + (/autoclose$/.test(st.pickerUri || '') ? '' : '/autoclose')} target="_blank" rel="noopener noreferrer">Choose in Google Photos</a></>
        : st.state === 'copying' ? <p>Copying {st.done || 0} of {st.total || 0}…</p>
        : st.state === 'done' ? <p>{st.total ? `Added ${st.done} ${st.done === 1 ? 'photo' : 'photos'} to Photos.` : 'Nothing was picked.'}</p>
        : <p>{st.error || 'That didn’t work.'}</p>}
      {['calendars', 'done', 'error'].includes(st.state) && <button className="go small" onClick={onDone}>Done</button>}
    </main>
  );
}

/** Their own OpenAI key (kept by the keeper, never here or on this page once sent) and the PIN. */
function Keeper({ c, k, reload }) {
  const [a, setA] = useState(''), [b, setB] = useState(''), [old, setOld] = useState(''), [st, setSt] = useState(null), [pinOpen, setPinOpen] = useState(false);
  const computer = !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (!k || k.error) return null;
  async function setPin() {
    if (a.length < 4) return setSt('4 to 8 digits.');
    if (a !== b) return setSt('The two don’t match.');
    const r = await c.json('POST', '/hub/pin', { pin: a, old });
    if (r.status !== 200) return setSt(r.json?.error || 'That didn’t work.');
    setA(''); setB(''); setOld(''); setSt(null); setPinOpen(false); reload();
  }
  return <>
    <section className="setup">
      <h2>Opie’s AI</h2>
      {k.openai ? <ul className="list"><li><div>Your own OpenAI key</div><button className="plain" onClick={async () => { if (confirm('Remove your key? Opie stops using your OpenAI account at once.')) { await c.json('POST', '/hub/openai/remove', {}); reload(); } }}>Remove</button></li></ul>
        : <AddKey c={c} computer={computer} />}
    </section>
    <section className="setup">
      <h2>PIN</h2>
      {!pinOpen ? <><p className="soft small">{k.pin ? 'Changing settings here asks for it.' : 'With one, changing settings here asks for it first.'}</p><button className="pill" onClick={() => setPinOpen(true)}>{k.pin ? 'Change the PIN' : 'Choose a PIN'}</button></> : <>
        {k.pin && <input className="field" type="password" inputMode="numeric" maxLength={8} value={old} onChange={(e) => setOld(e.target.value.replace(/\D/g, ''))} placeholder="The PIN now" autoComplete="current-password" />}
        <input className="field" type="password" inputMode="numeric" maxLength={8} value={a} onChange={(e) => { setA(e.target.value.replace(/\D/g, '')); setSt(null); }} placeholder="4 to 8 digits" autoComplete="new-password" />
        <input className="field" type="password" inputMode="numeric" maxLength={8} value={b} onChange={(e) => { setB(e.target.value.replace(/\D/g, '')); setSt(null); }} placeholder="Again" autoComplete="new-password" />
        <div className="btns"><button className="pill" onClick={setPin}>Set</button><button className="plain" onClick={() => setPinOpen(false)}>Cancel</button></div>
        {st && <p className="soft">{st}</p>}</>}
    </section>
  </>;
}

/** With a PIN set: this device changes settings only after it (for 10 minutes). */
function Locked({ c, onOpen }) {
  const [pin, setPin] = useState(''), [st, setSt] = useState(null);
  async function go(e) {
    e.preventDefault();
    const r = await c.json('POST', '/hub/unlock', { pin });
    if (r.status === 200) { setPin(''); onOpen(); } else setSt(r.json?.error || 'That didn’t work.');
  }
  return (
    <form className="join" onSubmit={go}>
      <h1>Type the PIN</h1>
      <input className="code" type="password" inputMode="numeric" maxLength={8} value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setSt(null); }} placeholder="PIN" autoComplete="current-password" autoFocus />
      <button className="go" disabled={pin.length < 4}>Open</button>
      {st && <p className="soft">{st}</p>}
    </form>
  );
}

/** The setup, on the hub's first settings device: the same steps a tablet's phone shows, the hub's bridge moving them on. */
function Setup({ me, c, onDone }) {
  const [house, setHouse] = useState({});
  useEffect(() => { let t; const load = () => c.json('GET', '/house').then((r) => r.status === 200 && setHouse(r.json || {})).catch(() => {}); load(); t = setInterval(load, 5000); return () => clearInterval(t); }, [c]);
  return <SetupFlow me={me} c={c} h={{ house }} onDone={onDone} />;
}

function Hub({ me, c, onRemoved }) {
  const admin = !!me.scopes?.includes('admin');
  const [step, setStep] = useState(undefined), [k, reloadK] = useGet(c, '/hub/keeper', 60e3, onRemoved);
  useEffect(() => { if (admin) c.json('GET', '/setup/step').then((r) => setStep(r.status === 200 ? r.json?.step || null : null)).catch(() => setStep(null)); else setStep(null); }, [c]);
  if (step === undefined) return <main className="join"><div className="brand">Opie hub</div><p className="soft">…</p></main>;
  if (step) return <Setup me={me} c={c} onDone={() => { setStep(null); reloadK(); }} />;
  return (
    <div className="app hub">
      <header><span className="brand">Opie hub</span><a className="soft" href="/screen/">Home screen</a></header>
      <div className="page">
        {!admin ? <p>This device isn't one of the hub's settings devices.</p> : <>
          <Asks c={c} />
          {k?.locked ? <Locked c={c} onOpen={reloadK} /> : <>
            <Devices c={c} onRemoved={onRemoved} />
            <Calendars c={c} k={k} onRemoved={onRemoved} />
            <Account c={c} onRemoved={onRemoved} />
            <Keeper c={c} k={k} reload={reloadK} />
            <Backups c={c} onRemoved={onRemoved} />
            <Updates c={c} onRemoved={onRemoved} />
          </>}
        </>}
      </div>
    </div>
  );
}

function App() {
  const [me, setMe] = useState(() => get(STORE));
  const cl = useMemo(() => me && client({ id: me.id, key: me.key, relay: me.relay || null }), [me?.id]);
  const [back, setBack] = useState(() => { const h = location.hash.slice(1); if (/^(g=|gc=|g-no$)/.test(h)) { history.replaceState(null, '', location.pathname); return h; } return null; }); // (no token stays in the address bar)
  if (!cl) return <Join onJoined={setMe} />;
  if (back) return <GoogleBack c={cl} hash={back} onDone={() => setBack(null)} />;
  return <Hub me={me} c={cl} onRemoved={() => { put(STORE, null); setMe(null); }} />;
}

createRoot(document.getElementById('root')).render(<App />);

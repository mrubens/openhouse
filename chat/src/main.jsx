// A conversation page, served by the bridge at /chat/. The display itself talks natively (ui/Overlay.kt); this page is
// kept as the start of a phone page.
import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState, useMemo } from 'react';
import { BRIDGE, Display, segments, buildLine, Prose, SpecView, page, makeApp, streamTurn, stopTurn, MicIcon } from './answer.jsx';

let lastContext = () => '';
page.context = () => lastContext();
page.afterBuild = () => setTimeout(() => Display.closeChat(), 900);
export async function pin(title, text, conversation) {
  await fetch(BRIDGE + '/board/pin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, text, conversation }) }).catch(() => {});
}

// --- the page ------------------------------------------------------------------------
const STARTERS = ['How do I make pasta from scratch?', 'What’s a fun rainy-day craft for kids?', 'Plan three easy dinners for this week', 'Explain why the sky is blue'];

function App() {
  const [convo, setConvo] = useState(null); // {id, turns:[{role,text}]}
  const [live, setLive] = useState(null); // the turn in progress: {status, text, started}
  const [input, setInput] = useState('');
  const [apps, setApps] = useState([]);
  const [history, setHistory] = useState(null);
  const [now, setNow] = useState(Date.now());
  const scroller = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => { fetch(BRIDGE + '/apps').then((r) => r.json()).then(setApps).catch(() => {}); }, []);
  useEffect(() => { if (!live) return; const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, [!!live]);
  // Keep the latest question at the top of the view so its answer reads from the start.
  useEffect(() => {
    const s = scroller.current, q = s?.querySelectorAll('.you');
    const last = q?.[q.length - 1];
    if (last) s.scrollTop = last.offsetTop - 20;
  }, [convo?.turns.length, convo?.id]);
  // the shell calls these when the panel is shown again
  const warm = () => fetch(BRIDGE + '/chat/warm', { method: 'POST' }).catch(() => {});
  useEffect(() => { warm(); window.onShown = () => { warm(); fetch(BRIDGE + '/apps').then((r) => r.json()).then(setApps).catch(() => {}); }; }, []);

  lastContext = () => {
    const t = convo?.turns || [];
    return t.slice(-6).map((x) => `${x.role === 'user' ? 'Family' : 'Assistant'}: ${x.text}`).join('\n\n');
  };

  async function ask(text) {
    text = text.trim();
    if (!text || live) return;
    setInput(''); inputRef.current?.blur();
    const turns = [...(convo?.turns || []), { role: 'user', text }];
    setConvo((c) => ({ ...(c || {}), turns }));
    setLive({ status: 'Thinking', text: '', started: Date.now() });
    const ctl = new AbortController(); abortRef.current = ctl;
    const r = await streamTurn({ id: convo?.id, text, signal: ctl.signal, on: {
      start: (id) => setConvo((c) => ({ ...c, id })),
      status: (st) => setLive((l) => ({ ...l, status: st })),
      text: (t) => setLive((l) => ({ ...l, text: t })),
    } });
    const { id, ok } = r, finalText = r.text;
    abortRef.current = null;
    setLive(null);
    setConvo((c) => ({ ...c, id, turns: [...turns, { role: 'assistant', text: finalText, failed: !ok }] }));
    const build = ok && buildLine(finalText);
    if (build) makeApp(build, lastContext() + `\n\nFamily: ${text}`);
  }
  page.ask = ask;
  window.openConvo = (cid) => openConvo(cid); // the shell, for "Open" on a board card

  async function openHistory() {
    const list = await fetch(BRIDGE + '/chats').then((r) => r.json()).catch(() => []);
    setHistory(list);
  }
  async function openConvo(cid) {
    const c = await fetch(BRIDGE + '/chats/' + cid).then((r) => r.json()).catch(() => null);
    if (c) setConvo({ id: c.id, turns: c.turns });
    setHistory(null);
  }
  function newConvo() { if (!live) { setConvo(null); setHistory(null); } }

  const turns = convo?.turns || [];
  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) Display.closeChat(); }}>
      <div className="panel">
        <header>
          <div className="title"><span className="spark"><MicIcon /></span>{convo ? (turns[0]?.text || '').slice(0, 60) : 'Ask me anything'}</div>
          <div className="hbtns">
            <button className="ghost" onClick={openHistory}>Earlier</button>
            {convo && <button className="ghost" onClick={newConvo}>New</button>}
            <button className="close" onClick={() => Display.closeChat()} aria-label="Close">×</button>
          </div>
        </header>

        <div className="scroll" ref={scroller}>
          {history ? (
            <div className="history">
              <h2>Earlier conversations</h2>
              {!history.length && <p className="muted">Nothing yet.</p>}
              {history.map((h) => (
                <button key={h.id} className="hist" onClick={() => openConvo(h.id)}>
                  <span>{h.title}</span><span className="muted">{ago(h.updated)}</span>
                </button>
              ))}
            </div>
          ) : !turns.length ? (
            <div className="empty">
              <h1>Hi! What can I help with?</h1>
              <p className="muted">Ask a question, get a recipe with timers, plan the week — or ask me to make an app.</p>
              <div className="starters">{STARTERS.map((s) => <button key={s} className="chip big" onClick={() => ask(s)}>{s}</button>)}</div>
              {!!apps.length && <>
                <div className="label">Apps</div>
                <div className="apps">
                  {apps.map((a) => (
                    <button key={a.id} className="app" onClick={() => { Display.openApp(a.id); Display.closeChat(); }}>
                      <span className="ic">{(a.meta?.name || a.id).slice(0, 1).toUpperCase()}</span><span className="nm">{a.meta?.name || a.id}</span>
                    </button>
                  ))}
                </div>
              </>}
            </div>
          ) : (
            <div className="turns">
              {turns.map((t, i) => t.role === 'user'
                ? <div key={i} className="you">{t.text}</div>
                : <Answer key={i} text={t.text} failed={t.failed} question={turns[i - 1]?.text} convo={convo?.id} />)}
              {live && (
                <div className="answer">
                  {live.text ? segments(live.text).map((s, j) => s.kind === 'text'
                    ? <Prose key={j} text={s.text} />
                    : <SpecView key={j} src={s.src} done={s.done} />) : null}
                  <div className="status"><span className="dots"><i /><i /><i /></span>{live.status}… <span className="muted">{Math.round((now - live.started) / 1000)}s</span>
                    <button className="ghost small" onClick={() => { abortRef.current?.abort(); stopTurn(convo?.id); }}>Stop</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <form className="ask" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
          <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} placeholder={turns.length ? 'Ask a follow-up…' : 'Ask anything…'} enterKeyHint="send" />
          <button className="send" disabled={!input.trim() || !!live}>Ask</button>
        </form>
      </div>
    </div>
  );
}

function Answer({ text, failed, question, convo }) {
  const segs = useMemo(() => segments(text), [text]);
  const [pinned, setPinned] = useState(false);
  const hasUI = segs.some((s) => s.kind === 'spec');
  const build = buildLine(text);
  return (
    <div className={'answer' + (failed ? ' failed' : '')}>
      {segs.map((s, j) => s.kind === 'text' ? <Prose key={j} text={s.text} /> : <SpecView key={j} src={s.src} done />)}
      {build && <div className="building-app">Building: {build}</div>}
      {hasUI && !build && (
        <div className="keep">
          <button className="ghost" disabled={pinned} onClick={() => { pin(question || 'Pinned', text, convo); setPinned(true); }}>{pinned ? 'On the door' : 'Stick it on the door'}</button>
          <button className="ghost" onClick={() => makeApp('Turn this answer into an app on the display, keeping its content and layout. Add a tile for it on the home screen.', lastContext())}>Make it an app</button>
        </div>
      )}
    </div>
  );
}

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

createRoot(document.getElementById('root')).render(<App />);

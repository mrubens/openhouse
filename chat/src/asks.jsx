// A hub's "Is this OK?" cards (bridge/hub-shell.js hubAsks, docs/hub.md): what a tablet asks someone standing at it,
// asked on the hub's settings devices and grown-ups' phones. A card that needs the PIN asks for it here. On a tablet
// (no /hub/asks) it asks once and stops.
import { useEffect, useState } from 'react';

export function Asks({ c }) {
  const [asks, setAsks] = useState([]), [pin, setPin] = useState({}), [err, setErr] = useState({}), [n, setN] = useState(0);
  useEffect(() => {
    let stop = false, t = null;
    const look = async () => {
      try {
        const r = await c.json('GET', '/hub/asks');
        if (r.status === 403 || r.status === 404) return; // not a hub, or not this device's
        if (!stop && r.status === 200) setAsks(r.json?.asks || []);
      } catch {}
      if (!stop) t = setTimeout(look, 3000);
    };
    look();
    return () => { stop = true; clearTimeout(t); };
  }, [c, n]);
  if (!asks.length) return null;
  async function answer(x, b) {
    const r = await c.json('POST', '/hub/asks/answer', { id: x.id, ...b, pin: pin[x.id] || '' }).catch(() => null);
    setErr({ ...err, [x.id]: r?.status === 200 ? '' : r?.json?.error || 'That didn’t work.' });
    if (r?.status === 200) setAsks(asks.filter((a) => a.id !== x.id));
    setN(n + 1);
  }
  return (
    <section className="asks-cards">
      {asks.map((x) => (
        <div className="card ask" key={x.id}>
          <div className="t">{x.title}</div>
          {x.detail && <p className="soft small pre">{x.detail}</p>}
          {x.rights?.length > 0 && <ul className="rights small">{x.rights.map((r, i) => <li key={i}>{r.text}</li>)}</ul>}
          {x.more && <details className="small"><summary className="soft">More</summary><p className="pre">{x.more}</p></details>}
          {x.pin && <input className="field" type="password" inputMode="numeric" maxLength={8} autoComplete="off" placeholder="PIN" value={pin[x.id] || ''} onChange={(e) => setPin({ ...pin, [x.id]: e.target.value.replace(/\D/g, '') })} />}
          <div className="btns">
            <button className="go small" disabled={x.pin && (pin[x.id] || '').length < 4} onClick={() => answer(x, { yes: true })}>{x.yes}</button>
            <button className="plain" onClick={() => answer(x, { yes: false })}>{x.no || 'No'}</button>
            {x.later && <button className="plain" onClick={() => answer(x, { yes: false, later: true })}>Not now</button>}
          </div>
          {err[x.id] && <p className="soft">{err[x.id]}</p>}
        </div>
      ))}
    </section>
  );
}

// What the screens hear about the agent at work: one event stream (GET /events, SSE) with the state
// (idle or working, what was asked) and its steps. A screen that connects mid-run gets the steps so far.
//
// GET  /events                 SSE stream of progress events
// GET  /state                  current state as JSON
export function eventStream() {
  const clients = new Set();
  const history = []; // replayed to clients that connect mid-run
  const ev = {
    state: { state: 'idle', request: null, who: null, base: null, startedAt: null },
    emit(e) {
      e.t = Date.now();
      if (e.type === 'ack') history.length = 0;
      history.push(e);
      if (history.length > 400) history.shift();
      const data = `data: ${JSON.stringify(e)}\n\n`;
      for (const res of clients) res.write(data);
      if (e.type !== 'delta' && e.type !== 'writing') console.log(`[${e.type}]`, e.text ?? e.state ?? e.name ?? '');
    },
    setState(patch) {
      ev.state = { ...ev.state, ...patch };
      ev.emit({ type: 'state', ...ev.state });
    },
    /** GET /events and /state; false for anything else. */
    handle(req, res, url, json) {
      if (url.pathname === '/state') { json(res, 200, ev.state); return true; }
      if (url.pathname !== '/events') return false;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'state', ...ev.state, t: Date.now() })}\n\n`);
      if (ev.state.state !== 'idle') for (const e of history) res.write(`data: ${JSON.stringify(e)}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return true;
    },
  };
  return ev;
}

// One request that throws answers with an error; it never stops the bridge (server.js, screens.js, web-mcp.js).
// An address that isn't one (new URL throws) is the asker's mistake: 400. Anything else: 500, and it's logged.

/** handler(req, res), sync or async, wrapped for http.createServer. */
export function guarded(tag, handler) {
  return (req, res) => {
    let out;
    try { out = handler(req, res); } catch (e) { return fail(tag, req, res, e); }
    if (out && typeof out.catch === 'function') out.catch((e) => fail(tag, req, res, e));
  };
}

function fail(tag, req, res, e) {
  const bad = e?.code === 'ERR_INVALID_URL';
  if (!bad) console.error(`[${tag}] ${req.method} ${String(req.url).slice(0, 200)} failed:`, e?.stack || e);
  try {
    if (!res.headersSent) { res.writeHead(bad ? 400 : 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: bad ? 'bad address' : 'failed' })); }
    else res.destroy();
  } catch {}
}

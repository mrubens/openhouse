// Live voice in a browser (a phone, a laptop, an old tablet; docs/hub.md): tap to talk to Opie. The session itself is
// chat/live/live-session.cjs, the same copy the tablet's LiveVoice.kt runs; this is its Host, the part the tablet does
// in Kotlin, with every request sealed to the hub the way the rest of this device's are (screen-client.js):
//   GET  /live/setup     the household's tools, rules and what was said lately
//   POST /live/start     the WebRTC offer, through OpenHouse cloud (it holds OpenAI's key): OpenAI's answer back
//   POST /live/tool      one of the household's tools, run by the hub
//   POST /live/said      what was heard and said, kept on the hub for half an hour (the next conversation knows it)
//   POST /live/usage     how long it ran, for the household's allowance
// Audio goes between this browser and OpenAI. A browser lets a page use the microphone only on https or localhost, so on
// the Wi-Fi's plain http address `available()` is false and the button isn't shown.
import { liveSession } from '../live/live-session.cjs';

export const available = () => !!(globalThis.isSecureContext && navigator.mediaDevices?.getUserMedia && globalThis.RTCPeerConnection);

/**
 * Start a session now (from a tap: browsers only let sound start from one).
 * on: {state(mood, said), level(mic, out), problem(text), ended(why)}. Returns {stop()}.
 */
export function talk(c, on = {}) {
  let S = null, closed = false, idleS = 8;
  const log = (t) => { if (globalThis.OPENHOUSE_LIVE_DEBUG) console.debug('[live]', t); };
  const setup = c.json('GET', '/live/setup').then((r) => (r.status === 200 ? r.json : null)).catch(() => null);
  const post = (p, b) => c.json('POST', p, b).then((r) => r.json).catch(() => null);
  const later = (f) => setTimeout(() => { if (S) f(S); }, 0);
  let wasReady = false, told = false;
  const problem = (text) => { told = true; on.problem?.(text); };
  function end(why) {
    if (closed) return; closed = true;
    if (!told && why === 'no microphone') problem('Opie needs the microphone: allow it for this page.');
    else if (!told && !wasReady && why !== 'stopped') problem("Opie couldn't connect. Try again in a moment.");
    try { S?.stop(); } catch {}
    on.ended?.(why);
  }
  const Host = {
    offer: async (sdp) => {
      const s = await setup;
      if (s?.quietS > idleS) idleS = Math.min(30, s.quietS);
      // Only the offer: the hub makes the session's instructions and tools itself (the relay takes only small requests).
      const r = await c.json('POST', '/live/start', { sdp, name: 'Opie', idleTimeoutS: 60 }).catch((e) => { log('start failed: ' + (e?.message || e)); return null; });
      const a = r?.status === 200 && r.json ? r.json : { error: r?.json?.error || "the hub didn't answer" };
      // 'off' (the household hasn't turned talking on) comes as 400 from the bridge or 403 from the service; a 403
      // 'not for screens' is the bridge refusing this device (or a tablet too old to take voice from other devices).
      if (a.error === 'off' || /\boff\b/.test(a.error || '')) problem('Talking to Opie is off. It can be turned on in Settings, Voice.');
      else if (r?.status === 403) problem('The tablet can’t take Opie from this device yet. Update the tablet, then try again.');
      later((x) => x.answer(JSON.stringify(a)));
    },
    // Its text model normally answers (with the household's tools). Handed to us instead: the household's assistant
    // answers as if typed, and the session says it.
    delegated: async (text) => {
      let said = '';
      await c.lines('POST', '/chat', { text, voice: true }, (ev) => { if (ev.type === 'delta') said += ev.text; else if (ev.type === 'reset') said = ''; else if (ev.type === 'done') said = ev.text || said; }).catch(() => {});
      later((x) => x.say(said.replace(/```[\s\S]*?```/g, '').trim() || "Sorry, I couldn't do that just now."));
    },
    tool: async (d, callId, name, args) => {
      let a = {}; try { a = JSON.parse(args); } catch {}
      const r = await post('/live/tool', { name, args: a });
      later((x) => x.toolResult(d, callId, String(r?.text ?? "That didn't work.").slice(0, 6000)));
    },
    usage: (sessionId, seconds, backend) => { if (sessionId) post('/live/usage', { sessionId, seconds, backend: (() => { try { return JSON.parse(backend); } catch { return null; } })() }); },
    said: (event, text) => {
      if (!String(text).trim()) return;
      const role = event === 'live-heard' ? 'user' : event === 'live-said' ? 'assistant' : 'tool';
      const p = post('/live/said', { role, text: String(text).trim().slice(-2000) });
      if (role === 'user') p.then((r) => { if (r?.end) S?.leave(); }); // they want it over (the bridge asked a small model): it says goodbye and goes
    },
    log, mark: log, note: (e, t) => log(e + ': ' + t),
    level: (mic, out) => on.level?.(mic, out),
    gain: () => 1,
    listening: () => true,
    mode: () => 'direct', // the microphone at once: nothing else here was listening
    handoff: () => later((x) => x.goLive()),
    state: (m, said) => on.state?.(m, said),
    ready: (yes) => { if (yes) wasReady = true; },
    unsaid: (t) => { if (String(t).trim()) problem('Opie stopped before it could say all of that.'); },
    unanswered: () => problem("Opie didn't get an answer for that. Try asking again."),
    ended: (why) => end(why),
    idle: () => idleS,
  };
  S = liveSession(Host);
  const cap = setTimeout(() => end('five minutes'), 5 * 60e3);
  return { stop: () => { clearTimeout(cap); end('stopped'); } };
}

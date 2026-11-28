// The live voice session on Google's Gemini Live (the household's own Gemini key: bridge/own-gemini.js), one copy for
// the tablet and every browser, with the same Host as live-session.cjs (OpenAI's): the tablet's LiveVoice.kt or a
// browser's chat/src/live-voice.js. It returns the same calls: feed, goLive, stop, setGain, answer, toolResult, say, leave.
//
// Gemini Live is a WebSocket (aistudio.google.com/docs/live-api): 16 kHz 16-bit PCM in, 24 kHz out, base64 in JSON.
// Host.offer('') asks the bridge to start it; the answer is Google's address, a one-use token the shell got with the
// household's key, and the setup (the household's instructions and tools, made by the bridge). Gemini calls the
// household's tools itself (toolCall); each is run by the host (Host.tool) and answered (toolResponse). Barge-in is
// Google's: on `interrupted` what's still to play is dropped. The microphone goes through Chromium's echo cancelling
// (getUserMedia echoCancellation), so it shouldn't hear itself; that is to be checked on each device.
function geminiSession(Host) {
  let ws = null, sessionId = '', started = false, closed = false, n = 0, heard = '', queue = [], sayTimer = null, pend = [], t0 = Date.now(), readyAt = 0;
  const names = {}; // tool call id -> its name (Gemini's toolResponse names it again)
  // What Google counted (usageMetadata): kept per turn, added up as each turn completes (Google bills each turn for the
  // whole conversation so far), and reported when the session ends (Host.usage) for the household's monthly stop.
  const backend = { model: 'gemini-3.8-live', audio_in: 0, audio_out: 0, text_in: 0, text_out: 0, searches: 0 };
  let turnUse = null;
  function countUse(u) {
    const by = (list, m) => (list || []).filter((d) => d && d.modality === m).reduce((a, d) => a + (d.tokenCount || 0), 0);
    const ain = by(u.promptTokensDetails, 'AUDIO'), aout = by(u.responseTokensDetails, 'AUDIO');
    turnUse = { audio_in: ain, audio_out: aout,
      text_in: Math.max(0, (u.promptTokenCount || 0) + (u.toolUsePromptTokenCount || 0) - ain),
      text_out: Math.max(0, (u.responseTokenCount || 0) + (u.thoughtsTokenCount || 0) - aout) };
  }
  function turnDone() { if (!turnUse) return; for (const k in turnUse) backend[k] += turnUse[k]; turnUse = null; }
  const send = (m) => { if (started && ws && ws.readyState === 1) ws.send(JSON.stringify(m)); else queue.push(m); };
  const kind = (m) => Object.keys(m).filter((k) => k !== 'usageMetadata')[0] || 'usageMetadata';
  let lastType = '', lastN = 0;
  function logEvent(t, m) { // one line per kind of message, a run of the same counted; why it ended in full, words cut out
    if (t === lastType) { lastN++; return; }
    if (lastN) Host.log('< ' + lastType + ' x' + (lastN + 1));
    lastType = t; lastN = 0;
    Host.log('< ' + t + (t === 'goAway' || t === 'setupComplete' ? ' ' + JSON.stringify(m[t]).slice(0, 200) : ''));
  }

  // Sound: one context at 24 kHz for what it says, one at 16 kHz for the microphone. Levels ~12 times a second.
  let out = null, outGain = null, outAn = null, playAt = 0, playing = [], gain = 1;
  let micCtx = null, mic = null, micAn = null, proc = null, lvlTimer = null; const lvlBuf = new Float32Array(512);
  function analyser(c, node) { try { const a = c.createAnalyser(); a.fftSize = 512; node.connect(a); return a; } catch (e) { Host.log('level: ' + e); return null; } }
  function rms(a) { if (!a) return 0; a.getFloatTimeDomainData(lvlBuf); let s = 0; for (let i = 0; i < lvlBuf.length; i++) s += lvlBuf[i] * lvlBuf[i]; return Math.sqrt(s / lvlBuf.length); }
  let voiceLast = 0;
  function levels() { if (lvlTimer) return; lvlTimer = setInterval(() => { if (closed) { clearInterval(lvlTimer); return; } const o = rms(outAn); if (o > 0.006) voiceLast = Date.now(); Host.level(rms(micAn), o); look(); }, 80); }
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  function play(data) {
    const bin = atob(data), k = bin.length >> 1;
    if (!k) return;
    const buf = out.createBuffer(1, k, 24000), d = buf.getChannelData(0);
    for (let i = 0; i < k; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 32768) v -= 65536; d[i] = v / 32768; }
    const src = out.createBufferSource(); src.buffer = buf; src.connect(outGain);
    const at = Math.max(playAt, out.currentTime + 0.05); src.start(at); playAt = at + buf.duration;
    playing.push(src); src.onended = () => { playing = playing.filter((x) => x !== src); };
  }
  function hush() { for (const s of playing) { try { s.stop(); } catch (e) {} } playing = []; playAt = 0; }
  const mode = Host.mode();

  function begin() {
    try {
      out = new AudioContext({ sampleRate: 24000 }); outGain = out.createGain(); outGain.connect(out.destination); outAn = analyser(out, outGain);
      out.resume().catch(() => {}); setGain(Host.gain()); levels();
      Host.log('gemini, mode ' + mode);
      Host.offer(''); // (no SDP: the bridge answers with where to connect)
      if (mode === 'direct') { handing = true; Host.handoff('at once'); }
    } catch (e) { Host.log('could not start: ' + e); Host.ended('no connection'); }
  }
  function answer(j) {
    let r = {}; try { r = JSON.parse(j); } catch (e) {}
    const g = r && r.gemini;
    if (r.error || !g || !g.url || !g.token) { Host.log('not started: ' + (r.error || 'no answer')); Host.ended('not started'); return; }
    sessionId = r.sessionId || '';
    try { ws = new WebSocket(g.url + '?access_token=' + encodeURIComponent(g.token)); } catch (e) { Host.log('socket: ' + e); Host.ended('not started'); return; }
    ws.onopen = () => { Host.mark('socket open'); ws.send(JSON.stringify({ setup: g.setup })); };
    ws.onmessage = (ev) => {
      const text = typeof ev.data === 'string' ? Promise.resolve(ev.data) : ev.data && ev.data.text ? ev.data.text() : Promise.resolve('');
      text.then((t) => { let m; try { m = JSON.parse(t); } catch (e) { Host.log('bad message'); return; } on(m); });
    };
    ws.onerror = () => Host.log('socket error');
    ws.onclose = (e) => { Host.log('socket closed ' + e.code + ' ' + String(e.reason || '').slice(0, 120)); Host.ready(false); Host.ended(started ? 'closed by Google' + (e.reason ? ': ' + String(e.reason).slice(0, 80) : '') : 'not started'); };
  }
  function begin2() { started = true; readyAt = Date.now(); Host.mark('setup complete'); Host.ready(true); for (const m of queue.splice(0)) ws.send(JSON.stringify(m)); lastAct = Date.now(); quietTimer(); }

  // The microphone, once the tablet's listening has let it go (LiveVoice.handOff): 16 kHz PCM in ~128 ms frames.
  async function goLive() {
    if (closed || mode === 'none') return;
    try {
      const ask = () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      try { mic = await ask(); } catch (e) { Host.log('microphone: ' + e + ', trying again'); await new Promise((r) => setTimeout(r, 400)); mic = await ask(); }
      if (closed) { mic.getTracks().forEach((t) => t.stop()); return; }
      micCtx = new AudioContext({ sampleRate: 16000 });
      const src = micCtx.createMediaStreamSource(mic);
      micAn = analyser(micCtx, src);
      proc = micCtx.createScriptProcessor(2048, 1, 1);
      proc.onaudioprocess = (e) => {
        if (closed || !Host.listening() || leaving) return;
        const x = e.inputBuffer.getChannelData(0), pcm = new Int16Array(x.length);
        for (let i = 0; i < x.length; i++) { const v = Math.max(-1, Math.min(1, x[i])); pcm[i] = v < 0 ? v * 32768 : v * 32767; }
        send({ realtimeInput: { audio: { data: b64(new Uint8Array(pcm.buffer)), mimeType: 'audio/pcm;rate=16000' } } });
      };
      src.connect(proc); proc.connect(micCtx.destination); // (it outputs silence; connected so it runs)
      Host.mark('its own microphone');
    } catch (e) { Host.log('no microphone: ' + e); Host.ended('no microphone'); }
  }
  // What the tablet kept from its name on (16 kHz 16-bit, base64): Gemini takes it as it is. Caught up, at a pause (or
  // once it starts talking), the session's own microphone takes over.
  let handing = false, holdFeed = false, fedAny = false, quietFrames = 0;
  function feed(data) {
    if (closed || holdFeed) return;
    send({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } });
    if (!fedAny) { fedAny = true; Host.mark('first audio to Google'); }
    const bin = atob(data), k = bin.length >> 1; let s2 = 0;
    for (let i = 0; i < k; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 32768) v -= 65536; s2 += (v / 32768) * (v / 32768); }
    quietFrames = k && Math.sqrt(s2 / k) < 0.004 ? quietFrames + k : 0;
    if (!handing && started && quietFrames > 8000) { handing = true; Host.handoff('caught up'); } // (half a second of quiet)
  }

  // It ends Host.idle() seconds after the last words heard or said, with nothing in the works (a tool, words waiting)
  // and nothing still playing; asked to go, once its goodbye has played.
  let lastAct = Date.now(), work = 0, workAt = 0, workEnd = 0, qTimer = null, leaving = 0;
  const working = (d) => { const was = work; work = Math.max(0, work + d); workAt = lastAct = Date.now(); if (was > 0 && work === 0) workEnd = workAt; };
  function quietTimer() {
    if (qTimer) return;
    const idle = Host.idle() * 1000;
    qTimer = setInterval(() => {
      if (closed) { clearInterval(qTimer); return; }
      const t = Date.now();
      if (work > 0 && t - workAt > 180000) { Host.note('live-backend-problem', 'a tool took 3 minutes'); work = 0; sorry(); }
      if (work > 0 || pend.length || queue.length || playing.length || rms(outAn) > 0.003) { lastAct = t; return; }
      if (leaving && t - leaving > 1500 && t - lastAct > 400) { clearInterval(qTimer); Host.ended('asked to go'); return; }
      if (t - lastAct > idle) { Host.log('quiet ' + idle / 1000 + ' s'); clearInterval(qTimer); Host.ended('quiet'); }
    }, 250);
  }
  // The face (Host.state): talking while its voice plays, thinking while a tool runs (and a moment after), hearing
  // while their words come in, else listening; each held a moment so it never flickers.
  let mood = 'listening', said = '', saidOpen = false, saidAt = 0, heardAt = 0, moodAt = 0, asked = '';
  function st(m) { if (m !== mood) { mood = m; moodAt = Date.now(); Host.state(m, said); } }
  function look() {
    if (closed) return;
    const t = Date.now();
    if (saidOpen && t - saidAt > 1500 && !playing.length) { saidOpen = false; if (said) Host.said('live-said', said); }
    const voice = outAn ? t - voiceLast < 450 : saidOpen;
    const m = voice ? 'talking' : work > 0 || leaving || t - workEnd < 2500 ? 'thinking' : t - heardAt < 1200 ? 'hearing' : 'listening';
    if (m === mood || m === 'talking' || t - moodAt > 350 && !(mood === 'talking' && t - voiceLast < 700)) st(m);
  }
  function heardDone() { const q = heard.trim(); if (q) Host.said('live-heard', q); heard = ''; return q; }

  function on(m) {
    logEvent(kind(m), m);
    if (m.usageMetadata) countUse(m.usageMetadata);
    if (m.setupComplete) { if (!started) begin2(); return; }
    if (m.goAway) { Host.log('Google ends the connection in ' + (m.goAway.timeLeft || '?')); return; }
    if (m.toolCall) {
      for (const c of m.toolCall.functionCalls || []) {
        if (!c || !c.name) continue;
        Host.note('live-tool-asked', c.name);
        const q = heardDone(); if (q) asked = q;
        if (c.name === 'go_away') { send({ toolResponse: { functionResponses: [{ id: c.id, name: c.name, response: { result: 'ok' } }] } }); leave(); continue; }
        names[c.id] = c.name; working(1);
        Host.tool('', c.id || '', c.name, JSON.stringify(c.args || {}));
      }
      return;
    }
    if (m.toolCallCancellation) { for (const id of m.toolCallCancellation.ids || []) if (names[id]) { delete names[id]; working(-1); } return; }
    const s = m.serverContent;
    if (!s) return;
    lastAct = Date.now();
    if (s.inputTranscription && s.inputTranscription.text) { heardAt = lastAct; heard += s.inputTranscription.text; }
    if (s.interrupted) { hush(); Host.log('interrupted'); }
    for (const p of (s.modelTurn && s.modelTurn.parts) || []) {
      if (p.inlineData && p.inlineData.data) {
        play(p.inlineData.data);
        // It talks before it caught up with what was kept: the tablet's listening stops feeding it (it has no echo
        // cancelling), and the session's own microphone takes over.
        if (!handing && mode === 'buffer') { handing = true; holdFeed = true; Host.handoff('it talked'); }
      }
    }
    if (s.groundingMetadata) { backend.searches++; Host.said('live-tool', 'web search'); }
    if (s.outputTranscription && s.outputTranscription.text) {
      asked = '';
      if (!saidOpen) { said = ''; saidOpen = true; if (heard.trim()) heardDone(); }
      saidAt = Date.now(); said += s.outputTranscription.text; if (mood === 'talking') Host.state('talking', said);
    }
    if (s.turnComplete) { turnDone(); if (heard.trim() && said) heardDone(); }
    look();
  }

  // Words to say (an answer, a reminder, an app's words): gathered for a moment, then given as a turn to read out.
  function say(text) {
    pend.push(text); clearTimeout(sayTimer);
    sayTimer = setTimeout(() => {
      const t = pend.splice(0).join(' ');
      send({ clientContent: { turns: [{ role: 'user', parts: [{ text: 'Read the following exactly, without an introduction or explanation: <say>' + t + '</say>' }] }], turnComplete: true } });
    }, 500);
  }
  function sorry() { say("Sorry, I couldn't do that just now. Could you ask me again?"); }
  // A tool's result back to Gemini, which carries on with it.
  function toolResult(d, callId, output) {
    const name = names[callId]; if (!name) return; // (cancelled meanwhile)
    delete names[callId]; working(-1);
    send({ toolResponse: { functionResponses: [{ id: callId, name, response: { result: String(output) } }] } });
  }
  function leave() {
    if (closed || leaving) return; leaving = lastAct = Date.now();
    Host.note('live-go-away', 'leaving');
    setTimeout(() => { if (!closed) Host.ended('asked to go'); }, 6000);
  }
  function setGain(g) { gain = Math.max(0, Math.min(1, g)); if (outGain) outGain.gain.value = gain; }
  function stop() {
    if (closed) return; closed = true;
    if (lastN) Host.log('< ' + lastType + ' x' + (lastN + 1));
    if (saidOpen && said) Host.said('live-said', said);
    heardDone(); turnDone();
    if (asked) Host.unanswered(asked); // (a tool was asked for, and nothing said since)
    clearTimeout(sayTimer);
    const unsaid = pend.splice(0).join(' ');
    if (unsaid.trim()) Host.unsaid(unsaid);
    Host.usage(sessionId, readyAt ? (Date.now() - readyAt) / 1000 : 0, JSON.stringify(backend));
    try { ws && ws.close(); } catch (e) {}
    try { proc && proc.disconnect(); } catch (e) {}
    try { mic && mic.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { micCtx && micCtx.close(); } catch (e) {}
    try { out && out.close(); } catch (e) {}
  }
  begin();
  return { feed, goLive, stop, setGain, answer, toolResult, say, leave };
}
// The tablet: a plain script in its web view, with Host already there (LiveVoice.kt calls these by name).
if (typeof Host !== 'undefined' && typeof module === 'undefined') {
  var LIVE = geminiSession(Host);
  var feed = LIVE.feed, goLive = LIVE.goLive, stop = LIVE.stop, setGain = LIVE.setGain, answer = LIVE.answer, toolResult = LIVE.toolResult, say = LIVE.say, leave = LIVE.leave;
}
// A browser: bundled (chat/src/live-voice.js imports it).
if (typeof module === 'object' && module.exports) module.exports.geminiSession = geminiSession;

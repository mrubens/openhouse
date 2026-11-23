// The live voice session (OpenAI's live voice over WebRTC, client delegation), one copy for the tablet and every browser.
// It talks to whoever runs it through a global Host object: the tablet's LiveVoice.kt (a hidden web view and its
// JavaScript interface), or a browser's chat/src/live-voice.js (a hidden frame). docs/hub.md, docs/voice-conversation.md
//
// liveSession(Host) starts one session and returns what its host calls: feed, goLive, stop, setGain, answer,
// toolResult, say. The tablet's page is this file as a plain script, so they're also put in the page's globals there.
function liveSession(Host) {
  let asked = '', out, pc, dc, mic, sessionId = '', started = false, closed = false, seconds = 0, n = 0, delegation = null, heard = '', queue = [], sayTimer = null, pend = [];
  const calls = {}, done = {}, called = {}, answered = {}; // per delegation: tool calls not yet answered; its backend response has ended
  const send = (e) => { e.event_id = 'c' + (++n); if (started && dc && dc.readyState === 'open') { Host.log('> ' + e.type); dc.send(JSON.stringify(e)); } else { Host.log('> ' + e.type + ' (queued)'); queue.push(e); } };
  // Logs: event types only, and for the ones that say why something ended, their fields with any words cut out.
  const SECRET = /^(delta|text|transcript|content|instructions|arguments|output|audio|sdp|item)$/;
  const shape = (v) => JSON.stringify(v, (k, x) => (SECRET.test(k) && typeof x !== 'number' ? '[' + (typeof x === 'string' ? x.length + ' chars' : typeof x) + ']' : x)).slice(0, 500);
  let lastType = '', lastN = 0;
  function logEvent(ev) { // one line per event, a run of the same type counted
    if (ev.type === lastType) { lastN++; return; }
    if (lastN) Host.log('< ' + lastType + ' x' + (lastN + 1));
    lastType = ev.type; lastN = 0;
    if (/closed|paused|error|failed|expired|delegation\.created|session\.started|usage/.test(ev.type)) Host.log('< ' + shape(ev)); else Host.log('< ' + ev.type);
  }
  // How loud the room and its voice are, ~12 times a second (Host.level), so the assistant's bars move with them.
  let micAn = null, outAn = null, lvlTimer = null; const lvlBuf = new Float32Array(512);
  function analyser(stream) { try { const a = ctx.createAnalyser(); a.fftSize = 512; ctx.createMediaStreamSource(stream).connect(a); return a; } catch (e) { Host.log('level: ' + e); return null; } }
  function rms(a) { if (!a) return 0; a.getFloatTimeDomainData(lvlBuf); let s = 0; for (let i = 0; i < lvlBuf.length; i++) s += lvlBuf[i] * lvlBuf[i]; return Math.sqrt(s / lvlBuf.length); }
  // Per reply: when its words began (the first transcript delta) and when its voice was first heard in what came back,
  // for the log ("reply 2: voice 140 ms after its words"), to see where a clipped start comes from.
  let replies = 0, wordsAt = 0, voiceAt = 0, outQuiet = 0;
  function onset(o) {
    if (o < 0.002) { outQuiet++; return; }
    if (o > 0.01 && wordsAt && !voiceAt) { voiceAt = Date.now(); Host.note('live-onset', 'reply ' + replies + ': voice ' + (voiceAt - wordsAt) + ' ms after its words (quiet ' + outQuiet * 80 + ' ms before)'); }
    outQuiet = 0;
  }
  function levels() { if (lvlTimer) return; lvlTimer = setInterval(() => { if (closed) { clearInterval(lvlTimer); return; } const o = rms(outAn); onset(o); Host.level(rms(micAn), o); }, 80); }
  // Its audio track starts as what the tablet kept (feed), played into it; the microphone replaces it (goLive).
  let ctx, dest, sender, fedTo = 0, peak = 0.01, floor = null, quiet = 0, handing = false, fedAny = false;
  const mode = Host.mode();
  // The speaker kept awake for the whole session: a faint noise (about -70 dB, not heard), so the tablet's audio doesn't
  // go idle between replies and come back a moment late, clipping the start of what it says.
  let warm = null;
  function awake() {
    try {
      warm = new AudioContext();
      const n = warm.sampleRate, b = warm.createBuffer(1, n, n), d = b.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * 0.0003;
      const src = warm.createBufferSource(); src.buffer = b; src.loop = true; src.connect(warm.destination); src.start();
      warm.resume().catch(() => {});
    } catch (e) { Host.log('awake: ' + e); }
  }
  async function begin() {
    try {
      pc = new RTCPeerConnection();
      ctx = new AudioContext({ sampleRate: 16000 }); dest = ctx.createMediaStreamDestination();
      try { await ctx.resume(); } catch (e) {}
      Host.log('mode ' + mode + ', audio ' + ctx.state);
      sender = pc.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
      awake();
      out = new Audio(); out.autoplay = true; setGain(Host.gain()); pc.ontrack = (e) => { out.srcObject = e.streams[0]; outAn = analyser(e.streams[0]); levels(); };
      dc = pc.createDataChannel('oai-events');
      dc.onmessage = (m) => { try { const ev = JSON.parse(m.data); logEvent(ev); if (ev.type === 'response.event' && ev.event) Host.log('<   ' + ev.event.type); on(ev); } catch (e) { Host.log('bad event ' + e); } };
      // Open is enough to talk to it: once (on the family tablet) session.started never came, and the answer went to the
      // tablet's own voice. A moment's grace for it, then on.
      dc.onopen = () => { Host.mark('data channel open'); setTimeout(() => { if (!started && !closed) { Host.log('no session.started: going on'); begin2(); } }, 800); };
      dc.onclose = () => { Host.log('data channel closed'); Host.ready(false); Host.ended('connection closed'); };
      pc.onconnectionstatechange = () => { Host.log('connection ' + pc.connectionState); if (pc.connectionState === 'failed') Host.ended('connection lost'); };
      pc.oniceconnectionstatechange = () => Host.mark('ice ' + pc.iceConnectionState);
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => { if (pc.iceGatheringState === 'complete') r(); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 1500); });
      Host.offer(pc.localDescription.sdp);
      if (mode === 'direct') { handing = true; Host.handoff('at once'); }
    } catch (e) { Host.log('could not start: ' + e); Host.ended('no connection'); }
  }
  // The microphone, once the tablet's listening has let it go (LiveVoice.handOff). Switched off: none (it only speaks).
  async function goLive() {
    if (closed || mode === 'none') return;
    try {
      const ask = () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      try { mic = await ask(); } catch (e) { Host.log('microphone: ' + e + ', trying again'); await new Promise((r) => setTimeout(r, 400)); mic = await ask(); }
      if (closed) { mic.getTracks().forEach((t) => t.stop()); return; }
      if (!Host.listening()) mic.getTracks().forEach((t) => { t.enabled = false; });
      await sender.replaceTrack(mic.getAudioTracks()[0]);
      micAn = analyser(mic); levels();
      Host.mark('its own microphone');
    } catch (e) { Host.log('no microphone: ' + e); Host.ended('no microphone'); }
  }
  // What the tablet kept (16 kHz 16-bit, base64), into the track in 20 ms frames. Brought up as the wake model's is (the
  // tablet's microphone is quiet, and nothing else here evens it out), and while it's behind, each pause is cut to its
  // first 160 ms, so it catches up. Caught up, in a pause: the microphone takes over.
  let holdFeed = false;
  function feed(b64) {
    if (closed || !ctx || holdFeed) return;
    const bin = atob(b64), n = bin.length >> 1, x = new Float32Array(n), F = 320;
    for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 32768) v -= 65536; x[i] = v / 32768; }
    for (let i = 0; i + F <= n; i += F) {
      const f = x.subarray(i, i + F);
      let s2 = 0, p = 0; for (let j = 0; j < F; j++) { const v = f[j]; s2 += v * v; const a = v < 0 ? -v : v; if (a > p) p = a; }
      const rms = Math.sqrt(s2 / F);
      if (p > peak) peak = p;
      floor = floor == null ? rms : rms < floor ? 0.8 * floor + 0.2 * rms : 0.995 * floor + 0.005 * rms;
      quiet = rms < Math.max(0.0003, 3 * floor) ? quiet + 1 : 0;
      if (quiet > 8 && fedTo - ctx.currentTime > 0.1) continue;
      const g = Math.min(32, Math.max(1, 0.3 / peak)), b = ctx.createBuffer(1, F, 16000), d = b.getChannelData(0);
      for (let j = 0; j < F; j++) d[j] = Math.tanh(f[j] * g);
      const src = ctx.createBufferSource(); src.buffer = b; src.connect(dest);
      const at = Math.max(fedTo, ctx.currentTime + 0.02); src.start(at); fedTo = at + F / 16000;
      if (!fedAny) { fedAny = true; Host.mark('first audio to OpenAI'); }
    }
    if (!handing && quiet > 8 && fedTo - ctx.currentTime < 0.15) { handing = true; Host.handoff('caught up'); }
  }
  async function answer(j) {
    const r = JSON.parse(j);
    if (r.error || !r.sdp) { Host.log('not started: ' + (r.error || 'no answer')); Host.ended('not started'); return; }
    sessionId = r.sessionId || '';
    try { await pc.setRemoteDescription({ type: 'answer', sdp: r.sdp }); } catch (e) { Host.log('bad answer ' + e); Host.ended('not started'); }
  }
  // The face and bubble follow the session (Host.state): hearing while someone talks, thinking once it hands the request
  // over until it says something, talking while its words come (and a moment after: the audio runs a little behind).
  function begin2() { started = true; Host.ready(true); for (const e of queue.splice(0)) send(e); lastAct = Date.now(); quietTimer(); }
  // It ends here: Host.idle() seconds after the last words heard or said, with nothing in the works (a request handed to
  // its text model or to the client, its tools, a web search, words waiting to be said) and nothing still playing.
  let lastAct = Date.now(), work = 0, workAt = 0, qTimer = null, leaving = 0, toolsOut = 0; // leaving: when it was asked to go; toolsOut: tools the client is running
  const working = (d) => { work = Math.max(0, work + d); workAt = Date.now(); lastAct = workAt; };
  function quietTimer() {
    if (qTimer) return;
    const idle = Host.idle() * 1000;
    qTimer = setInterval(() => {
      if (closed) { clearInterval(qTimer); return; }
      const t = Date.now();
      // (a tool still running here may take longer: the camera waits for someone to tap Allow on the tablet)
      if (work > 0 && t - workAt > (toolsOut > 0 ? 180000 : 30000)) { Host.note('live-backend-problem', 'nothing back in 30 s'); work = 0; sorry(); }
      if (work > 0 || pend.length || queue.length || rms(outAn) > 0.003) { lastAct = t; return; }
      // asked to go: once what it was saying has had time to start, and has played
      if (leaving && t - leaving > 1500 && t - lastAct > 400) { clearInterval(qTimer); Host.ended('asked to go'); return; }
      if (t - lastAct > idle) { Host.log('quiet ' + idle / 1000 + ' s'); clearInterval(qTimer); Host.ended('quiet'); }
    }, 250);
  }
  let mood = 'listening', said = '', moodTimer = null;
  function st(m) { if (m !== mood) { if (mood === 'talking' && said) Host.said('live-said', said); if (mood === 'talking' && holdFeed) { holdFeed = false; Host.handoff('it talked'); } mood = m; Host.state(m, said); } }
  function heardDone() {
    const q = heard.trim(); if (q) Host.said('live-heard', q);
    return q;
  }
  function settle(ms) { clearTimeout(moodTimer); moodTimer = setTimeout(() => { if (mood === 'hearing' || mood === 'talking') st('listening'); }, ms); }
  function on(ev) {
    switch (ev.type) {
      case 'session.output_transcript.delta':
        asked = ''; // (it's answering)
        if (mood !== 'talking') { said = ''; if (heard.trim()) { heardDone(); heard = ''; } replies++; wordsAt = Date.now(); voiceAt = 0; }
        // It talks before it caught up with what was kept: what the tablet hears now stops going to it (so it doesn't hear
        // itself through the tablet's microphone, which has no echo cancelling), and its own microphone takes over once it
        // has finished: taking it now switches Android's audio over to a call, which swallowed the start of what it said.
        if (!handing && mode === 'buffer') { handing = true; holdFeed = true; }
        lastAct = Date.now(); said += ev.delta || ''; mood === 'talking' ? Host.state('talking', said) : st('talking'); settle(1500); break;
      case 'session.started': Host.mark('started ' + (ev.session && ev.session.id || '')); if (!started) begin2(); break;
      case 'session.input_transcript.delta': lastAct = Date.now(); heard += ev.delta || ''; if (mood !== 'talking' && mood !== 'thinking') { st('hearing'); settle(1200); } break;
      case 'session.delegation.created':
        working(1); clearTimeout(moodTimer); st('thinking'); moodTimer = setTimeout(() => mood === 'thinking' && st('listening'), 30000);
        Host.note('live-delegated', (ev.delegation && ev.delegation.target) || '?');
        asked = heard.trim() || asked || '(what was said)';
        if (ev.delegation && ev.delegation.target === 'responses') { heardDone(); heard = ''; break; } // its text model has it, with the household's tools
        delegation = ev.delegation && ev.delegation.id; { const q = heardDone(); heard = ''; Host.log('asked: ' + q.length + ' chars'); if (q) Host.delegated(q); } break;
      case 'response.event': { // its text model, working: a tool to run here
        const e = ev.event || {}, d = ev.delegation_id;
        lastAct = Date.now(); workAt = lastAct; // (still at it: using an app takes many steps, each one counts)
        if (e.type === 'response.created') called[d] = false;
        if (e.type === 'response.output_item.done' && e.item && /^web_search/.test(e.item.type || '')) { Host.log('web search'); Host.said('live-tool', 'web search'); }
        // Its text model gave up (failed, cut short, an error): nothing would ever be said, so say that, and stop waiting.
        if (e.type === 'response.failed' || e.type === 'response.incomplete' || e.type === 'error') {
          const r = e.response || {};
          Host.note('live-backend-problem', e.type + ' ' + shape(r.error || r.incomplete_details || e.error || {}));
          if (called[d] !== null) working(-1);
          called[d] = null; delete calls[d]; delete done[d]; sorry(); break;
        }
        if (e.type === 'response.output_item.done' && e.item && e.item.type === 'function_call') { Host.note('live-tool-asked', e.item.name || '?'); called[d] = true; calls[d] = (calls[d] || 0) + 1; Host.log('tool ' + e.item.name); /* asked to go (go_away): it stops listening and says goodbye (leave) */ if (e.item.name === 'go_away') { leave(); break; } toolsOut++; Host.tool(d, e.item.call_id, e.item.name, e.item.arguments || '{}'); }
        if (e.type === 'response.completed' || e.type === 'response.done') { if (called[d] === false) { called[d] = null; working(-1); } done[d] = true; carryOn(d); } // (no tools in it: its answer, which it now says)
        break;
      }
      case 'session.usage.updated': seconds = (ev.usage && ev.usage.seconds) || seconds; break;
      case 'session.paused': Host.ended('quiet'); break;
      case 'session.closed': seconds = (ev.usage && ev.usage.seconds) || seconds; Host.ended('closed by OpenAI' + (ev.reason ? ': ' + ev.reason : '')); break;
    }
  }
  // The assistant's answer, a sentence at a time: gathered for a moment, then said in one go (each instruction can cut
  // off what it's saying). For the request it handed over: commentary (it may say it in its own words); otherwise read as given.
  function say(text) {
    pend.push(text); clearTimeout(sayTimer); if (delegation && !answered[delegation]) { answered[delegation] = true; working(-1); }
    sayTimer = setTimeout(() => {
      const t = pend.splice(0).join(' ');
      if (delegation) send({ type: 'session.commentary.append', delegation_id: delegation, content: t });
      else send({ type: 'session.instructions.append', delegation_id: null, content: 'Read the following exactly, without an introduction or explanation: <say>' + t + '</say>' });
    }, 500);
  }
  // Asked to go (the bridge's judgment, or its go_away tool): it stops listening at once, finishes what it's saying (its
  // own goodbye), and ends once that has played; at most a few seconds on.
  function leave() {
    if (closed || leaving) return; leaving = lastAct = Date.now();
    Host.note('live-go-away', 'leaving');
    try { mic && mic.getAudioTracks().forEach((t) => { t.enabled = false; }); } catch (e) {}
    setTimeout(() => { if (!closed) Host.ended('asked to go'); }, 6000);
  }
  // The text model couldn't answer: one plain sentence, so nobody is left waiting in silence.
  function sorry() { send({ type: 'session.instructions.append', delegation_id: null, content: 'Read the following exactly, without an introduction or explanation: <say>Sorry, I couldn\'t do that just now. Could you ask me again?</say>' }); }
  // A tool's result back to its text model; once all of a response's tools are answered, it carries on.
  // (OpenAI's shape: no delegation_id here, call_id matches it; then response.create resumes the backend: guides/live-delegation.)
  function toolResult(d, callId, output) {
    workAt = Date.now(); toolsOut = Math.max(0, toolsOut - 1);
    send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: callId, output: output } });
    calls[d] = (calls[d] || 1) - 1; carryOn(d);
  }
  function carryOn(d) { if (done[d] && calls[d] === 0) { delete done[d]; delete calls[d]; send({ type: 'response.create' }); } }
  // The household's volume (LiveVoice.setGain): the element's own volume, after the call stream's fixed level.
  function setGain(g) { if (out) { out.volume = Math.max(0, Math.min(1, g)); out.muted = g <= 0; } }
  function stop() {
    if (closed) return; closed = true;
    try { if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'session.close' })); } catch (e) {}
    if (lastN) Host.log('< ' + lastType + ' x' + (lastN + 1));
    if (mood === 'talking' && said) Host.said('live-said', said);
    heardDone();
    if (asked) Host.unanswered(asked); // handed over, and nothing said since
    clearTimeout(sayTimer);
    const unsaid = pend.splice(0).concat(queue.splice(0).filter((e) => /append$/.test(e.type)).map((e) => String(e.content || '').replace(/^Read the following exactly[^<]*<say>/, '').replace(/<\/say>$/, ''))).join(' ');
    if (unsaid.trim()) Host.unsaid(unsaid);
    Host.usage(sessionId, seconds);
    try { pc && pc.close(); } catch (e) {}
    try { mic && mic.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { ctx && ctx.close(); } catch (e) {}
    try { warm && warm.close(); } catch (e) {}
  }
  begin();
  return { feed, goLive, stop, setGain, answer, toolResult, say, leave };
}
// The tablet: a plain script in its web view, with Host already there (LiveVoice.kt calls these by name).
if (typeof Host !== 'undefined' && typeof module === 'undefined') {
  var LIVE = liveSession(Host);
  var feed = LIVE.feed, goLive = LIVE.goLive, stop = LIVE.stop, setGain = LIVE.setGain, answer = LIVE.answer, toolResult = LIVE.toolResult, say = LIVE.say, leave = LIVE.leave;
}
// A browser: bundled (chat/src/live-voice.js imports it).
if (typeof module === 'object' && module.exports) module.exports.liveSession = liveSession;

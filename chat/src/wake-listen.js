// Listening for "Hey Opie" in a browser (a hub's screens, docs/hub.md): the microphone at 16 kHz, a third of a second
// at a time, sealed to the hub, whose wake model (bridge/voice.js /voice/listen, voice-worker.js) says when it heard
// the name. Nothing here understands speech; the sound is scored on the hub and dropped.
const RATE = 16000;

/** Start listening; onWake() when the name is heard. Returns stop(). Throws if the microphone can't be had. */
export async function listenForName(c, onWake) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ctx = new AudioContext({ sampleRate: RATE });
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1); // (about 0.26 s at 16 kHz)
  const mute = ctx.createGain(); mute.gain.value = 0;
  let stopped = false, busy = false, queue = [];
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  async function send() {
    if (busy || stopped || !queue.length) return;
    busy = true;
    const n = queue.reduce((a, q) => a + q.length, 0), pcm = new Int16Array(n);
    let o = 0; for (const q of queue) { pcm.set(q, o); o += q.length; } queue = [];
    try {
      const r = await c.json('POST', '/voice/listen', { pcm: b64(new Uint8Array(pcm.buffer)) });
      if (!stopped && r.json?.woke) { stop(); onWake(); }
    } catch {}
    busy = false;
    if (queue.length) send();
  }
  proc.onaudioprocess = (e) => {
    if (stopped) return;
    const f = e.inputBuffer.getChannelData(0), q = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) q[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)));
    queue.push(q);
    if (queue.length > 12) queue.splice(0, queue.length - 12); // a slow hub: keep the last few seconds only
    send();
  };
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  function stop() {
    if (stopped) return; stopped = true;
    try { proc.disconnect(); src.disconnect(); } catch {}
    stream.getTracks().forEach((t) => t.stop()); ctx.close().catch(() => {});
  }
  return stop;
}

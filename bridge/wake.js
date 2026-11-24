// The wake word: "Hey Opie", the same for every household ("Opie" alone doesn't wake it, since voice set 9). A small model listens all the time
// (bridge/voice-worker.js), and when it fires the display hands the microphone to OpenAI's live voice. It's the only
// speech model on the tablet. How it was made and how well it does: docs/wake-word.md, scripts/wake/.
//
// openWakeWord's front end (Apache-2.0): every 80 ms, 8 new log-mel frames (melspectrogram.onnx) from the newest
// 110 ms of sound, then one 96-number embedding (embedding_model.onnx) of the last 76 frames. The wake model
// (opie.onnx, ours: convolutions and a GRU over them) reads the last 16 embeddings (1.28 s) and says how likely it is
// that "Hey Opie" just ended. This is
// openWakeWord's own streaming code (AudioFeatures._streaming_features), in JavaScript; the model was trained on the
// same features made in Python (scripts/wake/features.py), and scripts/wake/check.mjs checks the two agree.
export const WAKE_DIR = 'wake';
export const WAKE_FILES = ['melspectrogram.onnx', 'embedding_model.onnx', 'opie.onnx'];
const CHUNK = 1280, MEL_CONTEXT = 160 * 3, EMB_FRAMES = 76, HEAD_FRAMES = 16;

/**
 * A listener for one microphone. push(samples) takes 16 kHz audio (floats, ±1); onScore(score, end) is called for
 * each 80 ms with the model's score and the sample count at the end of that window. The models run one after another
 * (onnxruntime's run is async); pending() says how many 80 ms steps are still to be scored.
 */
export async function wakeListener(ort, dir, { threads = 1 } = {}) {
  const opt = { intraOpNumThreads: threads, interOpNumThreads: 1, executionMode: 'sequential', graphOptimizationLevel: 'all' };
  const [mel, emb, head] = await Promise.all(WAKE_FILES.map((f) => ort.InferenceSession.create(`${dir}/${f}`, opt)));
  return (onScore) => {
    let raw = new Float32Array(0), carry = new Float32Array(0); // the last MEL_CONTEXT samples, and samples not yet a whole chunk
    const mels = [], embs = []; // newest last
    let total = 0, queue = Promise.resolve(), waiting = 0;
    async function step(chunk, end) {
      const x = new Float32Array(MEL_CONTEXT + CHUNK);
      x.set(raw.subarray(Math.max(0, raw.length - MEL_CONTEXT)), MEL_CONTEXT - Math.min(MEL_CONTEXT, raw.length));
      for (let i = 0; i < CHUNK; i++) x[MEL_CONTEXT + i] = chunk[i] * 32767;
      raw = x.slice(CHUNK); // (the newest MEL_CONTEXT samples)
      const m = (await mel.run({ [mel.inputNames[0]]: new ort.Tensor('float32', x, [1, x.length]) }))[mel.outputNames[0]].data;
      for (let f = 0; f + 32 <= m.length; f += 32) mels.push(Float32Array.from(m.subarray(f, f + 32), (v) => v / 10 + 2));
      if (mels.length > EMB_FRAMES) mels.splice(0, mels.length - EMB_FRAMES);
      if (mels.length < EMB_FRAMES) return;
      const w = new Float32Array(EMB_FRAMES * 32); mels.forEach((r, i) => w.set(r, i * 32));
      const e = (await emb.run({ [emb.inputNames[0]]: new ort.Tensor('float32', w, [1, EMB_FRAMES, 32, 1]) }))[emb.outputNames[0]].data;
      embs.push(Float32Array.from(e)); if (embs.length > HEAD_FRAMES) embs.shift();
      if (embs.length < HEAD_FRAMES) return;
      const h = new Float32Array(HEAD_FRAMES * 96); embs.forEach((r, i) => h.set(r, i * 96));
      const p = (await head.run({ [head.inputNames[0]]: new ort.Tensor('float32', h, [1, HEAD_FRAMES, 96]) }))[head.outputNames[0]].data[0];
      onScore(p, end);
    }
    const run = (chunk, end) => { waiting++; queue = queue.then(() => step(chunk, end)).catch(() => {}).finally(() => { waiting--; }); };
    return {
      push(samples) {
        let s = samples;
        if (carry.length) { s = new Float32Array(carry.length + samples.length); s.set(carry); s.set(samples, carry.length); }
        let i = 0;
        for (; i + CHUNK <= s.length; i += CHUNK) { total += CHUNK; run(s.slice(i, i + CHUNK), total); }
        carry = s.slice(i);
      },
      reset() { raw = new Float32Array(0); carry = new Float32Array(0); mels.length = 0; embs.length = 0; },
      pending: () => waiting,
      idle: () => queue,
    };
  };
}

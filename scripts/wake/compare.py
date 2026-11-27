"""Wake-word engines, ours among them, on our wake test set (scripts/wake/testset.py), all treated alike
(docs/wake-eval.md). Evaluation only: nothing here ships. Unlike bench.mjs, each clip starts from a fresh listener and
is heard at --phases offsets within the 80 ms step.

Every engine hears what the tablet's listener would hand it: the clip through the listener's fixed gain (2, tanh) and
a wake counts only if the microphone's loudest moment in the last 1.3 s, before the gain, reached the floor (0.01), and
not again within 1.5 s (models/wake/opie.json, bridge/voice-worker.js).

  python -I compare.py --set <testset dir> --engine <name> [--skip-voices <file>] [--every N] [--hours H] [--phases 4]
                      [--no-streams] [--streams-from <report>] --out <json>
     engines:  oww:<head.onnx>               a 16x96 head on openWakeWord's features (ours, or openWakeWord's own)
               sherpa:<kws dir>[:thr:boost[:tokens]]  sherpa-onnx's open-vocabulary keyword spotter, "HEY OPIE" (or tokens_with_underscores)
               mww:<model.json>              a microWakeWord model (TFLite), with pymicro-features
               lk:<model.onnx>               a LiveKit WakeWord model, with its own client
     --oww <dir with melspectrogram.onnx, embedding_model.onnx>  for oww:

Writes per-clip peak scores (score engines) or wakes (event engines) and the stream's wake times, so thresholds can
be tried afterwards (summary.py).
"""
import argparse, json, os, sys, time
import numpy as np

RATE, GAIN, FLOOR = 16000, 2.0, 0.01
AGAIN = int(1.5 * RATE)
HEY = ('Hey Opie.', "Hey Opie, what's the weather tomorrow?", 'Hey Opie, add milk to the shopping list.')

def pcm(path):
    return np.fromfile(path, np.int16).astype(np.float32) / 32768

def loud(raw):
    """For each sample index, whether the raw peak over the last 1.3 s reached the floor (0.1 s blocks, as the listener)."""
    n = len(raw) // 1600
    pk = np.abs(raw[:n * 1600]).reshape(n, 1600).max(1) if n else np.zeros(0)
    ok = np.zeros(n + 1, bool)
    for i in range(n): ok[i + 1] = pk[max(0, i - 12): i + 1].max() >= FLOOR
    return lambda end: ok[min(n, end // 1600)]

class OwwHead:
    """openWakeWord's front end (as features.py and bridge/wake.js) and any head reading 16 embeddings."""
    kind = 'score'
    def __init__(self, head, oww):
        import onnxruntime as ort
        o = ort.SessionOptions(); o.intra_op_num_threads = 1; o.inter_op_num_threads = 1
        self.mel = ort.InferenceSession(os.path.join(oww, 'melspectrogram.onnx'), o)
        self.emb = ort.InferenceSession(os.path.join(oww, 'embedding_model.onnx'), o)
        self.head = ort.InferenceSession(head, o)
        self.hin = self.head.get_inputs()[0].name
        self.hb = 1 if self.head.get_inputs()[0].shape[0] == 1 else 4096  # (openWakeWord's own models take one window at a time)
    def scores(self, x):
        m = self.mel.run(None, {'input': (x * 32767)[None].astype(np.float32)})[0].reshape(-1, 32) / 10 + 2
        idx = list(range(0, len(m) - 75, 8))
        if len(idx) < 16: return np.zeros(0, int), np.zeros(0)
        e = np.concatenate([self.emb.run(None, {'input_1': np.stack([m[i:i + 76] for i in idx[j:j + 2048]])[..., None].astype(np.float32)})[0].reshape(-1, 96)
                            for j in range(0, len(idx), 2048)])
        w = np.lib.stride_tricks.sliding_window_view(e, (16, 96))[:, 0]  # (k, 16, 96)
        p = np.concatenate([self.head.run(None, {self.hin: w[j:j + self.hb].astype(np.float32)})[0].reshape(-1) for j in range(0, len(w), self.hb)])
        ends = np.array([(idx[k + 15] + 76) * 160 for k in range(len(w))])
        return ends, p

class Sherpa:
    """sherpa-onnx's streaming keyword spotter. It fires or doesn't (no score to sweep), so each threshold is a run."""
    kind = 'event'
    def __init__(self, d, thr=0.25, boost=1.0, keywords=None):
        import sherpa_onnx, tempfile
        # the ways its BPE writes the name as said: "Opie", "Opee", "Oh pee", "Oppy"
        kw = keywords or '\n'.join(t + ' @HEY_OPIE' for t in ('▁HE Y ▁O P I E', '▁HE Y ▁O PE E', '▁HE Y ▁OH ▁P E E', '▁HE Y ▁O PP Y'))
        f = tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False); f.write(kw + '\n'); f.close()
        enc = lambda s: os.path.join(d, f'{s}-epoch-12-avg-2-chunk-16-left-64.int8.onnx')
        self.kws = sherpa_onnx.KeywordSpotter(tokens=os.path.join(d, 'tokens.txt'), encoder=enc('encoder'), decoder=enc('decoder'),
            joiner=enc('joiner'), num_threads=1, keywords_file=f.name, keywords_score=boost, keywords_threshold=thr, max_active_paths=4)
    def events(self, x):
        s = self.kws.create_stream(); out = []; fed = 0
        for i in range(0, len(x), 1600):
            s.accept_waveform(RATE, x[i:i + 1600]); fed = i + len(x[i:i + 1600])
            while self.kws.is_ready(s):
                self.kws.decode_stream(s)
                if self.kws.get_result(s): out.append(fed); self.kws.reset_stream(s)
        s.accept_waveform(RATE, np.zeros(RATE // 2, np.float32)); s.input_finished()
        while self.kws.is_ready(s):
            self.kws.decode_stream(s)
            if self.kws.get_result(s): out.append(len(x)); self.kws.reset_stream(s)
        return out

class Mww:
    """A microWakeWord model (TFLite) through pymicro-wakeword: 40 features every 10 ms, a probability every 30 ms,
    averaged over the model's sliding window, as ESPHome and Home Assistant run it."""
    kind = 'score'
    def __init__(self, cfg):
        from pymicro_wakeword import MicroWakeWord, MicroWakeWordFeatures
        self.mww, self.Feat = MicroWakeWord.from_config(cfg), MicroWakeWordFeatures
    def scores(self, x):
        self.mww.reset(); fe = self.Feat()
        b = (np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes()
        ends, ps, n = [], [], 0
        for i in range(0, len(b) - 319, 320 * 10):
            for f in fe.process_streaming(b[i:i + 3200]):
                n += 1; p = self.mww.process_streaming_prob(f)
                if p is not None and n % self.mww.stride == 0: ends.append(n * 160); ps.append(p)
        return np.array(ends, int), np.array(ps)

class Lk:
    """A LiveKit WakeWord model (its own pretrained encoder, ONNX) through its Python client: a score every 80 ms."""
    kind = 'score'
    def __init__(self, path):
        from livekit.wakeword import WakeWordModel
        self.m = WakeWordModel(models=[path]); self.name = os.path.splitext(os.path.basename(path))[0]
    def scores(self, x):
        self.m.reset(); ends, ps = [], []
        for i in range(0, len(x) - 1279, 1280):
            ps.append(float(self.m.predict(x[i:i + 1280])[self.name])); ends.append(i + 1280)
        return np.array(ends, int), np.array(ps)

def make(spec, a):
    kind, _, rest = spec.partition(':')
    if kind == 'oww': return OwwHead(rest, a.oww)
    if kind == 'sherpa':
        d, *o = rest.split(':')
        kw = o.pop() if o and not o[-1].replace('.', '').isdigit() else None  # (a last field of BPE tokens: another phrase)
        return Sherpa(d, *(float(v) for v in o), keywords=kw and kw.replace('_', ' ') + ' @KW')
    if kind == 'mww': return Mww(rest)
    if kind == 'lk': return Lk(rest)
    raise SystemExit(f'unknown engine {spec}')

def run(eng, x):
    """Returns (ends, scores) with scores zeroed where the floor wasn't reached; events are score 1."""
    ok = loud(x); y = np.tanh(x * GAIN).astype(np.float32)
    if eng.kind == 'event':
        ends = np.array(eng.events(y), int); p = np.ones(len(ends))
    else: ends, p = eng.scores(y)
    return ends, np.array([v if ok(int(e)) else 0.0 for e, v in zip(ends, p)])

def wakes(ends, p, thr):
    n, last = 0, -10 ** 12
    for e, v in zip(ends, p):
        if v >= thr and e - last >= AGAIN: n += 1; last = e
    return n

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', required=True); ap.add_argument('--engine', required=True); ap.add_argument('--oww')
    ap.add_argument('--skip-voices'); ap.add_argument('--every', type=int, default=1); ap.add_argument('--hours', type=float, default=99)
    ap.add_argument('--no-streams', action='store_true'); ap.add_argument('--phases', type=int, default=4)
    ap.add_argument('--streams-from', help="an earlier report of the same engine: take its streams (they don't change)"); ap.add_argument('--out', required=True)
    a = ap.parse_args()
    man = json.load(open(os.path.join(a.set, 'manifest.json')))
    skip = set(open(a.skip_voices).read().split()) if a.skip_voices else set()
    pick = lambda xs: [x for i, x in enumerate([x for x in xs if x['voice'].replace('-kid', '') not in skip]) if i % a.every == 0]
    eng = make(a.engine, a)
    res = {'engine': a.engine, 'kind': eng.kind, 'positives': [], 'near': [], 'streams': {}, 'cpu': {}}
    t0, secs = time.process_time(), 0.0
    # Each clip is heard at a few offsets within openWakeWord's 80 ms step (and the other engines' own steps): on a
    # hard clip a model can score 0.003 at one offset and 0.999 at another, so one offset alone is a coin toss.
    def peaks(x):
        out = []
        for k in range(a.phases):
            e, s = run(eng, np.concatenate([np.zeros(k * 1280 // a.phases, np.float32), x])); out.append(float(s.max()) if len(s) else 0.0)
        return out
    for p in pick(man['positives']):
        if p['voice'] == 'recorded': continue  # (a real person's takes: not used here)
        x = pcm(os.path.join(a.set, p['file'])); secs += a.phases * len(x) / RATE
        res['positives'].append({'voice': p['voice'], 'cond': p['cond'], 'text': p['text'], 'peaks': peaks(x)})
    for p in pick(man['near']):
        x = pcm(os.path.join(a.set, p['file'])); secs += a.phases * len(x) / RATE
        res['near'].append({'text': p['text'], 'peaks': peaks(x)})
    print(f'clips done: {len(res["positives"])} positives, {len(res["near"])} near-misses', flush=True)
    piece = 10 * 60 * RATE
    for st in ([] if a.no_streams else man['streams']):
        x = pcm(os.path.join(a.set, st['file']))[: int(a.hours * 3600 * RATE)]
        ev = []
        for i in range(0, len(x), piece):
            e, s = run(eng, x[i:i + piece]); keep = s >= (0.5 if eng.kind == 'event' else 0.05)
            ev += [[int(i + v), float(w)] for v, w in zip(e[keep], s[keep])]
        secs += len(x) / RATE
        res['streams'][st['file'].replace('.pcm', '')] = {'kind': st['kind'], 'hours': len(x) / RATE / 3600, 'scores': ev}
        print(f'  {st["kind"]}: {len(x) / RATE / 3600:.2f} h, {len(ev)} frames over 0.05', flush=True)
    if a.streams_from: res['streams'] = json.load(open(a.streams_from))['streams']
    cpu = time.process_time() - t0
    res['cpu'] = {'audioSeconds': secs, 'cpuSeconds': cpu, 'realTimeFactor': cpu / secs}
    json.dump(res, open(a.out, 'w'))
    print(f'CPU: {cpu:.0f} s for {secs / 3600:.1f} h of audio ({100 * cpu / secs:.2f}% of one core, this Mac)')

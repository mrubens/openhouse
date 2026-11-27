"""What each wake engine costs while it listens (docs/wake-eval.md): CPU per second of sound and memory, streaming
the way the tablet does (80 ms at a time, one thread), in a fresh process per engine.

  python -I cost.py <engine spec as compare.py takes it> --audio <16 kHz s16le file> [--seconds 300] [--oww <dir>]
"""
import argparse, json, os, resource, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ap = argparse.ArgumentParser(); ap.add_argument('engine'); ap.add_argument('--audio', required=True)
ap.add_argument('--seconds', type=float, default=300); ap.add_argument('--oww')
a = ap.parse_args()
rss = lambda: resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1 << 20)  # MB (macOS reports bytes)
x = np.fromfile(a.audio, np.int16, count=int(a.seconds * 16000)).astype(np.float32) / 32768
import onnxruntime  # (loaded for every engine that uses it, so the baseline is fair)
base = rss()
kind, _, rest = a.engine.partition(':')
if kind == 'oww':
    import onnxruntime as ort
    o = ort.SessionOptions(); o.intra_op_num_threads = 1; o.inter_op_num_threads = 1
    mel = ort.InferenceSession(os.path.join(a.oww, 'melspectrogram.onnx'), o); emb = ort.InferenceSession(os.path.join(a.oww, 'embedding_model.onnx'), o)
    head = ort.InferenceSession(rest, o); hin = head.get_inputs()[0].name
    raw, mels, embs = np.zeros(480, np.float32), [], []
    def push(c):  # bridge/wake.js's step
        global raw
        y = np.concatenate([raw, c * 32767]).astype(np.float32); raw = y[-480:]
        m = mel.run(None, {'input': y[None]})[0].reshape(-1, 32) / 10 + 2
        mels.extend(m); del mels[:-76]
        if len(mels) < 76: return
        embs.append(emb.run(None, {'input_1': np.array(mels, np.float32)[None, :, :, None]})[0].reshape(96)); del embs[:-16]
        if len(embs) == 16: head.run(None, {hin: np.array(embs, np.float32)[None]})
elif kind == 'sherpa':
    from compare import Sherpa
    eng = Sherpa(rest.split(':')[0]); kws = eng.kws; s = kws.create_stream()
    def push(c):
        s.accept_waveform(16000, c)
        while kws.is_ready(s):
            kws.decode_stream(s)
            if kws.get_result(s): kws.reset_stream(s)
elif kind == 'mww':
    from pymicro_wakeword import MicroWakeWord, MicroWakeWordFeatures
    m, fe = MicroWakeWord.from_config(rest), MicroWakeWordFeatures()
    def push(c):
        for f in fe.process_streaming((c * 32767).astype(np.int16).tobytes()): m.process_streaming_prob(f)
elif kind == 'lk':
    from livekit.wakeword import WakeWordModel
    m = WakeWordModel(models=[rest])
    def push(c): m.predict(c)
loaded = rss()
t0, w0 = time.process_time(), time.time()
for i in range(0, len(x) - 1279, 1280): push(x[i:i + 1280])
cpu = time.process_time() - t0
print(json.dumps({'engine': a.engine, 'seconds': len(x) / 16000, 'cpuPercentOfOneCore': round(100 * cpu / (len(x) / 16000), 2),
                  'memoryMB': {'models': round(loaded - base, 1), 'peakProcess': round(rss(), 1)}}))

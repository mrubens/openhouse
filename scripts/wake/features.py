"""openWakeWord's front end (melspectrogram.onnx -> embedding_model.onnx, Apache-2.0, github.com/dscripka/openWakeWord)
and the room the training clips are put in: speed and pitch, reverb, distance, kitchen noise, music, TV-like babble.

The display computes the same features while it listens (bridge/wake.js); scripts/wake/check.py checks they agree.
One embedding (96 numbers) per 80 ms from the last 0.775 s of sound; the wake model reads the last 16 (1.28 s).
"""
import glob, os, random
import numpy as np
import onnxruntime as ort
from scipy.signal import fftconvolve, resample_poly

RATE = 16000
WIN = 2.0  # seconds of audio per training example: enough for 16 embeddings

class Front:
    def __init__(self, oww_dir, threads=4, cuda=False):
        o = ort.SessionOptions(); o.intra_op_num_threads = threads; o.inter_op_num_threads = 1
        pr = (['CUDAExecutionProvider'] if cuda else []) + ['CPUExecutionProvider']
        self.mel = ort.InferenceSession(os.path.join(oww_dir, 'melspectrogram.onnx'), o, providers=pr)
        self.emb = ort.InferenceSession(os.path.join(oww_dir, 'embedding_model.onnx'), o, providers=pr)

    def mels(self, audio):  # float [-1, 1] -> (frames, 32), scaled as openWakeWord does
        x = (np.asarray(audio, np.float32) * 32767)[None]
        return self.mel.run(None, {'input': x})[0][:, 0].reshape(-1, 32) / 10 + 2

    def embeddings(self, audio, batch=None):
        """Every 80 ms (8 mel frames), from the last 76 frames, as openWakeWord's batch path (_get_embeddings)."""
        if batch is not None: return self.embeddings_batch(batch)
        m = self.mels(audio)
        wins = [m[i:i + 76] for i in range(0, len(m) - 75, 8)]
        if not wins: return np.zeros((0, 96), np.float32)
        return self.emb.run(None, {'input_1': np.stack(wins)[..., None].astype(np.float32)})[0].reshape(-1, 96)

    def embeddings_batch(self, clips):  # equal-length clips -> (n, k, 96)
        x = (np.stack(clips).astype(np.float32) * 32767)
        m = self.mel.run(None, {'input': x})[0]  # (n*frames? or n, 1, frames, 32)
        m = m.reshape(len(clips), -1, 32) / 10 + 2
        idx = list(range(0, m.shape[1] - 75, 8))
        w = np.stack([m[:, i:i + 76] for i in idx], 1)  # (n, k, 76, 32)
        e = self.emb.run(None, {'input_1': w.reshape(-1, 76, 32, 1).astype(np.float32)})[0]
        return e.reshape(len(clips), len(idx), 96)

def load_npz(path):
    z = np.load(path)
    a, off = z['audio'], z['offsets']
    return [(a[off[i]:off[i + 1]].astype(np.float32) / 32768, int(z['ends'][i]), str(z['texts'][i])) for i in range(len(off) - 1)]

class Room:
    """Noise and music banks, split so training and testing never share a recording (see `part`)."""
    def __init__(self, noise_dir, music_dir=None, part='train', babble=None, musan=None):
        self.noise, self.music = [], []
        if musan and part == 'train':  # MUSAN's music and noise (CC-BY 4.0): training only
            self.music += sorted(glob.glob(os.path.join(musan, 'music', '**', '*.wav'), recursive=True))
            self.noise += sorted(glob.glob(os.path.join(musan, 'noise', '**', '*.wav'), recursive=True))
        for f in sorted(glob.glob(os.path.join(noise_dir, '*', 'ch*.wav'))):
            ch = int(os.path.basename(f)[2:4])
            if (ch <= 10) == (part == 'train'): self.noise.append(f)
        if music_dir:
            for f in sorted(glob.glob(os.path.join(music_dir, '*', '*.wav')) + glob.glob(os.path.join(music_dir, '*', '*.au'))):
                n = int(f.split('.')[-2])
                if (n < 70) == (part == 'train'): self.music.append(f)
        self.babble = babble or []  # other speech clips (float, 16 kHz)
        self._cache = {}

    def _read(self, f):
        if f not in self._cache:
            if len(self._cache) >= 48: self._cache.pop(next(iter(self._cache)))  # (a few files at a time: MUSAN's music is 40 hours)
            import soundfile as sf
            a, sr = sf.read(f, dtype='float32')
            if a.ndim > 1: a = a.mean(1)
            if sr != RATE: a = resample_poly(a, RATE, sr).astype(np.float32)
            self._cache[f] = a
        return self._cache[f]

    def background(self, n, rng, kinds=('noise', 'music', 'babble')):
        r = rng.random()
        kind = 'noise' if r < 0.45 else 'music' if r < 0.75 else 'babble'
        if kind not in kinds: kind = rng.choice(kinds)
        if kind == 'noise' and self.noise: src = self._read(rng.choice(self.noise))
        elif kind == 'music' and self.music: src = self._read(rng.choice(self.music))
        elif self.babble:  # someone else talking (a TV, the next room)
            parts, got = [], 0
            while got < n: c = rng.choice(self.babble); parts.append(c); got += len(c)
            src = np.concatenate(parts)
        else: return np.zeros(n, np.float32)
        if len(src) < n: src = np.tile(src, n // len(src) + 1)
        i = rng.randrange(0, len(src) - n + 1)
        return src[i:i + n].copy()

def rir(rng, rt60, drr_db):
    n = int(RATE * min(1.2, rt60 * 1.1))
    t = np.arange(n) / RATE
    tail = np.random.default_rng(rng.randrange(1 << 30)).standard_normal(n) * np.exp(-6.9 * t / rt60)
    tail[:int(RATE * rng.uniform(0.002, 0.012))] = 0  # first reflections arrive a little later
    h = tail / (np.sqrt(np.sum(tail ** 2)) + 1e-9) * 10 ** (-drr_db / 20)
    h[0] += 1
    return (h / np.max(np.abs(h))).astype(np.float32)

def speed(a, f):  # f > 1: faster and higher (a child), < 1: slower and lower
    if abs(f - 1) < 0.01: return a
    up, down = 100, int(round(100 * f))
    return resample_poly(a, up, down).astype(np.float32)

def db(x): return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9)

def call(x, rng):
    """As over a phone or a video call (or the tablet's call-style microphone): 300-3400 Hz, squashed, a little hiss."""
    from scipy.signal import butter, sosfilt
    lo, hi = rng.uniform(200, 400), rng.uniform(3000, 3800)
    y = sosfilt(butter(4, [lo, hi], btype='band', fs=RATE, output='sos'), x).astype(np.float32)
    pk = np.abs(y).max() or 1; mu = 255.0
    y = np.sign(y) * np.log1p(mu * np.abs(y / pk)) / np.log1p(mu)  # mu-law, then a coarse step as a codec would
    y = np.round(y * rng.choice([64, 128, 256])) / 128
    y = np.sign(y) * (np.expm1(np.abs(y) * np.log1p(mu)) / mu) * pk
    return (y + np.random.default_rng(rng.randrange(1 << 30)).standard_normal(len(y)) * pk * 10 ** (-45 / 20)).astype(np.float32)

def place(speech, room, rng, end=None, at=None, n=int(WIN * RATE), far=None, hard=False):
    """Put a clip in a room: a window of n samples whose speech mark (end, in the clip) lands at sample `at`. hard: the
    hard rooms (round 3): across the room half the time, always over something, often music or talk as loud as a TV."""
    f = rng.uniform(1.12, 1.38) if rng.random() < 0.3 else rng.uniform(0.88, 1.12)  # (0.3: children, higher and quicker)
    s = speed(speech, f); end = int((len(speech) if end is None else end) / f)
    far = rng.random() < (0.5 if hard else 0.4) if far is None else far
    if rng.random() < 0.8 or far:
        s = fftconvolve(s, rir(rng, rng.uniform(0.2, 0.9) if far else rng.uniform(0.12, 0.5), rng.uniform(-6, 3) if far else rng.uniform(3, 15)))[:len(s) + int(0.3 * RATE)].astype(np.float32)
    if rng.random() < 0.12: s = call(s, rng)  # someone on a call, or the TV
    at = n - 1 if at is None else at
    out = np.zeros(n, np.float32)
    lo = at - end  # where the clip starts in the window
    a, b = max(0, lo), min(n, lo + len(s))
    if b > a: out[a:b] = s[a - lo:b - lo]
    level = rng.uniform(-48, -38) if far else rng.uniform(-38, -18)  # speech RMS, dBFS (the tablet's microphone is quiet)
    out *= 10 ** ((level - db(s[:max(1, end)])) / 20)
    if hard or rng.random() < 0.85:
        bg = room.background(n, rng, kinds=('music', 'babble')) if hard and rng.random() < 0.6 else room.background(n, rng)
        snr = rng.uniform(2, 12) if hard else rng.uniform(-2, 12) if rng.random() < 0.3 else rng.uniform(8, 30)
        if np.any(bg): out += bg * 10 ** ((level - snr - db(bg)) / 20)
    out += np.random.default_rng(rng.randrange(1 << 30)).standard_normal(n).astype(np.float32) * 10 ** (rng.uniform(-75, -60) / 20)
    # The listener's auto-gain brings a quiet room up (bridge/voice-worker.js): a level between what the mic gave and ~-20 dBFS.
    g = rng.uniform(0, max(0, -22 - level))
    out *= 10 ** (g / 20)
    return np.clip(out, -1, 1)

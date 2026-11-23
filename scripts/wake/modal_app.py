"""The wake model's data and training, on Modal (docs/wake-word.md). Synthetic and public data only: no household audio
goes there, and only the trained model and its scores come back.

  MODAL_CONFIG_PATH=~/.openhouse/wake/modal.toml ~/.openhouse/wake/.venv/bin/modal run scripts/wake/modal_app.py::main --stage all

Stages (each keeps what's done on the volume "opie-wake" and skips it next time): data, voices, features, train, score.
"""
import io, json, os, random, sys, time
import modal

HERE = os.path.dirname(os.path.abspath(__file__))
app = modal.App('opie-wake')
vol = modal.Volume.from_name('opie-wake', create_if_missing=True)
V = '/vol'
image = (modal.Image.debian_slim(python_version='3.12')
         .apt_install('ffmpeg', 'curl', 'unzip', 'bzip2', 'libsndfile1')
         .pip_install('numpy<2.3', 'scipy', 'soundfile', 'pyarrow', 'sherpa-onnx==2.0.1', 'torch==2.5.1', 'onnx', 'onnxscript')
         .pip_install('piper-tts', extra_options='--no-deps')
         .pip_install('onnxruntime-gpu[cuda,cudnn]==1.22.0')
         .add_local_dir(HERE, '/root/wake', ignore=['__pycache__', '*.pyc']))

# ---- voices ----
PV = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/'
# (model, speakers, path under en/). Held out for the test: Piper speakers from 850 up, l2arctic's odd ones, and four
# single voices; Kokoro's odd voices. Training never hears them.
PIPER = [('en_US-libritts_r-medium', 904, 'en_US/libritts_r/medium'), ('en_US-libritts-high', 904, 'en_US/libritts/high'),
         ('en_GB-vctk-medium', 109, 'en_GB/vctk/medium'), ('en_US-arctic-medium', 18, 'en_US/arctic/medium'),
         ('en_US-l2arctic-medium', 24, 'en_US/l2arctic/medium'), ('en_GB-aru-medium', 12, 'en_GB/aru/medium'),
         ('en_GB-semaine-medium', 4, 'en_GB/semaine/medium')] + [
        (f'{n}-medium', 1, n.replace('-', '/', 1).replace('en_US/', 'en_US/').replace('en_GB/', 'en_GB/') + '/medium') for n in
        ['en_GB-alan', 'en_GB-cori', 'en_GB-jenny_dioco', 'en_GB-northern_english_male', 'en_US-bryce', 'en_US-hfc_female',
         'en_US-hfc_male', 'en_US-joe', 'en_US-john', 'en_US-kathleen', 'en_US-kristin', 'en_US-kusal', 'en_US-lessac',
         'en_US-ljspeech', 'en_US-mike', 'en_US-norman', 'en_US-reza_ibrahim', 'en_US-sam',
         'en_GB-alba', 'en_US-amy', 'en_US-ryan', 'en_US-hifi_tts_92']]
HELD_SINGLE = {'en_GB-alba-medium', 'en_US-amy-medium', 'en_US-ryan-medium', 'en_US-hifi_tts_92-medium'}

def held_out(model, spk):
    if model.startswith('kokoro'): return spk % 2 == 1
    if 'libritts' in model: return spk >= 850
    if 'l2arctic' in model: return spk % 2 == 1
    return model in HELD_SINGLE

def jobs():
    out = []
    for model, n, _ in PIPER:
        per = 40 if n >= 900 else 80 if n > 50 else 150 if n > 1 else 500  # clips of the name per speaker
        for s in range(n): out.append((model, s, per))
    for s in range(28): out.append(('kokoro', s, 300))
    return out

def _sh(cmd): import subprocess; subprocess.run(cmd, shell=True, check=True)

@app.function(image=image, volumes={V: vol}, timeout=6 * 3600, cpu=4)
def data():
    """Public data onto the volume (once): voices, rooms, ordinary sound, openWakeWord's front end."""
    d = f'{V}/dl'; os.makedirs(d, exist_ok=True)
    def get(url, dst):
        if not os.path.exists(dst): _sh(f'curl -sSLf "{url}" -o "{dst}.part" && mv "{dst}.part" "{dst}"')
    os.makedirs(f'{d}/piper', exist_ok=True)
    for model, _, p in PIPER:
        for ext in ('.onnx', '.onnx.json'): get(f'{PV}{p}/{model}{ext}', f'{d}/piper/{model}{ext}')
    if not os.path.isdir(f'{d}/kokoro-multi-lang-v1_0'): _sh(f'curl -sSLf https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2 | tar xj -C {d}')
    os.makedirs(f'{d}/oww', exist_ok=True)
    for f in ('melspectrogram.onnx', 'embedding_model.onnx'): get(f'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/{f}', f'{d}/oww/{f}')
    get('https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy', f'{d}/oww/validation_set_features.npy')
    os.makedirs(f'{d}/noise', exist_ok=True)
    for n in ('DKITCHEN', 'DLIVING', 'DWASHING', 'PCAFETER', 'OOFFICE', 'NFIELD'):
        if not os.path.isdir(f'{d}/noise/{n}'): get(f'https://zenodo.org/records/1227121/files/{n}_16k.zip', f'/tmp/{n}.zip'); _sh(f'cd {d}/noise && unzip -qo /tmp/{n}.zip')
    if not os.path.isdir(f'{d}/musan/musan/music'): os.makedirs(f'{d}/musan', exist_ok=True); _sh(f'curl -sSLf https://openslr.elda.org/resources/17/musan.tar.gz | tar xz -C {d}/musan musan/music musan/noise')
    os.makedirs(f'{d}/ls', exist_ok=True)
    for part in ('dev-clean', 'dev-other', 'test-other', 'test-clean'):
        if not os.path.isdir(f'{d}/ls/LibriSpeech/{part}'): _sh(f'curl -sSLf https://www.openslr.org/resources/12/{part}.tar.gz | tar xz -C {d}/ls')
    os.makedirs(f'{d}/ami', exist_ok=True)
    for i in range(6): get(f'https://huggingface.co/datasets/edinburghcstr/ami/resolve/main/sdm/train-0000{i}-of-00027.parquet', f'{d}/ami/train-{i}.parquet')
    for i in range(2): get(f'https://huggingface.co/datasets/edinburghcstr/ami/resolve/main/sdm/test-0000{i}-of-00004.parquet', f'{d}/ami/test-{i}.parquet')
    if not os.path.isdir(f'{d}/gtzan/genres'): os.makedirs(f'{d}/gtzan', exist_ok=True); _sh(f'curl -sSLf https://huggingface.co/datasets/marsyas/gtzan/resolve/main/data/genres.tar.gz | tar xz -C {d}/gtzan; rm -f {d}/gtzan/genres/jazz/jazz.00054.wav')
    vol.commit(); _sh(f'du -sh {d}/*')

# ---- saying it ----
def _say_one(job):
    """(model, speaker, n) -> its name clips and near-misses. Piper on the CPU (it's small: faster than a GPU here)."""
    sys.path.insert(0, '/root/wake')
    import numpy as np, synth, tempfile, piper
    from testset import Kokoro, trim
    model, spk, n = job
    rng = random.Random(f'{model}-{spk}')
    if model == 'kokoro':
        k = Kokoro(f'{V}/dl/kokoro-multi-lang-v1_0', tempfile.mkdtemp()); say = lambda t: trim(k(t, spk)); names = ['Opie']  # ("Opie" added to its lexicon, as said)
    else:
        from piper import PiperVoice
        v = PiperVoice.load(f'{V}/dl/piper/{model}.onnx', espeak_data_dir=os.path.join(os.path.dirname(piper.__file__), 'espeak-ng-data'))
        say = lambda t: synth.say(v, t, spk if v.config.num_speakers > 1 else None, rng); names = synth.NAMES
    pos, neg = [], []
    for i in range(n):
        t = rng.choice(synth.WAKE).format(n=rng.choice(names)); a = say(t); end = len(a)
        if i % 4 == 3: nxt = rng.choice(synth.AFTER); a = np.concatenate([a, np.zeros(int(rng.uniform(0, 0.15) * 16000), np.float32), say(nxt)]); t += ' ' + nxt
        pos.append((t, a, end))
    for i in range(max(8, n // 2)):
        t = rng.choice(synth.NEAR) if i % 3 else rng.choice(synth.SENTENCES); a = say(t); neg.append((t, a, len(a)))
    return pos, neg

@app.function(image=image, volumes={V: vol}, timeout=1500, cpu=8, memory=16384, max_containers=40)
def voices(batch):
    """A batch of speakers (all held out, or none) -> one npz of name clips and near-misses on the volume."""
    import numpy as np
    from multiprocessing import Pool
    key = f'{batch[0][0]}-{batch[0][1]}'; out = f'{V}/synth/{key}.npz'
    if os.path.exists(out): return key, 0
    import multiprocessing as mp
    with mp.get_context('spawn').Pool(min(8, len(batch))) as p: res = p.map(_say_one, batch)  # (spawn: a forked pool hung, and billed)
    pos = [x for r in res for x in r[0]]; neg = [x for r in res for x in r[1]]
    def pack(items):
        lens = np.array([len(a) for _, a, _ in items], np.int64)
        return dict(audio=np.concatenate([np.clip(a * 32767, -32768, 32767).astype(np.int16) for _, a, _ in items]), offsets=np.concatenate([[0], np.cumsum(lens)]),
                    ends=np.array([e for _, _, e in items], np.int64), texts=np.array([t for t, _, _ in items]))
    os.makedirs(f'{V}/synth', exist_ok=True)
    np.savez(out + '.tmp.npz', **{f'pos_{k}': v for k, v in pack(pos).items()}, **{f'neg_{k}': v for k, v in pack(neg).items()}, held=np.array([held_out(batch[0][0], batch[0][1])]))
    os.rename(out + '.tmp.npz', out); vol.commit()
    return key, len(pos)

# ---- in rooms, as features ----
@app.function(image=image, volumes={V: vol}, timeout=1200, cpu=1.0, memory=6144, max_containers=150)
def features(task):
    """task: ('synth', npz file, seed) | ('speech', seed, n) | ('room', seed, n) | ('test', npz, seed) -> npy on the volume."""
    sys.path.insert(0, '/root/wake')
    import numpy as np, features as F, onnxruntime as ort
    pass  # (CPU only here)
    kind, arg, seed = task
    if kind == 'synth' and not os.path.exists(arg): return None  # (a batch the voices run didn't finish)
    name = f'{V}/feats/{kind}-{os.path.basename(str(arg)).replace(".npz", "")}-{seed}.npz'
    if os.path.exists(name): return name
    rng = random.Random(seed); N = int(F.WIN * F.RATE)
    part = 'test' if kind == 'test' else 'train'
    room = F.Room(f'{V}/dl/noise', f'{V}/dl/gtzan/genres', part, babble=None, musan=f'{V}/dl/musan/musan')
    room.babble = _babble(part)
    front = F.Front(f'{V}/dl/oww', threads=1)
    out = {}
    def embed(xs): return np.concatenate([front.embeddings_batch(xs[i:i + 256])[:, -16:] for i in range(0, len(xs), 256)]).astype(np.float16)
    if kind in ('synth', 'test'):
        z = np.load(arg); hard = kind == 'synth' and seed >= 100  # (seed 100 and up: the name clips again, in the hard rooms only)
        if hard: out['neg'] = np.zeros((0, 16, 96), np.float16)
        for k in (('pos',) if hard else ('pos', 'neg')):
            a, off, ends = z[f'{k}_audio'], z[f'{k}_offsets'], z[f'{k}_ends']
            xs = []
            for i in range(len(off) - 1):
                clip = a[off[i]:off[i + 1]].astype(np.float32) / 32768
                for _ in range((8 if 'clone-' in str(arg) else 3) if k == 'pos' else 2):  # (cloned voices: fewer clips, more rooms each)
                    if k == 'pos': xs.append(F.place(clip, room, rng, end=int(ends[i]), at=N - 1 - int(rng.uniform(0, 0.24) * F.RATE), hard=hard))
                    else: xs.append(F.place(clip, room, rng, end=len(clip), at=int(rng.uniform(0.55, 1.0) * (N - 1))))
            out[k] = embed(xs) if xs else np.zeros((0, 16, 96), np.float16)
    elif kind == 'speech':
        bank = np.load(f'{V}/dl/speech-bank.npy', mmap_mode='r')
        xs = []
        for _ in range(arg):
            i = rng.randrange(0, len(bank) - N); xs.append(F.place(bank[i:i + N].astype(np.float32) / 32768, room, rng, end=N, at=N - 1))
        out['neg'] = embed(xs)
    elif kind == 'room':
        out['neg'] = embed([F.place(np.zeros(1600, np.float32), room, rng) for _ in range(arg)])
    elif kind == 'speech2':  # round 2: LibriSpeech-360 (two thirds) and AMI's other meetings, 2 s at a time, in rooms
        xs = []
        for x in _speech2(rng, arg):
            xs.append(F.place(x, room, rng, end=N, at=N - 1))
        out['neg'] = embed(xs)
    os.makedirs(f'{V}/feats', exist_ok=True); np.savez(name + '.tmp.npz', **out); os.rename(name + '.tmp.npz', name); vol.commit()
    return name

def _speech2(rng, n):
    """n random 2 s pieces of round 2's ordinary speech."""
    import glob, numpy as np, soundfile as sf, pyarrow.parquet as pq
    lst = f'{V}/dl/ls360/files.txt'
    if not os.path.exists(lst):
        open(lst + '.tmp', 'w').write('\n'.join(sorted(glob.glob(f'{V}/dl/ls360/LibriSpeech/train-clean-360/**/*.flac', recursive=True)))); os.rename(lst + '.tmp', lst)
    files = open(lst).read().split(); N = 2 * 16000; out = []
    while len(out) < n * 2 // 3:
        x = sf.read(rng.choice(files), dtype='float32')[0]
        if x.ndim > 1: x = x.mean(1)
        for _ in range(4):
            if len(x) > N: i = rng.randrange(0, len(x) - N); out.append(x[i:i + N])
    t = pq.read_table(f'{V}/dl/ami/train-{rng.randrange(6, 27)}.parquet', columns=['audio']).to_pylist(); rng.shuffle(t)
    mono = lambda x: x.mean(1) if x.ndim > 1 else x  # (some AMI files are stereo)
    buf = np.concatenate([mono(sf.read(io.BytesIO(r['audio']['bytes']), dtype='float32')[0]) for r in t[:600]])
    while len(out) < n:
        i = rng.randrange(0, len(buf) - N); out.append(buf[i:i + N])
    return out

_BAB = {}
def _babble(part):
    """Other people talking, for TV-like backgrounds: LibriSpeech (train: dev-other; test: test-clean's last part)."""
    if part not in _BAB:
        import glob, soundfile as sf
        fs = sorted(glob.glob(f'{V}/dl/ls/LibriSpeech/{"dev-other" if part == "train" else "test-clean"}/**/*.flac', recursive=True))
        fs = fs[:400] if part == 'train' else fs[-300:]
        _BAB[part] = [sf.read(f, dtype='float32')[0] for f in fs]
    return _BAB[part]

@app.function(image=image, volumes={V: vol}, timeout=3600, cpu=8, memory=32768)
def speech_bank():
    """27 h of ordinary speech, once, as one int16 file: LibriSpeech dev-clean, dev-other, test-other; AMI train shards."""
    sys.path.insert(0, '/root/wake')
    if os.path.exists(f'{V}/dl/speech-bank.npy'): return 'kept'
    from build import speech_bank as sb
    ls = f'{V}/dl/ls/LibriSpeech'
    sb(','.join([f'{ls}/dev-clean', f'{ls}/dev-other', f'{ls}/test-other'] + [f'{V}/dl/ami/train-{i}.parquet' for i in range(6)]), f'{V}/dl/speech-bank.npy')
    vol.commit(); return 'made'

# ---- training ----
@app.function(image=image, volumes={V: vol}, gpu='L4', timeout=3 * 3600, cpu=8, memory=65536)
def train(cfg):
    """Train one model on everything not held out; score it on the held-out voices and openWakeWord's validation sound."""
    sys.path.insert(0, '/root/wake')
    import glob, numpy as np, torch
    from torch import nn
    from train import Head, Head2, stream_windows, fires
    dev = 'cuda'
    tr = {'pos': [], 'neg': []}; held = {'pos': [], 'neg': []}
    for f in sorted(glob.glob(f'{V}/feats/synth-*.npz')):
        z = np.load(f); key = os.path.basename(f)[6:].rsplit('-', 1)[0]
        h = bool(np.load(f'{V}/synth/{key}.npz')['held'][0])
        for k in ('pos', 'neg'): (held if h else tr)[k].append(z[k])
    gen = [np.load(f)['neg'] for f in sorted(glob.glob(f'{V}/feats/speech-*.npz')) + sorted(glob.glob(f'{V}/feats/speech2-*.npz')) + sorted(glob.glob(f'{V}/feats/room-*.npz'))]
    hard = np.concatenate([np.load(f'{V}/feats/hard-{h}.npz')['neg'] for h in cfg.get('hard', [])]) if cfg.get('hard') else None
    P = np.concatenate(tr['pos']); Nn = np.concatenate(tr['neg']); G = np.concatenate(gen)
    Pv = np.concatenate(held['pos']); Nv = np.concatenate(held['neg'])
    val = stream_windows(np.load(f'{V}/dl/oww/validation_set_features.npy').astype(np.float32)); val_h = (len(val) + 15) * 0.08 / 3600
    print(f'train: {len(P)} name, {len(Nn)} near-miss, {len(G)} other sound; held out: {len(Pv)} / {len(Nv)}', flush=True)
    torch.manual_seed(cfg.get('seed', 0)); rng = np.random.default_rng(cfg.get('seed', 0))
    model = (Head2(cfg.get('width', 192)) if cfg.get('arch') == 'v2' else Head(cfg.get('width', 128))).to(dev)
    steps, B, nw = cfg.get('steps', 60000), 1024, cfg.get('neg_weight', 100)
    lr = cfg.get('lr', 1e-3)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-2)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=steps, pct_start=0.1)
    Pt, Nt, Gt = (torch.from_numpy(x).to(dev) for x in (P, Nn, G))
    Ht = torch.from_numpy(hard).to(dev) if hard is not None and len(hard) else None
    bce = nn.BCELoss(reduction='none')
    @torch.no_grad()
    def score(x):
        model.eval(); out = torch.cat([model(torch.from_numpy(np.asarray(x[i:i + 16384], np.float32)).to(dev))[:, 0] for i in range(0, len(x), 16384)]).cpu().numpy(); model.train(); return out
    for step in range(steps):
        nh = B // 4 if Ht is not None else 0
        ip = torch.randint(0, len(Pt), (B // 4,), device=dev); ineg = torch.randint(0, len(Nt), (B // 4 - nh // 2,), device=dev); ig = torch.randint(0, len(Gt), (B // 2 - nh // 2,), device=dev)
        parts = [Pt[ip], Nt[ineg], Gt[ig]] + ([Ht[torch.randint(0, len(Ht), (nh,), device=dev)]] if nh else [])
        x = torch.cat(parts).float(); y = torch.cat([torch.ones(B // 4, device=dev), torch.zeros(B - B // 4, device=dev)])[:, None]
        out = model(x).clamp(1e-6, 1 - 1e-6)
        if cfg.get('smooth'): y = y * (1 - cfg['smooth'])  # (a little doubt on the name: its scores don't all pile up at 1.00)
        w = torch.where(y > 0.5, 1.0, float(nw))
        if nh: w[-nh:] = float(cfg.get('hard_weight', nw))
        y = y.clamp(0, 1)
        loss = (bce(out, y) * w).mean()
        opt.zero_grad(); loss.backward(); opt.step(); sched.step()
        if step % 10000 == 0: print(step, round(loss.item(), 4), flush=True)
    sp, sn, sv = score(Pv), score(Nv), score(val)
    curve = [{'thr': t, 'heard': float(np.mean(sp >= t)), 'nearWoke': float(np.mean(sn >= t)), 'falsePerHour': fires(sv, t) / val_h} for t in np.round(np.arange(0.1, 1.0, 0.05), 2).tolist()]
    model.cpu().eval()
    buf = io.BytesIO(); torch.onnx.export(model, torch.zeros(1, 16, 96), buf, input_names=['x'], output_names=['p'], dynamic_axes={'x': {0: 'n'}, 'p': {0: 'n'}}, opset_version=13, dynamo=False)
    name = cfg['name']; os.makedirs(f'{V}/models', exist_ok=True)
    open(f'{V}/models/{name}.onnx', 'wb').write(buf.getvalue()); torch.save(model.state_dict(), f'{V}/models/{name}.pt'); vol.commit()
    return {'name': name, 'cfg': cfg, 'counts': {'pos': len(P), 'near': len(Nn), 'other': len(G), 'hard': 0 if hard is None else len(hard), 'heldPos': len(Pv)}, 'curve': curve}

# ---- what it mistakes for its name ----
@app.function(image=image, volumes={V: vol}, gpu='L4', timeout=2 * 3600, cpu=8, memory=65536)
def mine(name, thr=0.2, cap=300000):
    """Run a model over the training speech (27 h, at a few levels, over a noise floor) and MUSAN's training music and
    noise, as the listener would: every window it scores at least thr is a hard negative for the next model."""
    sys.path.insert(0, '/root/wake')
    import glob, numpy as np, features as F, onnxruntime as ort
    ort.preload_dlls()
    front = F.Front(f'{V}/dl/oww', threads=4, cuda=True)
    head = ort.InferenceSession(f'{V}/models/{name}.onnx', providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])
    rng = np.random.default_rng(3); found = []; seen = 0; mined_h = [0]
    def run(x):
        nonlocal seen
        for i in range(0, len(x) - 3 * F.RATE, 10 * 60 * F.RATE):
            e = front.embeddings(x[i:i + 10 * 60 * F.RATE + 2 * F.RATE])
            if len(e) < 16: continue
            w = np.lib.stride_tricks.sliding_window_view(e, (16, 96))[:, 0]
            p = head.run(None, {'x': np.ascontiguousarray(w, np.float32)})[0][:, 0]; seen += len(p)
            found.append(w[p >= thr].astype(np.float16))
    bank = np.load(f'{V}/dl/speech-bank.npy', mmap_mode='r')
    for k in range(0, len(bank), 3600 * F.RATE):  # an hour at a time, each at its own level
        x = bank[k:k + 3600 * F.RATE].astype(np.float32) / 32768
        x = x * 10 ** ((rng.uniform(-40, -18) - F.db(x)) / 20) + rng.standard_normal(len(x)).astype(np.float32) * 10 ** (rng.uniform(-70, -55) / 20)
        run(x)
    if os.path.exists(f'{V}/dl/ls360/files.txt'):
        import random as _r, soundfile as sf
        r2 = _r.Random(5); files = open(f'{V}/dl/ls360/files.txt').read().split(); r2.shuffle(files); x = []; n = 0
        for f in files:
            a = sf.read(f, dtype='float32')[0]; x.append(a * 10 ** ((rng.uniform(-40, -18) - F.db(a)) / 20)); x.append(np.zeros(int(r2.uniform(0.2, 1.0) * F.RATE), np.float32)); n += len(a)
            if n > 3600 * F.RATE: y = np.concatenate(x); run(y + rng.standard_normal(len(y)).astype(np.float32) * 10 ** (-65 / 20)); x = []; n = 0; mined_h[0] += 1
            if mined_h[0] >= 15: break
    room = F.Room(f'{V}/dl/noise', None, 'train', babble=None, musan=f'{V}/dl/musan/musan')
    for kind in (room.music, room.noise):
        fs = list(kind); rng.shuffle(fs); x = []; n = 0
        for f in fs:
            a = room._read(f); x.append(a * 10 ** ((rng.uniform(-40, -16) - F.db(a)) / 20)); n += len(a)
            if n > 3600 * F.RATE: run(np.concatenate(x)); x = []; n = 0
        if x: run(np.concatenate(x))
    hard = np.concatenate(found) if found else np.zeros((0, 16, 96), np.float16)
    if len(hard) > cap: hard = hard[rng.choice(len(hard), cap, replace=False)]
    np.savez(f'{V}/feats/hard-{name}.npz', neg=hard); vol.commit()
    return {'name': name, 'windows': seen, 'hard': int(len(hard)), 'perHour': round(len(hard) / (seen * 0.08 / 3600), 1)}

# ---- held-out scores in streams, as the display listens ----
@app.function(image=image, volumes={V: vol}, gpu='L4', timeout=3 * 3600, cpu=8, memory=32768)
def score(name):
    """The model as the listener runs it (bridge/wake.js's streaming), on held-out voices in four rooms and on hours of
    other sound it never trained on (LibriSpeech test-clean, AMI test, GTZAN, DEMAND's test channels): by threshold,
    how many of 10 it hears, and false wakes per hour."""
    sys.path.insert(0, '/root/wake')
    import glob, numpy as np, features as F, onnxruntime as ort, soundfile as sf
    ort.preload_dlls()
    rng = random.Random(9)
    front = F.Front(f'{V}/dl/oww', threads=4, cuda=True)
    head = ort.InferenceSession(f'{V}/models/{name}.onnx', providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])
    room = F.Room(f'{V}/dl/noise', f'{V}/dl/gtzan/genres', 'test', babble=_babble('test'))
    def stream_scores(x):
        e = front.embeddings(x)
        if len(e) < 16: return np.zeros(0)
        w = np.lib.stride_tricks.sliding_window_view(e, (16, 96))[:, 0]
        return head.run(None, {'x': np.ascontiguousarray(w, np.float32)})[0][:, 0] if len(w) else np.zeros(0)
    sys.path.insert(0, '/root/wake'); from testset import room_scene
    peaks = {c: [] for c in ('near', 'far', 'tv', 'call', 'noisy')}
    for f in sorted(glob.glob(f'{V}/synth/*.npz')):
        z = np.load(f)
        if not bool(z['held'][0]): continue
        a, off = z['pos_audio'], z['pos_offsets']
        for i in range(0, len(off) - 1, 3):
            clip = a[off[i]:off[i + 1]].astype(np.float32) / 32768
            for c in peaks:
                x, _ = room_scene(clip, 'tv' if c == 'call' else c, room, rng)
                if c == 'call': x = F.call(x, rng)
                peaks[c].append(float(stream_scores(x).max(initial=0)))
    streams = {}
    def piece_scores(x):  # in 10-minute pieces, with the times of each 80 ms step
        out = []
        for i in range(0, len(x), 10 * 60 * F.RATE):
            if len(x) - i > 3 * F.RATE: out.append((i / F.RATE, stream_scores(x[i:i + 10 * 60 * F.RATE + 2 * F.RATE])))
        return out
    ls = sorted(glob.glob(f'{V}/dl/ls/LibriSpeech/test-clean/**/*.flac', recursive=True))[:-300]
    def cat(parts, hours, gap=(0.3, 1.5), level=(-34, -20)):
        out, n = [], 0
        for p in parts:
            if n > hours * 3600 * F.RATE: break
            p = p * 10 ** ((rng.uniform(*level) - F.db(p)) / 20); out += [p, np.zeros(int(rng.uniform(*gap) * F.RATE), np.float32)]; n += len(p) + len(out[-1])
        return np.concatenate(out)
    import pyarrow.parquet as pq
    def ami():
        for i in range(2):
            for r in sorted(pq.read_table(f'{V}/dl/ami/test-{i}.parquet', columns=['audio', 'meeting_id', 'begin_time']).to_pylist(), key=lambda r: (r['meeting_id'], r['begin_time'])):
                yield sf.read(io.BytesIO(r['audio']['bytes']), dtype='float32')[0]
    for key, x in (('talk', cat((sf.read(f, dtype='float32')[0] for f in ls), 5)), ('meeting', cat(ami(), 4, (0.05, 0.6), (-40, -26))),
                   ('music', cat((room._read(f) for f in room.music), 2, (0, 0.2))), ('noise', cat((room._read(f) for f in room.noise), 1, (0, 0.1), (-45, -30)))):
        sc = piece_scores(x + np.random.default_rng(1).standard_normal(len(x)).astype(np.float32) * 3e-4)
        streams[key] = {'hours': len(x) / F.RATE / 3600, 'peaks': [[round(t0 + j * 0.08, 2), round(float(p), 3)] for t0, s in sc for j, p in enumerate(s) if p >= 0.05]}
    res = {'name': name, 'positives': peaks, 'streams': streams}
    json.dump(res, open(f'{V}/models/{name}-scores.json', 'w')); vol.commit()
    return res

@app.local_entrypoint()
def main(stage: str = 'all', names: str = 'nw100,nw300', hard: str = ''):
    t0 = time.time()
    if stage in ('all', 'data'): data.remote(); speech_bank.remote()
    if stage in ('all', 'voices'):
        js = jobs(); rnd = random.Random(1)
        batches = []
        for model in sorted(set(m for m, _, _ in js)):
            mj = [j for j in js if j[0] == model]
            size = 1 if model in ('kokoro', 'en_US-l2arctic-medium') or len(mj) == 1 else 10
            batches += [mj[i:i + size] for i in range(0, len(mj), size)]
        rnd.shuffle(batches)
        n = 0
        for r in voices.map(batches, order_outputs=False, return_exceptions=True):
            if isinstance(r, tuple): n += r[1]
        print('name clips', n, f'{(time.time() - t0) / 60:.0f} min', flush=True)
    if stage in ('all', 'features'):
        files = sorted(f'{V}/synth/{m}-{s}.npz' for m, s, _ in [b[0] for b in _batches_first()])
        tasks = [('synth', f, 1) for f in files] + [('speech', 2000, s) for s in range(100)] + [('room', 2000, 1000 + s) for s in range(60)]
        for _ in features.map(tasks, order_outputs=False, return_exceptions=True): pass
        print('features done', f'{(time.time() - t0) / 60:.0f} min', flush=True)
    if stage in ('clone', 'clone360'):
        spks = speakers.remote() if stage == 'clone' else speakers360.remote()[::9]  # (~100 of the 904: the Starter plan's limit)
        n = d = 0
        for r in clone.map(spks, order_outputs=False, return_exceptions=True):
            if isinstance(r, tuple): n += r[1]; d += r[2]
        print('cloned name clips', n, 'dropped', d, flush=True)
        return
    if stage == 'features2':  # the cloned voices and round 2's ordinary speech, as features
        files = synth_files.remote(); tasks = [('synth', f, 1) for f in files if 'clone-' in f] + [('speech2', 2000, 5000 + s) for s in range(200)]
        for _ in features.map(tasks, order_outputs=False, return_exceptions=True): pass
        print('features2 done', flush=True); return
    if stage == 'train2':  # names like v2a:300:1000 (name:neg weight:hard weight), hard negatives from --hard
        cfgs = []
        for spec in names.split(','):
            n, nw, hw, *more = spec.split(':'); steps = int(more[0]) if more else 80000; width = int(more[1]) if len(more) > 1 else 192
            cfgs.append({'name': n, 'arch': 'v2', 'neg_weight': int(nw), 'hard_weight': int(hw), 'hard': [h for h in hard.split(',') if h], 'smooth': 0.05, 'steps': steps, 'width': width, 'lr': 5e-4})
        for r in train.map(cfgs): json.dump(r, open(os.path.expanduser(f'~/.cache/openhouse-wake/reports/modal-{r["name"]}-train.json'), 'w')); print(r['name'], r['counts'], [c for c in r['curve'] if c['thr'] in (0.5, 0.9)], flush=True)
        return
    if stage == 'mine':
        for n in names.split(','): print(mine.remote(n), flush=True)
        return
    if stage == 'harden':  # mine the hard negatives of the first name, then train the rest with them
        base, *rest = names.split(',')
        print(mine.remote(base), flush=True)
        prev = [h for h in ('nw300', 'h1000') if h != base]  # (hard negatives mined before: kept)
        cfgs = [{'name': n, 'neg_weight': 300, 'hard': [base] + prev, 'hard_weight': int(n.lstrip('ghn'))} for n in rest]
        for r in train.map(cfgs): json.dump(r, open(os.path.expanduser(f'~/.cache/openhouse-wake/reports/modal-{r["name"]}-train.json'), 'w')); print(r['name'], r['counts'], [c for c in r['curve'] if c['thr'] in (0.5, 0.9)], flush=True)
        return
    if stage in ('all', 'train', 'score'):
        cfgs = [{'name': n, 'neg_weight': int(n[2:])} for n in names.split(',')]
        if stage != 'score':
            for r in train.map(cfgs): json.dump(r, open(os.path.expanduser(f'~/.cache/openhouse-wake/reports/modal-{r["name"]}-train.json'), 'w')); print(r['name'], r['counts'], [c for c in r['curve'] if c['thr'] in (0.5, 0.7, 0.9)], flush=True)
        for r in score.map([c['name'] for c in cfgs]): json.dump(r, open(os.path.expanduser(f'~/.cache/openhouse-wake/reports/modal-{r["name"]}-scores.json'), 'w')); print('scored', r['name'], flush=True)
    print(f'{(time.time() - t0) / 60:.0f} min')

def _batches_first():
    js = jobs(); out = []
    for model in sorted(set(m for m, _, _ in js)):
        mj = [j for j in js if j[0] == model]; size = 1 if model in ('kokoro', 'en_US-l2arctic-medium') or len(mj) == 1 else 10
        out += [mj[i:i + size] for i in range(0, len(mj), size)]
    return out

@app.function(image=image, volumes={V: vol}, gpu='L4', timeout=900)
def smoke():
    """One clip from each kind of voice, embedded on the GPU: does the image work?"""
    sys.path.insert(0, '/root/wake')
    import numpy as np, synth, features as F, onnxruntime as ort, piper, tempfile
    ort.preload_dlls(); print(ort.get_available_providers())
    from piper import PiperVoice
    from testset import Kokoro, trim
    v = PiperVoice.load(f'{V}/dl/piper/en_US-libritts_r-medium.onnx', use_cuda=True, espeak_data_dir=os.path.join(os.path.dirname(piper.__file__), 'espeak-ng-data'))
    t = time.time(); a = [synth.say(v, 'Hey Opee', s, random.Random(s)) for s in range(50)]; print('piper 50 clips', round(time.time() - t, 2), 's', len(a[0]))
    k = Kokoro(f'{V}/dl/kokoro-multi-lang-v1_0', tempfile.mkdtemp()); t = time.time(); b = trim(k('Hey Opie', 3)); print('kokoro', round(time.time() - t, 2), 's', len(b))
    f = F.Front(f'{V}/dl/oww', cuda=True); room = F.Room(f'{V}/dl/noise', f'{V}/dl/gtzan/genres', 'train', babble=None, musan=f'{V}/dl/musan/musan')
    xs = [F.place(x, room, random.Random(i)) for i, x in enumerate(a)]; t = time.time(); e = f.embeddings_batch(xs); print('embed', e.shape, round(time.time() - t, 2), 's', f.mel.get_providers())

# ==== round 2: cloned voices, more ordinary speech, a bigger model, standalone ====
clone_image = (modal.Image.debian_slim(python_version='3.11')
               .apt_install('ffmpeg', 'libsndfile1', 'git')
               .pip_install('chatterbox-tts==0.1.7', 'soundfile', 'scipy', 'sherpa-onnx==2.0.1', 'pyarrow')
               .env({'HF_HOME': f'{V}/hf'})
               .add_local_dir(HERE, '/root/wake', ignore=['__pycache__', '*.pyc']))

@app.function(image=image, volumes={V: vol}, timeout=6 * 3600, cpu=4)
def data2():
    """Round 2's public data (commercial use allowed): LibriTTS-R train-clean-100 (CC-BY 4.0; reference voices to clone),
    LibriSpeech train-clean-360 (CC-BY 4.0) and more AMI meetings (CC-BY 4.0) as ordinary speech, Parakeet (CC-BY 4.0)
    to check the cloned clips say the name."""
    d = f'{V}/dl'
    if not os.path.isdir(f'{d}/libritts_r/LibriTTS_R/train-clean-100'): os.makedirs(f'{d}/libritts_r', exist_ok=True); _sh(f'curl -sSLf https://openslr.elda.org/resources/141/train_clean_100.tar.gz | tar xz -C {d}/libritts_r --wildcards "*.wav"')
    if not os.path.isdir(f'{d}/parakeet'): _sh(f'cd {d} && curl -sSLf https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2 | tar xj && mv sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8 parakeet')
    vol.commit()
    if not os.path.isdir(f'{d}/ls360/LibriSpeech/train-clean-360'): os.makedirs(f'{d}/ls360', exist_ok=True); _sh(f'curl -sSLf https://openslr.elda.org/resources/12/train-clean-360.tar.gz | tar xz -C {d}/ls360')
    for i in range(6, 27):
        f = f'{d}/ami/train-{i}.parquet'
        if not os.path.exists(f): _sh(f'curl -sSLf "https://huggingface.co/datasets/edinburghcstr/ami/resolve/main/sdm/train-{i:05d}-of-00027.parquet" -o {f}.part && mv {f}.part {f}')
    vol.commit(); _sh(f'du -sh {d}/*')

@app.function(image=clone_image, volumes={V: vol}, gpu='L4', timeout=900)
def clone_smoke():
    import glob, torch, numpy as np, soundfile as sf
    from chatterbox.tts import ChatterboxTTS
    m = ChatterboxTTS.from_pretrained(device='cuda')
    ref = sorted(glob.glob(f'{V}/dl/ls/LibriSpeech/test-other/**/*.flac', recursive=True))[5]
    t = time.time()
    for text in ['Hey Opie.', 'Opie, what time is it?', 'Hey Opie, set a timer.', 'Okay, please.']:
        w = m.generate(text, audio_prompt_path=ref, exaggeration=0.5, cfg_weight=0.5)
        print(text, w.shape, m.sr, round(time.time() - t, 2)); t = time.time()
    vol.commit()

_MODELS = {}

@app.function(image=clone_image, volumes={V: vol}, gpu='L4', timeout=1500, max_containers=10)  # (the Starter plan: 10 GPUs)
def clone(spk_dir, n_pos=32, n_neg=12):
    """One LibriTTS-R speaker's voice, cloned (Chatterbox, MIT): the name and near-misses in it. Each name clip must be
    heard as the name by Parakeet (else it's dropped: a cloned voice can mumble or say something else)."""
    sys.path.insert(0, '/root/wake')
    import glob, re, numpy as np, soundfile as sf, sherpa_onnx
    from scipy.signal import resample_poly
    import synth
    key = 'clone-' + os.path.basename(spk_dir); out = f'{V}/synth/{key}.npz'
    if os.path.exists(out): return key, 0, 0
    from chatterbox.tts import ChatterboxTTS
    if 'cb' not in _MODELS: _MODELS['cb'] = ChatterboxTTS.from_pretrained(device='cuda')
    if 'asr' not in _MODELS:
        P = f'{V}/dl/parakeet'
        for _ in range(20):
            if os.path.exists(f'{P}/encoder.int8.onnx'): break
            time.sleep(15); vol.reload()
        _MODELS['asr'] = sherpa_onnx.OfflineRecognizer.from_transducer(encoder=f'{P}/encoder.int8.onnx', decoder=f'{P}/decoder.int8.onnx', joiner=f'{P}/joiner.int8.onnx', tokens=f'{P}/tokens.txt', model_type='nemo_transducer', num_threads=4)
    _CB, _ASR = _MODELS['cb'], _MODELS['asr']
    wavs = sorted(glob.glob(f'{spk_dir}/**/*.wav', recursive=True))
    lens = [(sf.info(w).duration, w) for w in wavs[:200]]; good = [w for d, w in lens if 5 <= d <= 12] or [max(lens)[1]]
    rng = random.Random(key)
    heard = re.compile(r"^\W*(?:(?:hey|hi|okay|ok|oh)\W+)?(opie|opi|opee|oppy|ohpee|oh pee|o\.? ?p\.?|op|obi|obie|oby)(?![a-z])", re.I)
    def say(text):
        w = _CB.generate(text, audio_prompt_path=rng.choice(good), exaggeration=rng.uniform(0.3, 0.8), cfg_weight=rng.uniform(0.3, 0.7), temperature=rng.uniform(0.6, 1.0))
        a = resample_poly(w[0].cpu().numpy().astype(np.float32), 2, 3).astype(np.float32)  # 24 kHz -> 16 kHz
        nz = np.nonzero(np.abs(a) > 0.01 * (np.abs(a).max() or 1))[0]
        return a[max(0, nz[0] - 480): nz[-1] + 480] if len(nz) else a
    def asr(a):
        s = _ASR.create_stream(); s.accept_waveform(16000, np.concatenate([np.zeros(8000, np.float32), a, np.zeros(8000, np.float32)])); _ASR.decode_stream(s); return s.result.text
    pos, neg, dropped = [], [], 0
    for i in range(n_pos):
        t = rng.choice(synth.WAKE).format(n='Opie'); a = say(t)
        if not heard.match(asr(a)): dropped += 1; continue
        end = len(a)
        if i % 4 == 3: nxt = rng.choice(synth.AFTER); a = np.concatenate([a, np.zeros(int(rng.uniform(0, 0.15) * 16000), np.float32), say(nxt)]); t += ' ' + nxt
        pos.append((t, a, end))
    for i in range(n_neg):
        t = rng.choice(synth.NEAR) if i % 3 else rng.choice(synth.SENTENCES); a = say(t); neg.append((t, a, len(a)))
    def pack(items):
        if not items: return dict(audio=np.zeros(0, np.int16), offsets=np.zeros(1, np.int64), ends=np.zeros(0, np.int64), texts=np.array([], dtype=str))
        lens = np.array([len(a) for _, a, _ in items], np.int64)
        return dict(audio=np.concatenate([np.clip(a * 32767, -32768, 32767).astype(np.int16) for _, a, _ in items]), offsets=np.concatenate([[0], np.cumsum(lens)]),
                    ends=np.array([e for _, _, e in items], np.int64), texts=np.array([t for t, _, _ in items]))
    os.makedirs(f'{V}/synth', exist_ok=True)
    np.savez(out + '.tmp.npz', **{f'pos_{k}': v for k, v in pack(pos).items()}, **{f'neg_{k}': v for k, v in pack(neg).items()}, held=np.array([False]))
    os.rename(out + '.tmp.npz', out); vol.commit()
    return key, len(pos), dropped

@app.function(image=image, volumes={V: vol}, timeout=600)
def speakers():
    import glob
    return sorted(glob.glob(f'{V}/dl/libritts_r/LibriTTS_R/train-clean-100/*'))

@app.function(image=image, volumes={V: vol}, timeout=600)
def synth_files():
    import glob
    return sorted(glob.glob(f'{V}/synth/*.npz'))

@app.function(image=image, volumes={V: vol}, timeout=6 * 3600, cpu=4)
def data3():
    """904 more reference voices to clone: LibriTTS-R train-clean-360 (CC-BY 4.0)."""
    d = f'{V}/dl/libritts_r'
    if not os.path.isdir(f'{d}/LibriTTS_R/train-clean-360'): _sh(f'curl -sSLf https://openslr.elda.org/resources/141/train_clean_360.tar.gz | tar xz -C {d} --wildcards "*.wav"')
    vol.commit()

@app.function(image=image, volumes={V: vol}, timeout=600)
def speakers360():
    import glob
    return sorted(glob.glob(f'{V}/dl/libritts_r/LibriTTS_R/train-clean-360/*'))

# ==== round 3: far more, and more varied, ordinary speech; more cloned voices ====
# Ordinary speech whose licenses allow commercial use, each source cut into shards: YouTube talk (YODAS2, CC-BY 3.0),
# People's Speech "clean" (CC-BY), European Parliament speeches (VoxPopuli English, CC0), earnings calls (Earnings-22,
# CC-BY-SA 4.0), LibriSpeech train-other-500 (CC-BY 4.0). Each shard becomes a stream (utterances with gaps), put in
# rooms 20 s at a time, embedded once; the windows are kept (every 4th: 320 ms apart) as features on the volume, so mining
# and training never touch the audio again. Shard 0 of each source is held out, all windows kept, to count false wakes
# on speech no model trained on.
HF = 'https://huggingface.co/datasets'
SOURCES = {
    'yodas': [f'{HF}/espnet/yodas2/resolve/main/data/en{s:03d}/audio/{i:08d}.tar.gz' for s in (0, 1, 2, 3, 100, 101) for i in range(4)],
    # (Appended to, never reordered: a shard's file on the volume is named by its place in the list.)
    'people': [f'{HF}/MLCommons/peoples_speech/resolve/main/clean/train-{i:05d}-of-00804.parquet' for i in list(range(0, 804, 27)) + [i for i in range(0, 804, 9) if i % 27]],
    'vox': [f'{HF}/facebook/voxpopuli/resolve/main/en/train-{i:05d}-of-00030.parquet' for i in range(0, 30, 3)] + [f'{HF}/facebook/voxpopuli/resolve/main/en_accented/test-00001-of-00002.parquet']
           + [f'{HF}/facebook/voxpopuli/resolve/main/en/train-{i:05d}-of-00030.parquet' for i in range(30) if i % 3],
    'earnings': [f'{HF}/distil-whisper/earnings22/resolve/main/full/' + n for n in ('test-00000-of-00004-4541e1972fe3ed48.parquet', 'test-00001-of-00004-e6d772bca8e23981.parquet', 'test-00002-of-00004-25462b81a4cd9f09.parquet', 'test-00003-of-00004-514196049d554a43.parquet')],
    'ls500': [f'https://openslr.elda.org/resources/12/train-other-500.tar.gz#{k}' for k in range(6)],  # (#k: the speakers whose number % 6 is k)
}

def _decode(b, name=''):
    """Audio bytes (wav, flac, ogg/opus, mp3...) -> 16 kHz mono float32."""
    import numpy as np, soundfile as sf, subprocess
    from scipy.signal import resample_poly
    try: x, sr = sf.read(io.BytesIO(b), dtype='float32')
    except Exception:
        p = subprocess.run(['ffmpeg', '-v', 'quiet', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], input=b, capture_output=True)
        return np.frombuffer(p.stdout, np.int16).astype(np.float32) / 32768
    if x.ndim > 1: x = x.mean(1)
    if sr != 16000: from math import gcd; g = gcd(sr, 16000); x = resample_poly(x, 16000 // g, sr // g).astype(np.float32)
    return x

def _utterances(src, url, rng, hours):
    """The shard's utterances, as audio, in a random order, up to about `hours`."""
    import numpy as np, tarfile, pyarrow.parquet as pq, subprocess
    path = '/tmp/shard'; url, _, part = url.partition('#')
    total = 0
    if url.endswith('.parquet'):
        subprocess.run(f'curl -sSLf --retry 5 "{url}" -o {path}', shell=True, check=True)
        f = pq.ParquetFile(path); col = 'audio'
        groups = list(range(f.num_row_groups)); rng.shuffle(groups)
        for g in groups:
            for r in f.read_row_group(g, columns=[col]).to_pylist():
                x = _decode(r[col]['bytes'])
                if len(x) < 8000: continue
                yield x; total += len(x)
                if total > hours * 3600 * 16000: return
    else:
        cur = subprocess.Popen(['curl', '-sSLf', '--retry', '5', url], stdout=subprocess.PIPE)  # (streamed: no disk)
        with tarfile.open(fileobj=cur.stdout, mode='r|gz') as t:
            for m in t:
                if not m.isfile() or not m.name.lower().endswith(('.wav', '.flac', '.opus', '.ogg', '.mp3', '.m4a', '.webm')): continue
                if part and int(os.path.basename(m.name).split('-')[0]) % 6 != int(part): continue
                x = _decode(t.extractfile(m).read(), m.name)
                if len(x) < 8000: continue
                if len(x) > 600 * 16000: i = rng.randrange(0, len(x) - 600 * 16000); x = x[i:i + 600 * 16000]  # (a long video: ten minutes of it)
                yield x; total += len(x)
                if total > hours * 3600 * 16000: cur.kill(); return

@app.function(image=image, volumes={V: vol}, gpu='L4', cpu=8, memory=32768, timeout=3 * 3600, max_containers=20)
def bank(job):
    """(source, index, hours) -> /vol/bank3/<source>-<index>.npz: the shard's speech in rooms, as windows of 16 embeddings."""
    sys.path.insert(0, '/root/wake')
    import numpy as np, features as F, onnxruntime as ort
    src, i, hours = job; url = SOURCES[src][i]; held = i == 0
    if held: hours = min(hours, 5)  # (every window kept: 5 hours is plenty to count false wakes)
    out = f'{V}/bank3/{src}-{i}.npz'
    if os.path.exists(out): return src, i, 'kept'
    ort.preload_dlls()
    rng = random.Random(f'{src}-{i}'); t0 = time.time()
    room = F.Room(f'{V}/dl/noise', f'{V}/dl/gtzan/genres' if held else None, 'test' if held else 'train', babble=_babble('test' if held else 'train'), musan=None if held else f'{V}/dl/musan/musan')
    front = F.Front(f'{V}/dl/oww', threads=4, cuda=True)
    CH = 20 * F.RATE; stride = 1 if held else 4
    chunks, wins, secs = [], [], 0.0
    def flush():
        if not chunks: return
        e = front.embeddings_batch(chunks)  # (n, k, 96)
        w = np.lib.stride_tricks.sliding_window_view(e, (16, 96), axis=(1, 2))[:, :, 0]  # (n, k-15, 16, 96)
        off = rng.randrange(stride)
        wins.append(w[:, off::stride].reshape(-1, 16, 96).astype(np.float16)); chunks.clear()
    buf = []; n = 0
    for x in _utterances(src, url, rng, hours):
        x = x * 10 ** ((rng.uniform(-6, 6)) / 20)  # (one speaker a little louder than another)
        buf += [x, np.zeros(int(rng.uniform(0.1, 1.2) * F.RATE), np.float32)]; n += len(x) + len(buf[-1])
        while n >= CH:
            s = np.concatenate(buf); c, rest = s[:CH], s[CH:]; buf = [rest]; n = len(rest)
            chunks.append(F.place(c, room, rng, end=CH, at=CH - 1, n=CH)); secs += 20
            if len(chunks) == 32: flush()
    flush()
    W = np.concatenate(wins) if wins else np.zeros((0, 16, 96), np.float16)
    os.makedirs(f'{V}/bank3', exist_ok=True)
    np.savez(out + '.tmp.npz', neg=W, hours=np.array([secs / 3600]), held=np.array([held]), stride=np.array([stride]))
    os.rename(out + '.tmp.npz', out); vol.commit()
    return src, i, round(secs / 3600, 1), len(W), round((time.time() - t0) / 60, 1)

@app.function(image=image, volumes={V: vol}, timeout=600)
def bank_files():
    import glob
    vol.reload(); return sorted(glob.glob(f'{V}/bank3/*.npz'))

@app.function(image=image, volumes={V: vol}, cpu=4, timeout=3600)
def vox_refs(n_spk=300):
    """Reference voices to clone from accented English (VoxPopuli en_accented, CC0): a folder of wavs per speaker."""
    import numpy as np, soundfile as sf, pyarrow.parquet as pq, subprocess
    d = f'{V}/dl/voxrefs'
    if os.path.isdir(d) and len(os.listdir(d)) >= 10: return sorted(f'{d}/{s}' for s in os.listdir(d))
    subprocess.run(f'curl -sSLf "{HF}/facebook/voxpopuli/resolve/main/en_accented/test-00000-of-00002.parquet" -o /tmp/acc.parquet', shell=True, check=True)  # (the other half of en_accented is a bank shard)
    t = pq.read_table('/tmp/acc.parquet').to_pylist()
    by = {}
    for r in t:
        spk = str(r.get('speaker_id') or r.get('speaker') or ''); x = _decode(r['audio']['bytes'])
        if spk and 4 * 16000 <= len(x) <= 14 * 16000: by.setdefault(spk, []).append(x)
    spks = sorted(by)[:n_spk]
    for s in spks:
        os.makedirs(f'{d}/{s}', exist_ok=True)
        for k, x in enumerate(by[s][:6]): sf.write(f'{d}/{s}/{k}.wav', x, 16000)
    vol.commit(); return sorted(f'{d}/{s}' for s in spks)

@app.function(image=image, volumes={V: vol}, gpu='L4', cpu=8, memory=32768, timeout=3600, max_containers=10)
def mine3(job):
    """(model, bank file, thr) -> the windows of a training shard the model scores at least thr: hard negatives."""
    import numpy as np, onnxruntime as ort
    ort.preload_dlls()
    name, f, thr = job
    out = f'{V}/hard3/{name}-{os.path.basename(f)}'
    if os.path.exists(out): return name, f, 'kept'
    z = np.load(f)
    if bool(z['held'][0]): return name, f, 'held'
    W = z['neg']; head = ort.InferenceSession(f'{V}/models/{name}.onnx', providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])
    p = np.concatenate([head.run(None, {'x': W[i:i + 65536].astype(np.float32)})[0][:, 0] for i in range(0, len(W), 65536)])
    os.makedirs(f'{V}/hard3', exist_ok=True); np.savez(out + '.tmp.npz', neg=W[p >= thr]); os.rename(out + '.tmp.npz', out); vol.commit()
    h = float(z['hours'][0]); return name, os.path.basename(f), int((p >= thr).sum()), round(float((p >= 0.9).sum()) / h, 1)

@app.function(image=image, volumes={V: vol}, gpu='A100-80GB', timeout=5 * 3600, cpu=8, memory=196608)
def train3(cfg):
    """Round 3's training: round 2's name clips, near-misses and ordinary sound, plus the bank's training shards (sampled)
    and hard negatives mined from it. Scored on held-out voices, openWakeWord's validation sound, and the bank's
    held-out shards (false wakes an hour per source)."""
    sys.path.insert(0, '/root/wake')
    import glob, numpy as np, torch
    from torch import nn
    from train import Head2, stream_windows, fires
    dev = 'cuda'; vol.reload()
    rng = np.random.default_rng(cfg.get('seed', 0)); torch.manual_seed(cfg.get('seed', 0))
    tr = {'pos': [], 'neg': []}; held = {'pos': [], 'neg': []}
    for f in sorted(glob.glob(f'{V}/feats/synth-*.npz')):
        z = np.load(f); key = os.path.basename(f)[6:].rsplit('-', 1)[0]
        h = bool(np.load(f'{V}/synth/{key}.npz')['held'][0])
        for k in ('pos', 'neg'): (held if h else tr)[k].append(z[k])
    gen = [np.load(f)['neg'] for f in sorted(glob.glob(f'{V}/feats/speech-*.npz')) + sorted(glob.glob(f'{V}/feats/speech2-*.npz')) + sorted(glob.glob(f'{V}/feats/room-*.npz'))]
    banks = sorted(glob.glob(f'{V}/bank3/*.npz')); btr, bheld = [], {}
    per = cfg.get('bank_n', 6_000_000) // max(1, sum(1 for f in banks if not bool(np.load(f)['held'][0])))
    for f in banks:
        z = np.load(f); W = z['neg']
        if bool(z['held'][0]): bheld[os.path.basename(f)] = (W, float(z['hours'][0]))
        else: btr.append(W[rng.choice(len(W), min(per, len(W)), replace=False)] if len(W) > per else W)
    hard = [np.load(f'{V}/feats/hard-{h}.npz')['neg'] for h in cfg.get('hard', []) if os.path.exists(f'{V}/feats/hard-{h}.npz')]  # (round 2's, where this volume has them)
    hard += [np.load(f)['neg'] for h in cfg.get('hard3', []) for f in sorted(glob.glob(f'{V}/hard3/{h}-*.npz'))]
    P = np.concatenate(tr['pos']); Nn = np.concatenate(tr['neg']); G = np.concatenate(gen + btr)
    H = np.concatenate(hard) if hard else None
    if H is not None and len(H) > cfg.get('hard_cap', 2_000_000): H = H[rng.choice(len(H), cfg.get('hard_cap', 2_000_000), replace=False)]
    Pv = np.concatenate(held['pos']); Nv = np.concatenate(held['neg'])
    val = stream_windows(np.load(f'{V}/dl/oww/validation_set_features.npy').astype(np.float32)); val_h = (len(val) + 15) * 0.08 / 3600
    print(f'train: {len(P)} name, {len(Nn)} near-miss, {len(G)} other sound ({sum(len(b) for b in btr)} from the bank), {0 if H is None else len(H)} hard; held out: {len(Pv)} / {len(Nv)}; held streams {list(bheld)}', flush=True)
    model = Head2(cfg.get('width', 128)).to(dev)
    steps, B, nw = cfg.get('steps', 60000), 2048, cfg.get('neg_weight', 300)
    lr = cfg.get('lr', 5e-4)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=cfg.get('wd', 1e-2))
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=steps, pct_start=0.1)
    Pt, Nt, Gt = (torch.from_numpy(x).to(dev) for x in (P, Nn, G))
    Ht = torch.from_numpy(H).to(dev) if H is not None and len(H) else None
    bce = nn.BCELoss(reduction='none')
    @torch.no_grad()
    def score(x):
        model.eval(); out = torch.cat([model(torch.from_numpy(np.asarray(x[i:i + 32768], np.float32)).to(dev))[:, 0] for i in range(0, len(x), 32768)]).cpu().numpy(); model.train(); return out
    def evaluate():
        sp, sn, sv = score(Pv), score(Nv), score(val); hs = {k: (score(W), h) for k, (W, h) in bheld.items()}
        return [{'thr': t, 'heard': round(float(np.mean(sp >= t)), 4), 'nearWoke': round(float(np.mean(sn >= t)), 4), 'oww': round(fires(sv, t) / val_h, 2),
                 **{k.replace('.npz', ''): round(fires(s, t) / h, 2) for k, (s, h) in hs.items()}} for t in (0.5, 0.7, 0.8, 0.9, 0.95, 0.98)]
    noise = cfg.get('feat_noise', 0.0)
    for step in range(steps):
        nh = B // 4 if Ht is not None else 0
        ip = torch.randint(0, len(Pt), (B // 4,), device=dev); ineg = torch.randint(0, len(Nt), (B // 8,), device=dev); ig = torch.randint(0, len(Gt), (B - B // 4 - B // 8 - nh,), device=dev)
        parts = [Pt[ip], Nt[ineg], Gt[ig]] + ([Ht[torch.randint(0, len(Ht), (nh,), device=dev)]] if nh else [])
        x = torch.cat(parts).float(); y = torch.cat([torch.ones(B // 4, device=dev), torch.zeros(B - B // 4, device=dev)])[:, None]
        if noise: x = x + torch.randn_like(x) * noise * x.std(dim=(1, 2), keepdim=True)
        out = model(x).clamp(1e-6, 1 - 1e-6)
        if cfg.get('smooth'): y = y * (1 - cfg['smooth'])
        w = torch.where(y > 0.5, 1.0, float(nw))
        if nh: w[-nh:] = float(cfg.get('hard_weight', nw))
        loss = (bce(out, y) * w).mean()
        opt.zero_grad(); loss.backward(); opt.step(); sched.step()
        if step % 10000 == 0: print(step, round(loss.item(), 4), flush=True)
    curve = evaluate()
    model.cpu().eval()
    buf = io.BytesIO(); torch.onnx.export(model, torch.zeros(1, 16, 96), buf, input_names=['x'], output_names=['p'], dynamic_axes={'x': {0: 'n'}, 'p': {0: 'n'}}, opset_version=13, dynamo=False)
    name = cfg['name']; os.makedirs(f'{V}/models', exist_ok=True)
    open(f'{V}/models/{name}.onnx', 'wb').write(buf.getvalue()); torch.save(model.state_dict(), f'{V}/models/{name}.pt'); vol.commit()
    return {'name': name, 'cfg': cfg, 'counts': {'pos': len(P), 'near': len(Nn), 'other': len(G), 'hard': 0 if H is None else len(H), 'heldPos': len(Pv)}, 'curve': curve}

@app.local_entrypoint()
def r3(stage: str, hours: float = 20, names: str = '', thr: float = 0.3, only: str = ''):
    """Round 3. --stage bank (all shards) | banksmoke | clonemore | features3 | mine --names a,b | train --names spec,..."""
    t0 = time.time(); R = os.path.expanduser('~/.cache/openhouse-wake/reports')
    if stage in ('bank', 'banksmoke'):
        jobs_ = [(s, i, hours) for s, urls in SOURCES.items() for i in range(len(urls)) if not only or s in only.split(',')]
        if stage == 'banksmoke': jobs_ = [(s, 1 if len(SOURCES[s]) > 1 else 0, 0.3) for s in SOURCES if not only or s in only.split(',')]
        for r in bank.map(jobs_, order_outputs=False, return_exceptions=True): print(r, f'{(time.time() - t0) / 60:.0f} min', flush=True)
    if stage == 'clonemore':  # the rest of LibriTTS-R train-clean-360's voices, and accented voices from VoxPopuli
        # (~11 min a voice on an L4: a third of LibriTTS-R's 360 voices and 150 accented ones, mixed so both come early)
        a, b = speakers360.remote()[::3], vox_refs.remote()[:150]
        spks = [x for pair in zip(a, b + [None] * len(a)) for x in pair if x]
        n = d = 0
        for r in clone.with_options(max_containers=25).map(spks, order_outputs=False, return_exceptions=True):
            if isinstance(r, tuple): n += r[1]; d += r[2]
            else: print('clone error', str(r)[:200], flush=True)
        print('cloned name clips', n, 'dropped', d, f'{(time.time() - t0) / 60:.0f} min', flush=True)
    if stage == 'featureshard':  # every voice's name clips again, far and over music or talk (seed 100: train3 takes them as more name clips)
        files = synth_files.remote(); tasks = [('synth', f, 100) for f in files]
        for _ in features.map(tasks, order_outputs=False, return_exceptions=True): pass
        print('featureshard done', flush=True)
    if stage == 'features3':
        files = synth_files.remote(); tasks = [('synth', f, 1) for f in files if 'clone-' in f]
        for _ in features.map(tasks, order_outputs=False, return_exceptions=True): pass
        print('features3 done', flush=True)
    if stage == 'mine':
        fs = bank_files.remote()
        for r in mine3.map([(n, f, thr) for n in names.split(',') for f in fs], order_outputs=False, return_exceptions=True): print(r, flush=True)
    if stage == 'train':  # name:neg weight:hard weight:steps:width[:hard3 models separated by +][:feat noise]
        cfgs = []
        for spec in names.split(','):
            n, nw, hw, st, wd, *more = spec.split(':')
            cfgs.append({'name': n, 'neg_weight': int(nw), 'hard_weight': int(hw), 'steps': int(st), 'width': int(wd), 'smooth': 0.05,
                         'hard': ['nw300', 'h1000', 'v2a'], 'hard3': [h for h in (more[0].split('+') if more else []) if h], 'feat_noise': float(more[1]) if len(more) > 1 else 0.0})
        for r in train3.map(cfgs, order_outputs=False, return_exceptions=True):
            if not isinstance(r, dict): print('train error', str(r)[:300], flush=True); continue
            json.dump(r, open(f'{R}/r3-{r["name"]}-train.json', 'w')); print(r['name'], r['counts'], flush=True)
            for c in r['curve']: print('  ', c, flush=True)
    print(f'{(time.time() - t0) / 60:.0f} min', flush=True)

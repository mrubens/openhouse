"""Training examples for the wake model: synthetic clips (synth.py) put in rooms (features.py), as openWakeWord features.

  python build.py --synth <synth.py's out> --oww <dir with melspectrogram.onnx, embedding_model.onnx>
                  --noise <DEMAND dir> [--music <GTZAN genres dir>] --out <dir> [--copies 3]

Writes <out>/{pos,neg}-{train,val}.npy: (n, 16, 96) float16, the last 1.28 s before each example's mark (the end of
"Opie" for positives; anywhere for near-misses, noise and music).

With --speech <LibriSpeech dirs and AMI parquets, comma-separated>: also <out>/speech-train.npy, random 2 s of ordinary
speech in the same rooms (--crops of them): what the model learns "not the name" from, besides the near-misses.
"""
import argparse, glob, io, os, random, sys
from multiprocessing import Pool
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from features import Front, Room, load_npz, place, RATE, WIN

N = int(WIN * RATE)
G = {}

def init(a, babble):
    G['front'] = Front(a.oww, threads=1)
    G['room'] = Room(a.noise, a.music, 'train', babble, a.musan)
    G['a'] = a

def speech_bank(spec, path):
    """Ordinary speech, once, as one int16 file (memory-mapped by each worker)."""
    if os.path.exists(path): return
    import soundfile as sf
    from scipy.signal import resample_poly
    parts = []
    for src in spec.split(','):
        if src.endswith('.parquet'):
            import pyarrow.parquet as pq
            for r in pq.read_table(src, columns=['audio']).to_pylist():
                x, sr = sf.read(io.BytesIO(r['audio']['bytes']), dtype='float32')
                parts.append(x if sr == RATE else resample_poly(x, RATE, sr).astype(np.float32))
        else:
            for f in sorted(glob.glob(os.path.join(src, '**', '*.flac'), recursive=True)): parts.append(sf.read(f, dtype='float32')[0])
    x = np.concatenate(parts); x = x / (np.abs(x).max() or 1)
    np.save(path + '.tmp.npy', np.clip(x * 32767, -32768, 32767).astype(np.int16)); os.rename(path + '.tmp.npy', path)
    print(f'speech bank: {len(x) / RATE / 3600:.1f} h', flush=True)

def run(job):
    kind, clips, seed = job
    rng = random.Random(seed); front, room = G['front'], G['room']
    out = []
    for audio, end, _ in clips:
        for _ in range(G['a'].copies if kind == 'pos' else max(1, G['a'].copies - 1)):
            if kind == 'pos':  # the name ends 0-240 ms before the window does
                x = place(audio, room, rng, end=end, at=N - 1 - int(rng.uniform(0, 0.24) * RATE))
            elif kind == 'neg':  # a near-miss anywhere in the window
                x = place(audio, room, rng, end=len(audio), at=int(rng.uniform(0.55, 1.0) * (N - 1)))
            elif kind == 'speech':  # 2 s of someone talking, as the room has it
                bank = G.setdefault('bank', np.load(G['a'].bank, mmap_mode='r'))
                i = rng.randrange(0, len(bank) - N); y = bank[i:i + N].astype(np.float32) / 32768
                x = place(y, room, rng, end=N, at=N - 1)
            else:  # the room alone
                x = place(np.zeros(1600, np.float32), room, rng)
            out.append(x)
    e = front.embeddings_batch(out)[:, -16:]
    return kind, e.astype(np.float16)

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    for k in ('synth', 'oww', 'noise', 'out'): p.add_argument('--' + k, required=True)
    p.add_argument('--music'); p.add_argument('--copies', type=int, default=3); p.add_argument('--procs', type=int, default=14)
    p.add_argument('--room-only', type=int, default=30000); p.add_argument('--musan', help="MUSAN's folder (music/, noise/): more rooms")
    p.add_argument('--only-room', action='store_true', help='just more of the room alone, as room-train.npy')
    p.add_argument('--speech'); p.add_argument('--crops', type=int, default=150000); p.add_argument('--only-speech', action='store_true')
    a = p.parse_args(); os.makedirs(a.out, exist_ok=True)
    if a.speech:
        a.bank = os.path.join(a.out, 'speech-bank.npy'); speech_bank(a.speech, a.bank)
    data = {(k, s): load_npz(os.path.join(a.synth, f'{k}-{s}.npz')) for k in ('pos', 'neg') for s in ('train', 'val')}
    for k in ('pos', 'neg'):  # synth_more.py's voices (other engines), for training: twice over
        f = os.path.join(a.synth, f'{k}-more.npz')
        if os.path.exists(f): data[(k, 'train')] += load_npz(f) * 2
    babble = [x for x, _, t in data[('neg', 'train')] if len(t) > 20][:3000]
    for split in ([] if a.only_speech or a.only_room else ['train', 'val']) + (['speech'] if a.speech else []) + (['room'] if a.only_room else []):
        if split == 'room':
            jobs = [('room', [(None, 0, '')] * 64, 5_000_003 + i) for i in range(0, a.room_only, 64)]
            with Pool(a.procs, init, (a, babble)) as pool: acc = [e for _, e in pool.imap_unordered(run, jobs)]
            np.save(os.path.join(a.out, 'room-train.npy'), np.concatenate(acc)); print('room', sum(len(x) for x in acc)); continue
        if split == 'speech':
            jobs = [('speech', [(None, 0, '')] * 64, 3_000_003 + i) for i in range(0, a.crops, 64)]
            acc = []
            with Pool(a.procs, init, (a, babble)) as pool:
                for k, (_, e) in enumerate(pool.imap_unordered(run, jobs)):
                    acc.append(e)
                    if k % 200 == 0: print(f'speech {k}/{len(jobs)}', file=sys.stderr, flush=True)
            np.save(os.path.join(a.out, 'speech-train.npy'), np.concatenate(acc)); print('speech', sum(len(x) for x in acc)); continue
        jobs, seed = [], 1 if split == 'train' else 2
        for kind in ('pos', 'neg'):
            c = data[(kind, split)]
            for i in range(0, len(c), 64): jobs.append((kind, c[i:i + 64], seed * 1_000_003 + len(jobs)))
        nroom = a.room_only if split == 'train' else a.room_only // 10
        for i in range(0, nroom, 64): jobs.append(('room', [(None, 0, '')] * 64, seed * 1_000_003 + len(jobs)))
        acc = {'pos': [], 'neg': [], 'room': []}
        with Pool(a.procs, init, (a, babble)) as pool:
            for k, (kind, e) in enumerate(pool.imap_unordered(run, jobs)):
                acc[kind].append(e)
                if k % 100 == 0: print(f'{split} {k}/{len(jobs)}', file=sys.stderr, flush=True)
        np.save(os.path.join(a.out, f'pos-{split}.npy'), np.concatenate(acc['pos']))
        np.save(os.path.join(a.out, f'neg-{split}.npy'), np.concatenate(acc['neg'] + acc['room']))
        print(split, {k: sum(len(x) for x in v) for k, v in acc.items()})

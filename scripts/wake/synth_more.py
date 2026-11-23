"""More training voices from the other engines: half of the macOS voices and half of Kokoro's (the even ones in
testset.py's lists); the test set then counts only the other half (voice-bench.mjs --voices odd), so no test voice is
ever heard in training. Same phrases and near-misses as synth.py.

  python synth_more.py --kokoro <kokoro-multi-lang-v1_0 dir> --parakeet <dir> --out <dir> [--pos 120] [--neg 60]

Writes <out>/{pos,neg}-more.npz, as synth.py's files.
"""
import argparse, os, random, sys, tempfile
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synth import WAKE, AFTER, NEAR, SENTENCES, save
from testset import SAY_VOICES, KOKORO, SPELLINGS, NAME_HEARD, Kokoro, Asr, say_mac, trim

def train_voices():
    return [('say', v) for i, v in enumerate(SAY_VOICES) if i % 2 == 0] + [('kokoro', s) for i, s in enumerate(KOKORO) if i % 2 == 0]

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    for k in ('kokoro', 'parakeet', 'out'): p.add_argument('--' + k, required=True)
    p.add_argument('--pos', type=int, default=120); p.add_argument('--neg', type=int, default=60)
    a = p.parse_args(); rng = random.Random(11)
    kok, asr = Kokoro(a.kokoro, tempfile.mkdtemp()), Asr(a.parakeet)
    pos, neg = [], []
    for kind, v in train_voices():
        synth = lambda t: trim(say_mac(t, v) if kind == 'say' else kok(t, v))
        names = [s for s in SPELLINGS if NAME_HEARD.match(asr(synth(s + '.')))]
        if not names: print('no spelling for', kind, v, flush=True); continue
        for i in range(a.pos):
            t = rng.choice(WAKE).format(n=rng.choice(names)); x = synth(t); end = len(x)
            if i % 4 == 3: x = np.concatenate([x, np.zeros(int(rng.uniform(0, 0.15) * 16000), np.float32), synth(rng.choice(AFTER))])
            pos.append((t, x, end))
        for i in range(a.neg):
            t = rng.choice(NEAR) if i % 3 else rng.choice(SENTENCES); x = synth(t); neg.append((t, x, len(x)))
        print(kind, v, names, len(pos), flush=True)
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, 'train-voices.txt'), 'w') as f:  # for voice-bench.mjs --skip-voices: these are heard in training
        for kind, v in train_voices(): f.write(f'{kind}-{v}'.replace(' ', '').replace('(', '').replace(')', '').lower() + '\n')
    save(os.path.join(a.out, 'pos-more.npz'), pos); save(os.path.join(a.out, 'neg-more.npz'), neg)
    print('pos', len(pos), 'neg', len(neg))

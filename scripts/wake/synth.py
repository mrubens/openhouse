"""Synthetic speech for the wake-word model (docs/wake-word.md): "Opie" / "Hey Opie" and near-misses, from Piper's
multi-speaker voices (LibriTTS-R, 904 speakers; VCTK, 109). Speakers are split by number: most for training, the rest
for validation. The test set uses other engines entirely (scripts/wake/testset.py).

  python synth.py --piper <dir with en_US-libritts_r-medium.onnx, en_GB-vctk-medium.onnx> --espeak <espeak-ng-data> --out <dir>

espeak-ng (Piper's phonemizer) can't open data under a long path (its limit is ~160 characters): link it somewhere short.
It also reads "Opie" as "oh-pie", so the name is spelled the way it's said ("Opee", "Ohpee", "Opey": /ˈoʊpi/).
Writes <out>/{pos,neg}-{train,val}.npz: int16 clips at 16 kHz, concatenated, with offsets, texts and where the
name ends in each (a request can follow it).
"""
import argparse, os, random, sys
from multiprocessing import Pool
import numpy as np
from scipy.signal import resample_poly

NAMES = ['Opee', 'Ohpee', 'Opey', 'Opi']
WAKE = ['{n}', '{n}.', '{n}?', '{n}!', 'Hey {n}', 'Hey, {n}.', 'Hey {n}!', 'Hey {n}?', 'Hi {n}', 'Okay {n}', 'Oh, hey {n}']
# What comes right after the name when someone asks at once: the window that ends just after "Opie" holds its start.
AFTER = ["what's the weather", 'set a timer', 'add milk', 'turn it down', 'what time is it', 'play some music',
         'are you there', 'help me', 'how long', 'can you', 'remind me', 'stop', 'when is', 'tell me a joke']
# Near-misses: sounds like the name, or the name's sounds inside ordinary speech. ("Hope he…" stays out of the bare
# words: it's the same sounds; the speech model's check after a wake is what tells it apart.)
NEAR = ['Okay.', 'Okay, please.', 'Oh, please.', 'Copy.', 'Copy that.', 'Obi.', 'Hey Obi.', 'Obie!', 'Hoping.', 'Hoping so.',
        'Open.', 'Open it.', 'Opal.', 'Hey Opal.', 'Oprah.', 'Toby.', 'Hey Toby.', 'Soapy.', 'Dopey.', 'Poppy.', 'Hey Poppy.',
        'Hoppy.', 'Hippie.', 'Happy.', 'Okie.', 'Oakley.', 'Hey Oakley.', 'Ollie.', 'Hey Ollie.', 'Odie.', 'Hey Odie.',
        'Joey.', 'Hey Joey.', 'Sophie.', 'Hey Sophie.', 'Zoe.', 'Hey Zoe.', 'Chloe.', 'Hey Chloe.', 'Bobby.', 'Hey Bobby.',
        'Opium.', 'Oboe.', 'Ozzy.', 'Hey Ozzy.', 'Hey Opa.', 'Oh boy.', 'Oh, be quiet.', 'Oh, P.E.', 'O.P.', 'Hey, OP.',
        'Hey, okay.', 'Hey, open up.', 'Oh pizza!', 'Hey Opus.', 'Hey Otis.', 'Hey Toby, come here.', 'Hey, hold it.',
        'Hey hey hey!', 'Hey.', 'Hey you.', 'Hey there.', 'Oh.', 'Oh no.', 'Oh, okay.', 'Okay, bye.', 'Hey, honey.']
SENTENCES = [
    'Okay, please pass the peas.', 'Open the door for me, please.', 'Hopefully it stops raining soon.', 'I hope he gets here soon.',
    "Copy that, I'll be right there.", 'Hey Opal, time for dinner.', 'Hey Toby, your shoes are by the door.', 'Hey Obi, sit down!',
    'The OP said it was fine.', 'Okay, people, listen up.', 'Soapy water is in the sink.', 'Dopey is my favorite dwarf.',
    'Opening night is on Friday.', 'Hey, open the window, please.', 'Okay, peas or carrots?', 'Hi Poppy, how was your day?',
    'I was hoping we could go to the park.', 'Can you make a copy of this for me?', 'The oboe sounds lovely.', 'Oh, pick that up.',
    'Hey, how was the open house?', 'We should open a pizza place.', 'Oh, peanuts!', 'Oh, perfect, thank you.', 'Hold the hoe, please.',
    'Did you see the opossum in the yard?', 'Oh, Pete called earlier.', 'Hey, hope you had a nice day.',
    'Turn the TV down a bit.', 'What do you want for dinner tonight?', 'Did anyone feed the dog?', 'Remember your lunch box.',
    'Can you pick up milk on the way home?', 'The game starts at seven.', "I'll be home around six.", 'Who left the fridge open?',
]

def jobs(n_train_lib=800, n_train_vctk=90):
    out = []
    for model, n, split in (('en_US-libritts_r-medium', 904, n_train_lib), ('en_GB-vctk-medium', 109, n_train_vctk)):
        for s in range(n): out.append((model, s, 'train' if s < split else 'val'))
    return out

_voices = {}
def voice(piper_dir, espeak, model):
    if model not in _voices:
        from piper import PiperVoice
        _voices[model] = PiperVoice.load(os.path.join(piper_dir, model + '.onnx'), espeak_data_dir=espeak)
    return _voices[model]

def say(v, text, speaker, rng):
    from piper import SynthesisConfig
    cfg = SynthesisConfig(speaker_id=speaker, length_scale=rng.uniform(0.75, 1.35), noise_scale=rng.uniform(0.35, 0.9), noise_w_scale=rng.uniform(0.5, 1.1))
    a = np.concatenate([c.audio_int16_array for c in v.synthesize(text, cfg)]).astype(np.float32) / 32768
    a = resample_poly(a, 160, 220)  # 22050 -> 16000
    nz = np.nonzero(np.abs(a) > 0.01)[0]  # trim Piper's silence, keeping 30 ms
    if len(nz): a = a[max(0, nz[0] - 480): nz[-1] + 480]
    return a

def work(args):
    piper_dir, espeak, (model, spk, split), n_pos, n_neg, seed = args
    rng = random.Random(seed * 100003 + spk * 7 + (model[:5] == 'en_GB'))
    v = voice(piper_dir, espeak, model)
    pos, neg = [], []
    for i in range(n_pos):
        name = rng.choice(NAMES); t = rng.choice(WAKE).format(n=name)
        a = say(v, t, spk, rng); end = len(a)
        if i % 4 == 3:  # followed at once by a request
            gap = np.zeros(int(rng.uniform(0, 0.15) * 16000), np.float32)
            nxt = rng.choice(AFTER); a = np.concatenate([a, gap, say(v, nxt, spk, rng)]); t += ' ' + nxt
        pos.append((t, a, end))
    for i in range(n_neg):
        t = rng.choice(NEAR) if i % 3 else rng.choice(SENTENCES)
        a = say(v, t, spk, rng); neg.append((t, a, len(a)))
    return split, pos, neg

def save(path, items):
    lens = np.array([len(a) for _, a, _ in items], np.int64)
    np.savez(path, audio=np.concatenate([np.clip(a * 32767, -32768, 32767).astype(np.int16) for _, a, _ in items]),
             offsets=np.concatenate([[0], np.cumsum(lens)]), ends=np.array([e for _, _, e in items], np.int64), texts=np.array([t for t, _, _ in items]))

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--piper', required=True); p.add_argument('--espeak', required=True); p.add_argument('--out', required=True)
    p.add_argument('--pos', type=int, default=24); p.add_argument('--neg', type=int, default=16); p.add_argument('--procs', type=int, default=12)
    p.add_argument('--seed', type=int, default=1)
    a = p.parse_args(); os.makedirs(a.out, exist_ok=True)
    js = [(a.piper, a.espeak, j, a.pos, a.neg, a.seed) for j in jobs()]
    acc = {('pos', 'train'): [], ('pos', 'val'): [], ('neg', 'train'): [], ('neg', 'val'): []}
    with Pool(a.procs) as pool:
        for k, (split, pos, neg) in enumerate(pool.imap_unordered(work, js, chunksize=4)):
            acc[('pos', split)] += pos; acc[('neg', split)] += neg
            if k % 50 == 0: print(f'{k}/{len(js)} speakers', file=sys.stderr, flush=True)
    for (kind, split), items in acc.items():
        save(os.path.join(a.out, f'{kind}-{split}.npz'), items); print(kind, split, len(items), f'{sum(len(x) for _, x, _ in items) / 16000 / 3600:.2f} h')

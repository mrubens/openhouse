"""A "Hey Jarvis" set in the wake test set's rooms (docs/wake-eval.md): every engine has a model for "Hey Jarvis" made
by its own authors, so on it the engines can be compared apart from how each "Hey Opie" model was trained.

  python -I jarvis_set.py --testset <wake test set dir> --out <dir>

macOS voices (`say`, as testset.py), adults and the same voices sped up like children, three phrases, the test set's
four rooms (testset.room_scene) with its own recordings as the noise, music and talk behind; the test set's 12 hours
of other sound are the negatives, as for "Hey Opie" (a jarvis model hears the same sounds).
"""
import argparse, json, os, random, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from testset import SAY_VOICES, CONDS, say_mac, trim, room_scene, i16
from features import speed, RATE

class Streams:
    """testset's Room, with backgrounds cut from the test set's own noise, music and speech recordings."""
    def __init__(self, d):
        rd = lambda f: np.fromfile(os.path.join(d, f), np.int16).astype(np.float32) / 32768
        self.src = {'noise': rd('noise.pcm'), 'music': rd('music.pcm'), 'babble': rd('speech.pcm')}
    def background(self, n, rng, kinds):
        a = self.src[rng.choice(kinds)]; i = rng.randrange(len(a) - n); return a[i:i + n].copy()

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--testset', required=True); ap.add_argument('--out', required=True)
    a = ap.parse_args(); os.makedirs(os.path.join(a.out, 'pos'), exist_ok=True)
    rng, room = random.Random(7), Streams(a.testset)
    tm = json.load(open(os.path.join(a.testset, 'manifest.json')))
    man = {'positives': [], 'near': [], 'streams': [dict(s, file=os.path.join(os.path.abspath(a.testset), s['file'])) for s in tm['streams']]}
    for v in SAY_VOICES:
        label = 'say-' + v.split(' ')[0].lower() + ('-uk' if 'UK' in v else '')
        for kid in (False, True):
            for text in ('Hey Jarvis.', "Hey Jarvis, what's the weather tomorrow?", 'Hey Jarvis, add milk to the shopping list.'):
                s = trim(say_mac(text, v))
                if kid: s = speed(s, rng.uniform(1.2, 1.3))
                for cond in CONDS:
                    x, at = room_scene(s, cond, room, rng)
                    fn = f'pos/{label}{"-kid" if kid else ""}-{len(man["positives"])}.pcm'; i16(x).tofile(os.path.join(a.out, fn))
                    man['positives'].append({'file': fn, 'text': text, 'voice': label + ('-kid' if kid else ''), 'cond': cond})
        print(label, len(man['positives']), flush=True)
    json.dump(man, open(os.path.join(a.out, 'manifest.json'), 'w'), indent=1)

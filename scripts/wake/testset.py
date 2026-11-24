"""The wake-word test set (docs/wake-word.md), for scripts/voice-bench.mjs --only wakeset --set <out>.

  python testset.py --out <dir> --parakeet <sherpa-onnx-nemo-parakeet-* dir> --kokoro <kokoro-multi-lang-v1_0 dir>
                    --noise <DEMAND dir> --music <GTZAN genres dir> --librispeech <LibriSpeech/test-clean>
                    --ami <AMI sdm test-*.parquet, comma-separated> [--recorded <dir of wav: the user's own "Opie">]

Voices the wake model never trained on: macOS voices (`say`) and Kokoro's 28 English voices, adults and the same
voices pitched up like children. The name's spelling is picked per voice: each says "Opie." alone in each spelling,
and the first that the speech model reads as the name is used (a TTS reads "Opie" as "oh-pie" now and then).
Rooms: near and quiet, near with kitchen noise, across the room (reverb, the tablet's quiet microphone, noise), and
with a TV or music on. The noise and music are recordings training never used (features.Room's 'test' part).

Negatives: near-miss sentences (the same voices and rooms), and hours of other sound: read speech (LibriSpeech),
meetings heard from a table microphone (AMI), music (GTZAN), and household noise (DEMAND).

Writes <out>/manifest.json and int16 16 kHz audio files.
"""
import argparse, glob, io, json, os, random, re, subprocess, sys, tempfile
import numpy as np
import soundfile as sf
from scipy.signal import fftconvolve, resample_poly
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from features import Room, rir, speed, db, RATE

SAY_VOICES = ['Samantha', 'Daniel', 'Karen', 'Moira', 'Tessa', 'Rishi', 'Fred', 'Ralph', 'Kathy', 'Junior', 'Albert',
              'Eddy (English (US))', 'Flo (English (US))', 'Reed (English (US))', 'Rocko (English (US))', 'Sandy (English (US))',
              'Shelley (English (US))', 'Grandma (English (US))', 'Grandpa (English (US))', 'Eddy (English (UK))',
              'Flo (English (UK))', 'Reed (English (UK))', 'Sandy (English (UK))', 'Shelley (English (UK))']
KOKORO = list(range(28))  # af_*, am_*, bf_*, bm_* in kokoro-multi-lang-v1_0
SPELLINGS = ['Opie', 'Opee', 'Ohpee', 'Oh-pee', 'Opi']
NAME_HEARD = re.compile(r"^\W*(opies?|opi|opee|oppy|ohpee|oh pee|o\.? ?p\.?|op)\W*$", re.I)
PHRASES = ['{n}.', 'Hey {n}.', "Hey {n}, what's the weather tomorrow?", '{n}, set a timer for ten minutes.',
           'Hey {n}, add milk to the shopping list.', 'Hi {n}, what time is it?']
NEAR = ['Okay, please pass the peas.', 'Oh, please, not again.', 'Open the door for me, please.', 'Hopefully it stops raining soon.',
        'Hoppy the bunny needs more hay.', "Copy that, I'll be right there.", 'Hey Opal, time for dinner.', 'Hey Toby, your shoes are by the door.',
        'Hey Obi, sit down!', 'Hey Sophie, did you finish your homework?', 'The OP said it was fine.', 'Okay, people, listen up.',
        'Soapy water is in the sink.', 'Dopey is my favorite dwarf.', 'Oh, be quiet for a second.', 'Oh, P.E. is on Tuesday.',
        'Hey Joey, can you pass the salt?', 'Opening night is on Friday.', 'Hey, open the window, please.', 'Okay, peas or carrots?',
        'Hi Poppy, how was your day?', 'Hello Bobby, come sit down.', 'Oh boy, look at the time.', 'I hope he gets here soon.',
        'I was hoping you would call.', 'Can you make a copy for me?', 'Okay.', 'Open it.', 'Oh, please.', 'Copy.', 'Obi.', 'Hoping.',
        'Hey, has anyone seen my shoes?', 'Okay everyone, dinner is ready!', 'Hey hey hey, stop running in the house!']
CONDS = ['near', 'noisy', 'far', 'tv']

def say_mac(text, voice):
    with tempfile.TemporaryDirectory() as d:
        f = os.path.join(d, 'x.aiff')
        for i in range(4):
            try: subprocess.run(['say', '-v', voice, '-o', f, text], check=True, timeout=20); break
            except Exception:
                if i == 3: raise
        out = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', f, '-ac', '1', '-ar', str(RATE), '-f', 'f32le', '-'], check=True, capture_output=True).stdout
    return np.frombuffer(out, np.float32).copy()

class Kokoro:
    """Kokoro reads English from its lexicon only (a word that isn't there is skipped), so the name is added to it, said
    as "Dopey" without the D: US voices (0-19) with the American lexicon, British ones (20-27) with the British."""
    def __init__(self, d, tmp):
        import sherpa_onnx
        self.tts = {}
        for acc, vowel in (('us', 'O'), ('gb', 'Q')):
            lex = os.path.join(tmp, f'lexicon-{acc}-en.txt')
            with open(lex, 'w') as f: f.write(open(f'{d}/lexicon-{acc}-en.txt').read().rstrip('\n') + f'\nopie ˈ {vowel} p i\n')
            cfg = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=f'{d}/model.onnx', voices=f'{d}/voices.bin', tokens=f'{d}/tokens.txt', data_dir=f'{d}/espeak-ng-data',
                lexicon=lex, dict_dir=f'{d}/dict'), num_threads=4))
            self.tts[acc] = sherpa_onnx.OfflineTts(cfg)
    def __call__(self, text, sid, speed=1.0):
        a = self.tts['gb' if sid >= 20 else 'us'].generate(text, sid=sid, speed=speed)
        return resample_poly(np.asarray(a.samples, np.float32), RATE, a.sample_rate).astype(np.float32)

def trim(a):
    nz = np.nonzero(np.abs(a) > 0.01 * (np.abs(a).max() or 1))[0]
    return a[max(0, nz[0] - 480): nz[-1] + 480] if len(nz) else a

class Asr:
    def __init__(self, d):
        import sherpa_onnx
        self.r = sherpa_onnx.OfflineRecognizer.from_transducer(encoder=f'{d}/encoder.int8.onnx', decoder=f'{d}/decoder.int8.onnx',
            joiner=f'{d}/joiner.int8.onnx', tokens=f'{d}/tokens.txt', model_type='nemo_transducer', num_threads=4)
    def __call__(self, a):
        s = self.r.create_stream(); s.accept_waveform(RATE, np.concatenate([np.zeros(8000, np.float32), a, np.zeros(8000, np.float32)]))
        self.r.decode_stream(s); return s.result.text

def room_scene(speech, cond, room, rng, lead=1.0, tail=2.5):
    """A scenario as the tablet would hear it. Returns audio and where the speech starts."""
    s = speech
    if cond == 'far': s = fftconvolve(s, rir(rng, rng.uniform(0.4, 0.8), rng.uniform(-4, 2)))[:len(s) + int(0.3 * RATE)].astype(np.float32)
    elif cond != 'near' and rng.random() < 0.7: s = fftconvolve(s, rir(rng, rng.uniform(0.15, 0.4), rng.uniform(6, 14)))[:len(s) + int(0.2 * RATE)].astype(np.float32)
    n = int((lead + tail) * RATE) + len(s); out = np.zeros(n, np.float32); at = int(lead * RATE); out[at:at + len(s)] = s
    level = rng.uniform(-46, -40) if cond == 'far' else rng.uniform(-30, -22)
    out *= 10 ** ((level - db(s)) / 20)
    if cond == 'noisy': bg = room.background(n, rng, kinds=('noise',)); snr = rng.uniform(5, 15)
    elif cond == 'far': bg = room.background(n, rng, kinds=('noise',)); snr = rng.uniform(10, 20)
    elif cond == 'tv': bg = room.background(n, rng, kinds=('music', 'babble')); snr = rng.uniform(5, 12)
    else: bg = None
    if bg is not None and np.any(bg): out += bg * 10 ** ((level - snr - db(bg)) / 20)
    out += np.random.default_rng(rng.randrange(1 << 30)).standard_normal(n).astype(np.float32) * 10 ** (-70 / 20)
    return np.clip(out, -1, 1), at

def i16(a): return np.clip(np.round(a * 32767), -32768, 32767).astype(np.int16)

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    for k in ('out', 'parakeet', 'kokoro', 'noise', 'music', 'librispeech', 'ami'): p.add_argument('--' + k, required=True)
    p.add_argument('--recorded'); p.add_argument('--seed', type=int, default=7)
    p.add_argument('--only-recorded', action='store_true', help="a set of the recorded takes alone (the rest isn't made)")
    p.add_argument('--hours-speech', type=float, default=5.0); p.add_argument('--hours-meeting', type=float, default=4.0)
    p.add_argument('--hours-music', type=float, default=2.0); p.add_argument('--hours-noise', type=float, default=1.0)
    a = p.parse_args(); os.makedirs(os.path.join(a.out, 'pos'), exist_ok=True); os.makedirs(os.path.join(a.out, 'near'), exist_ok=True)
    rng = random.Random(a.seed)
    asr, kok = Asr(a.parakeet), Kokoro(a.kokoro, tempfile.mkdtemp())
    ls_files = sorted(glob.glob(os.path.join(a.librispeech, '**', '*.flac'), recursive=True))
    room = Room(a.noise, a.music, 'test', babble=[sf.read(f, dtype='float32')[0] for f in ls_files[-300:]])
    voices = [] if a.only_recorded else [('say', v) for v in SAY_VOICES] + [('kokoro', s) for s in KOKORO]
    synth = lambda kind, v, t: trim(say_mac(t, v) if kind == 'say' else kok(t, v))
    man = {'positives': [], 'near': [], 'streams': [], 'voices': {}, 'dropped': []}
    for kind, v in voices:
        label = f'{kind}-{v}'.replace(' ', '').replace('(', '').replace(')', '').lower()
        spelling = next((s for s in SPELLINGS if NAME_HEARD.match(asr(synth(kind, v, s + '.')))), None)
        if not spelling: man['dropped'].append(label); print('no spelling works for', label, flush=True); continue
        man['voices'][label] = spelling
        for kid in (False, True):
            if kid and rng.random() < 0.5: continue  # children: half the voices
            vl = label + ('-kid' if kid else '')
            for ph in PHRASES:
                text = ph.format(n=spelling)
                s = synth(kind, v, text)
                name_end = None
                if ',' in text or text.endswith('.'):  # where the name ends: say the part up to it alone, as long as the voice does
                    head = text.split(',')[0].rstrip('.') + ('.' if ',' not in text else ',')
                    name_end = len(synth(kind, v, head)) - 480
                if kid: f = rng.uniform(1.2, 1.3); s = speed(s, f); name_end = int(name_end / f)
                for cond in CONDS:
                    x, at = room_scene(s, cond, room, rng)
                    fn = f'pos/{vl}-{len(man["positives"])}.pcm'; i16(x).tofile(os.path.join(a.out, fn))
                    man['positives'].append({'file': fn, 'text': text.replace(spelling, 'Opie'), 'voice': vl, 'cond': cond,
                                             'speechAt': at, 'nameEnd': at + min(name_end, len(s)), 'samples': len(x)})
            for t in rng.sample(NEAR, 8):
                s = synth(kind, v, t)
                if kid: s = speed(s, rng.uniform(1.2, 1.3))
                cond = rng.choice(['near', 'far', 'noisy'])
                x, at = room_scene(s, cond, room, rng, tail=1.5)
                fn = f'near/{vl}-{len(man["near"])}.pcm'; i16(x).tofile(os.path.join(a.out, fn))
                man['near'].append({'file': fn, 'text': t, 'voice': vl, 'cond': cond, 'samples': len(x)})
        print(label, spelling, len(man['positives']), flush=True)
    if a.recorded:  # the user's own takes (wav, any rate), each one wake phrase: as recorded, and across a simulated room
        for f in sorted(glob.glob(os.path.join(a.recorded, '*.wav'))):
            s, sr = sf.read(f, dtype='float32'); s = s.mean(1) if s.ndim > 1 else s
            if sr != RATE: s = resample_poly(s, RATE, sr).astype(np.float32)
            s = trim(s)
            for cond in CONDS:
                x, at = room_scene(s, cond, room, rng)
                fn = f'pos/rec-{len(man["positives"])}.pcm'; i16(x).tofile(os.path.join(a.out, fn))
                man['positives'].append({'file': fn, 'text': os.path.basename(f), 'voice': 'recorded', 'cond': cond, 'speechAt': at, 'nameEnd': None, 'samples': len(x)})

    def stream(name, kind, pieces, hours, gap=(0.3, 1.5), level=(-34, -20)):
        out, got = [], 0
        for piece in pieces:
            if got >= hours * 3600 * RATE: break
            x = piece * 10 ** ((rng.uniform(*level) - db(piece)) / 20) if np.any(piece) else piece
            out += [x, np.zeros(int(rng.uniform(*gap) * RATE), np.float32)]; got += len(x) + len(out[-1])
        x = np.concatenate(out); x += np.random.default_rng(1).standard_normal(len(x)).astype(np.float32) * 10 ** (-70 / 20)
        fn = f'{name}.pcm'; i16(x).tofile(os.path.join(a.out, fn))
        man['streams'].append({'file': fn, 'kind': kind, 'hours': len(x) / RATE / 3600}); print(name, f'{len(x) / RATE / 3600:.2f} h', flush=True)

    def ls_pieces():
        for f in ls_files[:-300]:
            yield sf.read(f, dtype='float32')[0]
    if a.only_recorded: json.dump(man, open(os.path.join(a.out, 'manifest.json'), 'w'), indent=1); sys.exit(0)
    stream('speech', 'read speech (LibriSpeech test-clean)', ls_pieces(), a.hours_speech)
    def ami_pieces():
        import pyarrow.parquet as pq
        for path in a.ami.split(','):
            t = pq.read_table(path, columns=['audio', 'meeting_id', 'begin_time']).to_pylist()
            t.sort(key=lambda r: (r['meeting_id'], r['begin_time']))
            for r in t:
                x, sr = sf.read(io.BytesIO(r['audio']['bytes']), dtype='float32')
                yield x if sr == RATE else resample_poly(x, RATE, sr).astype(np.float32)
    stream('meeting', 'meetings, table microphone (AMI SDM)', ami_pieces(), a.hours_meeting, gap=(0.05, 0.6), level=(-40, -26))
    stream('music', 'music (GTZAN, 10 genres)', (room._read(f) for f in rng.sample(room.music, len(room.music))), a.hours_music, gap=(0, 0.2))
    stream('noise', 'household noise (DEMAND kitchen, living room, washing, cafeteria)', (room._read(f) for f in room.noise), a.hours_noise, gap=(0, 0.1), level=(-45, -30))
    json.dump(man, open(os.path.join(a.out, 'manifest.json'), 'w'), indent=1)
    print({k: len(v) for k, v in man.items()})

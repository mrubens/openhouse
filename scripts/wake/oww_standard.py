"""A "Hey Opie" model made openWakeWord's standard way (its train.py and examples/custom_model.yml), as a baseline
for ours (docs/wake-eval.md). Evaluation only: its negatives (ACAV100M features) are non-commercial.

  python -I oww_standard.py --oww-src <openWakeWord checkout> --generator <dir with generate_samples.py>
      --rirs <MIT RIR wavs> --backgrounds <dir>,<dir> --acav <ACAV100M .npy> --val <validation_set_features.npy>
      --out <dir> [--n 20000] [--steps 50000] [--stage generate,augment,train]

Piper's phonemizer reads "Opie" as "oh-pie", so the clips are made from "hey opee", as openWakeWord's notes suggest
for names it misreads; the near-miss phrases come from "hey opie", whose CMUdict entry (OW1 P IY2) is right.
"""
import argparse, os, runpy, sys
import yaml

ap = argparse.ArgumentParser()
for k in ('oww-src', 'generator', 'rirs', 'backgrounds', 'acav', 'val', 'out'): ap.add_argument('--' + k, required=True)
ap.add_argument('--n', type=int, default=20000); ap.add_argument('--n-val', type=int, default=2000)
ap.add_argument('--steps', type=int, default=50000); ap.add_argument('--stage', default='generate,augment,train')
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
cfg = {  # examples/custom_model.yml, with our phrase and paths
    'model_name': 'hey_opie', 'target_phrase': ['hey opee'], 'custom_negative_phrases': [],
    'n_samples': a.n, 'n_samples_val': a.n_val, 'tts_batch_size': 50, 'augmentation_batch_size': 16,
    'piper_sample_generator_path': a.generator, 'output_dir': a.out, 'rir_paths': [a.rirs],
    'background_paths': a.backgrounds.split(','), 'background_paths_duplication_rate': [1] * len(a.backgrounds.split(',')),
    'false_positive_validation_data_path': a.val, 'augmentation_rounds': 1,
    'feature_data_files': {'ACAV100M_sample': a.acav},
    'batch_n_per_class': {'ACAV100M_sample': 1024, 'adversarial_negative': 50, 'positive': 50},
    'model_type': 'dnn', 'layer_size': 32, 'steps': a.steps, 'max_negative_weight': 1500,
    'target_false_positives_per_hour': 0.2,
}
path = os.path.join(a.out, 'hey_opie.yml'); yaml.safe_dump(cfg, open(path, 'w'))

import torch.utils.data as tud
class _Loader(tud.DataLoader):  # train.py's loader workers can't start on macOS (spawned, they can't take its lambdas;
    def __init__(self, *args, **kw):  # forked, they hang on its second pass), so its batches load in the main process
        kw['num_workers'] = 0; kw.pop('prefetch_factor', None); super().__init__(*args, **kw)
tud.DataLoader = _Loader
import openwakeword.data as owd
_adv = owd.generate_adversarial_texts
owd.generate_adversarial_texts = lambda input_text, **kw: _adv(input_text=input_text.replace('opee', 'opie'), **kw)
flags = {'generate': '--generate_clips', 'augment': '--augment_clips', 'train': '--train_model'}
sys.argv = ['train.py', '--training_config', path] + [flags[s] for s in a.stage.split(',')]
runpy.run_path(os.path.join(a.oww_src, 'openwakeword', 'train.py'), run_name='__main__')

"""A "Hey Opie" microWakeWord model made the way its basic_training_notebook.ipynb makes one, as a candidate against
ours (docs/wake-eval.md). Evaluation only: its negative features (kahrendt/microwakeword) are CC-BY-NC 4.0.

  python -I mww_standard.py --clips <dir of "hey opee" wavs from piper-sample-generator> --rirs <MIT RIR wavs>
      --backgrounds <dir>,<dir> --negatives <dir with speech/, dinner_party/, no_speech/, dinner_party_eval/>
      --out <dir> [--steps 10000] [--stage features,train]

Then a model JSON beside the .tflite (written here) runs in compare.py as mww:<out>/hey_opie.json.
"""
import argparse, json, os, shutil, subprocess, sys
import yaml

ap = argparse.ArgumentParser()
for k in ('clips', 'rirs', 'backgrounds', 'negatives', 'out'): ap.add_argument('--' + k, required=True)
ap.add_argument('--steps', type=int, default=10000); ap.add_argument('--stage', default='features,train')
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
feat = os.path.join(a.out, 'generated_augmented_features')

if 'features' in a.stage:
    from microwakeword.audio.augmentation import Augmentation
    from microwakeword.audio.clips import Clips
    from microwakeword.audio.spectrograms import SpectrogramGeneration
    from mmap_ninja.ragged import RaggedMmap
    clips = Clips(input_directory=a.clips, file_pattern='*.wav', max_clip_duration_s=None, remove_silence=False,
                  random_split_seed=10, split_count=0.1)
    aug = Augmentation(augmentation_duration_s=3.2, augmentation_probabilities={
        'SevenBandParametricEQ': 0.1, 'TanhDistortion': 0.1, 'PitchShift': 0.1, 'BandStopFilter': 0.1,
        'AddColorNoise': 0.1, 'AddBackgroundNoise': 0.75, 'Gain': 1.0, 'RIR': 0.5},
        impulse_paths=[a.rirs], background_paths=a.backgrounds.split(','), background_min_snr_db=-5,
        background_max_snr_db=10, min_jitter_s=0.195, max_jitter_s=0.205)
    for split, name, rep, slide in (('training', 'train', 2, 10), ('validation', 'validation', 1, 10), ('testing', 'test', 1, 1)):
        d = os.path.join(feat, split, 'wakeword_mmap')
        if os.path.exists(d): continue
        os.makedirs(os.path.dirname(d), exist_ok=True)
        sg = SpectrogramGeneration(clips=clips, augmenter=aug, slide_frames=slide, step_ms=10)
        RaggedMmap.from_generator(out_dir=d, sample_generator=sg.spectrogram_generator(split=name, repeat=rep), batch_size=100, verbose=True)

if 'train' in a.stage:
    neg = lambda n, w, trunc='random': {'features_dir': os.path.join(a.negatives, n), 'sampling_weight': w, 'penalty_weight': 1.0,
                                       'truth': False, 'truncation_strategy': trunc, 'type': 'mmap'}
    cfg = {  # the notebook's training_parameters.yaml
        'window_step_ms': 10, 'train_dir': os.path.join(a.out, 'trained'),
        'features': [{'features_dir': feat, 'sampling_weight': 2.0, 'penalty_weight': 1.0, 'truth': True,
                      'truncation_strategy': 'truncate_start', 'type': 'mmap'},
                     neg('speech', 10.0), neg('dinner_party', 10.0), neg('no_speech', 5.0), neg('dinner_party_eval', 0.0, 'split')],
        'training_steps': [a.steps], 'positive_class_weight': [1], 'negative_class_weight': [20], 'learning_rates': [0.001],
        'batch_size': 128, 'time_mask_max_size': [0], 'time_mask_count': [0], 'freq_mask_max_size': [0], 'freq_mask_count': [0],
        'eval_step_interval': 500, 'clip_duration_ms': 1500, 'target_minimization': 0.9, 'minimization_metric': None,
        'maximization_metric': 'average_viable_recall',
    }
    path = os.path.join(a.out, 'training_parameters.yaml'); yaml.safe_dump(cfg, open(path, 'w'))
    subprocess.run([sys.executable, '-I', '-m', 'microwakeword.model_train_eval', f'--training_config={path}', '--train', '1',
        '--restore_checkpoint', '1', '--test_tf_nonstreaming', '0', '--test_tflite_nonstreaming', '0',
        '--test_tflite_nonstreaming_quantized', '0', '--test_tflite_streaming', '0', '--test_tflite_streaming_quantized', '1',
        '--use_weights', 'best_weights', 'mixednet', '--pointwise_filters', '64,64,64,64', '--repeat_in_block', '1, 1, 1, 1',
        '--mixconv_kernel_sizes', '[5], [7,11], [9,15], [23]', '--residual_connection', '0,0,0,0',
        '--first_conv_filters', '32', '--first_conv_kernel_size', '5', '--stride', '3'], check=True, cwd=a.out)
    src = os.path.join(a.out, 'trained', 'tflite_stream_state_internal_quant', 'stream_state_internal_quant.tflite')
    shutil.copy(src, os.path.join(a.out, 'hey_opie.tflite'))
    json.dump({'type': 'micro', 'wake_word': 'Hey Opie', 'model': 'hey_opie.tflite', 'trained_languages': ['en'], 'version': 2,
               'micro': {'probability_cutoff': 0.9, 'feature_step_size': 10, 'sliding_window_size': 5, 'tensor_arena_size': 30000}},
              open(os.path.join(a.out, 'hey_opie.json'), 'w'), indent=1)

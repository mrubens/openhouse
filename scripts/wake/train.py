"""Train the wake model on build.py's features and openWakeWord's general negatives; export opie.onnx.

  python train.py --feats <build.py's out> --val <validation_set_features.npy> --out <dir> [--steps 40000]
                  [--acav <openwakeword_features_ACAV100M_2000_hrs_16bit.npy, or a first part of it>]

The ordinary speech to learn "not the name" from is build.py's speech-train.npy (LibriSpeech, AMI: CC-BY), or with
--acav openWakeWord's 2,000 hours of features instead (CC-BY-NC-SA: non-commercial, so only to compare).

The model: 16 embeddings (1.28 s) -> two small dense layers -> one score. openWakeWord's recipe: many more negatives
than positives, and the negatives weighed more as training goes on, so that false wakes come down. Reports, on held-out
synthetic speakers and on openWakeWord's 11 hours of other sound: missed, and false wakes per hour, by threshold.
"""
import argparse, json, os, sys
import numpy as np
import torch
from torch import nn

class Head(nn.Module):
    def __init__(self, width=128):
        super().__init__()
        self.net = nn.Sequential(nn.Flatten(), nn.LayerNorm(16 * 96), nn.Linear(16 * 96, width), nn.ReLU(),
                                 nn.Linear(width, width), nn.LayerNorm(width), nn.ReLU(), nn.Linear(width, 1))
    def forward(self, x): return torch.sigmoid(self.net(x))[:, 0:1]

class Head2(nn.Module):
    """The bigger wake model: per-frame projection, three 1-D convolutions over the 16 embeddings (residual), a GRU, then
    attention pooling: it can tell where in the 1.28 s the name sits and what came just before. ~0.6 M weights."""
    def __init__(self, width=192):
        super().__init__()
        self.inp = nn.Sequential(nn.LayerNorm(96), nn.Linear(96, width), nn.GELU())
        self.convs = nn.ModuleList([nn.Sequential(nn.Conv1d(width, width, 3, padding=1), nn.GELU(), nn.Dropout(0.1)) for _ in range(3)])
        self.norms = nn.ModuleList([nn.LayerNorm(width) for _ in range(3)])
        self.gru = nn.GRU(width, width, batch_first=True)
        self.att = nn.Linear(width, 1)
        self.out = nn.Sequential(nn.LayerNorm(width), nn.Linear(width, width), nn.GELU(), nn.Linear(width, 1))
    def logits(self, x):
        h = self.inp(x)
        for conv, norm in zip(self.convs, self.norms): h = norm(h + conv(h.transpose(1, 2)).transpose(1, 2))
        h, _ = self.gru(h)
        w = torch.softmax(self.att(h), dim=1)
        return self.out((w * h).sum(1) + h[:, -1])
    def forward(self, x): return torch.sigmoid(self.logits(x))

def load_acav(path, n_max):
    with open(path, 'rb') as f:
        major = f.read(8)[6]; hl = int.from_bytes(f.read(2 if major == 1 else 4), 'little'); off = f.tell() + hl
    n = min(n_max, (os.path.getsize(path) - off) // (16 * 96 * 2))
    return np.memmap(path, np.float16, 'r', off, (n, 16, 96))

def stream_windows(feats):  # a continuous (frames, 96) stream -> every 16-frame window
    from numpy.lib.stride_tricks import sliding_window_view
    return sliding_window_view(feats, (16, 96))[:, 0]

def fires(scores, thr, hop_s=0.08, refractory=2.0):
    n, last = 0, -1e9
    for i in np.nonzero(scores >= thr)[0]:
        t = i * hop_s
        if t - last >= refractory: n += 1; last = t
    return n

@torch.no_grad()
def score(model, x, bs=8192):
    out = []
    for i in range(0, len(x), bs): out.append(model(torch.from_numpy(np.asarray(x[i:i + bs], np.float32))).numpy()[:, 0])
    return np.concatenate(out) if out else np.zeros(0)

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    for k in ('feats', 'val', 'out'): p.add_argument('--' + k, required=True)
    p.add_argument('--acav')
    p.add_argument('--steps', type=int, default=40000); p.add_argument('--width', type=int, default=128)
    p.add_argument('--acav-max', type=int, default=1_200_000); p.add_argument('--seed', type=int, default=0)
    p.add_argument('--max-neg-weight', type=float, default=1500)
    p.add_argument('--loss', default='plain', choices=['plain', 'oww']); p.add_argument('--neg-weight', type=float, default=10)
    p.add_argument('--lr', type=float, default=1e-3); p.add_argument('--threads', type=int, default=4)
    a = p.parse_args(); os.makedirs(a.out, exist_ok=True); torch.manual_seed(a.seed); rng = np.random.default_rng(a.seed); torch.set_num_threads(a.threads)
    pos = np.load(os.path.join(a.feats, 'pos-train.npy')); neg = np.load(os.path.join(a.feats, 'neg-train.npy'))
    speech = np.load(os.path.join(a.feats, 'speech-train.npy'))  # ordinary speech in rooms (build.py --speech)
    if os.path.exists(os.path.join(a.feats, 'room-train.npy')): neg = np.concatenate([neg, np.load(os.path.join(a.feats, 'room-train.npy'))])  # music, noise (build.py --only-room)
    acav = np.asarray(load_acav(a.acav, a.acav_max)) if a.acav else None
    pos_val = np.load(os.path.join(a.feats, 'pos-val.npy')); neg_val = np.load(os.path.join(a.feats, 'neg-val.npy'))
    val = np.load(a.val, mmap_mode='r'); val_w = stream_windows(np.asarray(val, np.float32)); val_hours = len(val) * 0.08 / 3600
    print(f'pos {len(pos)}, near-miss+room {len(neg)}, speech {len(speech)}, general {len(acav) if acav is not None else 0}, val {len(pos_val)}/{len(neg_val)}, stream {val_hours:.1f} h', flush=True)
    model = Head(a.width); opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-2)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.steps, pct_start=0.1)
    bce = nn.BCELoss(reduction='none'); B = 512
    for step in range(a.steps):
        ip = rng.integers(0, len(pos), B // 4); ineg = rng.integers(0, len(neg), B // 4)
        isp = rng.integers(0, len(speech), B // 4 if acav is not None else B // 2); ia = rng.integers(0, len(acav), B // 4) if acav is not None else []
        x = np.concatenate([pos[ip], neg[ineg], speech[isp]] + ([acav[ia]] if acav is not None else [])).astype(np.float32)
        y = np.concatenate([np.ones(len(ip)), np.zeros(len(ineg) + len(isp) + len(ia))]).astype(np.float32)
        xt, yt = torch.from_numpy(x), torch.from_numpy(y)[:, None]
        out = model(xt)
        if a.loss == 'plain':  # weighted cross-entropy: a false wake costs neg-weight times a miss
            w_neg = a.neg_weight
            loss = (bce(out.clamp(1e-6, 1 - 1e-6), yt) * torch.where(yt == 1, torch.ones_like(yt), torch.full_like(yt, w_neg))).mean()
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
        else:
          w_neg = 1 + (a.max_neg_weight - 1) * min(1.0, step / (0.7 * a.steps)) ** 2  # negatives count for more as it goes
          # openWakeWord's trick: only the examples it still gets wrong count (the rest are already settled).
          wrong = ((yt == 1) & (out < 0.9)) | ((yt == 0) & (out > 0.1))
          w = torch.where(yt == 1, torch.ones_like(yt), torch.full_like(yt, w_neg)) * wrong
          loss = (bce(out, yt) * w).sum() / max(1.0, float(wrong.sum()))
          opt.zero_grad(); loss.backward(); opt.step(); sched.step()
        if step % 2000 == 0 or step == a.steps - 1:
            model.eval()
            sp, sn = score(model, pos_val), score(model, neg_val); sv = score(model, val_w)
            rep = {t: (round(float(np.mean(sp < t)), 4), round(float(np.mean(sn >= t)), 4), round(fires(sv, t) / val_hours, 2)) for t in (0.3, 0.5, 0.7, 0.9)}
            print(f'step {step} loss {loss.item():.4f} w_neg {w_neg:.0f}  thr: (missed, near-miss woke, false/h) {rep}', flush=True)
            model.train()
    model.eval()
    torch.save(model.state_dict(), os.path.join(a.out, 'opie.pt'))
    torch.onnx.export(model, torch.zeros(1, 16, 96), os.path.join(a.out, 'opie.onnx'), input_names=['x'], output_names=['p'],
                      dynamic_axes={'x': {0: 'n'}, 'p': {0: 'n'}}, opset_version=13, dynamo=False)
    sp, sn, sv = score(model, pos_val), score(model, neg_val), score(model, val_w)
    curve = [{'thr': t, 'missed': float(np.mean(sp < t)), 'nearWoke': float(np.mean(sn >= t)), 'falsePerHour': fires(sv, t) / val_hours} for t in np.round(np.arange(0.05, 1.0, 0.05), 2).tolist()]
    json.dump({'args': vars(a), 'curve': curve}, open(os.path.join(a.out, 'train-report.json'), 'w'), indent=1)
    for c in curve: print(c)

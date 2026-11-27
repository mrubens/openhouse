"""compare.py's reports as one table (docs/wake-eval.md): "Hey Opie" heard out of 10 in each room, the other name
clips ("Opie.", "Hi Opie") and near-miss sentences that woke it, and false wakes an hour on the 12 h of other sound.

  python -I summary.py <report.json>[@threshold,threshold...] ...   (event engines: no threshold)
  python -I summary.py --at-fph 0.1 <report.json> ...                the threshold that gives that many false wakes an hour
"""
import json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compare import HEY, wakes

CONDS = ('near', 'noisy', 'far', 'tv')

def row(r, t):
    T = 0.5 if r['kind'] == 'event' else t
    hit = lambda p: np.mean([v >= T for v in p['peaks']])  # (the share of offsets it woke at)
    hey = [p for p in r['positives'] if p['text'] in HEY or p['text'].startswith('Hey Jarvis')]
    out = {c: 10 * np.mean([hit(p) for p in hey if p['cond'] == c]) for c in CONDS}
    other = [p for p in r['positives'] if p['text'] not in HEY and not p['text'].startswith('Hey')]
    out['other name'] = np.mean([hit(p) for p in other])
    out['near-miss'] = np.mean([hit(p) for p in r['near']])
    H = sum(s['hours'] for s in r['streams'].values())
    n = sum(wakes(np.array([e for e, _ in s['scores']]), np.array([v for _, v in s['scores']]), 0.5 if r['kind'] == 'event' else t)
            for s in r['streams'].values())
    out['false/h'] = n / H if H else float('nan')
    out['hours'] = H
    return out

def at_fph(r, target):
    for t in np.concatenate([np.arange(0.05, 0.99, 0.005), 1 - np.logspace(-2, -6, 41)]):
        if row(r, t)['false/h'] <= target: return round(float(t), 6)
    return 1.0

if __name__ == '__main__':
    args = sys.argv[1:]; fph = None
    if args[0] == '--at-fph': fph = float(args[1]); args = args[2:]
    print(f'{"engine":58} {"thr":>6} ' + ' '.join(f'{c:>6}' for c in CONDS) + f' {"other":>6} {"near":>6} {"false/h":>8} {"hours":>6}')
    for a in args:
        f, _, ts = a.partition('@'); r = json.load(open(f))
        thr = [None] if r['kind'] == 'event' else ([at_fph(r, fph)] if fph is not None else [float(t) for t in (ts or '0.5').split(',')])
        for t in thr:
            o = row(r, t)
            print(f'{r["engine"][-58:]:58} {("%.5g" % t) if t is not None else "-":>6} ' + ' '.join(f'{o[c]:6.1f}' for c in CONDS)
                  + f' {o["other name"]:6.0%} {o["near-miss"]:6.0%} {o["false/h"]:8.2f} {o["hours"]:6.1f}')

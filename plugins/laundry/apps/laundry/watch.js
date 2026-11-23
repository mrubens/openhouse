// Telling a washer or dryer's cycle from its smart plug's power: running once it draws more than a few watts for a
// couple of minutes, done once it has drawn almost nothing for a few minutes after that. No page or kit here.

/** The power (watts) a device's state reports, whatever the driver or recipe calls it; null if it doesn't. */
export function wattsOf(state) {
  if (!state || typeof state !== 'object') return null;
  for (const k of ['watts', 'power', 'apower', 'current_power', 'currentPower', 'power_w', 'load_power']) {
    const v = Number(state[k]); if (k in state && Number.isFinite(v)) return v;
  }
  return null;
}
/** A plug: anything whose state reports power, or whose kind says it's a plug or outlet. */
export const isPlug = (d) => /plug|outlet|switch/i.test(d.kind || '') || wattsOf(d.state) != null;

/** One reading into the watcher: state {phase: 'idle'|'running'|'done', since, above, below}; returns the new one. */
export function step(s, watts, now = Date.now(), { on = 8, off = 3, start = 2 * 60e3, end = 4 * 60e3 } = {}) {
  s = { phase: 'idle', since: now, above: null, below: null, ...s };
  if (watts == null) return s;
  if (watts > on) { s.above ??= now; s.below = null; } else if (watts < off) { s.below ??= now; s.above = null; }
  if (s.phase !== 'running' && s.above && now - s.above >= start) return { ...s, phase: 'running', since: s.above };
  if (s.phase === 'running' && s.below && now - s.below >= end) return { ...s, phase: 'done', since: now };
  return s;
}

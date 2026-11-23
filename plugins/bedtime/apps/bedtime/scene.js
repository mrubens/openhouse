// What the bedtime scene does to each device, from the actions the device itself offers (kit devices.list): a speaker
// down to a volume (or paused), a TV off, a light dimmed. Only action names the tablet's drivers and recipes use.
export function choicesFor(d) {
  const has = (n) => d.actions?.find((a) => a.name === n);
  const out = [{ value: '', text: 'Leave it' }];
  if (has('set_volume')) out.push({ value: 'quiet', text: 'Turn down' });
  if (has('pause')) out.push({ value: 'pause', text: 'Pause' });
  if (has('power_off')) out.push({ value: 'off', text: 'Turn off' });
  const dim = d.actions?.find((a) => /^(set_)?(brightness|dim|level)$/.test(a.name) || (a.params && ('brightness' in a.params) && a.name.startsWith('set')));
  if (dim) out.push({ value: 'dim', text: 'Dim' });
  if (has('turn_off') && !has('power_off')) out.push({ value: 'off', text: 'Turn off' });
  return out;
}
/** The action and its arguments for a choice: [action, args] or null. */
export function stepFor(d, choice, level) {
  const has = (n) => d.actions?.find((a) => a.name === n);
  if (choice === 'quiet' && has('set_volume')) return ['set_volume', { level }];
  if (choice === 'pause' && has('pause')) return ['pause', {}];
  if (choice === 'off') return has('power_off') ? ['power_off', {}] : has('turn_off') ? ['turn_off', {}] : null;
  if (choice === 'dim') { const a = d.actions.find((x) => /^(set_)?(brightness|dim|level)$/.test(x.name) || (x.params && 'brightness' in x.params)); if (!a) return null; const k = Object.keys(a.params || { level: 0 })[0] || 'level'; return [a.name, { [k]: level }]; }
  return null;
}

/** The scene, a device at a time, through the kit's devices (passed in, so this file has no kit): [{name, ok, text}].
 *  Each change may ask the people here first; a no is just a no. */
export async function runScene(devices, setup) {
  const list = await devices.list(), results = [];
  for (const d of list) {
    const s = setup.steps?.[d.id]; if (!s?.choice) continue;
    const step = stepFor(d, s.choice, s.level ?? 15); if (!step) continue;
    const r = await devices.do(d.id, step[0], step[1]);
    results.push({ name: d.name, ok: !!r?.ok, text: r?.ok ? (r.text || 'Done.') : r?.limited ? 'Too many changes; try again in a minute.' : 'Not this time.' });
  }
  return results;
}

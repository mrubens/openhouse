// A reminder that comes due buzzes the phones of the people on its event (docs/phones.md, "Notifications"): once
// each, never in the household's night hours, and nobody's for an event with nobody on it (the tablet says those).
// The words are the tablet's own ("Dentist in 15 minutes"); the push goes from the tablet itself (screens.notify).
// A chore with a time and Remind me is one of these too, for whose chore it is, until it's done (house/chores.js).

const MIN = 60e3, DAY = 24 * 60 * MIN;
const toMin = (s) => Number(String(s).slice(0, 2)) * 60 + Number(String(s).slice(3, 5));

/** In night hours {from: "21:30", to: "06:30"} (either way round midnight). */
export function inNight(night, t) {
  if (!night?.from || !night?.to) return false;
  const d = new Date(t), m = d.getHours() * 60 + d.getMinutes(), f = toMin(night.from), e = toMin(night.to);
  return f <= e ? m >= f && m < e : m >= f || m < e;
}

/** "Dentist in 15 minutes", "Dentist now", "Dentist at 4:00 PM". */
export function reminderWords(r, t) {
  const m = Math.ceil((Date.parse(r.start) - t) / MIN);
  return `${r.title} ${m <= 0 ? 'now' : m === 1 ? 'in a minute' : m < 60 ? `in ${m} minutes` : 'at ' + new Date(r.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

export function phoneBuzz({ reminders, night = () => null, notify, now = () => Date.now() }) {
  const sent = new Map(); // reminder key -> when it was handled (sent, or passed over at night)
  async function tick() {
    const t = now();
    for (const [k, at] of sent) if (at < t - DAY) sent.delete(k);
    let list = [];
    try { list = reminders(t) || []; } catch (e) { console.error('[phone-buzz]', e.message); return 0; }
    const quiet = inNight(night(), t);
    let n = 0;
    for (const r of list) {
      if (!r?.key || sent.has(r.key)) continue;
      sent.set(r.key, t);
      if (quiet) continue;
      const people = String(r.who || '').split(' & ').map((x) => x.trim()).filter(Boolean);
      for (const p of people) {
        try { n += await notify(p, { title: reminderWords(r, t), body: r.place || '', tag: 'remind-' + r.key }) || 0; } catch {}
      }
    }
    return n;
  }
  return { tick };
}

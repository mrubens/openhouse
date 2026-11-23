// The sun and the moon, worked out here: nothing is fetched. The tablet's weather says today's sunrise and sunset for
// where the household lives; from those two times this finds roughly where that is (the middle of the day gives the
// longitude, the day's length the latitude), and from there any day's sun. The moon's phase needs no place at all.
// Standard low-precision formulas (the Astronomical Almanac's, as in NOAA's calculator): good to a minute or two.

const RAD = Math.PI / 180, DAY = 864e5, J2000 = Date.UTC(2000, 0, 1, 12);
const days = (t) => (t - J2000) / DAY;

/** The sun's declination (radians) and the equation of time (minutes) at a moment. */
function sun(t) {
  const n = days(t), L = (280.46 + 0.9856474 * n) % 360, g = (357.528 + 0.9856003 * n) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD, eps = (23.439 - 4e-7 * n) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / RAD;
  let eot = 4 * (((L - ((ra + 360) % 360)) + 540) % 360 - 180);
  return { dec: Math.asin(Math.sin(eps) * Math.sin(lambda)), eot };
}
const H0 = -0.833 * RAD; // the sun's top at the horizon, with the air's bending

/** Where the household is, near enough, from a day's sunrise and sunset (Dates): {lat, lon} in degrees, or null. */
export function placeFrom(rise, set) {
  if (!(rise instanceof Date) || !(set instanceof Date) || !(set > rise)) return null;
  const noon = new Date((rise.getTime() + set.getTime()) / 2), s = sun(noon);
  const utcMin = noon.getUTCHours() * 60 + noon.getUTCMinutes() + noon.getUTCSeconds() / 60;
  const lon = (720 - utcMin - s.eot) / 4;
  const half = ((set - rise) / 60e3 / 4 / 2) * RAD; // half the day, as an hour angle
  // cos(half) = (sin h0 - sin φ sin δ) / (cos φ cos δ): find φ by halving the interval
  const f = (phi) => (Math.sin(H0) - Math.sin(phi) * Math.sin(s.dec)) / (Math.cos(phi) * Math.cos(s.dec)) - Math.cos(half);
  let a = -65 * RAD, b = 65 * RAD;
  if (f(a) * f(b) > 0) return { lat: 0, lon };
  for (let i = 0; i < 50; i++) { const m = (a + b) / 2; if (f(a) * f(m) <= 0) b = m; else a = m; }
  return { lat: ((a + b) / 2) / RAD, lon };
}

/** A day's sunrise and sunset (Dates) at a place, for the day holding `day` (a Date). */
export function sunTimes(day, { lat, lon }) {
  const d = new Date(day); d.setHours(12, 0, 0, 0);
  const s = sun(d.getTime()), phi = lat * RAD;
  const cosH = (Math.sin(H0) - Math.sin(phi) * Math.sin(s.dec)) / (Math.cos(phi) * Math.cos(s.dec));
  if (cosH > 1 || cosH < -1) return null;
  const half = Math.acos(cosH) / RAD * 4; // minutes
  const noonUtc = 720 - 4 * lon - s.eot; // minutes after UTC midnight
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { rise: new Date(base + (noonUtc - half) * 60e3), set: new Date(base + (noonUtc + half) * 60e3) };
}

// ---- the moon ----
const SYNODIC = 29.530588853;
const NEW = Date.UTC(2000, 0, 6, 18, 14); // a new moon
/** The moon at a moment: {age (days since new), lit (0-1), name, waxing}. */
export function moon(t = Date.now()) {
  const age = ((((t - NEW) / DAY) % SYNODIC) + SYNODIC) % SYNODIC;
  const lit = (1 - Math.cos((2 * Math.PI * age) / SYNODIC)) / 2;
  const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  const name = names[Math.floor(((age / SYNODIC) * 8) + 0.5) % 8];
  return { age, lit, name, waxing: age < SYNODIC / 2 };
}
/** When the moon is next full (or new) after a moment: a Date. */
export function next(kind, t = Date.now()) {
  const target = kind === 'full' ? SYNODIC / 2 : 0;
  const age = moon(t).age;
  let wait = (target - age + SYNODIC) % SYNODIC;
  if (wait < 0.5) wait += SYNODIC;
  return new Date(t + wait * DAY);
}

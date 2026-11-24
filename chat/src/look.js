// The home screen's palettes (home.jsx, and the phone's app frames: phone-apps.jsx). Plain data, so a page can take
// them without the rest of the home screen.
/** bg: the world behind everything; sheet: the panels on it; ink: text and the primary buttons; accent: now, counts.
 *  tabs (optional): a faint hue of its own for a tab's world, by the starting app it is (worldOf). */
export const PALETTES = {
  // The light look, the default: a warm off-white world with a faint hue per tab, white panels, ink type.
  paper: { bg: '#f1eee8', sheet: '#ffffff', ink: '#15132b', accent: '#e2452f',
    tabs: { calendar: '#eeeef6', weather: '#edf0f4', map: '#eef0ea', chores: '#f1eef7', lists: '#ebf2ec', meals: '#f6ede5', recipes: '#f5eee4', photos: '#f2f1ee', whiteboard: '#e8eff0', apps: '#ebeff6' } },
  linen: { bg: '#eadfce', sheet: '#fffaf2', ink: '#35291f', accent: '#b0502a' },
  sage: { bg: '#dfe6db', sheet: '#fbfdf9', ink: '#25302a', accent: '#4f7d5c' },
  mist: { bg: '#dfe6ee', sheet: '#fcfdfe', ink: '#222b34', accent: '#3d6ea8' },
  dusk: { bg: '#1b1a20', sheet: '#2a2830', ink: '#f0ece6', accent: '#f0a070' },
};
const lum = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= .04 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)); return .2126 * r + .7152 * g + .0722 * b; };
/** White as the accent: true white on a dark palette; on a light one, where white would vanish into the panels, the
 *  marks take the ink instead (no color at all). */
export const WHITE = '#ffffff';
/** A look's colors: its palette with the household's own over it. */
export const paletteOf = (look) => {
  const p = { ...(PALETTES[look?.palette] || PALETTES.paper), ...(look?.colors || {}) };
  if (/^#[0-9a-f]{6}$/i.test(p.accent) && /^#[0-9a-f]{6}$/i.test(p.sheet) && lum(p.accent) > .6 && lum(p.sheet) > .6) p.accent = p.ink;
  return p;
};
/** The world behind a tab (its id, or the starting app it is): the palette's hue for it, unless the household chose
 *  its own background. */
export const worldOf = (look, tab) => { const p = paletteOf(look); return (!look?.colors?.bg && p.tabs?.[tab]) || p.bg; };

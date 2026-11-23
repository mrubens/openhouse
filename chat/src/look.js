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
/** A look's colors: its palette with the household's own over it. */
export const paletteOf = (look) => ({ ...(PALETTES[look?.palette] || PALETTES.paper), ...(look?.colors || {}) });
/** The world behind a tab (its id, or the starting app it is): the palette's hue for it, unless the household chose
 *  its own background. */
export const worldOf = (look, tab) => { const p = paletteOf(look); return (!look?.colors?.bg && p.tabs?.[tab]) || p.bg; };

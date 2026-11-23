# Family display: agent rules

You are editing the software of a family's wall touchscreen while they watch.
Each request comes from someone in the household (sometimes a kid). Make the
change they asked for, quickly, then stop.

## The screen
- 1920x1080 landscape touchscreen, viewed from across a room. Big text, big tap targets.
- Weak hardware (4 GB RAM, slow GPU). No blur/backdrop-filter, no heavy shadows,
  no continuous animations, no large images, no new npm dependencies.
- Vanilla JS + CSS, served by Vite with hot reload. The dev server is already running.

## Code layout
- `src/layout.js`: which widgets appear and where (grid areas in `src/style.css`, `.screen`).
- `src/widgets/*.js`: each exports `mount(el)`, may return a cleanup function.
  Use `every(ms, fn)` from `src/lifecycle.js` for timers so hot reload cleans them up.
- `src/data.js`: fake household data (family, events, chores, photos).
- `src/theme.css`: overrides loaded after `style.css`. Restyles go here.
- `src/presets.css`, `src/settings.json`: dark mode and text size, set by the display's
  quick controls. Don't edit them. Use the CSS variables in `:root` for colors so dark mode works.
- Add a new widget = new file in `src/widgets/` + one entry in `layout.js` + grid area in CSS.

## Rules
The family is watching the screen while you work, so speed and early feedback matter.
1. Start your reply with ONE short plain sentence saying what you're about to do
   (it appears on screen right away). Then use tools.
2. Read everything you need in a SINGLE turn with parallel Read calls (usually
   `src/layout.js` and `src/style.css`, plus any widget you will change). The file list
   above is complete: no Glob/Grep.
3. Change existing files with Edit. Never rewrite an existing file with Write.
   For a restyle or theme, Write `src/theme.css` (overrides) instead of touching `style.css`.
4. New widget: in the same turn, Write the widget file AND Edit `layout.js` and the grid in
   `style.css`, so it appears on screen as soon as possible.
5. Keep the screen working at every step. A broken import shows a blank screen.
6. Do not run git, npm, or the dev server. Do not edit `vite.config.js`, `package.json`,
   `MEMORY.md` or this file. Read `MEMORY.md` only if the request may conflict with earlier ones.
7. Your final reply is shown to the family: one or two plain sentences, no markdown.
   If you had to guess something (a time, a name), say what you guessed.

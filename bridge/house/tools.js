// The house's tools for the assistant (on the home screen's MCP server: what the apps' taps do), and what a
// conversation knows of the house.
import { DAY, WEEKDAYS, REPEATS, PICS, SHOWS, NIGHT, dayKey, daysFrom, localWhen, inLocal, str, objs, same, arr } from './util.js';
import { asData } from '../as-data.js';
import { groceriesOf } from '../kit/recipe-text.js';

export default function (house) {
  const { data, view, board, notes, appEvents } = house;
  // ---- for conversations: what's on the lists and the menu, so "what's for dinner?" just works ----
  function context() {
    const today = dayKey(), lines = [];
    for (const l of data.lists) { const open = l.items.filter((i) => !i.done); lines.push(`- ${l.name}: ${open.map((i) => i.text).join(', ') || 'empty'}`); }
    const meals = [...Array(7)].map((_, i) => { const k = dayKey(daysFrom(i)); const m = data.meals[k]; return m ? `${i === 0 ? 'today' : new Date(k + 'T12:00').toLocaleDateString('en-US', { weekday: 'short' })} ${Object.entries(m).map(([a, b]) => `${a}: ${b}`).join(', ')}` : null; }).filter(Boolean);
    const ch = house.chores().filter((c) => c.today), done = ch.filter((c) => c.done);
    const st = Object.entries(house.starsView()).filter(([, n]) => n > 0);
    return [
      `Lists (the Lists app):\n${lines.join('\n')}`,
      meals.length ? `Meals planned: ${meals.join('; ')}` : 'Meals planned: none this week',
      Object.keys(data.recipes).length ? `Recipes saved (set_meals recipes): ${Object.values(data.recipes).map((r) => r.text).join(', ')}` : '',
      ch.length ? `Chores done today (${today}): ${done.map((c) => `${c.who ? c.who + ': ' : ''}${c.task}`).join(', ') || 'none yet'}` : '',
      st.length || data.rewards.length ? `Stars to spend: ${st.map(([n, s]) => `${n} ${s}`).join(', ') || 'none'}. Rewards: ${data.rewards.map((r) => `${r.title} (${r.stars}${r.who ? `, ${r.who}` : ''})`).join(', ') || 'none yet'}` : '',
      data.checklists.length ? `Routines (picture checklists in Chores): ${data.checklists.map((c) => `${c.name} ${c.from}–${c.to}${c.who.length ? ` (${c.who.join(', ')})` : ''}: ${c.steps.map((s) => s.text + (s.secs ? ` (${s.secs % 60 ? s.secs + ' s' : s.secs / 60 + ' min'})` : '')).join(', ')}`).join('; ')}` : '',
    ].filter(Boolean).join('\n');
  }
  // ---- tools (on the home screen's MCP server) ----
  const person = { type: 'string', description: 'A family name' };
  const TOOLS = [
    { name: 'night_hours', description: 'The screen\'s night hours: when nobody\'s using it, it dims and shows only the time (no photos), and the check-ins sleep. On by default, 9:30 PM to 6:30 AM. Pass from and to ("21:30", "06:30") to change them, off: true to turn night off, or nothing to say what they are. Change them only when they ask.',
      inputSchema: { type: 'object', properties: { from: { type: 'string', description: '"HH:MM", 24-hour' }, to: { type: 'string', description: '"HH:MM", 24-hour' }, off: { type: 'boolean' } } } },
    { name: 'family_things', description: "The family's lists (groceries, to-do...), today's chores with checkmarks and this week's stars, stars to spend and rewards, routines (morning/bedtime checklists), the meal plan and favorite meals, and events added on this display, and the household's email address (email; null when email is off: mail from the household's approved addresses to it offers its events on the Calendar and puts its photos in Photos). Read before changing them. The Calendar, Chores, Lists and Meals apps show exactly this.", inputSchema: { type: 'object', properties: {} } },
    { name: 'change_list', description: 'Add to, check off, uncheck, change or remove items on one of the family\'s lists (the Lists app; "add milk" means Groceries). Creates the list if it\'s new. Items match by their text.',
      inputSchema: { type: 'object', properties: {
        list: { type: 'string', description: 'e.g. "Groceries", "To do", "Costco"' },
        add: { type: 'array', items: { type: 'string' } }, check: { type: 'array', items: { type: 'string' } }, uncheck: { type: 'array', items: { type: 'string' } },
        remove: { type: 'array', items: { type: 'string' } },
        edit: { type: 'array', description: 'Change items: the item (its text now), its new text, and whose it is.', items: { type: 'object', properties: { item: { type: 'string' }, text: { type: 'string' }, who: { type: 'string' } }, required: ['item'] } },
        clearChecked: { type: 'boolean', description: 'Take everything checked off the list.' },
        rename: { type: 'string' }, deleteList: { type: 'boolean', description: 'Only if they asked to get rid of the whole list.' },
        byAisle: { type: 'boolean', description: 'Show it by store section (true) or in the order added (false), as the list\'s card sets it' },
      } } },
    { name: 'change_chores', description: "The family's chores (the Chores app): mark one done or not done (today unless a date), add, change or remove one, or skip one for a day (no stars, not left to do). Chores repeat every day unless they have days. Each chore done earns its person its stars (1 unless set); a chore for anyone (no who) earns them for whoever did it (by).",
      inputSchema: { type: 'object', properties: {
        done: { type: 'array', items: { type: 'object', required: ['task'], properties: { who: person, task: { type: 'string' }, by: { type: 'string', description: 'For a chore anyone can do: who did it (gets its stars)' }, date: { type: 'string', description: 'YYYY-MM-DD; default today' } } } },
        update: { type: 'array', items: { type: 'object', required: ['task'], properties: { who: person, task: { type: 'string' }, to: { type: 'object', properties: { task: { type: 'string' }, who: { type: 'string', description: 'Empty: anyone' }, days: { type: 'array', items: { type: 'string', enum: WEEKDAYS } }, stars: { type: 'number', description: '1 to 10' }, pic: { type: 'string', enum: PICS }, keep: { type: 'boolean' }, every: { type: 'number', description: 'Every N days (2-90) instead of weekdays; 0 for weekdays again' }, after: { type: 'boolean', description: 'With every: N days after it was last done' } } } } } },
        skip: { type: 'array', items: { type: 'object', required: ['task'], properties: { who: person, task: { type: 'string' }, date: { type: 'string' } } } },
        unskip: { type: 'array', items: { type: 'object', required: ['task'], properties: { who: person, task: { type: 'string' }, date: { type: 'string' } } } },
        undone: { type: 'array', items: { type: 'object', required: ['task'], properties: { who: person, task: { type: 'string' }, date: { type: 'string' } } } },
        add: { type: 'array', items: { type: 'object', required: ['task'], properties: { who: person, task: { type: 'string' }, stars: { type: 'number', description: 'Stars it earns, 1 to 10 (1 unless a bigger job)' }, pic: { type: 'string', enum: PICS, description: 'Its picture (guessed from the task if left out)' }, keep: { type: 'boolean', description: 'With days: if not done on its day it stays up, late, until it is' }, days: { type: 'array', items: { type: 'string', enum: WEEKDAYS }, description: 'Only on these days; leave out for every day.' },
          every: { type: 'number', description: 'Every N days (2-90) instead of weekdays: 14 for every other week' }, after: { type: 'boolean', description: 'With every: N days after it was last done (change the sheets a week after)' } } } },
        remove: { type: 'array', items: { type: 'object', required: ['task'], properties: { who: person, task: { type: 'string' } } } },
      } } },
    { name: 'change_rewards', description: 'Rewards the kids save their chore stars for (the Chores app), like "Movie night" for 20 stars. Add or change one (same title changes its stars), or remove one. ' +
      'redeem spends a kid\'s stars on a reward ("Leo wants movie night"), as the Chores app\'s Get it! does: someone says yes on the device, with the PIN, and this waits for them (tell them to type the PIN on the device). You never say yes for them.',
      inputSchema: { type: 'object', properties: {
        add: { type: 'array', items: { type: 'object', required: ['title', 'stars'], properties: { title: { type: 'string' }, stars: { type: 'number' }, who: { type: 'string', description: 'Only for this person; leave out for anyone' } } } },
        remove: { type: 'array', items: { type: 'string', description: 'title or id' } },
        redeem: { type: 'object', required: ['who', 'reward'], properties: { who: person, reward: { type: 'string', description: 'The reward\'s title or id' } } },
      } } },
    { name: 'change_routines', description: 'Routines: short picture checklists (morning, bedtime, after school) that the Chores app shows at the top during their hours, one row per person. Add, change (by name or id), remove, or check a step off. Each step has a picture, and may have a time (shown as a bar that runs down; running out never fails the step). To play one a step at a time on the screen, use chores__play.',
      inputSchema: { type: 'object', properties: {
        add: { type: 'array', items: { type: 'object', required: ['name', 'steps'], properties: {
          name: { type: 'string', description: 'e.g. "Morning"' }, who: { type: 'array', items: person, description: 'Whose; leave out for every kid' },
          from: { type: 'string', description: 'HH:MM, when it shows' }, to: { type: 'string', description: 'HH:MM' }, days: { type: 'array', items: { type: 'string', enum: WEEKDAYS } },
          steps: { type: 'array', items: { type: 'object', required: ['text'], properties: { text: { type: 'string', description: 'Two or three words' }, pic: { type: 'string', enum: PICS }, minutes: { type: 'number', description: 'Optional: how long the step gets' } } } } } } },
        update: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, rename: { type: 'string' }, who: { type: 'array', items: person }, from: { type: 'string' }, to: { type: 'string' }, days: { type: 'array', items: { type: 'string' } }, steps: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, pic: { type: 'string', enum: PICS }, minutes: { type: 'number', description: 'Left out: the step keeps its time' } } } } } } },
        remove: { type: 'array', items: { type: 'string', description: 'name or id' } },
        check: { type: 'array', items: { type: 'object', required: ['name', 'step', 'who'], properties: { name: { type: 'string' }, step: { type: 'string' }, who: person, done: { type: 'boolean' } } } },
        times: { type: 'array', description: 'Give one step a time, or 0 to take it off', items: { type: 'object', required: ['name', 'step', 'minutes'], properties: { name: { type: 'string', description: 'The routine' }, step: { type: 'string' }, minutes: { type: 'number' } } } },
      } } },
    { name: 'save_recipe', description: "Save a recipe into the recipe box, where it is made into cooking steps and shows in Recipes. Every recipe goes here, never in a note: a link to its page (one someone gives or shares, or one you found), or a recipe someone tells you or types (name, ingredients and steps: kept as they said it, ready to cook at once, as Recipes' Type it in does), or else the recipe itself as text. meal: the meal it's for, only if they said.",
      inputSchema: { type: 'object', properties: { link: { type: 'string', description: 'Its web page (with steps: just where it came from)' }, name: { type: 'string', description: 'With steps: its name' },
        ingredients: { type: 'array', items: { type: 'string' }, description: 'With steps: one each, with its amount ("2 tsp ground cumin")' }, steps: { type: 'array', items: { type: 'string' }, description: 'One each, in order, in their words' },
        serves: { type: 'string' }, minutes: { type: 'number', description: 'How long it takes in all' }, picture: { type: 'string', description: 'An https link to a photo of the dish' },
        text: { type: 'string', description: 'Without a page or steps: the whole recipe, its name, ingredients and steps' }, meal: { type: 'string' } } } },
    { name: 'set_meals', description: 'Plan meals (the Meals app): set or change what\'s for a meal on a day; empty text clears it. Also the recipe box (a recipe per meal) and which meals the app plans. Meals they have often come back as one-tap choices; favorite pins one there.',
      inputSchema: { type: 'object', properties: { meals: { type: 'array', items: { type: 'object', required: ['date', 'text'], properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' }, meal: { type: 'string', description: 'dinner (default), lunch, breakfast' }, text: { type: 'string' } } } },
        favorite: { type: 'array', items: { type: 'string' }, description: 'Meals to pin as favorites' }, unfavorite: { type: 'array', items: { type: 'string' } },
        recipes: { type: 'array', description: 'Save a recipe in the recipe box, by the meal it is for (a link and/or notes: ingredients and steps); both empty takes it out. It shows on every day that meal is planned.', items: { type: 'object', required: ['meal'], properties: { meal: { type: 'string' }, link: { type: 'string' }, notes: { type: 'string' } } } },
        slots: { type: 'array', items: { type: 'string', enum: ['breakfast', 'lunch', 'dinner'] }, description: 'Which meals the Meals app plans each day (dinner only unless they want more).' },
        groceries: { type: 'array', description: "Put a planned meal's ingredients on Groceries (the Meals app's Add to Groceries): what its recipe lists (family_things recipes' needs), or only items. Ones already on the list are left.", items: { type: 'object', required: ['date'], properties: {
          date: { type: 'string', description: 'YYYY-MM-DD' }, meal: { type: 'string', description: 'dinner (default), lunch, breakfast' }, items: { type: 'array', items: { type: 'string' }, description: 'Only these, by name; leave out for all it lists' } } } } } } },
    { name: 'flyer_photo', description: 'The latest photo someone sent to the display from their phone: a flyer, school notice or invitation (the Calendar app\'s camera button), or a recipe (the Meals app). Look at it to add its events (say what you found and ask before adding) or type up the recipe.',
      inputSchema: { type: 'object', properties: {} } },
    { name: 'calendar_event', description: "The family calendar (the Calendar app). Add an event; change one added on this display (update: its id and only what changes: a new time, place, title, notes, whose, repeat); remove one added here (by id; with date, only that day of a repeating one); remind them before any event (remind; synced ones too); or count down to any event, synced ones too (countdown: id for one added here, uid for a synced one; family_things lists both). Events in a two-way calendar (editable: true in family_things; Google or iCloud signed in on the display) are changed and removed by id here like the display's own, and new events go into the person's own two-way calendar, else the household's (the answer says which). Other synced calendars (read from a link) can't be changed here: say so, and offer to add it on the display's calendar instead.",
      inputSchema: { type: 'object', properties: {
        add: { type: 'object', required: ['title', 'start'], properties: { title: { type: 'string' }, calendar: { type: 'string', description: 'Which calendar it belongs in: a key from family_things\' calendars. The one they named; else the one where events like it already are (each lists some of its titles: a practice goes where the other practices are, a work meeting where the work ones are); else leave it out for the person\'s own, then the household\'s. "here" for only this display. Say which in a few words when it isn\'t the obvious one.' }, start: { type: 'string', description: 'ISO local date-time like 2026-11-20T16:30, or a date for all day (the first time, for a repeating one)' }, end: { type: 'string' }, allDay: { type: 'boolean' }, who: { type: 'string', description: 'Whose it is (a family name), if anyone\'s' }, also: { type: 'array', items: { type: 'string' }, description: 'Anyone else it is for (shown in each of their colours)' }, place: { type: 'string' },
          notes: { type: 'string', description: 'What to bring, who drives, a phone number' }, countdown: { type: 'boolean', description: 'Count down to it on the home screen (a birthday, a trip)' },
          remind: { type: 'number', description: 'Minutes before to remind them on the display (0 at the start, -1 none); leave out for the household\'s usual' },
          repeat: { type: 'string', enum: REPEATS, description: 'Only when they said it repeats ("every Friday", "weekly", "each day"); never because of what the event is. Leave it out for a one-off.' }, until: { type: 'string', description: 'YYYY-MM-DD, last day it repeats; leave out for always' } } },
        update: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD: which time of a repeating one they mean (the whole series changes)' }, title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, allDay: { type: 'boolean' }, who: { type: 'string' }, also: { type: 'array', items: { type: 'string' } }, place: { type: 'string' }, notes: { type: 'string' },
          countdown: { type: 'boolean' }, remind: { type: 'number' }, repeat: { type: 'string', enum: [...REPEATS, 'none'] }, until: { type: 'string' } } },
        remove: { type: 'array', items: { type: 'string' }, description: 'ids of events added on the display (one or more): all of each, every day it repeats' }, date: { type: 'string', description: 'YYYY-MM-DD: only remove that day of a repeating event' },
        countdown: { type: 'object', properties: { id: { type: 'string' }, uid: { type: 'string' }, on: { type: 'boolean' } } },
        remind: { type: 'object', description: 'A reminder on any event, synced ones too: minutes before (0 at the start, -1 none, null the household\'s usual)', properties: { id: { type: 'string' }, uid: { type: 'string' }, minutes: { type: ['number', 'null'] } } },
        settings: { type: 'object', description: 'The Calendar app\'s own settings, as its bell and its app-notes chips set them: the household\'s usual reminder (minutes before; -1 for none), whether reminders are also said aloud, and how much of each app\'s notes on the calendar\'s days shows (lunch menus, trash day: the week, today only, or off). Pass {} to hear them and the apps.',
          properties: { remind: { type: 'number' }, remind_aloud: { type: 'boolean' }, app_notes: { type: 'array', items: { type: 'object', required: ['app', 'show'], properties: { app: { type: 'string', description: 'The app\'s id (settings {} lists them)' }, show: { type: 'string', enum: SHOWS } } } } } },
      } } },
    { name: 'photos', description: "The household's photos (the Photos app, and the slideshow on the sleep screen). list: the photos, newest first (name, when, caption, albums), the albums, and the photos taken off lately. " +
      'Then, by the photos\' names from list: take_off (kept 30 days and can be put back), put_back one taken off, caption one (empty text takes the caption off), or an album: add one (name, photos), rename it, put_in or take_out photos, ' +
      'show (whether its photos show on the sleep screen and in All), or remove the album (its photos stay). An album from iCloud is stopped in the Photos app, on its card. Photos are added from a phone (Add photos), not here.',
      inputSchema: { type: 'object', required: ['do'], properties: {
        do: { type: 'string', enum: ['list', 'take_off', 'put_back', 'caption', 'album'] },
        photos: { type: 'array', items: { type: 'string' }, description: 'Photos by their name from list' },
        text: { type: 'string', description: 'For caption: the line shown with it' },
        album: { type: 'object', description: 'For album', required: ['do'], properties: {
          do: { type: 'string', enum: ['add', 'rename', 'put_in', 'take_out', 'show', 'remove'] },
          album: { type: 'string', description: 'Which album, by its name or id (not for add)' }, name: { type: 'string', description: 'For add and rename: its name' },
          sleep: { type: 'boolean', description: 'For show: on the sleep screen' }, all: { type: 'boolean', description: 'For show: in Photos\' All' } } } } } },
  ];
  const ParentPinNote = ' (someone types the PIN there)';
  async function call(name, a, ctx = null) {
    const ok = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 1) }] });
    const out = (r) => (r.error ? { content: [{ type: 'text', text: r.error }], isError: true } : ok(r));
    if (name === 'family_things') {
      const v = view(); delete v.v; delete v.mealWork; delete v.ai; delete v.night; v.photos = v.photos.length; delete v.screensaver; delete v.aisles; delete v.removed;
      v.recipes = Object.fromEntries(Object.entries(v.recipes || {}).map(([k, { cook, ...r }]) => [k, { ...r, ...(cook ? { steps: cook.steps.length } : {}), needs: groceriesOf({ ...r, cook }) }])); // the cooking steps are the Recipes app's
      v.albums = v.albums.map((a) => ({ name: a.name, photos: a.photos.length }));
      // Events added here (changeable, by id), and the coming two weeks of everything else (synced: by uid, for a countdown).
      v.events = data.events.map((e) => ({ id: e.id, title: e.title, start: localWhen(e.start, e.allDay), end: localWhen(e.end, e.allDay, true), allDay: e.allDay, who: e.who, ...(e.also ? { also: e.also } : {}), ...(e.place ? { place: e.place } : {}), ...(e.notes ? { notes: e.notes } : {}), ...(e.countdown ? { countdown: true } : {}), ...(e.remind != null ? { remind: e.remind } : {}), ...(e.repeat ? { repeat: e.repeat, until: e.until } : {}) }));
      const soon = Date.now() + 14 * DAY;
      // What the household's apps put on the calendar: read-only here (the app changes them).
      v.fromApps = appEvents().filter((e) => new Date(e.end || e.start) > Date.now() - DAY && new Date(e.start) < soon).slice(0, 60)
        .map((e) => ({ title: e.title, start: localWhen(e.start, e.allDay), ...(e.allDay ? { allDay: true } : {}), ...(e.who ? { who: e.who } : {}), ...(e.place ? { place: e.place } : {}), from: e.appName }));
      v.dayNotes = Object.fromEntries(Object.entries(v.dayNotes || {}).filter(([k]) => k >= dayKey() && k < dayKey(new Date(soon))).map(([k, l]) => [k, l.map((x) => `${x.label}: ${x.text}${x.who ? ` (${x.who})` : ''} [from ${x.name}]`)]));
      // Each two-way calendar with some of what's in it, so a new event goes where ones like it already are.
      const inCal = (k) => [...new Set(board.calendarEvents().filter((e) => e.calendar === k && e.title).map((e) => String(e.title).slice(0, 60)))].slice(0, 8);
      v.calendars = board.sync?.targets().map((t) => ({ key: t.key, name: t.name, ...(t.who ? { who: t.who } : {}), ...(t.default ? { default: true } : {}), has: inCal(t.key) })) || [];
      v.synced = board.calendarEvents().filter((e) => new Date(e.end || e.start) > Date.now() - DAY && new Date(e.start) < soon).slice(0, 80)
        .map((e) => ({ title: e.title, start: localWhen(e.start, e.allDay), ...(e.allDay ? { allDay: true } : {}), who: e.who || null, ...(e.place ? { place: e.place } : {}), ...(e.uid ? { uid: e.uid } : {}), ...(e.editable ? { id: e.id, editable: true, calendar: e.calendarName, ...(e.date ? { date: e.date } : {}), ...(e.repeat ? { repeat: e.repeat } : {}) } : {}), ...(e.uid && data.countdowns.includes(e.uid) ? { countdown: true } : {}), ...(e.uid && data.reminds[e.uid] !== undefined ? { remind: data.reminds[e.uid] } : {}) }));
      v.meals = Object.fromEntries(Object.entries(v.meals).filter(([k]) => k >= dayKey(daysFrom(-2))));
      v.lists = v.lists.map((l) => ({ name: l.name, items: l.items.map((i) => ({ text: i.text, ...(i.who ? { who: i.who } : {}), ...(i.done ? { done: true } : {}) })) }));
      v.favorites = v.favorites.map((f) => f.text);
      v.reminders = (v.reminders || []).map((r) => ({ ...inLocal(r), ...(r.remindAt ? { remindAt: localWhen(r.remindAt) } : {}) }));
      v.things = (v.things || []).map((x) => (x.start ? { ...x, start: localWhen(x.start, x.allDay) } : x));
      // Synced calendars' events, what apps put on the calendar or on Home, the reminders (synced events' titles among
      // them), the photos' captions (shared albums' own) and the recipe box (its recipes' pages' own text: recipes.js
      // saveLink) are other people's words: after ours, marked as data.
      const outside = { synced: v.synced, fromApps: v.fromApps, dayNotes: v.dayNotes, reminders: v.reminders, things: v.things, captions: v.captions, recipes: v.recipes };
      for (const k of Object.keys(outside)) delete v[k];
      return { content: [...ok(v).content, { type: 'text', text: asData(JSON.stringify(outside, null, 1), "the household's synced calendars' events (synced), what their apps put on the calendar (fromApps), the apps' day notes (dayNotes), the reminders due, the things on Home, the photos' captions and the recipe box (recipes): their titles, places, notes and captions are those calendars', apps' and albums' own words, and a recipe's notes and name can be its web page's", { max: 60000 }) }] };
    }
    if (name === 'night_hours') {
      if (a?.off) house.settings({ night: false });
      else if (a?.from || a?.to) { const cur = view().night || NIGHT; house.settings({ night: { from: a.from || cur.from, to: a.to || cur.to } }); }
      const n = view().night;
      return ok(n ? `Night: ${n.from} to ${n.to}.` : 'Night is off: the screen stays as it is all night.');
    }
    if (name === 'flyer_photo') return house.flyerPhoto();
    if (name === 'change_list') return out(house.changeList(a));
    if (name === 'change_chores') return out(house.changeChores(a));
    if (name === 'change_rewards') {
      if (!a?.redeem) return out(house.changeRewards(a));
      // Spending stars, as the Chores app's Get it!: the same ask and the same "Is this OK?" card, with the PIN, that only
      // a person answers on the tablet (askAnAdult); this waits for it.
      const { redeem, ...rest } = a, did = Object.keys(rest).length ? (house.changeRewards(rest).did || []) : [];
      const r = data.rewards.find((y) => y.id === redeem.reward || same(y.title, redeem.reward)), who = str(redeem.who, 40);
      if (!r || !who) return out({ error: `Which reward, for whom? The rewards: ${data.rewards.map((y) => `${y.title} (${y.stars} stars)`).join(', ') || 'none'}.` });
      if (house.stars(who) < r.stars) return out({ error: `${who} has ${house.stars(who)} stars; ${r.title} needs ${r.stars}.` });
      const before = house.stars(who);
      house.changeRewards({ redeem: { who, id: r.id } }, { fromApp: true });
      const ask = data.asks.find((x) => x.reward === r.id && same(x.who, who));
      if (ask && !ask.manual) { const t0 = Date.now(); while (data.asks.includes(ask) && Date.now() - t0 < 105e3) await new Promise((ok) => setTimeout(ok, 300)); }
      const given = house.stars(who) < before;
      return { content: [{ type: 'text', text: [...did, given ? `Given: ${who} spent ${r.stars} stars on ${r.title}.` : ask?.manual ? 'Asked: someone says yes in the Chores app on the device.' : `Not given: nobody said yes on the device${ParentPinNote}.`].join('; ') }], isError: !given && !ask?.manual };
    }
    if (name === 'change_routines') return out(house.changeChecklists(a));
    if (name === 'save_recipe') {
      if (a.steps != null) { const r = house.addTyped({ name: a.name || a.meal, ingredients: a.ingredients, steps: a.steps, serves: a.serves, minutes: a.minutes, link: a.link, picture: a.picture }); return r.error ? out(r) : ok(`Saved ${r.meal}: it is in Recipes, ready to cook.`); }
      const r = a.link ? house.addRecipeLink({ link: a.link, meal: a.meal || '' }) : house.addRecipeText(a.text);
      return r.error ? out(r) : ok(r.meal ? `Saved ${r.meal}: it is in Recipes, ready to cook.` : 'Saved: it is being read and made into steps; it will be in Recipes in a moment.');
    }
    if (name === 'set_meals') {
      for (const f of arr(a.favorite)) house.favorite(f, true);
      for (const f of arr(a.unfavorite)) house.favorite(f, false);
      const did = [];
      for (const r of objs(a.recipes)) { const x = house.setRecipe(r); did.push(...(x.did || [x.error])); }
      if (a.slots) did.push(`plans ${house.setSlots(a.slots).slots.join(', ')}`);
      const m = a.meals ? house.setMeals(a.meals) : { ok: true, did: [] };
      for (const g of objs(a.groceries)) { // (after the meals: "plan tacos tonight and get what they need")
        const x = await house.ingredients(str(g.date, 10), str(g.meal || 'dinner', 20).toLowerCase(), { items: g.items == null ? null : arr(g.items) });
        did.push(x.error ? x.error : x.added ? [`added ${x.added.length ? x.added.join(', ') : 'nothing'} to Groceries`, x.had?.length ? `already on it: ${x.had.join(', ')}` : ''].filter(Boolean).join('; ') : 'the assistant is adding what it needs to Groceries');
      }
      return out({ ...m, did: [...(m.did || []), ...did] });
    }
    if (name === 'calendar_event') {
      const locked = await house.calendarPin(a, ctx); if (locked) return locked;
      if (a?.settings && typeof a.settings === 'object') {
        const s = a.settings, b = {};
        if (s.remind !== undefined) b.remind = s.remind;
        if (s.remind_aloud !== undefined) b.remindAloud = !!s.remind_aloud;
        for (const x of objs(s.app_notes)) house.settings({ fromApp: { app: x.app, show: x.show } });
        if (Object.keys(b).length) house.settings(b);
        const r = data.settings.remind, apps = (() => { try { return notes ? notes.apps() : []; } catch { return []; } })();
        const said = `Calendar settings: the usual reminder ${r == null ? 'none' : r === 0 ? 'at the start' : `${r} minutes before`}${data.settings.remindAloud ? ', said aloud too' : ''}. ` +
          (apps.length ? `Apps' notes on the calendar: ${apps.map((x) => `${x.name} (${x.app}): ${x.show}`).join(', ')}.` : 'No app puts notes on the calendar.');
        const rest = Object.keys(a).filter((k) => k !== 'settings');
        if (!rest.length) return ok(said);
      }
      const r = house.changeEvents(a); return out(r.event ? { ...r, event: inLocal(r.event) } : r);
    }
    if (name === 'photos') return house.photosTool(a || {});
    return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
  }
  return { TOOLS, call, context };
}

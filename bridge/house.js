// The family's own things that the starting apps (Calendar, Chores, Lists, Meals, Photos) show: kept here, by
// the bridge, not in any app's code. So the assistant can rewrite an app, or the family can throw one away and
// say "undo", and the events, chores, lists and meals are all still there. The same data is on the door
// tools, so "add milk", "Leo fed the cat" or "what's for dinner Thursday?" work from any conversation.
//
// GET  /house                  { v, today, family, lists, chores, stars, rewards, asks, checklists, meals, favorites,
//                                mealWork, events, photos, night, ai }
// GET  /house/wait?v=N         the same, once it changes (or after 25 s)
// POST /house/list             { list, add?: [text], check?: [id|text], uncheck?, remove?, clearChecked?, who? }
// POST /house/chore            { done: {who, task}, value? } | { add: {who, task, days?} } | { remove: {who, task} }
// POST /house/reward           { add: {title, stars, who?} } | { remove: id } | { redeem: {who, id} } | { answer: {id, yes} }
// POST /house/checklist        { add: {name, who?, from, to, days?, steps: [{text, pic}]} } | { update: {id, ...} } | { remove: id }
//                              | { check: {id, step, who, done?} }
// POST /house/meal             { date: "YYYY-MM-DD", meal?: "dinner", text } (empty text clears it) | { favorite: text, value? }
// POST /house/meal/ingredients { date, meal? }  the assistant puts what that meal needs on Groceries
// POST /house/event            { add: {title, start, end?, allDay?, who?, repeat?, until?} } | { remove: id, date? }
// POST /house/settings         { night: {from: "21:30", to: "06:30"} | false, remind?: minutes | false, remindAloud?: bool }
//                              (no photos on the idle screen at night; remind: the reminder every timed event gets)
// POST /house/flyer?name=x.jpg a photo of a flyer or school notice (the body): the assistant reads its events
//                              into view().flyer { state: "working" | "done" | "error", events?, text? }; nothing is
//                              added until the Calendar app (or the assistant) adds what the family says yes to
// POST /house/recipe-photo?meal=Tacos  a photo of a recipe (the body): the assistant types it into the recipe box
// POST /house/recipe-link     {link, meal?} a recipe's page (shared from a phone): read, saved, made into cooking steps
//                             (POST /house/meal {cook: meal, force?} makes the steps again; {find: words} finds recipes
//                             on the web, shown as recipeFind; {findDone: true} puts them away; cooking.js)
// POST /house/flyer/clear      {}  the flyer's events put away (added, or not wanted)
// POST /house/lock             { calendar: bool }  the display only (not an app): a PIN for calendar changes in the apps
// POST /house/unlock           {}  the display only, after the PIN: apps may change the calendar for 5 minutes
//   view(): calendarLock, unlockedUntil (ms; 0 when locked or no lock)
// POST /house/remind           { done: key }  a reminder put away, on every screen (its key from view().reminders)
// POST /house/thing            { take: id }  one of the things on Today taken down (view().things: things.js)
// GET  /house/photo/<name>     one of the family's photos (files in display/photos/)
// POST /house/photo?name=x.jpg the image itself as the body (the phone upload page)
// POST /house/photo/remove     { name }  (moved to photos/.removed, not deleted)
// POST /house/photo/album      { add: {name, photos?} } | { rename: {id, name} } | { remove: id } | { put: {id, photos, on?} }
// POST /house/photo/caption    { name, text }  (empty text takes it off)
//   view(): albums [{id, name, photos}], captions {photo: text}, slideshow (an album's id, or null for all of them),
//   screensaver: the photos the idle screen shows (that album's, else all)
//   linked: shared albums kept in step from iCloud [{id, album, from, status, error?, at, photos, coming}] (photo-albums.js)
// POST /house/album/stream, /house/album/assets   the shell only: what a linked album said (photo-albums.js)
// POST /house/share            { url }  a phone hand-off link (PhoneQr) through the shell's share sheet
//
// files: house.json (lists, chore checkmarks, stars, rewards, checklists, meals, events added on the display)
// next to household.json; photos/ next to it. Chores themselves stay in household.json, where setup and
// update_household keep them.
import fs from 'node:fs';
import { albumSync } from './photo-albums.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { cookSource, readRecipeLink, cookPrompt, COOK_SYSTEM, parseCook, cookAsNotes, youtube, findPrompt, FIND_SYSTEM, parseFound, withPictures } from './cooking.js';

const DAY = 86400e3;
/** Each person's color, in the order the family is listed, unless they chose one (household.json family[].color).
 *  The one palette: the apps (kit), the home screen and its widgets all take a person's color from /house. */
export const PEOPLE = ['#ffc247', '#56d6a0', '#ff8566', '#74acff', '#c3a0ff', '#ff9ec4'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const PHOTO = /\.(jpe?g|png|webp|gif|heic)$/i;
const REPEATS = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly'];
/** The pictures a checklist step can have (drawn by the display: dev.openhouse.ui StepPicture). */
export const PICS = ['sun', 'moon', 'shirt', 'teeth', 'shoes', 'backpack', 'bed', 'bath', 'book', 'plate', 'hands', 'hair', 'toys', 'cup', 'coat', 'pet', 'star', 'plant', 'trash', 'laundry', 'broom'];

/** Store sections, in the order a shop is usually walked, and words that put a thing in one (a guess: "Other" else). */
export const AISLES = [
  ['Produce', /\b(apples?|bananas?|berr(y|ies)|strawberr|blueberr|grapes?|lemons?|limes?|oranges?|pears?|peach|plums?|melon|avocados?|tomato|potato|onions?|garlic|carrots?|celery|lettuce|spinach|kale|broccoli|cauliflower|cucumbers?|peppers?|zucchini|squash|mushrooms?|herbs?|cilantro|parsley|basil|ginger|corn|beans? sprouts|salad|fruit|veg|greens|scallions?)\b/i],
  ['Bakery', /\b(bread|bagels?|buns?|rolls?|tortillas?|pitas?|croissants?|muffins?|baguette|cake|donuts?|english muffins)\b/i],
  ['Meat & fish', /\b(chicken|beef|pork|turkey|ham|bacon|sausages?|steak|ground|mince|lamb|fish|salmon|tuna steaks?|shrimp|prawns|cod|hot dogs?|deli|salami|pepperoni)\b/i],
  ['Dairy & eggs', /\b(milk|cheese|cheddar|mozzarella|parmesan|yogh?urt|butter|cream|eggs?|sour cream|cottage|half and half|creamer)\b/i],
  ['Frozen', /\b(frozen|ice cream|popsicles?|ice pops?|waffles|pizza rolls|nuggets|peas and carrots)\b/i],
  ['Pantry', /\b(rice|pasta|spaghetti|noodles|flour|sugar|salt|pepper|oil|vinegar|sauce|ketchup|mustard|mayo|cereal|oats|oatmeal|granola|beans|lentils|soup|broth|stock|canned|tuna|peanut butter|jam|jelly|honey|syrup|spices?|cinnamon|baking|yeast|crackers|chips|pretzels|popcorn|cookies|snacks?|nuts|almonds|raisins|coffee|tea|cocoa|chocolate)\b/i],
  ['Drinks', /\b(juice|water|sparkling|soda|seltzer|lemonade|beer|wine|kombucha)\b/i],
  ['Household', /\b(paper towels?|toilet paper|tissues?|napkins|foil|plastic wrap|bags|trash bags|dish soap|detergent|sponges?|cleaner|bleach|batteries|light ?bulbs?|dishwasher)\b/i],
  ['Personal care', /\b(shampoo|conditioner|soap|toothpaste|toothbrush|floss|deodorant|lotion|sunscreen|razors?|diapers|wipes|band-?aids|vitamins|medicine|tylenol|advil)\b/i],
  ['Pets', /\b(dog food|cat food|litter|treats|kibble)\b/i],
];
export const aisleOf = (text) => (AISLES.find(([, re]) => re.test(String(text || ''))) || ['Other'])[0];

export function houseRoutes({ DIR, json, body, board, door = null, currentAgent = null, agentName = () => 'off', WORK = DIR, things = null, notes = null }) {
  const FILE = path.join(DIR, '../house.json');
  const PHOTOS = path.join(DIR, '../photos');
  try { fs.mkdirSync(PHOTOS, { recursive: true }); } catch {}
  const tryRead = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  let data = tryRead(FILE) || tryRead(FILE + '.bak') || {};
  data.lists ||= [{ id: 'groceries', name: 'Groceries', items: [] }, { id: 'todo', name: 'To do', items: [] }];
  data.done ||= {}; // "YYYY-MM-DD": ["who|task", ...]
  data.by ||= {}; // "YYYY-MM-DD|who|task" -> who did a chore anyone could (they got its stars)
  data.skipped ||= {}; // "YYYY-MM-DD": ["who|task", ...]  skipped for the day: no stars, not left to do
  data.meals ||= {}; // "YYYY-MM-DD": { dinner: "Tacos" }
  data.recipes ||= {}; // the recipe box, by meal (lowercase): { text, link?, notes?, video?, image?, picsAt?, cook?: {name, serves, ingredients,
  // steps: [{text, uses?, timer?, image?}], for, at}, at } (image: the dish's photo on its page; a step's image: its page's photo of it)
  data.mealSlots ||= ['dinner']; // which meals the Meals app plans: some of breakfast, lunch, dinner
  data.events ||= []; // added on the display: [{ id, title, start, end?, allDay, who, place?, notes?, repeat?, until?, skip?, countdown? }]
  data.countdowns ||= []; // synced events counted down to (their uid from calendar.js)
  data.reminds ||= {}; // synced events' reminders: uid -> minutes before (-1: none, over the household's default)
  data.reminded ||= []; // reminders put away: "uid-or-id|start ISO" (the latest 200)
  data.rewards ||= []; // [{ id, title, stars, who? }]
  data.spent ||= {}; // "who" (lowercase) -> stars spent on rewards
  data.asks ||= []; // rewards asked for, waiting for a yes: [{ id, who, reward, title, stars, at, manual? }]
  data.got ||= []; // rewards given, newest first: [{ who, title, stars, at }]
  data.checklists ||= []; // [{ id, name, who: [], from, to, days?, steps: [{ text, pic }] }]
  data.checked ||= {}; // "YYYY-MM-DD": ["checklistId|step|who", ...]
  data.favorites ||= []; // meals pinned as favorites
  data.mealCounts ||= {}; // "tacos": { text, n, last }
  data.settings ||= {};
  // What the household's apps put on the calendar (day-notes.js): how each shows ('week': the Calendar's week and Today;
  // 'today': Today only, where a new one starts, so the week never changes without someone choosing; 'off'), and their order.
  const SHOWS = ['week', 'today', 'off'];
  notes?.setPrefs({ show: (app) => (SHOWS.includes(data.settings.fromApps?.[app]) ? data.settings.fromApps[app] : 'today'), order: () => data.settings.fromAppsOrder || [] });
  const appEvents = () => { try { return notes ? notes.events() : []; } catch (e) { console.error('[day-notes]', e); return []; } };
  data.albums ||= []; // [{ id, name, photos: [file names] }]
  data.captions ||= {}; // file name -> a line shown with it ("Grandma's 80th")
  // shared albums linked on the tablet (photo-albums.js): data.synced; their links stay in the shell
  if (!data.earned) { // stars earned so far, kept apart from checkmarks (those are pruned after two months)
    data.earned = {};
    for (const keys of Object.values(data.done)) for (const k of keys) { const w = k.split('|')[0]; if (w) data.earned[w] = (data.earned[w] || 0) + 1; }
  }
  let version = 1;
  const waiters = new Set();
  const mealWork = {}; // "date|meal" -> { state: "working" | "done" | "error", added?, text? } (not saved)
  let unlockedUntil = 0; // the PIN was given on the display: apps may change the calendar until then
  let flyer = null; // the latest flyer read: { state, at, events?, text? } (not saved); its photo in FLYERS
  const FLYERS = path.join(DIR, '../flyers');

  let rev = 0; // goes up with every save (what's cached from the data is good while it's the same)
  function save() {
    rev++;
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    try { if (fs.existsSync(FILE)) fs.copyFileSync(FILE, FILE + '.bak'); } catch {}
    fs.renameSync(tmp, FILE);
    changed();
  }
  function changed() {
    version++;
    const out = view();
    for (const w of waiters) w(out);
    waiters.clear();
  }

  // ---- dates (the display's own time zone) ----
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  // For a model: a time in the household's clock with its offset ("2026-11-22T13:00-05:00"); the stored UTC one
  // ("…T18:00:00.000Z") reads as 6 PM for a 1 PM practice. An all-day one is its day (an end: the last day it's on).
  const localWhen = (s, allDay, end = false) => {
    const d = new Date(s); if (!s || isNaN(d) || /^\d{4}-\d{2}-\d{2}$/.test(String(s))) return s;
    if (allDay) return dayKey(end ? new Date(d - 1) : d);
    const o = -d.getTimezoneOffset();
    return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}${o < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`;
  };
  const inLocal = (e) => (e?.start ? { ...e, start: localWhen(e.start, e.allDay), ...(e.end ? { end: localWhen(e.end, e.allDay, true) } : {}) } : e);
  const validDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T12:00:00'));
  const hhmm = (s, d) => (/^\d{1,2}:\d{2}$/.test(String(s || '')) ? String(s).padStart(5, '0') : d);
  const minutes = (s) => +s.slice(0, 2) * 60 + +s.slice(3, 5);
  function prune() { // keep two months of checkmarks and meals
    const cut = dayKey(new Date(Date.now() - 60 * DAY));
    for (const k of Object.keys(data.done)) if (k < cut) delete data.done[k];
    for (const k of Object.keys(data.skipped)) if (k < cut) delete data.skipped[k];
    for (const k of Object.keys(data.by)) if (k < cut) delete data.by[k];
    for (const k of Object.keys(data.checked)) if (k < cut) delete data.checked[k];
    for (const k of Object.keys(data.meals)) if (k < cut) delete data.meals[k];
    data.events = data.events.filter((e) => e.repeat ? !e.until || e.until >= cut : new Date(e.end || e.start) > Date.now() - 60 * DAY);
  }

  // ---- what the apps see ----
  const str = (v, n = 100) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);
  /** Objects given as one or a list (the tools' arrays of changes). */
  const objs = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).filter((x) => x && typeof x === 'object');
  /** Text that keeps its lines (a recipe's notes). */
  const keepLines = (v, n) => String(v ?? '').replace(/\r/g, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);
  const same = (a, b) => str(a).toLowerCase() === str(b).toLowerCase();
  const low = (who) => str(who, 40).toLowerCase();
  const choreKey = (c) => `${low(c.who)}|${str(c.task).toLowerCase()}`;
  const household = () => board.householdView();
  const doneOn = (c, d) => (data.done[dayKey(d)] || []).includes(choreKey(c));
  const daysBetween = (a, b) => Math.round((new Date(dayKey(b) + 'T12:00') - new Date(dayKey(a) + 'T12:00')) / DAY);
  /** Is it a day for this chore? By weekday (none: every day); every N days from a day (since); or N days after it
   *  was last done (after: the day it's done, and until it's due again, it isn't up). */
  const todayIs = (c, d = new Date()) => {
    if (c.every >= 2) {
      if (c.after) { for (let i = 1; i < c.every; i++) if (doneOn(c, new Date(d.getTime() - i * DAY))) return false; return true; }
      const n = daysBetween(c.since ? new Date(c.since + 'T12:00') : d, d);
      return n >= 0 && n % c.every === 0;
    }
    return !c.days?.length || c.days.includes(WEEKDAYS[d.getDay()]);
  };
  /** A chore that waits until done (keep): days since its last day came round undone; 0 when it isn't late. */
  function lateBy(c) {
    if (!c.keep || !(c.days?.length || (c.every >= 2 && !c.after)) || todayIs(c)) return 0;
    for (let i = 1; i <= Math.max(14, c.every || 0); i++) {
      const d = new Date(Date.now() - i * DAY);
      if ((data.done[dayKey(d)] || []).includes(choreKey(c)) || (data.skipped[dayKey(d)] || []).includes(choreKey(c))) return 0;
      if (todayIs(c, d)) return i;
    }
    return 0;
  }
  function chores() {
    const today = dayKey(), week = [...Array(7)].map((_, i) => dayKey(new Date(Date.now() - i * DAY)));
    return (household().chores || []).map((c) => {
      const late = lateBy(c), done = (data.done[today] || []).includes(choreKey(c));
      return {
      who: c.who || '', task: c.task, ...(c.days?.length && !c.every ? { days: c.days } : {}), ...(c.every ? { every: c.every, ...(c.after ? { after: true } : {}) } : {}), today: todayIs(c) || late > 0, stars: c.stars || 1,
      pic: PICS.includes(c.pic) ? c.pic : guessPic(c.task), ...(c.keep ? { keep: true } : {}), ...(late && !done ? { late } : {}),
      done: (data.done[today] || []).includes(choreKey(c)),
      ...((data.skipped[today] || []).includes(choreKey(c)) ? { skipped: true } : {}),
      ...(data.by[`${today}|${choreKey(c)}`] ? { by: data.by[`${today}|${choreKey(c)}`] } : {}),
      week: week.filter((k) => (data.done[k] || []).includes(choreKey(c))).length, // days done this past week
      };
    });
  }
  /** Days in a row each person did all their chores for the day (skipped ones don't break it; today counts once
   *  it's all done, and doesn't break it before). Days with nothing for them are passed over. */
  function streaks() {
    const out = {}, list = household().chores || [];
    for (const who of new Set(list.map((c) => c.who).filter(Boolean))) {
      const mine = list.filter((c) => same(c.who, who) && !c.after); // (after-done ones have no fixed day)
      let n = 0;
      for (let i = 0; i <= 60; i++) {
        const d = new Date(Date.now() - i * DAY), k = dayKey(d), due = mine.filter((c) => todayIs(c, d));
        if (!due.length) continue;
        const all = due.every((c) => (data.done[k] || []).includes(choreKey(c)) || (data.skipped[k] || []).includes(choreKey(c)));
        if (all) n++; else if (i > 0) break;
      }
      if (n >= 2) out[who] = n;
    }
    return out;
  }
  const stars = (who) => Math.max(0, (data.earned[low(who)] || 0) - (data.spent[low(who)] || 0));
  function starsView() {
    const names = new Set([...(household().family || []).map((f) => f.name), ...(household().chores || []).map((c) => c.who).filter(Boolean)]);
    return Object.fromEntries([...names].map((n) => [n, stars(n)]));
  }

  // Events added here can repeat; each time it comes up is one event (same id, its own start).
  function occurrences(e, from, to) {
    if (!e.repeat) return [e];
    const s = new Date(e.start), dur = new Date(e.end || e.start) - s, out = [];
    const until = e.until ? new Date(e.until + 'T23:59:59') : null, skip = new Set(e.skip || []);
    // Start near `from`, not at the first time it came up (a weekly event from years ago).
    const step = { daily: 1, weekdays: 1, weekly: 7, biweekly: 14 }[e.repeat];
    const i0 = step ? Math.max(0, Math.floor((from - s - dur) / (step * DAY)) - 1) : e.repeat === 'monthly' ? Math.max(0, Math.floor((from - s - dur) / (31 * DAY)) - 1) : e.repeat === 'yearly' ? Math.max(0, Math.floor((from - s - dur) / (366 * DAY)) - 1) : 0;
    for (let i = i0; i < i0 + 5000; i++) {
      const d = new Date(s);
      if (e.repeat === 'daily' || e.repeat === 'weekdays') d.setDate(s.getDate() + i);
      else if (e.repeat === 'weekly') d.setDate(s.getDate() + 7 * i);
      else if (e.repeat === 'biweekly') d.setDate(s.getDate() + 14 * i);
      else if (e.repeat === 'monthly') { d.setMonth(s.getMonth() + i); if (d.getDate() !== s.getDate()) continue; } // no Feb 30th
      else if (e.repeat === 'yearly') { d.setFullYear(s.getFullYear() + i); if (d.getMonth() !== s.getMonth()) continue; }
      if (d >= to || (until && d > until)) break;
      if (e.repeat === 'weekdays' && (d.getDay() === 0 || d.getDay() === 6)) continue;
      if (d.getTime() + dur < from || skip.has(dayKey(d))) continue;
      out.push({ ...e, start: d.toISOString(), end: new Date(d.getTime() + dur).toISOString(), date: dayKey(d) });
    }
    return out;
  }
  let localCache = null; // events added here, expanded: kept while the data and the minute are the same
  function events() {
    const minute = Math.floor(Date.now() / 60e3), from = (minute * 60e3) - 35 * DAY, to = (minute * 60e3) + 70 * DAY; // enough for a month view either way
    if (localCache?.rev !== rev || localCache.minute !== minute) localCache = { rev, minute, list: data.events.flatMap((e) => occurrences(e, from, to)).map((e) => ({ ...e, local: true })) };
    const local = localCache.list;
    // A countdown is on that one event; once it's over it's gone (a weekly class counting down again every week isn't
    // worth the space: the user, "who cares?").
    const cd = new Set(data.countdowns);
    const counted = (uid) => cd.has(uid);
    const all = data.settings.remind ?? null;
    const remindOf = (e) => { if (e.allDay || e.fromApp) return null; /* (an app's events: read-only, no chime) */ const m = e.local ? e.remind ?? all : e.uid && data.reminds[e.uid] !== undefined ? data.reminds[e.uid] : all; return m == null || m < 0 ? null : m; };
    return [...board.calendarEvents().map((e) => (e.uid && counted(e.uid) ? { ...e, countdown: true } : e)), ...local, ...appEvents()]
      .filter((e) => new Date(e.end || e.start) > from && new Date(e.start) < to)
      .map((e) => { // remind: its own minutes (the household's when absent); remindAt: when it's due
        const own = !e.local && e.uid && data.reminds[e.uid] !== undefined ? { remind: data.reminds[e.uid] } : {}, m = remindOf(e);
        return m == null ? { ...e, ...own } : { ...e, ...own, remindAt: new Date(new Date(e.start).getTime() - m * 60e3).toISOString(), remindMin: m };
      })
      .sort((a, b) => new Date(a.start) - new Date(b.start));
  }
  const remindKey = (e) => `${e.uid || e.id}|${e.start}`;
  /** The reminders due now: from their time until ten minutes after the start (or the end, if sooner), unless put away. */
  function reminders(now = Date.now()) {
    const away = new Set(data.reminded);
    return events().filter((e) => e.remindAt && new Date(e.remindAt) <= now && now < Math.min(new Date(e.start).getTime() + 10 * 60e3, new Date(e.end || e.start).getTime() + 60e3) && !away.has(remindKey(e)))
      .map((e) => ({ key: remindKey(e), title: e.title, start: e.start, who: [e.who, ...(e.also || [])].filter(Boolean).join(' & ') || null, ...(e.place ? { place: e.place } : {}) }));
  }
  const albums = albumSync({ photosDir: PHOTOS, data, save: () => save(), log: (m) => console.log(m) });
  let photoCache = null; // the folder's listing, kept while the folder hasn't changed
  function photos() {
    try {
      const at = fs.statSync(PHOTOS).mtimeMs;
      if (photoCache?.at === at) return photoCache.list;
      const list = fs.readdirSync(PHOTOS).filter((f) => PHOTO.test(f) && !f.startsWith('.'))
        .map((f) => ({ name: f, at: fs.statSync(path.join(PHOTOS, f)).mtimeMs })).sort((a, b) => b.at - a.at).map((p) => p.name);
      photoCache = { at, list };
      return list;
    } catch { return []; }
  }
  const activeNow = (c, d = new Date()) => {
    if (c.days?.length && !c.days.includes(WEEKDAYS[d.getDay()])) return false;
    const m = d.getHours() * 60 + d.getMinutes(), a = minutes(c.from), b = minutes(c.to);
    return a <= b ? m >= a && m < b : m >= a || m < b;
  };
  function checklists() {
    const today = data.checked[dayKey()] || [];
    return data.checklists.map((c) => ({ ...c, now: activeNow(c), done: today.filter((k) => k.startsWith(c.id + '|')).map((k) => k.slice(c.id.length + 1)) }));
  }
  function favorites() {
    const pinned = data.favorites.map((t) => ({ text: t, pinned: true }));
    const often = Object.values(data.mealCounts).filter((m) => !data.favorites.some((f) => same(f, m.text)))
      .sort((a, b) => b.n - a.n || String(b.last).localeCompare(String(a.last))).map((m) => ({ text: m.text, pinned: false }));
    return [...pinned, ...often].slice(0, 16);
  }
  const NIGHT = { from: '21:30', to: '06:30' };
  function view() {
    const h = household();
    return {
      v: version, today: dayKey(), family: (h.family || []).map((f, i) => ({ name: f.name, note: f.note || '', color: f.color || PEOPLE[i % PEOPLE.length] })),
      streaks: streaks(), lists: data.lists.map((l) => ({ ...l, byAisle: l.byAisle ?? l.id === 'groceries', items: l.items.map((i) => ({ ...i, aisle: aisleOf(i.text) })) })), aisles: [...AISLES.map(([a]) => a), 'Other'], chores: chores(), stars: starsView(), rewards: data.rewards, asks: data.asks, got: data.got.slice(0, 5),
      checklists: checklists(), meals: data.meals, favorites: favorites(), mealWork, recipes: data.recipes, recipeFind, mealSlots: data.mealSlots,
      events: events(), dayNotes: (() => { try { return notes ? notes.byDay() : {}; } catch { return {}; } })(), fromApps: (() => { try { return notes ? notes.apps() : []; } catch { return []; } })(), photos: photos(), calendars: (h.calendars || []).length,
      things: (() => { try { return things ? things.strip({ events: events(), reminders: reminders() }) : []; } catch (e) { console.error('[things]', e); return []; } })(), // (things.js: the strip on Today)
      night: data.settings.night === false ? null : data.settings.night || NIGHT,
      reminders: reminders(), flyer, calendarLock: !!data.settings.calendarLock, unlockedUntil: unlockedUntil > Date.now() ? unlockedUntil : 0,
      removed: removedPhotos(), albums: data.albums, linked: albums.view(), captions: data.captions, slideshow: data.settings.slideshow || null, screensaver: screensaver(), remind: data.settings.remind ?? null, remindAloud: !!data.settings.remindAloud,
      ai: !['off', 'none'].includes(agentName()) && !!currentAgent,
    };
  }

  // ---- changes: one place for the apps (HTTP) and the assistant (tools) ----
  function findList(name, create) {
    const n = str(name, 40) || 'Groceries';
    let l = data.lists.find((x) => same(x.id, n) || same(x.name, n) || same(x.name.replace(/s$/i, ''), n.replace(/s$/i, '')));
    if (!l && create) { l = { id: n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'list-' + crypto.randomUUID().slice(0, 4), name: n[0].toUpperCase() + n.slice(1), items: [] }; data.lists.push(l); }
    return l;
  }
  const item = (l, ref) => l.items.find((i) => i.id === ref) || l.items.find((i) => same(i.text, ref)) ||
    l.items.find((i) => str(i.text).toLowerCase().includes(str(ref).toLowerCase()) && str(ref).length > 2);
  const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).map((x) => str(x)).filter(Boolean);

  function changeList(a) {
    const l = findList(a.list, arr(a.add).length > 0 || a.create);
    if (!l) return { error: `No list "${str(a.list)}". Lists: ${data.lists.map((x) => x.name).join(', ')}.` };
    const did = [];
    if (a.byAisle !== undefined) { l.byAisle = !!a.byAisle; did.push(a.byAisle ? 'sorted by aisle' : 'in the order added'); }
    for (const t of arr(a.add)) {
      const was = l.items.find((i) => same(i.text, t));
      if (was) { if (was.done) { was.done = false; did.push(`put ${was.text} back on`); } else did.push(`${was.text} was already on it`); continue; }
      l.items.push({ id: crypto.randomUUID().slice(0, 8), text: t[0].toUpperCase() + t.slice(1), done: false, who: str(a.who, 40) || null, at: Date.now() });
      did.push(`added ${t}`);
    }
    for (const [refs, done] of [[arr(a.check), true], [arr(a.uncheck), false]]) for (const r of refs) {
      const i = item(l, r); if (!i) { did.push(`no "${r}" on it`); continue; }
      i.done = done; i.doneAt = done ? Date.now() : null; did.push(`${done ? 'checked off' : 'unchecked'} ${i.text}`);
    }
    for (const r of arr(a.remove)) {
      const i = item(l, r); if (!i) { did.push(`no "${r}" on it`); continue; }
      l.items = l.items.filter((x) => x !== i); did.push(`removed ${i.text}`);
    }
    for (const e of objs(a.edit)) {
      const i = item(l, e?.item ?? e?.id); if (!i) { did.push(`no "${str(e?.item ?? e?.id)}" on it`); continue; }
      const t = str(e.text, 200).trim(); if (t) i.text = t[0].toUpperCase() + t.slice(1);
      if ('who' in e) i.who = str(e.who, 40) || null;
      did.push(`changed ${i.text}`);
    }
    if (a.clearChecked) { const n = l.items.filter((i) => i.done).length; l.items = l.items.filter((i) => !i.done); did.push(`cleared ${n} checked`); }
    if (a.rename) { const n = str(a.rename, 40).trim(); if (n && !data.lists.some((x) => x !== l && same(x.name, n))) l.name = n; else if (n) did.push(`there's already a list called ${n}`); }
    if (a.deleteList) data.lists = data.lists.filter((x) => x !== l);
    l.items = l.items.slice(-200);
    save();
    return { ok: true, list: l.name, did };
  }

  function saveChores(list) { board.saveHousehold({ chores: list }, { quiet: true }); }
  function changeChores(a) {
    const did = [];
    let list = [...(household().chores || [])];
    const match = (c, x) => same(c.task, x.task) && (!x.who || same(c.who, x.who));
    const fuzzy = (x) => list.find((c) => match(c, x)) || list.find((c) => (!x.who || same(c.who, x.who)) && str(c.task).toLowerCase().includes(str(x.task).toLowerCase()) && str(x.task).length > 2);
    const adds = (a.add ? [].concat(a.add) : []).filter((x) => str(x?.task));
    const removes = (a.remove ? [].concat(a.remove) : []).filter((x) => str(x?.task));
    const updates = (a.update ? [].concat(a.update) : []).filter((x) => str(x?.task));
    const dayList = (v) => { const d = (v || []).map((x) => String(x).slice(0, 3).toLowerCase()).filter((x) => WEEKDAYS.includes(x)); return d.length && d.length < 7 ? d : null; };
    const starsOf = (v) => { const n = Math.round(Number(v)); return n >= 1 && n <= 10 ? n : null; };
    /** every: N days (2 to 90), from today, or after it's done (after); 0/null: by weekday again. */
    const setEvery = (c, every, after) => {
      const n = Math.round(Number(every));
      if (n >= 2 && n <= 90) { c.every = n; delete c.days; if (after) { c.after = true; delete c.since; } else { delete c.after; c.since = dayKey(); } }
      else { delete c.every; delete c.after; delete c.since; }
    };
    if (adds.length || removes.length || updates.length) {
      for (const x of adds) {
        if (list.some((c) => match(c, x) && same(c.who, x.who))) { did.push(`${x.task} was already there`); continue; }
        const days = dayList(x.days), n = starsOf(x.stars);
        const c = { who: str(x.who, 40), task: str(x.task), ...(days ? { days } : {}), ...(n > 1 ? { stars: n } : {}), ...(PICS.includes(x.pic) ? { pic: x.pic } : {}), ...(x.keep ? { keep: true } : {}) };
        if (x.every) setEvery(c, x.every, x.after);
        list.push(c); did.push(`added ${x.task}${x.who ? ` for ${x.who}` : ''}`);
      }
      // Removing matches exactly (who and task) first; a near match only when it's the only one.
      for (const x of removes) {
        const exact = list.filter((c) => match(c, x)), c = exact.length === 1 ? exact[0] : exact.length ? null : fuzzy(x);
        if (!c) { did.push(exact.length ? `which "${x.task}"? say whose` : `no chore "${x.task}"`); continue; }
        list = list.filter((y) => y !== c); did.push(`removed ${c.task}`);
      }
      // Changing one: its words, whose, which days, how many stars. Today's tick and this week's go with it.
      for (const x of updates) {
        const c = list.find((y) => match(y, x)); if (!c) { did.push(`no chore "${x.task}"`); continue; }
        const to = x.to || {}, was = choreKey(c);
        if (str(to.task)) c.task = str(to.task);
        if (to.who !== undefined) c.who = str(to.who, 40);
        if (to.days !== undefined) { const d = dayList(to.days); if (d) c.days = d; else delete c.days; }
        if (to.stars !== undefined) c.stars = starsOf(to.stars) || 1; // (1 is the usual: not kept)
        if (to.pic !== undefined) { if (PICS.includes(to.pic)) c.pic = to.pic; else delete c.pic; }
        if (to.keep !== undefined) { if (to.keep) c.keep = true; else delete c.keep; }
        if (to.every !== undefined) setEvery(c, to.every, to.after ?? c.after);
        else if (to.after !== undefined && c.every) setEvery(c, c.every, to.after);
        if (to.every === undefined && to.days !== undefined && dayList(to.days)) { delete c.every; delete c.after; delete c.since; }
        const now = choreKey(c);
        if (now !== was) for (const m of [data.done, data.skipped]) for (const k of Object.keys(m)) m[k] = m[k].map((y) => (y === was ? now : y));
        did.push(`changed ${c.task}`);
      }
      saveChores(list);
    }
    // Skipped for a day (away, sick): not left to do, no stars, and it doesn't count against anyone.
    for (const [refs, value] of [[a.skip, true], [a.unskip, false]]) for (const x of (refs ? [].concat(refs) : []).filter((y) => str(y?.task))) {
      const c = fuzzy(x); if (!c) { did.push(`no chore "${x.task}"`); continue; }
      const day = validDay(x.date) ? x.date : dayKey(), set = new Set(data.skipped[day] || []);
      value ? set.add(choreKey(c)) : set.delete(choreKey(c)); data.skipped[day] = [...set];
      did.push(`${value ? 'skipped' : 'back on'}: ${c.task}`);
    }
    for (const [refs, value] of [[a.done, true], [a.undone, false]]) for (const x of (refs ? [].concat(refs) : []).filter((y) => str(y?.task))) {
      const c = fuzzy(x); if (!c) { did.push(`no chore "${x.task}"${x.who ? ` for ${x.who}` : ''}`); continue; }
      const day = validDay(x.date) ? x.date : dayKey(), k = choreKey(c);
      const set = new Set(data.done[day] || []), had = set.has(k);
      value ? set.add(k) : set.delete(k); data.done[day] = [...set];
      // Its stars go to whose it is; a chore anyone could do earns them for whoever did it (x.by).
      const byKey = `${day}|${k}`, who = c.who || (value ? str(x.by, 40) : data.by[byKey]) || '', w = low(who);
      if (!c.who) { if (value && w) data.by[byKey] = who; else if (!value) delete data.by[byKey]; }
      if (w && had !== value) data.earned[w] = Math.max(0, (data.earned[w] || 0) + (value ? 1 : -1) * (c.stars || 1));
      if (value) data.skipped[day] = (data.skipped[day] || []).filter((y) => y !== k);
      did.push(`${value ? 'done' : 'not done'}: ${who ? who + ' ' : ''}${c.task}`);
    }
    prune(); save();
    return { ok: true, did };
  }

  // ---- rewards: stars from chores, spent on something the kid chose; someone says yes ----
  const shellCfg = () => { try { const d = JSON.parse(fs.readFileSync(process.env.DEVICE_MCP_CONFIG, 'utf8')).mcpServers.device; return { base: d.url.replace(/\/mcp$/, ''), auth: d.headers.Authorization }; } catch { return null; } };
  async function shell(p, b, ms = 3000) {
    const s = shellCfg();
    if (!s) return null;
    try { const r = await fetch(s.base + p, { method: 'POST', headers: { authorization: s.auth, 'content-type': 'application/json' }, body: JSON.stringify(b), signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; }
  }
  function give(ask) {
    const w = low(ask.who);
    data.spent[w] = (data.spent[w] || 0) + ask.stars;
    data.got.unshift({ who: ask.who, title: ask.title, stars: ask.stars, at: Date.now() }); data.got = data.got.slice(0, 30);
    data.asks = data.asks.filter((x) => x.id !== ask.id);
  }
  async function askGrownUp(ask) {
    // The shell's "Is this OK?" card, with the PIN when there is one. Nothing the assistant says answers it.
    const r = await shell('/approve', { title: `${ask.who}: ${ask.title}?`, detail: `For ${ask.stars} stars.`, pin: true, yes: 'Give it' }, 100_000);
    if (!data.asks.some((x) => x.id === ask.id)) return;
    // No card on this display (device access off): the Chores app shows the ask, but only a no counts from there. No answer
    // in time (nobody came): it's dropped, and the kid asks again; it never falls to a button anyone can tap.
    if (r?.why) { ask.manual = true; save(); return; }
    if (r == null) { data.asks = data.asks.filter((x) => x.id !== ask.id); save(); return; }
    if (r.yes && stars(ask.who) >= ask.stars) give(ask); else data.asks = data.asks.filter((x) => x.id !== ask.id);
    save();
  }
  /**
   * Adding or removing rewards (what stars buy) needs a yes on the display's card, with the PIN, as
   * giving one does: a kid could otherwise make "Ice cream: 1 star", in an app or by asking the assistant. With no
   * display around (a computer running the bridge) it just happens; with no card possible (device access off), too.
   */
  function rewardSetup(a, fromApp) {
    const adds = (a.add ? [].concat(a.add) : []).filter((y) => str(y?.title)), removes = arr(a.remove);
    if (!adds.length && !removes.length) return [];
    if (!shellCfg()) return setUpRewards(adds, removes);
    const what = [...adds.map((x) => `${str(x.title, 60)} for ${Math.max(1, Math.min(500, Math.round(Number(x.stars) || 10)))} stars`), ...removes.map((x) => `take off ${data.rewards.find((y) => y.id === x || same(y.title, x))?.title || x}`)].join('; ');
    shell('/approve', { title: 'Change the rewards?', detail: what, pin: true, yes: 'Change' }, 100_000).then((r) => {
      if (r?.why || r?.yes) { setUpRewards(adds, removes); save(); }
    });
    return [`asked someone to OK it on the display (${what})`];
  }
  function setUpRewards(adds, removes) {
    const did = [];
    for (const x of adds) {
      const n = Math.max(1, Math.min(500, Math.round(Number(x.stars) || 10)));
      const was = data.rewards.find((r) => same(r.title, x.title) && same(r.who || '', x.who || ''));
      if (was) { was.stars = n; did.push(`${was.title} is now ${n} stars`); continue; }
      data.rewards.push({ id: 'r-' + crypto.randomUUID().slice(0, 6), title: str(x.title, 60), stars: n, ...(str(x.who) ? { who: str(x.who, 40) } : {}) });
      did.push(`added ${x.title} for ${n} star${n === 1 ? "" : "s"}`);
    }
    for (const ref of removes) {
      const r = data.rewards.find((y) => y.id === ref || same(y.title, ref));
      if (!r) { did.push(`no reward "${ref}"`); continue; }
      data.rewards = data.rewards.filter((y) => y !== r); data.asks = data.asks.filter((y) => y.reward !== r.id); did.push(`removed ${r.title}`);
    }
    return did;
  }
  function changeRewards(a, { fromApp = false } = {}) {
    const did = rewardSetup(a, fromApp);
    if (fromApp && a.redeem) {
      const r = data.rewards.find((y) => y.id === a.redeem.id), who = str(a.redeem.who, 40);
      if (!r || !who) return { error: 'Which reward, for whom?' };
      if (stars(who) < r.stars) return { error: `${who} has ${stars(who)} stars; ${r.title} needs ${r.stars}.` };
      if (!data.asks.some((x) => x.reward === r.id && same(x.who, who))) {
        const ask = { id: 'a-' + crypto.randomUUID().slice(0, 6), who, reward: r.id, title: r.title, stars: r.stars, at: Date.now() };
        data.asks.push(ask); askGrownUp(ask);
      }
      did.push(`asked for ${r.title}`);
    }
    if (fromApp && a.answer) { // only where the display has no "Is this OK?" card of its own: an app can say no, never yes
      const ask = data.asks.find((x) => x.id === a.answer.id);
      if (ask?.manual && !a.answer.yes) data.asks = data.asks.filter((x) => x !== ask);
      else if (ask?.manual) did.push('someone says yes on the display (its own card, with the PIN)');
    }
    save();
    return { ok: true, did };
  }

  // ---- checklists (morning, bedtime): a few steps with pictures, shown during their hours ----
  function steps(list) {
    return [].concat(list || []).map((s) => (typeof s === 'string' ? { text: s } : s)).filter((s) => str(s?.text))
      .map((s) => ({ text: str(s.text, 40), pic: PICS.includes(s.pic) ? s.pic : guessPic(s.text) })).slice(0, 10);
  }
  function guessPic(t) {
    const s = str(t).toLowerCase();
    const hit = [['plant', /plant|weed|garden|flower|lawn|mow/], ['trash', /trash|garbage|recycl|bins?\b|compost/], ['laundry', /laundry|fold|socks|hamper/],
      ['broom', /sweep|vacuum|mop|floor|broom|dust/], ['plate', /dish|dishwasher/], ['teeth', /teeth|brush/], ['shirt', /dress|clothes|shirt|pajama|pyjama|pj/], ['shoes', /shoe|sock/], ['backpack', /backpack|bag|school/],
      ['bed', /bed|sleep|lights/], ['bath', /bath|shower|wash up/], ['book', /read|book|homework/], ['plate', /breakfast|eat|dinner|lunch|table/],
      ['hands', /hands|wash/], ['hair', /hair|comb/], ['toys', /toy|tidy|clean up|pick up/], ['cup', /water|drink|milk/], ['coat', /coat|jacket/],
      ['pet', /cat|dog|pet|fish/], ['sun', /wake|up|morning/], ['moon', /night/]].find(([, re]) => re.test(s));
    return hit ? hit[0] : 'star';
  }
  const findChecklist = (ref) => data.checklists.find((c) => c.id === ref || same(c.name, ref));
  function checklistFields(x, into = {}) {
    if (x.name != null) into.name = str(x.name, 30) || into.name || 'Routine';
    if (x.who != null) into.who = arr(x.who).map((w) => str(w, 40));
    if (x.from != null) into.from = hhmm(x.from, into.from || '06:30');
    if (x.to != null) into.to = hhmm(x.to, into.to || '09:00');
    if (x.days != null) { const d = arr(x.days).map((y) => y.slice(0, 3).toLowerCase()).filter((y) => WEEKDAYS.includes(y)); if (d.length && d.length < 7) into.days = d; else delete into.days; }
    if (x.steps != null) into.steps = steps(x.steps);
    return into;
  }
  function changeChecklists(a) {
    const did = [];
    for (const x of (a.add ? [].concat(a.add) : []).filter((y) => str(y?.name))) {
      if (findChecklist(x.name)) { did.push(`${x.name} is already there (update it instead)`); continue; }
      const c = checklistFields({ from: '06:30', to: '09:00', who: [], steps: [], ...x }, { id: 'c-' + crypto.randomUUID().slice(0, 6) });
      data.checklists.push(c); did.push(`added ${c.name}`);
    }
    for (const x of (a.update ? [].concat(a.update) : [])) {
      const c = findChecklist(x?.id || x?.name); if (!c) { did.push(`no routine "${x?.id || x?.name}"`); continue; }
      checklistFields({ ...x, name: x.rename ?? (x.id ? x.name : undefined) }, c); did.push(`changed ${c.name}`);
    }
    for (const ref of arr(a.remove)) { const c = findChecklist(ref); if (!c) { did.push(`no routine "${ref}"`); continue; } data.checklists = data.checklists.filter((y) => y !== c); did.push(`removed ${c.name}`); }
    for (const x of (a.check ? [].concat(a.check) : [])) {
      const c = findChecklist(x?.id || x?.name); const step = c?.steps.find((s) => same(s.text, x.step));
      if (!c || !step) { did.push(`no step "${x?.step}"`); continue; }
      const day = dayKey(), k = `${c.id}|${step.text}|${low(x.who)}`, set = new Set(data.checked[day] || []);
      x.done === false ? set.delete(k) : set.add(k); data.checked[day] = [...set];
      did.push(`${x.done === false ? 'unchecked' : 'checked'} ${step.text}${x.who ? ` for ${x.who}` : ''}`);
    }
    prune(); save();
    return { ok: true, did };
  }

  // ---- meals ----
  function setMeals(list) {
    const did = [];
    for (const m of [].concat(list || [])) {
      if (!validDay(m?.date)) { did.push(`bad date ${m?.date}`); continue; }
      const meal = str(m.meal || 'dinner', 20).toLowerCase(), text = str(m.text, 80);
      const day = { ...(data.meals[m.date] || {}) };
      if (text && !same(day[meal], text)) { // what they eat often comes back as a one-tap choice
        const k = text.toLowerCase(), c = data.mealCounts[k];
        data.mealCounts[k] = { text, n: (c?.n || 0) + 1, last: m.date };
        const keys = Object.keys(data.mealCounts); if (keys.length > 80) delete data.mealCounts[keys.sort((a, b) => data.mealCounts[a].n - data.mealCounts[b].n)[0]];
      }
      if (text) day[meal] = text; else delete day[meal];
      if (Object.keys(day).length) data.meals[m.date] = day; else delete data.meals[m.date];
      did.push(text ? `${m.date} ${meal}: ${text}` : `cleared ${m.date} ${meal}`);
    }
    prune(); save();
    return { ok: true, did };
  }
  function favorite(text, value = true) {
    const t = str(text, 80); if (!t) return { error: 'which meal?' };
    data.favorites = data.favorites.filter((f) => !same(f, t));
    if (value) data.favorites.unshift(t); else delete data.mealCounts[t.toLowerCase()]; // unpinning a suggestion forgets it
    data.favorites = data.favorites.slice(0, 16);
    save(); return { ok: true };
  }
  const SLOTS = ['breakfast', 'lunch', 'dinner'];
  function setSlots(list) {
    const s = SLOTS.filter((x) => arr(list).some((y) => same(y, x)));
    data.mealSlots = s.length ? s : ['dinner']; save(); return { ok: true, slots: data.mealSlots };
  }
  /** A meal's recipe: a link and/or notes (ingredients, steps); both empty takes it out of the box. */
  function setRecipe(r) {
    const text = str(r?.meal, 80).trim(); if (!text) return { error: 'which meal?' };
    const k = text.toLowerCase(), link = str(r.link, 400).trim(), notes = keepLines(r.notes, 4000);
    if (link && !/^https?:\/\//i.test(link)) return { error: 'A link starts with http:// or https://' };
    if (!link && !notes) { delete data.recipes[k]; save(); return { ok: true, did: [`took ${text}'s recipe out`] }; }
    const was = data.recipes[k], unchanged = !!was && cookSource(was) === cookSource({ link, notes });
    // Its cooking steps (cooking.js) stay while it's the same recipe; a changed one is read again.
    data.recipes[k] = { text: was?.text || text, ...(link ? { link } : {}), ...(notes ? { notes } : {}), at: Date.now(),
      ...(unchanged && was.cook ? { cook: was.cook } : {}), ...(unchanged && was.video ? { video: was.video } : {}), ...(unchanged && was.image ? { image: was.image, picsAt: was.picsAt } : {}), ...(r.video && youtube(r.video) ? { video: youtube(r.video) } : !unchanged && youtube(link) ? { video: youtube(link) } : {}) };
    const keys = Object.keys(data.recipes);
    if (keys.length > 150) delete data.recipes[keys.sort((a, b) => data.recipes[a].at - data.recipes[b].at)[0]];
    save();
    if (!unchanged && !r.quiet && !noAssistant('')) setTimeout(() => prepareCook(text), 50).unref?.();
    return { ok: true, did: [`saved the recipe for ${text}`] };
  }
  /** A recipe turned into cooking steps, once (cooking.js), kept with it as {cook}; a link only is read first (watch
   *  mealWork["cook|meal"]). Again with force, else only when it has none or the recipe changed since. */
  const COOK_V = 2; // the shape of the steps (2: titles, parts, waiting, ahead, full detail)
  function prepareCook(meal, { force = false } = {}) {
    const text = str(meal, 80).trim(), k = text.toLowerCase(), key = `cook|${k}`, r = data.recipes[k];
    if (!r) return { error: `There's no recipe for ${text || 'that'} yet.` };
    // (steps made before they had titles, parts and their full detail are made again, once: COOK_V)
    if (!force && r.cook && r.cook.for === cookSource(r) && r.cook.v === COOK_V) { if (r.link && !r.picsAt) pictures(k); if (!r.cook.minutes && !r.timeAt) howLong(k); return { ok: true, ready: true }; }
    { const no = noAssistant('Getting a recipe ready to cook'); if (no) return { error: no }; }
    if (mealWork[key]?.state === 'working') return { ok: true };
    mealWork[key] = { state: 'working' }; changed();
    (async () => {
      try {
        // notes written from its own steps (a link only) aren't the recipe: its page is
        const ownNotes = r.link && r.cook && r.notes === cookAsNotes(r.cook).slice(0, 4000);
        let source = ownNotes ? '' : r.notes || '', video = r.video || null, page = null;
        // a link is read for the recipe (when it's all there is) and for its pictures: the dish and its steps' own photos
        if (!source && r.link) { page = await readRecipeLink(r.link); source = page.text; }
        else if (r.link) page = await readRecipeLink(r.link).catch(() => null);
        video ||= page?.video || null;
        if (!source.trim()) throw new Error('That recipe has nothing in it to cook from.');
        let cook = parseCook(await answer(cookPrompt(r.text, source, page?.links || []), COOK_SYSTEM));
        if (page?.minutes) cook.minutes = page.minutes; // the page's own total time over the model's estimate
        // What it builds on ("make the Classic Pizza Sauce", linked on its page): each of those recipes read and made into
        // steps on its own (one answer for all of them takes longer than the cloud waits), as a part, in place of the step
        // that only says to make it (makes), so nothing is left as "prepare the sauce" with no way to.
        if (cook.needs?.length) cook = withNeeds(cook, (await Promise.all(cook.needs.slice(0, 3).map(async (x) => {
          try { const p = await readRecipeLink(x.url, { timeoutMs: 8000 }); const c = parseCook(await answer(cookPrompt(x.name, `${p.text.slice(0, 12000)}\n\nThis is made for ${r.text}, whose own steps go on from where they use it: write only the steps that make the ${x.name} itself, and leave out what comes after it is ready (using it, baking, serving).`), COOK_SYSTEM)); if (p.minutes) c.minutes = p.minutes; return { name: x.name, cook: c }; } catch { return null; }
        }))).filter(Boolean));
        cook.steps = cook.steps.map(({ makes, ...st }) => st);
        cook = withPictures(cook, page?.stepPics); delete cook.needs;
        const now = data.recipes[k]; if (!now) throw new Error('That recipe was taken out.');
        if (!now.notes || ownNotes) now.notes = cookAsNotes(cook).slice(0, 4000); // a link only: the Meals app shows it too
        if (video && !now.video) now.video = video;
        if (page?.image) now.image = page.image;
        if (r.link) now.picsAt = Date.now();
        now.cook = { ...cook, v: COOK_V, for: cookSource(now), at: Date.now() };
        save();
        mealWork[key] = { state: 'done' };
      } catch (e) { mealWork[key] = { state: 'error', text: String(e.message || e).slice(0, 160) }; }
      changed();
      setTimeout(() => { if (mealWork[key]?.state !== 'working') { delete mealWork[key]; changed(); } }, 60e3).unref?.();
    })();
    return { ok: true };
  }
  /** Steps made before they said how long the recipe takes: its page's total time, else the text model's estimate, once. */
  function howLong(k) {
    const r = data.recipes[k]; if (!r?.cook || r.timeAt) return;
    r.timeAt = Date.now();
    (async () => {
      let m = r.link ? (await readRecipeLink(r.link).catch(() => null))?.minutes : null;
      if (!m && !noAssistant('')) m = Math.round(Number(String(await answer(`How many minutes does this recipe take, start to finish? Reply with only a number.\n\n${cookAsNotes(r.cook).slice(0, 6000)}`, 'Reply with only a number.')).match(/\d+/)?.[0]));
      const now = data.recipes[k];
      if (now?.cook && m > 0 && m < 10000) { now.cook.minutes = m; save(); changed(); }
    })().catch(() => {});
  }
  /** The recipes it builds on put in: each one's steps (as its part) where a step says only to make it, else before the
   *  rest; their ingredients after its own. */
  function withNeeds(cook, subs) {
    if (!subs.length) return cook;
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    const steps = (sub) => sub.cook.steps.map(({ makes, ...st }) => ({ ...st, part: sub.name }));
    const placed = new Set(), out = [];
    for (const st of cook.steps) {
      const sub = st.makes && subs.find((x) => same(x.name, st.makes) && !placed.has(x));
      if (sub) { placed.add(sub); out.push(...steps(sub)); } else out.push(st);
    }
    const rest = subs.filter((x) => !placed.has(x)).flatMap(steps);
    const more = subs.flatMap((x) => x.cook.ingredients.map((i) => ({ ...i, part: x.name }))); // (listed under its name)
    const minutes = (cook.minutes || 0) + subs.reduce((n, x) => n + (x.cook.minutes || 0), 0); // (its dough's rise too)
    return { ...cook, ...(minutes ? { minutes } : {}), steps: [...rest, ...out].slice(0, 80), ingredients: [...more, ...cook.ingredients].slice(0, 80) };
  }
  /** A recipe made into steps before pictures were kept: its page read once more for the dish and step photos (no model). */
  function pictures(k) {
    const r = data.recipes[k]; if (!r?.link || r.picsAt) return;
    r.picsAt = Date.now();
    readRecipeLink(r.link).then((page) => {
      const now = data.recipes[k]; if (!now?.cook) return;
      if (page.image) now.image = page.image;
      now.cook = withPictures({ ...now.cook, steps: now.cook.steps.map((st) => ({ ...st })) }, page.stepPics);
      save();
    }, () => {});
  }
  /** Recipes found on the web for a few words ("a good weeknight chili"): the household's text model searches with
   *  OpenAI's web search (the service they chose), then each page is read here for its picture, time and whether it
   *  really holds a recipe. Shown on the Recipes tab (recipeFind: {query, state, results: [{title, url, site, image,
   *  minutes, about}], text?}); not kept. Saving one is addRecipeLink with its title. */
  let recipeFind = null;
  function findRecipes(query) {
    const q = str(query, 200);
    if (!q) return { error: 'Find what?' };
    { const no = noAssistant('Finding recipes'); if (no) return { error: no }; }
    const mine = recipeFind = { query: q, state: 'working', at: Date.now() }; changed();
    (async () => {
      try {
        const found = parseFound(await answer(findPrompt(q), FIND_SYSTEM, [], { webSearch: true }));
        if (!found.length) throw new Error(`No recipes found for ${q}.`);
        // each page, read here (5 s each, all at once): its own picture and time; one with no recipe in it goes last
        const read = await Promise.all(found.map((f) => readRecipeLink(f.url, { timeoutMs: 5000 }).then((p) => ({ ...f,
          title: f.title || p.name, ...(p.image ? { image: p.image } : {}), ...(p.minutes ? { minutes: p.minutes } : {}), ok: p.recipe !== false }), () => ({ ...f, ok: false }))));
        const results = [...read.filter((r) => r.ok), ...read.filter((r) => !r.ok)].slice(0, 4).map(({ ok, ...r }) => r);
        if (recipeFind === mine) recipeFind = { query: q, state: 'done', at: mine.at, results };
      } catch (e) { if (recipeFind === mine) recipeFind = { query: q, state: 'error', at: mine.at, text: String(e.message || e).slice(0, 160) }; }
      changed();
    })();
    return { ok: true };
  }
  /** A link shared from a phone (or typed): the page is read for its name, saved as that meal's recipe, and its steps
   *  made (mealWork["link"] while it's read; then mealWork["cook|meal"]). */
  function addRecipeLink({ link, meal = '' } = {}) {
    let l = str(link, 400); if (l && !/^https?:\/\//i.test(l)) l = 'https://' + l;
    try { if (!/^https?:$/.test(new URL(l).protocol)) throw 0; } catch { return { error: 'That isn’t a link.' }; }
    { const no = noAssistant('Adding a recipe from a link'); if (no) return { error: no }; }
    if (str(meal)) { const x = setRecipe({ meal, link: l, quiet: true }); if (x.error) return x; return prepareCook(meal); }
    if (mealWork.link?.state === 'working') return { error: 'Still reading the last link.' };
    mealWork.link = { state: 'working', link: l }; changed();
    (async () => {
      try {
        const page = await readRecipeLink(l);
        const name = str(page.name, 60) || new URL(l).hostname.replace(/^www\./, '');
        setRecipe({ meal: name, link: l, notes: page.text.length < 4000 && /\bIngredients\b/.test(page.text) ? page.text : '', video: page.video || '', quiet: true });
        mealWork.link = { state: 'done', meal: name };
        changed(); prepareCook(name);
      } catch (e) { mealWork.link = { state: 'error', text: String(e.message || e).slice(0, 160) }; changed(); }
      setTimeout(() => { if (mealWork.link?.state !== 'working') { delete mealWork.link; changed(); } }, 60e3).unref?.();
    })();
    return { ok: true };
  }
  /** One answer from the assistant, with no tools (the Meals app's buttons; a flyer or recipe photo in images). */
  async function answer(prompt, sys, images = [], { webSearch = false } = {}) {
    const agent = await currentAgent();
    if (agent.answer) return String(await agent.answer({ instructions: sys, prompt, images, webSearch })); // the cloud's text model (agents/cloud.js)
    if (webSearch) throw new Error('Searching the web needs the cloud assistant.');
    if (!agent.chat) throw new Error('no assistant');
    const go = (run) => agent.chat({ prompt, cwd: WORK, systemPrompt: sys, onEvent: () => {}, resume: null, doorToken: run?.token, route: false });
    const r = door ? (await door.during({ by: 'assistant' }, go)).result : await go(null);
    if (!r?.ok) throw new Error(r?.text || 'no answer');
    return String(r.text);
  }
  /** The latest photo sent (a flyer or a recipe), for the model to look at. */
  const photoBytes = () => { const f = latestFlyer(); if (!f) return []; const ext = path.extname(f).slice(1).toLowerCase();
    return [{ bytes: fs.readFileSync(path.join(FLYERS, f)), type: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' }]; };
  /** Does this need the assistant, and is there none? Its words, else null. */
  const noAssistant = (what) => !currentAgent || ['off', 'none'].includes(agentName())
    ? `${what} needs the assistant, and it isn’t on yet (Settings → Voice).` : null;
  /** The assistant writes a meal's recipe into the box (watch mealWork["recipe|meal"]). */
  function writeRecipe(meal) {
    const text = str(meal, 80).trim(), key = `recipe|${text.toLowerCase()}`;
    if (!text) return { error: 'which meal?' };
    { const no = noAssistant('That'); if (no) return { error: no }; }
    if (mealWork[key]?.state === 'working') return { ok: true };
    mealWork[key] = { state: 'working' }; changed();
    (async () => {
      try {
        const prompt = `Write a simple family recipe for "${text}". First a line "Ingredients", then one ingredient per line starting with "- ", then a line "Steps", then numbered steps. Plain text, no markdown headings or bold, under 1500 characters.`;
        const notes = (await answer(prompt, 'You write short, reliable home recipes for a family. Reply with only the recipe. Use no tools.')).trim();
        if (!notes) throw new Error('no recipe');
        setRecipe({ meal: text, link: data.recipes[text.toLowerCase()]?.link, notes });
        mealWork[key] = { state: 'done' };
      } catch (e) { mealWork[key] = { state: 'error', text: String(e.message || e).slice(0, 120) }; }
      changed();
      setTimeout(() => { if (mealWork[key]?.state !== 'working') { delete mealWork[key]; changed(); } }, 60e3);
    })();
    return { ok: true };
  }
  async function ingredients(date, meal = 'dinner') {
    const text = data.meals[date]?.[meal], key = `${date}|${meal}`;
    if (!text) return { error: 'Nothing planned for that meal.' };
    { const no = noAssistant('That'); if (no) return { error: no }; }
    if (mealWork[key]?.state === 'working') return { ok: true };
    mealWork[key] = { state: 'working' }; changed();
    (async () => {
      try {
        const groceries = findList('Groceries', true), open = groceries.items.filter((i) => !i.done).map((i) => i.text);
        const prompt = `What groceries does a family need to make "${text}" (${meal})? Already on the grocery list: ${open.join(', ') || 'nothing'}.\n` +
          'Reply with only a JSON array of short item names, like ["Tortillas", "Ground beef", "Shredded cheese"]. Leave out what is already on the list and pantry staples (salt, pepper, oil, flour, sugar, spices). At most 10.';
        const sys = 'You turn a planned meal into the few groceries to buy for it. Reply with only a JSON array of strings, nothing else. Use no tools.';
        const recipe = data.recipes[text.toLowerCase()]?.notes;
        const said = await answer(recipe ? `${prompt}\nTheir recipe for it:\n${recipe}` : prompt, sys);
        const items = JSON.parse(said.match(/\[[\s\S]*\]/)?.[0] || '[]').map((x) => str(x, 40)).filter(Boolean).slice(0, 12);
        const fresh = items.filter((t) => !groceries.items.some((i) => !i.done && same(i.text, t)));
        if (fresh.length) changeList({ list: 'Groceries', add: fresh });
        mealWork[key] = { state: 'done', added: fresh };
      } catch (e) { mealWork[key] = { state: 'error', text: String(e.message || e).slice(0, 120) }; }
      changed();
      setTimeout(() => { if (mealWork[key]?.state !== 'working') { delete mealWork[key]; changed(); } }, 60e3);
    })();
    return { ok: true };
  }

  // ---- a flyer to events: the photo is kept (the latest few), the assistant sees it through the flyer_photo tool ----
  const latestFlyer = () => { try { return fs.readdirSync(FLYERS).filter((f) => PHOTO.test(f)).sort().at(-1) || null; } catch { return null; } };
  function addFlyer(bytes, name) {
    { const no = noAssistant('Reading a flyer'); if (no) return { error: no }; }
    fs.mkdirSync(FLYERS, { recursive: true });
    const ext = (String(name).match(/\.(jpe?g|png|webp)$/i)?.[0] || '.jpg').toLowerCase();
    fs.writeFileSync(path.join(FLYERS, Date.now() + ext), bytes);
    for (const f of fs.readdirSync(FLYERS).sort().slice(0, -5)) try { fs.unlinkSync(path.join(FLYERS, f)); } catch {}
    const mine = flyer = { state: 'working', at: Date.now() }; changed();
    (async () => {
      try {
        const d = new Date(), today = `${dayKey(d)} (${d.toLocaleDateString('en-US', { weekday: 'long' })})`;
        const prompt = `Someone sent the family display a photo of a flyer, school notice, invitation or schedule. It's attached (or the flyer_photo tool shows it). Today is ${today}.\n` +
          'Reply with only a JSON array of the events in it, like [{"title": "Book fair", "start": "2026-12-03T15:00", "end": "2026-12-03T17:00", "place": "School library", "notes": "Bring $10"}]. ' +
          'start: a local date-time, or just a date (YYYY-MM-DD) for an all-day one; end only if it says. A short title a family would put on their calendar. notes: what to bring, cost, who to contact, sign-up by (short). ' +
          'When it gives no year, the next time that date comes. A repeating schedule (practices every Tuesday) as each date it lists, at most 12. If it shows no events, or you can\'t see it, reply [].';
        const said = await answer(prompt, 'You read flyers into calendar events for a family. Reply with only a JSON array, nothing else.', photoBytes());
        const evs = JSON.parse(said.match(/\[[\s\S]*\]/)?.[0] || '[]').slice(0, 12).map((e) => {
          const start = str(e?.start, 30); if (!str(e?.title) || isNaN(new Date(start))) return null;
          return { title: str(e.title, 80), start, ...(str(e.end, 30) && !isNaN(new Date(e.end)) ? { end: str(e.end, 30) } : {}), allDay: /^\d{4}-\d{2}-\d{2}$/.test(start),
            ...(str(e.place) ? { place: str(e.place, 80) } : {}), ...(str(e.notes) ? { notes: str(e.notes, 400) } : {}) };
        }).filter(Boolean);
        if (flyer === mine) flyer = { state: 'done', at: mine.at, events: evs };
      } catch (e) { if (flyer === mine) flyer = { state: 'error', at: mine.at, text: String(e.message || e).slice(0, 120) }; }
      changed();
    })();
    return { ok: true };
  }
  /** A photo of a recipe for a meal: the assistant reads it into the recipe box (mealWork["recipe|meal"], photo: true). */
  function addRecipePhoto(bytes, meal) {
    const text = str(meal, 80).trim(), key = `recipe|${text.toLowerCase()}`;
    if (!text) return { error: 'which meal?' };
    { const no = noAssistant('Reading a recipe'); if (no) return { error: no }; }
    fs.mkdirSync(FLYERS, { recursive: true });
    fs.writeFileSync(path.join(FLYERS, Date.now() + '.jpg'), bytes);
    for (const f of fs.readdirSync(FLYERS).sort().slice(0, -5)) try { fs.unlinkSync(path.join(FLYERS, f)); } catch {}
    mealWork[key] = { state: 'working', photo: true }; changed();
    (async () => {
      try {
        const prompt = `Someone sent the family display a photo of a recipe for "${text}" (a recipe card, a cookbook page, a screenshot). It's attached (or the flyer_photo tool shows it). ` +
          'Type it out: first a line "Ingredients", then one ingredient per line starting with "- ", then a line "Steps", then numbered steps. Plain text, no markdown. Keep its amounts and words; leave out stories and ads. If you can\'t read a recipe in it, reply only NONE.';
        const notes = (await answer(prompt, 'You type recipes from photos for a family. Reply with only the recipe.', photoBytes())).trim();
        if (!notes || /^NONE\b/.test(notes)) throw new Error('Couldn’t read a recipe in that photo. Try closer, straight on.');
        setRecipe({ meal: text, link: data.recipes[text.toLowerCase()]?.link, notes: notes.slice(0, 4000) });
        mealWork[key] = { state: 'done' };
      } catch (e) { mealWork[key] = { state: 'error', text: String(e.message || e).slice(0, 120) }; }
      changed();
      setTimeout(() => { if (mealWork[key]?.state !== 'working') { delete mealWork[key]; changed(); } }, 60e3);
    })();
    return { ok: true };
  }
  function flyerPhoto() {
    const f = latestFlyer();
    if (!f) return { content: [{ type: 'text', text: 'No flyer photo has been sent to the display.' }], isError: true };
    const ext = path.extname(f).slice(1).toLowerCase();
    return { content: [
      { type: 'image', data: fs.readFileSync(path.join(FLYERS, f)).toString('base64'), mimeType: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' },
      { type: 'text', text: `The latest flyer photo sent to the display (${new Date(Number(f.split('.')[0])).toLocaleString('en-US')}).` }] };
  }

  // ---- events added on the display ----
  /** An event's fields from what was asked (add, or an update over what it was). */
  function eventFields(e, was = {}) {
    const startIn = e.start ?? was.start, start = new Date(startIn);
    const title = e.title !== undefined ? str(e.title, 80) : was.title;
    if (!title || isNaN(start)) return { error: 'An event needs a title and a start (ISO date or date-time).' };
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(startIn));
    const allDay = e.allDay !== undefined ? !!e.allDay || dateOnly : e.start !== undefined ? dateOnly : !!was.allDay;
    const s = allDay ? (dateOnly ? new Date(String(startIn) + 'T00:00:00') : new Date(start.getFullYear(), start.getMonth(), start.getDate())) : start;
    // The end: as given; else as long as it was (when it moved); else an hour, or the day.
    const dur = was.start && was.end ? new Date(was.end) - new Date(was.start) : null;
    let end = e.end && !isNaN(new Date(e.end)) ? new Date(e.end) : dur && allDay === !!was.allDay ? new Date(s.getTime() + dur) : allDay ? new Date(s.getTime() + DAY) : new Date(s.getTime() + 3600e3);
    if (end <= s) end = allDay ? new Date(s.getTime() + DAY) : new Date(s.getTime() + 3600e3);
    const repeat = e.repeat !== undefined ? (REPEATS.includes(e.repeat) ? e.repeat : null) : was.repeat || null;
    const until = e.until !== undefined ? (validDay(e.until) ? e.until : null) : was.until || null;
    const pick = (k, n) => (e[k] !== undefined ? str(e[k], n) : was[k] || '');
    const who = e.who !== undefined ? str(e.who, 40) || null : was.who || null;
    const also = (e.also !== undefined ? arr(e.also) : was.also || []).map((n) => str(n, 40)).filter((n) => n && !same(n, who)).slice(0, 6); // whoever else it's for
    const countdown = e.countdown !== undefined ? !!e.countdown : !!was.countdown;
    const remind = e.remind !== undefined ? remindMin(e.remind) : was.remind; // minutes before; -1 none; absent: the household's
    return { title, start: s.toISOString(), end: end.toISOString(), allDay, who, ...(who && also.length ? { also } : {}),
      ...(pick('place', 80) ? { place: pick('place', 80) } : {}), ...(pick('notes', 400) ? { notes: pick('notes', 400) } : {}),
      ...(repeat ? { repeat } : {}), ...(repeat && until ? { until } : {}), ...(countdown ? { countdown: true } : {}), ...(remind != null ? { remind } : {}), ...(repeat && was.skip ? { skip: was.skip } : {}) };
  }
  /** Minutes before an event, from what was asked: 0 at the start, up to a day; "none"/false/-1 no reminder; null/"default" the household's. */
  function remindMin(v) {
    if (v === null || v === undefined || v === 'default') return undefined;
    if (v === false || v === 'none' || v === 'off' || Number(v) < 0) return -1;
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(n, 1440) : undefined;
  }
  function changeEvents(a) {
    // One thing per call, and only one that was really asked for: the voice's backend sends every part of this tool at
    // once (an add with defaults and no title beside the remove it meant), so an add needs a title and a start, an
    // update an id, and a remove wins over everything else. (It had been adding "x" on 1 January instead of removing.)
    if (a.add && !(str(a.add.title) && str(a.add.start))) delete a.add;
    if (a.update && !str(a.update.id)) delete a.update;
    if (a.countdown && !(str(a.countdown.uid) || str(a.countdown.id))) delete a.countdown;
    if (a.remind && !(str(a.remind.uid) || str(a.remind.id))) delete a.remind;
    if (a.remove != null && ![].concat(a.remove).some((x) => str(x))) delete a.remove;
    if (a.remove) { delete a.add; delete a.update; delete a.countdown; delete a.remind; }
    else if (a.update) delete a.add;
    if (a.add) {
      const f = eventFields(a.add);
      if (f.error) return f;
      // The same event again (the same title within a few minutes of the same start): it's already there, so it's
      // changed rather than added twice.
      const twin = data.events.find((e) => same(e.title, f.title) && Math.abs(new Date(e.start) - new Date(f.start)) <= 5 * 60e3);
      if (twin) {
        for (const k of Object.keys(twin)) if (k !== 'id') delete twin[k];
        Object.assign(twin, f); save();
        return { ok: true, already: true, event: twin, note: 'Already on the calendar, so it was changed rather than added again. Nothing more to add; to change it later, update it by id.' };
      }
      const ev = { id: 'e-' + crypto.randomUUID().slice(0, 6), ...f };
      data.events.push(ev); prune(); save();
      return { ok: true, event: ev };
    }
    if (a.update) { // one added on the display: anything about it (what isn't given stays)
      const ev = data.events.find((e) => e.id === a.update.id);
      if (!ev) return { error: `No event ${a.update.id} added on the display (synced calendars are changed where they come from; a countdown on one is { countdown: { uid, on } }).` };
      const f = eventFields(a.update, ev);
      if (f.error) return f;
      for (const k of Object.keys(ev)) if (k !== 'id') delete ev[k];
      Object.assign(ev, f); save();
      return { ok: true, event: ev };
    }
    if (a.countdown) { // a synced event (by its uid), or one added here (by id): count down to it on Today and the idle screen
      const { uid, id, on = true } = a.countdown;
      const ev = id && data.events.find((e) => e.id === id);
      if (ev) { if (on) ev.countdown = true; else delete ev.countdown; save(); return { ok: true }; }
      if (!str(uid)) return { error: 'Which event (its uid, or id for one added here)?' };
      const u = str(uid, 140);
      data.countdowns = on ? [...new Set([...data.countdowns, u])].slice(-40) : data.countdowns.filter((x) => x !== u);
      save(); return { ok: true };
    }
    if (a.remind) { // a reminder on a synced event (by its uid), or one added here (by id); minutes: null for the household's
      const { uid, id } = a.remind, m = remindMin(a.remind.minutes);
      const ev = id && data.events.find((e) => e.id === id);
      if (ev) { if (m === undefined) delete ev.remind; else ev.remind = m; save(); return { ok: true }; }
      if (!str(uid)) return { error: 'Which event (its uid, or id for one added here)?' };
      const u = str(uid, 140);
      if (m === undefined) delete data.reminds[u]; else data.reminds[u] = m;
      const keys = Object.keys(data.reminds); if (keys.length > 200) delete data.reminds[keys[0]];
      save(); return { ok: true };
    }
    if (a.remove) {
      const ids = [].concat(a.remove).map(String), gone = [], missing = [];
      for (const id of ids) {
        const ev = data.events.find((e) => e.id === id);
        if (!ev) { missing.push(id); continue; }
        if (ev.repeat && validDay(a.date) && ids.length === 1) { ev.skip = [...new Set([...(ev.skip || []), a.date])]; save(); return { ok: true, removed: [], skipped: a.date, note: `Only ${a.date} is off; it still repeats ${ev.repeat}. Leave out date to remove it entirely.` }; }
        data.events = data.events.filter((e) => e !== ev); gone.push(id);
      }
      if (gone.length) save();
      if (!gone.length) return { error: `No event ${missing.join(', ')} added on the display (synced calendars can only be changed where they come from).` };
      return { ok: true, removed: gone, ...(missing.length ? { notFound: missing } : {}) };
    }
    return { error: 'add or remove' };
  }

  function removePhoto(name) {
    const n = path.basename(String(name || ''));
    if (!PHOTO.test(n) || n.startsWith('.')) return { error: 'no such photo' };
    const bin = path.join(PHOTOS, '.removed');
    try { fs.mkdirSync(bin, { recursive: true }); fs.renameSync(path.join(PHOTOS, n), path.join(bin, n)); } catch { return { error: 'no such photo' }; }
    try { const t = new Date(); fs.utimesSync(path.join(bin, n), t, t); } catch {} // its 30 days start now (not from when it was taken)
    try { for (const f of fs.readdirSync(bin)) if (fs.statSync(path.join(bin, f)).mtimeMs < Date.now() - 30 * DAY) fs.unlinkSync(path.join(bin, f)); } catch {}
    albums.removed(n);
    for (const a of data.albums) a.photos = a.photos.filter((x) => x !== n); delete data.captions[n];
    save(); return { ok: true };
  }
  // ---- photos taken off: kept in photos/.removed for 30 days, and can be put back ----
  let removedCache = null;
  function removedPhotos() {
    const bin = path.join(PHOTOS, '.removed');
    try {
      const at = fs.statSync(bin).mtimeMs;
      if (removedCache?.at !== at) removedCache = { at, list: fs.readdirSync(bin).filter((f) => PHOTO.test(f) && !f.startsWith('.'))
        .map((f) => ({ f, t: fs.statSync(path.join(bin, f)).mtimeMs })).sort((a, b) => b.t - a.t).map((x) => x.f).slice(0, 60) };
      return removedCache.list;
    } catch { return []; }
  }
  function restorePhoto(name) {
    const n = path.basename(String(name || ''));
    if (!PHOTO.test(n) || n.startsWith('.')) return { error: 'no such photo' };
    try { fs.renameSync(path.join(PHOTOS, '.removed', n), path.join(PHOTOS, n)); } catch { return { error: 'That photo isn’t there to put back.' }; }
    if (n.startsWith('ic-')) { albums.restored(n); save(); return { ok: true }; }
    changed(); return { ok: true };
  }

  // ---- albums and captions ----
  /** The photos the idle screen shows: the chosen album's (those still there), else all of them. */
  function screensaver() {
    const all = photos(), a = data.albums.find((x) => x.id === data.settings.slideshow);
    if (!a) return all;
    const have = new Set(all), list = a.photos.filter((n) => have.has(n));
    return list.length ? list : all;
  }
  const photoName = (n) => { const b = String(n || ''); return b === path.basename(b) && photos().includes(b) ? b : null; }; // one of theirs, by its name
  function changeAlbums(b) {
    if (b.add) {
      const name = str(b.add.name, 40); if (!name) return { error: 'An album needs a name.' };
      if (data.albums.some((x) => same(x.name, name))) return { error: `There's an album called ${name} already.` };
      const a = { id: 'a-' + crypto.randomUUID().slice(0, 6), name, photos: [...new Set(arr(b.add.photos).map(photoName).filter(Boolean))] };
      data.albums.push(a); save(); return { ok: true, album: a };
    }
    const a = data.albums.find((x) => x.id === (b.rename?.id ?? b.put?.id ?? b.remove));
    if (!a) return { error: 'No such album.' };
    if (b.rename) {
      const name = str(b.rename.name, 40); if (!name) return { error: 'An album needs a name.' };
      if (data.albums.some((x) => x !== a && same(x.name, name))) return { error: `There's an album called ${name} already.` };
      a.name = name; albums.renamed(a.id); save(); return { ok: true };
    }
    if (b.put) {
      const names = arr(b.put.photos).map(photoName).filter(Boolean);
      a.photos = b.put.on === false ? a.photos.filter((n) => !names.includes(n)) : [...new Set([...a.photos, ...names])];
      save(); return { ok: true };
    }
    if (a.from) return { error: `${a.name} comes from ${a.from}: someone takes it off in the Photos app, the album's card.` };
    data.albums = data.albums.filter((x) => x !== a); // the photos stay: only the album goes
    if (data.settings.slideshow === a.id) delete data.settings.slideshow;
    save(); return { ok: true };
  }
  /** A photo into Photos (a phone's upload page, or one shared to Opie: phone-share.js), with a caption if given. Its file name. */
  function addPhoto(bytes, name = 'photo.jpg', text = '') {
    // The very same picture again (a drawing saved twice unchanged): it's already there, so that one's name comes back.
    const same = samePhoto(bytes);
    if (same) { if (str(text, 120) && !data.captions[same]) { data.captions[same] = str(text, 120); save(); changed(); } return same; }
    const file = Date.now() + '-' + String(name).replace(/[^\w.-]/g, '_').slice(-80);
    fs.mkdirSync(PHOTOS, { recursive: true });
    fs.writeFileSync(path.join(PHOTOS, file), bytes);
    if (str(text, 120)) data.captions[file] = str(text, 120);
    save(); changed();
    return file;
  }
  /** A photo already in Photos with exactly these bytes (same size first, then the same SHA-256), or null. */
  function samePhoto(bytes) {
    let names; try { names = fs.readdirSync(PHOTOS).filter((n) => PHOTO.test(n)); } catch { return null; }
    let digest = null;
    for (const n of names) {
      let st; try { st = fs.statSync(path.join(PHOTOS, n)); } catch { continue; }
      if (st.size !== bytes.length) continue;
      digest ??= crypto.createHash('sha256').update(bytes).digest('hex');
      try { if (crypto.createHash('sha256').update(fs.readFileSync(path.join(PHOTOS, n))).digest('hex') === digest) return n; } catch {}
    }
    return null;
  }
  function caption(b) {
    const n = photoName(b.name); if (!n) return { error: 'no such photo' };
    const t = str(b.text, 120);
    if (t) data.captions[n] = t; else delete data.captions[n];
    save(); return { ok: true };
  }

  function settings(b) {
    if (b.night === false || b.night === null) data.settings.night = false;
    else if (b.night) data.settings.night = { from: hhmm(b.night.from, NIGHT.from), to: hhmm(b.night.to, NIGHT.to) };
    if (b.remind !== undefined) { const m = remindMin(b.remind); if (m === undefined || m < 0) delete data.settings.remind; else data.settings.remind = m; }
    if (b.remindAloud !== undefined) data.settings.remindAloud = !!b.remindAloud;
    if (b.slideshow !== undefined) { if (b.slideshow && data.albums.some((a) => a.id === b.slideshow)) data.settings.slideshow = b.slideshow; else delete data.settings.slideshow; }
    // An app's things on the calendar: {app, show: 'week' | 'today' | 'off'}; fromAppsOrder: the apps' ids, first first.
    if (b.fromApp && typeof b.fromApp === 'object') {
      const app = str(b.fromApp.app, 80);
      if (app && SHOWS.includes(b.fromApp.show)) data.settings.fromApps = { ...(data.settings.fromApps || {}), [app]: b.fromApp.show };
    }
    if (Array.isArray(b.fromAppsOrder)) data.settings.fromAppsOrder = [...new Set(b.fromAppsOrder.map((x) => str(x, 80)).filter(Boolean))].slice(0, 60);
    save(); return { ok: true };
  }
  function putAway(key) {
    const k = str(key, 220);
    if (!k) return { error: 'Which reminder (its key)?' };
    data.reminded = [...data.reminded.filter((x) => x !== k), k].slice(-200);
    save(); return { ok: true };
  }

  // ---- for conversations: what's on the lists and the menu, so "what's for dinner?" just works ----
  function context() {
    const today = dayKey(), lines = [];
    for (const l of data.lists) { const open = l.items.filter((i) => !i.done); lines.push(`- ${l.name}: ${open.map((i) => i.text).join(', ') || 'empty'}`); }
    const meals = [...Array(7)].map((_, i) => { const k = dayKey(new Date(Date.now() + i * DAY)); const m = data.meals[k]; return m ? `${i === 0 ? 'today' : new Date(k + 'T12:00').toLocaleDateString('en-US', { weekday: 'short' })} ${Object.entries(m).map(([a, b]) => `${a}: ${b}`).join(', ')}` : null; }).filter(Boolean);
    const ch = chores().filter((c) => c.today), done = ch.filter((c) => c.done);
    const st = Object.entries(starsView()).filter(([, n]) => n > 0);
    return [
      `Lists (the Lists app):\n${lines.join('\n')}`,
      meals.length ? `Meals planned: ${meals.join('; ')}` : 'Meals planned: none this week',
      Object.keys(data.recipes).length ? `Recipes saved (set_meals recipes): ${Object.values(data.recipes).map((r) => r.text).join(', ')}` : '',
      ch.length ? `Chores done today (${today}): ${done.map((c) => `${c.who ? c.who + ': ' : ''}${c.task}`).join(', ') || 'none yet'}` : '',
      st.length || data.rewards.length ? `Stars to spend: ${st.map(([n, s]) => `${n} ${s}`).join(', ') || 'none'}. Rewards: ${data.rewards.map((r) => `${r.title} (${r.stars}${r.who ? `, ${r.who}` : ''})`).join(', ') || 'none yet'}` : '',
      data.checklists.length ? `Routines (picture checklists in Chores): ${data.checklists.map((c) => `${c.name} ${c.from}–${c.to}${c.who.length ? ` (${c.who.join(', ')})` : ''}: ${c.steps.map((s) => s.text).join(', ')}`).join('; ')}` : '',
    ].filter(Boolean).join('\n');
  }

  // ---- tools (on the door's MCP server) ----
  const person = { type: 'string', description: 'A family name' };
  const TOOLS = [
    { name: 'night_hours', description: 'The screen\'s night hours: when nobody\'s using it, it dims and shows only the time (no photos), and the check-ins sleep. On by default, 9:30 PM to 6:30 AM. Pass from and to ("21:30", "06:30") to change them, off: true to turn night off, or nothing to say what they are. Change them only when they ask.',
      inputSchema: { type: 'object', properties: { from: { type: 'string', description: '"HH:MM", 24-hour' }, to: { type: 'string', description: '"HH:MM", 24-hour' }, off: { type: 'boolean' } } } },
    { name: 'family_things', description: "The family's lists (groceries, to-do...), today's chores with checkmarks and this week's stars, stars to spend and rewards, routines (morning/bedtime checklists), the meal plan and favorite meals, and events added on this display. Read before changing them. The Calendar, Chores, Lists and Meals apps show exactly this.", inputSchema: { type: 'object', properties: {} } },
    { name: 'change_list', description: 'Add to, check off, uncheck, change or remove items on one of the family\'s lists (the Lists app; "add milk" means Groceries). Creates the list if it\'s new. Items match by their text.',
      inputSchema: { type: 'object', properties: {
        list: { type: 'string', description: 'e.g. "Groceries", "To do", "Costco"' },
        add: { type: 'array', items: { type: 'string' } }, check: { type: 'array', items: { type: 'string' } }, uncheck: { type: 'array', items: { type: 'string' } },
        remove: { type: 'array', items: { type: 'string' } },
        edit: { type: 'array', description: 'Change items: the item (its text now), its new text, and whose it is.', items: { type: 'object', properties: { item: { type: 'string' }, text: { type: 'string' }, who: { type: 'string' } }, required: ['item'] } },
        clearChecked: { type: 'boolean', description: 'Take everything checked off the list.' },
        rename: { type: 'string' }, deleteList: { type: 'boolean', description: 'Only if they asked to get rid of the whole list.' },
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
    { name: 'change_rewards', description: 'Rewards the kids save their chore stars for (the Chores app), like "Movie night" for 20 stars. Add or change one (same title changes its stars), or remove one. You can\'t give a reward: the kid asks on the display and someone says yes there.',
      inputSchema: { type: 'object', properties: {
        add: { type: 'array', items: { type: 'object', required: ['title', 'stars'], properties: { title: { type: 'string' }, stars: { type: 'number' }, who: { type: 'string', description: 'Only for this person; leave out for anyone' } } } },
        remove: { type: 'array', items: { type: 'string', description: 'title or id' } },
      } } },
    { name: 'change_routines', description: 'Routines: short picture checklists (morning, bedtime, after school) that the Chores app shows at the top during their hours, one row per person. Add, change (by name or id), remove, or check a step off. Each step has a picture.',
      inputSchema: { type: 'object', properties: {
        add: { type: 'array', items: { type: 'object', required: ['name', 'steps'], properties: {
          name: { type: 'string', description: 'e.g. "Morning"' }, who: { type: 'array', items: person, description: 'Whose; leave out for every kid' },
          from: { type: 'string', description: 'HH:MM, when it shows' }, to: { type: 'string', description: 'HH:MM' }, days: { type: 'array', items: { type: 'string', enum: WEEKDAYS } },
          steps: { type: 'array', items: { type: 'object', required: ['text'], properties: { text: { type: 'string', description: 'Two or three words' }, pic: { type: 'string', enum: PICS } } } } } } },
        update: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, rename: { type: 'string' }, who: { type: 'array', items: person }, from: { type: 'string' }, to: { type: 'string' }, days: { type: 'array', items: { type: 'string' } }, steps: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, pic: { type: 'string', enum: PICS } } } } } } },
        remove: { type: 'array', items: { type: 'string', description: 'name or id' } },
        check: { type: 'array', items: { type: 'object', required: ['name', 'step', 'who'], properties: { name: { type: 'string' }, step: { type: 'string' }, who: person, done: { type: 'boolean' } } } },
      } } },
    { name: 'save_recipe', description: "Save a recipe from its web page into the recipe box: the page is read and made into cooking steps, and it shows in Recipes. For a link to a recipe someone gives or shares (meal: the meal it's for, only if they said).",
      inputSchema: { type: 'object', required: ['link'], properties: { link: { type: 'string' }, meal: { type: 'string' } } } },
    { name: 'set_meals', description: 'Plan meals (the Meals app): set or change what\'s for a meal on a day; empty text clears it. Also the recipe box (a recipe per meal) and which meals the app plans. Meals they have often come back as one-tap choices; favorite pins one there.',
      inputSchema: { type: 'object', properties: { meals: { type: 'array', items: { type: 'object', required: ['date', 'text'], properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' }, meal: { type: 'string', description: 'dinner (default), lunch, breakfast' }, text: { type: 'string' } } } },
        favorite: { type: 'array', items: { type: 'string' }, description: 'Meals to pin as favorites' }, unfavorite: { type: 'array', items: { type: 'string' } },
        recipes: { type: 'array', description: 'Save a recipe in the recipe box, by the meal it is for (a link and/or notes: ingredients and steps); both empty takes it out. It shows on every day that meal is planned.', items: { type: 'object', required: ['meal'], properties: { meal: { type: 'string' }, link: { type: 'string' }, notes: { type: 'string' } } } },
        slots: { type: 'array', items: { type: 'string', enum: ['breakfast', 'lunch', 'dinner'] }, description: 'Which meals the Meals app plans each day (dinner only unless they want more).' } } } },
    { name: 'flyer_photo', description: 'The latest photo someone sent to the display from their phone: a flyer, school notice or invitation (the Calendar app\'s camera button), or a recipe (the Meals app). Look at it to add its events (say what you found and ask before adding) or type up the recipe.',
      inputSchema: { type: 'object', properties: {} } },
    { name: 'calendar_event', description: "The family calendar (the Calendar app). Add an event; change one added on this display (update: its id and only what changes: a new time, place, title, notes, whose, repeat); remove one added here (by id; with date, only that day of a repeating one); remind them before any event (remind; synced ones too); or count down to any event, synced ones too (countdown: id for one added here, uid for a synced one; family_things lists both). Synced calendars (Google, iCloud) can't be changed here: say so, and offer to add it on the display's calendar instead.",
      inputSchema: { type: 'object', properties: {
        add: { type: 'object', required: ['title', 'start'], properties: { title: { type: 'string' }, start: { type: 'string', description: 'ISO local date-time like 2026-11-20T16:30, or a date for all day (the first time, for a repeating one)' }, end: { type: 'string' }, allDay: { type: 'boolean' }, who: { type: 'string', description: 'Whose it is (a family name), if anyone\'s' }, also: { type: 'array', items: { type: 'string' }, description: 'Anyone else it is for (shown in each of their colours)' }, place: { type: 'string' },
          notes: { type: 'string', description: 'What to bring, who drives, a phone number' }, countdown: { type: 'boolean', description: 'Count down to it on the home screen (a birthday, a trip)' },
          remind: { type: 'number', description: 'Minutes before to remind them on the display (0 at the start, -1 none); leave out for the household\'s usual' },
          repeat: { type: 'string', enum: REPEATS, description: 'Only when they said it repeats ("every Friday", "weekly", "each day"); never because of what the event is. Leave it out for a one-off.' }, until: { type: 'string', description: 'YYYY-MM-DD, last day it repeats; leave out for always' } } },
        update: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, allDay: { type: 'boolean' }, who: { type: 'string' }, also: { type: 'array', items: { type: 'string' } }, place: { type: 'string' }, notes: { type: 'string' },
          countdown: { type: 'boolean' }, remind: { type: 'number' }, repeat: { type: 'string', enum: [...REPEATS, 'none'] }, until: { type: 'string' } } },
        remove: { type: 'array', items: { type: 'string' }, description: 'ids of events added on the display (one or more): all of each, every day it repeats' }, date: { type: 'string', description: 'YYYY-MM-DD: only remove that day of a repeating event' },
        countdown: { type: 'object', properties: { id: { type: 'string' }, uid: { type: 'string' }, on: { type: 'boolean' } } },
        remind: { type: 'object', description: 'A reminder on any event, synced ones too: minutes before (0 at the start, -1 none, null the household\'s usual)', properties: { id: { type: 'string' }, uid: { type: 'string' }, minutes: { type: ['number', 'null'] } } },
      } } },
  ];
  async function call(name, a) {
    const ok = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 1) }] });
    const out = (r) => (r.error ? { content: [{ type: 'text', text: r.error }], isError: true } : ok(r));
    if (name === 'family_things') {
      const v = view(); delete v.v; delete v.mealWork; delete v.ai; delete v.night; v.photos = v.photos.length; delete v.screensaver; delete v.aisles; delete v.removed;
      v.recipes = Object.fromEntries(Object.entries(v.recipes || {}).map(([k, { cook, ...r }]) => [k, { ...r, ...(cook ? { steps: cook.steps.length } : {}) }])); // the cooking steps are the Recipes app's
      v.albums = v.albums.map((a) => ({ name: a.name, photos: a.photos.length }));
      // Events added here (changeable, by id), and the coming two weeks of everything else (synced: by uid, for a countdown).
      v.events = data.events.map((e) => ({ id: e.id, title: e.title, start: localWhen(e.start, e.allDay), end: localWhen(e.end, e.allDay, true), allDay: e.allDay, who: e.who, ...(e.also ? { also: e.also } : {}), ...(e.place ? { place: e.place } : {}), ...(e.notes ? { notes: e.notes } : {}), ...(e.countdown ? { countdown: true } : {}), ...(e.remind != null ? { remind: e.remind } : {}), ...(e.repeat ? { repeat: e.repeat, until: e.until } : {}) }));
      const soon = Date.now() + 14 * DAY;
      // What the household's apps put on the calendar: read-only here (the app changes them).
      v.fromApps = appEvents().filter((e) => new Date(e.end || e.start) > Date.now() - DAY && new Date(e.start) < soon).slice(0, 60)
        .map((e) => ({ title: e.title, start: localWhen(e.start, e.allDay), ...(e.allDay ? { allDay: true } : {}), ...(e.who ? { who: e.who } : {}), ...(e.place ? { place: e.place } : {}), from: e.appName }));
      v.dayNotes = Object.fromEntries(Object.entries(v.dayNotes || {}).filter(([k]) => k >= dayKey() && k < dayKey(new Date(soon))).map(([k, l]) => [k, l.map((x) => `${x.label}: ${x.text}${x.who ? ` (${x.who})` : ''} [from ${x.name}]`)]));
      v.synced = board.calendarEvents().filter((e) => new Date(e.end || e.start) > Date.now() - DAY && new Date(e.start) < soon).slice(0, 80)
        .map((e) => ({ title: e.title, start: localWhen(e.start, e.allDay), ...(e.allDay ? { allDay: true } : {}), who: e.who || null, ...(e.place ? { place: e.place } : {}), ...(e.uid ? { uid: e.uid } : {}), ...(e.uid && data.countdowns.includes(e.uid) ? { countdown: true } : {}), ...(e.uid && data.reminds[e.uid] !== undefined ? { remind: data.reminds[e.uid] } : {}) }));
      v.meals = Object.fromEntries(Object.entries(v.meals).filter(([k]) => k >= dayKey(new Date(Date.now() - 2 * DAY))));
      v.lists = v.lists.map((l) => ({ name: l.name, items: l.items.map((i) => ({ text: i.text, ...(i.who ? { who: i.who } : {}), ...(i.done ? { done: true } : {}) })) }));
      v.favorites = v.favorites.map((f) => f.text);
      v.reminders = (v.reminders || []).map((r) => ({ ...inLocal(r), ...(r.remindAt ? { remindAt: localWhen(r.remindAt) } : {}) }));
      v.things = (v.things || []).map((x) => (x.start ? { ...x, start: localWhen(x.start, x.allDay) } : x));
      return ok(v);
    }
    if (name === 'night_hours') {
      if (a?.off) settings({ night: false });
      else if (a?.from || a?.to) { const cur = view().night || NIGHT; settings({ night: { from: a.from || cur.from, to: a.to || cur.to } }); }
      const n = view().night;
      return ok(n ? `Night: ${n.from} to ${n.to}.` : 'Night is off: the screen stays as it is all night.');
    }
    if (name === 'flyer_photo') return flyerPhoto();
    if (name === 'change_list') return out(changeList(a));
    if (name === 'change_chores') return out(changeChores(a));
    if (name === 'change_rewards') return out(changeRewards(a));
    if (name === 'change_routines') return out(changeChecklists(a));
    if (name === 'save_recipe') { const r = addRecipeLink({ link: a.link, meal: a.meal || '' }); return r.error ? out(r) : ok('Saved: it is being read and made into steps; it will be in Recipes in a moment.'); }
    if (name === 'set_meals') {
      for (const f of arr(a.favorite)) favorite(f, true);
      for (const f of arr(a.unfavorite)) favorite(f, false);
      const did = [];
      for (const r of objs(a.recipes)) { const x = setRecipe(r); did.push(...(x.did || [x.error])); }
      if (a.slots) did.push(`plans ${setSlots(a.slots).slots.join(', ')}`);
      const m = a.meals ? setMeals(a.meals) : { ok: true, did: [] };
      return out({ ...m, did: [...(m.did || []), ...did] });
    }
    if (name === 'calendar_event') { const r = changeEvents(a); return out(r.event ? { ...r, event: inLocal(r.event) } : r); }
    return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (p !== '/house' && !p.startsWith('/house/')) return false; // not /household
    if (req.method === 'GET' && p === '/house') { json(res, 200, view()); return true; }
    if (req.method === 'GET' && p === '/house/wait') {
      if (Number(url.searchParams.get('v')) !== version) { json(res, 200, view()); return true; }
      const t = setTimeout(() => { waiters.delete(done); json(res, 200, view()); }, 25e3);
      const done = (v) => { clearTimeout(t); json(res, 200, v); };
      waiters.add(done);
      req.on('close', () => { clearTimeout(t); waiters.delete(done); });
      return true;
    }
    if (p.startsWith('/house/photo/') && req.method === 'GET') {
      const name = decodeURIComponent(p.slice('/house/photo/'.length));
      if (!PHOTO.test(name) || name.includes('/') || name.startsWith('.')) { json(res, 404, { error: 'not found' }); return true; }
      try {
        const buf = fs.readFileSync(url.searchParams.get('removed') ? path.join(PHOTOS, '.removed', name) : path.join(PHOTOS, name)); // ?removed=1: one taken off, to put back
        res.writeHead(200, { 'content-type': /png$/i.test(name) ? 'image/png' : /webp$/i.test(name) ? 'image/webp' : /gif$/i.test(name) ? 'image/gif' : 'image/jpeg', 'cache-control': 'max-age=86400' });
        res.end(buf);
      } catch { json(res, 404, { error: 'not found' }); }
      return true;
    }
    if (req.method !== 'POST') return false;
    if (p === '/house/photo') { // raw image body
      const name = String(url.searchParams.get('name') || '').replace(/[^\w.-]/g, '_').slice(-80);
      if (!PHOTO.test(name)) { json(res, 400, { error: 'name must end in .jpg, .png, .webp' }); return true; }
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 25e6) { json(res, 413, { error: 'too big' }); return true; } chunks.push(c); }
      const file = addPhoto(Buffer.concat(chunks), name);
      json(res, 200, { ok: true, name: file }); return true;
    }
    if ((p === '/house/flyer' || p === '/house/recipe-photo') && req.method === 'POST') { // raw image body
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 15e6) { json(res, 413, { error: 'too big' }); return true; } chunks.push(c); }
      const r = p === '/house/flyer' ? addFlyer(Buffer.concat(chunks), url.searchParams.get('name') || 'flyer.jpg') : addRecipePhoto(Buffer.concat(chunks), url.searchParams.get('meal'));
      json(res, r.error ? 400 : 200, r); return true;
    }
    const b = await body(req);
    const send = (r) => json(res, r.error ? 400 : 200, r.error ? r : { ...r, house: view() });
    if (p === '/house/list') { send(changeList(b)); return true; }
    if (p === '/house/chore') {
      if (b.done) send(changeChores(b.value === false ? { undone: [b.done] } : { done: [b.done] }));
      else send(changeChores(b));
      return true;
    }
    if (p === '/house/reward') { send(changeRewards(b, { fromApp: true })); return true; }
    if (p === '/house/checklist') { send(changeChecklists(b)); return true; }
    if (p === '/house/recipe-link') { send(addRecipeLink(b)); return true; } // a link shared from a phone (Recipes)
    if (p === '/house/meal') { send(b.favorite != null ? favorite(b.favorite, b.value !== false) : b.recipe ? setRecipe({ ...b.recipe, quiet: false, video: b.recipe.video }) : b.cook ? prepareCook(b.cook, { force: !!b.force }) : b.find ? findRecipes(b.find) : b.findDone ? (recipeFind = null, changed(), { ok: true }) : b.writeRecipe ? writeRecipe(b.writeRecipe) : b.slots ? setSlots(b.slots) : setMeals([b])); return true; }
    if (p === '/house/meal/ingredients') { send(await ingredients(b.date, str(b.meal || 'dinner', 20).toLowerCase())); return true; }
    if (p === '/house/event') {
      // With the calendar locked, an app changes it only for a little while after the PIN on the display.
      if (req.headers['x-openhouse-app'] && data.settings.calendarLock && unlockedUntil < Date.now()) { json(res, 403, { error: 'The calendar is locked: someone unlocks it with the PIN.', locked: true }); return true; }
      send(changeEvents(b)); return true;
    }
    if ((p === '/house/lock' || p === '/house/unlock') && req.headers['x-openhouse-app']) { json(res, 403, { error: 'Only the display can do that.' }); return true; }
    if (p === '/house/lock') { if (b.calendar !== undefined) { if (b.calendar) data.settings.calendarLock = true; else delete data.settings.calendarLock; } unlockedUntil = 0; save(); send({ ok: true }); return true; }
    if (p === '/house/unlock') { unlockedUntil = Date.now() + 5 * 60e3; changed(); send({ ok: true, until: unlockedUntil }); return true; }
    if (p === '/house/settings') { send(settings(b)); return true; }
    if (p === '/house/remind') { send(putAway(b.done)); return true; }
    if (p === '/house/thing') { if (!things?.take(b.take)) { json(res, 400, { error: 'Which thing (its id)?' }); return true; } changed(); json(res, 200, { ok: true }); return true; }
    if (p === '/house/flyer/clear') { flyer = null; changed(); send({ ok: true }); return true; }
    if (p === '/house/photo/remove') { send(removePhoto(b.name)); return true; }
    if (p === '/house/photo/album') { send(changeAlbums(b)); return true; }
    if (p === '/house/photo/restore') { send(restorePhoto(b.name)); return true; }
    if (p === '/house/photo/caption') { send(caption(b)); return true; }
    if ((p === '/house/album/stream' || p === '/house/album/assets') && req.headers['x-openhouse-app']) { json(res, 403, { error: 'Only the display can do that.' }); return true; }
    if (p === '/house/album/stream') { const { done, ...r } = albums.stream(b); json(res, r.error ? 400 : 200, r); return true; }
    if (p === '/house/album/assets') { const { done, ...r } = albums.assets(b); json(res, r.error ? 400 : 200, r); return true; }
    if (p === '/house/share') { const r = await shell('/share', { url: String(b.url || '') }); send(r && !r.error ? { ok: true } : { error: r?.error || 'The display can\u2019t share from here.' }); return true; }
    return false;
  }

  // Photos added straight into the folder (adb push, a file share) show up without a restart.
  try { fs.watch(PHOTOS, () => { clearTimeout(handle._pt); handle._pt = setTimeout(changed, 500); }).unref?.(); } catch {}
  // Routines come and go with the clock: tell the apps when one starts or ends.
  let wasActive = '';
  setInterval(() => { const now = data.checklists.filter((c) => activeNow(c)).map((c) => c.id).join(','); if (now !== wasActive) { wasActive = now; changed(); } }, 30e3).unref?.();
  // Asks left from before a restart: nobody is looking at a card for them any more (the kid asks again).
  data.asks = [];
  handle.tools = TOOLS;
  handle.call = call;
  handle.context = context;
  handle.settings = settings;
  handle.putAway = putAway;
  handle.addFlyer = addFlyer;
  handle.addRecipePhoto = addRecipePhoto;
  handle.prepareCook = prepareCook;
  handle.addRecipeLink = addRecipeLink;
  handle.findRecipes = findRecipes;
  handle.changeAlbums = changeAlbums;
  handle.view = view;
  handle.changed = changed;
  handle.putAway = putAway;
  handle.caption = caption;
  handle.addPhoto = addPhoto;
  handle.removePhoto = removePhoto;
  handle.restorePhoto = restorePhoto;
  handle.albums = albums;
  handle.events = () => events(); // the calendar as screens get it (tests)
  handle.reminders = (now) => reminders(now); // the reminders due now (phone-buzz.js: they buzz the phones of the people on them)
  handle.night = () => (data.settings.night === false ? null : data.settings.night || { from: '21:30', to: '06:30' });
  handle.localEvents = () => [...data.events.flatMap((e) => occurrences(e, Date.now() - 35 * DAY, Date.now() + 70 * DAY)), ...appEvents()];
  return handle;
}

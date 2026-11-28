// What every part of the house (house.js and house/*.js) shares: its limits, the people's colors, the store's aisles,
// and the small helpers for dates (the display's own time zone) and for what a tap or a tool sent. Nothing here keeps state.

export const DAY = 86400e3;
// How much a list and the recipe box hold. Past it, an add is refused with the reason (a 400 for a tap, an error a
// tool says), never made room for by dropping the oldest.
export const ROOM = { listItems: 500, recipes: 300 };
/** Each person's color, in the order the family is listed, unless they chose one (household.json family[].color).
 *  The one palette: the apps (kit), the home screen and its widgets all take a person's color from /house. */
export const PEOPLE = ['#ffc247', '#56d6a0', '#ff8566', '#74acff', '#c3a0ff', '#ff9ec4'];
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const PHOTO = /\.(jpe?g|png|webp|gif|heic)$/i;
/** Videos keep their own file (no transcoding: the tablet's WebView plays what phones make, H.264 and HEVC in mp4 or
 *  mov) and a still beside it (stills.js). They're in Photos and its albums like any photo (docs/photos.md, "Videos"). */
export const VIDEO = /\.(mp4|mov|m4v)$/i;
export const MEDIA = /\.(jpe?g|png|webp|gif|heic|mp4|mov|m4v)$/i;
/** The biggest video kept (about a minute or two from a phone); bigger ones are refused, never cut. */
export const MAX_VIDEO = 80e6;
export const MAX_PICTURE = 25e6;
/** A video's file type from its first bytes (an ISO media file has "ftyp" at byte 4: 'qt' is QuickTime), or null. */
export const videoKind = (bytes) => (bytes?.length > 12 && bytes.toString('latin1', 4, 8) === 'ftyp' ? (bytes.toString('latin1', 8, 10) === 'qt' ? '.mov' : '.mp4') : null);
export const REPEATS = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly'];
/** How far the calendar reaches, in days: a year back and 18 months ahead (the Calendar app's steps, a range read). */
export const REACH = { back: 366, ahead: 549 };
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

// What the household's apps put on the calendar (day-notes.js): how each shows ('week': the Calendar's week and Today;
// 'today': Home only, where a new one starts, so the week never changes without someone choosing; 'off').
export const SHOWS = ['week', 'today', 'off'];
export const NIGHT = { from: '21:30', to: '06:30' };

// ---- dates (the display's own time zone) ----
import { pad, dayKey } from '../dates.js';
export { pad, dayKey, daysFrom, midnightAfter } from '../dates.js';
export const wholeDays = (ms) => Math.max(1, Math.round(ms / DAY));
// For a model: a time in the household's clock with its offset ("2026-11-22T13:00-05:00"); the stored UTC one
// ("…T18:00:00.000Z") reads as 6 PM for a 1 PM practice. An all-day one is its day (an end: the last day it's on).
export const localWhen = (s, allDay, end = false) => {
  const d = new Date(s); if (!s || isNaN(d) || /^\d{4}-\d{2}-\d{2}$/.test(String(s))) return s;
  if (allDay) return dayKey(end ? new Date(d - 1) : d);
  const o = -d.getTimezoneOffset();
  return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}${o < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`;
};
export const inLocal = (e) => (e?.start ? { ...e, start: localWhen(e.start, e.allDay), ...(e.end ? { end: localWhen(e.end, e.allDay, true) } : {}) } : e);
export const validDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T12:00:00'));
export const hhmm = (s, d) => (/^\d{1,2}:\d{2}$/.test(String(s || '')) ? String(s).padStart(5, '0') : d);
export const minutes = (s) => +s.slice(0, 2) * 60 + +s.slice(3, 5);
export const daysBetween = (a, b) => Math.round((new Date(dayKey(b) + 'T12:00') - new Date(dayKey(a) + 'T12:00')) / DAY);

// ---- what the apps and tools send ----
export const str = (v, n = 100) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);
/** Objects given as one or a list (the tools' arrays of changes). */
export const objs = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).filter((x) => x && typeof x === 'object');
/** Text that keeps its lines (a recipe's notes). */
export const keepLines = (v, n) => String(v ?? '').replace(/\r/g, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);
export const same = (a, b) => str(a).toLowerCase() === str(b).toLowerCase();
export const low = (who) => str(who, 40).toLowerCase();
export const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).map((x) => str(x)).filter(Boolean);
/** A refusal (an { error } answer) in work done in the background: thrown, so its mealWork says why. */
export const must = (r) => { if (r?.error) throw new Error(r.error); return r; };
/** A chore's or a routine step's picture, guessed from its words (a star when nothing fits). */
export function guessPic(t) {
  const s = str(t).toLowerCase();
  const hit = [['plant', /plant|weed|garden|flower|lawn|mow/], ['trash', /trash|garbage|recycl|bins?\b|compost/], ['laundry', /laundry|fold|socks|hamper/],
    ['broom', /sweep|vacuum|mop|floor|broom|dust/], ['plate', /dish|dishwasher/], ['teeth', /teeth|brush/], ['shirt', /dress|clothes|shirt|pajama|pyjama|pj/], ['shoes', /shoe|sock/], ['backpack', /backpack|bag|school/],
    ['bed', /bed|sleep|lights/], ['bath', /bath|shower|wash up/], ['book', /read|book|homework/], ['plate', /breakfast|eat|dinner|lunch|table/],
    ['hands', /hands|wash/], ['hair', /hair|comb/], ['toys', /toy|tidy|clean up|pick up/], ['cup', /water|drink|milk/], ['coat', /coat|jacket/],
    ['pet', /cat|dog|pet|fish/], ['sun', /wake|up|morning/], ['moon', /night/]].find(([, re]) => re.test(s));
  return hit ? hit[0] : 'star';
}

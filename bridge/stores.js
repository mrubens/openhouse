// Every whole-file store the bridge keeps, declared once: where it lives, whether it is the household's own data (so
// it goes in backups, backup-format.js INCLUDE is made from this list), whether a save keeps the version it replaces
// as <file>.bak, and the shape's schema version with how an older shape is brought up to it.
//
// path: relative to the data folder (the display folder: chats/ is beside household.json), or bridge/... for the
// bridge's own folder. dir: a folder, backed up (or not) whole.
// backup: the household's data. A store under a backed-up folder is backed up with it unless it says backup: false
// (a cache that is read again by itself), and then the backup leaves it out.
// bak: a save keeps the replaced version as <file>.bak (store.js). Keys and grants don't: a key or a grant taken
// back must not come back from a spare copy.
// version / migrate(old, fromVersion): the shape's schema version. A file carries it as "$v" in its top-level object
// once it is past 0 (store.js adds it on save and takes it out on read, so readers never see it); a file without
// one is version 0. A file read at an older version is passed through migrate first; one at a NEWER version (saved
// by a later release, then the tablet went back to its rescue build) is read as it is, best-effort, and never
// written over with this code's older shape: store.js refuses every save to it. A store whose top level is an
// array has no room for "$v": its first version past 0 makes it an object (migrate gets the array).
//
// Calling a store: `const FILE = registered('later', path.join(DIR, '../later.json'))` ties that path (wherever a
// test or a dev bridge puts it) to the declaration; a path nobody tied is matched against where the declaration
// lives in the data folder, so a caller still passing the raw path gets the same rules.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE = path.dirname(fileURLToPath(import.meta.url));

// copy(value): what a backup holds of a store at the top of the data folder, when that isn't the whole file: the
// parsed file in, the backup's copy out (backup-format.js pack). A TV's pairing is this device's own, like a key.
const devicesCopy = (db) => ({ ...db, pairing: Object.fromEntries(Object.entries(db?.pairing || {}).map(([id, p]) => {
  const { token, clientKey, ...rest } = p && typeof p === 'object' ? p : {};
  return [id, rest];
})) });

// shape: what the file's readers count on (store.js readJson reads a file of the wrong shape as the nearest right one,
// so none of them stops the bridge on it): {} an object, {key: shape} with those keys' shapes, {'*': shape} every
// value's; [] a list, [shape] of those. A JSON store with none is an object at its top.
const HOUSE = {
  lists: [{ items: [{}] }], done: { '*': [''] }, by: {}, skipped: { '*': [''] }, meals: { '*': {} }, recipes: { '*': {} }, mealSlots: [],
  events: [{}], countdowns: [], reminds: {}, whose: { '*': {} }, reminded: [], rewards: [{}], spent: {}, asks: [{}], got: [{}],
  checklists: [{ steps: [{}] }], checked: { '*': [''] }, favorites: [], mealCounts: { '*': {} }, settings: {}, albums: [{ photos: [] }],
  captions: {}, earned: {},
};

/** @type {{name: string, path: string, dir?: boolean, backup: boolean, bak?: boolean, text?: boolean, version?: number, migrate?: (old: any, from: number) => any, copy?: (v: any) => any, shape?: any, why?: string}[]} */
export const STORES = [
  // --- the household's own, in every backup (in this order) ---
  { name: 'webapp', path: 'webapp', dir: true, backup: true, why: "the family's apps, with their git history" },
  { name: 'chats', path: 'chats', dir: true, backup: true, why: 'conversations, the home screen, the board' },
  { name: 'household', path: 'household.json', backup: true, bak: true, shape: { family: [{}], routines: [{}], events: [{}], chores: [{}], places: [{}] }, why: 'family, chores, calendars, places' },
  { name: 'house', path: 'house.json', backup: true, bak: true, shape: HOUSE, why: 'lists, chores done, meals, photos' },
  { name: 'photos', path: 'photos', dir: true, backup: true },
  { name: 'appdata', path: 'appdata', dir: true, backup: true, why: "apps' own data" },
  { name: 'devices', path: 'devices.json', backup: true, bak: true, shape: { devices: [{}], recipes: {}, pairing: { '*': {} }, certs: {} }, why: "the house's devices and their recipes", copy: devicesCopy },
  { name: 'agent-model', path: 'agent-model.json', backup: true, bak: true, why: 'the chosen model (older devices)' },
  { name: 'preferences', path: 'preferences.md', backup: true, bak: true, text: true, why: 'what the assistant learned' },
  { name: 'heartbeat', path: 'heartbeat.json', backup: true, bak: true, shape: { handled: {}, log: [], findings: [], notesFor: {}, judgedAt: [] }, why: "the heartbeat's notes" },
  { name: 'flyers', path: 'flyers', dir: true, backup: true, why: 'scanned flyers' },
  { name: 'mail', path: 'mail.json', backup: true, bak: true, shape: { senders: [], held: [], recent: [], notes: [], counts: {} }, why: "email's approved senders (not the messages, mail/)" },
  { name: 'later', path: 'later.json', backup: true, bak: true, shape: { items: [{}] }, why: 'reminders and follow-ups' },
  { name: 'calendar-sync', path: 'calendar-sync.json', backup: true, bak: true, shape: { calendars: { '*': {} }, outbox: [{}], cache: { '*': {} }, notes: { '*': {} }, errors: {}, accounts: [{}], reads: {} }, why: 'the calendars chosen, changes not yet sent' },
  { name: 'things', path: 'things.json', backup: true, bak: true, shape: { items: [{}], gone: {} }, why: 'the things on Home' },
  { name: 'alarms', path: 'alarms.json', backup: true, bak: true, shape: { alarms: [{}] }, why: 'the alarm clocks' },
  { name: 'day-notes', path: 'day-notes.json', backup: true, bak: true, shape: { byApp: { '*': { items: [{}], events: [{}] } }, first: {} }, why: 'what apps put on the calendar' },
  // in chats/, backed up with it
  { name: 'board', path: 'chats/board.json', backup: true, bak: true },
  { name: 'home-screen', path: 'chats/door.json', backup: true, bak: true, shape: { notes: [{}], trash: [{}], boardNotes: [{}], places: { '*': {} }, timers: [{}], sketch: { strokes: [] }, widgets: {} }, why: "the home screen's look" },
  { name: 'days', path: 'chats/days.json', backup: true, bak: true, shape: { days: { '*': {} } }, why: 'the last days, remembered' },

  // --- read again by itself: never in a backup ---
  { name: 'calendar', path: 'calendar.json', backup: false, bak: false, shape: { events: [{}], errors: {}, labels: [] }, why: "the calendars' events, fetched again" },
  { name: 'calendar-only', path: 'calendar-only.json', backup: false, bak: false, shape: { '*': {} }, why: 'verdicts made again' },
  { name: 'heartbeat-fixes', path: 'heartbeat-fixes.json', backup: false, bak: true, shape: [{}], why: "the heartbeat's waiting fixes" },
  { name: 'maps', path: 'chats/maps.json', backup: false, bak: false, shape: { geo: {}, routes: {} }, why: 'places looked up, a cache' },
  { name: 'weather-sense', path: 'chats/weather-sense.json', backup: false, bak: false, shape: { lines: [{}], runs: {} }, why: 'made again from the forecast' },
  { name: 'voice-mic-level', path: 'chats/voice-mic-level.json', backup: false, bak: false, why: "the mic's usual level" },
  { name: 'voice', path: 'voice', dir: true, backup: false, why: 'the wake model, downloaded again' },

  // --- what the microphone heard and what was said, kept on this device only: never in a backup ---
  { name: 'voice-clips', path: 'chats/voice-clips', dir: true, backup: false, why: 'seconds around each wake, when the household chose that' },
  { name: 'voice-rec', path: 'chats/voice-rec', dir: true, backup: false, why: "a test recording of the microphone" },
  { name: 'voice-log', path: 'chats/voice-log.jsonl', backup: false, text: true, why: 'the speech log' },
  { name: 'voice-log-old', path: 'chats/voice-log.jsonl.1', backup: false, text: true, why: "the speech log's older half" },
  { name: 'voice-wakes', path: 'chats/voice-wakes.jsonl', backup: false, text: true, why: 'when it woke' },
  { name: 'voice-wakes-old', path: 'chats/voice-wakes.jsonl.1', backup: false, text: true, why: 'when it woke, older' },
  { name: 'talk', path: 'chats/talk', dir: true, backup: false, why: "what was said, until it's summed up in days.json" },

  // --- keys, pairings, credentials: this tablet's alone, never in a backup ---
  { name: 'cloud', path: '.cloud', dir: true, backup: false, why: "the device's cloud credential and its keys" },
  { name: 'relay', path: '.cloud/relay.json', backup: false, bak: false },
  { name: 'mail-key', path: '.cloud/mail-key.json', backup: false, bak: false },
  { name: 'backup-keys', path: '.backup', dir: true, backup: false, why: "the backups' key and state" },
  { name: 'tailscale', path: '.tailscale', dir: true, backup: false, why: "the device's Tailscale node (its key), when it's on" },
  { name: 'tailscale-bin', path: '.tailscale-bin', dir: true, backup: false, why: "Tailscale's own build, downloaded again" },
  { name: 'bridge', path: 'bridge', dir: true, backup: false, why: 'the bridge, its secret, pairings and keys' },
  { name: 'undo', path: 'bridge/undo.json', backup: false, bak: true, shape: [{}], why: "the undo list of this device's apps" },
  { name: 'screens', path: 'bridge/screens.json', backup: false, bak: false, shape: { screens: [{}], invites: [{}] }, why: 'paired phones and screens' },
  { name: 'push', path: 'bridge/push.json', backup: false, bak: false, why: "the device's push keys" },
  { name: 'web-mcp', path: 'bridge/web-mcp.json', backup: false, bak: false, shape: { clients: { '*': {} }, grants: { '*': {} } }, why: "computers' grants" },
  { name: 'workshop-open', path: 'bridge/workshop-open.json', backup: false, bak: true, shape: { '*': {} }, why: "computers' open changes" },
];

const byName = new Map(STORES.map((s) => [s.name, s]));
if (byName.size !== STORES.length) throw new Error('stores.js: two stores share a name');

/** The data folder: where household.json is (chats/ is in it). */
const dataDir = () => path.resolve(process.env.CHAT_DIR || path.join(BRIDGE, '../chats'), '..');
const home = (s) => (s.path === 'bridge' || s.path.startsWith('bridge/') ? path.join(BRIDGE, s.path.slice('bridge'.length)) : path.join(dataDir(), s.path));

const tied = new Map(); // absolute path -> store, from registered()

/** Tie this path to the named store (wherever it is: a test's folder, a dev bridge's scratch); returns the path. */
export function registered(name, file) {
  const s = byName.get(name);
  if (!s) throw new Error(`stores.js: no store named ${name}`);
  tied.set(path.resolve(file), s);
  return file;
}

/** The store a file belongs to: the one it was tied to, else the one declared at that place in the data folder. */
export function storeOf(file) {
  const f = path.resolve(file);
  const t = tied.get(f);
  if (t) return t;
  for (const s of STORES) if (!s.dir && home(s) === f) return s;
  return null;
}

export const storeNamed = (name) => byName.get(name) || null;

/** What a backup holds: the backed-up stores at the top of the data folder (the rest are in a backed-up folder). */
export const backedUp = () => STORES.filter((s) => s.backup && !s.path.includes('/')).map((s) => s.path);
/** Inside the backed-up folders, what a backup leaves out (caches). */
export const leftOutOfBackups = () => STORES.filter((s) => !s.backup && s.path.includes('/') && STORES.some((d) => d.dir && d.backup && s.path.startsWith(d.path + '/'))).map((s) => s.path);

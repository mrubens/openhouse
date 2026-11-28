// What Opie may do during a turn that comes from a share from someone's phone (phone-share.js). What was shared is
// someone else's page, message or photo, and it can say anything ("add these", "delete that"), so this is enforced
// here, in code, not left to the instructions: an event it finds is offered on the Calendar to tick (house/flyers.js
// offerShared, as an email's are), never added; things go onto a list (adding only) and a recipe into Recipes; a photo
// into Photos; a calendar or album link goes to the device, where a person says yes. Looking is fine. Nothing else.
//
// share: the turn's {id, who, text, image?, type?, at, offered, did: []} (chat.js puts it in the turn's context);
// offered counts the events offered this turn, for the reply on the phone; did lists what else went where.

/** Tools that only look. */
const LOOK = new Set(['family_things', 'about_household', 'look_at_notes', 'flyer_photo', 'weather', 'read_page', 'list_changes', 'end_conversation', 'look_at_plugin', 'list_plugins']);
/** Tools that act and may: each asks a person on the device, or only adds. */
const MAY = new Set(['keep_shared_photo', 'save_recipe', 'add_calendar', 'add_photo_album', 'change_list', 'calendar_event']);

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const NOT = 'Not from something shared from a phone: from a share, events are only offered on the Calendar to tick, ' +
  'things only go onto a list, recipes into Recipes and photos into Photos. Tell them what you found; they can ask you for the rest themselves.';

/**
 * Before a tool runs in a share's turn: null to let it run as it is, {args} to run it with these instead, or {result}
 * (it doesn't run); did: what it put where, once it has run without an error (for share.did). offer(events, share) -> {offered} | {error} (house.offerShared).
 */
export function shareGate(name, args, share, { offer }) {
  if (!share) return null;
  const a = args && typeof args === 'object' ? args : {};
  if (LOOK.has(name)) return null;
  if (!MAY.has(name)) return { result: text(NOT, true) };
  if (name === 'change_list') {
    const add = Array.isArray(a.add) ? a.add.filter((x) => typeof x === 'string' && x.trim()) : [];
    if (!add.length) return { result: text(NOT, true) };
    return { args: { list: a.list, add }, did: `${add.length === 1 ? add[0] : `${add.length} things`} onto ${a.list || 'Groceries'}` }; // (adding only: no check, remove, edit or clear)
  }
  if (name === 'save_recipe') return { did: 'the recipe into Recipes' };
  if (name === 'keep_shared_photo') return { did: 'the photo into Photos' };
  if (name === 'calendar_event') {
    const evs = [a.add, ...(Array.isArray(a.events) ? a.events : [])].filter((e) => e && typeof e === 'object');
    if (!evs.length) return { result: text(NOT, true) };
    const r = offer(evs, share);
    if (r.error) return { result: text(r.error, true) };
    share.offered = (share.offered || 0) + r.offered;
    return { result: text(`Offered on the Calendar to tick (${r.offered === 1 ? 'it is' : 'they are'} not added: someone ticks what they want). ` +
      'Their phone shows how many are waiting and opens them, so say plainly what you found and don\'t count them.') };
  }
  return null; // add_calendar, add_photo_album: a person says yes on the device
}

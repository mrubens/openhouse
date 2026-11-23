// Opie using the tablet's other Android apps for someone (docs/device-control.md): open one, install one, and work it
// by reading the screen and tapping or typing, through the shell's device server (DeviceServer.kt: Android
// accessibility, with the floating face showing where it acts and a Stop button). For OpenAI's live voice (its
// backend calls these: live-tools.js) and the typed assistant (agents/cloud.js), the same tools.
//
// The rules that matter live in the shell, where nothing here can change them: it never taps a finishing button (pay,
// place order, buy, send, delete account), never types into a password or card field, never sends what it typed, never
// opens Settings or a store, and does nothing unless someone turned on "Opie uses apps" (Settings, This tablet, behind
// the lock when it's on). This side adds its own limits (how many steps, card numbers in what it types) and stops at
// once when someone says "stop".
//
// Every action goes to the speech log (the shell logs it too, with what came of it).

export const DEVICE_NAMES = ['open_app', 'install_app', 'look_at_screen', 'tap', 'type', 'pick', 'scroll', 'stop_using_apps', 'press', 'look_with_camera'];

/** Opie looking at something through the tablet's camera. The tablet asks on screen every time, and only a person's
 *  Allow opens it (the shell's CameraLook: Opie's screen tools can't see or tap that sheet). The one picture goes from
 *  the shell, in memory, to the household's own cloud AI (describe) and is kept nowhere. */
export const CAMERA_TOOL = { name: 'look_with_camera', description: 'Look at something someone holds up to the tablet\'s camera: "look at this", "what is this?", "what does this say?", ' +
    'a flyer or school notice (its events), a recipe card, a shelf or pantry (what is on it). The tablet asks them on screen and only they can allow it; then it takes one picture. ' +
    'Answers with what the picture shows, as the question asked.',
  inputSchema: { type: 'object', required: ['why', 'question'], properties: {
    why: { type: 'string', description: 'One short line the screen shows them, saying why: "To read the school flyer", "To see what is on the shelf"' },
    question: { type: 'string', description: 'What to find out from the picture: "What is this?", "Read the text", "The events on this flyer, with dates and times", "The recipe\'s ingredients and steps", "The food items on these shelves"' } } } };

const NEVER = 'It never taps a button that pays, places an order, buys, sends a message or posts, or deletes an account, and never types a password or card details: ' +
  'it stops at that last screen and asks the person to tap it themselves (those taps are refused anyway).';

export const DEVICE_TOOLS = [
  { name: 'open_app', description: 'Open one of the tablet\'s Android apps by name ("DoorDash", "Clock", "Calculator"), to use it for someone. ' +
      'Not for OpenHouse\'s own tabs and apps (Calendar, Lists, the Map...): show_on_screen opens those. Afterwards: what is on its screen (numbered elements). Back on the family screen with press home. ' + NEVER,
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string', description: 'The app\'s name, as on its icon' } } } },
  { name: 'install_app', description: 'Add an Android app to the tablet from Google Play (through Aurora Store, no Google account), by name. ' +
      'Ask them first in a few words ("Install DoorDash from the Play Store?") and call with confirmed true only after they said yes; the tablet ' +
      'also asks on screen (with the PIN when the lock is on). It takes a minute or two; then open_app opens it.',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string', description: 'The app\'s name' }, package: { type: 'string', description: 'Its package, only if you know it' }, confirmed: { type: 'boolean', description: 'They said yes to installing it' } } } },
  { name: 'look_at_screen', description: 'What is on the tablet\'s screen now (OpenHouse\'s own tabs and apps, or another app you opened): numbered elements with their text, what can be done ' +
      'with each (tap, type, scroll) and where. picture: also a short description of a picture of it, for pictures, maps or games the list can\'t ' +
      'show. wait: seconds to wait first for something to load (up to 10). The actions already answer with the screen afterwards, so look only when unsure.',
    inputSchema: { type: 'object', properties: { picture: { type: 'boolean' }, wait: { type: 'number' } } } },
  { name: 'tap', description: 'Tap an element by its number from the latest screen, or a point (x, y). Long-press with long. ' +
      'Something hard to take back on OpenHouse\'s own screen (deleting, removing, resetting) answers "ask them first": ask in a few words, and once they say yes, tap again with confirmed true. ' + NEVER +
      ' Answers with the screen afterwards.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' }, x: { type: 'number' }, y: { type: 'number' }, long: { type: 'boolean' }, confirmed: { type: 'boolean', description: 'They said yes to this one, just now' } } } },
  { name: 'type', description: 'Type into a text field (by its number, or the one in focus). submit true presses the keyboard\'s search or enter key, ' +
      'only in a search box: a message, review or form is written but never sent (the person sends it). Never a password or card details.',
    inputSchema: { type: 'object', required: ['text'], properties: { id: { type: 'integer' }, text: { type: 'string' }, submit: { type: 'boolean' } } } },
  { name: 'pick', description: 'Choose an option in a dropdown (a select: on the screen it says "a menu pop up button", or "now:" with its choice in some apps): its element number and the option as it reads ("Alex"). It opens the list, finds the option and taps it, in OpenHouse or another app; if there\'s no such option, it says which there are and closes the list. Use it rather than tapping a dropdown open.',
    inputSchema: { type: 'object', required: ['id', 'option'], properties: { id: { type: 'integer' }, option: { type: 'string' } } } },
  { name: 'scroll', description: 'Scroll the screen (or element id) up, down, left or right, to find more. Answers with the screen afterwards.',
    inputSchema: { type: 'object', required: ['direction'], properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, id: { type: 'integer' } } } },
  { name: 'stop_using_apps', description: 'Stop what you are doing on the screen or in an app at once, when someone wants you to stop. Nothing more happens there until their next request.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'press', description: 'back: the app\'s Back. home: back to the family\'s own screen (do this when you are done, unless they want to finish in the app).',
    inputSchema: { type: 'object', required: ['key'], properties: { key: { type: 'string', enum: ['back', 'home'] } } } },
];

/** What the assistant is told about using apps, after the household's rules (live-tools.js, chat.js). */
export const DEVICE_RULES = `\n\n---\n\nUSING THE SCREEN AND THE TABLET'S APPS
Anything a person can do on OpenHouse by tapping, you can do when they ask: every tab and app and its buttons, the sidebar's buttons (typing to you, sleep, tabs and look, Settings), timers, and Settings itself. Your limits are a person's.
- Use a direct tool when there is one: the household tools for the family's things (lists, calendar, chores, meals, notes), timer for timers, show_on_screen to put the screen on a tab or app ("open the calendar", "show me the map"). For anything else on the screen, look_at_screen, then tap, type, pick (a dropdown) or scroll, like a person would.
- Other Android apps: open_app, install_app, then the same look_at_screen, tap, type, scroll, press ("open DoorDash and reorder last Friday's pizza").
- Before anything hard to take back or that reaches outside the house (deleting the household's things, installing, buying, sending), ask in a few words first ("Delete the Groceries list?") and go on only once they say yes.
- A PIN is only ever typed by a person: when one is asked for (Settings with the lock on), say it needs their PIN and stop; you never enter it or get round it. A few controls are a person's own (Opie uses apps, Device control, leaving kiosk mode, Android settings, adding a calendar or album someone sent): those taps are refused, so say it's theirs to tap.
- The floating face shows each step as you go; say what you're about to do in a few words first ("Opening Settings"), and at the end say where it got to.
- Work from the screen the actions give back: find the element, tap it by its number. Don't guess what's on it.
- ${NEVER} At that screen, stop and say what's ready ("Your pizza from Tony's is in the cart for $24: tap Place order when you're happy with it"). Paying, ordering, sending and confirming are always theirs.
- If an app asks someone to sign in, or for anything you don't know, stop and ask them. If something is refused, don't try another way: say so.
- If they want you to stop, call stop_using_apps at once.
- To look at something they show you ("look at this", "what does this say?"), use look_with_camera. Never look_at_screen for that: it shows the screen, not the room. The tablet asks them on screen first, so say so in a few words as you call it ("Tap Allow on the screen, then hold it up"); if they cancel or don't answer, say so in a few words and leave it. Then act on what it found with your usual tools, asking first as always: calendar_event for a flyer's events (say what you found, then add them once they say yes), change_list for things to buy or keep, set_meals recipes to save a recipe (by its name, with its ingredients and steps as notes: it shows in Recipes).`;


const CARD = /(?:\d[ -]?){13,19}/g;
function luhn(d) { let s = 0; [...d].reverse().forEach((c, i) => { let n = +c; if (i % 2) { n *= 2; if (n > 9) n -= 9; } s += n; }); return s % 10 === 0; }
/** Text with what looks like a card number in it. */
export const hasCardNumber = (t) => (String(t || '').match(CARD) || []).some((m) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d); });

/**
 * server(): {url, auth} of the shell's device MCP server (chat.js deviceServer), or null on a laptop.
 * describe(picture: base64 JPEG, question): a few lines about a screenshot, from the cloud's text model (agents/cloud.js answer), or throws.
 * log(kind, data): the speech log (voice.js).
 */
export function deviceTools({ server = () => null, describe = null, log = () => {}, fetchImpl = (...a) => fetch(...a), maxSteps = 60, perMinute = 40, clock = () => Date.now() } = {}) {
  let fresh = true, steps = 0, halted = null;
  const recent = []; // when each action was, the last minute
  let id = 1;
  async function rpc(method, params = {}, timeoutMs = 30e3) {
    const d = server();
    if (!d) throw Object.assign(new Error('no device server'), { code: 'none' });
    const r = await fetchImpl(d.url, { method: 'POST', headers: { authorization: d.auth, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'device server error');
    return j.result;
  }
  const textOf = (res) => (res?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const short = (t, n = 5000) => (t.length > n ? t.slice(0, n) + '\n(the rest of the screen left out)' : t);
  /** The shell's own call; a new request first clears an earlier stop (MCP initialize). */
  async function shell(name, args, timeoutMs) {
    if (fresh) { await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'opie', version: '1' } }); fresh = false; }
    return rpc('tools/call', { name, arguments: args }, timeoutMs);
  }
  async function base(d) { return d ? d.url.replace(/\/mcp$/, '') : null; }

  async function call(name, args = {}) {
    log('device-tool', { name, args: { ...args, ...(args.text ? { text: String(args.text).slice(0, 80) } : {}) } });
    console.log(`[device] ${name} ${JSON.stringify(args).slice(0, 200)}`);
    if (name === 'stop_using_apps') { await stop('Someone asked Opie to stop.'); return { text: 'Stopped. Say so in a few words.', isError: false }; }
    if (halted) return { text: `Stopped: ${halted} Don't continue; say in a few words that you stopped.`, isError: true };
    if (!server()) return { text: 'This tablet can\'t use its other apps from here (no device control).', isError: true };
    const t = clock();
    while (recent.length && t - recent[0] > 60e3) recent.shift();
    if (recent.length >= perMinute) return { text: 'That\'s a lot of steps in a minute. Stop here and tell them where it got to.', isError: true };
    if (++steps > maxSteps) return { text: `That's ${maxSteps} steps for one request. Stop here, say where it got to, and let them take over.`, isError: true };
    recent.push(t);
    if (name === 'type' && hasCardNumber(args.text)) return { text: 'Not done: Opie never types card details. Ask them to type it themselves.', isError: true };
    try {
      switch (name) {
        case 'open_app': return out(await shell('open_app', { name: String(args.name || '') }, 120e3));
        case 'install_app': {
          if (args.confirmed !== true) return { text: `Ask them first, by name: install ${args.name || 'it'} from the Play Store? Then call again with confirmed true once they say yes.`, isError: false };
          return out(await shell('install_app', { name: String(args.name || ''), ...(args.package ? { package: String(args.package) } : {}) }, 6 * 60e3), 2000);
        }
        case 'look_at_screen': {
          const wait = Math.max(0, Math.min(10, Number(args.wait) || 0));
          const r = wait ? await shell('wait', { seconds: wait }, 20e3) : await shell('screen', {});
          if (r.isError) return out(r);
          let text = short(textOf(r));
          const labelled = (text.match(/"[^"]+"/g) || []).length;
          if (args.picture === true || labelled < 4) text += await picture();
          return { text, isError: false };
        }
        case 'tap': {
          const a = {}; for (const k of ['id', 'x', 'y']) if (args[k] != null && Number.isFinite(Number(args[k]))) a[k] = Number(args[k]);
          if (args.long === true) a.long = true;
          if (args.confirmed === true) a.confirmed = true;
          if (a.id == null && (a.x == null || a.y == null)) return { text: 'Give the element\'s number from the screen (or x and y).', isError: true };
          return out(await shell('tap', a, 120e3));
        }
        case 'type': {
          const a = { text: String(args.text ?? '') }; if (Number.isFinite(Number(args.id)) && args.id != null) a.id = Number(args.id); if (args.submit === true) a.submit = true;
          return out(await shell('type', a, 30e3));
        }
        case 'pick': return out(await shell('pick', { id: Number(args.id), option: String(args.option || '') }, 30e3));
        case 'scroll': return out(await shell('scroll', { direction: String(args.direction || 'down'), ...(args.id != null ? { id: Number(args.id) } : {}) }));
        case 'press': return out(await shell('key', { key: args.key === 'home' ? 'home' : 'back' }));
        case 'look_with_camera': return await camera(args);
        default: return { text: `${name} isn't a device tool.`, isError: true };
      }
    } catch (e) {
      return { text: e.code === 'none' ? 'This tablet can\'t use its other apps from here.' : `The tablet didn't answer (${e.cause?.code || e.message}).`, isError: true };
    }
  }
  function out(r, n) { const text = short(textOf(r) || (r?.isError ? 'That didn\'t work.' : 'Done.'), n); log('device-result', { text: text.slice(0, 300), isError: !!r?.isError }); return { text, isError: !!r?.isError }; }
  /** A small picture of the screen, described by the cloud's text model in a few lines (the voice's tools take text). */
  async function picture() {
    if (!describe) return '';
    try {
      const r = await shell('look', { scale: 4 }, 30e3);
      const img = (r?.content || []).find((c) => c.type === 'image');
      if (!img) return '';
      const d = await describe(img.data, 'This is a screenshot of an Android tablet, at a quarter of its size. In at most 8 short lines: which app and screen it is, ' +
        'what it shows, and where the things someone would tap are (as screen coordinates: multiply what you see by 4). No advice.');
      return `\n\nThe picture shows:\n${String(d).slice(0, 1500)}`;
    } catch (e) { return `\n\n(No picture: ${e.message})`; }
  }
  /** look_with_camera: the shell asks on screen and, after a person's Allow, takes one picture (DeviceServer /camera);
   *  the cloud's text model answers the question about it. The picture is never written down, here or on the tablet. */
  async function camera(args) {
    if (!describe) return { text: 'Looking through the camera needs the household\'s cloud assistant, and it isn\'t on.', isError: true };
    const why = String(args.why || '').replace(/\s+/g, ' ').trim().slice(0, 140) || 'To look at something for you.';
    const question = String(args.question || '').trim().slice(0, 600) || 'What is this?';
    const d = server();
    const r = await fetchImpl((await base(d)) + '/camera', { method: 'POST', headers: { authorization: d.auth, 'content-type': 'application/json' },
      body: JSON.stringify({ why }), signal: AbortSignal.timeout(200e3) });
    let j = await r.json();
    if (!j?.jpeg) return { text: `No picture: ${j?.no || 'the camera didn\'t answer.'} Say so in a few words; ask again only if they want.`, isError: true };
    const day = new Date(), today = `${day.toLocaleDateString('en-CA')} (${day.toLocaleDateString('en-US', { weekday: 'long' })})`;
    try {
      const said = await describe(j.jpeg, `Someone held this up to their household tablet's camera and asked: "${question}". Today is ${today}.\n` +
        'Answer that about the picture, in plain text, briefly. Text they want read: as written. Events (a flyer, school notice, invitation, schedule): each one\'s title, ' +
        'date (YYYY-MM-DD; with no year given, the next time that date comes), start and end times, place, and notes such as what to bring or cost. A recipe: its name, ' +
        'ingredients with amounts, and steps. Things on a shelf or in a pantry: each one by name. If you can\'t make it out, say what you can see and that it\'s unclear.');
      return { text: `The camera's picture shows:\n${String(said).slice(0, 4000)}`, isError: false };
    } catch (e) { return { text: `The picture was taken, but your assistant couldn't look at it (${e.message}).`, isError: true }; }
    finally { j = null; }
  }
  /** Someone said something (by voice or typed): a new request, starting fresh. (Whether it means stop is the model's
   *  call: stop_using_apps. No words are matched here.) */
  function heard() { fresh = true; steps = 0; halted = null; return false; }
  async function stop(reason = 'Someone said stop.') {
    halted = reason; log('device-stop', { reason });
    const d = server(); if (!d) return;
    try { await fetchImpl((await base(d)) + '/halt', { method: 'POST', headers: { authorization: d.auth, 'content-type': 'application/json' }, body: JSON.stringify({ reason }), signal: AbortSignal.timeout(3e3) }); } catch {}
  }
  const available = () => !!server();
  return { tools: () => (available() ? [...DEVICE_TOOLS, ...(describe ? [CAMERA_TOOL] : [])] : []), names: DEVICE_NAMES, call, heard, stop, available, rules: () => (available() ? DEVICE_RULES : '') };
}

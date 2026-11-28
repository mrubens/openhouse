// The household's quick tools for OpenAI's live voice (openhouse-cloud/docs/cloud-beta.md: its backend calls these while it talks) and,
// with a few more (chat.js textTools), the cloud's text model for typed turns (agents/cloud.js). The home screen's tools
// (calendar, lists, chores and stars, routines, meals, notes, what the family told it) plus the weather, the TV and the
// apps' own voice actions, so the family's things stay in one place and whoever answers changes the same data. An app's
// code isn't among them: make_app hands a request to the tablet's own builder (rails.js), and anything bigger is
// someone's own Claude or ChatGPT on a computer (workshop.js).
//
//   GET  /live/setup   {instructions, tools: [{type:'function', name, description, parameters}], earlier, quietS?}
//                      (quietS: an app is in use hands-free, home-screen.js handsFree: the session stays this long after the last words)
//   POST /live/tool {name, args}  -> {text, isError}
//   POST /live/said {role: user|assistant|tool, text}   what a live conversation heard and said (the shell's LiveVoice)
//
// What was said lately, by voice or typed, and what the tools found, is kept here in memory for half an hour (never
// written down, never sent anywhere on its own), so a new conversation knows what was just talked about ("the event we
// just talked about"): /live/setup gives it as `earlier` (the live voice's own history) and in the instructions.
import fs from 'node:fs';
import path from 'node:path';
import { forModel, fromModel } from './tool-args.js';
import { readPage, READ_PAGE_TOOL } from './read-page.js';
import { asData, cutData } from './as-data.js';

/** The home screen's tools a voice may use: what a person can tap on the tablet without the PIN, and asking for what
 *  needs it (docs/opie-parity.md). Never an app's code directly (make_app asks the builder; a computer: workshop.js). */
export const LIVE_TOOLS = ['about_household', 'family_things', 'change_list', 'change_chores', 'change_rewards', 'change_routines', 'set_meals', 'save_recipe', 'keep_shared_photo',
  'calendar_event', 'look_at_notes', 'put_note', 'update_note', 'take_down_note', 'take_down_thing', 'today_card', 'remember_preference', 'forget_preference', 'show_on_map', 'save_place', 'forget_place', 'heartbeat_settings', 'night_hours', 'later', 'later_list', 'alarm',
  // the house rules (Settings → Voice → House rules): changing them asks for the PIN on the tablet when Settings does (house-rules.js)
  'house_rules',
  // a calendar or an iCloud album by its link (found with a web search, say: a team's schedule): the link goes straight to
  // the shell, and someone says yes on the tablet (calendar-links.js; an album with the PIN, a calendar without), so the voice can offer it, not force it
  'add_calendar', 'add_photo_album',
  // what the tapping can do too (docs/opie-parity.md): the photos, a flyer sent from a phone, the family list and
  // where they live (the Family sheet), the tabs and look ("Tabs and look"), and taking a change back when asked
  'photos', 'flyer_photo', 'update_household', 'set_home', 'put_back', 'list_changes', 'undo_change',
  // plugins (Settings' Plugins and Apps' Add apps, behind the PIN there): each add, update or removal asks on the tablet,
  // and a person types the PIN there (plugins.js)
  'find_plugins', 'look_at_plugin', 'list_plugins', 'add_plugin', 'update_plugin', 'remove_plugin'];
const WEATHER = { name: 'weather', description: "The weather where the family lives: now, the next 24 hours, and the next 7 days (°F, mph).", inputSchema: { type: 'object', properties: {} } };

/** Kitchen timers (the tablet rings them: home-screen.js timers), as a person sets them on the screen. */
export const TIMER_TOOL = { name: 'timer', description: 'Timers on the device (it rings them, and shows them): start one ("Pasta", 10 minutes), list them (running and finished), or cancel: that stops one ringing and clears it off the screen too. To cancel, no list first: with one timer, just cancel; otherwise by its label, or all.',
  inputSchema: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['start', 'list', 'cancel'] }, label: { type: 'string', description: 'For start: its name. For cancel: which one, by its name' }, all: { type: 'boolean', description: 'For cancel: every timer' }, minutes: { type: 'number' }, seconds: { type: 'number' }, endAt: { type: 'number', description: 'For cancel, optional: the exact one, from list' } } } };

/** Opie putting its own screen on a tab, or one of its apps (setScreen: the tabs and apps there are now). */
export function screenTool(places) {
  const list = places.map((p) => `${p.id} (${p.name}${p.tab ? ', a tab' : ', opens full screen'})`).join('; ');
  return { name: 'show_on_screen', description: 'Put the device\'s own screen on one of its tabs or apps, whatever is showing now: ' +
    'when someone asks to see, open or go to one of them. Then look_at_screen, tap, type and scroll work in it, to do what they asked there. The tabs and apps: ' + list + '.',
  inputSchema: { type: 'object', required: ['what'], properties: { what: { type: 'string', enum: places.map((p) => p.id), description: 'Which one, by its id' } } } };
}

/** A message to someone's phone, or everyone's (screens.js message: Web Push from the tablet itself): only to the
 *  people in the household's family list, by name, so the model picks one and never makes one up. */
export function messageTool(names) {
  return { name: 'message_family', description: 'Send a short message now to the phones of someone in the family, or of everyone: "tell Alex dinner\'s ready", ' +
    '"remind Maya to bring her lunch", "let everyone know we\'re leaving in 10 minutes". It goes to each phone that person paired with the device, and shows on their phone\'s page. ' +
    'It answers who got it and who has no phone paired or has notifications off: say so in a few words.',
  inputSchema: { type: 'object', required: ['to', 'text'], properties: {
    to: { type: 'string', enum: [...names, 'everyone'], description: 'Who, by name, or everyone' },
    text: { type: 'string', description: 'The message, short and as they said it, said to the person getting it: "Dinner\'s ready", "Bring your lunch", "We\'re leaving in 10 minutes"' },
    from: { type: 'string', enum: names, description: 'Who it\'s from, only when they said who they are' } } } };
}
const MESSAGE_NAME = 'message_family';

/** The voice's part of the instructions; the family's rules and the assistant's manner follow (CHAT.md, as the assistant gets them). */
/** A session the wake model opened (/live/setup?how=wake): it's often wrong at home (talk at dinner, the TV), so the
 *  session checks it was spoken to before saying anything (the user, 2026-11-21: the tablet "kept responding when they
 *  weren't talking to it"). */
export const wakeNote = (name) => `\n\n---\n\nThis conversation opened because the device thought it heard "Hey ${name}", and it is often wrong: ` +
  `people talking to each other, someone on a call, a TV or music, and what you hear can be written as "Hey ${name}" when it was other words. ` +
  'Before you say anything, decide from what you hear whether someone is asking you something. Answer only a clear, finished request to you, ' +
  `or "Hey ${name}" on its own (then just "Yes?"). Anything else (other talk, a sentence cut off or that sounds said to a person, the TV, nothing) is not for you: ` +
  'call go_away and say nothing at all, not even "Okay". When in doubt, stay silent: being quiet when wanted costs little, talking when not wanted bothers people.\n' +
  'What you get is a transcript of speech, and it is often misheard ("you put all that" for "can you put a"): read it generously, for what they most likely said. ' +
  'If the voice has already answered them (said it is on it, or anything back), it heard them speak to it: never call go_away then. Do what they most likely asked, ' +
  'or if you truly can\'t tell what, ask in a few words.';
export const livePreamble = (name, builds = false) => `You are ${name}, the voice of a household's Opie, on the screen they share at home. You talk with them out loud, so keep it short, warm and plain: ` +
  'one or two sentences, no lists or markdown. Use your tools for anything about the household (their calendar, lists, chores and stars, meals, notes, the weather) ' +
  'and never guess those. If you can\'t do something or don\'t know, say so plainly in a sentence; never answer a different question instead. Nobody\'s voice is recognised here, so "me" or "my name" doesn\'t say who is talking: if it matters, ask once who they are; once they\'ve said, use it and never ask again. ' +
  'Something behind the device\'s PIN isn\'t a reason to refuse: do it, and when the device asks for the PIN (a tool says so), tell them to type it on the device. Never ask them to say the PIN to you. ' +
  'Make each change once, then say it\'s done; don\'t repeat a call that worked. Something repeats only if they said so ("every Friday"). If someone talks over you, stop and listen. If people are talking to each other and not to you, stay quiet.\n\n' +
  'What follows is how the family\'s assistant works and what this family asked for. Follow it, except the parts about making or changing an app\'s code, ' +
  (builds ? 'which is make_app (the device makes it, it opens there to try, and someone there keeps it); ' : 'which isn\'t yours to do (someone does that from their computer); ') + 'the home screen\'s tabs and look are set_home.\n\n---\n\n';

/** Making or changing an app on the tablet itself (rails.js, through the builder), when the household has it on. */
export const MAKE_APP_TOOL = { name: 'make_app', description: 'Make a new app or game, or change one of the household\'s apps ("make the text on Chores bigger"), on the device itself: it takes a minute or two, the screen shows it working, then it opens there to try, and it goes in only when someone taps Keep it there (never you). Before you call it for a new app or game, ask about the details that would change what gets made (who it\'s for, what goes on it, how it should work or look), one short question at a time since this is spoken, until you know enough to make something they\'ll like; skip the questions when they\'ve already said, ask you to just make it, or the change is small. what: what they asked for, in their words, with what you know (who it\'s for, what it should do) and their answers. Each change they ask for is its own call, also while one is still being made (it waits its turn): never say you\'ve asked for something without calling this for it. Only an app\'s code: the family\'s things (lists, events, a countdown on the calendar, chores) and the tabs and look have their own tools.',
  inputSchema: { type: 'object', properties: { what: { type: 'string' } }, required: ['what'] } };

/** An app made on the tablet that nobody kept or turned down yet (build-waits.js): open to try again, as a tap on Home's line. */
export const ASK_AGAIN_TOOL = { name: 'try_made_app', description: 'An app or game the device made is waiting to be kept (Home says "… is ready to try"): open it on the device to try, with its bar to keep it or not. Only a person keeps it (Keep it, with the PIN when the device asks for one); you can\'t. app: its name.',
  inputSchema: { type: 'object', properties: { app: { type: 'string' } } } };

/** The TV, straight from the voice (no agent turn): devices/index.js tv(). Offered only when there's a TV to control. */
export const TV_TOOL = { name: 'tv', description: "The family's TV: turn it on or off, pause or play, volume, mute, open an app (Netflix, YouTube...), or what it's showing. Turning it on or opening an app asks the people in the room first.",
  inputSchema: { type: 'object', properties: { do: { type: 'string', enum: ['off', 'on', 'pause', 'play', 'volume_up', 'volume_down', 'mute', 'open_app', 'status'] }, app: { type: 'string', description: 'For open_app: the app by name' }, steps: { type: 'integer', description: 'For volume: how many steps (1-10)' }, tv: { type: 'string', description: 'Which TV, only when there are several' } }, required: ['do'] } };

/** Bluetooth devices, straight from the voice: devices/index.js bluetooth(). Offered on a tablet with Bluetooth. */
export const BT_TOOL = { name: 'bluetooth', description: "Bluetooth speakers, headphones and gadgets near the device: list or scan for them, pair one (the device asks the people here first), " +
    "play_here sends the device's sound (music, timers, your answers) to a paired speaker and stop_here brings it back, louder, quieter or set_volume while it plays there, " +
    "beep a tag to find it, status for paired or not, battery and readings, forget to unpair. To find a new speaker it must be on and in pairing mode.",
  inputSchema: { type: 'object', required: ['do'], properties: { do: { type: 'string', enum: ['list', 'scan', 'pair', 'play_here', 'stop_here', 'louder', 'quieter', 'set_volume', 'beep', 'stop_beep', 'status', 'forget'] },
    device: { type: 'string', description: 'Which one, by name (not needed when only one fits)' }, level: { type: 'integer', description: 'For set_volume: 0-100' } } } };

/** The tablet's volume, straight from the voice: devices/index.js volumeDo (one volume for music, timers and Opie). */
export const VOLUME_TOOL = { name: 'volume', description: "The device's volume (music, timers and your own voice): louder or quieter (a step), set to a level, mute, or get it. \"Turn it up\", \"too loud\", \"volume to 50\". " +
    'room_on or room_off: Adjust to the room (Settings → Screen → Volume), where your voice and the timers get a little louder in a noisy room and quieter in a quiet one and at night; music stays as set.',
  inputSchema: { type: 'object', required: ['do'], properties: { do: { type: 'string', enum: ['louder', 'quieter', 'set', 'mute', 'get', 'room_on', 'room_off'] }, level: { type: 'integer', description: 'For set: 0-100' } } } };
/** The tablet's own screen, straight from the voice: devices/index.js screenDo (the shell's /screen). Neither is behind
 *  the PIN on the tablet: Brightness is in Settings → Screen, Sleep now is the moon button. */
/** What acts on this tablet itself (its screen, speaker, camera, media and other apps): not offered to a conversation on
 *  another of the household's tablets (setupFor), which would have them act here, in another room. */
const ON_THIS_DEVICE = new Set(['look_with_camera', 'open_app', 'install_app', 'look_at_screen', 'tap', 'type', 'pick', 'scroll', 'stop_using_apps', 'press', 'tablet_screen', 'volume', 'music', 'bluetooth', 'pin_choices']);
export const SCREEN_TOOL = { name: 'tablet_screen', description: "The device's screen itself: its brightness (Automatic, Low, Medium, High or Full, or a step brighter or dimmer: \"it's too bright\", \"I can't see the screen\"), " +
    'or put it to sleep now, dark as at night until someone touches it ("go to sleep", "turn the screen off"). get says the brightness. For when the screen goes dark every night, that is night_hours.',
  inputSchema: { type: 'object', required: ['do'], properties: { do: { type: 'string', enum: ['get', 'brightness', 'sleep'] },
    level: { type: 'string', enum: ['Automatic', 'Low', 'Medium', 'High', 'Full', 'brighter', 'dimmer'], description: 'For brightness' } } } };
/** Music, audiobooks and podcasts in the tablet's media apps: devices/index.js mediaDo (the shell's /media, Media.kt). */
export const MUSIC_TOOL = { name: 'music', description: "Music, audiobooks and podcasts on the device, in its media apps (the ones someone added and signed in to): " +
    'search plays something (what, and which app by its name when they said or it matters; otherwise the app they last played from), ' +
    'play resumes, pause, next, previous, seek some seconds back (negative) or forward ("back 30 seconds"), stop, or status: what is playing and which media apps the device has. ' +
    'A book goes to an audiobook app, music to a music app; if the app they need isn\'t there, say so and offer to add it (install_app). ' +
    'Spotify plays on the device without its app coming up once someone signs in to Spotify in Opie: spotify_sign_in puts its sign-in page on the screen for them (Settings → Connections → Spotify does too).',
  inputSchema: { type: 'object', required: ['do'], properties: { do: { type: 'string', enum: ['status', 'search', 'play', 'pause', 'next', 'previous', 'seek', 'stop', 'spotify_sign_in'] },
    query: { type: 'string', description: 'For search: what to play, as they said it ("Abbey Road", "some jazz for dinner", "the second Harry Potter book")' },
    focus: { type: 'string', enum: ['artist', 'album', 'song', 'playlist', 'genre'], description: 'For search, only when it is clearly one of these' },
    app: { type: 'string', description: 'Which media app, by its name as on the device' }, seconds: { type: 'number', description: 'For seek: negative is back' } } } };
/** The house's other devices (speakers, streamers, printers...), as Settings' Devices buttons work them: devices/index.js devicesDo. */
export const DEVICES_TOOL = { name: 'home_devices', description: "The house's devices Opie found on the Wi-Fi and over Bluetooth (speakers, streamers, printers...), as Settings' Devices shows them: " +
    'list them with what each can do, then act: one of a device\'s actions (play, pause, volume_up, set_volume with params {"level": 20}, power_off...), or name one as the family calls it. ' +
    'Anything that turns on, opens or unlocks something asks the people in the room first. The TV, Bluetooth and the device\'s own volume have their own tools.',
  inputSchema: { type: 'object', required: ['do'], properties: { do: { type: 'string', enum: ['list', 'act', 'name'] },
    device: { type: 'string', description: 'Which one, by its name or id from list' }, action: { type: 'string', description: 'For act: one of its actions from list' },
    params: { type: 'object', description: 'For act: the action\'s parameters, if any' }, name: { type: 'string', description: 'For name: what the family calls it (empty: its own name)' } } } };
/** Does the tablet hear them? Settings → Opie → Voice's microphone check, on the screen: devices/index.js micCheckDo (the shell's /mic-check). */
export const MIC_CHECK_TOOL = { name: 'mic_check', description: 'Check whether the device hears people: when "Hey Opie" isn\'t working, it keeps missing them, or they ask for a microphone check. ' +
    'start puts the check on the device\'s screen: someone says "Hey Opie" to it, and it says plainly whether it heard them, or the microphone is too quiet, too noisy or blocked. ' +
    'Nothing is recorded or sent while it checks. last says how the last check went.',
  inputSchema: { type: 'object', required: ['do'], properties: { do: { type: 'string', enum: ['start', 'last'] } } } };
/** What asks for the tablet's PIN (Settings → Advanced → Ask for the PIN): devices/index.js pinChoicesDo (the shell's
 *  /pin-choices, PinChoices.kt). Changing one always takes the PIN, typed by a person on the tablet's own card. */
export const USAGE_TOOL = { name: 'how_much_used', description: "How much of Opie the household used this month, as Settings → Voice shows it: minutes talking to Opie, typed questions answered, apps made or changed, and about what it cost so far, and what's left of Opie's credit. For \"how much have we used?\", \"what does this cost us?\", \"how much credit is left?\".",
  inputSchema: { type: 'object', properties: {} } };
export const PIN_TOOL = { name: 'pin_choices', description: 'Which everyday things ask for the device\'s PIN (Settings → Advanced → Ask for the PIN), when the device has one. ' +
    'get says each choice and what always needs the PIN. set turns one on or off only when they ask: the device then asks for the PIN on its screen, so tell them to type it on the device (never ask them to say it). ' +
    'What always needs the PIN can\'t be turned off.',
  inputSchema: { type: 'object', required: ['do'], properties: { do: { type: 'string', enum: ['get', 'set'] },
    choice: { type: 'string', enum: ['apps', 'photos', 'calendar', 'rewards', 'settings'], description: 'For set: apps (adding apps and plugins, and the apps you make), photos (photo albums), calendar (changing the calendar), rewards (giving and changing rewards), settings (Voice, the calendars in Connections, Time and Email in Settings)' },
    ask: { type: 'boolean', description: 'For set: true to ask for the PIN, false to stop asking' } } } };
/** Ending the conversation when asked: the session ends as soon as its last words have played (live-session.cjs). */
export const GO_AWAY_TOOL = { name: 'go_away', description: 'End this conversation now, when they want you gone: "go away", "stop", "that\'s all", "never mind", "be quiet", "bye". Just call it: you stop listening at once, and the conversation ends once you have finished speaking.',
  inputSchema: { type: 'object', properties: {} } };

/** The last half hour of talk, newest last: {at, role: 'user'|'assistant'|'tool', text}. */
export function recentTalk({ keepMs = 30 * 60e3, max = 60, clock = () => Date.now(), onAdd = null } = {}) {
  let items = [];
  const prune = () => { const t = clock(); items = items.filter((x) => t - x.at < keepMs).slice(-max); };
  return {
    add(role, text, name) {
      text = String(text || '').trim(); if (!text || !['user', 'assistant', 'tool'].includes(role)) return;
      prune();
      const t = clock();
      if (items.some((x) => x.role === role && x.text === text && t - x.at < 60e3)) return; // (a request handed on to a typed turn: once)
      const x = { at: t, role, text: cutData(text, role === 'tool' ? 400 : 2000), ...(name ? { name: String(name).slice(0, 64) } : {}) };
      items.push(x);
      try { onAdd?.(x); } catch {}
    },
    all() { prune(); return items.slice(); },
    /** The live voice's history (OpenAI's session input: text messages, user and assistant only), up to `chars` in all. */
    messages(chars = 12000) {
      const out = []; let n = 0;
      for (const x of this.all().reverse()) {
        if (x.role === 'tool') continue;
        if ((n += x.text.length) > chars) break;
        out.unshift({ role: x.role, text: x.text });
      }
      return out;
    },
    /** For the instructions: who said what, and what the tools found, with the minutes ago. */
    describe(chars = 8000) {
      const t = clock(), lines = []; let n = 0;
      for (const x of this.all().reverse()) {
        const ago = Math.round((t - x.at) / 60e3), when = ago < 1 ? 'just now' : `${ago} min ago`;
        const l = x.role === 'tool' ? `- (${when}, ${x.name || 'a tool'} found: ${x.text.replace(/\s+/g, ' ')})` : `- ${when}, ${x.role === 'user' ? 'they said' : 'you said'}: ${x.text}`;
        if ((n += l.length) > chars) break;
        lines.unshift(l);
      }
      return lines.join('\n');
    },
  };
}



export function liveToolRoutes({ HERE, homeScreen, weather, prefsBlock = () => '', assistantName = () => 'Opie', now = () => '', json, body, talk = recentTalk(), household = null }) {
  // Which setup step the tablet shows, whatever it is (the setup phone or computer follows it: chat/src/phone.jsx).
  // On the photos step, the household's photo page (PhotoShare's link) once someone turned it on there: the setup
  // phone or computer opens it, rather than a second code to scan.
  let shownStep = null, shownAt = 0, shownPhotos = null;
  let guess = null; // where the tablet guesses it is ({address, town, zip}: Setup.kt), for the place step on the phone
  let wanted = null; // the step the setup phone or computer moved on to (its Next: server.js /setup/go), for the tablet to show
  // Whether to stop listening is a small yes-or-no model's call (the cloud's decide, about a hundred-thousandth of a
  // cent each), given the whole conversation: never a list of words.
  let decide = null, convoStart = 0; // convoStart: when this conversation began (its /live/setup)
  /** The conversation so far, newest last, as the model reads it. */
  function conversation(since = convoStart || Date.now() - 30 * 60e3) {
    const name = assistantName();
    return talk.all().filter((x) => x.at >= since).map((x) => x.role === 'user' ? `Person: ${x.text}` : x.role === 'assistant' ? `${name}: ${x.text}` : `(${name} used ${x.name || 'a tool'}: ${x.text.slice(0, 200)})`).join('\n').slice(-8000);
  }
  async function judge(question, threshold) {
    if (!decide) return null;
    const input = `The conversation so far, newest last:\n${conversation() || '(nothing yet)'}`;
    try {
      const r = await Promise.race([decide(input, [{ type: 'predicate', name: 'q', instructions: question }]), new Promise((ok) => setTimeout(() => ok(null), 4000))]);
      const p = (r?.answers || []).find((a) => a.name === 'q')?.probability;
      return typeof p === 'number' ? p >= threshold : null;
    } catch { return null; }
  }
  // Whether to stop listening: its voice model answers "go away" itself rather than handing it to the backend, whose
  // go_away tool would end it, so after each thing heard /live/said answers {end: true} when it should stop.
  const shouldStop = () => judge(`Should ${assistantName()}, the household's voice assistant, stop listening and end this conversation now, given what the person said last? ` +
    'Yes if they are done with it: dismissing it, telling it to go away or hang up, or saying goodbye to it. No if they still want something from it, or are asking it to stop or end something else (a timer, the music, a list).', 0.7);
  // Voice actions the apps declare (plugins.js voiceTools/callVoice), set once the plugins are up: data only, each one
  // done by its app's own page.
  let builds = null; // (text, who, {phone}) => {ok, queued?, busy?}: the builder (builder.js request), when apps are made on the tablet
  let waits = null; // the apps made here waiting to be kept (build-waits.js): waiting(), open(id)
  const waitTools = () => { try { const w = waits?.waiting() || []; return w.length ? [{ ...ASK_AGAIN_TOOL, description: ASK_AGAIN_TOOL.description + ` Waiting now: ${w.map((x) => x.name).join(', ')}.` }] : []; } catch { return []; } };
  let usageNow = null; // () => this month in words (cloud.js usageNow)
  let extra = null, tvDevices = null, device = null, screen = null, phones = null; // screen: {places(), show(id)} (server.js); phones: screens.js phones(), message()
  const screenTools = () => { try { const p = screen?.places() || []; return p.length ? [screenTool(p)] : []; } catch { return []; } }; // device: Opie using the tablet's other apps (device-tools.js)
  const deviceTools = () => { try { return device?.tools() || []; } catch { return []; } };
  const tvTools = () => { try { const names = tvDevices?.tvs() || []; return names.length ? [{ ...TV_TOOL, description: TV_TOOL.description + `\n${asData(names.map((n) => String(n).replace(/\s+/g, ' ').slice(0, 60)).join(', '), "the TVs' names, as the TVs give them unless the family named them", { max: 600 })}` }] : []; } catch { return []; } }; // (a TV names itself on the network: data)
  const extraTools = () => { try { return extra?.tools() || []; } catch { return []; } };
  const btTools = () => { try { return tvDevices?.bluetoothOn?.() ? [BT_TOOL] : []; } catch { return []; } };
  const volumeTools = () => (tvDevices?.volume ? [VOLUME_TOOL] : []);
  const tabletScreenTools = () => (tvDevices?.screen ? [SCREEN_TOOL, ...(tvDevices.micCheckOn?.() ? [MIC_CHECK_TOOL] : []), ...(tvDevices.devices ? [DEVICES_TOOL] : []), ...(tvDevices.media ? [MUSIC_TOOL] : [])] : []);
  const pinTools = () => { try { return tvDevices?.pinChoicesOn?.() ? [PIN_TOOL] : []; } catch { return []; } };
  const family = () => { try { return (household?.read?.()?.family || []).filter((f) => f?.name); } catch { return []; } };
  const messageTools = () => { const n = [...new Set(family().map((f) => String(f.name)))]; return phones && n.length ? [messageTool(n)] : []; };
  const read = (f) => { try { return fs.readFileSync(path.join(HERE, f), 'utf8'); } catch { return ''; } };
  const rawTools = () => {
    const all = homeScreen.tools().filter((t) => LIVE_TOOLS.includes(t.name));
    return [...all, WEATHER, READ_PAGE_TOOL, GO_AWAY_TOOL, ...volumeTools(), ...tabletScreenTools(), ...pinTools(), ...tvTools(), ...btTools(), ...extraTools(), ...(homeScreen.timers ? [TIMER_TOOL] : []), ...(usageNow ? [USAGE_TOOL] : []), ...screenTools(), ...deviceTools(), ...messageTools(), ...(builds ? [MAKE_APP_TOOL, ...waitTools()] : [])];
  };
  const tools = () => rawTools().map((t) => ({ type: 'function', name: t.name, description: String(t.description || ''), parameters: forModel(t.inputSchema || { type: 'object', properties: {} }) }));
  const instructions = () => livePreamble(assistantName(), !!builds) + read('CHAT.md') + (device?.rules() || '') + prefsBlock();
  /** One tool, as the assistant would call it (outside any conversation's turn). */
  const lately = []; // [{at, key}]: the calls of the last minute, to stop the same one being made over and over
  // The voice's backend fills in every part of a tool's schema (strict function calling): tool-args.js takes out what
  // wasn't given (null, "", [], an object missing what it requires), by the tool's own schema.
  const schemaOf = (name) => { try { return rawTools().find((t) => t.name === name)?.inputSchema || null; } catch { return null; } };
  async function callTool(name, args, ctx = {}) {
    args = fromModel(schemaOf(name), args || {});
    const key = name + ' ' + JSON.stringify(args || {}), t = Date.now();
    while (lately.length && t - lately[0].at > 60e3) lately.shift();
    // Only the household's own changes are guarded (the calendar once got the same event many times); moving through
    // a recipe, using an app or changing the screen repeat on purpose ("next", "next").
    const repeats = !LIVE_TOOLS.includes(name) && name !== MESSAGE_NAME; // (a message sent twice buzzes twice)
    if (!repeats && lately.filter((x) => x.key === key).length >= 2) return { text: `Already done: this exact ${name} call was made twice in the last minute. Don't make it again; tell them it's done, or ask what's wrong.`, isError: true };
    lately.push({ at: t, key });
    const r = await callTool1(name, args, ctx);
    if (name !== 'weather') talk.add('tool', r.text, name); // (the weather is in Right now anyway)
    return r;
  }
  async function callTool1(name, args, ctx = {}) {
    // A page is someone else's words: marked as data (as-data.js), never as ours.
    if (name === READ_PAGE_TOOL.name) { const p = await readPage(args?.url); return p.error ? { text: p.error, isError: true } : { text: asData(`${p.title ? p.title + '\n' : ''}${p.url}\n\n${p.text}`, 'the text of a web page'), isError: false }; }
    if (name === 'weather') {
      try { const w = await weather.current(); return { text: JSON.stringify({ ...w, hours: (w.hours || []).slice(0, 12) }), isError: false }; }
      catch { return { text: "The weather isn't available right now.", isError: true }; }
    }
    if (name === USAGE_TOOL.name && usageNow) { try { return { text: (await usageNow()).text, isError: false }; } catch { return { text: "This month's use isn't available right now.", isError: true }; } }
    if (name === GO_AWAY_TOOL.name) return { text: 'Ending now. Say nothing more, or just "Okay."', isError: false };
    if (name === 'volume' && tvDevices?.volume) { const r = await tvDevices.volume(args || {}); return { text: r.text, isError: !r.ok }; }
    if (name === DEVICES_TOOL.name && tvDevices?.devices) { const r = await tvDevices.devices(args || {}); return { text: r.text, isError: !r.ok }; }
    if (name === MUSIC_TOOL.name && tvDevices?.media) { const r = await tvDevices.media(args || {}); return { text: r.text, isError: !r.ok }; }
    if (name === MIC_CHECK_TOOL.name && tvDevices?.micCheck) { const r = await tvDevices.micCheck(args || {}, { wait: !!(ctx.typed || ctx.phone) }); return { text: r.text, isError: !r.ok }; }
    if (name === PIN_TOOL.name && tvDevices?.pinChoices) { const r = await tvDevices.pinChoices(args || {}); return { text: r.text, isError: !r.ok }; }
    if (name === SCREEN_TOOL.name && tvDevices?.screen) { const r = await tvDevices.screen(args || {}); return { text: r.text, isError: !r.ok }; }
    if (name === 'bluetooth' && tvDevices?.bluetooth) { const r = await tvDevices.bluetooth(args || {}, { who: 'voice' }); return { text: r.text, isError: !r.ok }; }
    if (name === 'tv' && tvDevices) { const r = await tvDevices.tv(args || {}, { who: 'voice' }); return { text: r.text, isError: !r.ok }; }
    if (extra && extraTools().some((t) => t.name === name)) { // an app's voice action: what the app says back is its words, marked as data
      const r = await extra.call(name, args || {});
      return r?.said != null ? { text: asData(`${r.app}: ${r.said}`, `what one of the apps answered${r.shared ? ' (an app from a link)' : ''}`, { max: 2000 }), isError: !!r.isError } : r;
    }
    if (device && device.names.includes(name)) return device.call(name, args || {});
    if (name === 'timer' && homeScreen.timers) {
      const t = homeScreen.timers, a = args || {};
      if (a.action === 'list') { const l = t.list(); return { text: l.length ? l.map((x) => `${x.label}: ${x.endAt <= Date.now() ? 'finished (ringing or on the screen until cleared)' : `${Math.round((x.endAt - Date.now()) / 1000)} s left`} (endAt ${x.endAt})`).join('\n') : 'No timers.', isError: false }; }
      if (a.action === 'cancel') {
        const l = t.list(), name = String(a.label || '').trim().toLowerCase();
        const which = a.endAt ? l.filter((x) => x.endAt === Number(a.endAt)) : a.all || l.length === 1 ? l : name ? l.filter((x) => String(x.label).toLowerCase() === name) : [];
        if (!l.length) return { text: 'No timers to stop.', isError: false };
        if (!which.length) return { text: `Which one? ${l.map((x) => x.label).join(', ')} (or all).`, isError: true };
        which.forEach((x) => t.cancel(x.endAt));
        return { text: `Stopped ${which.length > 1 ? `${which.length} timers` : `the ${which[0].label} timer`}.`, isError: false };
      }
      const endAt = t.start({ label: a.label || 'Timer', seconds: Math.round((Number(a.minutes) || 0) * 60 + (Number(a.seconds) || 0)) });
      if (!endAt) return { text: 'A timer is 1 second to 24 hours.', isError: true };
      return { text: `${String(a.label || 'Timer')} timer on: rings at ${new Date(endAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. (endAt ${endAt})`, isError: false };
    }
    if (name === 'show_on_screen' && screen) {
      const p = (screen.places() || []).find((x) => x.id === String(args?.what || ''));
      if (!p) return { text: `${args?.what || 'That'} isn't one of the device's tabs or apps.`, isError: true };
      await screen.show(p.id);
      return { text: `The screen shows ${p.name}${p.tab ? '' : ', full screen'}. look_at_screen to see what's on it.`, isError: false };
    }
    if (name === MESSAGE_NAME && phones) return sendMessage(args || {}, ctx.phone?.person || null);
    if (name === ASK_AGAIN_TOOL.name && waits) { // (Home's "ready to try" line, tapped: the app again, to try; only a person keeps it)
      const w = waits.waiting(), want = String(args?.app || '').trim().toLowerCase();
      const one = w.find((x) => x.name.toLowerCase() === want || x.app === want) || (w.length === 1 ? w[0] : null);
      if (!one) return { text: w.length ? `Which one? ${w.map((x) => x.name).join(', ')}.` : 'Nothing the device made is waiting to be kept.', isError: true };
      waits.open(one.id).catch(() => {});
      return { text: `${one.name} is opening on the device to try. Keeping it is their own tap there (Keep it); you can't keep it for them.`, isError: false };
    }
    if (name === MAKE_APP_TOOL.name && builds) {
      const r = await builds(String(args?.what || ''), ctx.phone?.person || null, { phone: !!ctx.phone, typed: ctx.typed || null }).catch(() => ({ ok: false }));
      // Said once, then the conversation ends as usual: the tablet shows it being made, and how it went (open to try,
      // or why it couldn't). So the line promises no outcome: a build can still fail.
      return r.queued ? { text: `Queued: the device makes it right after what it's making now${r.queued > 1 ? ` (${r.queued - 1} more before it)` : ''}. Tell them in one short sentence that it's next and it'll show here when it's ready; promise nothing more, and don't wait for it.`, isError: false }
        : r.ok ? { text: 'Started: the device is making it now (a minute or two). Tell them in one short sentence that you\'re making it and it\'ll show here when it\'s ready; promise nothing more (it can still fail), and don\'t wait for it.', isError: false }
        : { text: r.busy ? 'The device already has a few things waiting to be made: tell them to ask again once those are done.' : 'Making apps on the device isn\'t on: someone does it from their computer (Settings, then Screens and computers).', isError: true };
    }
    if (!LIVE_TOOLS.includes(name)) return { text: `${name} isn't one of this voice's tools.`, isError: true };
    const r = await homeScreen.call(name, args || {}, { by: 'assistant', who: null, conversation: 'live', touched: null });
    return { text: (r?.content || []).map((c) => c.text || '').join('\n').slice(0, 8000), isError: !!r?.isError };
  }
  /** message_family: who it's for from the family list (never a name the model made up), sent to their phones. */
  async function sendMessage(a, phonePerson) {
    const fam = family(), find = (n) => fam.find((f) => String(f.name).toLowerCase() === String(n || '').trim().toLowerCase());
    const text = String(a.text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!text) return { text: 'What should the message say?', isError: true };
    const sender = find(phonePerson) || find(a.from) || null;
    const everyone = String(a.to || '').trim().toLowerCase() === 'everyone';
    const to = everyone ? fam.filter((f) => f !== sender) : [find(a.to)].filter(Boolean);
    if (!to.length) return { text: everyone ? 'There\'s nobody else in the family list to message.' : `${a.to || 'That'} isn't in the family list (about_household).`, isError: true };
    const have = phones.phones(), of = (f) => Object.entries(have).find(([p]) => p.toLowerCase() === String(f.name).toLowerCase())?.[1] || { phones: 0, on: 0 };
    const reach = to.filter((f) => of(f).on > 0);
    // (everyone it's for keeps it on their phone's page, notifications on or not; only phones that allowed them buzz)
    const sent = await phones.message(to.map((f) => f.name), { title: sender ? `From ${sender.name}` : 'From Opie', text });
    const got = reach.filter((f) => sent[f.name] > 0), failed = reach.filter((f) => !(sent[f.name] > 0));
    const off = to.filter((f) => of(f).phones > 0 && of(f).on === 0), none = to.filter((f) => of(f).phones === 0);
    const who = (l) => l.map((f) => f.name).join(', '); // (names only: "Sam's phone")
    const parts = [got.length ? `Sent "${text}" to ${who(got)}.` : 'It didn\'t reach anyone.'];
    if (failed.length) parts.push(`Couldn't reach ${who(failed)}'s phone just now.`);
    if (off.length) parts.push(`Notifications are off on ${who(off)}'s phone.`);
    if (none.length) parts.push(`No phone paired for ${who(none)}.`);
    return { text: parts.join(' '), isError: false };
  }
  /** Today and tomorrow and the weather, as the screen knows them when a conversation starts: most questions ("what's
   *  for dinner?", "is it cold out?") are answered from it, without a tool call and the second model call after it
   *  (about 2 s). After the rules, so they stay the same from one conversation to the next (cached). */
  let dayNotesOf = () => '';
  async function rightNow() {
    let w = null;
    try { w = await Promise.race([weather.current(), new Promise((r) => setTimeout(r, 300, null))]); } catch {}
    let picture = '';
    try { picture = now(); } catch {}
    try { const n = dayNotesOf(); if (n) picture += `\n\nOn the calendar's days, from the household's apps (not events):\n${n}`; } catch {}
    const before = talk.describe();
    const earlier = before ? '\n\n---\n\nEarlier, in the last half hour (newest last), by voice or typed. When someone refers to something from it ' +
      '("the event we just talked about", "that one", "why not?"), this is what they mean; carry on from it rather than asking again.\n\n' + before : '';
    if (!picture && !w) return earlier;
    return earlier + '\n\n---\n\nRight now, as the screen knows it as this conversation starts. Answer from it when it has the answer; use the tools ' +
      'for anything not here, anything that may have changed since, and for every change.\n\n' + picture +
      (w ? `\n\nWeather: ${JSON.stringify({ ...w, hours: (w.hours || []).slice(0, 8), days: (w.days || []).slice(0, 3) })}` : '');
  }
  /** An app in use hands-free (home-screen.js handsFree: the Recipes app while cooking): what it says is on the screen, and how
   *  long the session stays after the last words (the shell's LiveVoice ends it then), so "next" works without the name for a while. */
  function handsFree() {
    let hf = null; try { hf = homeScreen.handsFree?.(); } catch {}
    if (!hf) return { text: '', listen: 0 };
    return { listen: hf.listen, text: '\n\n---\n\nThey are using an app hands-free right now. What it says:\n' + asData(hf.note, `what the app in use (${hf.app}) says is on its screen`, { max: 1500 }) +
      '\nWhile this lasts, short things said without your name ("next", "back", "again", "how much salt?", "pause") are for you: ' +
      'do them with that app\'s tools and say what the tool answers, as it is. Stay quiet for anything else said in the room.' };
  }
  /** Someone said something (by voice or typed): "Opie, stop" stops what it's doing in an app at once; anything else is a new request. */
  function heard(text) { try { return device?.heard(text) || false; } catch { return false; } }
  async function handle(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/setup/step') { // the display only (its secret), like every route here
      // (The setup is quiet throughout: nothing listens until it's over, so the live voice is never told about it.)
      const b = await body(req); const s = String(b.step || '');
      shownStep = /^[a-z]{1,20}$/.test(s) ? s : null; shownAt = Date.now();
      shownPhotos = shownStep === 'photos' && /^https?:\/\/[^\s"'<>]{1,600}$/.test(String(b.photos || '')) ? String(b.photos) : null;
      json(res, 200, { ok: true, step: shownStep }); return true;
    }
    if (req.method === 'POST' && url.pathname === '/setup/guess') { // the display: where it guesses it is, for the place step on the phone
      const b = await body(req), t = (v) => String(v || '').trim().slice(0, 120);
      guess = { address: t(b.address), town: t(b.town), zip: t(b.zip) }; json(res, 200, { ok: true }); return true;
    }
    if (req.method === 'GET' && url.pathname === '/setup/want') { const w = wanted; wanted = null; json(res, 200, { step: w }); return true; } // the display: once
    if (req.method === 'GET' && url.pathname === '/live/setup') {
      convoStart = Date.now(); // a conversation begins (what it's given as earlier talk stays earlier)
      json(res, 200, await setupFor(req, url.searchParams.get('how') === 'wake')); return true;
    }
    if (req.method === 'POST' && url.pathname === '/live/said') {
      const b = await body(req), role = String(b.role || '');
      if (role === 'tool') { if (b.text === 'web search') talk.add('tool', 'searched the web', 'web search'); } // (the household's tools are kept with what they found, in callTool)
      else {
        if (role === 'user') heard(b.text);
        talk.add(role, b.text);
        const end = role === 'user' ? (await shouldStop()) === true : false;
        if (end) talk.add('tool', 'ended the conversation: they wanted it over', 'go_away');
        json(res, 200, { ok: true, ...(end ? { end: true } : {}) }); return true;
      }
      json(res, 200, { ok: true }); return true;
    }
    if (req.method === 'POST' && url.pathname === '/live/tool') { const b = await body(req);
      if (onOtherTablet(req) && ON_THIS_DEVICE.has(String(b.name || ''))) { json(res, 200, { text: "That acts on the main device itself, not the device they're at.", isError: true }); return true; }
      if (onPhone(req) && b.name === 'look_with_camera') { json(res, 200, { text: 'The device\'s camera is for someone at the device, not on a phone.', isError: true }); return true; }
      json(res, 200, await callTool(String(b.name || ''), b.args && typeof b.args === 'object' ? b.args : {}, { phone: onPhone(req) })); return true; }
    return false;
  }
  // Someone's own phone (screens.js, docs/phones.md): who's talking is known, and nobody else is in the room.
  let whoOf = () => null;
  /** What a live session is set up with: the household's instructions, tools and what was said lately. A paired device
   *  (a phone) gets it from GET /live/setup to know the quiet time, but its session starts with this, made here again
   *  (server.js /live/start): the relay takes only small requests, and a device shouldn't say what Opie's rules are. */
  async function setupFor(req, woke = false) {
    const phone = onPhone(req), hf = phone ? { text: '' } : handsFree();
    woke = woke && !phone;
    // A session its name opened starts fresh unless they were just talking (2 min): an old conversation turned a false wake
    // into an answer about something nobody had just said (2026-11-21, "staying focused").
    const recentlyTalked = () => { const a = talk.all(); return a.length > 0 && Date.now() - a[a.length - 1].at < 120e3; };
    const other = phone ? null : onOtherTablet(req);
    return { instructions: instructions() + await rightNow() + hf.text + (phone ? phoneNote(phone) : '') + (other ? otherTabletNote(other) : '') + (woke ? wakeNote(assistantName()) : ''),
      tools: tools().filter((t) => !(phone && t.name === 'look_with_camera') && !(other && ON_THIS_DEVICE.has(t.name))), earlier: woke && !recentlyTalked() ? [] : talk.messages(), ...(hf.listen ? { quietS: hf.listen } : {}) }; // (the tablet's camera is for someone at the tablet, not a phone)
  }
  // Another Opie tablet in the household (docs/multi-tablet.md): the household's tools work as here, but the tools that
  // act on this tablet's own screen, speaker, camera and apps would act here, not in the room they're talking in.
  const onOtherTablet = (req) => { const id = req.headers?.['x-openhouse-screen']; const w = id ? whoOf(String(id)) : null; return w?.kind === 'tablet' ? w : null; };
  const otherTabletNote = (w) => `\n\nThis conversation is on another of the household's devices, the ${w.name || 'other device'}, not this one. The household is the same: its calendar, lists, chores, meals, notes and apps. Its own screen, volume, camera and apps can't be changed from here yet: say so if they ask. Anything that needs the PIN asks for it on the main device.`;
  const onPhone = (req) => { const id = req.headers?.['x-openhouse-screen']; const w = id ? whoOf(String(id)) : null; return w?.kind === 'phone' && w.person ? w : null; };
  const phoneNote = (w) => `\n\nThis conversation is on ${w.person}'s own phone, not the device: you're talking with ${w.person}, so "me" and "my" are ${w.person}'s and you never ask who it is. They may be away from home, and nobody else hears you. Anything that needs the PIN asks for it on the device itself, not this phone: say so, so someone at home can type it.`;
  return Object.assign(handle, { useDecide: (f) => { decide = f; } }, { tools, instructions, callTool, talk, setWhoOf: (f) => { whoOf = f; }, setDayNotes: (f) => { dayNotesOf = f; }, setExtra: (x) => { extra = x; }, setTv: (x) => { tvDevices = x; }, setUsage: (f) => { usageNow = f; }, setDevice: (x) => { device = x; }, setScreen: (x) => { screen = x; }, setPhones: (x) => { phones = x; }, setBuild: (f, w = null) => { builds = f; waits = w; }, heard, setupFor, device: () => device,
    /** The setup step on the tablet's screen now, or null (none, or shown more than an hour ago). */
    /** The setup phone or computer's Next: the tablet goes to [s] at its next look (Setup.kt). */
    setupWant: (s) => { if (/^[a-z]{1,20}$/.test(String(s || ''))) wanted = String(s); },
    setupHousehold: household,
    setupGuess: () => guess,
    setupShown: () => (shownStep && Date.now() - shownAt < 60 * 60e3 ? { step: shownStep, ...(shownPhotos ? { photos: shownPhotos } : {}) } : { step: null }) });
}

# More than one tablet in a household

2026-11-25, design; 2026-11-27, phase 1 built (below, "Built: phase 1"). The main tablet (the brain) can be any
device that keeps the household: a tablet, or a hub on a spare computer (docs/host.md, docs/hub.md); a satellite talks
to it the same way either way. Away from home it reaches the brain through the relay or the household's own Tailscale,
as any paired device does.

Some households want a tablet in the kitchen and another in the den or by the back door, showing the same calendar,
lists, chores and meals. Today each tablet is its own brain: two tablets on one account share only the account, the AI
allowance and the account page. Each has its own lists, its own backups and its own phones.

**Recommendation: one brain per household, and every other tablet is a full Opie tablet that keeps no household data
of its own.** Its shell is unchanged: the kiosk, the wake word, live voice, timers ringing, its PIN pad, its approval
cards. Its bridge becomes a *satellite*: it passes the household's routes, sealed, to the main tablet as a paired
device, on the Wi-Fi or through the relay. Syncing between brains and a cloud-held household both cost far more and
break rules we hold (undo, no duplicate calendar events, the cloud never holding the household's things in the clear).
The real cost of one brain, the main tablet being switched off, is covered by a read-only home screen while it's away,
and later by a standby copy on the second tablet.

## The three options

### A. A second tablet as a satellite of the first (one brain)

The main tablet keeps everything as today. A second tablet pairs with it as a new kind of device, `tablet`, the way
screens, phones and TVs do (`bridge/screens.js`). On the second tablet:

- **The shell doesn't change.** It still talks to a bridge on its own loopback with its own secret. That bridge has no
  household data: for each request it decides whether to pass it on, answer it itself, or refuse it.
  - Passed on: whatever the pairing's scopes allow (`screens.js` RULES), through the same screen client the browser
    screen uses (`chat/src/screen-client.js`): sealed with the tablet's own key, Wi-Fi first, the relay if the Wi-Fi
    doesn't answer. The main tablet checks the scopes again, so a satellite that's been tampered with still reaches
    only what its pairing allows.
  - Answered here: the tablet's own wake word (`bridge/wake.js` and its model), its own state (brightness, volume,
    night hours for this tablet), its own Android apps.
  - Refused: everything else, with "That's on the main tablet". A satellite never answers a household route from its
    own data, so there's nothing to drift apart.
- **The home screen** is the brain's `/screen/?display` page with the brain's data, as on any screen. The same notes,
  tabs, Today and apps.

Whether the shell's own features still work on a satellite:

| Feature | On a satellite | What it takes |
|---|---|---|
| The home screen, tabs, lists, chores, meals, calendar, photos | Yes, the brain's | `door` and `arrange` scopes, as screens have |
| Typed questions to Opie | Yes, answered by the brain's assistant | `ask` |
| Voice: "Hey Opie" | Yes. The wake model runs on the satellite; the microphone never leaves the room it's in | Local, as today |
| Voice: the conversation | Yes. The satellite's LiveVoice starts its session through the brain (`/live/start`, scope `voice`, as the hub's browsers do), so it counts against the household's allowance, and its tools run on the brain | `voice` (built for the hub) |
| Timers ringing | Yes, but today every screen rings every timer. A timer should ring where it was set (and show everywhere) | Phase 2: the brain records which device started a timer |
| Opie controlling Android apps ("put cartoons on the den tablet") | Not at first. `device_action` and `tv` act on the brain's own shell | Phase 2: the brain sends a device call to the satellite's shell over its sealed channel, and the tools say which tablet |
| The PIN | Its own pad, but the PIN must be the household's | Phase 2: the brain keeps the PIN's hash; the satellite's pad sends the attempt sealed and the brain says yes or no (with its lockout). A PIN set on one tablet works on all |
| Person-only approvals (`DeviceServer.personOnly`) | Not at first: they appear on the main tablet only | Phase 2: approval cards go to every household tablet; the answer comes from a satellite shell's own native tap, which its `personOnly` guard protects just as on the brain. A new `approve` scope only tablets get |
| Household settings (linked devices, calendars, backups, the account) | On the main tablet | Phase 2 could open them on a satellite behind the household PIN (the hub's `admin` scope, given to tablets, guarded by the PIN) |
| Family apps | Yes, from the brain: the screen-app frames screens already have (`/screen-app/`), each app reading only what it may through the sealed requests | Done for screens; the satellite's AppWindow loads from there |
| Apps that need the microphone or camera | Only where the page is a secure context: the brain's https name (`docs/networking.md`) | Works once the brain has its https name; on plain http they open on the main tablet only |
| Undo | One history, on the brain: undo from any tablet takes back the latest change whoever made it | Nothing new. Undo stays unspoken (asked for, never offered) |
| Calendars, shared albums, email | The brain's shell keeps their links and reads them; satellites see the results | Nothing new |
| The heartbeat, reminders, message_family, calendar sync | Run once, on the brain | Nothing new: this is the point of one brain |

What happens when:

- **The Wi-Fi drops or the satellite is away from home:** the client falls back to the relay if the household turned
  "Use it away from home" on; otherwise it's like the brain being off.
- **The main tablet is off or unplugged:** the satellite keeps showing the last home screen, marked away ("Can't reach
  the kitchen tablet"), and refuses changes rather than keeping them to send later. Its own timers still ring (the
  shell mirrors them already). Opie isn't available, because the household's tools are on the brain. This is the main
  cost of one brain, and the reason for phase 3.
- **Conflicts:** none new. Two people ticking the same list from two tablets is the same as a phone and a tablet today:
  the brain applies one change, then the other.
- **The relay:** carries a satellite's sealed requests like any device's, cents a month. It never sees contents.
- **Removing a tablet:** on the main tablet, under Linked devices. Its open requests end at once and it shows "This
  tablet was removed", then offers to join again or start as its own Opie.

Security:

- A satellite's pairing is a key only it and the brain hold, an allowlist of routes, and revocable. The kind `tablet`
  gets `door`, `arrange`, `ask`, `voice` like a screen, and in phase 2 `approve` (person-only answers) and the PIN
  check. Never the undo and restore routes themselves (asking Opie to undo works, as from any screen), the builder, the workshop's MCP, the screen routes
  themselves.
- The satellite's bridge holds the pairing key in its own folder (mode 600), not in backups, like the cloud credential.
- A stolen satellite reaches what a stolen screen reaches, from the Wi-Fi (and from away if the relay is on) until it's
  removed. With the PIN check on the brain, guessing the PIN on a stolen satellite hits the brain's lockout.
- The person-only rule holds because the tap comes from the satellite shell's own native dialog, guarded as on the
  brain. Opie on the brain can show a card on a satellite, never answer it.

Size: phase 1 about 1.5–2 weeks; phase 2 about 2 weeks.

### B. Syncing data between brains

Each tablet keeps the household's data and they exchange changes, on the Wi-Fi or through the relay as sealed
messages. Every store would need a merge rule:

- lists, chores, meals and notes: an operation log or CRDT per store (about 15 stores in `bridge/stores.js` and
  `house/`), with tombstones so a deleted item doesn't come back;
- apps and the home screen's look: git repos, so two tablets' changes to the same app need git merges, and an agent
  to resolve conflicts;
- photos: copying files both ways;
- undo: "take back the latest change" stops having one answer. Undoing a change another tablet already built on needs
  its own merge;
- calendar sync: two tablets writing to the same Google or iCloud calendar is exactly the duplicate-events failure the
  data-safety rules forbid, so one tablet has to be the one that writes anyway;
- the heartbeat, reminders and message_family would run twice unless one tablet is chosen to run them, which is a
  brain again.

Offline it's the best of the three: each tablet works on its own and catches up later. Everything else is worse: a long
tail of merge bugs in exactly the area (losing or duplicating the household's things) where breakage is costliest,
backups that no longer describe one household, and PIN and approvals that have to agree across devices.

Size: 2–3 months to do well, and ongoing.

### C. A cloud-held household

The household's data lives in the cloud and every tablet is a client. It's simple for the tablets and the same as
every other product's multi-device story, but:

- it breaks the default we sell: the household's things stay on its own devices, the cloud is optional, and the
  privacy policy says the cloud never holds them in the clear. Holding them only encrypted (the cloud as a mailbox of
  sealed changes) turns it into option B with the cloud as the transport, with all of B's merge work;
- no Wi-Fi or no internet means no lists, unless each tablet caches and syncs, which is B again;
- it doesn't help self-installers without our cloud.

Size: large, and a policy change. Not recommended.

### Comparison

| | A. Satellite (one brain) | B. Sync between brains | C. Cloud-held |
|---|---|---|---|
| Main tablet off | Read-only home screen, no Opie (phase 3: a standby takes over) | Fine | Fine while online |
| Internet down | Fine (Wi-Fi) | Fine | Broken |
| Conflicts | None new | Many | Many, or none if online-only |
| Undo | Unchanged | Hard | Unchanged if online-only |
| Calendar sync, reminders, heartbeat | Once | Needs a leader | Once, in the cloud |
| Privacy default | Unchanged | Unchanged | Broken unless E2E (= B) |
| Security model | Today's pairing and scopes | Every tablet holds everything; more keys to agree | The cloud becomes the target |
| Works without our cloud | Yes | Yes | No |
| Size | ~4 weeks over two phases | months | months, and policy |

## What the family sees

Joining during setup, on the new tablet:

1. After Wi-Fi, the first setup screen finds an Opie on the network (Bonjour `_openhouse._tcp`, as the workshop and
   phones do) and asks: **"Add this tablet to the Smiths' Opie?"** with *Add it* and *Start a new one*. (The
   name shown is the household's as the main tablet chooses to announce it; with none announced, "the Opie in the
   kitchen", from the main tablet's own name.)
2. *Add it* shows a short code on the new tablet. On the main tablet, a card says **"A new tablet wants to join: Den
   tablet. Allow?"**, which asks for the PIN, and someone types the code shown on the new tablet (typing it is what
   proves it's the tablet in front of them, as with the TV). Or someone asks Opie on the main tablet to add a tablet,
   and Opie opens that screen; the PIN and the tap stay a person's.
3. The new tablet asks only what's its own: its name and room ("Den"), night hours for that room, whether "Hey Opie"
   listens here. Everything else (people, calendars, backups, the account, the PIN, the AI) comes from the main tablet.
   No second recovery code, no second account link, no second allowance.
4. With no Opie on the network: the setup is as today. With one found but *Start a new one* chosen: a separate
   household, as today.

Living with it:

- Both tablets show the same Home and tabs. A note left on one shows on both. A timer rings where it was set.
- "Hey Opie" answers on the tablet you spoke to, with the same memory and tools.
- Settings on the den tablet shows its own things (brightness, volume, night hours, Hey Opie here) and *Household
  settings are on the kitchen tablet* (in phase 2, they open here behind the PIN).
- Linked devices on the main tablet lists tablets with screens, phones and the TV.
- If the main tablet is off: "Can't reach the kitchen tablet. Showing what it last showed." Taps that would change
  something say the same.
- Backups: one, from the main tablet, as today. Phase 3 adds a quiet copy on the second tablet.

For a cloud account with two tablets already linked as separate households (today's state), the account page can
show "These are two separate Opies" and the satellite join is how they become one; merging two existing households'
data isn't offered (one is chosen, the other's kept as a backup).

## Phased plan

**Phase 1: satellites (about 1.5–2 weeks).**
- A `tablet` pairing kind with its scopes (`screens.js`), offered under Linked devices → Add a tablet.
- `bridge/satellite.js` wired into `server.js`: when the tablet has a satellite pairing, `route()` passes requests
  through it before any household store loads; the stores aren't opened at all. Bundling: the screen client and
  cipher (`chat/src/screen-client.js`, `seal.js`) go into the bridge's runtime copy, or the bridge gets its own copy
  of the client (it already has Node's ChaCha20-Poly1305).
- Streaming: the chat stream and `/home/wait` passed through as they come (the PoC waits for whole answers).
- The shell: a setup screen that finds an Opie and joins; "Can't reach the kitchen tablet" on the home screen; Settings
  split into this tablet's own and the household's.
- Live voice on a satellite through the brain's `/live/start` (the hub's path).
- On the main tablet, a timer started on a satellite carries that tablet's id.
- Tests: pairing a tablet and its scopes (security); nothing household written on a satellite (data safety).
- Parity: "Add a tablet" in `docs/opie-parity.md` (screen, with the PIN; Opie opens it).

**Phase 2: per-tablet features (about 2 weeks).**
- Timers ring where they were set.
- Device calls to a satellite's shell (`device_action`, `tv`, `look_at_tablet`, `show_on_tablet` with a `tablet`
  argument), sent down the satellite's long poll.
- The household PIN checked on the brain, with its lockout, from any tablet's pad.
- Approval cards on every tablet, answered by a person's native tap (`approve` scope).
- Household settings on a satellite behind the PIN.

**Phase 3: a standby brain (about 1–2 weeks).**
- The main tablet sends its nightly backup (the same encrypted file and recovery code) to each satellite too, on the
  Wi-Fi, as one more backup place.
- If the main tablet is gone for good, a satellite offers **"Make this the main tablet"**: restore the newest copy,
  take over the pairings (devices re-pair with a code, since their keys were the old brain's), and relink the cloud.
  It's a deliberate step a person takes, never automatic: two brains at once is the problem option B has.

**Later, if asked for:** a home screen per tablet (each tablet its own Home layout, sharing the household's tabs and
data), using the per-kind layouts TVs already have (`/screens/apps`).

## Built: phase 1

Adding a tablet is like adding a phone: the main tablet shows a code, the new one scans it (or types it), and it joins
at once, in its welcome or later.

| Piece | Where |
| --- | --- |
| The code | On the main tablet: Settings → Devices → Add → Another Opie tablet (`shell/Screens.kt` `tablet`, behind the PIN). `POST /screens/pair {kind: 'tablet', address}` makes a 12-letter code (`pair-code.js`), good once for 10 minutes; the QR code is `<address>/tablet#<code>`. While it shows, the tablet answers on the Wi-Fi as `_openhouse._tcp`, so a tablet that only typed the code finds it. Whoever has the code is standing at the main tablet, so it joins with no Allow, as a phone's code does |
| Joining | On the new tablet: the welcome's "Already have Opie in another room? Add this tablet to it", or Settings → Advanced → Add this tablet to another Opie (behind the PIN, personOnly). `shell/Satellite.kt`: scan (CameraX and ZXing) or type the code, say which room. Its bridge (`POST /satellite/join`, brain.js) pairs as kind `tablet` and keeps the pairing in `.satellite/pairing.json` (0600, never in a backup); the runtime starts again |
| Which bridge runs | `bridge/server.js` starts `brain.js` (the household's brain, what `server.js` was) or, with a pairing, `satellite-server.js`. Only one ever loads, so nothing on a satellite opens, changes or sends the household's things it had before; nothing that runs by itself in a brain (heartbeat, reminders, calendar sync, backups, mail, relay, the home network's port) runs on a satellite |
| The satellite's bridge | `satellite-server.js`: the same loopback port and secret, so the shell, the home screen page and the apps are unchanged. Its own: listening for "Hey Opie" (`voice.js`), the pages and the kit, its apps' keys. Passed to the brain, sealed (`satellite.js` forwarder, with `chat/src/screen-client.js`: Wi-Fi, then tailnet, then relay): what `TABLET_SCOPES` allow (`door`, `arrange`, `ask`, `voice`, and `tablet`: Opie's voice state, the household's names). Everything else: 403 "That's on the main tablet" |
| Apps | The brain's apps are copied into `.satellite/webapp` (`satellite.js` mirror, from `GET /screens/apps` and `/screens/app-files`, every 30 s), and the runtime's dev server serves them there (`device/runtime-start.sh`). What an app reads or changes goes to the brain marked with the app, so the brain answers only what that app may do (as on a phone) |
| Opie | The satellite's live voice starts through the brain (`/cloud/live/start` → the brain's `/live/start`, its account and allowance), and its tools run on the brain. Tools that act on the tablet itself (its screen, volume, camera, media, other apps) are left out there (`live-tools.js` `ON_THIS_DEVICE`): they would act on the main tablet |
| While the brain is away | The satellite serves the home screen and the house as last seen, marked `away`, and refuses changes ("Can't reach the main tablet"). Removed on the main tablet: 410 at once, and Settings says so |
| Settings on a satellite | Household (which, and Leave, behind the PIN, personOnly), Brightness, Time, Updates, Advanced. Leaving takes the pairing and the app copies away; the bridge starts again as this tablet's own brain, with what it had before it joined |
| Tests | `bridge/test/satellite.test.mjs`: joining with the code (once, wrong code refused), the household's changes landing on the brain and nothing of the satellite's own changed, what's refused on the satellite and by the brain itself, removed and leaving with its own things back |

Not in phase 1 (phase 2 above): a timer ringing only where it was set, Opie's device tools on the tablet it's
talking at, one PIN for the household, approval cards on every tablet, household settings on a satellite.

### Tried on two emulators (2026-11-27)

Two emulator tablets running a local release build (1.0.55-local.70), the kitchen as the brain and the den as the new
tablet, the den reaching the kitchen's home-network port through the computer (emulators can't see each other's
Wi-Fi, so no Bonjour and no camera scan):
- Kitchen: Settings → Devices → Add (the PIN) → Another Opie tablet showed the code and its QR code.
- Den, already set up with a list of its own: Settings → Advanced (the PIN) → Add this tablet to another Opie, the
  main tablet's link typed into the code box, room "Den". It joined as `Den tablet`, kind `tablet`.
- After its runtime started again, the den showed the kitchen's household: its family, Today and Groceries. A tick on
  the den's Home landed on the kitchen; Milk added in the den's Lists app (served from the copied apps, its calls
  going to the kitchen as that app) was on the kitchen's list. The den's own "To do" item wasn't shown.
- Undo, backups and pairing were refused on the den (403). Settings there showed only Household, Brightness, Time,
  Updates and Advanced.
- With the kitchen unreachable, the den kept showing its last Home and Groceries, marked away, and refused adding an
  item ("Can't reach the main tablet"); with the kitchen back, adding worked again.
- Household → Leave the household (the PIN, then Leave): the den started again as its own Opie, with its own list
  and none of the household's.

Found and fixed on the way: the code box types capitals, so a typed link arrived as `HTTP://…` and wasn't taken.

Needs two real tablets: scanning the QR code with the camera; finding the main tablet by Bonjour when only the code is
typed; "Hey Opie" and a live conversation on the second tablet (its session through the main tablet's account); the
apps that import libraries, from the copies; a timer started on one ringing on both; a tablet away from home through
the relay or Tailscale; a main tablet that's a hub (`docs/hub.md`) rather than a tablet.


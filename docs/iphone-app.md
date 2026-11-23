# The iPhone app

2026-11-23. A native shell around the phone page ([phones.md](phones.md)), for what a home-screen web page can't do on an
iPhone: a real share sheet entry, notes that open the right screen, widgets, and Siri. The code is in `ios/`.

## What it is

- **The phone page, in the app.** The household's page from the cloud (`/h/`, `chat/src/phone.jsx`) in a web view, so
  the app is always the page the household has, with every app and plugin it runs. The page knows it's in the app
  (`window.openhouseApp`) and leaves out what the app does itself: asking to be put on the home screen, turning on
  Web Push, and setting up the Send to Opie shortcut.
- **Joining**: the app scans the tablet's code (Settings, Screens, Add a screen, Someone's phone), or takes its link
  pasted. That opens the tablet's own joining page in the web view; once joined, the page goes on to the cloud's copy
  with the pairing after `#`, as it does in Safari. The app keeps that pairing in the keychain, shared with its
  extensions through the app group `group.computer.openhouse.phone`. Joining needs a household that reaches home from
  away (the relay, [networking.md](networking.md)); without one, the Wi-Fi page in Safari is the way.
- **Send to Opie** (`ios/Share`): a share extension for links, words and a photo. It posts to the cloud's `/send` with
  the phone's share key, the same way the Shortcut did (`openhouse-cloud/lambda/send.ts`), and shows Opie's answer. A
  photo is made a JPEG no wider than 1600 first. The share key comes from the phone's key, so removing the phone on the
  tablet ends it.
- **Notes by APNs** (`ios/App/Notes.swift`, `ios/Notes`): after joining, a phone with the `notify` scope asks once to
  allow notifications and gives the tablet its device token (`POST /phone/push {apns: {token, env}}`). The tablet seals
  each note with the phone's note key (HKDF of its key, "openhouse note", `bridge/screens.js`) and sends it through the
  cloud (`POST /v1/push/apns`, `openhouse-cloud/lambda/apns.ts`) to Apple. The cloud and Apple see only "Something from
  home." and the sealed box; the app's notification extension opens it on the phone. Tapping a note from Opie opens
  that conversation.
- **Widgets** (`ios/Widgets`): Today (the things, what's next, dinner; home screen and lock screen) and Groceries (tick
  items off on the widget). They ask the tablet themselves through the relay, sealed with the phone's key
  (`ios/Shared/Tablet.swift`, the same requests as the page), every 20 minutes and when the app opens; the last answer
  is kept for when home doesn't answer. Tapping one opens that tab.
- **Siri and Shortcuts** (`ios/App/AskOpie.swift`): "Ask OpenHouse", an App Intent that sends a typed turn to Opie as
  this phone's person (`POST /chat`) and says the answer.

## Building

```bash
cd ios && xcodegen
```

Then open `OpenHouse.xcodeproj`. The project file is made from `ios/project.yml`; it's committed too, so Xcode alone
works. For a device or TestFlight, put the Apple team in `ios/Config/Local.xcconfig` (gitignored, so no team id is
committed):

```
DEVELOPMENT_TEAM = ABCDE12345
```

Bundle ids: `computer.openhouse.phone` and `.share`, `.widgets`, `.notes` under it. Debug builds register for APNs'
sandbox, Release (TestFlight, the App Store) for production; the tablet passes which one on.

Tests: `ios/Tests/SealTests.swift` checks the keys and boxes against the bridge's own (Product, Test in Xcode).

Trying it in the Simulator against a local cloud and a sample household: run the local service
(`scripts/cloud.sh node lambda/local.ts --port 8797 --base http://127.0.0.1:8797`), link a bridge to it with Reach from
away on, add Sam's phone, and paste the join link into the app. The local service keeps the last note it would have
sent to Apple as `last-push.apns`; `simctl push` (or dropping the file on the Simulator) delivers it, but the Simulator
doesn't run the notification extension for those, so it shows the placeholder; the words show on a real phone.

Tried this way on 2026-11-23 (iOS 27 Simulator, the sample household): joining by the pasted link, the page with no
home-screen or Shortcut steps, notes allowed and the token on the tablet, Send to Opie from Safari's share sheet, and
both widgets with the household's events and list, Milk ticked off on the widget and gone on the tablet.

## What it needs from the Apple account

1. The app ids (Xcode makes them on the first signed build, with App Groups and Push Notifications).
2. An APNs auth key (Certificates, Identifiers & Profiles, Keys, a new key with Apple Push Notifications service).
   Its key id, the team id and the `.p8` file's text go in Parameter Store as one SecureString, JSON
   `{"keyId": "…", "teamId": "…", "key": "-----BEGIN PRIVATE KEY-----\n…"}`, at `/home-cloud/apns-key`
   (`openhouse-cloud/docs/cloud.md`). Until it's there, the cloud answers 503 and notes on iPhones don't go; the page's
   Web Push still works from Safari's home-screen copy.
3. App Store Connect: the app record, then TestFlight from Xcode's Archive.

## Not yet

- Live Activities for timers, and "leave by" notes (they come with the heartbeat's buzzes, [phones.md](phones.md)).
- Joining with no cloud: the app's native pieces all go through the relay.
- A phone removed on the tablet: the widgets say they aren't in touch, and the page says it was removed; the app
  forgets its pairing only when it joins again.

# The iPhone app

2026-11-23. A native shell around the phone page ([phones.md](phones.md)), for what a home-screen web page can't do on an
iPhone: a real share sheet entry, notes that open the right screen, widgets, and Siri. The code is in `ios/`.

## What it is

- **The phone page, in the app.** The phone page (`chat/src/phone.jsx`) built into the app and shown in a web view, so
  the code that holds the phone's key is the code Apple signed, not a copy a server could change. A build phase
  (`ios/scripts/phone-page.sh`, which runs `chat/phone-page.mjs`; it needs node and `chat`'s packages) puts it in the
  app as `PhonePage/`, and `ios/App/PhonePage.swift` serves it from the app's own address, `openhouse-app://phone/h/`
  (a `WKURLSchemeHandler`: the page gets an origin of its own for its storage and its apps' frames, which a file page
  wouldn't). It is the cloud's `/h/` page otherwise, with the same rules (it connects only to the relay) and every app
  and plugin it runs, since those come from the tablet. The one thing it needs from the cloud, a big reply's sealed box
  (`relay-box.ts`), the app fetches for it. The page knows it's in the app
  (`window.openhouseApp`) and leaves out what the app does itself: asking to be put on the home screen, turning on
  Web Push, and setting up the Send to Opie shortcut.
- **Joining**: the app scans the tablet's code (Settings, Devices, Add, Someone's phone), or takes its link
  pasted. That opens the tablet's own joining page in the web view; once joined, the page goes on to the cloud's copy
  with the pairing after `#`, as it does in Safari, and the app takes the pairing from that address and opens its own
  copy instead. An invite link (the cloud's page with `?for=` and `#pair.key.relay`) joins in the app's own copy too,
  which hands the pairing to the app. The app keeps that pairing in the keychain, shared with its
  extensions through the app group `group.computer.openhouse.phone`. It takes a pairing only from the clouds it was
  built for (`OPENHOUSE_CLOUD_HOSTS` in `ios/Config/Base.xcconfig`, `cloud.openhouse.computer`; a self-hosted cloud adds
  its host in `Local.xcconfig`; debug builds also take a local cloud on `localhost`), and asks the person before a page
  moves a joined phone to a different home. Joining needs a household that reaches home from
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
- **Siri and Shortcuts** (`ios/App/AskOpie.swift`): "Ask Opie", an App Intent that sends a typed turn to Opie as
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

A Simulator build that should keep its pairing needs signing to run locally (`CODE_SIGN_IDENTITY=-`); with
`CODE_SIGNING_ALLOWED=NO` it has no keychain and asks to join again on each start.

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
3. App Store Connect: the app record is **OpenHouse: Household AI** (named before the product became Opie; "OpenHouse" was
   taken; the home screen says Opie), with an internal TestFlight group, Household, that gets each uploaded build by itself. Upload: `ios/scripts/testflight.sh`
   (an App Store Connect API key with Admin access, for cloud signing: its `.p8` and a `config` with `ASC_KEY_ID` and
   `ASC_ISSUER_ID` in `~/.appstoreconnect/`), or Archive in Xcode.

## Export compliance

`ITSAppUsesNonExemptEncryption` is `false` in `ios/App/Info.plist`, so App Store Connect doesn't ask about each build.
The app's own encryption is all Apple's: https, and CryptoKit's ChaCha20-Poly1305, HKDF and SHA-256 for sealing to the
tablet (`ios/Shared/Seal.swift`). That is "encryption limited to that within the Apple operating system", which needs
no documentation. If App Store Connect ever asks anyway: the algorithms are standard, used through the OS; not
proprietary; no French declaration or CCATS. If the app ever ships its own crypto code (a library, not CryptoKit),
this answer changes: set the key to `true` and answer "standard encryption algorithms".

## The demo household

Beta App Review (and anyone without a tablet) needs a household to join. The demo household is a hub
([hub.md](hub.md)) holding the sample household (Sam, Alex, Maya and Leo in Springfield), linked to its own cloud
account, with a phone of Sam's joined; that phone's cloud link is pasted into the app ("Or paste its link") and goes in
the review notes. The hub needs no open ports: phones reach it through the cloud's relay, which it dials out to.

1. Run a hub on a computer that stays on (`hub/install.sh` on a small Linux machine or cloud instance,
   `hub/install-mac.sh` on a Mac that stays on). It's on only for review if that's all it's for, but it has to answer
   for the whole review (a day or two, the first time).
2. Its settings page: type the code it printed, then link it to the cloud with an account of its own (not the
   household's: anything a reviewer changes lands there), and turn on the cloud assistant so Opie answers.
3. From a checkout on that machine: `node hub/demo.mjs --data <the hub's data folder>` (`/var/lib/openhouse` on
   Linux, `~/Library/Application Support/OpenHouse Hub` on a Mac). It fills in the household (weekly events, chores,
   groceries, two weeks of dinners), turns on Reach from away, joins Sam's phone and prints its link (kept in
   `demo-link.txt` there; on Linux run it as `sudo -u openhouse`, as the folder is that user's). Run it daily (cron or launchd) and the dinners stay current; the weekly events repeat on
   their own. `--new-phone` makes a new link; remove the old phone on the settings page to end the old one.
4. Paste the link into the app on a phone to check it, then into the review notes.

Opie's own demo household runs on AWS, in the cloud's stack with `demoHub: on` (`openhouse-cloud/lib/demo-hub.ts`:
a t4g.small with no inbound ports, about $17 a month). Its family and hub credential are made by the operator with
`scripts/cloud.sh node scripts/demo-hub.ts` (no sign-up; the family has no members), and its first start does steps 1
to 3 by itself, with the nightly run in cron. Its link: `AWS_PROFILE=openhouse-admin scripts/cloud.sh node
scripts/demo-hub.ts link`. Its shell: `aws ssm start-session --target <DemoHubInstance from the stack's outputs>`.

Anyone with the link is Sam on the demo household, so it goes only where it has to (the review notes, never a public
page). Tried on 2026-11-24 against the local cloud: the seed ran twice, and the link opened Sam's Today through the
relay.

## External TestFlight

For people outside the Apple team. The first testers are friends whose tablets are set up for them: they join their
own household by scanning its code. The demo household is for Beta App Review.

Before the first submission:
- The cloud deployed with `/privacy` (and the APNs relay, `POST /v1/push/apns`), and openhouse.computer/privacy
  answering.
- The demo household running, and its link from `hub/demo.mjs` at hand.
- A build uploaded (Archive in Xcode, Distribute, App Store Connect) and shown under TestFlight with no "Missing
  Compliance".

In App Store Connect (an Account Holder, Admin or App Manager does these):
1. **TestFlight, Test Information** (left side, under General Information):
   - Beta App Description: "Opie is a household's shared screen and assistant. This app is the household's
     page on an iPhone: the day, lists, meals and apps, Opie the assistant, a share sheet entry, widgets and Siri.
     Join with the code your Opie tablet shows."
   - Feedback Email: the address testers' feedback goes to.
   - Marketing URL: `https://openhouse.computer`. Privacy Policy URL: `https://openhouse.computer/privacy`.
   - Beta App Review Information: contact name, phone and email. Sign-in required: off (there's no account in the
     app). Review notes:
     "The app is the phone companion to a household's Opie tablet, so it needs a household to join. Use our
     demo household: open the app, tap 'Or paste its link', and paste this link: <the demo link, from `scripts/demo-hub.ts link`>. You'll be Sam in a
     sample household. Try Today and the tabs, Talk to Opie, the Today and Groceries widgets, 'Ask Opie' in
     Shortcuts, and Send to Opie from Safari's share sheet."
   - Save.
2. **TestFlight, External Testing, +**: a group named "Friends", Create.
3. In that group, **Builds, +**: pick the build, fill in What to Test (for example "Joining your household, notes,
   widgets, Send to Opie"), and Submit for Review. The first build of a version gets a full review; later builds of
   the same version often go straight through.
4. When it's approved (the group shows the build as Testing): **Testers**, add each friend by email, or **Create
   Public Link** (Open to Anyone, with a tester limit such as 25) and send that link only to them.
5. Each new build: add it to the group (step 3). One build per version can be in review at a time, six a day at most.

## Not yet

- Live Activities for timers, and "leave by" notes (they come with the heartbeat's buzzes, [phones.md](phones.md)).
- Joining with no cloud: the app's native pieces all go through the relay.
- A phone removed on the tablet: the widgets say they aren't in touch, and the page says it was removed; the app
  forgets its pairing only when it joins again.

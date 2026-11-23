# OpenHouse

A shared screen for the household that changes whenever you tell it to. It comes ready with a calendar, meals,
chores, lists and photos. Don't like something? Just say so: anyone at home can ask it to add, change or remove
anything, and every change can be undone.

It is open source (MIT). Ready-made tablets and the hosted service are at [openhouse.computer](https://openhouse.computer);
this repo is everything that runs in the home, for anyone who wants to build it, run it or change it.

It runs on an Android tablet. You talk to Opie, its assistant, for the everyday things (it uses OpenAI's live voice,
through your OpenHouse account). New apps and bigger changes come from your own Claude or ChatGPT on a computer,
connected to the tablet.

<!-- screenshot: the home screen (Today tab) -->

## What it does

- **A home screen.** The time, the day and a column of tabs: Today, a board for notes and drawings, and an
  app per tab (calendar, meals, chores, lists, photos). Which tabs show, their order, the colours and the type are
  the family's to choose, by hand or by asking.
- **An assistant you talk to.** Tap it and ask, out loud or typed (or switch on waking it by name). It answers in a sentence or two, out loud, and
  puts anything worth keeping on the board.
- **Change anything by asking.** "Move photos first." "Add a homework tab." "Make the chore chart bigger for the
  kids." The assistant changes the apps and the home screen while you watch, and makes new ones when you want
  something that isn't there: a game, a countdown, a typing tutor.
- **Every change can be undone.** Each change is saved with who asked and what they said. "Undo" takes back the
  latest; any earlier one can be taken back on its own.
- **Customize it from your own AI app.** Pair a computer once (Settings, then "Screens and computers") and
  ask Claude Code or Claude Desktop for new tabs and apps there, with a big screen and a keyboard; the tablet shows
  each change as it lands, and undo works the same. See [docs/workshop-mcp.md](docs/workshop-mcp.md).
- **Other screens in the house.** A phone, laptop or another tablet on the same Wi-Fi can show the same home
  screen, after someone pairs it with a QR code.

## Built for a household

Several people use it, kids included, so it's built to be safe to hand over:

- **What protects the family is out of the assistant's reach.** The home screen app, undo, the watchdog that
  restarts things and the parent settings are fixed. The assistant can change the family's apps, not those.
- **The assistant has narrow tools, not the code.** Opie reaches the family's lists, calendar, chores, notes and the
  home screen's tabs through the household's tools. Changing an app's code is only for a computer someone paired.
- **a PIN** guards the tablet's own settings, turning the assistant on, connecting a computer, adding Android apps,
  and leaving kiosk mode. It's typed on a big on-screen pad (no OK: the last digit unlocks), someone's
  fingerprint can stand in for it, and it isn't asked again for two minutes unless the screen sleeps or someone
  closes Settings.
- **Nothing goes out until its name.** The wake word is heard on the tablet. After it, what's said goes to OpenAI
  until a few seconds after anyone last spoke; OpenHouse keeps none of it. Nothing is recorded or kept unless someone
   turns on the speech log.

## The AI

- **Talking to Opie:** OpenAI's live voice (gpt-live) with the household's tools, through your OpenHouse account
  (Settings → Live voice). Typed questions, getting to know the family, reading a flyer and the tablet's own
  check-ins use OpenAI's text model the same way. See [docs/assistant.md](docs/assistant.md).
- **Making and changing apps:** your own [Claude Code](https://www.anthropic.com/claude-code), Claude Desktop or Codex
  on a computer, paired with the tablet (Settings → Screens and computers). See
  [docs/workshop-mcp.md](docs/workshop-mcp.md).

There is no AI program on the tablet itself, and nothing to sign in to there.

## How it works

```
Android tablet (kiosk mode)
├─ the shell: the Android app that is the home screen's frame, the assistant's face, voice and parent settings
│  └─ a Linux runtime (proot Ubuntu)
│     ├─ the bridge (Node): the home screen, the family's data, conversations, undo, voice
│     └─ the family's apps: web pages, one folder each, changed from a paired computer
├─ OpenHouse cloud: OpenAI's live voice and text model, accounts, backups, updates, the relay
└─ someone's computer: Claude or ChatGPT, through the OpenHouse connector (the workshop)
```

- **Apps are web pages.** Each lives in its own folder and gets a small kit for the family's data, the stylus and
  the home screen. Every change is a git commit, which is what makes undo possible.
- **Voice:** the wake word ("Opie", [docs/wake-word.md](docs/wake-word.md)) is a small model of our own on the device
  (over [openWakeWord](https://github.com/dscripka/openWakeWord)'s features), the only speech model there; the
  conversation after it is OpenAI's live voice.

## Plugins

Everything on the home screen is a plugin: the built-in apps, the ones a household makes, and ones shared from a
link (a GitHub repo or folder). A plugin is a folder of web pages with an `app.json` saying what it may reach.
[docs/plugins.md](docs/plugins.md) is the full guide; [plugins/school-lunch](plugins/school-lunch) is a small, real
one to start from, and [bridge/AGENT.md](bridge/AGENT.md) is how apps are made here (what a computer's AI reads).

## The cloud

The hosted OpenHouse cloud (accounts, the live voice, encrypted backups, updates, reaching home from away) is a
service, not part of this repo. The tablet works on its own home network without it: the home screen, apps,
plugins, undo, backups to a USB drive and the workshop from a computer. Linking an account turns on the rest.
[docs/cloud.md](docs/cloud.md) is what the tablet sends it and what it keeps.

## Running it yourself

On a Raspberry Pi, a NUC, a Mac or any Linux or Docker host instead of a tablet, with phones, laptops and the TV as its screens: see
[docs/hub.md](docs/hub.md).

You need a Mac or Linux machine with the Android SDK, and an Android tablet with USB debugging on (or an emulator).

```bash
scripts/runtime-assets.sh                  # bundle the bridge, the home screen and the starting apps
(cd shell && ./gradlew :app:assembleDebug)
```

- **A tablet:** `scripts/tablet-setup.sh` once over USB (it also fetches and installs the voice models, about
  390 MB), then `ANDROID_SERIAL=<device> scripts/install-display.sh` for each new build.
- **An emulator:** `scripts/create-avd.sh` once, then `scripts/start-emulator.sh`, and install as above. For voice,
  `scripts/voice-models.sh <folder>` then `scripts/voice-install.sh <folder>`. A release build downloads the voice
  models itself once the microphone is on (docs/voice-models.md).
- **The assistant:** on the tablet, Settings: Cloud (link the family's account), then Live
  voice. **Apps:** Screens and computers, from the same menu.
- **Tests:** `cd bridge && npm test` and `cd shell && ./gradlew -q :app:testReleaseUnitTest`. The home screen
  page: `cd chat && npm ci && npm run build`.

## Repository

- `shell/`: the Android apps (the display, the update cover, the family apps' window template).
- `bridge/`: the Node server, with no dependencies, and the assistant's rules (`CHAT.md`; `AGENT.md`, how apps are made,
  for a computer's AI).
- `connect/`: the connector a computer's Claude or ChatGPT uses (the workshop).
- `chat/`: the home screen page.
- `defaults/apps/`: the starting apps; `plugins/`: plugins shared from this repo.
- `docs/`: design notes, one per part. Many are working notes from building it, dated; the code is the truth.
- `runtime/`, `device/`, `scripts/`: the Linux runtime, its start script, building and installing.

## License

[MIT](LICENSE). Bundled third-party code, fonts and data keep their own licenses: [docs/third-party.md](docs/third-party.md).

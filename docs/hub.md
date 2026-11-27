# Opie as a hub

2026-11-20. For tinkerers who want the house everywhere (phones, laptops, the TV, an old tablet) rather than on one
screen: Opie on a small computer in a closet, a Raspberry Pi, a NUC, a Mac mini, Docker on a NAS, with no screen of
its own.
The household's phones and computers are its screens and its controls. It is the do-it-yourself path in the open
source; what we sell is still the set-up tablet.

Status: the first working slice is built and was tried in Docker on a Mac (2026-11-20): the image built, the hub
started headless and printed its code; a browser typed it and became the settings device; it added Sam's phone (a code,
then Allow), and the phone page showed Today with Opie's pill; a tap sent the phone's offer through the hub to the
cloud call, which answered "off" (the test hub isn't linked to an account, and the browser pane blocks the microphone,
so a whole spoken conversation from a browser is still untried); the laptop's home screen showed Today and the tabs; a
backup went to the folder, and restoring it restarted the hub with everything in place. Then natively on the Mac: it
started from `hub/start.sh` under `caffeinate`, answered on the Mac's Wi-Fi address, and a scan found the 6 devices on
the Wi-Fi (the same scan from Docker Desktop found 2, the VM's own). The LaunchAgent itself, a real Pi, Docker on Linux
and WSL are untried.
2026-11-26: the keeper, the setup from the settings device, the cards (settings devices and grown-ups' phones), the
PIN, two-way Google and iCloud calendars, Google Photos, "Hey Opie" on a screen that says yes, and going back from a
bad update (below). The pages still say "the
tablet" in places (the phone's notes, the TV's empty view, the cloud backup's hint); the join page already says "the
hub's settings page" on a hub.

## How it fits together

```
the hub (a Pi, a NUC, a Mac mini, Docker on a NAS, in a closet)
├─ hub/start.sh: copies the code into the data folder, then runs
│  ├─ the bridge (Node, headless): the household's data, conversations, undo, the tools, pairing, backups
│  └─ the apps' dev server (Vite), on the hub only
├─ :8788 on the home network: the pages and one sealed route (screens.js), http, or https with your certificate
└─ :8789 (optional): Claude and ChatGPT's connector at your own https address (web-mcp.js)

phones, laptops, the TV, an old tablet: browsers, each paired with its own key
├─ /screen/  the home screen: Today, the tabs, the apps, timers, Opie's pill
├─ /phone/   someone's phone: their day, lists, calendar, chores, Opie's pill
├─ /tv       a TV's layout (it only shows)
└─ /hub/     the hub's settings, on a settings device only

Opie cloud (optional): live voice and typed questions (OpenAI), cloud backups, the relay from away
```

It is the tablet's bridge, unchanged in what it does, with the keeper as its host instead of the tablet's shell
([host.md](host.md); `OPENHOUSE_HOST=keeper`, set by `hub/start.sh`). The bridge never asks whether it's on a hub: the
keeper says it has no screen of its own (`cards`), and that turns on the few things the tablet's shell did on its
screen (`bridge/headless.js`, `bridge/hub.js`).

## Same as the tablet, and what differs

The same: the household's data and apps, undo, plugins, the heartbeat, the assistant's tools, pairing and sealing for
every device (`screens.js`), the phone and screen pages, the TV's layout, backups (the same encrypted format and
recovery code), linking to a family account (the same link code), the relay from away, the workshop for someone's
Claude or ChatGPT on a computer, and the connector at the household's own address.

| | Tablet | Hub |
|---|---|---|
| Where it runs | proot Ubuntu inside the Android app | Linux arm64 or x86_64 (installed, or Docker) or a Mac, natively |
| Its own screen | the kiosk home screen | none: every screen is a browser |
| Settings | the shell's, behind the PIN | `/hub/` on a settings device (below), behind the PIN once one is set |
| First setup | on the tablet, or from a phone with the setup code | type the code the hub printed when it started, then the same steps on that device |
| Calendar and album links, the own OpenAI key, the PIN | the shell, sealed with Android's keystore | the keeper (`hub/keeper.mjs`), sealed, beside the data folder |
| "Is this OK?" cards | on the tablet | on the settings page and grown-ups' phones |
| Two-way calendars, Google Photos | the shell's sign-ins | the keeper's, signed in from the settings device |
| Saying yes to a new device | Allow on the tablet | Allow on the settings page |
| Opie | wake word on the tablet, or a tap | a tap on the pill, in any browser that may use the microphone; "Hey Opie" on a screen that listens |
| Backups to a drive | a USB drive the shell owns | a folder: a mounted drive, a share, a Docker volume (`OPENHOUSE_BACKUP_DIR`) |
| Updates | the shell's self-update | Docker: a newer image. Linux or a Mac: Update on the settings page (git pull, build, restart) |
| The bridge's secret | a new one each boot from the shell | one kept in the data folder (`.bridge-token`, 0600) |

Not on the hub, by design: control of Android apps (device_action, the shell's accessibility service) and Android's
Bluetooth. The hub reaches devices on the Wi-Fi as the tablet's bridge does (TVs, speakers, printers: `bridge/devices`).

### The keeper (what the tablet's shell keeps)

The tablet's shell keeps a few things out of the bridge's reach: the calendar links, the iCloud albums' links, the
household's own OpenAI key and the PIN. On a hub that's the keeper, `hub/keeper.mjs`: its own process, started by
`hub/start.sh` from the code (not the data folder's copy), on loopback with a token made at each start. What it keeps
is sealed (AES-256-GCM) in its own folder beside the data folder, never inside it, so the assistant's file tools and
backups never reach it (`OPENHOUSE_KEEPER_DIR`: `<data>-keeper` by default; Docker `/keeper`; a Mac
`~/Library/Application Support/OpenHouse Keeper`). The seal key is in the login Keychain on a Mac and in a 0600 file
in the keeper's folder on Linux. Like the shell, it reads the calendars and albums itself and hands the bridge only
what they say, and it adds the OpenAI key to the bridge's calls at OpenAI's fixed addresses; nothing it keeps is ever
answered back. It answers the same requests as the tablet's shell, the same way (host.md), so add_calendar,
add_photo_album, the own key, the cards and the setup work the same way; it holds the cards until a person answers
them on a settings device or a grown-up's phone, and checks the PIN itself. A bridge set to the keeper with none
running starts one of its own (a laptop trying it).

### Setup, cards and the PIN

- **The setup.** The first settings device (the code from the console) goes straight into the same setup a tablet's
  phone shows (`chat/src/setup-flow.jsx`): who lives here, where, calendar links, iCloud albums, Opie's AI (their own
  OpenAI key), the PIN, the voice, then invites for the family. The hub's bridge moves the steps on itself
  (`hub-setup.json` in the data folder).
- **"Is this OK?" cards.** What the tablet asks someone there (a workshop fix, a plugin, an app made here, a calendar
  sent by the assistant) shows on the settings page and on grown-ups' phones (`chat/src/asks.jsx`), with its yes and No; one that needs the PIN asks for it there. Nobody
  answering is a no. On a hub, a fix from the workshop never goes in without a yes.
- **The PIN.** Once one is set (in the setup or on the settings page), a settings device asks for it before changing
  settings, and again after 10 minutes. Cards that need it ask for it on the card. A lost PIN: run
  `hub/owner-code.sh --forget-pin` on the hub.

- **Signing in to calendars and Google Photos.** iCloud: the Apple ID and an app-specific password, typed on the
  settings device, kept by the keeper, which signs every CalDAV request the bridge's `calendar-sync.js` makes. Google
  (calendars and photos, on a hub linked to an Opie account): the sign-in opens on the settings device and comes back
  from the cloud to the hub's own bare address (`http://<hub>:8788/#gc=…`, the same `/g/done` a tablet's page gets),
  where `chat/hub-back.js` hands it to the settings page, which sends it sealed to the keeper. The keeper keeps a
  calendar's refresh token, or picks with Google's Picker and copies the photos, the token in memory only. Which
  calendars show is chosen on the settings page. The cloud only sends back to an `http://` address, so a hub on its own
  https (`HUB_TLS_CERT`) signs in to Google from its http address.
- **"Hey Opie".** A screen (`/screen/`, on https or localhost so it may use the microphone) offers once to listen for
  its name. Then it sends its microphone, a third of a second at a time and sealed, to the hub's wake model
  (`/voice/listen`, the tablet's `voice-worker.js`), and the name starts Opie's live voice on that screen. The sound
  is scored and dropped. `hub/build.sh` fetches the model (about 4 MB) and onnxruntime-node into `runtime/hub-voice`.
- **A bad update.** `hub/update.sh` keeps the version before; if the new one stops within a minute of starting,
  `hub/start.sh` goes back to it by itself, once. The settings page has Go back too.

Not on the hub yet:
- **A microphone on the hub itself.** "Hey Opie" is heard by a screen that's listening, not by the hub's own box.
- **Speech out on its own.** What Opie says unasked (a follow-up's time, an app's `say`) goes to the tablet's speaker;
  a hub has none, and screens don't say it yet.
- **The devices sheet, mail attachments, health check-ins** to the cloud: the tablet's shell does these; untouched here.
- **A separate user for the keeper on Linux.** It runs as the hub's user, in its own folder; a user of its own would
  keep even code run as the hub's user away from what it keeps.
- Untried: a real Google sign-in (needs a linked hub), a real "Hey Opie" (synthetic voices don't wake the model, and
  the test browser blocks the microphone), Linux, Docker, the LaunchAgent.

## Live voice from other devices

The session is one script, `chat/live/live-session.cjs`, run by both the tablet (LiveVoice.kt loads it from the app's
assets) and every browser (`chat/src/live-voice.js`, as its host). A tap on Opie's pill starts it; the browser sends
its WebRTC offer to the hub, sealed; the hub starts the session through the cloud (`/live/start`, the same call the
tablet makes), and audio then goes between the browser and OpenAI. The household's tools run on the hub
(`/live/tool`), so a phone reaches only what its pairing allows. The `voice` scope: screens and grown-ups' phones, not
kids' phones or TVs.

A browser lets a page use the microphone only on https or `localhost`. So on the hub's plain http address the pill
isn't shown. Ways to have it:
- the hub on https on the home network: `HUB_TLS_CERT` and `HUB_TLS_KEY` (a certificate from `tailscale cert`, or
  `mkcert` with its root trusted on the phones);
- a Tailscale https address for the hub (`tailscale serve --https=443 http://localhost:8788`);
- on the hub's own machine, `http://localhost:8788`.

It needs the hub linked to a family account and live voice turned on in the settings page.

## Install

Any always-on computer on the home network will do. Which way to run it:

| Machine | How | Finds TVs and speakers on the Wi-Fi |
|---|---|---|
| A Raspberry Pi, a NUC, an old laptop, any Debian or Ubuntu box (arm64 or x86_64) | `hub/install.sh` | Yes |
| A Linux machine or NAS that already runs Docker | `hub/compose.yml` (host networking) | Yes |
| A Mac that stays on (a mini) | `hub/install-mac.sh` (native) | Yes (tried: 6 of 6 found) |
| Docker Desktop on a Mac or Windows | `hub/compose.desktop.yml` | No: its containers live in a VM (tried on a Mac: 2 of 6, the VM's own) |
| Windows | Ubuntu under WSL 2 with mirrored networking, then `hub/install.sh` | Should, untried |

Whichever way, the hub prints a code when it starts with no settings device. On a phone or computer on the same Wi-Fi,
open `http://<the machine>:8788/hub/` and type it: that device is the hub's settings device. From there add phones (each
gets a code to type at `/phone/`, then Allow), screens and laptops (`/screen/`), the TV (`/tv` on the TV, then type its
code on the settings page), and more settings devices.

### Linux (a Pi, a NUC, any Debian or Ubuntu machine)

```bash
curl -fsSL https://raw.githubusercontent.com/mrubens/openhouse/main/hub/install.sh | sudo bash
```

Or from a checkout: `sudo hub/install.sh`. It installs git and Node 22, clones Opie into `/opt/openhouse`, builds
it, and starts it as the `openhouse` service, with its data in `/var/lib/openhouse`. The code is in
`journalctl -u openhouse` and `/var/lib/openhouse/hub-setup.txt`. Backups go to `/var/lib/openhouse/backups` unless
`OPENHOUSE_BACKUP_DIR` is set in `/etc/default/openhouse` (a USB drive's mount point, say). Update from the settings page,
or `sudo -u openhouse /opt/openhouse/hub/update.sh && sudo systemctl restart openhouse`.

### Docker on Linux

```bash
git clone https://github.com/mrubens/openhouse.git && cd openhouse
docker compose -f hub/compose.yml up -d --build
docker logs openhouse
```

It shares the machine's network (`network_mode: host`): finding devices on the Wi-Fi is multicast and a sweep of the
home network, which a container's own network doesn't reach. It answers on 8788 (and 8789 only if the own-address
connector is on). The household's things are in `hub/data` (the `/data` volume); backups go to `hub/backups`
(`/backups`): point that at a USB drive or a share. Update with `docker compose -f hub/compose.yml up -d --build` from a
newer checkout (images aren't published yet).

### A Mac

```bash
curl -fsSL https://raw.githubusercontent.com/mrubens/openhouse/main/hub/install-mac.sh | bash
```

Natively, not in Docker, so it finds the devices on the Wi-Fi. It needs Apple's command line tools (for git; it opens
their installer if they're missing), puts Opie in `~/OpenHouse` with its own Node, the household's things in
`~/Library/Application Support/OpenHouse Hub`, and starts it at login as a LaunchAgent (`computer.openhouse.hub`). It runs
under `caffeinate`, so the Mac doesn't go to sleep while the hub runs; a laptop still sleeps with its lid shut, so a Mac
that stays on (a mini) is the right kind. If macOS asks whether node may accept incoming connections, Allow: that's
phones reaching it. Update from the settings page (launchd starts it on the new code). To take it off:
`launchctl bootout gui/$(id -u)/computer.openhouse.hub` and delete `~/Library/LaunchAgents/computer.openhouse.hub.plist`.

Docker Desktop on a Mac works too (`docker compose -f hub/compose.desktop.yml up -d --build`, a forwarded port) for
phones, screens and the TV's layout, but not for finding or controlling devices on the Wi-Fi.

### Windows

Not natively: the hub's scripts and the bridge's backups and undo lean on bash, tar and git as Linux and macOS have
them, which would be real work to port for a small audience. Two ways that should work, neither tried yet:
- **WSL 2 (recommended):** Windows 11 with Ubuntu under WSL, mirrored networking on (`networkingMode=mirrored` under
  `[wsl2]` in `%UserProfile%\.wslconfig`, so the hub is on the home network itself) and systemd on (the default for
  new Ubuntu installs under WSL), then `hub/install.sh` inside Ubuntu as on Linux. Windows' firewall has to allow
  inbound 8788. WSL stops when Windows sleeps or nobody's signed in, so the machine has to stay on and signed in.
- **Docker Desktop:** `hub/compose.desktop.yml`, with the same limit as on a Mac: no devices on the Wi-Fi.

### Sharing a computer with other things

The hub uses 127.0.0.1:8787 and :5173 inside, and 8788 on the network. If those are taken, set `PORT`, `VITE_PORT` and
`SCREENS_PORT` (in `/etc/default/openhouse`, the LaunchAgent's environment, or the compose file).

### A lost settings device

On the hub itself: `docker exec openhouse /opt/openhouse/hub/owner-code.sh`; on Linux
`sudo -u openhouse /opt/openhouse/hub/owner-code.sh`; on a Mac `~/OpenHouse/hub/owner-code.sh`. It prints a new code
(24 hours, once). Remove the old device on the settings page.

## Updates and identity

- **Updates.** A Docker hub is its image: a release is a new image, and the household (or Watchtower, if they run it)
  pulls it; the data volume stays. A hub installed on Linux or a Mac is a git checkout: Update on the settings page runs `hub/update.sh` (a
  fast-forward pull and a build), then the bridge exits and systemd or launchd starts it on the new code; `hub/start.sh` copies the
  new bridge into the data folder each start, as the tablet's shell does from a new app. Images aren't published yet:
  build from a checkout.
- **Linking to the cloud.** The same device link as the tablet: the settings page asks for a link code
  (`/cloud/link/start`, named "Home hub"), someone types it on the account's web page, and the hub holds its device
  credential in `.cloud/` in the data folder (never in a backup). Optional: without it, the hub keeps the household's
  day, lists and apps on the home network, with no Opie.
- **The connector for Claude and ChatGPT.** Through the cloud's relay, as the tablet (Reach the hub from away, on the
  settings page), or at the household's own https address: port 8789 behind a Tailscale Funnel or a tunnel, turned on
  on the settings page (`web-mcp.js`). Either way, signing in is pairing with a code from the settings page.

## Safety

- **Two ports, nothing else.** The bridge itself listens on 127.0.0.1 inside the hub. 8788 serves the pages and one
  sealed route; every request on it is sealed with the device's own key, and a device's scopes are an allowlist of
  routes (`screens.js` RULES). 8789 is only the connector, and only when turned on.
- **The settings device.** Only a device with the `admin` scope reaches the hub's settings: the one that typed the code
  printed on the hub's console (so whoever has the console, or the box, is the owner), and the ones it adds. Phones,
  screens and TVs never get it. A new code needs the bridge's secret, which is only on the hub.
- **What's on the hub's disk.** The data folder holds the household's things and the bridge's secret and state (0600
  where it matters). Backups leave the hub encrypted, with a key from a recovery code only the household holds. Whoever
  can read the data folder can read the household's things, as with the tablet's storage: keep the hub where the
  household keeps its router.
- **Household data only to services the household chose.** The hub sends nothing anywhere until someone links an
  account or turns on backups, the relay or the connector.

## Files

- `hub/Dockerfile`, `hub/compose.yml` (Linux, host networking), `hub/compose.desktop.yml` (Docker Desktop): the image
  (Node 22 on Debian, git, the built pages and apps' packages).
- `hub/start.sh`: the hub's start, shared by Docker, Linux and the Mac. `hub/build.sh`: building from a checkout.
- `hub/install.sh` (Linux), `hub/install-mac.sh`, `hub/update.sh`, `hub/owner-code.sh`.
- `hub/demo.mjs`: the demo household for the iPhone app's review ([iphone-app.md](iphone-app.md)).
- `hub/keeper.mjs` (the keeper: the host, [host.md](host.md)), `bridge/host.js` (picking the host, what it can do),
  `bridge/headless.js` (for a host with no screen: its cards on devices, the setup's steps, the PIN lock).
- `bridge/hub.js` (`/hub`, updates, the settings code), `bridge/folder-backup.js`, `screens.js` (the `voice` and `admin`
  scopes, https), `server.js` (live voice's start through the cloud for a device; the settings routes on a hub).
- `chat/src/hub.jsx` (the settings page), `chat/src/setup-flow.jsx` (the setup's steps, shared with the phone page), `chat/src/talk.jsx` (Opie's pill), `chat/src/live-voice.js`,
  `chat/live/live-session.cjs` (the session, shared with the tablet).
- `bridge/test/hub.test.mjs`.

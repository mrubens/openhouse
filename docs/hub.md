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
2026-11-26: the keeper, the setup from the settings device, the cards (settings devices and adults' phones), the
PIN, two-way Google and iCloud calendars, Google Photos, "Hey Opie" on a screen that says yes, and going back from a
bad update (below). The pages still say "the
tablet" in places (the phone's notes, the TV's empty view, the cloud backup's hint); the join page already says "the
hub's settings page" on a hub.
2026-11-28: tried in Docker on a Mac standing in for Linux (arm64 natively, x86_64 emulated), and `hub/install.sh`
on Debian 12 with systemd in a container, both kinds. Fixed on the way: the image stopped at once (the screen client
bridge/satellite.js loads wasn't in it), "Hey Opie" was missing from every image (no curl in the build, the wake
model left out of the build's files) and from every x86_64 install (onnxruntime-node's installer failed fetching the
CUDA build), and a checkout's `hub/data`, `hub/keeper` and `hub/backups` weren't ignored (the keeper's seal key could
go into the image's build), and the setup could end without a PIN (Next on the PIN step with nothing typed). From one browser at localhost: the setup, the home screen, a typed question answered
through the hub (by the local cloud's stand-in, linked like a real account), and a spoken one up to the session's
start (the hub took the browser's offer to the cloud and back; the browser pane blocks the microphone, and the
stand-in isn't OpenAI, so no audio). A backup made on the hub restored on another bridge linked to the same account.
Still untried: a real Pi or x86_64 machine, host networking (Docker Desktop's is a VM's), a whole spoken conversation.

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
| "Is this OK?" cards | on the tablet | on the settings page and adults' phones |
| Two-way calendars, Google Photos | the shell's sign-ins | the keeper's, signed in from the settings device |
| Saying yes to a new device | Allow on the tablet | Allow on the settings page |
| Opie | wake word on the tablet, or a tap | a tap on the pill, in any browser that may use the microphone; "Hey Opie" on a screen that listens |
| Backups to a drive | a USB drive the shell owns | a folder: a mounted drive, a share, a Docker volume (`OPENHOUSE_BACKUP_DIR`) |
| Updates | the shell's self-update | Docker: a newer image. Linux or a Mac: Update on the settings page (the newest release, build, restart) |
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
in the keeper's folder on Linux.

On Linux (`hub/install.sh`) the keeper is a service of its own, `openhouse-keeper`, as a user of its own: its folder
(`/var/lib/openhouse-keeper`, the seal key in it) is that user's, 0700, so nothing run as the `openhouse` user (the
bridge, the household's apps, the assistant's tools) can read the seal key or what's sealed. It runs a copy of its code
in `/opt/openhouse-keeper` that only root can change, since the checkout in `/opt/openhouse` is the `openhouse` user's
(the settings page updates it). The trade-off: Update on the settings page moves the bridge on, never the keeper;
`sudo hub/install.sh` again moves the keeper on. Its token is in `/etc/openhouse/keeper.token` (the bridge reads it to
call the keeper, which never answers back what it keeps), and it's in the `openhouse` group only to read the bridge's
secret. Deriving the seal key from something the bridge can't read wouldn't need the second user, but every such
thing (a TPM, systemd's credentials) is opened by whatever process the key's user runs, so the bridge would open it
too. On a Mac (the login Keychain, as the bridge's user) and in Docker (one container, as root) the keeper is still the
bridge's user: its folder keeps it out of the assistant's file tools and the backups, not out of code run as that user.

Like the shell, it reads the calendars and albums itself and hands the bridge only
what they say, and it adds the OpenAI key to the bridge's calls at OpenAI's fixed addresses; nothing it keeps is ever
answered back. It answers the same requests as the tablet's shell, the same way (host.md), so add_calendar,
add_photo_album, the own key, the cards and the setup work the same way; it holds the cards until a person answers
them on a settings device or an adult's phone, and checks the PIN itself. A bridge set to the keeper with none
running starts one of its own (a laptop trying it).

### Setup, cards and the PIN

- **The setup.** The first settings device (the code from the console) goes straight into the same setup a tablet's
  phone shows (`chat/src/setup-flow.jsx`): who lives here, where, calendar links, iCloud albums, the PIN, then invites
  for the family (their own OpenAI key is on the settings page). The hub's bridge moves the steps on itself
  (`hub-setup.json` in the data folder).
- **"Is this OK?" cards.** What the tablet asks someone there (a workshop fix, a plugin, an app made here, a calendar
  sent by the assistant) shows on the settings page and on adults' phones (`chat/src/asks.jsx`), with its yes and No; one that needs the PIN asks for it there. Nobody
  answering is a no. On a hub, a fix from the workshop never goes in without a yes.
- **The PIN.** Once one is set (in the setup or on the settings page), a settings device asks for it before changing
  settings, and again after 10 minutes. Cards that need it ask for it on the card. The keeper counts wrong tries per
  device, kept sealed through restarts: after 5 in a row that device waits a minute, then twice as long after each
  further wrong one, up to a day; a right one starts it again. All devices together get 20 before everyone waits the
  same way (the bridge says which device a try is from, so that's the bound if it made names up). A lost PIN: on the
  hub, as root on Linux (`sudo touch /var/lib/openhouse-keeper/forget-pin`, then `owner-code.sh --forget-pin`), or
  `hub/owner-code.sh --forget-pin` in Docker or on a Mac. The keeper forgets it only after that file is in its folder,
  never on the bridge's secret alone.

- **Home Assistant.** The settings page's Home Assistant section does what the tablet's Devices sheet does: Connect
  (its address and a long-lived token, typed there; the keeper checks it with Home Assistant, then keeps it once
  someone says yes on its card, with the PIN, shown in that section), then a tick for each light, switch, scene, media
  player and thermostat Opie may use, and Disconnect. The token goes through the bridge on its way to the keeper and
  is never kept, logged or answered back there. Opie's `home_assistant` connect opens that section on the settings
  devices that have the page open. There's no QR code for sending it from a phone, as the tablet has: the settings
  page is already in a phone's or computer's browser, where the token is copied from Home Assistant.
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
- **A bad update.** `hub/update.sh` keeps the version before; a build that fails puts it back at once, and if the new
  one stops within a minute of starting, `hub/start.sh` goes back to it by itself, once. The settings page has Go back
  too; going back forgets the version before only once that one has built.

Not on the hub yet:
- **A microphone on the hub itself.** "Hey Opie" is heard by a screen that's listening, not by the hub's own box.
- **Speech out on its own.** What Opie says unasked (a follow-up's time, an app's `say`) goes to the tablet's speaker;
  a hub has none, and screens don't say it yet.
- **The devices sheet, mail attachments, health check-ins** to the cloud: the tablet's shell does these; untouched here.
- **A separate user for the keeper on a Mac or in Docker** (Linux has one, above).
- Untried: a real Google sign-in (needs a linked hub), a real "Hey Opie" (synthetic voices don't wake the model, and
  the test browser blocks the microphone), Linux, Docker, the LaunchAgent.

## Live voice from other devices

The session is one script, `chat/live/live-session.cjs`, run by both the tablet (LiveVoice.kt loads it from the app's
assets) and every browser (`chat/src/live-voice.js`, as its host). A tap on Opie's pill starts it; the browser sends
its WebRTC offer to the hub, sealed; the hub starts the session through the cloud (`/live/start`, the same call the
tablet makes), and audio then goes between the browser and OpenAI. The household's tools run on the hub
(`/live/tool`), so a phone reaches only what its pairing allows. The `voice` scope: screens and adults' phones, not
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
| A Home Assistant OS or Supervised machine | the add-on (`ha-addon/`, below) | Yes (host network, untried) |
| Docker Desktop on a Mac or Windows | `hub/compose.desktop.yml` | No: its containers live in a VM (tried on a Mac: 2 of 6, the VM's own) |
| Trying it on any computer (README) | `hub/compose.desktop.yml` | No |
| Windows | Ubuntu under WSL 2 with mirrored networking, then `hub/install.sh` | Should, untried |

Whichever way, the hub prints a code when it starts with no settings device. On a phone or computer on the same Wi-Fi,
open `http://<the machine>:8788/hub/` and type it: that device is the hub's settings device. From there add phones (each
gets a code to type at `/phone/`, then Allow), screens and laptops (`/screen/`), the TV (`/tv` on the TV, then type its
code on the settings page), and more settings devices.

### Linux (a Pi, a NUC, any Debian or Ubuntu machine)

```bash
curl -fsSL https://raw.githubusercontent.com/mrubens/opie/main/hub/install.sh | sudo bash
```

Or from a checkout: `sudo hub/install.sh`. It installs git and Node 22 (checked against Node's own sha256), clones
Opie into `/opt/openhouse` at the newest release, builds it, and starts it as the `openhouse` service (and the keeper
as `openhouse-keeper`), with its data in `/var/lib/openhouse`. The code is in
`journalctl -u openhouse` and `/var/lib/openhouse/hub-setup.txt`. Backups go to `/var/lib/openhouse/backups` unless
`OPENHOUSE_BACKUP_DIR` is set in `/etc/default/openhouse` (a USB drive's mount point, say). Update from the settings page,
or `sudo -u openhouse /opt/openhouse/hub/update.sh && sudo systemctl restart openhouse`; `sudo hub/install.sh` again
also moves the keeper on.

### Docker on Linux

```bash
git clone https://github.com/mrubens/opie.git && cd opie
docker compose -f hub/compose.yml up -d --build
docker logs openhouse
```

It shares the machine's network (`network_mode: host`): finding devices on the Wi-Fi is multicast and a sweep of the
home network, which a container's own network doesn't reach. It answers on 8788 (and 8789 only if the own-address
connector is on). The household's things are in `hub/data` (the `/data` volume); backups go to `hub/backups`
(`/backups`): point that at a USB drive or a share. Update with `docker compose -f hub/compose.yml up -d --build` from a
newer checkout (the settings page shows that command). A release tag builds the image for both kinds in CI
(`.github/workflows/hub-image.yml`); publishing it is off until we decide to.

### A Mac

```bash
curl -fsSL https://raw.githubusercontent.com/mrubens/opie/main/hub/install-mac.sh | bash
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

### In Home Assistant (an add-on)

`ha-addon/` is a Home Assistant add-on repository, ready to be the root of a public repo of its own
(`repository.yaml`, and the add-on in `opie/`). Someone with Home Assistant OS or Supervised adds the repo's address
under Settings → Add-ons → Add-on store → Repositories, installs Opie, and opens the Log for the code. It runs the
hub's own image (`ghcr.io/mrubens/openhouse/hub`, the tag in `opie/config.yaml`'s `version`), so there's nothing
separate to build. Tried on 2026-11-28 in Docker on a Mac with a stand-in Supervisor (below); not yet in a real
Home Assistant.

- **Starting.** `hub/start.sh` sees the Supervisor (`SUPERVISOR_TOKEN` and `/data/options.json`) and hands over to
  `hub/addon.sh`: the data folder is `/data/hub`, the keeper's `/data/keeper` (root's, 0700), backups to a folder go
  to `/share/opie`. It starts the hub again when it stops (a restore, a crash), since Home Assistant restarts an
  add-on only with its watchdog on.
- **Home Assistant, with nothing typed.** `homeassistant_api: true` gives the add-on a token for
  `http://supervisor/core/api`. Only the keeper gets it (`OPENHOUSE_ADDON=1`): it is the keeper's Home Assistant
  connection, through the same rules as a typed token (`bridge/devices/ha-rules.js`), and `/homeassistant/set` and
  `/remove` say it's the add-on's. The bridge and the apps' server run as the image's `node` user
  (`OPENHOUSE_RUN_AS`), so they can read neither the keeper's folder nor its environment, nor that of the processes
  that started them. Installing the add-on is the household's yes for the connection; they still pick what Opie may
  use, under Home Assistant on the settings page (that section also connects a hub that isn't the add-on, by address
  and long-lived token, with a card and the PIN).
- **Its own port, not ingress.** The add-on is on the host's network (`host_network`), as `compose.yml` is: phones,
  TVs and screens reach `http://<Home Assistant's address>:8788/` without a Home Assistant account, pair with keys of
  their own, and it finds devices on the Wi-Fi. Ingress would put every page behind a Home Assistant sign-in, under
  a path that changes per install (the pages use absolute paths), and in an iframe of Home Assistant's own page;
  and a phone's or TV's page has to reach the hub with no Home Assistant account at all. Open Web UI goes to `/hub/`.
- **The microphone.** A browser lets a page use it only on https or localhost. On the hub's plain address the pill
  isn't shown; with the `ssl` option the hub serves https with the certificate in `/ssl` (Home Assistant's own: phones trust it
  only at the name it was made for, so that name has to reach Home Assistant on the home network), and a hub linked to an Opie account gets its own
  https name on the home network anyway (`bridge/lan-tls.js`). Under ingress it would depend on Home Assistant's own
  https and its iframe allowing the microphone, untried.
- **Backups.** Home Assistant's backups include `/data` but leave out the keeper (`backup_exclude`), as every Opie
  backup does: after restoring one, the calendar links, own OpenAI key and PIN are added again.
- **Updates.** Home Assistant pulls the image tagged with the add-on's `version`. `hub-image.yml` tags each release's
  image `1.0.NN` too (and `v1.0.NN`), and `ha-addon/.github/workflows/follow-releases.yml`, in the add-on's repo,
  moves `version` forward once that image is public. The settings page shows no Update button there.
- **A lost settings device or PIN.** The add-on's options `settings_code` and `forget_pin` (whoever may change them in
  Home Assistant is the hub's console).

Tried for real (Docker Desktop on a Mac, arm64, the image built from this checkout, a container named `supervisor`
answering `/core/api/` like the Supervisor's proxy, with a stand-in token): it started as an add-on, printed the code;
the keeper ran as root with the token and the bridge and Vite as `node` without it (`/proc/*/environ`, the keeper's
folder: denied to `node` on a Docker volume); the bridge listed the stand-in's lights, switch, speaker, thermostat and
scene, never its lock or garage door; a settings device in the browser paired with the code and picked two lights
under Home Assistant, and a picked light was turned off through `supervisor/core/api` with the token; the home screen
showed at `/screen/`; a killed bridge came back on its own; `docker stop` stopped it at once; `settings_code` and
`forget_pin` printed a code and forgot the PIN; `ssl` served the certificate from `/ssl`. Needs a real Home Assistant:
the Supervisor pulling the image and the repo's store listing, the real token and proxy, `host_network` (and finding
devices), the watchdog, Open Web UI, `backup_exclude`, the microphone on https.

Publishing it (the owner, once):
1. A release after this change (a `v1.0.NN` tag), so its image has the add-on's start and is tagged `1.0.NN`; on
   GitHub make the package `ghcr.io/mrubens/openhouse/hub` public (Packages → hub → Package settings → Change
   visibility), once.
2. Create the public repo (`ha-addon/repository.yaml`, `README.md` and `opie/config.yaml` name it
   `mrubens/opie-home-assistant`; change those if it's called something else), and copy `ha-addon/`'s contents to
   its root as they are, `.github/` included: `cp -R ha-addon/. <the new repo>/`.
3. Set `version` in `opie/config.yaml` to that release without the v (and the CHANGELOG's top), commit and push.
   From then on the workflow moves it forward each release (it runs hourly; Actions must be on, with write
   permission for the workflow's token under Settings → Actions → General).
4. In Home Assistant: add the repo's address under Repositories, install Opie, start it, open its Log.

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
  pulls it; the data volume stays. A hub installed on Linux or a Mac is a git checkout: Update on the settings page runs `hub/update.sh` (to the
  newest release tag, `v*`, on its branch and only ever forward, then a build; the tags aren't signed yet, so it trusts
  GitHub's https for what a tag points at), then the bridge exits and systemd or launchd starts it on the new code; `hub/start.sh` copies the
  new bridge into the data folder each start, as the tablet's shell does from a new app. Images are built per
  release in CI but not published yet: build from a checkout.
- **Moving to a device of its own.** A backup made on the hub restores on a device like any other (the same format,
  bridge/backup.js; the cloud lists the household's backups to every device linked to it; a folder's files are named as
  a USB drive's, in `Display backups`). What the keeper holds never goes in a backup, as on the tablet: calendar and
  album links, the household's own OpenAI key and the PIN are added again on the device. The settings page says so
  in one line under This hub.
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
- **Tailscale is the computer's own.** Away from home with Tailscale (the settings page) uses Tailscale installed and
  signed in on the hub's computer (in Docker, its socket and CLI shared in, `hub/compose.yml`), never one Opie runs
  itself: that one, in userspace networking, would put every port on the computer's 127.0.0.1 on the tailnet
  ([networking.md](networking.md#limits-and-security)).
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
- `hub/addon.sh` and `ha-addon/` (the Home Assistant add-on and its repository).
- `hub/demo.mjs`: the demo household for the iPhone app's review ([iphone-app.md](iphone-app.md)).
- `hub/keeper.mjs` (the keeper: the host, [host.md](host.md)), `bridge/host.js` (picking the host, what it can do),
  `bridge/headless.js` (for a host with no screen: its cards on devices, the setup's steps, the PIN lock).
- `bridge/hub.js` (`/hub`, updates, the settings code), `bridge/folder-backup.js`, `screens.js` (the `voice` and `admin`
  scopes, https), `server.js` (live voice's start through the cloud for a device; the settings routes on a hub).
- `chat/src/hub.jsx` (the settings page), `chat/src/setup-flow.jsx` (the setup's steps, shared with the phone page), `chat/src/talk.jsx` (Opie's pill), `chat/src/live-voice.js`,
  `chat/live/live-session.cjs` (the session, shared with the tablet).
- `bridge/test/hub.test.mjs`.

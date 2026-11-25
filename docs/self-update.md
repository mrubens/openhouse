# Self-update

Fixes reach tablets without a USB cable or the Play Store. The Play Store doesn't fit the display: device owner can't
come from a Play install, and the display runs downloaded Linux binaries, installs other APKs and uses accessibility.
So the display updates itself from a URL we control, and a freshly reset tablet can be set up from a QR code.

What changes in an update: the display's APK (`computer.openhouse.shell`) and what it carries, the bridge and start script
(copied out on its first start, `Runtime.installAssets`). (Until 1.0.9 also the agent's own app; an update to 1.0.9
removes that app, `OldAgent.kt`.) Nothing else: the family's apps, files, chats, photos and drawings live in the display's data, which an
update leaves as it is. The update cover app (`computer.openhouse.host`) isn't updated this way (it has to stay put while
the display is replaced).

## The name, in one place

The product is **OpenHouse**, on openhouse.computer (decided 2026-11-19, provisional: the name is revisited before
the beta, and the IDs are permanent once a release reaches a tablet; updates.openhouse.computer's DNS is set up,
nothing is uploaded there yet). These settings in `shell/gradle.properties` carry it:

- `openhouse.releaseAppId` = `computer.openhouse`: the package IDs releases are built under (`release.sh` passes it
  as `openhouse.appId`): `<id>.shell` (the display), `.agent`, `.host` (the cover) and `.app.<id>` (each family app).
  Android updates an app only under the same ID, so once tablets run releases it can't change without resetting them.
- `openhouse.appId` = `dev.openhouse`: what every other build uses, so debug installs over adb (`install-display.sh`,
  `tablet-setup.sh`) still update a prototype tablet's display until it has moved. The code reads the IDs from
  `BuildConfig` and the scripts from `scripts/env.sh` (`DISPLAY_PKG`, `AGENT_PKG`, `HOST_PKG`). After the move the
  tablet takes only builds signed with the release key (a debug-signed `computer.openhouse.shell` can't install over
  it), so deploys go through `release.sh` (a numbered release, installed with `install-display.sh <apk>` and
  `OPENHOUSE_APP_ID=computer.openhouse`, or through self-update) and this becomes `computer.openhouse`. The Kotlin classes keep the code name
  (`dev.openhouse.shell.MainActivity` and so on), so anything naming a class names it in full: `computer.openhouse.shell/
  dev.openhouse.shell.ConfigReceiver`, never `<package>/.ConfigReceiver`.
- `openhouse.updateUrl` = `https://updates.openhouse.computer/v1/update`: where releases look for updates (the managed cloud's
  endpoint, or a static `update.json` served at that address: a static host ignores the query). Its DNS is set up;
  no release is uploaded there yet. `release.sh --update-url` overrides it.

Two more for moving tablets off the prototype's IDs ("Moving to OpenHouse", below): `openhouse.movedFrom` =
`dev.openhouse`, and `openhouse.releaseCert`, the release key's certificate SHA-256 .

## A release

A release is a folder on any static host (or a GitHub release):

```
update.json                         the manifest the tablets read
display-0.4.0.apk                   the display, signed with the release key
rescue-0.3.0-for-0.4.0.apk          the release before, built again just above this one (below)
```

`update.json`:

```json
{
  "schema": 1,
  "version": "0.4.0",
  "versionCode": 40000,
  "url": "display-0.4.0.apk",
  "sha256": "…",
  "size": 24141033,
  "rollout": 25,
  "minVersion": "0.2.0",
  "notes": "Timers keep going when the screen sleeps",
  "rescue": { "version": "0.3.0", "versionCode": 40001, "url": "rescue-0.3.0-for-0.4.0.apk", "sha256": "…", "size": 24141033 }
}
```

- **version / versionCode**: `major.minor.patch`; the code is `major·1 000 000 + minor·10 000 + patch·100`
  (`Releases.versionCode`). The last two digits are for the rescue build. A build made on a computer for USB
  (`assembleDebug`) is code 1, below every release.
- **url**: relative to the manifest, or absolute. https only (plain http only from the emulator's computer, 10.0.2.2,
  for testing).
- **sha256, size**: of the APK. The tablet checks both after downloading, and checks again before installing.
- **rollout**: percentage of tablets offered it. Each tablet makes a random ID once (sent nowhere except, when it isn't
  linked to a family, to the managed cloud's update endpoint, below) and hashes
  it with the version code to a number 0–99 (`Releases.bucket`): the same answer every time, so raising the number
  only adds tablets, and a different sample of tablets for each release. To widen a rollout, edit `update.json`.
- **minVersion**: tablets older than this take it whatever the rollout, and at the next quiet moment instead of at
  night. For a fix every tablet must have.
- **rescue**: see "Going back". Without one, a tablet installs the release only when someone asks for it.

The manifest isn't signed. It doesn't need to be for safety: whatever it says, a tablet installs only an APK that is
this app, newer than what it has, and signed with its own key. Someone who can change the manifest can hold updates
back or change the rollout, so keep the host's account safe.

## On the tablet (`Updater.kt`)

- **Checking**: a few minutes after the display starts, then once a day (an hour later after a failed check). Also
  from Settings: *Check for updates (version 0.3.0)* shows the version, what updates did lately, and, when one
  is downloaded, *Install now*. The manifest's URL is the one the release was built with (`--update-url`), or set
  over adb: `ConfigReceiver --es update_url …`. An empty URL means updates are off.
- **Downloading**: in the background, to `files/updates/` (the release and its rescue build). Each is checked: the
  SHA-256 and size match the manifest; it's this app (`computer.openhouse.shell`), at the manifest's version code, not a
  test build; and it's signed with the key the installed display is signed with, or one that key rotated to
  (`Releases.signerAllowed`, `Updater.verifyApp`). Android checks the signature again when it installs.
- **Installing**, without asking anyone (the display is device owner, so PackageInstaller needs no confirmation):
  only when the tablet is quiet (no turn running in the bridge, nothing being said or heard for two minutes, nobody
  has touched the screen for eight), between 2:00 and 5:00 local time unless the release is urgent (`minVersion`).
  Someone's *Install now* goes on at once. The update cover goes up first (`UpdateCover`, the same cover
  `install-display.sh` uses), the display is replaced, Android starts the new one (`UpdatedReceiver`), and the cover
  hands the screen back.
- **Healthy** (`UpdateHealth.kt`): the new display has to come up (the bridge answers `/state` and the home
  screen's page loads) and be able to update again: its own updater fetches and parses the manifest, by the same
  check as every day's, tried every ten minutes until it works. Then Settings says *Updated from 0.3.0 to 0.4.0*. The
  rescue build stays staged until a day after the install either way (or until a newer release comes), and is thrown
  away then.

### The managed cloud's endpoint

The update URL can also be the managed cloud's `GET {api}/v1/update` (`docs/cloud.md` on its branch). A URL whose
path ends in `/v1/update` gets `component=shell`, `versionCode`, `channel` (`ConfigReceiver --es update_channel beta`;
default `stable`) and, for a tablet not linked to a family, `installId` (the random ID). A linked tablet sends
`authorization: Device <credential>` from `files/display/.cloud/device.json` instead, only to that file's own host and
never across a redirect. The answer is the same shape as `update.json` (the server buckets the rollout and says
`rollout: 100`), or `{"upToDate": true}`; `checkAgainSeconds` sets the next check (15 min to a week). Tried against
the cloud's local server (`node lambda/local.ts`, its branch at dbb88f5) with a release published into it by its
`release.ts --local`: an unlinked emulator on 0.7.0, channel beta, was offered 0.8.0 with its rescue, downloaded and
checked both from the server's file path, installed, was healthy 15 s later, and its next check said *Up to date*.
Not tried: a linked tablet's credential, and the deployed service.

### Going back

Android won't install a lower version code over a higher one (a downgrade) for an app that isn't debuggable, even for
a device owner. So keeping the old APK isn't enough to go back to it. Instead each release carries a **rescue
build**: the release before it, built again from its tag with a version code one above the new release's. Going back
is then an ordinary upgrade.

Before installing, the display writes the rescue build into a PackageInstaller session and leaves it uncommitted, and
notes the update in `files/updates/pending.json`. `UpdateGuard` (its own process, `:guard`, apart from everything the
display does on screen) is woken when the new display arrives, after a restart, and by a job when it's time to look
again. It goes back when:

- the new display hasn't come up within five minutes, crashed or not. That's on the boot clock
  (`SystemClock.elapsedRealtime`), from the install, or from the start of this boot after a restart, and it has to
  come up again after every restart while the rescue is kept. A restart in the window gives it its five minutes
  again instead of a judgment seconds after boot. While someone has left kiosk mode (Android settings, Wi-Fi,
  *Leave kiosk mode*) it isn't judged at all, even across a restart: the display writes `files/updates/kiosk.json`
  when kiosk mode is left and again when it's back, and from then it has its five minutes again.
- a day after the install, none of its manifest checks has worked and at least three counted against it. A check
  counts only when an answer arrived (HTTP 200) and the release couldn't read it as a manifest or refused it by the
  checks it applies to every manifest, and only when Android has validated the network (so not a captive portal's
  page). Not getting an answer at all (offline, DNS, TLS, a timeout) or getting any other HTTP status proves nothing,
  since the network, the server or the host's setup may be the trouble: the rescue stays and it keeps trying hourly.
  So a release whose updater can't reach the host at all is never sent back for it; it waits for one that can.

To go back it puts the cover up and commits the staged session (or installs `rescue.apk` from the file if the session
is gone). The rescue build starts,
remembers that release failed here and never tries it again, and Settings says *Version 0.4.0 didn't start
properly, so this tablet went back to 0.3.0*. The next release (0.5.0 = 50000) is above the rescue build (40001), so it
updates as usual.

Going back is tried once. If the rescue install fails (its result says so, or there's no rescue build to install), or
it hasn't finished an hour after it started, the release stays: the display notes it in the history (*Version 0.4.0
didn't start properly, but going back to 0.3.0 failed (…), so it stays on 0.4.0*), throws the rescue away, takes the
cover down and checks for updates again as usual, so a newer release can still come.

A tablet that skipped releases goes back to the release before the broken one, not to the one it had. That's a
version other tablets are running.

## Building a release (`scripts/release.sh`)

```bash
scripts/release.sh 0.4.0 --rescue v0.3.0 --rollout 10 --notes "Timers keep going" --update-url https://…/update.json
```

It builds from a clean checkout of `--ref` (default `HEAD`; nothing uncommitted goes out), bundles the bridge, signs
the agent's app and puts it inside, signs the display, builds the rescue from the `--rescue` ref with the next
version code, and writes `update.json` into `dist/<version>/`. Tag each published release on the commit it was built
from (`release.sh` prints the `git tag -a v0.4.0 <commit>` and push to run) so the next one can name it as its rescue
and build exactly that code.

Before it goes out, boot both APKs on an emulator: `scripts/smoke.sh dist/0.4.0` (or `release.sh --smoke`, which
stops before `--publish` on a failure). It makes a throwaway emulator (no window; `--serial emulator-NNNN` uses one
already running, and anything that isn't an emulator is refused), installs the display, serves it the folder's
`runtime.tar.gz` over adb, waits for the bridge's `/state` and the home page, then installs the rescue over it as a
tablet going back would and checks it the same way; any `FATAL EXCEPTION` in OpenHouse's processes fails it. Updates
are pointed at nowhere so the emulator never takes the published release. 1.0.30 and its rescue: about 90 s in all
on an M-series Mac. It doesn't check the updater, kiosk mode or voice. `--publish github` uploads the folder to a GitHub release `v0.4.0` with `gh`; the tablets'
URL is then `https://github.com/<owner>/<repo>/releases/latest/download/update.json`. Otherwise copy the folder to
the static host as it is. Either way the URL is only a setting: a managed cloud can serve the same `update.json`
later (and decide the rollout per tablet itself).

Version codes are major·1,000,000 + minor·10,000 + patch·100; a rescue is +1. A build for one tablet that isn't
published (trying something on a tablet before a release) uses the free numbers in between, so it never
takes a release's number:

```bash
scripts/release.sh 1.0.6 --local 1 --ref origin/main --out ~/.openhouse/releases/1.0.6-local.1
```

That's `1.0.6-local.1`, version code 1000611 (1.0.6's + 10 + N, N from 1 to 79): above 1.0.6 and its rescue, below
1.0.7, so the next published release still updates that tablet. `<version>` is the newest the tablet already has
(published or local); the next local build on top of `1.0.6-local.1` is `--local 2`. No rescue, and the cloud's
`release.ts` refuses it. (Before this, a prototype tablet took unpublished 1.0.2, 1.0.5 and 1.0.6 under release numbers.)

### The release key

Made 2026-11-18 (certificate SHA-256 `0b24b214…eedd8`). Never in the repo. `scripts/release-key.sh` makes it once, in
`~/.openhouse/release/release.jks` (PKCS12, alias `release`; the key made 2026-11-18 says `CN=Roo Home release, O=Roo Code Inc.`, from before the
name changed, which nothing shows and nothing checks; new keys say `CN=OpenHouse release`), makes a random
password and keeps it in the Mac's login keychain (item `roo-home-release-key`), and prints the certificate's SHA-256
for `openhouse.releaseCert`. Keep the key file and the password in the password manager as well; lose the key and no
tablet takes an update again without being reset. `release.sh` reads `OPENHOUSE_RELEASE_KS`,
`OPENHOUSE_RELEASE_ALIAS`, `OPENHOUSE_RELEASE_KS_PASS` (apksigner's `pass:`/`env:`/`file:` forms; by default the
keychain item, else it asks). Signing is its own step after each build: gradle makes unsigned APKs, and only
`apksigner` gets the password, on its standard input, so nothing the builds run (gradle plugins, npm packages) can
read it from the environment.

### What a release may unpack

A release carries the SHA-256 of the Linux runtime it sets a tablet up with and of its voice set's `voice.json`
(`openhouse.runtimeSha256`, `openhouse.voiceSha256` in `shell/gradle.properties`; `Pinned.kt`). The display checks
the downloaded `runtime.tar.gz` before unpacking it and the voice manifest before reading it; one that doesn't match
is deleted and not used, and it tries again later. Whatever `runtime_url` or `voice_url` the QR code or adb gives, only
those files go on. Debug builds carry neither and take what they're given (`tablet-setup.sh`'s runtime from the computer).
`release.sh --runtime <runtime.tar.gz>` builds with that file's hash and copies it into the release folder (a
`runtime.tar.gz` already there is used the same way); a new runtime's hash goes in `gradle.properties` too.

No lineage for OpenHouse's IDs: no tablet ever ran a debug build under `computer.openhouse.*`, so releases are signed with
the release key alone (v2 and v3), and nothing signed with a debug key can pass as ours. `release-key.sh --lineage`
still makes the debug-to-release lineage for a package that tablets ran debug builds of (`OPENHOUSE_LINEAGE` in
`release.sh`): what it lets the debug key keep is in git history (installed-data and permission; not rollback, auth or
shared UID).

## Moving to OpenHouse (`Move.kt`, `scripts/move-tablet.sh`)

Tablets set up during the prototype run `dev.openhouse.shell`, debug-signed, as device owner, with the family's data
in its private folder. Android never renames a package, and a new package can't read the old one's files, so the old
display hands everything over itself, without a factory reset:

1. **The handover build.** `move-tablet.sh` builds the old display once more from this checkout under the old ID with
   `-Popenhouse.moveTo=computer.openhouse -Popenhouse.releaseCert=<sha>` (debug-signed, like the tablet's own) and
   installs it, then OpenHouse's update cover and display (from a `release.sh` folder). Once the new display is
   installed and signed with the release key, the old one lets it into kiosk mode and opens its `MoveActivity`
   ("Moving to OpenHouse…").
2. **The data.** The new display asks the old one (`MoveOut`, a content provider that answers only
   `computer.openhouse.shell` signed with the certificate built in) to stop its runtime, then reads its data folder as
   one tar through a pipe: `files/` (the family's folder, the runtime), `shared_prefs/`, `no_backup/`, but not the
   update downloads, the family apps' launcher entries (made again under the new IDs) or self-update's state. The
   calendar links come over the provider's own channel (`open calendar-links`), decrypted by the old app because their
   key is in its Android keystore, never as a file, and are sealed again with the new app's. (Until 1.0.5 they were
   written to `files/move`, which the copy skips: a prototype tablet's never arrived. A tablet that moved like that:
   `move-tablet.sh -s <serial> --old-again` while the old display is still there puts it on again, built from this
   checkout, and the new display asks it for its links within ten minutes when it has none.) Links the runtime made into the old data folder (proot keeps hard links as absolute links) are pointed at
   the new one.
3. **The check.** Every file of the family's folder must arrive at the size the old display listed; otherwise the
   move stops, the old display starts again as it was, and the new one says so. Only then the old display calls
   `DevicePolicyManager.transferOwnership` to the new display's admin (which says `<support-transfer-ownership/>`).
   The new display, as owner, claims Home and kiosk mode (`AdminReceiver.onTransferOwnershipComplete`,
   `DeviceOwner.setUp`), grants itself the microphone and notifications (`move-tablet.sh` gives it the adb-only
   grants `tablet-setup.sh` gave the old one: secure settings, no battery saving), and the old one, if it's started,
   only steps aside. If the new display came to the front a moment before it was the owner, its watchdog turns kiosk
   mode on once it is. Device control goes over too: at the handover the old display turns its own off for good and
   disables its accessibility service, and the new one, as owner and on each watchdog tick, drops the old service from
   the enabled list. Left on, the old service drew its assistant button (its own overlay) beside the new one's. Then
   nothing of the old display runs on: it stops its calendar reads (before 1.0.5 they went on posting its calendars to
   the new bridge every 15 minutes, and the new display posted none a minute later), its runtime and its screen, and
   its process ends; it starts again only to answer the new display's calls.
4. **The assistant's sign-in (until 1.0.9; there's no assistant app or sign-in now).** Once the new display's own assistant app is bound, the old assistant app writes its
   home folder (pi's sign-in and conversations) into a pipe whose reading end goes to the new assistant app
   (`EXPORT_HOME` / `IMPORT_HOME`). The displays only hand the pipe on; neither reads it. The new app keeps its own
   sign-in if it already has one. The display doesn't ask the family to sign in while this is pending (an hour at
   most). Then the old assistant app is hidden, which stops it (it held the runner's port, 8790), and the new one
   restarts to take the port.
5. **The old apps go**, a day after the new display has been healthy (bridge answering, home loaded): the old display,
   assistant app, cover and launcher entries. Until then the old display is there, untouched, with everything it had.

`move-tablet.sh -s <serial> --release <dir>` first checks the old display is the owner and there's room for a second
copy of its data plus 4 GB (the new assistant's runtime unpacks to about 2 GB), and backs up the family's folder to `~/Documents/openhouse-backups/` (skip with
`--no-backup`). It names the device every time, so the move can't land on another one.

Release builds aren't `testOnly` (Android won't self-install or QR-provision one that is), so `dpm
remove-active-admin` doesn't work on them: undoing device owner takes a factory reset, as with any managed device. They
aren't debuggable either, so `adb shell run-as` doesn't work on them: the helpers that use it (`rt.sh` from
`tablet-setup.sh`, `restart-bridge.sh`, `bridge-token.sh`, `voice-install.sh`, reading `files/display` over adb) work
only on a debug build.

## Setup without a cable (QR provisioning)

Android sets a freshly reset tablet up as a managed device from a QR code: on the first welcome screen tap six times
in the same spot, connect to Wi-Fi if asked, scan the code. Android downloads the display from the URL in the code,
checks the file against the checksum in it, installs it and makes it the tablet's owner, then asks the display how to
be set up (`ProvisioningActivity`: as the whole tablet's owner). Two consent screens follow (Android's own: "This
device belongs to your organization", "This device isn't private"). When Android's setup finishes it asks the display
to finish too: the display takes the code's extras, grants itself the microphone and makes itself Home, so the tablet
comes up on the display.

`scripts/provision-qr.sh` makes the code from a release APK:

```bash
scripts/provision-qr.sh dist/0.4.0/display-0.4.0.apk https://…/display-0.4.0.apk \
  --runtime https://…/runtime.tar.gz --update-url https://…/update.json [--wifi "Home" --wifi-password …]
```

What it holds (`qr.json`):

| key | value |
| --- | --- |
| `PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME` | `computer.openhouse.shell/dev.openhouse.shell.AdminReceiver` |
| `PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION` | the APK's https URL |
| `PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM` | SHA-256 of the APK file, base64url |
| `PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED` | `true` (the camera, Chrome and the rest stay) |
| `PROVISIONING_ALLOW_OFFLINE` | `true`: go on if Google's device-management app can't be updated first |
| `PROVISIONING_ADMIN_EXTRAS_BUNDLE` | `runtime_url` (the Linux runtime, too big for the APK), `update_url` |
| `PROVISIONING_WIFI_*` | optional; readable by anyone who sees the code |

The checksum is of the file, so a code is for one APK: point it at that release's own file, not a "latest" link. That
doesn't make setup stale: the display updates itself once it's up. A signer checksum would let one code serve every
release, but Android's setup compares it with the oldest key in the APK's lineage, which is the debug key (tried: it
reported the debug key's hash), and a code that trusts a debug key trusts anything signed with one.

What a family or tester does: reset the tablet (or unbox it), tap the welcome screen six times, scan, wait. The
display comes up, downloads its runtime from `runtime_url` and asks someone to sign in to the AI.

### The setup page (live since 2026-11-19)

`scripts/setup-page.sh <qr.svg> <out.html> <version>` makes one quiet page from `provision-qr.sh --out qr.svg`: the
code inline as SVG, three steps, no scripts or outside requests, `noindex`. It's published unlisted, linked from
nowhere, at https://d15yaylh7unz6h.cloudfront.net/releases/setup/index.html (the releases bucket,
`releases/setup/index.html`, `Cache-Control: no-store`), and at https://updates.openhouse.computer/setup, where the
cloud service serves that same file (`noindex`, never cached). openhouse.computer itself serves nothing yet. Releases go up with the cloud's
`openhouse-cloud/scripts/release.ts <apk> --channel stable` (tablets ask for `stable`), and the runtime next to them at
`releases/runtime/<versionCode>/runtime.tar.gz`; the code points at that release's own files, so each new release
gets a new page.

Tried on a factory-fresh emulator (wiped; Android's own "setup complete" flags cleared, since this image has no setup
wizard). With 1.0.0's code, Android downloaded the APK from the CDN, checked its checksum, installed it and made it
device owner. With 1.0.1 (from this Mac's own server, not yet the CDN: a run from the live page's code was cut off
when its emulator was closed), with the setup wizard's last step sent by hand (`ADMIN_POLICY_COMPLIANCE`) and the code's
`runtime_url` given over adb (the extras bundle can't be passed with `am`), the display was Home in kiosk mode,
asked for a PIN, downloaded and unpacked the runtime, and opened OpenHouse's first run ("Which AI does your
family use?"). 1.0.0 failed here: a release's built-in bridge address was the emulator's computer (10.0.2.2), which
only tablets set up over adb overrode, so its runtime never started; 1.0.1 defaults to the tablet's own.

Since 1.0.3 (published 2026-11-19, the page also at https://updates.openhouse.computer/setup): end to end from the
live page's own code, decoded from the page as served, on a wiped emulator. Android downloaded 1.0.3 from the CDN,
checked it, installed it and made it device owner; the runtime came from the CDN and started; first run came up, in
kiosk mode, as Home. Then over USB: the update cover installed, the grants below took, and after a reboot device
control was on (it's switched on as the display starts; or Settings → Device control).

1.0.4 (published 2026-11-19, from main 04e93cc; the page now sets tablets up on it) brings the voice download and the
backup route. On a wiped emulator from a QR code served by this Mac: owner, kiosk, Home, the runtime up in 75 s;
with listening on (the emulator starts with it off, a real tablet with it on), voice set 1 downloaded (781 MB, about 6
min from the Mac) and `/voice/status` said ready with Parakeet and the wake words; `tablet-backup.sh` got the family
folder from `/backup/export` (on a tablet before first run it says "incomplete": no `household.json` yet). Voice set 1
is on the CDN at `releases/voice/1/` (every file checked against `voice.json`).

### Setting up a new tablet from the page

1. A new tablet, or one reset to factory settings. Don't add a Google or Samsung account.
2. On the first welcome screen, tap the same spot six times. A QR scanner opens.
3. Connect to Wi-Fi if it asks, then scan the code at https://updates.openhouse.computer/setup. Accept the "This device
   belongs to your organization" screens. The tablet downloads OpenHouse (about 24 MB, then the 211 MB runtime) and
   opens it.
4. On the tablet: set the PIN, then pick the AI and sign in.

5. Device control, once (the assistant using other apps): Settings → Device control → switch on "OpenHouse
   assistant" in Android's settings and tap Allow. Home brings the display and kiosk mode back.

That's all: from 1.0.7 a tablet set up from the code needs no computer. What `tablet-setup.sh` did over USB, and what
a QR-set-up tablet does instead:

- **The update cover**: the display carries it (built and signed with it by `release.sh`) and installs it as owner
  when it's missing or different (`HostApp.kt`).
- **Staying awake while plugged in**: the owner sets it itself (`DevicePolicyManager.setGlobalSetting`); the display
  also holds the screen on while it's in front.
- **Battery saving and background limits** (`deviceidle` whitelist, `RUN_ANY_IN_BACKGROUND`): not needed. As device
  owner the display is in the EXEMPTED standby bucket, background running is allowed by default, and a tablet on its
  charger with the screen held on never enters Doze. Unplugged and asleep at night it may: the network then pauses
  for a while, as on any tablet.
- **Device control** (`WRITE_SECURE_SETTINGS`): no owner API grants it or turns an accessibility service on, so someone
   switches it on once, as in step 5. Android's restricted settings don't block it for an app the setup
  installed. Without it the assistant can't use other apps; everything else works.
- **The phantom-process limit**: the one thing that truly needs adb (`settings_enable_monitor_phantom_procs`, a
  global setting no owner API reaches). Android 12+ may stop an app's child processes beyond 32 across all apps, or
  ones using a lot of CPU. The runtime runs about a dozen (proot, Node for the bridge and the dev server, pi, SearXNG,
  esbuild, the shells around them) and the assistant's app about five more, so the count stays under the limit;
  the CPU rule may still stop a busy one on a Samsung tablet, and the display's watchdog starts the runtime again
  (seconds of the assistant or voice not answering). A household that hits it can switch the limit off once in
  Developer options ("Disable child process restrictions", Android 14+), no computer needed.
- **The voice models**: downloaded by the display itself (docs/voice-models.md).

Tried 2026-11-19 with 1.0.7 on a wiped emulator from the code (runtime URL and PIN sent over adb only because
`am` can't pass the code's extras bundle and the emulator has no first-run PIN step): the cover installed itself in
the first minute, stay-awake was 7, the standby bucket EXEMPTED, the runtime up in about a minute with 14 processes
across the display and assistant apps and no phantom kills; the Calendar tab's "Add a calendar" asked for the PIN and
opened the paste box; device control went on from Settings with no adb, and Home brought kiosk mode back; an
update (a test 1.0.8 served from the Mac) showed the self-installed cover, installed and was healthy in 17 s, back in
kiosk mode. On the same emulator a setup race showed up (the display recreated mid-setup ran two setups, leaving an
empty runtime marked unpacked, for good): fixed in 1.0.7 (one setup at a time; a mark with nothing behind it unpacks
again).

Not tried: a real tablet or a real scan (the emulator image has no setup wizard; Android's provisioning app was handed
the code's extras as root, as the setup wizard does after a scan), so taking `runtime_url` from the code's extras
bundle is untested.

## Testing on the emulator

What was run (2026-11-18, emulator `display-update` on port 5580, a throwaway test key in place of the release key):

1. A debug build (version code 1, debug-signed, as today's tablets) set up as device owner with the cover app and
   the runtime, as `tablet-setup.sh` does.
2. Releases served from the Mac: `python3 -m http.server 8820` over a folder, `--update-url
   http://10.0.2.2:8820/update.json`.
3. **0.2.0, no rescue**: offered, downloaded, installed on *Install now* (`--ez update_check true --ez update_install
   true`). The debug-signed display took the release-signed one through the lineage and was healthy 16 s later.
4. **0.3.0 with its rescue (0.2.0 rebuilt as 30001)**: checked and downloaded both. It installed by itself at 17:27, once
   the emulator had gone eight minutes untouched (`--es update_hours 0-24`, so it didn't wait for the night), with the
   rescue staged. Healthy 15 s later, then the guard's job was cancelled and the rescue thrown away.
5. **0.4.0, broken on purpose** (the display throws as it starts; a throwaway commit, never on a branch), with the
   0.3.0 rescue as 40001: installed by itself, crashed on start, and the guard (health time cut to 60 s with
   `--ei update_health_s 60`) committed the staged rescue 101 s after the install (the job runs within 30 s of its
   time). The 0.3.0 rescue started, recorded that 0.4.0 failed, and the next check said *Up to date*.

6. **Rollout and urgency** (0.5.0–0.7.0): at rollout 0 the tablet said *not this one yet*. At 100 it downloaded and
   held it: quiet at 18:29, outside 2:00–5:00 (`--es update_hours 2-5`), no install. With `minVersion` raised to the
   release it installed within a minute and was healthy 15 s later. (This found a bug, fixed: a release already
   downloaded kept its old urgency.)
7. **QR setup** on a second, fresh emulator (`display-qr`), as in the section above; this found that the tablet landed
   on the stock launcher afterwards (fixed: the display claims Home when it finishes) and that the signer checksum
   matches the debug key (switched to the file's checksum).
8. **Lineage capabilities**, as in "Moving today's tablets over".

9. **The managed cloud's endpoint**, locally, as in "The managed cloud's endpoint".

Not tried: a real tablet, a restart in the middle of an update, a download cut off halfway, the deployed cloud and a
linked tablet's credential, and Settings' dialog on screen (it's behind the PIN; the same calls ran over adb).

To repeat: `scripts/release.sh` with `OPENHOUSE_RELEASE_KS` pointing at a test key made by `scripts/release-key.sh
<scratch dir>`, and the adb settings above.

### The calendar links and the old display (2026-11-19)

On a read-only copy of `display-agentbox` with a test calendar link (a public holidays feed, claimed by the old display
from the household): with the old display and `move-tablet.sh` from before the fix and a new display with it, the
move went as on a prototype tablet, the old display posting "1 calendar(s)" every 15 minutes after the handover and the
new one "0". `move-tablet.sh --old-again` then put the fixed old display on (after room was made: the emulator's disk
was full after the move), and within ten minutes the new display logged "calendar links from the old display: 1" and
posted 1; the old display's process posted nothing more. With both sides fixed, on a fresh copy: "calendar links from
the old display: 1" before the handover, the new display posting 1 once its bridge was up, and nothing from the old
display after the handover.

### Moving a prototype tablet (2026-11-19)

A prototype tablet moved with `move-tablet.sh` and an unpublished 1.0.2 (main 4653cf2; version code 1000200, so the
next release is 1.0.3 or later). Owner, kiosk, Home, voice, the household and the assistant's sign-in came over, and a
typed turn answered. One bug: the old display's device-control service stayed enabled, so its assistant button drew
beside the new one's (fixed by hand on the tablet, then in the move as in step 3). Tried again on the
`display-agentbox` copy (read-only, the old service enabled, the old display's runtime removed for room) with a 1.0.3
built from the fix: handed over in about 10 s, and after it only `computer.openhouse.shell/…DeviceAccess` was
enabled and bound; reopening the old display was refused by kiosk mode. The new display then asked the Mac for a
runtime, the old one having been removed for the test.

### Moving to OpenHouse (2026-11-19, OpenHouse 1.0.0 as released)

On a read-only copy of the emulator set up like a prototype tablet (`display-agentbox`: the old display as device
owner in lock task, family app launcher entries, the assistant's app, a 696 MB family folder of about 6,900 files),
with main's debug build installed over it first with `install-display.sh` (as the family's deploys do: it updated
`dev.openhouse.shell` in place), then the real OpenHouse 1.0.0 (`release.sh`, signed with the release key) and a
stand-in sign-in in the old assistant app:

- `move-tablet.sh -s emulator-5610 --release ~/.openhouse/releases/1.0.0 --no-backup`: handed over each time; the
  copy (2,422 MB, 367 links relinked) took 17 s to 4 min by how busy the Mac's other emulators kept it.
  `dpm list-owners` showed `computer.openhouse.shell`, in lock task (`LOCKED`), as Home, with the microphone granted.
- The sign-in reached the new assistant app byte for byte (MD5); the old assistant app was hidden and the new runner
  came up on :8790.
- The family's folder, file by file (MD5): the same but for the bridge code, built-in apps and defaults the newer
  bridge brings on its first start, its logs and git, and the house file, where the newer bridge moved the one note to
  its board notes (its own migration, as with any install of main). The display came up with the family's Today.
- Found and fixed: a microphone question sat over the new display (no grants: the old one had them from
  `tablet-setup.sh`); the old assistant app kept the runner's port, so the new assistant couldn't start until the old
  apps were removed a day later; once, the new display came to the front just before the handover and stayed out of
  kiosk mode; `move-tablet.sh` gave up after 5 minutes on a slow copy (now 20).

Not tried: a real tablet; a real pi sign-in; calendar links (none on this emulator); the backup step; a move cut off
halfway (the old display is left as it was, by design, but untested); removing the old apps a day later with this
build (tried in the earlier run below). The emulator's 7.7 GB can't hold two copies and the new assistant's runtime,
so the old assistant's runtime and, after the handover, the old display's runtime copy were removed by hand; with the
disk full, the family apps' new launcher entries failed to write (ENOSPC), which `move-tablet.sh`'s 4 GB margin is for.

### Moving to OpenHouse, first tried under the com.roocode.home IDs (2026-11-18)

On a read-only copy of the emulator set up like a prototype tablet (`display-agentbox`: the old display as device
owner in lock task, 13 family app launcher entries, the assistant's app, a 1.8 GB runtime, a 696 MB family folder of
6,863 files), with 1.0.3 under those IDs signed with a throwaway test key and a stand-in sign-in in the old assistant app:

- `move-tablet.sh -s emulator-5610 --release … --no-backup`: handed over in 82 s from the start of the script. The
  copy was 2,422 MB in 52 s, 367 runtime links pointed at the new folder; `dpm list-owners` showed
  `com.roocode.home.shell`, in lock task, as Home.
- The family's folder, file by file (MD5): identical but for the bridge code and built-in apps the newer bridge brings
  and rewrites on its first start, its logs, and a commit it made; photos, chats and the house file the same.
- An earlier run: the stand-in sign-in reached the new assistant app byte for byte; the new display made the family
  apps' launcher entries under `com.roocode.home.app.*`; with the wait shortened to two minutes it removed every old
  package, the old assistant app after letting go of the policy that kept it (fixed since: it's released first).
- Found and fixed on the way: the display looked for its assistant app's service under the package ID
  (`com.roocode.home.agent.RunnerService`, which doesn't exist: the class keeps the code name), and so did the adb
  scripts for every class; the old display's file list was sent in one Binder call (995 kB, near its 1 MB limit); a
  failed copy was left behind.

Not tried: a real tablet; the sign-in with a real pi sign-in (this emulator's runtime predates pi, so its sign-in
screen showed before and after); calendar links (none on this emulator); the backup step; a move cut off halfway
(the old display is left as it was, by design, but untested); the emulator's 7.7 GB couldn't hold both displays and
both assistant apps' runtimes, so the old assistant app's runtime copy was removed first (its home folder kept).

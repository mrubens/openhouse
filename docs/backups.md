# Backups

Backups protect the family's things on the tablet (the tablet is a single point of failure). There is one format
and one key, and the backups can go to one or more places:

| Place | Status | Who it's for |
|---|---|---|
| **A USB drive** plugged into the tablet | Built | Everyone, with no account and no cloud. Self-hosters included. |
| **The cloud** (OpenHouse's) | Built | Families who linked the tablet (Settings → Account) |
| **A shared folder on a home computer or NAS** (SMB) | Designed, below | Families with a Mac, PC or NAS at home |

Everything is behind the PIN, under Settings → Backups, and off until someone turns a place on.

## What a backup holds

A backup holds the display folder's family data: `webapp/` (their apps, with git history, so undo survives a
restore), `chats/` (conversations and the home screen's look, `door.json`), `household.json`, `house.json`,
`photos/`, `appdata/`, `voice/`, `devices.json` and `agent-model.json`. The list is `INCLUDE` in
`bridge/backup-format.js`.

It never holds:
- the sign-ins for Claude or ChatGPT (in the runtime and the agent's app, outside the display folder);
- the agent's app or the runtime;
- the bridge and its secret;
- `.cloud/` (the device credential) or `.backup/` (the key).

Symlinks are stored as links and never followed, so an app can't pull a sign-in in through a link. proot's `.l2s.*`
hard-link stand-ins are skipped; inside the runtime the real files read normally.

## The format

The tablet packs the family's data with `tar` and encrypts it with AES-256-GCM. The file is:
- `DBK1`;
- a JSON header line: `{v, keyId, iv, createdAt, entries}`;
- the ciphertext;
- the 16-byte tag.

The header is authenticated too. `keyId` is a hash of the key, so a restore can tell which recovery code fits
without revealing anything about the key. A restore decrypts to a temporary file and unpacks it only after the tag
checks out. Then it puts back only the entries listed in `INCLUDE`, keeps what was there in `.backup/before-restore/`
until the next restore, and restarts the bridge. The format is the same in every place, so a backup copied by hand
from one place to another still restores.

## The key: a recovery code the family keeps

When the first place is turned on, the tablet makes a 128-bit recovery code, like
`DJPQ-Y5GT-928Q-ZN9J-F2JZ-SQGX-Q4`. It's Crockford base32, which tolerates O/0 and I/L mix-ups when typed. The key
comes from the code through HKDF-SHA256.

The code is shown once at setup, as text and a QR code, with three ways to keep it: a photo or printout, a password
manager, or **Send to my phone**. Send to my phone uses the existing phone hand-off: a page on the home Wi-Fi that
gets the code sealed with a key held only in the QR code, so it never crosses the internet. The phone can save it
as a file. The setup screen says plainly that without the code, a backup can't be opened by anyone. Someone can
show the code again from Backups.

- **Same tablet:** restoring needs nothing more, because the code is kept on the tablet.
- **New tablet:** someone types the code. That tablet then keeps the code for its own backups.

**Keeping a copy with OpenHouse (key escrow): off by default.** It is offered once, when the cloud is first turned on,
and can be changed later under Backups. The screen says that with a copy kept, OpenHouse could open the family's
backups. If the family turns it on:
- the tablet sends the code to the service;
- the service checks that the code fits its key id, then keeps it under the family;
- a new tablet linked to the same family restores without typing anything;
- the family, signed in, can see the code on the family's web page;
- turning it off deletes it.

USB-only families have no escrow, because there is no service involved.

## Schedule and keeping

- **When:** nightly between 2 and 5 am, only when nobody is changing anything. "Back up now" runs on demand.
- **Packing:** each run packs and encrypts once, then copies the same file to every place that's on.
- **Failures:** each place records its own result. A failure in one place doesn't stop the others. Settings
  says plainly what went wrong ("Plug in the drive"). The health check-in carries only the failure's type
  (`backup.drive.notready`).
- **Keeping:** the newest 7 nightly and 5 manual backups in each place. On a drive, the tablet deletes older files
  itself. In the cloud, the service does.

## The USB drive

Android only gives apps the folder a person picks in the system's picker, and it won't hand over a drive's top
folder. So the first time, the tablet tells the person what to do: tap *Create new folder*, call it *Display
backups*, then *Use this folder* and *Allow*.

The shell (`BackupDrive.kt`) holds that permission. The bridge (`bridge/drive.js`) asks the shell to `/status`,
`/list`, `/put`, `/get` and `/remove` files, over 127.0.0.1, with a token in `display/.backup/drive.json`. Files
pass by path through `.backup/tmp` only. The agent's tools never reach the drive. Files are named
`display-backup-<time>-<kind>-<keyId>.backup`. Each is written as `.part` and then renamed, so a half-written file
never looks like a backup.

The display activity registers the picker's answer itself. The display can be restarted while the picker is open
(seen on the emulator), and the answer still arrives.

## Designed, not built: a shared folder on a home computer (SMB)

A Mac (File Sharing), a Windows PC (a shared folder) or a NAS can all serve SMB. The plan:

- **Where:** in the shell, as a second drive behind the same five calls: `/status`, `/list`, `/put`, `/get`,
  `/remove`. The bridge's `driveDestination` then needs only another `id` and `label`, and nothing else in
  `backup.js` changes. The library would be **jcifs-ng** (LGPL-2.1, SMB2/3, pure Java). Node's SMB clients are
  unmaintained and SMB1-era.
- **Setup:** Settings → Backups → *Back up to a computer at home*. The tablet looks for SMB servers on the Wi-Fi
  with mDNS (`_smb._tcp`), and someone can also type an address. They pick a share, type its user name and
  password, and choose or create a folder. The password is kept with Android Keystore (an AES key that never leaves
  the keystore). It's never in the display folder, so the bridge and the agent never see it.
- **Security:** SMB3 encryption is required where the server offers it; otherwise signing is required. The home
  network is not trusted with the family's data either way: the files are already encrypted with the family's key.
- **Failures:** the computer may be asleep at 2 am. The nightly run then tries again each 15-minute tick until 5 am,
  then waits until the next night. Settings shows the last success per place, so a computer that's always
  asleep shows up.
- **Testing:** a Samba container (`dperson/samba` or `crazymax/samba`) on the Mac, which the emulator reaches at
  10.0.2.2:445.

## Code

| Part | File |
|---|---|
| The format, key, packing and HTTP helper | `bridge/backup-format.js` |
| Places, schedule, restore, and the `/backup/*` routes | `bridge/backup.js` |
| The cloud as a place, and the escrow client | `bridge/cloud.js` (`destination`, `escrow`) |
| The USB drive as a place, through the shell | `bridge/drive.js` |
| The shell's side of the drive | `shell/.../BackupDrive.kt` |
| Settings, the recovery code (QR, phone hand-off), and the escrow question | `shell/.../BackupMenu.kt` |
| The phone page for the code | `shell/app/src/main/assets/recovery.html` (same sealing code as `handoff.html`; a test keeps them equal) |
| Tests | `bridge/test/cloud.test.mjs`, `bridge/test/handoff-crypto.test.mjs`, `openhouse-cloud/test/app.test.ts` (escrow) |

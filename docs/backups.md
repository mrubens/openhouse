# Backups

Backups protect the family's things on the tablet (the tablet is a single point of failure). There is one format
and one key, and the backups can go to one or more places:

| Place | Status | Who it's for |
|---|---|---|
| **A USB drive** plugged into the tablet | Built | Everyone, with no account and no cloud. Self-hosters included. |
| **The cloud** (Opie's) | Built | Families who linked the tablet (Settings → Account) |
| **Your own storage**: a bucket at Amazon S3, Cloudflare R2, Backblaze B2, MinIO or anything else that speaks S3 | Built, below | Households that don't use Opie cloud and don't mind setting up a bucket and a key |
| **A shared folder on a home computer or NAS** (SMB) | Designed, below | Families with a Mac, PC or NAS at home |

Everything is behind the PIN, under Settings → Backups, and off until someone turns a place on.

## What a backup holds

A backup holds the display folder's family data: `webapp/` (their apps, with git history, so undo survives a
restore), `chats/` (conversations and the home screen's look, `door.json`), `household.json`, `house.json`,
`photos/`, `appdata/`, `devices.json`, `agent-model.json`, what the assistant learned (`preferences.md`), the
heartbeat's notes, scanned flyers, email's approved senders, reminders and follow-ups (`later.json`), the chosen
calendars and changes not yet sent to them (`calendar-sync.json`), the things on Home (`things.json`) and what apps
put on the calendar (`day-notes.json`). The list is `INCLUDE` in `bridge/backup-format.js`. The stores' spare copies
(`.bak`, `.tmp`, `.damaged-*`) are left out: the file itself is what's kept.

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
until the next restore, and restarts the bridge. From the moment it starts putting files back until the bridge has
restarted, every save to those files is refused (`holdWrites` in `bridge/store.js`), so nothing the bridge still held in
memory is written over what came back; after the restart everything is read again from the restored files. The format is the same in every place, so a backup copied by hand
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

**Keeping a copy with Opie (key escrow): off by default.** It is offered once, when the cloud is first turned on,
and can be changed later under Backups. The screen says that with a copy kept, Opie could open the family's
backups. If the family turns it on:
- the tablet sends the code to the service;
- the service checks that the code fits its key id, then keeps it under the family;
- a new tablet linked to the same family restores without typing anything;
- the family, signed in, can see the code on the family's web page;
- turning it off deletes it.

USB-only families, and those with only their own storage, have no escrow, because there is no service involved.

## Schedule and keeping

- **When:** nightly between 2 and 5 am, only when nobody is changing anything. "Back up now" runs on demand.
- **Packing:** each run packs and encrypts once, then copies the same file to every place that's on.
- **Failures:** each place records its own result. A failure in one place doesn't stop the others. Settings
  says plainly what went wrong ("Plug in the drive", or that your own storage refused the key). The health check-in carries only the failure's type
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

## Your own storage (S3 and the like)

For a household that doesn't use Opie cloud, or wants a copy somewhere of its own: any bucket that speaks S3. Setting
one up is fiddly (a bucket, a key with the right rights, an address and a region), so it's for households that want
it; it's off until someone sets it up.

**Setting it up.** Settings → Backups → *Your own storage* shows a QR code. A phone or computer on the home Wi-Fi scans
it and gets a page (the same sealed hand-off as a calendar link, `handoff.html` with several fields) for the address,
region, bucket, an optional folder (a prefix), the access key ID and the secret. *Type it here instead* takes the same
fields on the tablet. On a hub, the settings page has *Set up your own storage* under Backups. Either way the host
**checks it first**: it writes a small file, reads it back and deletes it, and says plainly what's wrong (the key
isn't known, the secret doesn't fit, no such bucket, the key may not write, read or delete there, the bucket is in
another region, the address can't be reached). Only then is it kept, and backups there are on. *Change your own
storage* changes or removes it.

| What | For example |
|---|---|
| Amazon S3 | `https://s3.us-east-1.amazonaws.com`, region `us-east-1` |
| Cloudflare R2 | `https://<account id>.r2.cloudflarestorage.com`, region `auto` |
| Backblaze B2 | `https://s3.us-west-004.backblazeb2.com`, region `us-west-004` |
| MinIO at home | `http://192.168.1.20:9000`, region `us-east-1` |

The key needs to list, read, write and delete in that bucket (and only there, ideally: give it no more). The address
must be https, except on the home network (a NAS's MinIO), where http is allowed: the files are locked before they
leave either way, and SigV4 never sends the secret, only signatures.

**How it's built.** The host keeps the key and the secret: the tablet's shell (`OwnStorage.kt`, sealed with Android
Keystore in its no-backup files, as the household's own OpenAI key is) or the hub's keeper (`hub/s3.mjs`, sealed in
its own folder). The bridge (`bridge/bucket-backup.js`) never holds them. For each request it asks the host to sign
one (`POST /storage/sign`): the host answers with a presigned URL (AWS Signature V4, query-string, payload unsigned)
for one method (GET, PUT, DELETE, HEAD) on one object under the household's prefix, or the listing of that prefix,
good for 15 minutes. The bridge sends it itself and streams the file, as it does the cloud's presigned uploads. Object
names have no slashes, so a signed URL never reaches outside the prefix.

A design note: the first plan was for the host to make the requests itself, signed, and pass the answers back. The
backups are hundreds of megabytes and the shell's routes take JSON of a megabyte at most, so the host signs and the
bridge sends instead. The secret still never leaves the host, and each URL is good for one thing for a few minutes.

**In the bucket:** `<prefix>/display-backup-<time>-<kind>-<keyId>.backup`, the same encrypted files as on a USB drive or
a hub's folder, so a file copied by hand from one place to another restores. The bucket only ever sees ciphertext.
Same schedule and keeping as everywhere: the newest 7 nightly and 5 manual, the older ones deleted by the tablet.
Restore lists the bucket and pulls from it; a new tablet set up with the same storage and the recovery code restores
an old one's backups.

**Limits.**
- One PUT per backup: S3 takes up to 5 GB that way (R2 and B2 about the same), so no multipart upload. A backup holds
  at most 1 GB of videos, so this is far off for most households.
- The bucket's own versioning and lifecycle rules still apply. With versioning on, a deleted backup stays as an old
  version (and is still billed) until a lifecycle rule removes it. Object Lock or a retention rule can refuse the
  deletes; then backups still go up, but the old ones pile up (the bridge logs that it couldn’t tidy them).
- Requester-pays buckets, SSE-C (keys the caller sends), and storage with no path-style or virtual-hosted address
  aren't supported. Amazon's own addresses use the bucket's own host name; every other address has the bucket in the
  path.
- A restored or new tablet asks for the storage again: the keystore's key doesn't travel, by design.

**Trying it.** `cd bridge && npm test` runs a round trip against a small S3 stand-in that checks the signatures
(`test/bucket-backup.test.mjs`). With MinIO: `docker run -p 9000:9000 -e MINIO_ROOT_USER=opie -e
MINIO_ROOT_PASSWORD=<a long one> minio/minio server /data`, make a bucket in its console, then set up the storage with
`http://10.0.2.2:9000` on the emulator (or the computer's address on the Wi-Fi from a tablet).

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
| Your own storage as a place, signed by the host | `bridge/bucket-backup.js` |
| The host's side of it: the key, signing, the Check | `shell/.../OwnStorage.kt`, `hub/s3.mjs` (the keeper) |
| The shell's side of the drive | `shell/.../BackupDrive.kt` |
| Settings, the recovery code (QR, phone hand-off), and the escrow question | `shell/.../BackupMenu.kt` |
| The phone page for the code | `shell/app/src/main/assets/recovery.html` (same sealing code as `handoff.html`; a test keeps them equal) |
| Tests | `bridge/test/cloud.test.mjs`, `bridge/test/handoff-crypto.test.mjs`, `bridge/test/bucket-backup.test.mjs`, `shell/.../OwnStorageTest.kt`, `openhouse-cloud/test/app.test.ts` (escrow) |

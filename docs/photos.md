# Getting the household's photos onto the tablet

Status: three ways are built and on main, all off until someone adds or turns them on: iCloud shared albums,
photos from phones any time ("Share to Opie"), and Google Photos through Google's picker. None has run on a
real tablet. The iCloud and Google parts haven't seen a real album or a real Google account yet. What needs the
operator is at the end of this page.

Photos land where they always have: `display/photos/`, kept by `bridge/house.js` (albums, captions, the slideshow,
the idle screen, Today's photo card), shown by the Photos app (`defaults/apps/photos`, a built-in plugin). The
Photos app's **Add photos** card offers all four ways in:

| Way | Who it's for | Where it's set up | Needs |
| --- | --- | --- | --- |
| From a phone, now | anyone at home | the card's QR code (as before) | the home Wi-Fi |
| From the household's phones, any time | phones that keep a page | PIN: Photo albums, Phones | the home Wi-Fi; anywhere and the Android share sheet with Reach from away on |
| An iCloud shared album | households with iPhones | PIN: Photo albums (or Add photos, or a phone, or the computer) | an album with Public Website on |
| Pick in Google Photos | Google Photos users | PIN: Add photos, Pick in Google Photos | Opie's Google project (not made yet), the tablet linked to the cloud |

## 1. iCloud shared albums

A household makes a shared album for the tablet (the help text suggests one called **Kitchen**), turns on **Public
Website** in the album's People settings (on iOS 27, its public link), and gives the tablet its link,
`https://www.icloud.com/sharedalbum/#B0…` (or `https://photos.icloud.com/shared/album/…`, below).
After that, whatever anyone adds to the album shows up in Photos within half an hour, with its caption; what's taken
out of the album goes from the tablet too.

**Adding the link** works like a calendar link:
- on the tablet, behind the PIN: Settings' **Photo albums**, or the Photos app's Add photos (paste
  box, filled from the clipboard when it holds an album link);
- from a phone: the same box's **From a phone** (the hand-off page, `assets/handoff.html`, sealed);
- from the computer or a typed chat: the `add_photo_album` tool (`bridge/calendar-links.js`), which hands the link
  straight to the shell (DeviceServer `/album`); someone says yes on the tablet with the PIN.

**Where the link lives.** Anyone with it can see the album, so it's kept like the calendar links: in the shell's
no-backup folder, sealed with a Keystore key (`PhotoAlbums.kt`, alias `album-links`), never in the household (which
the agent reads), never logged. The bridge knows an album only by a random id.

**How it's read** (Apple doesn't document this; photo frames have used it for years):
1. `POST https://pNN-sharedstreams.icloud.com/<token>/sharedstreams/webstream` with `{"streamCtag":null}`. The
   partition `NN` comes from the token: after a leading `A`, one base-62 digit; otherwise the two after the first
   character (`AlbumLink.kt`). A wrong guess gets HTTP 330 and the right host in `X-Apple-MMe-Host` (body or header),
   followed only if it's an Apple `pNN-sharedstreams.icloud.com`. The answer lists the album's name and its photos,
   each with sizes ("derivatives") and a checksum.
2. The shell hands that answer to the bridge (`POST /house/album/stream`), which picks each photo's size (the
   smallest at least 2000 px on its long side, else the largest), drops photos taken out of the album, keeps the
   name and captions, and answers which new photos to fetch (40 a round; the rest come 90 seconds later).
3. `POST …/sharedstreams/webasseturls` with `{"photoGuids": [...]}` (20 a call) gives short-lived https addresses
   on Apple's content hosts, without the token in them. The shell hands them to the bridge (`/house/album/assets`),
   which fetches each photo itself (only from `*.icloud-content.com`/`*.icloud.com`, only images, 25 MB at most).

The bridge's part is `bridge/photo-albums.js`. `house.json` keeps `synced[<id>]`: the album's id, its status and
which photos came from it (never the link). Rules it keeps:
- A photo taken off on the tablet stays off. Putting it back makes it the album's again.
- A caption changed on the tablet stays; otherwise iCloud's caption follows changes there. An album renamed on the
  tablet keeps the tablet's name. Photos the household put into the album themselves stay in it.
- The album can't be taken away from the Photos app; someone takes the link off in Photo albums, and then the
  album and its photos go (they're copies; the originals stay in iCloud).
- The newest 600 photos of an album are kept, and of those the newest 50 videos (see Videos, below).
- Files are `ic-<id>-<photoGuid>.jpg` (a video `.mp4`), dated when they were shared, so they sort with the rest.

**When Apple changes it.** Anything that doesn't read as an album becomes a quiet line on the album ("Couldn't read
the album", or "The album isn't shared any more" for a 404), shown in Photo albums and on the album's card. Nothing
already on the tablet goes because of it.

**Checked when it's added.** Before a link is kept (`PhotoAlbums.check`, from the paste box, a phone, setup's phone,
the assistant or the computer), the shell asks Apple about it once; a link Apple doesn't share isn't kept or counted,
and whoever added it is told why. One that has never read (no album here yet) shows in Photos with Remove.

**iOS 27 albums** (new ones, and old ones the owner upgrades) have a different link, "Anyone with the Link":
`https://photos.icloud.com/shared/album/<key>` (25 characters, letters, digits, `_`, `-`). The old endpoints answer
404 for it; Apple's own page (photos.icloud.com, "photos3") reads it through **CloudKit**, without signing in, and so
does the tablet (`PhotoAlbums.syncShared`, tried on 2026-11-19 against a real album):
1. `POST https://ckdatabasews.icloud.com/database/1/com.apple.photos.cloud/production/public/records/resolve?…&sharing_url_key=<key>`
   with `{"shortGUIDs":[{"value":"<key>"}]}`. The answer has the album's zone, its title (`share.fields.cloudkit.title`),
   its expiry (`share.fields.expiryDate`), and `anonymousPublicAccess`: a token good for 20 minutes and the partition
   to ask (`https://pNNN-ckdatabasews.icloud.com`, followed only if it is one). It also carries the owner's name and
   email; the shell keeps none of that.
2. `POST <partition>/database/1/com.apple.photos.cloud/production/shared/records/query?…&sharing_url_key=<key>&publicAccessAuthToken=<token>`
   with the query `CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted` (`startRank`, `direction` ASCENDING), the
   zone, and `resultsLimit` 200: a page of records, a `CPLAsset` per photo (when it was added, `captionEnc`, a
   `masterRef`) and its `CPLMaster` (the pictures: `resJPEGThumb/Med/Large/FullRes` and `resOriginalRes`, each with
   a `downloadURL` on `cvws.icloud-content.com` that works as is, `${f}` standing for a file name). The shell pages
   by `startRank` until a page has no photos (3,000 at most), keeps only the fields the bridge reads
   (`AlbumLink.keepField`), and hands them over as `{source, ck: {title, expires, records}}`.
3. The bridge (`readCloudKit`) picks a JPEG about screen size (an original only if it's JPEG or PNG: the WebView
   can't show HEIC), and fetches the new photos straight away, since the addresses don't last.

**These links can run out.** The album tried had an expiry 30 days after it was shared. When the link is
within 10 days of it, the album's card in Photos says so: make a new public link on the iPhone and add it again. Once
it has run out, resolve fails and the album gets the quiet line ("isn't shared any more, or its link has run out");
its photos stay. The 30 days was chosen when sharing it (the share sheet offers a choice); a household can pick a longer one. Paging past one
page hasn't been seen on a real album (the test album had one photo).

## 2. Photos from phones, any time ("Share to Opie")

One lasting link per household (`PhotoShare.kt`), behind the PIN in Photo albums, **Phones** (or the Photos
app's Add photos). It's off until someone turns it on; **New link** cuts off every phone that has the old one;
**Turn off** stops it. Anyone with the link can add photos (not see them), so the card says to give it only to the
household.

The page is `assets/share.html`, the same code served two ways:
- **On the home Wi-Fi**, by the tablet: `http://<tablet>:<port>/#<key>`, a `Handoff` with a lasting key and port
  (kept sealed with a Keystore key, alias `photo-share`). The phone adds it to its home screen. It keeps working
  while the tablet keeps its address; the shell checks every 5 minutes and moves with it (the phone then needs the
  code again). Works on any phone, no cloud.
- **With Use it away from home on** (Cloud), the QR code is the cloud's copy instead:
  `https://cloud.openhouse.computer/p/#<key>.<relay>.<token>`. It goes through the relay (with a lasting token the
  shell sends again every 6 hours, `/relay/handoff {token, page: 'p'}`; New link and Turn off take the old one off at once,
  `/relay/handoff/end`), so it works anywhere. It can be installed,
  and on **Android** it's a Web Share Target: Photos (or any app), Share, Opie. The service worker
  (`/p/sw.js`, `openhouse-cloud/lambda/share-page.ts`) only puts what was shared in the phone's own cache; the page then
  shrinks each photo to 2200 px, seals it with the key and sends it.

Why the share sheet needs the cloud: an installed web app and its service worker need https, which a page from the
tablet on the Wi-Fi can't have. The relay passes only sealed bytes (docs/networking.md), in parts of about 17 KB;
the bridge takes 2 MB per request, so the page keeps photos under 1.6 MB.

**iPhones** have no web share target. The page works there as a home-screen page with a photo picker (Choose
Photos, then the Photos library). A Shortcut in the share sheet was considered and left out: Shortcuts can't do the
sealing, so photos would have to go to our cloud unsealed. An iCloud shared album is the better iPhone route.

Tried in a browser against a stand-in for the tablet (2026-11-19): two photos put in the share cache arrived
screen-sized and sealed, and the page reopened from its kept key. The cloud's `/p/` routes have tests
(`openhouse-cloud/test/relay.test.ts`); the lasting relay token has one in `bridge/test/relay.test.mjs`.

## 3. Google Photos through Google's picker

Since Google's 2025 Library API changes, an app can no longer read a user's library or albums. It can open
Google's **Picker**, where the person chooses photos, and read only those. So this is "pick and copy", not a synced
album: to add more, pick again.

**Who owns what.** Opie owns one Google Cloud project and its OAuth client (a web application). The client's
secret is the only reason any of this touches our cloud: the household never makes a Google project, and the tablet
never holds a long-lived Google credential.

**What the household sees:**
1. On the tablet, behind the PIN: Add photos, Pick in Google Photos. The tablet shows a QR code
   (`GooglePhotos.kt`, its page `assets/google.html`, on the home Wi-Fi, sealed like every phone page).
2. On the phone: **Sign in to Google**. Google's consent screen names Opie and one permission ("see the photos
   you select"). Then **Choose in Google Photos**: Google's own picker opens in a new tab (the Google Photos app on
   Android). They pick and tap Done.
3. The phone page and the tablet's card count along, "Copying 12 of 30…", then "Done". The photos are in Photos.

**How the token moves** (`openhouse-cloud/lambda/google.ts`, `/g/start` and `/g/done`):
- When the phone taps Sign in, the tablet (the shell, through the bridge's `/cloud/google/start` and the tablet's
  credential) asks the cloud to start a sign-in for its page's own address and kind (`POST /v1/google/start {r, k?}`),
  and the page gets back a one-time link, `/g/start?t=<ticket>` (15 minutes). The return address must be the tablet's
  page on a home network (a private address, path `/`), and it is the one the tablet named, never one from the link.
  (A cloud from before that route: the bridge hands back its old `/g/start?r=<address>` link instead.) The phone page
  keeps its key in sessionStorage and opens the link. The cloud sets a short cookie with a nonce
  and sends the phone to Google with `scope=photospicker.mediaitems.readonly`, `access_type=online` (so no refresh
  token).
- `/g/done` checks the nonce, exchanges the code (with the client secret) for an access token, and sends the phone
  back to `http://<tablet>:<port>/#g=<token>`. The part after `#` never leaves the phone. The cloud keeps nothing.
- The phone page seals the token for the tablet. The shell (not the bridge) makes a picking session
  (`POST photospicker.googleapis.com/v1/sessions`), gives the phone its `pickerUri` (plus `/autoclose`), polls the
  session until `mediaItemsSet`, lists the picked items, copies each photo (`baseUrl=w2400-h2400`, with the token)
  into Photos, deletes the session, and forgets the token. It's in memory only, for one run (an hour at most). Up to
  300 photos a run; videos are skipped.

Off until set up: without the Google parameter, `/g/start` says "Google Photos isn't connected to Opie yet", and
the phone page says to link the tablet to the cloud if it isn't. Tests: `openhouse-cloud/test/google.test.ts` (Google's token
endpoint stood in). The tablet's side compiles but hasn't talked to Google.

### What needs the operator before Google works

**Status (2026-11-19):** steps 1 to 3 are done: project `openhouse-515304`, the consent screen in Testing, and the
web client `575678758294-valnl6vl1b8t58fpceo1sqhn1v28m67m.apps.googleusercontent.com` with both redirect URIs. Left:
a cloud deploy, then a first real pick. Step 4 is done too (the parameter, version 1).

The steps, each the operator's to do:
1. **A Google Cloud project** for Opie (any name; an organization if there is one). Enable the **Google
   Photos Picker API**.
2. **The OAuth consent screen** (Google Auth Platform): app name Opie, a support email, the logo, home page
   `https://openhouse.computer`, a privacy policy URL (needed for verification; it should say that photos go from
   Google straight to the household's tablet and that Opie keeps no token), authorized domain
   `openhouse.computer`, and the one scope `.../auth/photospicker.mediaitems.readonly`.
3. **An OAuth client**, type Web application, redirect URI `https://cloud.openhouse.computer/g/done` (for local
   testing also `http://localhost:8790/g/done`; `openhouse-cloud/lambda/local.ts` reads `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`).
4. **The client in Parameter Store**: a SecureString `/home-cloud/google-oauth-client` with
   `{"id": "...apps.googleusercontent.com", "secret": "..."}`, then a cloud deploy (the stack already grants the
   function read access to just that parameter).
5. **Testing, then verification.** In "Testing" status the app works for up to 100 test users the operator adds (good
   for beta households) and Google shows an "unverified app" warning. For everyone, publish it and go through
   Google's verification: domain ownership of openhouse.computer (Search Console), the privacy policy, a short video
   of the consent and picking flow, and a written reason for the scope. We expect the picker scope to count as a
   sensitive scope, not a restricted one (so no paid security assessment); confirm that in the console when
   configuring it.

## 4. Later: a household email address for photos

An address per household (say `photos-<code>@in.openhouse.computer`) that grandparents can email photos to. It would
need inbound email on the cloud (SES receiving, an S3 bucket, a Lambda), a list of allowed senders per household (or
someone's OK on the tablet for new ones), the photos handed to the tablet through the relay or picked up by it,
and deleted from the cloud once delivered. It's the most grandparent-friendly way, and the one where photos rest on
our servers for a while, so it would be off by default and said plainly. Not built.

## Videos

Short videos sit in Photos beside the photos: in its albums, in All, with captions, taken off and put back the same
way. Everything else that shows a photo shows a video's **still**.

**Kept as they come.** No transcoding: the tablet's WebView plays what phones make (H.264 and HEVC, in mp4 or mov),
so the file is kept as it is, `display/photos/<name>.mp4|.mov`. **80 MB at most** (`house.js MAX_VIDEO`, about a
minute or two from a phone); a bigger one is refused, never cut, and nothing already there is touched. Files land
whole or not at all (a temporary file, then a rename).

**Its still** is `photos/.stills/<name>.jpg` (`bridge/stills.js`): Apple's poster frame for an iCloud video, else a
frame half a second in, made on the tablet by the shell (`MediaStill.kt`, DeviceServer `/media/still`: Android's
MediaMetadataRetriever, only files in the photos folder), or by ffmpeg when the bridge runs on a computer.
`GET /house/photo/<video>` gives the still, so every place that shows photos shows videos without knowing about them;
the sleep screen leaves out a video until it has one.

**Where they play.**
- **Photos tab:** the grid shows the still with a small play mark; the one view has a play button, and a tap plays the
  video with sound (a tap on it pauses). The slideshow plays a video muted, once through (a minute at most), then
  goes on. A `<video>` can't send an app's key, so `GET /house/photo/<video>?play=1` gives an address for it,
  `/house/video/<name>?t=…`, signed for that one video and good for 6 hours, served only on the device (loopback)
  with ranges (`house.js serveVideo`). The kit's `house.video(name)` asks for it; `house.isVideo(name)` tells which.
- **Sleep screen, Today's photo card, the Photos widget, the backdrop:** the still (Today's card with a small play
  mark; a tap opens it in Photos). Playing clips on a screen nobody is watching would keep a decoder busy for hours,
  warm the tablet and hold its memory; a still is also calmer across the room. The album switches (the sleep screen,
  All) work on videos as on photos.
- **Phones:** the still, as for any photo (Today's card on the phone page, with its mark). Playing them through the
  relay, sealed, isn't worth the bytes.

**Coming in.**
- **iCloud shared albums**, both kinds: the old webstream's video sizes (`720p`, `360p`…: the largest up to 1080p
  under the cap) and its `PosterFrame`; a new (CloudKit) album's `resVidSmall/Med/Full` (Apple's H.264 copies; the
  original only when there are none and it's mp4 or mov) and a JPEG size for the still. Streamed to a file, up to
  the cap. The newest 50 videos of an album (`MAX_VIDEOS`), so an album full of clips stays a few GB.
- **The Add photos page** (`assets/photos.html`, a phone on the Wi-Fi): pick photos or videos. A video isn't
  shrunk; it goes in sealed parts of 4 MB ("OHV1", a header `{id, n, of, name}`, the bytes: `Phone.kt videoPart`),
  which the bridge puts together in `photos/.incoming` and keeps only once the last part is in, in order
  (`/house/photo/part`, the display only). The lasting page (`share.html`, through the cloud) still takes photos only.
- **Email:** mp4, mov and m4v attachments (or a `.mov` sent as octet-stream), five a message, kept as they come in
  the Email album (no model call: a video sent to the household's photos is a moment, not a flyer).
- **Apps:** `house.addPhoto(blob, 'name.mp4')` (the kit), the same cap.

**Backups** hold the newest videos up to **1 GB** of video in all (`backup-format.js VIDEO_BUDGET`); the rest stay
on the tablet only, so a few long clips can't make every backup, and the cloud's copy, many times bigger. Photos are
always in it. A restore on the same tablet keeps every video that's there and not in the backup (left out for size,
or newer), with its still (`keptVideos`); on a new tablet those aren't there to keep.

## Files

| Where | What |
| --- | --- |
| `bridge/photo-albums.js` | reading Apple's answers, keeping synced albums, fetching their photos |
| `bridge/house.js` | `/house/album/stream`, `/house/album/assets`, `view().linked`; taken-off photos keep 30 days |
| `bridge/calendar-links.js` | `add_photo_album` (with `add_calendar`) |
| `bridge/relay.js` | `/relay/handoff` takes a lasting `token` and `page: 'p'` |
| `shell/.../AlbumLink.kt`, `PhotoAlbums.kt` | album links: sealed, read every 30 minutes, Settings' Photo albums |
| `shell/.../PhotoShare.kt`, `assets/share.html` | the lasting photo page for phones |
| `shell/.../GooglePhotos.kt`, `assets/google.html` | Google's picker |
| `shell/.../Handoff.kt` | `fixedKey`, `port`, `minutes = 0` (until stopped) |
| `openhouse-cloud/lambda/share-page.ts`, `phone-pages.ts`, `app.ts` | `/p/` (the page, manifest, service worker, icon) |
| `openhouse-cloud/lambda/google.ts`, `app.ts`, `lib/stack.ts` | `/g/start`, `/g/done`, the Google parameter |
| `defaults/apps/photos` | the Add photos card, a linked album's card; videos: play marks, the one view, the slideshow |
| `bridge/stills.js`, `shell/.../MediaStill.kt` | a video's still |

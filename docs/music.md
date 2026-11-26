# Music and audiobooks

Opie plays music, audiobooks and podcasts in the tablet's own media apps and works their buttons: "play Abbey Road",
"put on my audiobook", "pause", "skip this one", "back 30 seconds", "what's playing?". The family adds the apps the
usual way (Opie's `install_app`, or Apps → Add apps, which suggests a few under "Music and books": Spotify, Audible,
YouTube Music, Pocket Casts, Libby; both go through Aurora Store with the same card) and signs in to each once on the
tablet. The suggestions are only that: nothing is built for any one app, and any media app works.

## How it fits together

- **Shell** (`shell/.../Media.kt`): the device server's `POST /media {do, app?, query?, focus?, seconds?}`, with its
  token. `do` is `status`, `search`, `play`, `pause`, `next`, `previous`, `seek` (seconds, negative is back) or `stop`.
- **Bridge** (`bridge/devices/index.js` mediaDo): the voice's `music` tool (`bridge/live-tools.js`, typed turns too).
  Titles and artists are the apps' words, so they reach the model marked as data.

**The media apps** are found on the tablet, never listed in code: apps with a launcher icon that take a search to
play (`MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH`), or that offer a media browser
(`android.media.browse.MediaBrowserService`, what cars and watches use; a system app with only a browser is the
tablet's plumbing, like its voice search, and isn't counted). `status` names them and says which can take a search.
For example, Spotify (`com.spotify.music`) takes a search; Audible (`com.audible.application`) is expected to offer
only a browser, so it opens instead (not checked on a real install yet).

**Which app**: the one they named, by its label as installed; otherwise the app they last played from (the shell
keeps it once something has played); otherwise the only one that takes a search; otherwise Opie asks.

**Playing from a search**, in order:

1. A session the app already has that takes a search (`playFromSearch`): nothing comes up on the screen.
2. The app's media browser, if it lets the tablet connect. Most only let cars and Google's apps in (on the emulator
   YouTube Music said no), so this mostly doesn't happen.
3. The search intent, with `SearchManager.QUERY` and, when the model knows it, `EXTRA_MEDIA_FOCUS` (artist, album,
   song, playlist, genre). The app is let into kiosk mode first (`KioskApps.allowInKiosk`, as for any added app). Its
   screen comes up to start; once it plays, Opie's screen comes back in front and the music goes on behind it.
4. An app that can't take a search opens on the screen, and Opie says so.

The tablet's own system media apps (a preinstalled music app) open only for someone (`KioskApps.needsParent`), as
from Apps: Opie says they open it there.

**Resuming** ("play", "resume my book"): the app's session if it has one. After a restart, when no app has one, the
tablet presses a play key: Android gives it to the app that last played (what a headset's play button does), and
that app may start its player from it. An explicit media-button broadcast to one app doesn't work on Android 12 and
up (an app can't start its player from a broadcast another app sends), so it isn't used. If nothing starts, the app
opens.

**Not playing after all**: when the app came up but nothing played within ten seconds, Opie says it may need someone
to sign in on the tablet, or didn't find that.

## Spotify on the tablet itself

Spotify keeps its media service to its own list of apps, so through its app Opie can only hand it a search, which
brings Spotify's screen up (and Spotify may play on whichever of the household's devices was last used). Once someone
signs in to Spotify in Opie (Settings → Advanced → Spotify, or the `music` tool's `spotify_sign_in`, which puts
Spotify's own sign-in page on the screen), Spotify plays on the tablet without its app instead:

- **Home** (`chat/src/spotify-player.jsx`): Spotify's player for websites (its Embed), worked through Spotify's
  iFrame API (load, play, pause, seek, and its playback events). It lives once at the page's root, so it keeps
  playing on any tab; on Home it sits over Today's slot for it, with Spotify's own controls (skip included), and it
  goes a minute after a pause (Spotify's own button, or Opie's stop). Signed in with Premium, whole songs play; signed out, only
  30-second previews, so Opie uses it only when signed in.
- **Shell** (`SpotifyEmbed.kt`): the sign-in page; `POST /media {do: 'spotify', url, name?}` sends the player a link
  and waits until it's playing; while it's the one in use, `music`'s buttons go to it. The home screen's web view
  keeps Spotify's sign-in for its frame (third-party cookies) and lets it play protected songs.
- **Bridge** (`devices/index.js` spotifyFirst): a `search` meant for Spotify (named, or the app they last played from)
  asks the assistant, with its web search, for the thing's `open.spotify.com` link, and Spotify's oEmbed for its name.
  Signed in, Spotify plays there only, never in its app: what isn't found, or isn't what they asked for (the model
  judges Spotify's own name for it), Opie says so. Not signed in, Spotify's app as before.
- **Limits**: Opie can't skip ahead in it (Spotify's API has no next; its own button on Home does); the household's
  own private playlists aren't found by web search, so those go to the app.

## Seeing what's playing

Android shows other apps' media sessions only to a notification listener, so the shell is one (`MediaListener`). It
never reads the notifications themselves. Turning it on:

- No app can turn on its own listener, device owner or not: there's no owner API for it, the system's own call is
  hidden from apps, and on Android 15 a write to `enabled_notification_listeners` with WRITE_SECURE_SETTINGS is put
  back at once (all tried on the emulator).
- So `scripts/tablet-setup.sh` and `scripts/move-tablet.sh` grant it over adb:
  `adb shell cmd notification allow_listener <shell package>/dev.openhouse.shell.MediaListener`. It stays through
  updates.
- Otherwise Settings → Advanced → Now playing (shown only while it's off) opens Android's own page for it, with
  the PIN. It's a person's tap (`DeviceServer.personOnly`): it widens what Opie can see.

Without it, play, pause, stop and skip still work (media keys go to whatever is playing), `status` only says whether
something is playing, seeking by seconds can't, and nothing can tell whether a search started playing.

## Limits

- **Audible** has no search to play: Opie opens it, and "resume my book" resumes what was playing.
- **Spotify's Web API** isn't used: its quota rules keep an app like this in development mode (a few named users)
  unless Spotify approves it. Everything here goes through the app on the tablet instead.
- **Spotify Connect** needs no work of ours once Spotify is on the tablet and signed in: the tablet shows up as a
  device to play on in Spotify on a phone signed in to the same account. Whatever a phone starts there, the `music`
  tool sees and controls like anything else.
- Where the sound goes is the `bluetooth` tool's (`play_here`), and how loud is `volume`.

## Not built yet

A now-playing card on Home, with pause and skip, would be the natural tap path; today the tap path is opening the
app from Apps.

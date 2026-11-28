# The bridge's host

The bridge runs on a host: the device at the center of a household's Opie. The host keeps what the bridge must not
hold (the household's calendar and album links, its own OpenAI key, the PIN), asks people "Is this OK?", and does
what only the device can (Bluetooth, other apps, the camera). The Android tablet's shell is the best host and the
reference one; any spare computer can be one through the keeper (`hub/keeper.mjs`, docs/hub.md).

The bridge talks to every host the same way (`bridge/host.js`): it POSTs a path with JSON and gets
`{ ok, status, body }` back, and it asks `host.can(…)` what the host can do. It never asks which host it is on,
except once, at start-up, to pick one:

| Host | Picked when | Reached at |
|---|---|---|
| The tablet's shell (`DeviceServer.kt`) | `DEVICE_MCP_CONFIG` is set (the shell writes it) | its address and token in that file, read at every call |
| The keeper (`hub/keeper.mjs`) | `OPENHOUSE_HOST=keeper` (`hub/start.sh`) | `OPENHOUSE_KEEPER` and `OPENHOUSE_KEEPER_TOKEN`; without them the bridge starts one of its own, with its folder beside the data folder (a laptop trying it) |
| None | neither (a laptop's dev bridge) | every call answers `null`, and `host.can()` is false |

## What a host may say it can do

`POST /host` answers `{ kind, can: [...] }`. A host leaves out what it can't do. The bridge turns features on and off
by these, never by the host's kind (`host.js CAPS`):

| Capability | The host… | Tablet | Keeper |
|---|---|---|---|
| `screen` | has a screen people answer its cards on, Allow a new device on, and go through the setup on | ✓ | |
| `cards` | has no screen: its cards wait at `/cards` for the bridge to show on settings devices and adults' phones; the bridge then also drives the setup's steps and offers its settings page (`headless.js`, `hub.js`) | | ✓ |
| `approve` | answers `/approve` with a person's answer | ✓ | ✓ |
| `calendar` | keeps calendar and album links (`/calendar`, `/album`) sealed after a yes | ✓ | ✓ |
| `calendar-accounts` | signs in to Google and iCloud calendars (`/calendar/accounts`, `/calendar/request`, `/setup/icloud`) | ✓ | ✓ |
| `openai` | keeps the household's own OpenAI key (`/ownkey`) and adds it to the bridge's calls (`/openai`) | ✓ | ✓ |
| `gemini` | keeps the household's own Gemini key (`/geminikey`) and asks Google for a one-use token for each conversation (`/gemini`) | ✓ | |
| `pin` | keeps the PIN (`/setup/pin`), only its hash, and checks it itself | ✓ | ✓ |
| `google-signin` | starts Google's sign-in from the setup (`/setup/google`); else the bridge does, back to its own address | ✓ | |
| `drive` | owns a USB drive for backups; else they go to a folder | ✓ | |
| `storage` | keeps the household's own storage bucket's key (S3 and the like) and signs one request at a time for backups (`/storage/*`) | ✓ | ✓ |
| `updates` | updates the bridge; else the bridge updates itself (`hub/update.sh`) | ✓ | |
| `mail-convert` | makes mail attachments readable (`/mail/pdf`, `/mail/heic`) | ✓ | |
| `stills` | makes a video's still (`/media/still`) | ✓ | |
| `speaker` | says things (`/say`) on a speaker of its own | ✓ | |
| `apps` | offers the device tools over MCP (`screen`, `tap`, `open_app`…), `/front`, `/halt` | ✓ | |
| `bluetooth`, `camera`, `media`, `multicast`, `share`, `brightness` | `/bt`, `/camera`, `/media`, `/multicast`, `/share`, `/screen` | ✓ | |
| `mic-check` | puts the microphone check on its screen (`/mic-check {do: start}`), and says how the last one went (`{do: get}`) | ✓ | |

A shell older than `/host` gets the tablet's list (`TABLET_CAPS`). A path a host doesn't have answers an error, as it
always has, so a caller that copes with a failed call needs no capability check.

## The requests

The same requests and answers on every host that has them (DeviceServer.kt `home`, keeper.mjs `route`):

- `/approve {title, detail, more?, yes?, no?, rights?, danger?, later?, pin?, grownup?, waitMs?}` → `{yes, answered}`.
  A card a person answers. `pin`: the yes needs the PIN once one is set; `grownup`: always. The keeper holds it until
  someone answers on a settings device or an adult's phone (`/cards`, `/cards/answer {id, yes, later?, pin?}`, with
  the PIN checked in the keeper).
- `/calendar {url, who?, name?, only?, from?, trusted?}`, `/album {url, from?, trusted?}` → `{added}`. The link is read
  once, then kept after a yes (an album's needs the PIN). `trusted`: the setup's own, with no card.
- `/calendar/accounts` → `{accounts}` with no secrets; `/calendar/request {account, method, url, headers, body}`: a
  request to that account's own service, signed in there; `/setup/icloud {user, pass, who}`.
- `/openai {kind, body}` → OpenAI's status and answer, with the key added there; `/ownkey {key}` → `{added}`; the
  host tells the bridge only whether one is in (`POST /cloud/own {on}`).
- `/gemini {kind: 'token', body}` → Google's answer to `/v1beta/auth_tokens` with the key added there (a token for one
  conversation); `/geminikey {key}` → `{added}`, after a person's yes there; the host tells the bridge only whether one
  is in (`POST /cloud/gemini {on}`).
- `/setup/pin {pin}`: only while no PIN is set.
- `/storage/status` → `{set, endpoint, region, bucket, prefix}` (never the key or the secret); `/storage/set {endpoint,
  region, bucket, prefix, keyId, secret}` → `{ok}` once the Check (write, read and delete a small file) works, else
  `{error}` in the household's words (the tablet asks for the PIN first, with the lock on); `/storage/sign {method,
  name}` or `{method: 'GET', list: true, token?}` → `{url}`: one presigned URL (SigV4, 15 minutes) for one object
  under the prefix or its listing, 409 with none set; `/storage/remove`. The bridge sends the URL itself
  (`bucket-backup.js`); the secret never leaves the host (docs/backups.md, "Your own storage").

## What stays a person's

On every host: the bridge never holds a key, link or PIN (a storage bucket's secret included: it gets only
signed URLs); a card is answered by a person, never by Opie (the tablet's
`DeviceServer.personOnly`; the keeper's cards are answered only from a paired device's page, never by a tool); and
Opie never sees, hears or types the PIN. Anything but a yes is a no; only a laptop with no host at all may take
"nobody to ask" as a yes, for building.

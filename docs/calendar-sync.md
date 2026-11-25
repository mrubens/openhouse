# Two-way calendar sync

Agreed 2026-11-24. Google and iCloud are built (see "What's built" below) and in use with real accounts; Outlook
isn't started. Before this the family's calendars come in by their private iCal
links (read-only, `bridge/calendar-links.js`, the shell keeps the links sealed and fetches them) and events added on
the tablet stay on the tablet (`bridge/house.js`, `/house/event`). The goal: an event added or changed on the tablet
shows up in the household's Google Calendar (then iCloud, then Outlook), and changes there show up here, the way
Skylight's two-way sync works.

## What's built (2026-11-24)

- **The bridge** (`bridge/calendar-sync.js`, wired in `board.js` and `house.js`): accounts' calendars, which are shown,
  two-way or hidden, whose each is, the default for new events; reading; the outbox; Google and CalDAV. State in
  `calendar-sync.json` next to `house.json` (no secrets). Routes for Settings: `GET /calendar/sync`,
  `POST /calendar/sync/{discover,set,forget,now}`. `/house/event` and the assistant's `calendar_event` add, change and
  remove events in two-way calendars by their ids (`c-<calendar>-<id>`), like the display's own; `add.calendar` picks
  one (`"here"`: only the display). `/cloud/google/refresh` passes the shell's refresh to the cloud.
- **The shell** (`CalendarAccounts.kt`): the sealed accounts, `DeviceServer` `/calendar/accounts` and
  `/calendar/request` (only to Google's Calendar API, or the account's CalDAV server; iCloud's are `*.icloud.com`), a
  small HTTPS client (Android's won't send PROPFIND or REPORT), and the screens: Add a calendar (Google, iCloud, or a
  link), iCloud's sign-in, Google's QR code to the phone page (`google.html` with `kind: "cal"`), each account's
  calendars and the choices for each.
- **The cloud** (openhouse-cloud 2e17cfe, not deployed): `/g/start?k=cal` and `/g/done` (`#gc=<refresh token>`), and
  `POST /v1/google/refresh` for a linked tablet (120 an hour; `invalid_grant` means sign in again).
- **The Calendar tab**: events in two-way calendars can be changed and removed; a new event's sheet has a Calendar row
  (the person's own, the default, or This display only); the note when a change lost to one made elsewhere.
- **Tests**: no duplicate event when an answer is lost and the change is sent again; a change made offline survives a
  restart and goes in (`bridge/test/calendar-sync.test.mjs`); the cloud's sign-in and refresher.

**Not yet:** a real Google account (needs the Google project set up and the cloud deployed) and a real iCloud account;
the screens on a tablet; Outlook; the offer to move the display's own events into a two-way calendar; noticing an
iCal link to the same calendar (shown twice until the link is removed). `calendar-sync.json` isn't in backups: after a
restore the accounts are signed in again anyway (the sign-ins never leave the tablet).

## Decisions

- **Google first**, then iCloud, then Outlook. One sync engine is shared, so the later providers are small.
- **Google scope: the calendars they pick.** `calendar.events` (see, add, change and delete events) plus
  `calendar.calendarlist.readonly` (to list their calendars and pick). Events made on a phone can be changed or
  deleted from the tablet. The narrower `calendar.app.created` (only a calendar OpenHouse makes) was turned down:
  everything made on a phone would stay read-only here.
- **The refresh token is sealed on the tablet; the cloud only refreshes.** Refreshing needs OpenHouse's client
  secret, which can't ship in a public app. The tablet sends the sealed refresh token to the cloud about once an hour;
  the cloud adds the secret, asks Google for an access token, returns it and keeps nothing. Events go between the
  tablet and Google directly, never through the cloud.
- **New events go to the person's calendar, else a household default.** An event for Maya goes into Maya's calendar
  when hers is connected and writable; otherwise into the one default (a shared "Family" calendar, say). The add sheet
  says where it's going and can change it.

## Reference: what Skylight does

From Skylight's public help pages: two-way sync for Google and iCloud (iCloud needs two-factor on the Apple ID, and
changes can take up to 15 minutes); Outlook appears read-only. Two-way is chosen per calendar when it's added, and
mixing a one-way and a two-way copy of the same calendar doubles every event. The person connecting must own the
calendar, not just view a shared one. Their sync runs in their cloud; ours doesn't.

## How it fits together

**Where things live.** Credentials stay in the shell, as the iCal links do today: the Google refresh token, the
iCloud app-specific password, the Microsoft refresh token, each sealed with the shell's key. The sync engine is in
the bridge (plain JS, where the calendar already is). It never holds a credential: it asks the shell to make a request
for an account (`POST /calendar/request {account, method, path, body, headers}`), and the shell adds the
authorization, only to that provider's API host. This keeps one rule for every provider and keeps tokens out of
`house.json`, backups and logs.

**An account and its calendars.** An account is one sign-in (Sam's Google, Alex's iCloud). It has calendars; each
calendar is off, read-only, or two-way, and may belong to a person. A calendar connected through an account replaces
its iCal link (we offer to remove the link, so events don't show twice, the doubling Skylight warns about).

**Reading.** The window the Calendar shows (35 days back, 70 ahead), every two minutes and right after a write:
Google's events list (once for the repeating series, once for each time), CalDAV's `calendar-query` REPORT. Simpler
than change feeds (`syncToken`, `sync-collection`), which can come later if the requests ever matter. A side gain:
Google's secret iCal links can lag hours behind; the API doesn't.

**Writing.** Every change made on the tablet (from the Calendar tab, the assistant, a flyer, an app) goes into an
outbox saved in `house.json` first, then out to the provider. Offline, it waits and retries; the event shows on the
tablet meanwhile.

- **No duplicates.** A new event gets its id on the tablet before it's sent: Google accepts a client-chosen event
  `id`, CalDAV a client-chosen UID and resource name (with `If-None-Match: *`), Graph a `transactionId`. A retry after
  a lost reply finds the event already there instead of making a second one. This is the one place we test hard.
- **Conflicts: the provider wins.** Writes carry the event's ETag (`If-Match`). When it changed elsewhere first, the
  tablet takes theirs and drops its own edit, and the Calendar tab says so quietly on that event. No merging.
- **Deletes** go both ways: deleted here is deleted there (Google: `DELETE`, CalDAV: `DELETE` with the ETag, Graph:
  `DELETE`); deleted there disappears here at the next read. The tablet's undo puts it back by adding it again with
  the same fields.
- **Repeating events.** Changing or deleting one time of a repeating event changes that instance (Google
  `recurringEventId` instances, CalDAV `RECURRENCE-ID`, Graph occurrences); "this and later" splits the series. The
  local events already support repeat/until/skip, so these map over.
- **What the tablet adds on top** (countdowns, reminders, who it's for) stays in `house.json` by event id, as it does
  for synced events now, and isn't written into the provider's event.

**Events already on the tablet.** When the first two-way calendar is connected, the tablet offers once to move its
own upcoming events into it (each with its fixed id, so a second offer can't double them).

**The PIN.** Calendar changes from apps keep the existing calendar lock. Connecting an account is behind the PIN.

## Google

**Sign-in.** The same path as Google Photos (`docs/photos.md`, `openhouse-cloud/lambda/google.ts`): behind the PIN,
the tablet shows a QR code; the phone opens the tablet's own page on the home Wi-Fi, then the cloud's `/g/start`,
then Google's Allow screen. For calendars: `access_type=offline`, `prompt=consent`, the two scopes above. `/g/done`
exchanges the code and sends the phone back to its page with the refresh token after `#` (never leaving the phone,
never kept in the cloud); the page seals it for the tablet. The phone then shows the account's calendars to pick:
which to show, which are two-way, whose each is, and the default for new events.

**The cloud's new part:** `POST /v1/google/refresh {refresh_token}` → `{access_token, expires_in}`, only for a linked tablet
(its relay key), rate-limited per tablet, logging nothing of the token. An `invalid_grant` answer (revoked, or
Google's 7-day expiry for apps still in testing) tells the tablet to ask for a new sign-in on that account.

**What the user sets up** (in the OpenHouse Google Cloud project, which Google Photos needs too):

1. Enable the Google Calendar API; add the two scopes to the consent screen.
2. The Web OAuth client with `https://openhouse.computer/g/done` as its redirect, in Parameter Store as now.
3. Publish the consent screen ("In production"). Until it's verified, the Allow screen warns that the app is
   unverified and at most 100 people can use it: fine for the household and the beta. While it's "Testing" instead,
   refresh tokens die after 7 days, so publish before relying on it.
4. Verification for the sensitive scopes, started on day one because it's the slow part: the verified domain
   (openhouse.computer), the home page and privacy policy there (the privacy page needs a section on Google data: what
   is read, that it stays on the tablet, Google's Limited Use wording), a justification for each scope, and a demo
   video of the sign-in and of an event going both ways. No security assessment: that's for restricted scopes like
   Gmail, not Calendar.

**Without the cloud** (someone building their own): their own Google project with a Desktop OAuth client, signed in
from a laptop through the workshop, and the secret kept in the shell like the token. Later, not part of the first
build.

## iCloud

CalDAV at `caldav.icloud.com`, with the Apple ID and an app-specific password (appleid.apple.com, Sign-In and
Security, App-Specific Passwords; the Apple ID needs two-factor). Both typed on the tablet behind the PIN (or on the
phone page, sealed for the tablet), never in a chat. The engine finds the calendars (`PROPFIND` for the principal,
then the calendar home), reads with `sync-collection` and writes iCalendar with ETags. No cloud and no review.
The same code works for other CalDAV servers (Fastmail, Nextcloud) with their own address.

## Outlook

Microsoft Graph with `Calendars.ReadWrite` and `offline_access`, for personal Microsoft accounts and work ones. An
Entra app registration owned by OpenHouse, as a public client: no secret, so no cloud. Microsoft's device-code
sign-in works where Google's doesn't for calendars: the tablet shows a short code, the person enters it at
microsoft.com/devicelogin on a phone. The refresh token is sealed in the shell. Publisher verification (tied to a
Microsoft Partner account) removes the "unverified" label; work tenants may need their admin's consent anyway.

## Order of work

1. **Sync engine in the bridge** with the outbox, fixed ids, ETags and conflict handling, against a fake provider;
   the shell's `/calendar/request` and sealed accounts. The Calendar tab: where a new event goes, and the quiet
   "changed elsewhere" note. Tests: no duplicate events on retry, nothing lost from the outbox across a restart.
2. **Google**: the cloud's `/g/start` scopes, `/g/done` with a refresh token, `/g/refresh`; the phone page's calendar
   picker; the Google provider. The user starts verification (and the privacy page's Google section goes up) at the
   same time. Cloud tests for `/g/refresh` (auth and rate limits). The cloud deploy is the main session's, after the
   user's OK.
3. **iCloud** (CalDAV), on the same engine.
4. **Outlook** (Graph, device code), after the user registers the Entra app.

Each step is tried on the emulator with a real account the user signs in to themselves, before the household tablet.

## Open questions

- Does the household's main calendar live in one Google account or several? Several accounts means several sign-ins,
  each its own row under Calendars.
- Whether "changed elsewhere, theirs kept" needs to say more than a quiet line on the event. Start with the line.

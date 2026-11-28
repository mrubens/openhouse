# Privacy

The privacy policy for Opie: the tablet, the iPhone app and the hosted cloud. The page people read is the cloud's
copy at openhouse.computer/privacy (`openhouse-cloud/lambda/privacy.ts`); keep the two the same. Draft of 2026-11-25, Google section added,
not yet published.

---

**Opie keeps a household's things in the household's own home: on its device.** Our hosted service, and
the iPhone app, only help the household's devices reach it. We don't sell data, show ads or use tracking or analytics
in the app.

## The iPhone app

- **Joining.** The app joins a household when someone scans the code its device shows or opens an invite link. It keeps
  that pairing (the phone's own key) in the phone's keychain. The camera is used only to read that code; no picture is
  kept or sent.
- **The household's page and widgets.** What the app shows comes from the household's device. Requests between the
  phone and the device are sealed with a key only the two of them hold, and pass through our relay, which sees only
  sealed boxes and which household they are for. The page itself (its code, not the household's things) is loaded
  from our service.
- **Notifications.** If you allow them, the app gives the household's device this phone's notification token. Each
  note is sealed by the device for this phone; our service and Apple's notification service see only "Something from
  home." and the sealed note, which the app opens on the phone.
- **Send to Opie (the share sheet).** What you share (a link, words or a photo) goes through our service to the
  household's device, which answers. It's readable by our service on its way, as anything sent over https to a service
  is, and it isn't written down there.
- **Siri and Shortcuts.** A question asked with "Ask Opie" goes to the household's device, as if typed in the app.
- **The microphone.** Used only when you talk to Opie. See below for where speech goes.

## Opie, the assistant

What someone asks Opie goes to the AI service the household chose for it: their own Claude or ChatGPT subscription, or
Opie's cloud assistant, which uses OpenAI through our service. Talking out loud with the cloud assistant streams
the audio to OpenAI for the conversation. Those services handle it under their own terms; our service passes it on and
doesn't keep what's said or asked.

The device's microphone opens only while Opie's voice is on, and the household chooses how (Settings, Opie, Talk to
Opie). With "Hey Opie", a small model on the device listens for those two words, and nothing it hears leaves the device
until they're said. With Tap to talk, the microphone is closed until someone taps, and closes again
when that conversation ends.

## The hosted service

Every device checks with us for updates, linked or not. The check carries the device's version and a random install
id (a linked device's own id instead), used only to choose which release it gets. We count those checks by version
each day, as numbers only, with no id kept. Everything else here starts only when the household links its device to
an account.

- **The account:** the email address used to sign in, and the household's name. Kept until the account is deleted.
- **Devices:** each linked device's name and its latest health check-in (version, whether its parts are running,
  free space). Check-ins never carry the household's things.
- **Backups (if turned on):** encrypted on the device with a key from the household's recovery code before they're
  uploaded. We can't open them, unless the household asked us to keep a copy of that code.
- **Use and cost:** minutes and amounts used each month, as numbers, so we can keep within the limits.
- **Opie credit (if bought):** what was bought and used and when, and Stripe's id for the household and its saved card
  (if auto top-up is on). Card details and the billing address go to Stripe, never to us.
- **Logs:** each request's path, result, time taken and household, kept 30 days. Never what was said or shared.
- **Reports (only when someone sends one):** Send a report on the device sends us its recent logs, so we can see what
  went wrong. They can include things said to Opie and the household's names; the device says so and asks first.
  Kept 30 days, and deleted with the account.
- **Email to the device:** the household's address at email.openhouse.computer, made when its device is linked (it
  can be turned off on the device). Mail from addresses the household approved is delivered; mail from anyone else
  waits on the device, unread, until someone allows it. Each message is read once as it arrives, to check it and seal
  it so only the device can open it; we keep that sealed copy until the device takes it, at most 7 days. We keep the
  approved addresses only as hashes, and counts of messages, for the limits. The household's assistant reads what
  arrives.
- **The website:** if you ask for a beta invite, the email address and answers you give.

The service runs on Amazon Web Services in the United States. Only the people who run Opie can reach it.

## Google accounts

A household can connect its Google Calendar or pick photos from Google Photos. Opie asks Google only for what that
needs:

- **Google Calendar** (`calendar.events` and `calendar.calendarlist.readonly`): to list the calendars the household
  chooses, show their events on the device, and add or change the events someone asks for there.
- **Google Photos** (`photospicker.mediaitems.readonly`): to copy the photos someone picks onto the device, once.

Events and photos go between the device and Google directly. Our service only completes Google's sign-in, because the
sign-in's secret has to stay off the device. It keeps no tokens, events or photos. The calendar's refresh token stays
on the device, sealed, and the household can remove access at any time from the device or from their Google account.

Opie's use and transfer of information received from Google APIs adheres to the
Google API Services User Data Policy (developers.google.com/terms/api-services-user-data-policy), including
the Limited Use requirements. We don't sell it, use it for advertising, or use it to train AI models, and no person
reads it except, with the household's permission, to help with a problem they report.

## How we protect data

This covers everything above, including data from Google (calendar events, photos and sign-in tokens).

- **In transit:** everything between the household's devices, our service and Google goes over https (TLS). Our
  service refuses plain http. Between the household's own phones and device, requests are also sealed with keys only
  those devices hold, so our relay can't read them.
- **On the device:** Google's refresh token is encrypted with AES-256-GCM, using a key kept in the device's Android
  Keystore that can't be copied off the device. It's kept in Opie's private storage, apart from the household's
  files, and never goes into a backup. Android encrypts the rest of the device's storage.
- **On our service:** we keep no Google tokens, events or photos. Google's sign-in passes through it once and the
  token goes only to the household's device that asked for it; it is never written to a database or log. Our Google client secret is
  kept in AWS's encrypted parameter store, readable only by the service itself.
- **Stored data:** the account database and backups are encrypted at rest by AWS. Backups are also encrypted on the
  device before they're uploaded. Storage is never public, and only accepts https.
- **Who can reach it:** only the people who run Opie, through individual accounts with single sign-on. No one reads a
  household's data except, with the household's permission, to help with a problem they report.
- **Problems:** if we learn of a breach affecting a household's data, we tell them by email and fix the cause.

## Companies that help run it

- **Amazon Web Services** (United States): hosting, storage of encrypted backups, receiving email to the device, and
  address suggestions as someone types one on the map.
- **OpenAI**: the cloud assistant (typed and spoken) and making apps on the device, when the household uses it.
  With the household's own OpenAI key on the device, the device talks to OpenAI directly on the household's own
  account, and none of it passes through our service. The key stays on the device and never reaches us.
- **Stripe**: takes payments for Opie credit, under its own privacy policy.
- **Resend**: sends the sign-in emails.
- **Apple**: delivers iPhone notifications, which carry only a sealed note.
- **Let's Encrypt**: issues the certificate that lets the household's phones reach the device securely at home. It
  sees only the device's random name, never the household's.

## Services the device reaches itself

The device asks these directly, not through our service. Each sees the device's internet address, as any website
does, and handles it under its own terms.

- **Open-Meteo**: the household's town, or a place someone asks about, for the weather.
- **OpenStreetMap's services** (Nominatim, and the routing at routing.openstreetmap.de), once the Map is on: addresses
  someone looks up or saves, and the two ends of a drive being worked out.
- **OpenFreeMap**: the map itself, once the Map is on. It sees which part of the map is being shown.

## Deleting

Remove a phone on the device (Settings, Devices) and it can no longer reach the household; deleting the app removes
its pairing from the phone. Delete the account on the account page and we delete the account, its devices, backups,
mail waiting for the device, any copy of the recovery code, and its Opie credit and the record of its purchases (what's
left isn't refunded: see the terms). We also delete its customer and saved card at Stripe, which keeps its own record
of the payments. The database's own restore copies, kept for disaster recovery, age out within 35 days. Its email address is never given to anyone else. The household's things on the device are the household's to keep or erase.

## Children

A household's phones, kids' included, join only when an adult adds them on the device. What they do stays with the
household's device; we don't ask children for any information.

## Changes and contact

If this changes, the new version goes here with its date. Questions: privacy@opie.house.

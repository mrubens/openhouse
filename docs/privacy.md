# Privacy

The privacy policy for OpenHouse: the tablet, the iPhone app and the hosted cloud. The page people read is the cloud's
copy at openhouse.computer/privacy (`openhouse-cloud/lambda/privacy.ts`); keep the two the same. Draft of 2026-11-24,
not yet published.

---

**OpenHouse keeps a household's things in the household's own home: on its tablet (or hub).** Our hosted service, and
the iPhone app, only help the household's devices reach it. We don't sell data, show ads or use tracking or analytics
in the app.

## The iPhone app

- **Joining.** The app joins a household when someone scans the code its tablet shows or opens an invite link. It keeps
  that pairing (the phone's own key) in the phone's keychain. The camera is used only to read that code; no picture is
  kept or sent.
- **The household's page and widgets.** What the app shows comes from the household's tablet. Requests between the
  phone and the tablet are sealed with a key only the two of them hold, and pass through our relay, which sees only
  sealed boxes and which household they are for. The page itself (its code, not the household's things) is loaded
  from our service.
- **Notifications.** If you allow them, the app gives the household's tablet this phone's notification token. Each
  note is sealed by the tablet for this phone; our service and Apple's notification service see only "Something from
  home." and the sealed note, which the app opens on the phone.
- **Send to Opie (the share sheet).** What you share (a link, words or a photo) goes through our service to the
  household's tablet, which answers. It's readable by our service on its way, as anything sent over https to a service
  is, and it isn't written down there.
- **Siri and Shortcuts.** A question asked with "Ask OpenHouse" goes to the household's tablet, as if typed in the app.
- **The microphone.** Used only when you talk to Opie. See below for where speech goes.

## Opie, the assistant

What someone asks Opie goes to the AI service the household chose for it: their own Claude or ChatGPT subscription, or
OpenHouse's cloud assistant, which uses OpenAI through our service. Talking out loud with the cloud assistant streams
the audio to OpenAI for the conversation. Those services handle it under their own terms; our service passes it on and
doesn't keep what's said or asked.

## The hosted service

Everything here starts only when the household links its tablet to an account.

- **The account:** the email address used to sign in, and the household's name. Kept until the account is deleted.
- **Tablets:** each linked tablet's name and its latest health check-in (version, whether its parts are running,
  free space). Check-ins never carry the household's things.
- **Backups (if turned on):** encrypted on the tablet with a key from the household's recovery code before they're
  uploaded. We can't open them, unless the household asked us to keep a copy of that code.
- **Use and cost:** minutes and amounts used each month, as numbers, so we can keep within the limits.
- **Logs:** each request's path, result, time taken and household, kept 30 days. Never what was said or shared.
- **Reports (only when someone sends one):** Send a report on the tablet sends us its recent logs, so we can see what
  went wrong. They can include things said to Opie and the household's names; the tablet says so and asks first.
  Kept 30 days, and deleted with the account.
- **The website:** if you ask for a beta invite, the email address and answers you give.

The service runs on Amazon Web Services in the United States. Only the people who run OpenHouse can reach it.

## Deleting

Remove a phone on the tablet (Settings, Screens) and it can no longer reach the household; deleting the app removes
its pairing from the phone. Delete the account on the account page and we delete the account, its tablets, backups
and any copy of the recovery code. The household's things on the tablet are the household's to keep or erase.

## Children

A household's phones, kids' included, join only when a grown-up adds them on the tablet. What they do stays with the
household's tablet; we don't ask children for any information.

## Changes and contact

If this changes, the new version goes here with its date. Questions: privacy@openhouse.computer.

# The household's email address (plan)

A plan, not yet built (2026-11-24). Each household linked to the cloud gets an address, like
`maple-otter-42@email.openhouse.computer`. Someone forwards it a school email, an invitation or a flyer, and Opie reads
it and offers to add the events. Someone emails it photos and they go into Photos, the way you can email a
picture frame. Only mail from addresses the household approved gets in.

The cloud receives the mail, seals it for the tablet, and deletes its own copy once the tablet has it. The tablet does
the rest. How the cloud side is built (the SES receipt rule, the Lambda, the stack, DNS) is in the cloud repo's
`docs/tablet-email.md`. This page covers what the household sees and what the tablet does.

**Cost:** SES charges for receiving by the message and by the 256 KB chunk: about $0.12 a month for a household
getting five 2 MB messages a day, about $1.80 at the caps below. Reading mail is a model call through the household's
assistant; with the cloud assistant it counts against the monthly allowance, as a flyer photo does.

Sending mail from the tablet is out of scope for now. If it comes later it goes from the same address, through SES,
and needs its own plan: what may be sent, who says yes, and replies.

## How mail gets to the tablet

1. A message to `<address>@email.openhouse.computer` reaches Amazon SES (the subdomain's MX). The domain's own mail
   (Google Workspace on `openhouse.computer`) isn't affected.
2. The cloud checks it: the address belongs to a household, the sender is on that household's list (or it's held,
   below), SPF or DKIM pass
   for the sender's domain (DMARC alignment, so a forged `From` doesn't get through), no virus, and it's within the
   limits below. Anything that fails is dropped with no bounce (bounces to forged senders just spread spam).
3. The cloud seals the whole message (the raw MIME) with the tablet's mail key, a public key the tablet gave it when
   it was linked, so the waiting copy is one only the tablet can open. It deletes the plain copy and leaves the sealed
   one in storage.
4. If the tablet is connected, one small relay message tells it there's mail (the key only, as relay boxes do now).
   If it isn't, the mail waits, and the tablet asks for whatever is waiting each time it connects.
5. The tablet fetches it (a short-lived link, its own credential), says it's done, and the cloud deletes it. Mail
   nobody fetched is deleted after 7 days.

The tablet opens and reads the message itself: it parses the MIME, keeps the text, the images and the PDFs, and
throws the rest away.

## The address

- **Chosen for them, changeable.** When the household links its tablet, it gets two random words and a number
  (`maple-otter-42`), from a word list for addresses only, with nothing about the household in it. In Settings → Email
  they can take another random one or type their own (letters, digits, dashes, 4 to 30 characters, not already taken,
  not on the cloud's short list of reserved names like `admin` or `postmaster`).
- **Changing it** (spam, or they just want a new one): the old address stops at once and is never handed out again.
  The new one shows in Settings with a one-line note to update the forwarding rules people set up.
- **On by default.** Every household linked to the cloud gets an address when its tablet is linked, with the
  account's sign-in addresses already approved, so forwarding works with no setup. Settings → Email can turn it off,
  which deletes the address (and anything waiting).
- **No naming step.** Signing up doesn't ask for a household name to use in the address (or anywhere else): a chosen
  name tends to be the family's surname, which would make the household easy to identify from anything it's in.
- Since only approved senders get in, the address isn't a secret, and spam can't get through by guessing it.

## Senders

- **Each person's own addresses.** The account's sign-in addresses are approved from the start. In Settings → Email, a
  grown-up adds the other addresses mail may come from, each one with the person it belongs to (Sam:
  `sam@example.com`, `sam.work@example.com`), and says whose each sign-in address is. These are the only way in. The
  household's list is kept on the tablet; the cloud keeps only a keyed hash of each address (HMAC with a key per
  household), enough to check a sender without a readable list of people's addresses.
- **Approving is done on the tablet** (or a grown-up's phone), behind the PIN where the tablet has one. Opie can't add
  a sender, and nothing in a message can.
- **Anyone else is held.** The first message from a new address is usually one someone wanted (a school email
  forwarded from a work account), so it isn't dropped. If it passes the same checks as approved mail (SPF/DKIM,
  DMARC, no virus, the size limit), the cloud seals and delivers it like any other, marked held, at most 10 held
  messages a day per household. The tablet keeps it unread: nothing reads it, no model sees it, and Settings → Email
  shows only "Waiting: mail from `newsletter@maple-elementary.example`", with Allow and Delete. Allow approves the
  sender and reads that message; anything not allowed is deleted after 3 days. Held mail isn't kept in the cloud any
  longer than other mail. Past 10 a day, the rest from unknown senders are dropped.
- **Mail sent straight from a school** (the household gave the school its OpenHouse address): the school's sending
  address gets added like a person's, under "Others". Its domain has to pass SPF or DKIM like anyone's.
- **Forwarded mail** comes from the person who forwarded it, so it's their address that counts; what the message
  says it was originally from doesn't matter.

## Limits

- **25 MB a message** (what Gmail and most others send at most). Larger ones are dropped, with a note on the tablet
  ("A message from Sam was too big").
- **What's kept from a message:** its text (plain, or the HTML turned into text), images (JPEG, PNG, WebP, HEIC and
  GIF's first frame) and PDFs. At most 20 images and 5 PDFs a message, 20 pages of a PDF; other attachments are
  dropped. HEIC is turned into JPEG on the tablet.
- **50 messages a day** per household, and 200 a month, at the cloud. Past that, mail is dropped until the next day
  and the tablet says so.

## What the tablet does with a message

One model call per message, on the tablet, through the household's own assistant (`answer()` in `bridge/house.js`),
like reading a flyer photo today. The model gets the message's text, its images and PDF pages, and is asked for JSON
only: whether each image is a photo to keep or a flyer/notice to read, and the events found anywhere in the message
(the same event shape `addFlyer` asks for). It doesn't follow a keyword list for any of this (no "photos" or "flyer"
in a subject line); the model makes the call, with what the message holds as context.

- **Photos** go into an album called Email (made the first time, through the albums in `data.albums`; the household
  can rename it or turn it off for the sleep screen as with any album), captioned with the sender's first name and
  the message's subject. Duplicates are skipped as `addPhoto` already does.
- **Events** go where flyer events go now: the Calendar app shows them, from "Sam's email", each one to say yes to.
  Nothing is added until someone says yes on the tablet or on a phone. Opie mentions there's an email waiting the next
  time someone talks to it, once.
- **Everything else** (a message with no events and no photos) is kept on the tablet for a week in Settings → Email
  so someone can see what came in, then deleted. Nothing in it is acted on.
- If the household has no assistant connected, photos still go into Photos; flyers and other messages wait in
  Settings → Email until one is.

## Safety

- **A message is data, never instructions.** The model call that reads it has no tools: it can only return the JSON,
  which the tablet checks against the event and photo shapes like `addFlyer` does (titles and notes cut short, dates
  that parse, at most 12 events). The message is put to the model inside clear markers, with the instruction that
  nothing inside them is a request from the household.
- **Opie never sees a message in a conversation** as something to act on. When someone asks about it, Opie gets the
  proposed events and a short summary, marked as having come from an email.
- **Nothing happens without a person.** Events wait for a yes; senders are approved only in Settings; links in a
  message aren't opened or fetched by anything on the tablet.
- **Forgery:** a sender only counts when SPF or DKIM pass for its domain and line up with the `From` (DMARC). Mail that
  fails is dropped, even from an approved address.
- **The sealed copy:** the cloud seals each message for the tablet's mail key (X25519 sealed box) before it's stored,
  and the key's private half stays on the tablet. A tablet that's replaced or restored makes a new key; mail sealed
  for the old one can't be opened and is deleted.

## Storage and privacy

- **In the cloud:** while a message waits, only its sealed copy (at most 7 days, deleted when the tablet takes it).
  The plain copy SES writes is read once, sealed and deleted within a minute; a storage rule deletes any left behind
  after a day. Kept for as long as email is on: the address, the hashed sender list, and counts (messages a day, as
  numbers, for the limits). The logs say a message came for a household and its size, never who it's from or what's
  in it.
- **On the tablet:** held messages 3 days unless allowed; messages are kept a week, photos in Photos as any others, events once someone says yes.
- **Offline:** mail waits up to 7 days in the cloud, sealed. A tablet off for longer loses what came in that time and
  shows "Mail sent before (date) didn't arrive".
- **Who can read mail on the way:** SES receives it in the clear, as any mail server does, and the cloud's Lambda
  reads it once to check the sender and seal it. Nobody looks at it, and the plain copy is gone within a minute.
- **The privacy page** (`docs/privacy.md` and the cloud's `lambda/privacy.ts`) gets an "Email to the tablet" bullet
  under the hosted service when this ships, saying the above in short: the address, who may send, what the cloud
  keeps (a sealed copy until the tablet takes it, at most 7 days; hashed sender addresses; counts) and that the
  household's assistant reads what arrives.

## Without our cloud: the household's own mailbox

Self-hosters (and anyone who'd rather not use our cloud) can give the tablet a mailbox of their own instead: a
dedicated address at any provider with IMAP (Fastmail, iCloud, Gmail with an app password, their own server). Either
source works alone, or both together.

- **Settings → Email → Use your own mailbox:** the server, the address and an app password. The shell keeps them
  sealed with its key, as it keeps iCloud's app-specific password, and only ever talks to that server.
- **Checking:** the shell looks every 2 minutes, in the inbox only, at messages that came after the mailbox was added.
  It hands each one to the bridge, then marks it read on the server. Nothing goes anywhere but that server and the
  tablet.
- **The same rules.** The tablet makes the checks the cloud's gate would: senders on the list (the rest held, at most
  10 a day), the size, the daily caps. For forgery it trusts the receiving provider's verdict, the top-most
  `Authentication-Results` header (a sender can't put one above the provider's): DMARC `pass`, or, when the sender's
  domain has no DMARC policy, a DKIM or SPF `pass` for a domain matching the `From`. A message with no verdict from the
  provider is held, not read.
- **Running our cloud yourself** isn't the self-hosted path: openhouse-cloud is private. The mailbox is.

## How the parts talk (for building)

- **The mail key:** X25519, made by the bridge, the private half in `display/.cloud/mail-key.json` (0600, never in a
  backup). Its public half (32 bytes, base64url) goes to the cloud in `POST /v1/mail`.
- **A sealed message** (`bridge/mail-seal.js`, the cloud's seal copies it): `OHM1` (4 bytes), the sender's ephemeral
  X25519 public key (32), a nonce (12), then AES-256-GCM of the raw MIME with its 16-byte tag at the end, the 4 magic
  bytes as additional data. The AES key is HKDF-SHA256 of the X25519 shared secret, salt = ephemeral public key ‖
  tablet's public key, info `openhouse-mail-v1`, 32 bytes.
- **Sender hashes:** hex HMAC-SHA256 of the address lowercased and trimmed, keyed with the household's `hashKey`
  (base64url, from `POST /v1/mail`).
- **The relay's nudge:** `{k: 'ml'}` to the tablet (no key, nothing else): the tablet asks `GET /v1/mail/waiting`.
- **Bridge routes** (`bridge/mail.js`; `/mail/set`, `/mail/held` and `/mail/incoming` refuse apps, as the shell-only
  album routes do):
  - `GET /mail` → `{cloud: {on, address} | null, own: bool, senders: [{address, who}], held: [{id, from, subject,
    at}], recent: [{id, from, subject, at, photos, events}], notes: [text]}`
  - `POST /mail/set` `{on?, address?: 'new' | <name>, senders?: [{address, who}]}`
  - `POST /mail/held` `{id, allow}`
  - `POST /mail/incoming` `{raw: <base64 MIME>, source: 'imap'}` (the shell, for the own mailbox) → `{ok}` or
    `{error}`; the shell marks it read on `ok` only.
- **Shell routes the bridge calls** (DeviceServer, its token, JSON): `POST /mail/pdf` `{pdf: <base64>, pages: 20}` →
  `{pages: [<base64 JPEG>]}`; `POST /mail/heic` `{heic: <base64>}` → `{jpeg: <base64>}`.

## What changes where

- **Cloud** (openhouse-cloud): the receiving, the address and the sender list, sealing, the waiting mail and its
  endpoints; the stack and DNS. Its `docs/tablet-email.md`.
- **Bridge:** a mail key made and kept with the tablet's other keys, given to the cloud when linking (and on
  "turn on email"); fetching waiting mail on connect and on the relay's nudge; a MIME parser of its own (the bridge has no
  dependencies); `addEmail` beside `addFlyer` in `bridge/house.js`, which reads it and puts photos and events
  where they go; Settings → Email (address, senders, held mail, what came in).
- **Shell:** PDF pages to images (Android's `PdfRenderer`) and HEIC to JPEG, for the bridge; the own mailbox
  (`MailAccount.kt`: sealed, a small IMAP client over TLS); Settings → Email.
- **Tests** (security and data safety only): a held message is never read or shown to a model until Allow; a
  forged `From` that fails DMARC is dropped; an email's events are never added without a yes; mail is deleted from the
  cloud after it's fetched.

## Decided (2026-11-24)

- Mail from unknown senders is held on the tablet for 3 days for Allow, not dropped.
- On by default, with the account's sign-in addresses approved; a random address, no naming step.
- One album, Email, for emailed photos.
- The subdomain is `email.openhouse.computer`.
- A household's own mailbox (IMAP) works without our cloud.

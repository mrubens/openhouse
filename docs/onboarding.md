# Onboarding: from the box to "Hey Opie"

## Day one, as built (2026-11-20)

On the tablet:

1. **Setup page** (opie.house/setup, `scripts/setup-page.sh`): the steps up to here are [setup.md](setup.md)'s,
   not repeated here.
2. **Getting Opie ready**: the runtime downloads (a few minutes).
3. **Welcome**: one line (who lives here, calendars and photos, Opie's voice last) and **Get started**.
4. **Setup** (`ui/Setup.kt`), one step at a time, each with Back, Skip and Next, and Later to leave it. It's quiet
   until its last step (since 2026-11-25; the owner, after trying the spoken setup on a real tablet: "leave the voice
   control out of the setup and add it as the last step"): nothing is said aloud, nothing listens, and everything is
   tapped and typed. `Setup.hushed` keeps the microphone, the wake word and the live voice off while the welcome or a
   step before the voice step shows (`MainActivity.micWanted`, `LiveVoice`, `Speech.say`).
   1. **Who lives here**: names, and an age or role. + Add someone sits beside Next, and a new row takes the keys.
      Every step's card is one width and never runs past the screen or Android's keyboard: what's in it scrolls, its
      buttons stay below it.
   2. **Where do you live**: a street address by default, guessed from where the tablet is (Android's location and
      geocoder, only with location on), or just the town or the zip code. The address is kept with the household
      (`address`: Opie's for directions and the like, and the Map's once it's on; the Map looks it up then, not
      before); the town or zip is the weather's.
   3. **Connect your phone or computer** (since 2026-11-25 before the calendar and photos, whose links are copied on
      a phone or computer, never on the tablet: one code reaches it for the whole setup): whose it is, then two ways
      in, each its own line. A phone scans the code; a computer goes to **opie.local:8788** and types the code (the
      bridge answers `opie.local`, and `openhouse.local` from before, over mDNS while the code lasts, and the bare
      address goes to the page for the code: `connect-page.js`, `screens.js`). Android won't let an app listen on port
      80, so the port stays in the address. The tablet's raw Wi-Fi address is never shown; without the name answered, a
      phone it is. Either joins at once as that person's, with the `setup` scope (no Allow: the code was only on the
      tablet). The card shows who's connected, and makes a fresh code when one has been used. The phone or computer
      then **follows the tablet's setup** rather than starting its own (`chat/src/phone.jsx` SetupFlow, GET
      `/setup/step`): on the calendar step it shows the box for a calendar's link, on the photos step the one for an
      album's link and, once photos from phones are on, Choose photos; on any other step, "carry on at the tablet". Once
      the tablet's setup is over, it offers what's only for there: inviting the family, and making apps. (A tablet from
      before, with no step to follow, gets the four steps as before.)
   4. **Do you have a family calendar?** Google, iCloud, Outlook, Another link, or Start one here, each with what to
      do in a few numbered lines: Google signs in through the account (`CalendarAccounts`, two-way) on a linked
      tablet, else its Secret address in iCal format, copied on the computer and pasted into Opie there (the connected
      phone or computer, `/setup/calendar`); iCloud signs in with an app-specific password (two-way); Outlook and the
      rest are a link, sent the same way. With nothing connected yet, **Connect a phone or computer** goes back to
      step 3 and Next there comes back. **Paste it here instead** is the small way, for a tablet with a keyboard cover.
      What's been added shows below as it comes in.
   5. **Put your photos on the tablet?** An iCloud shared album's link (sent from the connected phone or computer, or
      pasted here), Google Photos' picker on a linked tablet (`GooglePhotos`), or From your phone: Let phones send
      photos (a person's yes here, `PhotoShare.turnOn`), then the connected phone shows Choose photos (no second code
      to scan). The albums and photos that came in show below, the newest as small pictures.
   6. **Choose a PIN** ("For grown-ups: settings and approvals"): PIN Lock on, so Settings and approving a new app
      ask for it. Skip leaves the lock off (Settings, PIN Lock, later). On a linked tablet there's no recovery code
      to keep, since the account page resets the PIN; unlinking shows one first.
   7. **Two of Android's settings** (`AndroidStep`, since 2026-11-26): Let Opie use other apps (Android's
      accessibility page for the Opie assistant; "On" once it is) and Stop charging at 80% (Android's settings, with
      the path for a Samsung, else a pointer to [tablets.md](tablets.md)). Each leaves kiosk mode, behind the PIN if
      one was chosen; Home comes back. Both can be skipped.
   8. **Talk to Opie**, the only step with a voice: "say “Hey Opie”, then what you'd like", three things to ask in
      the household's words ("Add milk to the list", "What's on tomorrow?", and an app in the children's names when
      the household has any: `PluginsMenu.example`), OpenAI's live voices in rows of six (all in view, nothing off the edge), and the line the tablet always
      uses: "What you say after “Hey Opie” goes to OpenAI." **Turn on Opie's voice** (a person's tap, behind the PIN
      when the lock is on: `CloudVoiceMenu.fromSetup`) sets the voice, turns the voice and Hey Opie on, and offers a
      try ("Say “Hey Opie, what's the weather?”") with Opie's face showing it listening; picking another voice then
      says a line in it. **Not now** ends the setup with the voice off, kept as an Off (`OpieChoice`), so it isn't
      turned on by itself later: Settings → Voice. Without a voice to turn on, it says why and how, and offers Done:
      the household's account doesn't have it yet ("Opie's voice isn't on for your household yet", with **Ask for
      Opie's voice**: the service keeps the ask and emails the household once it's on; the tablet asks once when it does), or the tablet isn't linked (Link this tablet, or Settings → Account, then Settings →
      Voice).

      The voices can't be heard before Turn on: they're OpenAI's live voices, played only in a live session, and the
      cloud has no sample route (that would be a cloud change: a short clip per voice, made once and served without a
      session). Until then the row says "You hear it once the voice is on", and once it's on, each pick is a real
      sample in that voice.

   **Opie's voice turning on by itself** (`CloudSetup.autoVoice`): once a minute the shell looks at `/cloud/voice`;
   while the tablet is linked and the voice is off, it asks the cloud (`?check=1`, the cloud's `voiceState`) right after
   a link (from Settings → Account, or the setup QR's code) and every five minutes after. Never while the welcome or
   the setup shows: the setup's voice step decides. When the household has the voice (`available`): a household that
   said yes here (the voice step's Turn on, a voice picked, or an older welcome's Turn on Opie) gets it on, Hey Opie
   listening; one that hasn't answered (a setup left before its voice step, or a tablet from before) sees "Turn on
   Opie?" once, with the words about OpenAI (a person's tap, behind the PIN when the lock is on). Off in Settings, Not
   now, or off from the account page (`offWhy`) stays off. Until the household has it, turning it on says "Opie's
   voice isn't on for your household yet."

On the phone or computer (`chat/src/phone.jsx`, SetupFlow), five steps with Next and Back:

1. **Keep Opie here**: the app version (installable, from the cloud) when the tablet is linked, else a bookmark
   that works on the home Wi-Fi.
2. **Your calendars**: paste a calendar's link (where to find it in Google, iCloud, Outlook), say whose. It goes
   straight in (`POST /setup/calendar`, no card on the tablet unless its lock is on).
3. **Photos**: an iCloud shared album's link (`POST /setup/album`).
4. **Invite your family**: Send for each person (not pets) makes their own link (`POST /setup/invite`, a week, once)
   and opens the share sheet. Opening it joins their phone as theirs, a kid's with a kid's scopes, with no Allow.
   With Use it away from home on, a link opens the cloud's phone page and joins through the relay from anywhere
   (the invite is announced to the relay like a computer's code, `screens.js` `computerPairs`); without it, links work
   on the home Wi-Fi.
5. **Make your own apps**: connect Claude or ChatGPT on a computer (openhouse.computer).

Then the usual phone page. On the tablet, Done goes to the home screen, filled in.

Not yet: photos from phones in the phone's setup, and the
address guess on a real tablet (the emulator has no location).

## The proposal (history)

Status: proposal, 2026-11-19. The sign-in relay (way 1's key piece) is built and tried on an emulator; the rest isn't built.

## Short answer

**Make adding Opie to Claude the whole setup.** Today there are two setups, the tablet's AI and the computer
link. Instead, there's one conversation in the AI app the parent already uses on their computer:

1. On openhouse.computer: **Add to Claude**. Open the file and click Install (or paste one line into Claude Code or
   Codex).
2. In Claude: "Set up my Opie." A page with a QR code opens on the computer. Type the Wi-Fi password there.
3. At the tablet: tap the welcome screen six times, scan the laptop's screen, and tap through Android's two consent
   screens. Then wait. Claude says what the tablet is doing.
4. In Claude, which is still in the same chat: "Your tablet's up. Click Authorize in the browser tab I just opened."
   That's the tablet's AI signed in. Then Claude asks for the family's names and what Opie should be called, and
   finishes with "try asking me for a whiteboard tab".
5. At the tablet: "Hey Opie, what's the weather?"

That's one flow, run in one place, with no codes moved by hand, no pairing code, no Allow tap and no "Which AI does
your family use?" screen. The tablet uses the AI of the app it was set up from: Claude Desktop or Claude Code means
Claude, and Codex means ChatGPT. It's about 15 actions, compared with about 40 today (see "Counting").

Three things make it one moment:

- **The computer makes the setup QR.** The Opie extension draws the provisioning QR code on the computer, with a
  fresh secret `S` inside it. The tablet scans it, so the tablet and this computer are paired the moment it comes up.
  Seeing the screen is the proof that the parent is in the room. Nothing goes through a server.
- **The computer catches the tablet's sign-in.** The tablet runs its own login, as now. Its sign-in link is opened in
  the computer's browser, where the parent is already signed in. The login's "back to the app" step, a redirect to
  `localhost`, lands on the computer, and the extension passes it to the tablet. One click, no code, and the login
  lives only on the tablet. **Prototyped:** see "The sign-in relay".
- **Claude runs the rest.** Names, the wake name and the first change happen in the chat, using the workshop tools
  that already exist (`update_household`, `set_home`, `start_editing`…).

## Where onboarding starts today

| Stage | Where | What the parent does |
| --- | --- | --- |
| Provision | tablet + a screen showing the QR | reset or unbox; tap the welcome screen 6×; Wi-Fi if asked; scan `provision-qr.sh`'s code; two Android consent screens; wait for the APK, then the runtime download |
| First run | tablet | family names, wake name (Opie), PIN, voices |
| AI | tablet (+ phone) | "Which AI does your family use?" Claude: sign in in the tablet's browser or on a phone (Handoff page), copy the code, paste it back. ChatGPT: a device code typed on a phone. OpenRouter: a key from a phone |
| Computer link | tablet + computer | PIN → Connect Claude or ChatGPT → on the computer open `opie.local:8788` → download `.mcpb` or copy a one-liner → new session → "connect to my Opie" + 12-character code → Allow on the tablet |

That's four separate starts, each with its own code and wait. The phone is there only because the tablet has no
keyboard, and the computer, which has one, comes last. It's also asked "which AI?" twice: once on the tablet, and once
by which app gets the extension.

## The sign-in relay (prototyped)

Claude Code's login has two modes. If it thinks it can open a browser, it uses a `localhost` callback. If not, it
falls back to "paste the code", which is what the tablet does today. What I ran on this Mac (Claude Code 2.1.319, an
empty `CLAUDE_CONFIG_DIR`, with `BROWSER` set to a script that only writes down what it's given; I didn't complete a
sign-in):

- The script received `https://claude.com/cai/oauth/authorize?…&redirect_uri=http://localhost:63059/callback&…` with
  a PKCE challenge. The printed fallback link still used the platform callback page.
- Claude Code was listening on `127.0.0.1:63059`, waiting for that callback, and also accepted a pasted code.

So the relay is:

```
tablet (agent's app): claude auth login, BROWSER=<hand the link to the bridge>
   └─ link (no secret in it: client id, PKCE challenge, redirect_uri=localhost:P) ──sealed──▶ computer's extension
computer: extension listens on 127.0.0.1:P, opens the link in the default browser
browser:  Anthropic's page (already signed in) → Authorize → redirect to localhost:P/callback?code&state
computer: extension forwards that request ──sealed──▶ tablet → 127.0.0.1:P inside the agent's app
tablet:   Claude Code swaps the code using its own PKCE verifier, and is signed in. Its answer (the "you're signed in"
          redirect) goes back to the browser.
```

The token is made on the tablet and never leaves it. Only the one-time code crosses, sealed, and it's useless without
the verifier on the tablet. The same relay fits pi's "Sign in with ChatGPT" (`pi/openai`, which also ends at
`127.0.0.1`, as `SignIn.kt` notes) and Codex-style logins (`localhost:1455`). ChatGPT's device-code route needs no
relay: the extension opens the link, and Claude shows the code to type.

This is worth building even on its own, because it also takes the paste out of today's Connect-then-sign-in flow.

**Built (2026-11-19)**:
- the runner catches the link (`/login/link`) and passes the callback on (`/login/callback`);
- `POST /workshop/signin` in the bridge (`signin-relay.js`), with the display's Claude sign-in opened through
  DeviceServer `/signin`, so the tablet shows "Finishing on <computer>: click Authorize there";
- `sign_in_tablet` and `openhouse-mcp sign-in` in the computer's extension;
- `bridge/test/signin-relay.test.mjs` runs the whole chain, with a stand-in Claude Code and browser.

**Tried on an emulator** (`display-workshop`, on the pi runtime):
- The real Claude Code in the agent's app honoured `BROWSER` too.
- Its `localhost:<port>` link reached the Mac 23 s after asking, including opening the sign-in screen and starting
  the login.
- A stand-in browser returned to the Mac's listener with a made-up code. The callback went Mac → bridge → runner →
  Claude Code, which tried the exchange with Anthropic and answered with its own "Sign-in was canceled or failed"
  page.

- A real Authorize with a real Claude account, from `openhouse-mcp sign-in` on the Mac (2026-11-19): one click in the
  Mac's browser, and the emulator's assistant came back signed in to Claude.

Still to see: pi's Sign in with ChatGPT through the same relay.

## Three ways to do it

### 1. One conversation in the computer's AI app (recommended)

Described above. Details:

- **Before pairing**, the extension offers a few setup tools alongside `pair_with_tablet`:
  - `set_up_new_tablet`: makes `S`, serves a local page at `127.0.0.1` with the Wi-Fi field and the QR code, and
    opens it.
  - `setup_status`: provisioning, then the runtime download, then ready. Each call returns quickly, so a slow
    download doesn't hit a tool timeout.
  - `sign_in_tablet`: the relay.
- **The Wi-Fi password.** It's typed on the local page and goes only into the QR code, never into the chat. On a Mac,
  the page can offer "Use this Mac's Wi-Fi": the network name from `networksetup`, and the password from the
  Keychain behind macOS's own prompt.
- **The QR** carries `provision-qr.sh`'s fields, plus `PROVISIONING_WIFI_*` and `S` in the admin extras.
  `ProvisioningActivity` already reads those extras. The tablet keeps `S`, comes up with the listener and
  `openhouse.local` on, and shows one line: "Finishing setup from Sam's MacBook". The extension finds it by Bonjour,
  as pairing does today, and enrolls with `S` instead of a typed code and Allow. The computer still appears in
  Screens and can be removed.
- **The AI.** The tablet's provider follows the app: Claude Desktop or Claude Code means `pi/claude-code`, and Codex
  means ChatGPT. The parent can say "use OpenRouter instead" and Claude opens a local page for the key. The key is
  typed there, not in the chat.
- **The rest** is ordinary workshop work: `update_household` for names, the wake name, the PIN through a local page
  (not the chat), then the first tab. The tablet's own screen asks for the voice steps that need its microphone.
- **openhouse.computer** only hosts the downloads: the `.mcpb` and the one-liners. It's the same file for everyone,
  holds no secrets, and takes no account.

Costs:

- **It needs a desktop AI app that runs local extensions:** Claude Desktop, Claude Code or Codex. ChatGPT's desktop
  app and the claude.ai website can't. Those families use way 2 (or way 3 later).
- **Installing an extension is the first step**, before anything visible happens. Claude Desktop's install is one
  dialog, but it's an unfamiliar one.
- The family's names go to the AI the family chose. That's fine by our rule, and it's the same as the workshop
  already does.

### 2. One page on the computer (the fallback)

For a computer without one of those apps. openhouse.computer/setup makes `S` and the QR in the browser. Once the tablet
is up, **Continue** goes to `http://openhouse.local:8788/setup#S`, a page the tablet serves, with names, PIN and the
AI on one page. It's a top-level navigation, because an https page can't fetch a plain-http LAN address. A browser
page can't listen on `localhost`, so Claude's sign-in is the copy-the-code paste, or a device code for ChatGPT. The
page ends with "Add to Claude", already enrolled through a one-time token stamped into the download, for when the
parent installs the app later.

It's the same moment, minus the chat, plus one paste. The same page also works on a phone, for a family with no
computer.

### 3. One family account (later)

The parent signs in at `cloud.openhouse.computer`. The setup QR carries a link token, so the tablet comes up already
linked. claude.ai or ChatGPT on the web then adds Opie as a remote connector (the planned relay in
`docs/workshop-mcp.md`) by signing in with the same email. This reaches the browser-only families that way 1 can't,
and it works away from home. But it's opt-in (it's a service the family's data passes through), it adds an email round
trip, and the relay isn't built. It's best offered as a checkbox in way 1 or 2 ("reach it from anywhere, keep
backups"), not as the default.

## Counting (non-technical parent with Claude Desktop)

Waits are the same in all of them: the APK download, about 7 s to install, and the runtime download (hundreds of MB,
minutes on home Wi-Fi). The runtime is the long pole. In way 1, Claude fills that wait with the names question.

| | Today | 1. AI app (recommended) | 2. One page | 3. Account |
| --- | --- | --- | --- | --- |
| Places | tablet, phone, computer | Claude + tablet | browser + tablet | browser + tablet |
| Taps and clicks | ~40 | ~15 | ~20 | ~22 |
| Typed | Wi-Fi and names on the tablet, the device code on the phone, the address and the 12-char code on the computer | one sentence, Wi-Fi password, names | Wi-Fi password, names | email, Wi-Fi password, names |
| Codes moved by hand | 3 | 0 | 1 (a paste) | 1 |
| "Which AI?" asked | twice | never (it follows the app) | once | once |
| Approvals | 2 Android consents, Allow | 2 Android consents, extension install, Authorize | 2 Android consents, Authorize | 2 Android consents, email link, Authorize |

## Where it lives

- **In the computer's AI app**: the conversation, and the local pages it opens for the Wi-Fi password, a PIN or a key.
  That's where the keyboard, the signed-in browser and the future workshop all are.
- **The tablet**, only for what needs its body: scanning the QR, Android's consents, the microphone. Its screens say
  one thing each: "Scan the code", "Finishing setup from Sam's MacBook", "Say Hey Opie".
- **Not the phone**, except in way 2 for a family without a computer.
- A second computer, later, uses today's Connect screen (code + Allow), with the sign-in relay available if the tablet
  ever needs to sign in again.

## The vendors (murky; context, not blockers)

- With the relay, the login is the tablet's own and stays there, so no sign-in is shared between devices.
- **Shortcut if the relay can't work for a vendor:** the computer mints a separate sign-in for the tablet and sends it
  sealed. For Claude that's `claude setup-token`, a one-year token for headless use, made with one Authorize click.
  For ChatGPT, Codex documents copying `~/.codex/auth.json` to another machine. Both are greyer, and copying Codex's
  file means two devices share one refresh token.
- pi driving Claude Code through a relay is grey today whatever the onboarding. A "Claude (API key)" option, like
  OpenRouter, is a cheap fallback.
- "Sign in with ChatGPT" (`pi/openai`) is OpenAI's named route for local apps, and it's already wired in `SignIn.kt`.
- Pages read 2026-11-19: Anthropic's [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) and
  [authentication](https://code.claude.com/docs/en/authentication); OpenAI's
  [Codex auth](https://developers.openai.com/codex/auth) and [Sign in with ChatGPT](https://developers.openai.com/siwc).

## What to check before building (emulator first)

1. The relay, end to end, with a test account, through pi-claude-code in the agent's app. Then pi's Sign in with
   ChatGPT.
2. Android 16 on the Tab S10 FE: does the QR's `PROVISIONING_WIFI_*` join Wi-Fi with no Wi-Fi screen? Can the rear
   camera read a QR off a laptop screen? A Print button covers glare.
3. Claude Desktop: an extension serving a `127.0.0.1` page and opening the browser, and how it handles a tool that
   waits on a download. Use short `setup_status` calls, not one long call.
4. Codex: its MCP tool list is read once per session, so the setup tools have to be there from the start. They are,
   since they're the unpaired tools.

## If you like way 1, the build order

1. **The sign-in relay.** `BROWSER` capture in the agent's app login, a bridge route, a sealed message to the
   paired computer, and the extension listening and forwarding. It's useful immediately for today's flow.
2. **`S` in the QR.** The extension makes the QR page, `ProvisioningActivity` keeps `S`, and `screens.js` enrolls a
   computer by `S`.
3. **The setup tools** in the extension, and the tablet's "Finishing setup from …" first-run screen.
4. **openhouse.computer's download page.** It's static.
5. Way 2's page, for computers without an AI app.

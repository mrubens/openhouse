# Setting up Opie on your own tablet

This is the one guide for turning a tablet into your household's Opie. The short version is on the setup page,
[opie.house/setup](https://opie.house/setup), next to the code you'll scan. Other docs link here rather than repeat
it.

## 1. What it does

- **It takes over the whole tablet and erases it.** Opie becomes the tablet's owner (Android calls this a managed
  device) and runs as its home screen, in kiosk mode. Anything already on the tablet is wiped. Use a tablet with
  nothing on it you want to keep.
- **You need** the tablet, a Wi-Fi network with its password, and a phone or computer to show the code on (or print
  the setup page).
- **Pick a tablet from [the list](tablets.md).** Others may work; that page says what they need.

## 2. Before the reset

1. Remove every Google and Samsung account from the tablet: Android's Settings → Accounts (on a Samsung, Accounts and
   backup → Manage accounts) → each account → Remove account. A tablet reset with an account still on it can ask
   for that account's password after the reset, before you can get any further.
2. Reset it from Android's own settings: on a Samsung, Settings → General management → Reset → Factory data reset;
   on others, Settings → System → Reset options → Erase all data. It restarts at the first welcome screen.

A brand-new tablet, still in its box, needs neither step.

The household's Google account goes on after the setup, not before: Settings → Advanced → Google Play (with the PIN)
signs it in for adding Android apps. Then, in Google Play: your picture → Settings → Authentication → Require
authentication for purchases → For all purchases.

A Google account made just for the tablet works best: it keeps personal mail and cards off the shared screen.
Google subscriptions like YouTube TV are shared by adding that account to the household's Google family group, or by
signing in inside the app itself. Apps with their own sign-in, like Netflix, don't depend on it.

## 3. The six taps and the code

1. On the very first welcome screen (the one with "Start" or the language), **tap the same spot six times**, anywhere
   that isn't a button. A code scanner opens. Nothing happens if you've already moved past that first screen: go back
   to it.
2. **Connect to Wi-Fi** if it asks.
3. **Scan the code** on [opie.house/setup](https://opie.house/setup). If you already have an Opie account, you can
   scan the code from your account page at [cloud.opie.house](https://cloud.opie.house) instead: the tablet then links
   itself to your household.
4. **Android shows "This device belongs to your organization"** (the words vary), then a screen or two about the
   organization managing it. "Organization" here means Opie: it lets Opie stay in front, install its own updates and
   restart itself. The tablet is still yours, nobody else manages it, and you can erase it any time (section 5). Tap
   Accept, Next or Continue on each.
5. **Wait.** The tablet downloads Opie, then its software (about 210 MB), then "Getting Opie ready" while it unpacks.
   Leave it plugged in.

## 4. What finished looks like

1. **Welcome to Opie**, with Get started.
2. The setup, done from a phone or computer: the tablet shows a code to scan with a phone (or an address and code
   for a computer). On it you type who lives here and where, add your calendar and photos, and choose a PIN; it moves
   the tablet along as you go. Then, on the tablet: two of Android's settings. You need a phone or computer on the
   same Wi-Fi for this.
   - **Your calendars**: on a tablet linked to an Opie account, Sign in with Google opens Google's sign-in in a new
     tab; then choose the calendars on the tablet. iCloud takes your Apple ID and an app-specific password, made at
     account.apple.com (Sign-In and Security). Or paste a calendar's link.
   - **Two of Android's settings** opens Android's settings for each: letting Opie use other apps (switch on "Opie
     assistant" and tap Allow), and stopping charging at 80% ([where it is on each tablet](tablets.md#the-charge-limit-on-each)).
     Press Home to come back. Without the first, Opie can't open or press buttons in other apps; everything else works.
   - **Opie is ready**: once the setup ends, a tablet linked to an Opie account says so: say "Hey Opie" to use it
     (Turn off there, or later in Settings → Opie → Voice). A tablet without an account works by touch; to talk to Opie, add
     your own OpenAI key in Settings → Opie → Voice (a key from platform.openai.com: OpenAI bills your account, so set a
     monthly budget there too).
3. **The home screen**: Today, then your tabs (calendar, chores, lists, meals, photos). Pressing Home always comes back
   here. That's it: no cable or computer needed after the code.

## Away from home without an Opie account: Tailscale

Optional, for households that already use [Tailscale](https://tailscale.com) (or want to). Your own tailnet, not
Opie's cloud.

1. On the tablet: **Settings → Advanced → Tailscale → Turn on** (with the PIN). It downloads Tailscale (about 40 MB).
2. **Scan the QR code** with your phone and sign in to Tailscale. Or **Use an auth key** from Tailscale's admin console
   (Settings → Keys) and paste it.
3. For an `https://` address, turn on **HTTPS** in Tailscale's admin console (DNS → HTTPS Certificates). Without it
   the tablet uses its plain `http://100.x…` address.
4. Install Tailscale on each phone and computer, sign in to the same tailnet, and keep it on. Phones and screens you
   add from now on open the tablet at its Tailscale address, at home and away.

**Turn off** there signs the tablet out of Tailscale and removes it. To be sure a lost phone can't reach the tablet,
remove it in Tailscale's admin console *and* in Settings → Devices.

## 5. How to undo it

**Settings → Advanced → Erase this tablet** (with the PIN, if you set one). It unlinks the tablet from your account
and resets it to factory settings, and it starts again at Android's welcome screen as a normal tablet. Backups in
your account stay there until you delete the account.

Android's own factory reset is blocked while Opie runs in kiosk mode, so this is the way. If Opie itself won't open,
see "Stuck in kiosk mode" below.

## 6. When it's stuck

These are the ones we've seen on real tablets, with what fixed them. Something else? Tell us on
[the "My tablet" form](https://github.com/mrubens/opie/issues/new?template=my-tablet.yml), and if Opie opens,
send its logs with **Settings → Advanced → Send a report** (needs the tablet linked to an account).

- **The code is refused, or the tablet says it can't set up a work device** (Xiaomi's HyperOS): that tablet can't run
  Opie. Reset it and use it as a normal tablet.
- **"Opie's voice isn't on for your household yet"**: nothing is wrong. It turns on by itself once it's on for your
  household.
- **Settings → Advanced shows "Opie's software was stopped by Android"**: Android's limit on background processes
  stopped part of Opie (Opie restarts it). Tap the row for the steps to switch the limit off in Developer options,
  once.

More ways back without a visit (a forgotten PIN, an update that won't start, a tablet stuck in kiosk mode, Opie's
software not answering) are in [Getting back without help](#getting-back-without-help) below.

## Getting back without help

What each way back is, as the code has it. **None of these has been walked through on a real tablet yet**; each gets
"tried on" with a release and date once it has.

- **A forgotten PIN.** Tap **Forgot PIN?** where it asks for the PIN, then type the PIN's recovery code (shown when
  the PIN was set) or the backups' recovery code. On a tablet linked to an account there's also **Reset with your
  account**: the tablet shows a code, someone in the household types it on the account page at
  [cloud.opie.house](https://cloud.opie.house), and the tablet lets you choose a new PIN. Without either code and
  without an account, the way back is erasing the tablet from Android's recovery menu (the last item).
- **An update that won't start.** Nothing to do: each release carries the one before it, and a tablet whose new
  release doesn't come up healthy installs that one by itself ([self-update.md](self-update.md), "Going back").
- **Opie's software not answering** ("The tablet's software isn't answering right now"). The tablet starts it again
  by itself within a minute or so. If Settings → Advanced says "Opie's software was stopped by Android", tap it and
  follow its steps once. If it keeps happening, restart the tablet (hold the power button, then Restart).
- **Stuck in kiosk mode, Opie open.** Settings → Advanced → Leave kiosk mode (with the PIN), or Erase this tablet to
  give it back to Android entirely.
- **Stuck in kiosk mode, Opie not opening at all.** Opie stops Android's own factory reset and safe mode while it owns
  the tablet, but not the recovery menu: with the tablet off, hold the power and volume-up buttons until it appears
  (the keys differ by maker), choose Wipe data / factory reset, and confirm. The tablet starts again as a normal
  Android tablet. If it then asks for a Google account, it's the one that was on it before the reset (section 2).

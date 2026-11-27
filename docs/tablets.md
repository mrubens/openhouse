# Tablets for Opie

Opie runs on an Android tablet you buy yourself. This is the short list of the ones we know about. To set one up,
follow [the setup guide](setup.md).

| Tablet | State | Since |
|---|---|---|
| **Samsung Galaxy Tab S10 FE**, Wi-Fi (SM-X520) | **Works** | Opie is built on it. Release and date of its full test run: to be recorded |
| **Samsung Galaxy Tab A11+**, Wi-Fi (SM-X230) | **Being tested** | Voice fixes for it are in. It moves up once its results are in [hardware.md](hardware.md) |
| **Lenovo Tab One**, Wi-Fi (4 GB) | **Being tested** | Setup by code, linking to Opie Cloud, voice and the home screen all worked on 1.0.55 (2026-11-27) |
| **Xiaomi** tablets on HyperOS (Redmi Pad 2 Pro and others) | **Doesn't work** | HyperOS refuses the setup that makes Opie the tablet's owner, and lets Home leave kiosk mode |
| Anything else | Not tried | Tell us what happened: [the "My tablet" form](https://github.com/mrubens/opie/issues/new?template=my-tablet.yml) |

What the states mean:

- **Works**: all eight tests in [hardware.md](hardware.md) ("What to test on each") passed on a named release, which is
  written here with the date. Opie's releases carry this list, so a tablet that isn't on it says "We haven't tested
  this tablet" at Welcome and in Settings → Advanced. It never stops you setting it up.
- **Being tested**: we have one and are running those tests. It may work fine; we just can't say yet.
- **Doesn't work**: it failed a test that can't be worked around, so don't buy one for Opie.

Prices change too fast to list. When a price appears in this repo it carries its date (as in [hardware.md](hardware.md)).

## A spare phone

The same app runs on an Android phone, as the household's hub or a small panel on a counter or wall. A phone is any
screen whose short side is under 600 dp (`Calm.compact` in the shell, `useCompact` in `chat/src/home.jsx`); a tablet
never is, and stays exactly as it was. On a phone:

- It turns upright as well as sideways (the manifest keeps tablets sideways; `MainActivity` lets a phone turn).
- Sizes come from the short side: 560 u across it, upright or not (a tablet's long side is 1536 u). The home page's
  `--u` and the shell's `u` follow the same rule, and the apps in tabs take their own phone layout (`narrow.css`).
  Cards drawn for a tablet are no wider than the screen (`fit()` in `Theme.kt`, and dialogs).
- Home is a glance in big type: the time and the day, the weather, then what's on now (cooking, timers, what's next on
  the calendar, the shopping list) and asking Opie. Upright, the first four tabs are on a bar along the foot and More
  has the rest, sleep and Settings; sideways, the rail has the tabs.
- An app in a tab gets `compact=1` in its address, and keeps its phone layout on its side too, across the whole width
  (the kit, as on a phone's page: [phones.md](phones.md), "On its side").

![The glance on a phone](phone-display.png)

Not tried on a real phone yet: the emulator only (a Pixel 7's screen).

## Trying a tablet that isn't listed

It has a fair chance of working if it has:

- **Android 10 or later.** That's the least the app installs on. Android 15 or 16, with years of security updates
  still to come, is what we'd buy.
- **Setup by QR code as the device owner.** Android's own: tap the first welcome screen six times and a code scanner
  opens. Most tablets with Google's Android have it; some makers' own versions remove or break it (Xiaomi's HyperOS).
- **4 GB of memory or more.** Opie itself needs little now that speech runs in the cloud; 4 GB runs it (the Lenovo Tab
  One), and 6 GB leaves room for bigger apps.
- **A charge limit**, since it stays plugged in. Not needed, but the battery lasts longer.

Then follow [the setup guide](setup.md) and fill in [the "My tablet" form](https://github.com/mrubens/opie/issues/new?template=my-tablet.yml)
either way. A tablet that works for several people is one we'll test.

## The charge limit on each

The setup's "Two of Android's settings" step opens Android's settings; this is where the limit is.

- **Samsung (One UI 8: the Tab S10 FE and A11+):** Settings → Battery → Battery protection → **Maximum**, which stops
  charging at 80% (One UI lets some models choose 80–95%). "Basic" charges to 100% and only tops up from 95%.
- **Others:** look in Battery for "charge limit", "battery protection" or "optimized charging". Tell us the path on
  the form and we'll add it here.

## For whoever updates this list

- A model moves to **Works** only with the eight tests' results in [hardware.md](hardware.md), and the release they ran
  on and the date written in the table above.
- Add its model number to `shell/app/src/main/java/dev/openhouse/shell/Tablets.kt` at the same time, so the next
  release stops calling it untested.
- Keep the list to two or three models. No household details here (the repo's `CLAUDE.md`).

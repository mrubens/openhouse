# Laundry

Says when the wash (or the dryer) is done.

- **With a smart plug:** if the tablet knows a plug that reports its power (Settings, Devices, or a device recipe),
  pick it for the washer or dryer in Plugs and times. Laundry watches the power by itself: running once it uses more
  than a few watts for two minutes, done once it's used almost nothing for four.
- **Without one:** tap Started, or tell Opie "the washer's on" ("I started the dryer, 70 minutes"): a timer for the
  usual cycle.
- **When it's done:** a line on Home ("The wash is done (4:12)") for three hours or until Emptied, and the tablet says
  so out loud (turn that off in Plugs and times).
- **The voice:** "the washer's on", "is the laundry done?", "I emptied the dryer".

The tablet's own drivers today are for speakers, TVs, Xbox and printers: none of them is a plug, so for now this works
by timer, and starts watching as soon as a plug that reports power is added.

## What it asks for

- the home's speakers and TVs (to read a plug's power; it never turns anything on or off)
- a line of its own on Home
- speaking
- timers
- it can't reach the internet

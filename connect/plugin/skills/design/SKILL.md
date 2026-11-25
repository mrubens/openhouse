---
name: design
description: "How an OpenHouse tab or everyday app should look (color, accents, buttons, panels, type sizes, touch targets), for restyling one or checking a new one."
---

# How a tab should look

For an everyday tool (anything that could be a tab). Games and toys can be as bold as they like. Sizes are in `u`
(`var(--u)`, 1/1536 of the screen's width, as `/kit/quiet.css` sets it). The Weather tab is the one to measure against:
one focal point, one color family, nothing boxed for the sake of it.

1. One image or one hue sets the whole tab's color; no second saturated color beside it. Tabs stay in the household's
   light palette (the `--bg`, `--ink` and `--accent` the home screen hands over).
2. At most one accent, with one meaning. If it shows up more than three times, take some out.
3. One filled button per screen: the next thing to do, in the highest contrast. Everything else is `.btn.soft` or text.
4. One panel style per tab, and at most three panels in view. A list is rows with hairlines between them, not a card
   for each item.
5. Shadows only for things that float over the screen (a sheet). Never colored glows.
6. At most four text sizes on a screen. Size follows what the text is for, never how long it is.
7. Nothing read while doing something is under 20u; no label is under 15u.
8. Small capitals with tracking, if used, are one style per tab: never two stacked, never colored.
9. A pill holds up to three words on one line. Anything that could wrap is plain text.
10. Lead with the value (an amount, a time, a temperature) in the heavier weight, and its description lighter.
11. The current thing and its action never scroll out of view.
12. Photos show clean or as the backdrop, with no title across the subject.
13. Touch targets are 64u or more for things used mid-task (cooking, a timer), 46u elsewhere.
14. Before calling it done, look at it on the tablet (`look_at_tablet`, 2304x1440) with the longest real content it
    will have.
15. Squint at it next to Weather: one focal point, one color family. If what you see is boxes, start over.

Also: no colored stripe down one side of a card or row (show color with a tint, a dot or the text itself), no emoji
as icons (draw them in inline SVG), no sparkle symbols.


---

This copy of the OpenHouse guide is version 862a16609b60. If the OpenHouse connector's guide is another version (its instructions, or get_guide with topic "home", say which), use get_guide instead and tell the person once that the OpenHouse plugin needs updating.

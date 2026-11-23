# The built-in apps against a family screen

2026-11-18. What a Skylight Calendar does (from its help centre and reviews, Nov 2026), what ours did when we
started, and what they do now. We match what it does for a family, not how it looks.

Skylight's paid plan (about $79 a year) holds photos, meal planning, stars and rewards, and its AI import. Here all of
it is free and on the tablet.

## Where we're ahead

- Nothing is behind a subscription.
- An assistant on the tablet itself, by voice or typing, that changes the family's things and builds new apps.
- Routines as picture checklists that show at their own time of day.
- "Add to groceries" from a meal: the assistant writes the ingredients (from the meal's recipe when it has one),
  skipping what's on the list already.
- A reward needs a yes with the PIN, and so does setting rewards up (Skylight has no approval step).
- The whiteboard and kitchen timers.

## The comparison

**Done** is built, tested in the bridge's tests and tried on the emulator. **Open** is still to do; P is its priority
(1 most useful first).

### Calendar

| What | Skylight | Ours now | Status |
|---|---|---|---|
| Sync sources | Google, iCloud, Outlook, Yahoo, Cozi, TeamSnap, any ICS | Any private ICS link, up to 12 | Same in practice |
| Two-way sync | Google and iCloud | Read-only; events added on the tablet stay on it | Open, P3 (needs a Cloud project; parked) |
| Past events | Shown | Shown (synced events were dropped once over) | Done |
| Repeats | Via sync | Daily, weekly, monthly (the 31st skips short months, last day, last weekday, every Tuesday), yearly (Thanksgiving, Feb 29) | Done |
| Views | Day, week, month, schedule | Day (by the hour, overlaps side by side, a line at now), week, month, list | Done |
| Weather by day | In the week's headers | Each day's high, and the chance of rain when likely | Done |
| One event for two people | Shown in both colours | Pick several people; shown in each of their colours | Done |
| Colour per person | Chosen per person | One palette everywhere; each person's colour picked in Settings › Family | Done |
| Add on screen | Yes | Any day, time to the quarter hour, how long, whose, repeat and until when (incl. end of the school year), place, notes, countdown | Done |
| Edit on screen | Yes | Change any event added on the display | Done |
| Countdowns | Any event, on the screensaver | Any event, synced ones too; on Today and the idle screen | Done |
| Reminders | Per event, a tone | A usual one for every timed event (the bell in Calendar) and each event's own, synced ones too; a card over any app with a chime, put away on every screen; said aloud if wanted; quiet at night | Done |
| Details | Notes, place | Notes, place (synced events' notes too) | Done |
| PIN lock for changes | Optional | Optional (Settings): the Calendar app asks for the PIN, then changes are open for 5 minutes; the bridge enforces it | Done |

### Photos and the idle screen

| What | Skylight | Ours now | Status |
|---|---|---|---|
| Adding | Phone app, email to the device | Phone by QR code (many at once) | Email-in needs the cloud: open, P3 |
| Slideshow | When idle, captions, albums | When idle, every 10 s, from a tapped photo; a caption per photo, shown with it there and on the idle screen | Done |
| Albums | Yes | Make one from a photo or several chosen; the idle screen can show one album | Done |
| Grid | Albums | Small thumbnails, loaded as they scroll in, freed after; All photos or one album | Done |
| Idle screen content | Time, date, countdowns | Time, what's next in the coming day, countdowns, timers | Done |
| Sleep at night | Screen off on a schedule, a sleep button | Night hours in Settings, works without the Photos app, backlight dimmed; Sleep now in Settings | Done |
| Removing | – | A × on each photo, or choose several; kept 30 days and can be put back ("Taken off") | Done |

### Today

| What | Skylight | Ours now | Status |
|---|---|---|---|
| The glance | Calendar beside tasks and lists | A card per tab, each opening it: what's next and the rest of today (then tomorrow) with the nearest countdown, the weather now with the high and rain, each person's chores left (or the routine that's on), tonight's dinner, the grocery list's first items and count, notes and reminders due, a photo that changes each minute; fits the sheet without scrolling and shows only the tabs the family has | Done |
| Groceries tick | Inline | Instant, with a moment to undo | Done |

### Chores, routines and stars

| What | Skylight | Ours now | Status |
|---|---|---|---|
| Chores per person, repeating | By date or after done | By weekday, or every 2 days to a month (from a day, or after it's last done); one can stay up until done, showing how late | Done |
| A picture per chore | Yes | Guessed from the words, or picked | Done |
| Done today, per person | Yes | "1 of 2 today" on each column | Done |
| Edit a chore | Yes | Task, whose (or anyone's), days, stars | Done |
| Skip | Yes | Skip today: not left to do, no stars | Done |
| "Anyone can do it" | Credit whoever did it | Asks who did it; the stars are theirs | Done |
| Stars per chore | Any number | 1, 2, 3 or 5 (the assistant can set up to 10) | Done |
| Rewards | Redeem when enough stars | Same, with the PIN yes | – |
| Kids approving their own reward | – | Needs the PIN, and so does adding rewards (was a hole) | Done |
| Weekly totals | Habit tracking | "N done this week" and "N days in a row" on each column | Done |

### Lists

| What | Skylight | Ours now | Status |
|---|---|---|---|
| Several lists | Yes | Add, rename, delete (asks first); type right on a list to add | Done |
| Edit an item | Yes | Its words and whose it is, from its … button | Done |
| Sections (aisles) | AI sorts | Groceries by store section (on the display, no AI needed); any list can switch | Done |
| On a phone at the shop | Live, through the app | By QR: live on the home Wi-Fi (ticks and new items both ways, for 3 hours); at the shop the page keeps working and what's ticked there goes to the display back home | Done; live away from home too when Cloud → Use it away from home is on ([networking.md](networking.md)) |

### Meals

| What | Skylight | Ours now | Status |
|---|---|---|---|
| Plan | Up to 4 meals a day | Dinner, and breakfast and lunch when wanted | Done |
| Recipes | Recipe box: URL, photo, voice | A recipe per meal: a link, notes, a photo the assistant types up, or the assistant writes it; shown every day that meal is planned | Done |
| Cooking | – | The Recipes app (docs/recipes.md): each recipe made into steps once, one step at a time in big type, Opie moves it ("next", "how much cumin?"), timers from the steps, the recipe's video beside it; Cook from a meal | Done |
| Ingredients to the list | Yes | Yes, by the assistant | – |
| AI week plan | Yes | Ask the assistant | – |

### The assistant (Skylight's AI import)

| What | Skylight | Ours now | Status |
|---|---|---|---|
| Add events, lists, meals by voice | Through Alexa | Yes, on the tablet | – |
| See synced events | – | The next two weeks of everything | Done |
| Edit an event, a chore, an item, a recipe | – | Yes | Done |
| A flyer or school email to events | Email or photo in the phone app | A photo from a phone (Calendar's camera button, by QR): the assistant reads its dates, and the family ticks which to add and whose | Photo: done (email-in needs the cloud: open, P3) |

### Quality

| What | Before | Now | Status |
|---|---|---|---|
| Touch targets | Some buttons 30–45 px | At least 48 px in the kit's controls | Done |
| Keyboard | Buttons ignored Enter and Space | Every tappable answers them; typing in a field goes to the field, not the assistant | Done |
| Hidden gestures | Removing was "hold" only | A visible … or × as well | Done |
| Speed | Every change re-read the photos folder and re-expanded repeats | Both cached | Done |

## What's left, in order

1. **Needs the cloud or a decision first:** two-way Google/iCloud sync (parked: needs their Cloud project), email-in.

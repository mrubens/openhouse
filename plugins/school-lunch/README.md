# School lunch

Each kid's school lunch menu for the week, for schools that post their menus on Nutrislice (many US districts do).

- **Set up:** open School lunch, tap Set up, and give each kid's name and their menu link from Nutrislice (open the
  menu there and copy the address, for example `https://springfield.nutrislice.com/menu/maple/lunch`). Kids at the same
  school share a row.
- **The page:** this week's and next week's lunches, today marked, the main dishes with their photos. Dishes that are there every day are listed once,
  under the week.
- **Today:** on school days, the Lunch card has the day's main dish and the other choice, each with Nutrislice's photo
  of it where there is one (a dish without one is just its name). Nothing on days with no menu.
- **The calendar:** each school day's lunch is a note on that day ("Lunch · Popcorn Chicken or Vegan Chic'n
  Nuggets"), not an event: on Home's calendar card, and on the Calendar's week if the household chooses (Calendar,
  From apps).
- **The voice:** "what's for lunch tomorrow?", "what's Maya having on Tuesday?", "what are the lunches this week?".

The menus come from Nutrislice's public menu API (`<district>.api.nutrislice.com`), through the tablet: this week and
next, once a day and whenever the app is opened. The last ones are kept, so it works without the internet. Nothing
about the household is sent: each address has only the district, the school and the date.

## What it asks for

- the family's names (to pick each kid)
- a line of its own on Home
- notes of its own on the calendar's days
- reaching `*.api.nutrislice.com`, and `client-food-images.nutrislice.com` for the dishes' photos

## Adding it

Ask the assistant to "add the plugin from github.com/mrubens/opie/tree/main/plugins/school-lunch", or paste that
link in Settings, Plugins, Add from a link.

It runs quietly in the background ("background": true), so each school day's lunch is on the calendar and today's on
Today without a tab of its own.

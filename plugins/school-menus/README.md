# School food

Each kid's school menu for the week, for any school district that posts its menus on Nutrislice (many US districts
do): lunch, and breakfast where the school has it. The shareable version of School lunch, with its own name, so a
household that has School lunch can have both while it moves over.

- **Set up:** open School food, tap Set up, pick each kid, then either paste their menu link from Nutrislice or tap
  **Find the school instead**: type the district as Nutrislice names it (the first part of its address:
  `springfield` for springfield.nutrislice.com), pick the school, then the menu (Lunch, Breakfast...). Kids at the same
  school share a row; a kid can have a lunch row and a breakfast row.
- **The page:** this week's and next week's menus, today marked, the main dishes with their photos. Dishes that are
  there every day are listed once.
- **Today:** the day's main dish and the other choice on the Lunch card, each with its photo where Nutrislice has one.
- **The calendar:** each school day's menu is a note on that day ("Lunch · Popcorn Chicken or Vegan Chic'n Nuggets"):
  on Home's calendar card, and on the Calendar's week if the household chooses (Calendar, From apps).
- **The voice:** "what's for lunch tomorrow?", "what's Sam having for breakfast on Tuesday?", "what are the lunches
  this week?".

The menus come from Nutrislice's public menu API (`<district>.api.nutrislice.com`), through the tablet, once a day and
whenever the app is opened. Nothing about the household is sent: each address has only the district, the school, the
menu and the date.

## What it asks for

- the family's names (to pick each kid)
- a line of its own on Home
- notes of its own on the calendar's days
- reaching `*.api.nutrislice.com`, and `client-food-images.nutrislice.com` for the dishes' photos

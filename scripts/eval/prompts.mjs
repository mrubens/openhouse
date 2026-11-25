// The eval's 15 requests, as someone in the sample household (Sam, Alex, Maya, Leo in Springfield) would say them.
// kind: game (a new game in Apps), tab (a new everyday app), edit (a change to one of OpenHouse's own apps).
// app: the app an edit should land in (for the check); event: an edit that is really the household's data.
export const PROMPTS = [
  { id: 'dino-catch', kind: 'game', who: 'Leo', text: 'Make me a dinosaur game: a dinosaur walks along the bottom and I move it left and right to catch falling eggs. Points for each egg, and it gets faster.' },
  { id: 'maze', kind: 'game', who: 'Maya', text: 'Make a simple maze game: I drag or use arrows to move a dot from the start to the star. A new maze each time I win.' },
  { id: 'memory', kind: 'game', who: 'Maya', text: 'A memory match game with cards I flip two at a time to find pairs of animals. Count my moves.' },
  { id: 'mole', kind: 'game', who: 'Leo', text: 'A tap-the-mole game: moles pop up out of holes and I tap them before they hide. 30 seconds, then show my score.' },
  { id: 'platformer', kind: 'game', who: 'Leo', text: 'A one-screen platformer: a little hero runs and jumps between platforms to reach a flag. Buttons on the screen for left, right and jump.' },
  { id: 'soccer', kind: 'tab', who: 'Alex', text: 'A countdown to the start of soccer season on March 14, with how many days and weeks are left and a soccer ball picture.' },
  { id: 'snacks', kind: 'tab', who: 'Sam', text: "A snack rotation for Saturday soccer: each Saturday whose turn it is to bring snacks, rotating through the Garcias, the Lees, us and the Patels. Show this Saturday and the next few." },
  { id: 'babysitter', kind: 'tab', who: 'Sam', text: 'A babysitter info board: bedtimes for Maya (8:00) and Leo (7:30), allergies (Leo: peanuts), our phone numbers, the Wi-Fi password is on the card in the kitchen drawer, and the pediatrician. We should be able to edit it.' },
  { id: 'reading', kind: 'tab', who: 'Alex', text: 'A reading streak tracker for Maya and Leo: each kid taps when they read today, it shows their streak of days in a row and the best streak.' },
  { id: 'thanksgiving', kind: 'tab', who: 'Sam', text: "A Thanksgiving hosting checklist we can tick off: grouped into the week before, the day before, and the day of, with things like order the turkey, set the table, and pie. Let us add our own items." },
  { id: 'chores-bigger', kind: 'edit', app: 'chores', who: 'Alex', text: 'Make the text on Chores bigger, it is hard to read from across the room.' },
  { id: 'lists-quantity', kind: 'edit', app: 'lists', who: 'Sam', text: 'In Lists, let us put a quantity on each item, like 2 for milk, and show it next to the item.' },
  { id: 'whiteboard-yellow', kind: 'edit', app: 'whiteboard', who: 'Maya', text: 'Make the Whiteboard paper light yellow instead of white.' },
  { id: 'grandma-countdown', kind: 'edit', event: true, who: 'Sam', text: "Add Grandma's birthday as a countdown: it's on December 19." },
  { id: 'meals-halloween', kind: 'edit', app: 'meals', who: 'Maya', text: 'Give the Meals tab a Halloween look: orange and purple, with a few bats or pumpkins.' },
];

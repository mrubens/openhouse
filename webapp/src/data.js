// Fake household data. Dates are relative to today so the screen always looks current.
export const family = [
  { name: 'Alex', color: '#e76f51' },
  { name: 'Sam', color: '#2a9d8f' },
  { name: 'Maya', color: '#e9c46a' },
  { name: 'Leo', color: '#8ab17d' },
];

function day(offset, h, m = 0) {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
}

export const events = [
  { who: 'Maya', title: 'Swim practice', start: day(0, 16, 30), end: day(0, 17, 30) },
  { who: 'Alex', title: 'Dentist', start: day(0, 9, 15), end: day(0, 10) },
  { who: 'Leo', title: 'Soccer', start: day(1, 17), end: day(1, 18) },
  { who: 'Sam', title: 'Book club', start: day(1, 19, 30), end: day(1, 21) },
  { who: 'Maya', title: 'Piano lesson', start: day(2, 15, 45), end: day(2, 16, 30) },
  { who: 'Alex', title: 'Team dinner', start: day(3, 18, 30), end: day(3, 21) },
  { who: 'Leo', title: 'Field trip', start: day(4, 8, 30), end: day(4, 14) },
  { who: 'Sam', title: 'Farmers market', start: day(5, 9), end: day(5, 11) },
  { who: 'Maya', title: 'Sleepover at Ava’s', start: day(5, 18), end: day(6, 10) },
  { who: 'Leo', title: 'Grandma visit', start: day(6, 12), end: day(6, 16) },
];

export const chores = [
  { who: 'Maya', task: 'Feed the cat' },
  { who: 'Leo', task: 'Unload dishwasher' },
  { who: 'Maya', task: 'Practice piano 20 min' },
  { who: 'Leo', task: 'Tidy bedroom' },
  { who: 'Sam', task: 'Recycling out' },
  { who: 'Alex', task: 'Water plants' },
];

export const photos = [
  { caption: 'Beach day', colors: ['#f4a261', '#2a9d8f'] },
  { caption: 'Leo’s first goal', colors: ['#8ab17d', '#264653'] },
  { caption: 'Maya’s recital', colors: ['#e9c46a', '#e76f51'] },
  { caption: 'Camping trip', colors: ['#264653', '#e9c46a'] },
];

export const colorOf = (name) => family.find((f) => f.name === name)?.color ?? '#999';

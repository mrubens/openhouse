// The questions: for a family with kids about 6 and up, four choices each, the right one first (the game mixes them).
export const QUESTIONS = [
  ['How many legs does a spider have?', '8', '6', '10', '12'],
  ['What is the largest planet in our solar system?', 'Jupiter', 'Saturn', 'Earth', 'Neptune'],
  ['Which animal is known as the King of the Jungle?', 'Lion', 'Tiger', 'Elephant', 'Gorilla'],
  ['What color do you get when you mix blue and yellow?', 'Green', 'Purple', 'Orange', 'Brown'],
  ['How many days are in a leap year?', '366', '365', '364', '360'],
  ['What do bees make?', 'Honey', 'Milk', 'Silk', 'Wax paper'],
  ['Which is the longest river in the United States?', 'The Missouri', 'The Hudson', 'The Colorado', 'The Ohio'],
  ['What is frozen water called?', 'Ice', 'Steam', 'Fog', 'Dew'],
  ['How many continents are there?', '7', '5', '6', '9'],
  ['How many sides does a stop sign have?', '8', '6', '4', '10'],
  ['What is the capital of France?', 'Paris', 'London', 'Rome', 'Madrid'],
  ['What gas do plants take in from the air?', 'Carbon dioxide', 'Oxygen', 'Helium', 'Nitrogen'],
  ['Which planet is known as the Red Planet?', 'Mars', 'Venus', 'Mercury', 'Jupiter'],
  ['How many sides does a hexagon have?', '6', '5', '8', '7'],
  ['What is the fastest land animal?', 'Cheetah', 'Horse', 'Lion', 'Greyhound'],
  ['Who wrote “Charlotte’s Web”?', 'E. B. White', 'Roald Dahl', 'Dr. Seuss', 'Beverly Cleary'],
  ['What do caterpillars turn into?', 'Butterflies or moths', 'Beetles', 'Bees', 'Dragonflies'],
  ['Which ocean is the biggest?', 'The Pacific', 'The Atlantic', 'The Indian', 'The Arctic'],
  ['How many minutes are in an hour?', '60', '100', '30', '45'],
  ['What is the tallest kind of animal?', 'Giraffe', 'Elephant', 'Ostrich', 'Moose'],
  ['What is the closest star to Earth?', 'The Sun', 'Polaris', 'Sirius', 'Alpha Centauri'],
  ['Which bird is a symbol of the United States?', 'The bald eagle', 'The robin', 'The turkey', 'The cardinal'],
  ['How many strings does a standard violin have?', '4', '6', '5', '3'],
  ['What is the hardest natural material?', 'Diamond', 'Gold', 'Iron', 'Granite'],
  ['Which is the smallest planet?', 'Mercury', 'Mars', 'Venus', 'Pluto'],
  ['What is a baby kangaroo called?', 'A joey', 'A kit', 'A cub', 'A pup'],
  ['How many players are on a soccer team on the field?', '11', '9', '10', '12'],
  ['Which shape has three sides?', 'Triangle', 'Square', 'Circle', 'Pentagon'],
  ['What part of the plant is under the ground?', 'The roots', 'The petals', 'The leaves', 'The stem'],
  ['What do you call a word that means the opposite of another word?', 'An antonym', 'A synonym', 'A verb', 'A rhyme'],
  ['How many hearts does an octopus have?', '3', '1', '2', '8'],
  ['Which country gave the Statue of Liberty to the United States?', 'France', 'England', 'Spain', 'Italy'],
  ['What is 7 times 8?', '56', '54', '48', '64'],
  ['Which animal sleeps standing up?', 'Horse', 'Dog', 'Cat', 'Rabbit'],
  ['What is the main language spoken in Brazil?', 'Portuguese', 'Spanish', 'English', 'French'],
  ['Which planet has the most famous rings?', 'Saturn', 'Uranus', 'Mars', 'Earth'],
  ['What is the name of the Toy Story cowboy?', 'Woody', 'Buzz', 'Jessie', 'Andy'],
  ['How many teeth does a grown-up usually have?', '32', '20', '28', '40'],
  ['What is the biggest mammal?', 'The blue whale', 'The elephant', 'The giraffe', 'The hippo'],
  ['Which month has the fewest days?', 'February', 'April', 'June', 'November'],
  ['What do you call molten rock that comes out of a volcano?', 'Lava', 'Magma bread', 'Ash', 'Coal'],
  ['How many colors are in a rainbow?', '7', '5', '6', '8'],
  ['Which is a mammal?', 'Dolphin', 'Shark', 'Trout', 'Octopus'],
  ['What is the name of the young wizard who goes to Hogwarts?', 'Harry Potter', 'Percy Jackson', 'Frodo', 'Peter Pan'],
  ['What is the freezing point of water in Fahrenheit?', '32 degrees', '0 degrees', '100 degrees', '50 degrees'],
  ['What is the capital of the United States?', 'Washington, D.C.', 'New York City', 'Philadelphia', 'Boston'],
  ['Which animal is a marsupial?', 'Koala', 'Panda', 'Raccoon', 'Sloth'],
  ['How many wheels does a tricycle have?', '3', '2', '4', '1'],
  ['What is the opposite of north?', 'South', 'East', 'West', 'Up'],
  ['Which fruit is dried to make raisins?', 'Grapes', 'Plums', 'Cherries', 'Figs'],
  ['What do pandas mostly eat?', 'Bamboo', 'Fish', 'Berries', 'Grass'],
  ['What is the largest desert in the world?', 'Antarctica', 'The Sahara', 'The Gobi', 'The Mojave'],
  ['How many years are in a century?', '100', '10', '1000', '50'],
  ['What is the name of our galaxy?', 'The Milky Way', 'Andromeda', 'The Big Dipper', 'Orion'],
  ['Which instrument has 88 keys?', 'Piano', 'Guitar', 'Trumpet', 'Drum'],
  ['What is a group of wolves called?', 'A pack', 'A herd', 'A flock', 'A school'],
  ['Which is not a primary color for paint?', 'Green', 'Red', 'Blue', 'Yellow'],
  ['What is 100 minus 37?', '63', '73', '67', '53'],
  ['Where do penguins mostly live?', 'The Southern Hemisphere', 'The North Pole', 'The Sahara', 'The Amazon'],
  ['What is the largest bone in your body?', 'The thigh bone', 'The skull', 'The spine', 'The arm bone'],
];
export const LETTERS = ['A', 'B', 'C', 'D'];

/** A game's questions: n of them, each with its choices mixed: [{q, choices, right: 0-3}]. */
export function deal(n, seed = Date.now()) {
  let s = seed >>> 0 || 1;
  const rnd = (k) => { s = (s * 1103515245 + 12345) >>> 0; return s % k; };
  const idx = QUESTIONS.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = rnd(i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.slice(0, n).map((i) => {
    const [q, ...opts] = QUESTIONS[i], order = [0, 1, 2, 3];
    for (let k = 3; k > 0; k--) { const j = rnd(k + 1); [order[k], order[j]] = [order[j], order[k]]; }
    return { q, choices: order.map((o) => opts[o]), right: order.indexOf(0) };
  });
}

// The puzzles: a word a day for kids about 6 to 10, its clue, and what kind of thing it is (the first hint). The day
// picks one (a different order each year), so the whole household gets the same puzzle.
export const WORDS = [
  ['planet', 'It goes around a star, like Earth does.', 'something in space'],
  ['penguin', 'A bird that can’t fly but swims very well.', 'an animal'],
  ['volcano', 'A mountain that can blow out hot melted rock.', 'a place in nature'],
  ['library', 'A place where you can borrow books for free.', 'a place in town'],
  ['rainbow', 'Colors in the sky after the rain.', 'something in the sky'],
  ['pumpkin', 'A big orange vegetable people carve in October.', 'a food'],
  ['blanket', 'You pull it over you to stay warm in bed.', 'a thing at home'],
  ['octopus', 'A sea animal with eight arms.', 'an animal'],
  ['thunder', 'The loud boom you hear in a storm.', 'weather'],
  ['bicycle', 'Two wheels, pedals and a bell.', 'a way to get around'],
  ['giraffe', 'The tallest animal, with a very long neck.', 'an animal'],
  ['pancake', 'Flat and round, for breakfast, with syrup.', 'a food'],
  ['compass', 'It always points north.', 'a tool'],
  ['dolphin', 'A smart sea animal that clicks and whistles.', 'an animal'],
  ['lantern', 'A light you can carry.', 'a thing'],
  ['snowman', 'You build him in winter with three big balls.', 'something you make'],
  ['teacher', 'The grown-up who helps your class learn.', 'a person'],
  ['blossom', 'A flower on a tree in spring.', 'a plant'],
  ['dragon', 'A make-believe animal that breathes fire.', 'a story creature'],
  ['puzzle', 'Lots of pieces that fit together into a picture.', 'a game'],
  ['castle', 'A big stone home for kings and queens.', 'a building'],
  ['kitten', 'A baby cat.', 'an animal'],
  ['mitten', 'It keeps your hand warm, with one spot for all four fingers.', 'clothing'],
  ['rocket', 'It blasts off into space.', 'a way to get around'],
  ['island', 'Land with water all around it.', 'a place in nature'],
  ['pencil', 'You write with it and can erase what you wrote.', 'a school thing'],
  ['garden', 'Where flowers and vegetables grow.', 'a place outside'],
  ['marble', 'A small glass ball you can roll and play with.', 'a toy'],
  ['tiger', 'A big cat with orange fur and black stripes.', 'an animal'],
  ['cactus', 'A prickly plant that lives in the desert.', 'a plant'],
  ['shadow', 'The dark shape that follows you on a sunny day.', 'something you see'],
  ['jacket', 'A coat you zip up when it’s chilly.', 'clothing'],
  ['robot', 'A machine that can move and do jobs.', 'a machine'],
  ['spider', 'It has eight legs and spins a web.', 'an animal'],
  ['bridge', 'It helps you cross over a river.', 'a building'],
  ['cookie', 'A sweet, round treat, sometimes with chocolate chips.', 'a food'],
  ['turtle', 'It carries its house on its back.', 'an animal'],
  ['helmet', 'You wear it on your head to stay safe on a bike.', 'clothing'],
  ['forest', 'Lots and lots of trees together.', 'a place in nature'],
  ['window', 'Glass in a wall that lets light in.', 'part of a house'],
  ['squirrel', 'It has a fluffy tail and hides nuts for winter.', 'an animal'],
  ['backpack', 'You carry your books to school in it.', 'a school thing'],
  ['dinosaur', 'A giant animal that lived long, long ago.', 'an animal'],
  ['umbrella', 'It keeps you dry in the rain.', 'a thing'],
  ['elephant', 'A huge gray animal with a trunk.', 'an animal'],
  ['sandwich', 'Two slices of bread with something in between.', 'a food'],
  ['treasure', 'Gold and jewels, maybe in a chest.', 'something pirates want'],
  ['airplane', 'It flies people across the sky.', 'a way to get around'],
  ['mountain', 'A very tall hill.', 'a place in nature'],
  ['birthday', 'The day you were born, with cake every year.', 'a special day'],
  ['butterfly', 'It starts as a caterpillar and gets bright wings.', 'an animal'],
  ['snowflake', 'A tiny piece of frozen ice that falls in winter.', 'weather'],
  ['telescope', 'You look through it to see faraway stars.', 'a tool'],
  ['hamburger', 'A round patty in a bun.', 'a food'],
  ['crocodile', 'A big reptile with lots of sharp teeth.', 'an animal'],
  ['astronaut', 'A person who travels into space.', 'a person'],
  ['moon', 'It lights up the night sky and changes shape.', 'something in space'],
  ['cloud', 'White and fluffy, floating in the sky.', 'something in the sky'],
  ['apple', 'A red or green fruit that crunches.', 'a food'],
  ['whale', 'The biggest animal in the ocean.', 'an animal'],
  ['candle', 'It has a wick and a little flame.', 'a thing'],
  ['pirate', 'A sailor who looks for treasure.', 'a person'],
  ['zebra', 'A horse-like animal with black and white stripes.', 'an animal'],
  ['music', 'Songs and sounds you listen to.', 'something you hear'],
  ['ocean', 'Huge and salty, full of fish.', 'a place in nature'],
  ['banana', 'A yellow fruit you peel.', 'a food'],
  ['camera', 'It takes pictures.', 'a tool'],
  ['wizard', 'Someone in a story who can do magic.', 'a story person'],
  ['acorn', 'A little nut that grows into an oak tree.', 'a plant'],
  ['hammock', 'A swinging bed hung between two trees.', 'a thing'],
  ['popcorn', 'A snack that pops when you heat it.', 'a food'],
  ['picnic', 'A meal you eat outside on a blanket.', 'something you do'],
  ['tornado', 'A spinning storm shaped like a funnel.', 'weather'],
  ['owl', 'A bird that stays up at night and says hoo.', 'an animal'],
  ['igloo', 'A house made of snow blocks.', 'a building'],
  ['skeleton', 'All the bones inside you.', 'part of your body'],
  ['scissors', 'You cut paper with them.', 'a school thing'],
  ['football', 'A ball game with a touchdown.', 'a sport'],
  ['keyboard', 'You type on it.', 'a machine'],
  ['firework', 'It bursts into colors in the night sky.', 'something you see'],
];

/** The puzzle for a day (YYYY-MM-DD): {word, clue, kind, letters}. */
export function puzzleFor(day) {
  const [y, m, d] = day.split('-').map(Number);
  const n = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 864e5);
  const order = shuffle(WORDS.map((_, i) => i), y);
  const [word, clue, kind] = WORDS[order[n % WORDS.length]];
  let letters = shuffle(word.split(''), y * 1000 + n);
  if (letters.join('') === word) letters = letters.reverse();
  return { word, clue, kind, letters };
}
function shuffle(a, seed) {
  a = [...a]; let s = seed >>> 0 || 1;
  for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

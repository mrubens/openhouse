// NAME: the game, on the engine (game.js: read its top for what it offers). This starting point is a box that moves
// with the arrows and the buttons; replace it with the game.
import { start, add, button, keys, keepIn, text, W, H } from './game.js';

let player, left, right, score = 0;
start({
  background: '#1d3557',
  setup() {
    score = 0;
    add({ x: W / 2, y: H - 40, w: W, h: 80, color: '#a8dadc', solid: true, tag: 'ground' });
    player = add({ x: W / 2, y: H - 300, w: 90, h: 90, color: '#f4a261', gravity: 2400 });
    left = button({ x: 160, y: H - 140, label: '‹' });
    right = button({ x: 400, y: H - 140, label: '›' });
  },
  update(dt) {
    const dir = (right.down || keys.has('ArrowRight') ? 1 : 0) - (left.down || keys.has('ArrowLeft') ? 1 : 0);
    player.vx = dir * 700;
    keepIn(player);
  },
  draw(ctx) { text(ctx, `Score ${score}`, 60, 70, { align: 'left', size: 56 }); },
});

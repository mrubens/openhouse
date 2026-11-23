// Screen layout: which widgets appear and in which grid area.
// Grid areas are defined in style.css (.screen).
import { mountAll } from './lifecycle.js';
import * as header from './widgets/header.js';
import * as calendar from './widgets/calendar.js';
import * as chores from './widgets/chores.js';
import * as photos from './widgets/photos.js';
import * as bus from './widgets/bus.js';
import * as recipe from './widgets/recipe.js';

export function render(root) {
  root.className = 'screen';
  mountAll(root, [
    { area: 'header', mount: header.mount },
    { area: 'calendar', mount: calendar.mount },
    { area: 'bus', mount: bus.mount },
    { area: 'chores', mount: chores.mount },
    { area: 'photos', mount: photos.mount },
    { area: 'recipe', mount: recipe.mount },
  ]);
}

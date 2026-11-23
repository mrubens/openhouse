import { photos } from '../data.js';
import { every } from '../lifecycle.js';

export function mount(el) {
  el.innerHTML = `<div class="photo"><div class="caption"></div></div>`;
  const photo = el.querySelector('.photo');
  const caption = el.querySelector('.caption');
  let i = 0;
  return every(8000, () => {
    const p = photos[i++ % photos.length];
    photo.style.background = `linear-gradient(135deg, ${p.colors[0]}, ${p.colors[1]})`;
    caption.textContent = p.caption;
  });
}

import { every } from '../lifecycle.js';

export function mount(el) {
  el.innerHTML = `<div class="clock"></div><div class="date"></div><div class="weather">☀️ 18° Sunny</div>`;
  const clock = el.querySelector('.clock');
  const date = el.querySelector('.date');
  return every(1000, () => {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    date.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  });
}

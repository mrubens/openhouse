// School bus countdown. Turns red from RED_AT until the bus leaves.
import { every } from '../lifecycle.js';

const BUS = { h: 7, m: 50 }; // guessed pickup time
const RED_AT = { h: 7, m: 40 };

function nextBus(now) {
  const d = new Date(now);
  d.setHours(BUS.h, BUS.m, 0, 0);
  while (d <= now || d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
    d.setHours(BUS.h, BUS.m, 0, 0);
  }
  return d;
}

function fmt(ms) {
  const mins = Math.ceil(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m} min`;
}

export function mount(el) {
  el.innerHTML = `<h2>🚌 School bus</h2><div class="bus-time"></div><div class="bus-when"></div>`;
  const time = el.querySelector('.bus-time');
  const when = el.querySelector('.bus-when');
  return every(15000, () => {
    const now = new Date();
    const bus = nextBus(now);
    const red = new Date(bus);
    red.setHours(RED_AT.h, RED_AT.m, 0, 0);
    el.classList.toggle('bus-late', now >= red);
    time.textContent = fmt(bus - now);
    when.textContent = bus.toLocaleDateString([], { weekday: 'long' }) + ' ' +
      bus.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  });
}

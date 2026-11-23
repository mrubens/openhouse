import { events, colorOf } from '../data.js';

const fmt = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function mount(el) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    return d;
  });
  el.innerHTML = `<h2>This week</h2><div class="week"></div>`;
  const week = el.querySelector('.week');
  for (const d of days) {
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    const items = events
      .filter((e) => e.start >= d && e.start < next)
      .sort((a, b) => a.start - b.start);
    const col = document.createElement('div');
    col.className = 'day' + (d.getTime() === today.getTime() ? ' today' : '');
    col.innerHTML =
      `<div class="day-name">${d.toLocaleDateString([], { weekday: 'short' })} <span>${d.getDate()}</span></div>` +
      items
        .map(
          (e) => `<div class="event" style="--c:${colorOf(e.who)}">
            <div class="event-time">${fmt(e.start)}</div>
            <div class="event-title">${e.title}</div>
            <div class="event-who">${e.who}</div></div>`
        )
        .join('');
    week.appendChild(col);
  }
}

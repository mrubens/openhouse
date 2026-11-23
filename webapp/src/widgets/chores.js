import { chores, colorOf } from '../data.js';

const KEY = 'chores-done-' + new Date().toDateString();

export function mount(el) {
  let done;
  try { done = new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { done = new Set(); }
  el.innerHTML = `<h2>Chores</h2><ul class="chores"></ul>`;
  const ul = el.querySelector('ul');
  chores.forEach((c, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--c', colorOf(c.who));
    li.className = done.has(i) ? 'done' : '';
    li.innerHTML = `<span class="check"></span><span class="task">${c.task}</span><span class="who">${c.who}</span>`;
    li.onclick = () => {
      done.has(i) ? done.delete(i) : done.add(i);
      li.classList.toggle('done');
      try { localStorage.setItem(KEY, JSON.stringify([...done])); } catch {}
    };
    ul.appendChild(li);
  });
}

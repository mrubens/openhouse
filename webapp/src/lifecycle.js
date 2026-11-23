// Widgets return a cleanup function from mount(); render() runs them before
// re-rendering so timers don't pile up across hot updates.
const cleanups = (window.__cleanups ||= []);

export function mountAll(root, widgets) {
  while (cleanups.length) {
    try { cleanups.pop()(); } catch (e) { console.error(e); }
  }
  root.innerHTML = '';
  for (const { area, mount } of widgets) {
    const el = document.createElement('section');
    el.className = `card area-${area}`;
    root.appendChild(el);
    try {
      const c = mount(el);
      if (typeof c === 'function') cleanups.push(c);
    } catch (e) {
      console.error(e);
      el.textContent = 'Widget failed: ' + e.message;
    }
  }
}

export function every(ms, fn) {
  fn();
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
}

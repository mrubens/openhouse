// The moon as it looks, as a small drawing (the page and its card).
/** The moon as it looks: a lit part and a dark part, drawn with two arcs. */
export function moonPic(m, cls) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '-50 -50 100 100'); svg.setAttribute('class', cls);
  const k = Math.cos(2 * Math.PI * m.age / 29.530588853); // 1 new, -1 full
  const rx = Math.abs(k) * 46, lit = 'color-mix(in srgb, #fff 80%, var(--bg))', dark = 'color-mix(in srgb, var(--ink) 55%, var(--bg))';
  const right = m.waxing; // in the north the lit side grows from the right
  const half = `M0 -46 A46 46 0 0 ${right ? 1 : 0} 0 46`;
  const term = `A${rx} 46 0 0 ${(k > 0) === right ? 0 : 1} 0 -46`;
  svg.innerHTML = `<circle r="46" fill="${dark}"/><path d="${half} ${term} Z" fill="${lit}"/><circle r="46" fill="none" stroke="color-mix(in srgb, var(--ink) 30%, transparent)" stroke-width="2"/>`;
  return svg;
}

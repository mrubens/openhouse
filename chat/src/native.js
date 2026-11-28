// What makes the phone page feel like a phone's own app rather than a web page (docs/iphone-app.md): a tap's buzz in the
// iPhone app, sheets that keep to the part of the screen the keyboard leaves, and the keyboard going away when a list is
// scrolled. Plain functions, so the tablet's pages can call haptic() too (it does nothing there).

/** A light tap of the phone's own (the iPhone app's haptic hook, WebPage.swift): when something is ticked, added or done.
 *  Nothing anywhere else. */
export function haptic(kind = 'light') {
  try { window.webkit?.messageHandlers?.haptic?.postMessage(kind); } catch {}
}

/** Once, on the phone page. */
export function feelNative() {
  const root = document.documentElement.style, vv = window.visualViewport;
  // The part of the screen that shows (--vvt, --vvh) and the keyboard's height (--kb): sheets keep to it (phone.css), so
  // a field and its button stay above the keyboard however the page under it moved.
  if (vv) {
    // (the keyboard's height: how much shorter what shows is than with no keyboard, the tallest seen at this width; the
    // page's own height doesn't change with it in the iPhone app)
    let full = 0, wide = 0;
    const fit = () => {
      if (innerWidth !== wide) { wide = innerWidth; full = 0; }
      full = Math.max(full, vv.height);
      root.setProperty('--vvt', `${Math.max(0, vv.offsetTop)}px`);
      root.setProperty('--vvh', `${vv.height}px`);
      root.setProperty('--kb', `${Math.max(0, Math.round(full - vv.height))}px`);
    };
    vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
  }
  // A touch listener is what lets an iPhone show :active on a tap (phone.css's pressed looks).
  let from = null;
  document.addEventListener('touchstart', (e) => { const t = e.touches[0]; from = t && { x: t.clientX, y: t.clientY }; }, { passive: true, capture: true });
  // Scrolling (a list, a sheet, the page) puts the keyboard away, as an app's own lists do; a tap doesn't.
  document.addEventListener('touchmove', (e) => {
    const a = document.activeElement, t = e.touches[0];
    if (!from || !t || !a || !/^(INPUT|TEXTAREA)$/.test(a.tagName) || a.contains(e.target)) return;
    if (Math.abs(t.clientY - from.y) > 14) { a.blur(); from = null; }
  }, { passive: true, capture: true });
}

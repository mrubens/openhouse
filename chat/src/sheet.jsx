// A sheet over the page: the veil, with the sheet as its first child. Only a tap that began on the veil closes it (on an
// iPhone a tap on a button first closes the keyboard, the sheet moves, and the tap would land on the veil). Where the
// page's CSS makes it a phone's sheet (--sheet: up on the sheet: phone.css, phone-today.css) it slides up, follows a
// finger down and closes when let go far enough or fast, and slides away when closed; elsewhere (the tablet) it closes
// at once. children may be a function of close, for its own Done or Cancel (so they slide it away too).
import { useEffect, useRef } from 'react';

const still = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const slides = (s) => !!s && getComputedStyle(s).getPropertyValue('--sheet').trim() === 'up';
const OUT = 'cubic-bezier(.4, 0, 1, 1)';
let open = 0; // (sheets open: the page under them doesn't scroll while there are any)

/** The element a touch at t would scroll vertically, inside the sheet s, if any. */
function scroller(t, s) {
  for (let e = t; e && e !== s.parentElement; e = e.parentElement) {
    if (e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(e).overflowY)) return e;
  }
  return null;
}

export function Veil({ className, style, onClose, children }) {
  const ref = useRef(null), done = useRef(onClose), down = useRef(false), shut = useRef(() => onClose());
  done.current = onClose;
  useEffect(() => {
    const v = ref.current, s = v?.firstElementChild;
    if (!v || !s) return;
    let gone = false, drag = null;
    const close = (from = 0) => {
      if (gone) return;
      gone = true;
      if (!slides(s) || still()) return done.current();
      const ms = 220, a = s.animate([{ transform: `translateY(${from}px)` }, { transform: `translateY(${s.offsetHeight + 40}px)` }], { duration: ms, easing: OUT, fill: 'forwards' });
      v.animate([{ backgroundColor: getComputedStyle(v).backgroundColor }, { backgroundColor: 'rgba(0,0,0,0)' }], { duration: ms, fill: 'forwards' });
      a.finished.then(() => done.current(), () => done.current());
    };
    shut.current = close;
    if (!open++) document.documentElement.classList.add('sheet-open');
    const y0 = scrollY;

    const start = (e) => {
      const t = e.touches[0];
      drag = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY, dy: 0, on: null, sc: s.contains(e.target) ? scroller(e.target, s) : null, inSheet: s.contains(e.target), t: e.timeStamp, ly: t.clientY, lt: e.timeStamp, vel: 0 } : null;
    };
    const move = (e) => {
      const t = e.touches[0];
      if (!drag || !t) return;
      // The veil itself: the page under it stays still.
      if (!drag.inSheet) { if (e.cancelable) e.preventDefault(); return; }
      const dx = t.clientX - drag.x, dy = t.clientY - drag.y;
      if (drag.on === null) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        // Down, from the top of what it scrolls (or where nothing scrolls): the sheet follows. Otherwise it scrolls as it would.
        drag.on = slides(s) && dy > Math.abs(dx) && (!drag.sc || drag.sc.scrollTop <= 0);
      }
      // (where nothing scrolls, a drag doesn't scroll the page under it either)
      if (!drag.on) { if (!drag.sc && Math.abs(dy) > Math.abs(dx) && e.cancelable) e.preventDefault(); return; }
      if (e.cancelable) e.preventDefault();
      drag.dy = Math.max(0, dy);
      const dt = e.timeStamp - drag.lt; if (dt > 0) drag.vel = (t.clientY - drag.ly) / dt;
      drag.ly = t.clientY; drag.lt = e.timeStamp;
      s.style.transform = `translateY(${drag.dy}px)`;
    };
    const end = () => {
      const d = drag; drag = null;
      if (!d?.on) return;
      if (d.dy > Math.min(150, s.offsetHeight * 0.33) || (d.vel > 0.5 && d.dy > 24)) return close(d.dy);
      s.style.transform = '';
      if (!still()) s.animate([{ transform: `translateY(${d.dy}px)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    };
    v.addEventListener('touchstart', start, { passive: true });
    v.addEventListener('touchmove', move, { passive: false });
    v.addEventListener('touchend', end); v.addEventListener('touchcancel', end);
    return () => {
      v.removeEventListener('touchstart', start); v.removeEventListener('touchmove', move);
      v.removeEventListener('touchend', end); v.removeEventListener('touchcancel', end);
      if (!--open) document.documentElement.classList.remove('sheet-open');
      // The page where it was, however the keyboard moved it: now, and as the keyboard finishes going.
      const back = () => { if (Math.abs(scrollY - y0) > 1) scrollTo(0, y0); };
      back();
      window.visualViewport?.addEventListener('resize', back);
      setTimeout(() => window.visualViewport?.removeEventListener('resize', back), 800);
    };
  }, []);
  return (
    <div ref={ref} className={className} style={style}
      onPointerDown={(e) => { down.current = e.target === e.currentTarget; }}
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget && down.current) shut.current(); }}>
      {typeof children === 'function' ? children(() => shut.current()) : children}
    </div>
  );
}

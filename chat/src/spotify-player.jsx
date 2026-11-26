// Spotify's own player on Home (docs/music.md): Spotify's Embed, worked through its iFrame API
// (developer.spotify.com/documentation/embeds/references/iframe-api), for the tablet's music. The shell sends it what to
// do (SpotifyEmbed.kt, as Opie's music tool asks: window.__opieSpotify) and hears what it plays (shell.spotifyState).
// It lives once, at the page's root, so it plays on whatever tab is showing; on Home it sits over the slot Today keeps
// for it (SpotifySlot), and anywhere else it's out of sight. It shows while it plays and for a few minutes after a
// pause; its x stops it.
import { useEffect, useRef, useState } from 'react';

const PAUSED_FOR = 5 * 60e3;
const subs = new Set();
let on = false;
const setOn = (v) => { if (on !== v) { on = v; subs.forEach((f) => f(v)); } };
/** Whether Spotify's player is showing (Today keeps its slot while it is). */
export function useSpotifyOn() {
  const [v, setV] = useState(on);
  useEffect(() => { subs.add(setV); setV(on); return () => { subs.delete(setV); }; }, []);
  return v;
}
/** Where the player sits on Home: Today's place for it. */
export const SpotifySlot = () => <div className="t-spotify" data-spotify-slot="" />;

export function SpotifyPlayer({ shell }) {
  const box = useRef(null), host = useRef(null);
  useEffect(() => {
    let api = null, ctl = null, state = {}, pausedAt = 0, script = null;
    const ready = new Promise((res) => { window.onSpotifyIframeApiReady = (a) => { api = a; res(); }; });
    const report = (s) => { state = { ...state, ...s }; try { shell.spotifyState(JSON.stringify(state)); } catch {} };
    const make = (uri) => new Promise((res) => {
      const el = document.createElement('div'); host.current.replaceChildren(el);
      api.createController(el, { uri, width: '100%', height: 152 }, (c) => {
        ctl = c;
        c.addListener('ready', () => res());
        c.addListener('playback_update', (e) => {
          const d = e?.data || {};
          if (d.isPaused) { if (!pausedAt) pausedAt = Date.now(); } else { pausedAt = 0; setOn(true); }
          report({ uri: d.playingURI || state.uri, paused: !!d.isPaused, buffering: !!d.isBuffering, pos: (d.position || 0) / 1000, len: (d.duration || 0) / 1000, stopped: false });
        });
      });
    });
    window.__opieSpotify = async (raw) => {
      let c = {}; try { c = typeof raw === 'string' ? JSON.parse(raw) : raw || {}; } catch { return; }
      if (c.do === 'load' && /^spotify:[a-z]+:[A-Za-z0-9]+$/.test(c.uri || '')) {
        if (!script) { script = document.createElement('script'); script.src = 'https://open.spotify.com/embed/iframe-api/v1'; script.async = true; document.head.appendChild(script); }
        await ready;
        report({ uri: c.uri, title: c.title || null, paused: true, pos: 0, len: 0, stopped: false });
        setOn(true); pausedAt = 0;
        if (!ctl) await make(c.uri); else { ctl.loadUri(c.uri); await new Promise((r) => setTimeout(r, 900)); }
        ctl.play();
        return;
      }
      if (!ctl) return;
      if (c.do === 'play') { setOn(true); ctl.resume(); }
      else if (c.do === 'pause') ctl.pause();
      else if (c.do === 'seek') ctl.seek(Math.max(0, (state.pos || 0) + (Number(c.seconds) || 0)));
      else if (c.do === 'restart') ctl.restart();
      else if (c.do === 'stop') { ctl.pause(); setOn(false); report({ stopped: true, paused: true }); }
    };
    // Over Today's slot when it's showing; else out of sight, still playing. Gone a while after a pause.
    const place = () => {
      const b = box.current; if (!b) return;
      if (on && pausedAt && Date.now() - pausedAt > PAUSED_FOR) { setOn(false); report({ stopped: true }); }
      const slot = on && document.querySelector('[data-spotify-slot]'), r = slot?.getBoundingClientRect();
      if (r && r.width > 0) Object.assign(b.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', visibility: 'visible' });
      else Object.assign(b.style, { left: '-4000px', top: '0px', width: '600px', visibility: 'hidden' });
    };
    const t = setInterval(place, 250);
    return () => { clearInterval(t); delete window.__opieSpotify; };
  }, []);
  const stop = () => window.__opieSpotify?.({ do: 'stop' });
  return <div ref={box} className="sp-player" style={{ left: '-4000px', visibility: 'hidden' }}>
    <div ref={host} className="sp-frame" />
    <span role="button" className="sp-close" aria-label="Close" onClick={stop}>
      <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M7 7l10 10M17 7L7 17" /></svg>
    </span>
  </div>;
}

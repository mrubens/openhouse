// Opie on a phone or a computer (docs/hub.md): its round mark at the bottom centre, only the mark, as on the tablet. A tap
// starts live voice (live-voice.js), another ends it. What it says isn't captioned (the user): only a problem shows. Shown only where it can work: a
// device allowed to talk (its 'voice' scope) on a page that may use the microphone (https or localhost).
import { useEffect, useRef, useState } from 'react';
import { talk, available } from './live-voice.js';

/** Can this device talk here: its 'voice' scope, and a page that may use the microphone. */
export const canTalk = (scopes) => !!scopes?.includes('voice') && available();

/** onType: where there's a typed sheet too (the phone page), a small keyboard button beside the pill opens it. */
export function Talk({ c, scopes, onType }) {
  const [on, setOn] = useState(false), [mood, setMood] = useState(null), [problem, setProblem] = useState('');
  const s = useRef(null), bars = useRef(null);
  useEffect(() => () => s.current?.stop(), []);
  useEffect(() => { if (!problem) return; const t = setTimeout(() => setProblem(''), 8000); return () => clearTimeout(t); }, [problem]);
  if (!c || !canTalk(scopes)) return null;
  function tap() {
    if (s.current) { s.current.stop(); return; }
    setProblem(''); setMood('listening'); setOn(true);
    s.current = talk(c, {
      state: (m) => setMood(m),
      level: (mic, out) => { const el = bars.current; if (el) el.style.setProperty('--lvl', Math.min(1, Math.max(mic, out) * 12).toFixed(2)); },
      problem: setProblem,
      ended: () => { s.current = null; setOn(false); setMood(null); },
    });
  }
  return (
    <div className="opie-talk">
      {problem && <div className="opie-words" aria-live="polite">{problem}</div>}
      <div className="opie-row">
      <button className={'opie-pill' + (on ? ' on ' + (mood || '') : '')} onClick={tap} aria-label={on ? 'Stop talking to Opie' : 'Talk to Opie'}>
        <span className="opie-bars" ref={bars}><i /><i /><i /><i /><i /></span>
      </button>
      {onType && !on && <button className="opie-type" onClick={onType} aria-label="Type to Opie"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" /></svg></button>}
      </div>
    </div>
  );
}

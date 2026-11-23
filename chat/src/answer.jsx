// The conversation page's (main.jsx) way of turning an answer's
// text into prose + generated UI, the actions that UI can take, and streaming a turn.
import { useMemo, Component } from 'react';
import { compileSpecStream, autoFixSpec } from '@json-render/core';
import { JSONUIProvider, Renderer } from '@json-render/react';
import { registry, setActions } from './registry.jsx';

export const BRIDGE = location.origin;

/** The assistant's mark: a microphone (talking to it is the main way in). */
export function MicIcon({ className = 'mic-icon' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2.5" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3.5" />
    </svg>
  );
}
// The shell exposes window.Display; in a desktop browser these are harmless stand-ins.
export const Display = window.Display || {
  closeChat: () => console.log('closeChat'),
  openChat: (id) => console.log('openChat', id),
  startTimer: (label, s) => console.log('timer', label, s),
  openApp: (id) => console.log('openApp', id),
};

// The model writes prose, then ```spec fences of JSONL patches. While streaming, the last fence
// may be unfinished: compile the complete lines so far, so the UI fills in as it arrives.
export function segments(text) {
  const out = [];
  const re = /```spec[^\n]*\n([\s\S]*?)(```|$)/g;
  let at = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > at) out.push({ kind: 'text', text: text.slice(at, m.index) });
    out.push({ kind: 'spec', src: m[1], done: m[2] === '```' });
    at = re.lastIndex;
    if (!m[2]) break;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out
    .map((s) => (s.kind === 'text' ? { ...s, text: s.text.replace(/^BUILD:.*$/m, '').trim() } : s))
    .filter((s) => s.kind === 'spec' || s.text);
}
function compile(src, done) {
  const lines = src.split('\n');
  if (!done) lines.pop(); // the last line may be half-written
  try {
    const spec = compileSpecStream(lines.join('\n'), { root: '', elements: {}, state: {} });
    if (!spec.root || !spec.elements?.[spec.root]) return null;
    return autoFixSpec(spec).spec;
  } catch { return null; }
}
export const buildLine = (text) => text.match(/^BUILD:\s*(.+)$/m)?.[1]?.trim();
export const hasUI = (text) => /```spec/.test(text || '');
export const firstSentence = (t) => (t.replace(/\s+/g, ' ').match(/^.*?[.!?](\s|$)/)?.[0] || t).trim().replace(/[.!…]+$/, '').slice(0, 90);

// Tiny, safe markdown: **bold**, *italic*, line breaks, "- " bullets.
export function Prose({ text, className }) {
  const html = useMemo(() => text
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\W)\*(?!\s)(.+?)\*(?=\W|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
    .replace(/^[-•] (.*)$/gm, '<span class="bullet">• $1</span>')
    .replace(/\n/g, '<br>'), [text]);
  return <div className={className || 'prose'} dangerouslySetInnerHTML={{ __html: html }} />;
}

class Guard extends Component {
  state = { err: null };
  static getDerivedStateFromError(err) { return { err }; }
  render() { return this.state.err ? <div className="ui-error">Couldn’t show this part.</div> : this.props.children; }
}

export function SpecView({ src, done }) {
  const spec = useMemo(() => compile(src, done), [src, done]);
  if (!spec) return done ? null : <div className="building">Building the answer…</div>;
  return (
    <Guard>
      <JSONUIProvider registry={registry} initialState={spec.state || {}} handlers={handlers}>
        <div className="ui"><Renderer spec={spec} registry={registry} loading={!done} /></div>
      </JSONUIProvider>
    </Guard>
  );
}

/** An answer's text as prose + UI. `prose: false` shows only the UI (board cards). */
export function AnswerBody({ text, done = true, prose = true }) {
  const segs = useMemo(() => segments(text || ''), [text]);
  return segs.map((s, j) => s.kind === 'text'
    ? (prose ? <Prose key={j} text={s.text} /> : null)
    : <SpecView key={j} src={s.src} done={done || s.done} />);
}

// --- actions the generated UI can take -----------------------------------------
// Each page plugs in how to ask a follow-up and what context "make it an app" should carry.
export const page = { ask: () => {}, context: () => '', afterBuild: () => {} };
export async function makeApp(request, context) {
  await fetch(BRIDGE + '/request', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: request, context: context ?? page.context() }),
  }).catch(() => {});
  page.afterBuild(); // the overlay's progress card takes over
}
const handlers = {
  ask: ({ text }) => text && page.ask(String(text)),
  startTimer: ({ label, seconds }) => Display.startTimer(String(label || 'Timer'), Math.round(Number(seconds) || 60)),
  makeApp: ({ request }) => makeApp(String(request || 'Make an app from this')),
};
setActions(handlers);

/**
 * One conversation turn, streamed. on.start(id), on.status(text), on.text(sofar).
 * Resolves { id, ok, text }.
 */
export async function streamTurn({ id, text, who, about, signal, on = {} }) {
  let finalText = '', streamed = '', ok = false;
  try {
    const r = await fetch(BRIDGE + '/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, text, who, about }), signal,
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'start') { id = ev.id; on.start?.(id); }
        else if (ev.type === 'status') on.status?.(ev.text);
        else if (ev.type === 'delta') { streamed += ev.text; on.text?.(streamed); }
        else if (ev.type === 'reset') { // a new message: an earlier one ("I'll look that up") becomes the status line
          if (streamed.trim()) { on.status?.(firstSentence(streamed)); streamed = ''; on.text?.(''); }
        } else if (ev.type === 'message') { if (!streamed) on.status?.(firstSentence(ev.text)); }
        else if (ev.type === 'done') { ok = ev.ok; finalText = ev.text; }
      }
    }
  } catch (e) { finalText = signal?.aborted ? 'Stopped.' : `I couldn’t reach the display’s helper (${e.message}).`; }
  return { id, ok, text: finalText || '…' };
}
export const stopTurn = (id) => fetch(BRIDGE + '/chat/stop', { method: 'POST', body: JSON.stringify({ id }) }).catch(() => {});

// How each catalog component looks on the wall. Big type and big touch targets throughout.
import { useState } from 'react';
import { defineRegistry } from '@json-render/react';
import { catalog } from './catalog.js';

let actions = {};
export const setActions = (a) => { actions = a; };

const fmt = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
};
const words = (s) => {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return s < 60 ? `${s} sec` : h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
};
const inline = (t) => String(t ?? '')
  .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
  .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\W)\*(?!\s)(.+?)\*(?=\W|$)/g, '$1<i>$2</i>');
const Rich = ({ text, tag: Tag = 'span', className }) => <Tag className={className} dangerouslySetInnerHTML={{ __html: inline(text) }} />;

function TimerButton({ label, seconds, compact }) {
  const [started, setStarted] = useState(false);
  return (
    <button className={'timer-btn' + (started ? ' started' : '') + (compact ? ' compact' : '')}
      onClick={() => { actions.startTimer?.({ label, seconds }); setStarted(true); setTimeout(() => setStarted(false), 4000); }}>
      <span><b>{started ? 'Timer started' : `Start ${words(seconds)}`}</b>{!compact && <small>{label}</small>}</span>
    </button>
  );
}

function ytId(url) {
  const m = String(url).match(/(?:youtu\.be\/|v=|\/embed\/|\/shorts\/)([\w-]{11})/);
  return m?.[1] || null;
}

function Video({ props }) {
  const [playing, setPlaying] = useState(false);
  const id = ytId(props.url);
  if (!id) return null;
  return (
    <>
      <button className="video" onClick={() => setPlaying(true)}>
        <span className="thumb" style={{ backgroundImage: `url(https://i.ytimg.com/vi/${id}/hqdefault.jpg)` }}><span className="play">▶</span></span>
        <span className="vmeta">
          <b>{props.title}</b>
          {props.channel && <span className="muted">{props.channel}</span>}
          {props.why && <span className="why">{props.why}</span>}
        </span>
      </button>
      {playing && (
        <div className="player" onClick={() => setPlaying(false)}>
          <iframe src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`} allow="autoplay; encrypted-media; fullscreen" allowFullScreen title={props.title} />
          <button className="close big" onClick={() => setPlaying(false)}>Close video</button>
        </div>
      )}
    </>
  );
}

function Steps({ props }) {
  const steps = props.steps || [];
  const [i, setI] = useState(0);
  if (!steps.length) return null;
  const s = steps[Math.min(i, steps.length - 1)];
  return (
    <div className="steps">
      <div className="steps-head">
        <span className="muted">{props.title ? `${props.title} · ` : ''}Step {i + 1} of {steps.length}</span>
        <span className="pips">{steps.map((_, k) => <i key={k} className={k === i ? 'on' : k < i ? 'done' : ''} onClick={() => setI(k)} />)}</span>
      </div>
      <Rich tag="div" className="step-text" text={s.text} />
      <div className="steps-foot">
        {s.timerSeconds ? <TimerButton key={i} label={s.timerLabel || `Step ${i + 1}`} seconds={s.timerSeconds} compact /> : <span />}
        <div className="nav">
          <button className="secondary" disabled={i === 0} onClick={() => setI(i - 1)}>Back</button>
          <button className="primary" disabled={i === steps.length - 1} onClick={() => setI(i + 1)}>{i === steps.length - 1 ? 'Done' : 'Next'}</button>
        </div>
      </div>
    </div>
  );
}

function Checklist({ props }) {
  const [done, setDone] = useState({});
  return (
    <div className="checklist">
      {props.title && <h3>{props.title}</h3>}
      {(props.items || []).map((it, k) => (
        <button key={k} className={'check' + (done[k] ? ' on' : '')} onClick={() => setDone({ ...done, [k]: !done[k] })}>
          <span className="box">{done[k] ? '✓' : ''}</span><Rich text={it} />
        </button>
      ))}
    </div>
  );
}

export const { registry } = defineRegistry(catalog, {
  components: {
    Stack: ({ props, children }) => <div className={`stack ${props.direction === 'horizontal' ? 'row' : 'col'} gap-${props.gap || 'medium'}`}>{children}</div>,
    Card: ({ props, children }) => (
      <section className="card">
        {props.title && <h3>{props.title}</h3>}
        {props.subtitle && <p className="muted sub">{props.subtitle}</p>}
        {children}
      </section>
    ),
    Heading: ({ props }) => { const L = `h${props.level || '2'}`; return <L className="heading">{props.text}</L>; },
    Text: ({ props }) => <Rich tag="p" className={`text ${props.tone || ''}`} text={props.text} />,
    List: ({ props }) => { const L = props.ordered ? 'ol' : 'ul'; return <L className="list">{(props.items || []).map((x, k) => <Rich tag="li" key={k} text={x} />)}</L>; },
    Checklist,
    Steps,
    Timer: ({ props }) => <TimerButton label={props.label} seconds={props.seconds} />,
    Video,
    Image: ({ props }) => (
      <figure className="img"><img src={props.url} alt={props.caption || ''} onError={(e) => { e.currentTarget.closest('figure').style.display = 'none'; }} />{props.caption && <figcaption>{props.caption}</figcaption>}</figure>
    ),
    Tip: ({ props }) => <div className={`tip ${props.tone || 'tip'}`}><Rich text={props.text} /></div>,
    Stat: ({ props }) => <div className="stat"><span className="muted">{props.label}</span><b>{props.value}</b></div>,
    Button: ({ props, emit }) => <button className={props.style === 'secondary' ? 'secondary' : 'primary'} onClick={() => emit('press')}>{props.label}</button>,
    Suggestions: ({ props }) => (
      <div className="suggestions">{(props.items || []).map((s, k) => <button key={k} className="chip" onClick={() => actions.ask?.({ text: s })}>{s}</button>)}</div>
    ),
  },
  actions: {
    ask: async (p) => actions.ask?.(p),
    startTimer: async (p) => actions.startTimer?.(p),
    makeApp: async (p) => actions.makeApp?.(p),
  },
});

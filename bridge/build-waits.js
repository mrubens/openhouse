// An app made on the tablet waits for a grown-up's yes (docs/building-on-the-tablet.md, "A grown-up's yes"). The card
// is asked as the build ends, with the PIN always (a tablet with none asks someone to choose one there). Its yes puts
// the app in; its no puts everything back. Nobody answering (or "Not now") loses nothing: the change is kept aside as
// a commit under refs/opie/waiting/<id> (not on the apps' history), the files are put back so nothing else waits on
// it, and Home shows "Reading Streak is waiting for a grown-up" (things.js); a tap there, or Opie asked, puts the change
// back in and asks the card again. One nobody answers for a day is put back for good, with a line on Home saying so.
//
// file: waiting-builds.json beside undo.json: [{ id, commit, at, who, text, card }]
import fs from 'node:fs';
import path from 'node:path';

const DAY = 864e5;

// A build under way is marked on disk (building.json beside undo.json) from when it holds the lock until it's done: a
// bridge stopped in between (an update, a crash) finds the mark on its next start and puts the half-made change back,
// before anything else could take it in as "checkpoint" (the household's own, with every right and no card).
const markOf = (HERE) => path.join(HERE, 'building.json');
export function markBuilding(HERE, owner) { try { fs.writeFileSync(markOf(HERE), JSON.stringify({ base: owner.base, text: String(owner.text || '').slice(0, 200), at: Date.now() })); } catch {} }
export function unmarkBuilding(HERE) { try { fs.rmSync(markOf(HERE), { force: true }); } catch {} }
/** On start-up, first: a build the bridge stopped in the middle of is put back. True when there was one. */
export function putBackUnfinished({ HERE, edits, log = (...a) => console.log('[builder]', ...a) }) {
  let m; try { m = JSON.parse(fs.readFileSync(markOf(HERE), 'utf8')); } catch { return false; }
  const owner = { id: 'unfinished-build', kind: 'build', who: null, text: m?.text || 'an unfinished build' };
  if (edits.tryAcquire(owner, { checkpoint: false })) {
    try { edits.discard(owner); log(`put back a build the bridge stopped in the middle of: "${owner.text.slice(0, 60)}"`); }
    finally { edits.release(owner); }
  }
  unmarkBuilding(HERE);
  return true;
}

/**
 * edits: the edit lock (edits.js). ask(card) -> 'yes' | 'no' | 'later' | null (server.js shellAsk; null: no screen to
 * ask, a hub: that's a no). grant(card): what a yes grants (plugins.js madeHere), before the commit, so both land
 * together. unmake(id): a change's draft off the registry once it's swapped in (plugins.js unmake). landed(rec): after it's committed (builder.js: the request log). emit: the screens' events.
 * line(text): one line on Home (things.js put). changed(): what's waiting changed (Home reads it again: house.js changed).
 */
export function buildWaits({ FILE, APP_DIR, edits, ask = async () => 'later', grant = () => {}, unmake = () => {}, landed = () => {}, emit = () => {}, line = () => {}, changed = () => {}, now = () => Date.now(), log = (...a) => console.log('[waits]', ...a) }) {
  const git = edits.git;
  let list = (() => { try { const l = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(l) ? l.filter((w) => w && /^[0-9a-f]{40}$/.test(w.commit || '') && w.card?.app) : []; } catch { return []; } })();
  const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(list, null, 1)); } catch (e) { log('not saved:', e.message); } try { changed(); } catch {} };
  const ref = (id) => `refs/opie/waiting/${id}`;
  const opening = new Set();

  /** The card, with the change in the working tree under [owner]'s lock: 'yes' (granted: the caller commits), 'no' or 'later'. */
  async function decide(owner, card) {
    let a;
    // The PIN, unless the household turned off asking for it to add apps (for: the shell's PinChoices); a person's yes either way.
    try { a = await ask({ ...card, pin: true, grownup: true, for: 'apps' }); } catch (e) { log('card:', e.message); a = 'later'; }
    if (a === 'yes') {
      if (card.draft) promote(card); // a change made in a draft: swapped in now, the draft's entry gone
      if (card.limited) grant(card);
      return 'yes';
    }
    // null: no screen here to ask a grown-up (a hub, a bridge on a laptop): nothing goes in, nothing is granted.
    return a === 'later' ? 'later' : 'no';
  }

  /** A change made in a draft copy (rails.js): its files take the app's place, and the draft goes. */
  function promote(card) {
    const apps = path.join(APP_DIR, 'apps'), from = path.join(apps, card.draft), to = path.join(apps, card.app);
    if (!fs.existsSync(from)) throw new Error(`${card.draft} isn't there`);
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(from, to);
    unmake(card.draft);
  }

  /** Keep the holder's change aside (a commit nothing points to but its ref) and put the files back. */
  function park(owner, card, { who = owner.who || null, text = owner.text || '' } = {}) {
    git('add', '-A');
    const tree = git('write-tree');
    const commit = git('commit-tree', tree, '-p', owner.base, '-m', `waiting: ${String(text).slice(0, 200)}`);
    const id = `w${now().toString(36)}`;
    git('update-ref', ref(id), commit);
    edits.discard(owner);
    list.push({ id, commit, at: now(), who, text, card });
    save();
    log(`${card.name} waits for a grown-up (${id})`);
    emit({ type: 'waiting', id, app: card.app, name: card.name });
    return id;
  }

  function drop(w) {
    list = list.filter((x) => x.id !== w.id); save();
    try { git('update-ref', '-d', ref(w.id)); } catch {}
  }

  /** Put the waiting change back in the working tree (the holder took the lock with the tree clean). True when it applied. */
  function apply(w) {
    try { git('cherry-pick', '--no-commit', w.commit); return true; }
    catch (e) { try { git('cherry-pick', '--abort'); } catch {} try { git('reset', '-q', '--merge'); } catch {} log('could not apply:', String(e.stderr || e.message).slice(0, 200)); return false; }
  }

  /**
   * Its card again (a tap on Home's line, or Opie): the change goes back in, the app shows behind the card, and the
   * answer settles it. Resolves { ok, answer } or { ok: false, error }.
   */
  async function open(id, { timeoutMs = 60e3 } = {}) {
    expire();
    const w = list.find((x) => x.id === id || x.card?.app === id || x.card?.name?.toLowerCase() === String(id || '').toLowerCase());
    if (!w) return { ok: false, error: 'Nothing is waiting for a yes.' };
    if (opening.has(w.id)) return { ok: true, answer: 'asking' };
    opening.add(w.id);
    const owner = { id: `wait-${w.id}`, kind: 'build', who: w.who, text: w.text };
    try {
      if (!(await edits.acquire(owner, { timeoutMs, checkpoint: true }))) return { ok: false, error: edits.busyText() || 'Busy with another change.' };
      markBuilding(path.dirname(FILE), owner);
      let answer = 'later';
      try {
        if (!apply(w)) {
          drop(w); edits.discard(owner);
          line(`${w.card.name} couldn't be put in: the apps changed since it was made`);
          emit({ type: 'gone', app: w.card.app, fresh: !!w.card.fresh }); emit({ type: 'apps' });
          return { ok: false, error: `${w.card.name} couldn't be put back in: the apps changed since. Ask for it again.` };
        }
        const shownApp = w.card.draft || w.card.app; // (a change made in a draft: the draft, limited, is what shows)
        emit({ type: 'edit', app: shownApp, text: `apps/${shownApp}/` }); // the app shows behind its card
        answer = await decide(owner, w.card);
        if (answer === 'yes') {
          edits.commit(owner);
          drop(w); landed(w);
          if (w.card.draft) emit({ type: 'gone', app: w.card.draft }); // (swapped in: the draft's page is gone)
          emit({ type: 'apps' });
          emit({ type: 'done', ok: true, changed: true, text: w.card.fresh ? `${w.card.name} is in Apps.` : `The change to ${w.card.name} is in.` });
        } else {
          edits.discard(owner);
          if (answer === 'no') drop(w);
          if (w.card.fresh || w.card.draft) emit({ type: 'gone', app: w.card.draft || w.card.app, fresh: true });
          emit({ type: 'waiting', id: w.id, app: w.card.app, name: w.card.name, gone: answer === 'no' });
        }
      } finally { if (answer !== 'yes') edits.discard(owner); unmarkBuilding(path.dirname(FILE)); edits.release(owner); }
      return { ok: true, answer };
    } finally { opening.delete(w.id); }
  }

  /** Put back for good the ones nobody answered for a day, each with a line on Home. */
  function expire() {
    for (const w of list.filter((x) => now() - x.at > DAY && !opening.has(x.id))) {
      drop(w);
      log(`${w.card.name}: nobody said yes in a day, put back`);
      try { line(`${w.card.name} wasn't put in: nobody said yes for a day`); } catch {}
      emit({ type: 'waiting', id: w.id, app: w.card.app, name: w.card.name, gone: true });
    }
  }
  const timer = setInterval(expire, 15 * 60e3); timer.unref?.();

  /** What's waiting, oldest first: { id, app, name, who, at }. */
  const waiting = () => { expire(); return list.map((w) => ({ id: w.id, app: w.card.app, name: w.card.name, who: w.who, at: w.at, summary: w.card.summary })); };

  return { decide, park, open, expire, waiting, stop: () => clearInterval(timer) };
}

// Rewards: what chore stars buy. A person says yes on the display's own card, with the PIN.
import crypto from 'node:crypto';
import { str, same, low, arr } from './util.js';

export default function (house) {
  const { data, save } = house;
  // ---- rewards: stars from chores, spent on something the kid chose; someone says yes ----
  function give(ask) {
    const w = low(ask.who);
    data.spent[w] = (data.spent[w] || 0) + ask.stars;
    data.got.unshift({ who: ask.who, title: ask.title, stars: ask.stars, at: Date.now() }); data.got = data.got.slice(0, 30);
    data.asks = data.asks.filter((x) => x.id !== ask.id);
  }
  async function askGrownUp(ask) {
    // The shell's "Is this OK?" card, with the PIN when there is one. Nothing the assistant says answers it.
    const r = await house.shell('/approve', { title: `${ask.who}: ${ask.title}?`, detail: `For ${ask.stars} stars.`, pin: true, yes: 'Give it' }, 100_000);
    if (!data.asks.some((x) => x.id === ask.id)) return;
    // No card on this display (device access off): the Chores app shows the ask, but only a no counts from there. No answer
    // in time (nobody came): it's dropped, and the kid asks again; it never falls to a button anyone can tap.
    if (r?.why) { ask.manual = true; save(); return; }
    if (r == null) { data.asks = data.asks.filter((x) => x.id !== ask.id); save(); return; }
    if (r.yes && house.stars(ask.who) >= ask.stars) give(ask); else data.asks = data.asks.filter((x) => x.id !== ask.id);
    save();
  }
  /**
   * Adding or removing rewards (what stars buy) needs a yes on the display's card, with the PIN, as
   * giving one does: a kid could otherwise make "Ice cream: 1 star", in an app or by asking the assistant. With no
   * display around (a computer running the bridge) it just happens; with no card possible (device access off), too.
   */
  function rewardSetup(a, fromApp) {
    const adds = (a.add ? [].concat(a.add) : []).filter((y) => str(y?.title)), removes = arr(a.remove);
    if (!adds.length && !removes.length) return [];
    if (!house.shellCfg()) return setUpRewards(adds, removes);
    const what = [...adds.map((x) => `${str(x.title, 60)} for ${Math.max(1, Math.min(500, Math.round(Number(x.stars) || 10)))} stars`), ...removes.map((x) => `take off ${data.rewards.find((y) => y.id === x || same(y.title, x))?.title || x}`)].join('; ');
    house.shell('/approve', { title: 'Change the rewards?', detail: what, pin: true, yes: 'Change' }, 100_000).then((r) => {
      if (r?.why || r?.yes) { setUpRewards(adds, removes); save(); }
    });
    return [`asked someone to OK it on the display (${what})`];
  }
  function setUpRewards(adds, removes) {
    const did = [];
    for (const x of adds) {
      const n = Math.max(1, Math.min(500, Math.round(Number(x.stars) || 10)));
      const was = data.rewards.find((r) => same(r.title, x.title) && same(r.who || '', x.who || ''));
      if (was) { was.stars = n; did.push(`${was.title} is now ${n} stars`); continue; }
      data.rewards.push({ id: 'r-' + crypto.randomUUID().slice(0, 6), title: str(x.title, 60), stars: n, ...(str(x.who) ? { who: str(x.who, 40) } : {}) });
      did.push(`added ${x.title} for ${n} star${n === 1 ? "" : "s"}`);
    }
    for (const ref of removes) {
      const r = data.rewards.find((y) => y.id === ref || same(y.title, ref));
      if (!r) { did.push(`no reward "${ref}"`); continue; }
      data.rewards = data.rewards.filter((y) => y !== r); data.asks = data.asks.filter((y) => y.reward !== r.id); did.push(`removed ${r.title}`);
    }
    return did;
  }
  function changeRewards(a, { fromApp = false } = {}) {
    const did = rewardSetup(a, fromApp);
    if (fromApp && a.redeem) {
      const r = data.rewards.find((y) => y.id === a.redeem.id), who = str(a.redeem.who, 40);
      if (!r || !who) return { error: 'Which reward, for whom?' };
      if (house.stars(who) < r.stars) return { error: `${who} has ${house.stars(who)} stars; ${r.title} needs ${r.stars}.` };
      if (!data.asks.some((x) => x.reward === r.id && same(x.who, who))) {
        const ask = { id: 'a-' + crypto.randomUUID().slice(0, 6), who, reward: r.id, title: r.title, stars: r.stars, at: Date.now() };
        data.asks.push(ask); askGrownUp(ask);
      }
      did.push(`asked for ${r.title}`);
    }
    if (fromApp && a.answer) { // only where the display has no "Is this OK?" card of its own: an app can say no, never yes
      const ask = data.asks.find((x) => x.id === a.answer.id);
      if (ask?.manual && !a.answer.yes) data.asks = data.asks.filter((x) => x !== ask);
      else if (ask?.manual) did.push('someone says yes on the display (its own card, with the PIN)');
    }
    save();
    return { ok: true, did };
  }
  return { changeRewards };
}

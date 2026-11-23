// Send to Opie (docs/phones.md): something shared from someone's phone becomes a turn with Opie, as from that person,
// and Opie decides what it's for (a recipe's link into the box, a date onto the calendar, things to buy onto a list, or
// one short question back). It comes from the iPhone's shortcut, through the cloud, sealed with the phone's share key
// (screens.js shareKey), or from the phone page itself (Android's share sheet). The answer goes back to their phone.
//
//   POST /phone/share {text?, image?: base64, type?}   -> {ok, text, id?}: from the shortcut, that it's sent (the answer
//                                                          comes as a message); from the page, Opie's answer within
//                                                          waitMs (id: the conversation), else that it's on it
//   GET  /phone/share-key                               -> {key}: this phone's share key, for its shortcut's address

const PER_HOUR = 30;

export function phoneShareRoutes({ screens, json, body, turn, describe, message, shareKey, phones = () => ({}), addPhoto = null, waitMs = 14e3, now = () => Date.now() }) {
  const recent = new Map(); // phone id -> [times]
  const convo = new Map(); // person -> {id, at}: shares within half an hour continue one conversation
  // A photo someone shared, kept here for an hour (memory only) so Opie can put it in Photos when that's what it's for,
  // then or when they answer back: person -> {bytes, type, at}.
  const HOLD_MS = 3600e3, held = new Map();
  const heldFor = (who) => {
    const t = now();
    for (const [p, x] of held) if (t - x.at > HOLD_MS) held.delete(p);
    if (who) return held.get(String(who)) ? [String(who), held.get(String(who))] : null;
    return held.size === 1 ? [...held][0] : null; // (the voice doesn't say who: only if there's just the one)
  };
  const KEEP = { name: 'keep_shared_photo', description: "Put the photo someone just shared from their phone into the household's Photos (it shows in the slideshow), with a short caption if it helps. Only while one is waiting (for an hour after it was shared).",
    inputSchema: { type: 'object', properties: { caption: { type: 'string', description: 'A few words, only if they gave them or it clearly helps' } } } };
  async function call(name, a, ctx) {
    const ok = (text) => ({ content: [{ type: 'text', text }] }), no = (text) => ({ content: [{ type: 'text', text }], isError: true });
    const h = heldFor(ctx?.who);
    if (!h || !addPhoto) return no('No shared photo is waiting (they last an hour). Ask them to share it again.');
    const [who, x] = h;
    addPhoto(x.bytes, x.type === 'image/png' ? 'shared.png' : x.type === 'image/webp' ? 'shared.webp' : 'shared.jpg', String(a?.caption || ''));
    held.delete(who);
    return ok('It is in Photos now.');
  }

  return Object.assign(async function handle(req, res, url) {
    if (url.pathname !== '/phone/share' && url.pathname !== '/phone/share-key') return false;
    const s = screens.who(String(req.headers['x-openhouse-screen'] || ''));
    if (!s || s.kind !== 'phone' || !s.person || !s.scopes.includes('ask')) { json(res, 403, { error: 'only a phone that may ask Opie' }); return true; }
    if (url.pathname === '/phone/share-key') { json(res, 200, { key: shareKey(s.id).toString('base64url') }); return true; }

    const t = now(), times = (recent.get(s.id) || []).filter((x) => x > t - 3600e3);
    if (times.length >= PER_HOUR) { json(res, 429, { error: 'That’s a lot at once. Try again in a while.' }); return true; }
    recent.set(s.id, [...times, t]);

    const b = await body(req);
    const text = String(b.text || '').trim().slice(0, 4000);
    const image = typeof b.image === 'string' && b.image ? Buffer.from(b.image, 'base64') : null;
    if (!text && !image) { json(res, 400, { error: 'Nothing came with it.' }); return true; }

    // Everything after this (looking at a photo, Opie's turn) is one piece of work raced against one deadline, from
    // when the request came: the cloud waits 25 s in all, and looking at a photo alone can take that long. What comes
    // later goes to their phone as a message, a failure too, so a share never ends in silence.
    const work = (async () => {
      if (image) held.set(s.person, { bytes: image, type: /^image\/(png|webp)$/.test(String(b.type)) ? String(b.type) : 'image/jpeg', at: t });
      let what = text;
      if (image) {
        held.set(s.person, { bytes: image, type: /^image\/(png|webp)$/.test(String(b.type)) ? String(b.type) : 'image/jpeg', at: now() });
        let seen;
        try { seen = await describe(image, /^image\/(png|webp|gif)$/.test(String(b.type)) ? String(b.type) : 'image/jpeg'); }
        catch { return { ok: false, text: 'Opie couldn’t look at that photo just now. Try again in a while.' }; }
        what = `a photo. What it shows: ${String(seen).trim().slice(0, 3000)}${text ? `\nWith it: ${text}` : ''}\n` +
          '(The photo itself is kept for an hour: keep_shared_photo puts it in the household\'s Photos. A moment worth keeping, people or the family, goes there: just do it and say so. ' +
          'Something to act on, like a flyer, a schedule or a recipe, is for the calendar, a list or Recipes, not Photos. If you can\'t tell, ask.)';
      }
      const prompt = `(Shared from their phone's share sheet, not said aloud; they may be away from home.) ${what}\n\n` + // (the turn puts "<person> says:" first)
        '(Do what they most likely want with it, with your tools. If it isn’t clear what they want, ask one short question. ' +
        'Your answer goes to their phone as a short notification: one or two plain sentences, no lists.)';
      const was = convo.get(s.person);
      const id = was && now() - was.at < 30 * 60e3 ? was.id : null;
      const r = await turn(prompt, s.person, id);
      if (r.id) convo.set(s.person, { id: r.id, at: now() });
      return r;
    })().catch(() => ({ ok: false, text: 'Opie couldn’t answer that just now.' }));
    // From the iPhone's shortcut (it comes through the cloud: x-openhouse-share-at): "Sent" at once, and Opie's answer
    // as OpenHouse's own message, whose tap opens that conversation on the phone to answer (a tap on the shortcut's
    // own notification only opens the Shortcuts app). From the page itself (Android's share sheet), the answer when
    // it comes, in the sheet that's open, within the deadline; later, as a message too.
    const fromShortcut = !!req.headers['x-openhouse-share-at'];
    const tell = (r) => message([s.person], { title: 'Opie', text: r.text || 'Done.', ...(r.id ? { open: `opie:${r.id}` } : {}) });
    if (fromShortcut) {
      const on = phones()[s.person]?.on > 0;
      json(res, 200, { ok: true, text: on ? 'Sent to Opie. The answer comes as a notification from OpenHouse.' : 'Sent to Opie. The answer will be in OpenHouse on your phone.' });
      work.then(tell).catch(() => {});
      return true;
    }
    const quick = await Promise.race([work, new Promise((r) => setTimeout(() => r(null), Math.max(0, t + waitMs - now())).unref?.())]);
    if (quick) { json(res, 200, { ok: quick.ok !== false, text: quick.text || 'Done.', ...(quick.id ? { id: quick.id } : {}) }); return true; }
    json(res, 200, { ok: true, text: 'Opie is on it. The answer will come here.' });
    work.then(tell).catch(() => {});
    return true;
  }, { tools: [KEEP], call });
}

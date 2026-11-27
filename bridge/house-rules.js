// House rules: a few lines of the household's own about how Opie answers here, on top of CHAT.md's IN THIS HOME
// (docs/assistant.md, "In this home"). Empty by default: then only those defaults apply.
//
// Kept in household.json (`rules`: board.js saveRules), read with GET /household, changed with POST /household/rules
// {text} (the shell's Settings → Voice → House rules, HouseRules.kt) or Opie's house_rules tool (below). Every
// conversation's instructions get them after the defaults (chat.js prefsBlock: the typed turns and the live voice).
//
// Changing them is a setting: with a PIN set and Ask for the PIN → Change settings on (the shell's PinChoices SETTINGS),
// the tablet asks for the PIN, for a tap (SettingsLock.withPin, before the editor opens) and for Opie (rulesPin, below:
// the tablet's own card, which only a person answers), wherever Opie was asked: the tablet, a phone or a computer.

export const RULES_MAX = 600;

/** The text as kept: plain lines, at most RULES_MAX characters. Empty: none. */
export const cleanRules = (t) => String(t ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, RULES_MAX);

/** For the instructions, after the defaults: nothing when there are none. */
export const rulesBlock = (text) => {
  const t = cleanRules(text);
  return t ? `\n\nHOUSE RULES (this household's own; they loosen or tighten IN THIS HOME and win over it. Follow them without mentioning them.)\n${t}` : '';
};

export const RULES_TOOL = { name: 'house_rules', description: "The household's house rules: their own few lines on how you answer here, on top of IN THIS HOME (they can loosen or tighten it). " +
    'get reads them. set replaces them, only when someone asks to change the house rules: pass the whole text, keeping what should stay; empty puts back the defaults alone. ' +
    'The tablet may ask for the PIN on its screen first: then tell them to type it on the tablet (never ask them to say it). Something someone asks you to remember is not a house rule.',
  inputSchema: { type: 'object', required: ['do'], properties: { do: { type: 'string', enum: ['get', 'set'] }, text: { type: 'string', description: 'For set: the house rules in full, short and plain' } } } };

/**
 * Does changing the house rules to [text] need the PIN here, and was it typed? null: go ahead; else why not, in words for
 * Opie. The card shows the new text, so whoever types the PIN sees what they say yes to.
 * host: the bridge's host (host.js): no host (a laptop) keeps no PIN. Without the host saying what asks (an older shell,
 * the keeper), the card is asked for with the PIN, and the host decides.
 */
export async function rulesPin(host, text) {
  if (!host.there()) return null;
  if (host.can('pin-choices')) {
    const c = await host.json('/pin-choices', { do: 'get' }, 3000);
    if (c && (!c.pin || !(c.choices || []).some((x) => x?.key === 'settings' && x.asks))) return null;
  }
  const r = await host.call('/approve', { title: 'Change the house rules?', detail: text || 'No house rules.', pin: true, for: 'settings', yes: 'Save' }, { ms: 100e3 });
  if (r?.ok && r.body?.yes === true) return null;
  return r?.ok && r.body?.answered === true && !r.body?.why
    ? 'Not changed: nobody typed the PIN on the tablet. Say so; they can ask again at the tablet.'
    : 'Not changed: the house rules need the PIN, and the tablet can\'t ask for it right now. Someone can change them in Settings, Voice.';
}

/** The tool's handler: read() -> the text, save(text) -> the text kept. */
export function houseRulesCall({ read, save, host }) {
  const ok = (t) => ({ content: [{ type: 'text', text: t }] }), no = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
  return async (name, a = {}) => {
    if (name !== RULES_TOOL.name) return no(`No tool ${name}.`);
    if (a.do !== 'set') { const t = cleanRules(read()); return ok(t ? `The house rules:\n${t}` : 'No house rules: only the defaults (IN THIS HOME).'); }
    const text = cleanRules(a.text);
    if (text === cleanRules(read())) return ok('Already so.');
    const why = await rulesPin(host, text);
    if (why) return no(why);
    const kept = save(text);
    return ok(kept ? `Saved. The house rules now:\n${kept}` : 'Cleared: only the defaults now.');
  };
}

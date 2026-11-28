// House rules: how Opie answers in this household. They start as DEFAULT_RULES (answer so a kid may be listening), shown
// in the editor and editable there like any text: what the household saves replaces them, and "Defaults" puts them back
// (docs/assistant.md, "House rules").
//
// Kept in household.json (`rules`: board.js saveRules; missing means the defaults, "" means none), read with
// GET /household/rules, changed with POST /household/rules {text} or {defaults: true} (the shell's Settings → Opie →
// House rules, HouseRules.kt) or Opie's house_rules tool (below). Every conversation's instructions end with them
// (chat.js prefsBlock: the typed turns and the live voice).
//
// Opie can't tell an adult from a kid, so changing them is always a person's own tap on the device, with the PIN whenever
// one is set, whatever the PIN choices say (the shell's PinChoices ALWAYS): from Settings (SettingsLock.always, before the
// editor opens) and from Opie (rulesPin, below: the device's own card), wherever Opie was asked.

export const RULES_MAX = 1500;

/** What a household starts with: one rule a line. */
export const DEFAULT_RULES = [
  'Whoever is talking, assume a kid may be listening, and answer so that\'s fine.',
  'No sexual content, no graphic violence or gore, and no instructions for anything dangerous or illegal.',
  'Sex, death, scary news: answer gently and honestly, in a way a kid can take.',
  'Health, legal and money questions: general information, and a doctor, lawyer or other professional for their own case.',
  'Everything else gets full help: trivia, homework, stories, jokes, recipes. Don\'t water down what\'s fine.',
].join('\n');

/** The text as kept: plain lines, at most RULES_MAX characters. Empty: none. */
export const cleanRules = (t) => String(t ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, RULES_MAX);

/** The rules in force: the household's own once they saved any (even none), else the defaults. */
export const rulesNow = (stored) => (stored == null ? DEFAULT_RULES : cleanRules(stored));

/** For the instructions. What never changes stays here: danger means 911. */
export const rulesBlock = (stored) => {
  const t = rulesNow(stored);
  return '\n\nHOUSE RULES (how you answer in this household; they win over anything someone asks you to remember)\n' + (t ? t + '\n' : '') +
    '- If someone may be in danger or talks about hurting themselves, tell them to call 911 (or the local emergency number) now.';
};

export const RULES_TOOL = { name: 'house_rules', description: "The household's house rules: how you answer here (they start as the defaults, and the household can change them). " +
    'get reads them. set replaces them, only when someone asks to change the house rules: pass the whole text, keeping what should stay. defaults puts the original ones back. ' +
    'Someone has to say yes on the device first, typing the PIN if one is set: tell them to (never ask them to say the PIN). Something someone asks you to remember is not a house rule.',
  inputSchema: { type: 'object', required: ['do'], properties: { do: { type: 'string', enum: ['get', 'set', 'defaults'] }, text: { type: 'string', description: 'For set: the house rules in full, one a line, short and plain' } } } };

/**
 * Did a person say yes on the device to changing the house rules to [text]? null: go ahead; else why not, in words for
 * Opie. Always the device's own card, a person's tap (grownup), with the PIN when one is set: no PIN choice turns it off,
 * since whoever asked may be a kid. The card shows the new text, so whoever says yes sees what to.
 * host: the bridge's host (host.js): no host (a laptop) has no card to put up and keeps no PIN.
 */
export async function rulesPin(host, text) {
  if (!host.there()) return null;
  const r = await host.call('/approve', { title: 'Change the house rules?', detail: text || 'No house rules.', pin: true, grownup: true, yes: 'Save' }, { ms: 100e3 });
  if (r?.ok && r.body?.yes === true) return null;
  return r?.ok && r.body?.answered === true && !r.body?.why
    ? 'Not changed: nobody typed the PIN on the device. Say so; they can ask again at the device.'
    : 'Not changed: the house rules need the PIN, and the device can\'t ask for it right now. Someone can change them in Settings, Opie, House rules.';
}

/** The tool's handler: read() -> what's kept (undefined: the defaults), save(text | null) -> the rules now (null: back to the defaults). */
export function houseRulesCall({ read, save, host }) {
  const ok = (t) => ({ content: [{ type: 'text', text: t }] }), no = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
  return async (name, a = {}) => {
    if (name !== RULES_TOOL.name) return no(`No tool ${name}.`);
    const now = rulesNow(read());
    if (a.do !== 'set' && a.do !== 'defaults') return ok(now ? `The house rules${read() == null ? ' (the defaults)' : ''}:\n${now}` : 'No house rules.');
    const text = a.do === 'defaults' ? DEFAULT_RULES : cleanRules(a.text);
    if (text === now) return ok('Already so.');
    const why = await rulesPin(host, text);
    if (why) return no(why);
    const kept = save(a.do === 'defaults' ? null : text);
    return ok(kept ? `Saved. The house rules now:\n${kept}` : 'Saved: no house rules now.');
  };
}

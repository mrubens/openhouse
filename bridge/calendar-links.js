// add_calendar: a family calendar's private link, from the workshop (someone's computer) or a typed chat, handed
// straight to the shell (DeviceServer /calendar), which keeps the links sealed with its own key and asks someone on
// the tablet (the PIN). The link is never written here: not to a file, a result or a log.
// add_photo_album: the same for an iCloud shared album's public link (the shell's PhotoAlbums.kt keeps it in step).
import fs from 'node:fs';

/** A call to the shell's device server (DeviceServer.kt's home paths), with its token from the agents' MCP config. */
export async function shellCall(p, b, { config = () => process.env.DEVICE_MCP_CONFIG, timeoutMs = 100e3 } = {}) {
  let d; try { d = JSON.parse(fs.readFileSync(config(), 'utf8')).mcpServers.device; } catch { return { error: 'This only works on the display.' }; }
  try {
    const r = await fetch(d.url.replace(/\/mcp$/, '') + p, { method: 'POST', headers: { authorization: d.headers.Authorization, 'content-type': 'application/json' }, body: JSON.stringify(b), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? j : { error: j.error || `The display said ${r.status}.` };
  } catch { return { error: 'The display didn\'t answer.' }; }
}

export function calendarLinkTools({ config = () => process.env.DEVICE_MCP_CONFIG, timeoutMs = 100e3 } = {}) {
  const toShell = (p, b) => shellCall(p, b, { config, timeoutMs });
  const tools = [{ name: 'add_calendar', description: 'When they want only part of a calendar ("just the home games", "only football"), always put that in only: without it every event in the calendar is added. Adding a calendar that is already there again replaces it, so this also changes an added calendar\'s name or which events it keeps. Add one of the family\'s calendars (Google, iCloud, Outlook) by its private link (an https:// or webcal:// address, usually ending .ics; in Google Calendar: Settings, the calendar, "Secret address in iCal format"). The link goes straight to the display, which keeps it sealed (you never see it again, and it isn\'t kept in the house), and someone says yes there (no PIN); this waits for them, up to a minute and a half. Never repeat the link back. Also a public calendar they want to follow (a team\'s or a league\'s schedule, a school\'s or a town\'s events, holidays): when they don\'t have its link, search the web for the official subscribe link (an .ics or webcal:// address, often behind an "iCal", "Subscribe" or "Sync to calendar" button on the schedule page) and add that; college and pro team sites built on Sidearm serve every sport\'s schedule at <site>/calendar.ashx/calendar.ics. Without a link and none to be found: tell them the easy ways, the Calendar tab\'s "Add a calendar" on the display (paste it there), or sending the link to you here.', inputSchema: { type: 'object', required: ['link'], properties: { name: { type: 'string', description: 'For a calendar that isn\'t a person\'s, its name as the family would say it ("Michigan home games").' }, only: { type: 'string', description: 'Required whenever they asked for only some of its events: which ones, in their words ("home games", "football and hockey"). The display keeps just those; leave it out only when they want everything.' }, link: { type: 'string', description: 'The calendar\'s link, as they gave it.' }, who: { type: 'string', description: 'Whose calendar it is (a name from the household), if they said.' } } } },
    { name: 'add_photo_album', description: 'Keep an iCloud shared album\'s photos on the display (Photos, Today\'s photo, the idle screen), up to date as people add to it: by the album\'s public link (https://www.icloud.com/sharedalbum/#..., or on iOS 27 and later https://photos.icloud.com/shared/album/...; in Photos on an iPhone or Mac, the album\'s sharing settings: turn on its public link or Public Website, then copy it). A dedicated album for the display ("Kitchen", say) works best. The link goes straight to the display, which keeps it sealed, and someone says yes there with the PIN; this waits for them, up to a minute and a half. Never repeat the link back. Without a link: tell them how to get one, or that the Photos tab has "Add an iCloud album". Google Photos albums can\'t be linked this way.', inputSchema: { type: 'object', required: ['link'], properties: { link: { type: 'string', description: 'The album\'s link, as they gave it.' } } } }];
  async function call(name, a, ctx) {
    if (name === 'add_photo_album') {
      const r = await toShell('/album', { url: String(a?.link || '').trim(), from: ctx?.who || (ctx ? '' : 'a computer') });
      const text = r.error ? r.error : r.added ? 'Added the album: its photos come into Photos over the next few minutes, and new ones within half an hour of being added.' : 'Not added: someone said no, or nobody answered on the tablet.';
      return { content: [{ type: 'text', text }], isError: !!r.error || !r.added };
    }
    const who = String(a?.who || '').trim().slice(0, 40);
    const title = String(a?.name || '').trim().slice(0, 60), only = String(a?.only || '').trim().slice(0, 200);
    const r = await toShell('/calendar', { url: String(a?.link || '').trim(), who, name: title, only, from: ctx?.who || (ctx ? '' : 'a computer') });
    const text = r.error ? r.error : r.added ? `Added ${title || (who ? `${who}'s calendar` : 'the calendar')}${only ? ` (only ${only})` : ''}: its events show in the Calendar within a minute${only ? ' or two' : ''}.` : 'Not added: someone said no, or nobody answered on the tablet.';
    return { content: [{ type: 'text', text }], isError: !!r.error || !r.added };
  }
  return { tools, call, toShell };
}

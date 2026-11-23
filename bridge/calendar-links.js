// add_calendar: a family calendar's private link, from the workshop (someone's computer) or a typed chat, handed
// straight to the shell (DeviceServer /calendar), which keeps the links sealed with its own key and asks someone on
// the tablet (the PIN). The link is never written here: not to a file, a result or a log.
// add_photo_album: the same for an iCloud shared album's public link (the shell's PhotoAlbums.kt keeps it in step).
import fs from 'node:fs';

export function calendarLinkTools({ config = () => process.env.DEVICE_MCP_CONFIG, timeoutMs = 100e3 } = {}) {
  const toShell = async (p, b) => {
    let d; try { d = JSON.parse(fs.readFileSync(config(), 'utf8')).mcpServers.device; } catch { return { error: 'This only works on the display.' }; }
    try {
      const r = await fetch(d.url.replace(/\/mcp$/, '') + p, { method: 'POST', headers: { authorization: d.headers.Authorization, 'content-type': 'application/json' }, body: JSON.stringify(b), signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => ({}));
      return r.ok ? j : { error: j.error || `The display said ${r.status}.` };
    } catch { return { error: 'The display didn\'t answer.' }; }
  };
  const tools = [{ name: 'add_calendar', description: 'Add one of the family\'s calendars (Google, iCloud, Outlook) by its private link (an https:// or webcal:// address, usually ending .ics; in Google Calendar: Settings, the calendar, "Secret address in iCal format"). The link goes straight to the display, which keeps it sealed (you never see it again, and it isn\'t kept in the house), and someone says yes there with the PIN; this waits for them, up to a minute and a half. Never repeat the link back. Without a link: tell them the easy ways, the Calendar tab\'s "Add a calendar" on the display (paste it there), or sending the link to you here.', inputSchema: { type: 'object', required: ['link'], properties: { link: { type: 'string', description: 'The calendar\'s link, as they gave it.' }, who: { type: 'string', description: 'Whose calendar it is (a name from the household), if they said.' } } } },
    { name: 'add_photo_album', description: 'Keep an iCloud shared album\'s photos on the display (Photos, Today\'s photo, the idle screen), up to date as people add to it: by the album\'s public link (https://www.icloud.com/sharedalbum/#..., or on iOS 27 and later https://photos.icloud.com/shared/album/...; in Photos on an iPhone or Mac, the album\'s sharing settings: turn on its public link or Public Website, then copy it). A dedicated album for the display ("Kitchen", say) works best. The link goes straight to the display, which keeps it sealed, and someone says yes there with the PIN; this waits for them, up to a minute and a half. Never repeat the link back. Without a link: tell them how to get one, or that the Photos tab has "Add an iCloud album". Google Photos albums can\'t be linked this way.', inputSchema: { type: 'object', required: ['link'], properties: { link: { type: 'string', description: 'The album\'s link, as they gave it.' } } } }];
  async function call(name, a, ctx) {
    if (name === 'add_photo_album') {
      const r = await toShell('/album', { url: String(a?.link || '').trim(), from: ctx?.who || (ctx ? '' : 'a computer') });
      const text = r.error ? r.error : r.added ? 'Added the album: its photos come into Photos over the next few minutes, and new ones within half an hour of being added.' : 'Not added: someone said no, or nobody answered on the tablet.';
      return { content: [{ type: 'text', text }], isError: !!r.error || !r.added };
    }
    const who = String(a?.who || '').trim().slice(0, 40);
    const r = await toShell('/calendar', { url: String(a?.link || '').trim(), who, from: ctx?.who || (ctx ? '' : 'a computer') });
    const text = r.error ? r.error : r.added ? `Added ${who ? `${who}'s calendar` : 'the calendar'}: its events show in the Calendar within a minute.` : 'Not added: someone said no, or nobody answered on the tablet.';
    return { content: [{ type: 'text', text }], isError: !!r.error || !r.added };
  }
  return { tools, call, toShell };
}

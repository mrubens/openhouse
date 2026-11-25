// Reading a web page for the voice and typed turns ("what's for lunch at school this week?"): web search finds the page,
// this reads it. The tablet fetches it itself, like a browser would; only public https and http pages, never the home
// network (the tablet sits on it: a page on 192.168.x or a .local name could be someone's router or camera). The
// checks and the fetch are app-web.js publicGet: each hop's addresses checked, and the one checked is the one reached.
import { publicGet, pinnedFetch } from './app-web.js';
import { textFromHtml } from './cooking.js';

export { privateIp } from './app-web.js';

const SAY = { address: 'That isn\'t a web address.', protocol: 'Only web pages (http or https).', signin: 'That page didn\'t open.', home: 'Not a page on the home network.',
  notfound: 'That site couldn\'t be found.', timeout: 'That page took too long to open.', failed: 'That page didn\'t open.', redirects: 'That page kept sending me elsewhere.' };

/** A page's readable text: {title, text, url} or {error}. */
export async function readPage(link, { fetch = pinnedFetch, lookup, timeoutMs = 12000, max = 12000 } = {}) {
  const r = await publicGet(link, { http: true, fetch, lookup, timeoutMs, max: 3e6, headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) OpenHouse', accept: 'text/html,text/plain,*/*' } });
  if (r.error) return { error: SAY[r.error] || SAY.failed };
  if (r.status < 200 || r.status > 299) return { error: `That page didn't open (${r.status}).` };
  if (!/text\/html|text\/plain|xml/.test(r.type)) return { error: `That's not a page to read (${r.type || 'unknown'}).` };
  const body = r.buf.toString('utf8').slice(0, 3e6);
  if (/text\/plain/.test(r.type)) return { url: r.url.href, title: '', text: body.slice(0, max) };
  const { title, text } = textFromHtml(body, max);
  return { url: r.url.href, title, text: text || '(nothing readable on it)' };
}

export const READ_PAGE_TOOL = { name: 'read_page', description: 'Read a web page\'s text, to answer from it: a school lunch menu, opening hours, a sign-up page, an article. Find the page with web search first when you don\'t know its address. Public pages only.',
  inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'The page\'s address, https://...' } } } };

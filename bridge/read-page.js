// Reading a web page for the voice and typed turns ("what's for lunch at school this week?"): web search finds the page,
// this reads it. The tablet fetches it itself, like a browser would; only public https and http pages, never the home
// network (the tablet sits on it: a page on 192.168.x or a .local name could be someone's router or camera).
import dns from 'node:dns/promises';
import net from 'node:net';
import { textFromHtml } from './cooking.js';

export const privateIp = (ip) => {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  const x = ip.toLowerCase(); return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:') && privateIp(x.slice(7));
};

/** A page's readable text: {title, text, url} or {error}. */
export async function readPage(link, { fetch = globalThis.fetch, timeoutMs = 12000, max = 12000 } = {}) {
  let url; try { url = new URL(String(link || '').trim()); } catch { return { error: 'That isn\'t a web address.' }; }
  for (let hops = 0; hops < 5; hops++) {
    if (!/^https?:$/.test(url.protocol)) return { error: 'Only web pages (http or https).' };
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (/^(localhost|.*\.local|.*\.lan|.*\.home|.*\.internal)$/i.test(host)) return { error: 'Not a page on the home network.' };
    let ips = []; try { ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address); } catch { return { error: 'That site couldn\'t be found.' }; }
    if (!ips.length || ips.some(privateIp)) return { error: 'Not a page on the home network.' };
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
    let r;
    try { r = await fetch(url, { signal: ac.signal, redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) OpenHouse', accept: 'text/html,text/plain,*/*' } }); }
    catch (e) { clearTimeout(t); return { error: e.name === 'AbortError' ? 'That page took too long to open.' : 'That page didn\'t open.' }; }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { clearTimeout(t); url = new URL(r.headers.get('location'), url); continue; } // (each hop checked again)
    try {
      if (!r.ok) return { error: `That page didn't open (${r.status}).` };
      const type = r.headers.get('content-type') || '';
      if (!/text\/html|text\/plain|xml/.test(type)) return { error: `That's not a page to read (${type.split(';')[0] || 'unknown'}).` };
      const body = (await r.text()).slice(0, 3e6);
      if (/text\/plain/.test(type)) return { url: url.href, title: '', text: body.slice(0, max) };
      const { title, text } = textFromHtml(body, max);
      return { url: url.href, title, text: text || '(nothing readable on it)' };
    } finally { clearTimeout(t); }
  }
  return { error: 'That page kept sending me elsewhere.' };
}

export const READ_PAGE_TOOL = { name: 'read_page', description: 'Read a web page\'s text, to answer from it: a school lunch menu, opening hours, a sign-up page, an article. Find the page with web search first when you don\'t know its address. Public pages only.',
  inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'The page\'s address, https://...' } } } };

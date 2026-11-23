// AGENT=fake-chat: streams a canned answer (fixtures/pasta.txt) for testing the chat page.
import fs from 'node:fs';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export { run } from './fake.js';
export async function chat({ onEvent, signal }) {
  onEvent({ kind: 'session', id: 'fake-session' });
  onEvent({ kind: 'status', text: 'Searching the web' }); await wait(800);
  const text = fs.readFileSync(new URL('../fixtures/pasta.txt', import.meta.url), 'utf8');
  for (let i = 0; i < text.length; i += 60) { if (signal?.aborted) break; onEvent({ kind: 'delta', text: text.slice(i, i + 60) }); await wait(25); }
  return { ok: true, text, sessionId: 'fake-session' };
}

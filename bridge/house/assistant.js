// The house's ways to the assistant and the shell: one answer from the household's assistant with no tools (the
// Meals app's buttons, a flyer or a recipe photo), whether there is one, and a call to the shell (its "Is this OK?" card).
import fs from 'node:fs';

export default function (house) {
  const { currentAgent, agentName, homeScreen, WORK } = house;
  const shellCfg = () => { try { const d = JSON.parse(fs.readFileSync(process.env.DEVICE_MCP_CONFIG, 'utf8')).mcpServers.device; return { base: d.url.replace(/\/mcp$/, ''), auth: d.headers.Authorization }; } catch { return null; } };
  async function shell(p, b, ms = 3000) {
    const s = shellCfg();
    if (!s) return null;
    try { const r = await fetch(s.base + p, { method: 'POST', headers: { authorization: s.auth, 'content-type': 'application/json' }, body: JSON.stringify(b), signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; }
  }
  /** One answer from the assistant, with no tools (the Meals app's buttons; a flyer or recipe photo in images). */
  async function answer(prompt, sys, images = [], { webSearch = false } = {}) {
    const agent = await currentAgent();
    if (agent.answer) return String(await agent.answer({ instructions: sys, prompt, images, webSearch })); // the cloud's text model (agents/cloud.js)
    if (webSearch) throw new Error('Searching the web needs the cloud assistant.');
    if (!agent.chat) throw new Error('no assistant');
    const go = (run) => agent.chat({ prompt, cwd: WORK, systemPrompt: sys, onEvent: () => {}, resume: null, homeToken: run?.token, route: false });
    const r = homeScreen ? (await homeScreen.during({ by: 'assistant' }, go)).result : await go(null);
    if (!r?.ok) throw new Error(r?.text || 'no answer');
    return String(r.text);
  }
  /** Does this need the assistant, and is there none? Its words, else null. */
  const noAssistant = (what) => !currentAgent || ['off', 'none'].includes(agentName())
    ? `${what} needs the assistant, and it isn’t on yet (Settings → Voice).` : null;
  return { shellCfg, shell, answer, noAssistant };
}

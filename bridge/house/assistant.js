// The house's ways to the assistant and the shell: one answer from the household's assistant with no tools (the
// Meals app's buttons, a flyer or a recipe photo), whether there is one, and a call to the shell (its "Is this OK?" card).
import { host } from '../host.js';

export default function (house) {
  const { currentAgent, agentName, homeScreen, WORK } = house;
  const shell = (p, b, ms = 3000) => host.json(p, b, ms);
  /** Is there a host to ask "Is this OK?" (none on a laptop)? */
  const canAsk = () => host.can('approve');
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
    ? `${what} needs an Opie account or your own OpenAI key (Settings → Opie → Voice).` : null;
  return { canAsk, shell, answer, noAssistant };
}

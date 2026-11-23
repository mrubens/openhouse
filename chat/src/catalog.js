// The components the assistant may answer with. Shared by the chat page (rendering) and the
// bridge (catalog.prompt() is written to bridge/chat-prompt.md by `npm run prompt`).
// Built for a kitchen wall: big type, touch targets, read from across the room.
import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/react/schema';
import { z } from 'zod';

const seconds = z.number().int().positive().describe('Duration in seconds');

export const catalog = defineCatalog(schema, {
  components: {
    Stack: {
      props: z.object({ direction: z.enum(['vertical', 'horizontal']).nullable(), gap: z.enum(['small', 'medium', 'large']).nullable() }),
      slots: ['default'],
      description: 'Lays out children in a column (default) or a wrapping row.',
    },
    Card: {
      props: z.object({ title: z.string().nullable(), subtitle: z.string().nullable() }),
      slots: ['default'],
      description: 'A panel grouping related content, with an optional title.',
    },
    Heading: {
      props: z.object({ text: z.string(), level: z.enum(['1', '2', '3']).nullable() }),
      description: 'A heading. Level 1 is the largest.',
    },
    Text: {
      props: z.object({ text: z.string(), tone: z.enum(['normal', 'muted', 'large']).nullable() }),
      description: 'A paragraph. Supports **bold** and *italic*. Keep it short: this is read standing up.',
    },
    List: {
      props: z.object({ items: z.array(z.string()), ordered: z.boolean().nullable() }),
      description: 'A plain bulleted or numbered list.',
    },
    Checklist: {
      props: z.object({ title: z.string().nullable(), items: z.array(z.string()) }),
      description: 'A list the family can tick off by tapping (ingredients, packing, chores). Ticks are remembered while the answer is open.',
    },
    Steps: {
      props: z.object({
        title: z.string().nullable(),
        steps: z.array(z.object({
          text: z.string().describe('One instruction, one or two sentences'),
          need: z.array(z.string()).nullable().describe('What this step uses, e.g. "2 eggs", "whisk"; shown with the step'),
          timerSeconds: z.number().int().positive().nullable().describe('If this step involves waiting, how long'),
          timerLabel: z.string().nullable().describe('Short name for that timer, e.g. "Dough rest"'),
        })),
      }),
      description: 'Step-by-step instructions shown one step at a time in very large type with Back/Next, so someone can follow along with messy hands. Steps with timerSeconds get a one-tap timer button; "need" lists what that step uses, shown with it. Use this for any how-to (recipes, crafts, fixes).',
    },
    Timer: {
      props: z.object({ label: z.string(), seconds }),
      description: 'A button that starts a real timer on the display. The timer keeps running and rings even if the conversation is closed.',
    },
    Video: {
      props: z.object({
        url: z.string().describe('A real YouTube watch URL you found with web search. Never invent one.'),
        title: z.string(),
        channel: z.string().nullable(),
        why: z.string().nullable().describe('One line on why this video is worth watching'),
      }),
      description: 'A YouTube video card with thumbnail. Tapping plays it full screen.',
    },
    Image: {
      props: z.object({ url: z.string().describe('A real image URL from your search results. Never invent one.'), caption: z.string().nullable() }),
      description: 'A picture.',
    },
    Tip: {
      props: z.object({ text: z.string(), tone: z.enum(['tip', 'warning']).nullable() }),
      description: 'A highlighted tip or warning.',
    },
    Stat: {
      props: z.object({ label: z.string(), value: z.string() }),
      description: 'A big number or fact with a label (e.g. "Total time" / "1 h 15 min"). Put several in a horizontal Stack.',
    },
    Button: {
      props: z.object({ label: z.string(), style: z.enum(['primary', 'secondary']).nullable() }),
      description: 'A button. Bind its "press" event to an action with "on".',
    },
    Suggestions: {
      props: z.object({ items: z.array(z.string()).describe('2-4 short follow-up questions the family might ask next, in their voice') }),
      description: 'Tappable follow-up questions. Tapping one asks it.',
    },
  },
  actions: {
    ask: {
      params: z.object({ text: z.string() }),
      description: 'Ask the assistant a follow-up, as if the family said it.',
    },
    startTimer: {
      params: z.object({ label: z.string(), seconds }),
      description: 'Start a timer on the display.',
    },
  },
});

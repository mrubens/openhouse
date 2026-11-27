// Safe mode (Settings): no agent at all. Every run and conversation answers at once that it's off,
// and the hourly curation of the notes fails quietly. The shell turns it on by writing files/display/safe-mode.
const text = 'Safe mode is on, so I can’t do anything right now. Someone can turn it off in Settings → Advanced.';

export async function run() { return { ok: false, text }; }
export async function chat() { return { ok: false, text }; }

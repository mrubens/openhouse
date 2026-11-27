// No assistant to answer typed turns yet: the tablet isn't linked to a family account with OpenAI chosen (Settings →
// Live voice). Everything that needs one says so plainly; the home screen and its apps work as ever.
export const NOT_YET = "I can't answer yet: someone turns me on in Settings → Opie → Voice (it needs the device linked to your Opie account).";
export async function chat() { return { ok: false, text: NOT_YET }; }
export async function run() { return { ok: false, text: NOT_YET }; }

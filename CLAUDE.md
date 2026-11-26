# Working on Opie

Standing rules for anyone (person or agent) changing this repo.

## No real people or places in anything public

This repo is public, and so is everything around it on GitHub: code, comments, tests, sample data, docs, screenshots,
commit messages, branch names, issues and PRs. Never put a real household's specifics in any of them: people's names,
the town, schools and school menu links, addresses, devices and their serials, Wi-Fi names, calendars, recipes,
photos, or a screenshot that shows any of these. Use the sample household instead: Sam, Alex, Maya and Leo, in
Springfield, at Maple Elementary (Nutrislice district `springfield`); `webapp/src/data.js` has the rest. Quoting
what someone asked for is fine once the names and details in it are swapped for the sample ones. Real values belong
in the tablet's own setup and data, never in the repo. Before publishing a screenshot, look at it for any of the above.

## Tests only where breakage is costly

Don't write tests unless they are absolutely critical. The ones that earn their place:

- The bridge loads and serves at all (`bridge/test/smoke.test.mjs`).
- Security: pairing, scopes, tokens and keys, what a screen, phone or app may reach, the PIN and person-only rules,
  sealed traffic.
- Household data safety: nothing lost, backups and restore, no duplicate calendar events, undo not losing changes.
- The cloud: auth, rate limits and cost caps, the release manifest.

Never assert exact prose or wording (prompts, replies, UI copy). Don't add tests for trivia or to repeat what another
test already covers.

Run them with `cd bridge && npm test` and `cd shell && ./gradlew -q :app:testReleaseUnitTest`; the cloud's with
`scripts/cloud.sh npm test`.

## No word lists for what people say

Never hardcode words or phrase lists to interpret what someone said ("stop", "next", "never mind"). Ask a model for
the judgment, with the conversation as context.

## Opie can do what a tap can

Anything someone can do by tapping on the tablet or the phone page, Opie can do when asked: when you add or change a
feature, give Opie the same reach (a tool in `bridge/live-tools.js` LIVE_TOOLS, `bridge/home-screen.js` or
`bridge/house.js`), and add the row to `docs/opie-parity.md`. Where a tap needs the PIN, Opie doesn't refuse: it goes
ahead and the tablet asks a person for the PIN (Opie never sees, hears or skips it). The only things that stay a
person's own are approvals that must be a person's tap (DeviceServer.personOnly), and the few that table lists.

## Screens say as little as they can

Every screen, the setup most of all, should be clear to someone who has never seen Opie, with nothing more on it than that
needs. Before adding a line, ask whether anyone would miss it. `docs/ux.md` has the full house rules.

- A title, at most one short line under it, then what to do. No list of what's coming, no "this page follows along",
  no reasons nobody asked for.
- Don't repeat what's already on screen: a placeholder that names the input, a button that names the action, the other
  screen showing the same thing (the tablet's "Try it" line isn't on the phone too).
- One filled button per screen: the next step (Next, Done, the verb). A step's own actions (Add, Sign in, Turn on) are
  tinted. When an action and Next would do the same job, make them one button (the setup's PIN: Next sets it).
- No developer words in the UI: file paths, docs, protocol names.
- Keep inputs and the main button high on phone screens, so the keyboard never covers them.
- When you change words, check every copy that says the same thing (tablet, phone page, web) and fix any that are now
  wrong.

## The cloud is its own private repo

The hosted cloud service is in mrubens/openhouse-cloud (private: only its maintainers have it), checked out next to
this repo or at `~/Code/openhouse-cloud`; nothing of it is in this repo, and everything here works without it. `scripts/cloud.sh <command>` runs a command there with `OPENHOUSE` set to this checkout. Commit cloud
changes in that repo, and give files from here as absolute paths.

- Deploy: `AWS_PROFILE=openhouse-admin scripts/cloud.sh scripts/deploy.sh --diff`, then without `--diff`. Its
  `cdk.context.json` stays in that checkout (copied from `~/.openhouse/cloud/` when it has none).
- Publish: `AWS_PROFILE=openhouse-admin scripts/cloud.sh node scripts/release.ts "$PWD/dist/…/display.apk" --rescue … --channel stable`.
- After changing `chat/src/phone.jsx` (or `list.html` / `share.html`): `scripts/cloud.sh node scripts/phone-app.ts`
  (or `phone-pages.ts`), then `scripts/cloud.sh npm test`, commit there and deploy.
- The relay protocol (`bridge/relay.js`, `bridge/screens.js`, `chat/src/relay-client.js`) changes together with the
  cloud's `lambda/relay.ts`, `connector.ts` and `send.ts`. The bridge's cloud tests run the service from that
  checkout and are skipped without one. More in `docs/cloud.md`.

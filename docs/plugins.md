# Sharing what a family made: a proposal

> **Status (1.0.9):** pi is off the tablet (docs/assistant.md), so the assistant-skills half of this (the `pi` key, `--skill`) has nothing to load into. Apps, looks, voice actions and checks are unchanged.

**Status: v1 built (apps and looks from a link; §9 says what is there and what is not). Decisions (2026-11-19) are in §10. Since then every app is a plugin, whoever made it (§11).** The idea is
that one family's chore chart for twins, swim-meet countdown or homeschool timetable can be picked up by another
family and changed again by talking. This page covers what can be shared, the format, how a family installs one, where
plugins are hosted, what keeps it safe on a kids' device, and the smallest first version. Open questions
are at the end.

## Recommendation in one paragraph

**An OpenHouse plugin is a pi package with one more key.** It is a folder with a `package.json`:
- pi's own `pi` key carries the assistant's pieces (skills, prompt templates), and pi loads them its own way.
- An `openhouse` key carries the tablet's pieces (apps, a look, device recipes), and the bridge installs them.

The first version shares **apps and looks only**. Each one is installed from a link (a git repo or a tarball). The
bridge does the install in three steps:
1. Fetch the plugin at a pinned commit.
2. Show a calm "Is this OK?" card with the PIN.
3. Copy the files into `webapp/` as **one change**, so undo removes it like anything else.

Shared apps run with fewer rights than the family's own apps:
- They get only the house data their `app.json` says they use.
- They can't reach the internet unless they declare where.

Assistant skills come next, through pi's `--skill` and with pi's other discovery switched off. Code that runs outside
an app's page never comes from a plugin: no pi extensions, bridge drivers or heartbeat code. That code arrives only
through OpenHouse updates, or as data the bridge validates (device recipes, and later data-only checks). Hosting
starts as "any public git URL". An index on openhouse.computer comes later, and it is a catalog of reviewed commits,
not a store.

## 1. How pi does it (pi 1.5.2 on the tablet, docs read from 0.78 on the laptop)

- **Four kinds of resources:**
  - **extensions** are TypeScript or JS modules. They get the full `ExtensionAPI`: register tools and commands,
    intercept tool calls, add providers, and run anything (`pi.exec`).
  - **skills** follow the Agent Skills standard: a folder with `SKILL.md` (name and description frontmatter), plus
    scripts and references loaded on demand. Only the descriptions sit in the prompt.
  - **prompt templates** are `.md` files that become `/name` commands.
  - **themes** are JSON color tokens for the TUI. They don't matter to us.
- **A package is an npm-style folder.** `package.json` has `"keywords": ["pi-package"]` and an optional
  `"pi": { "extensions": [...], "skills": [...], "prompts": [...], "themes": [...] }` with globs and `!exclusions`.
  Without that key, pi falls back to the convention folders `extensions/`, `skills/`, `prompts/` and `themes/`.
  Gallery fields `image` and `video` feed pi.dev/packages.
- **Sources:**
  - `npm:@scope/pkg@1.2.3`
  - `git:github.com/user/repo@v1`, or https or ssh URLs, pinned to a tag or commit
  - local paths
- **Install:**
  - `pi install <source>` writes the source to `settings.json` under `packages`: user scope `~/.pi/agent/` or project
    scope `.pi/`.
  - npm packages install to `~/.pi/agent/npm/` and git ones clone to `~/.pi/agent/git/<host>/<path>`, followed by
    `npm install`.
  - `pi -e <source>` tries a package for one run.
  - Versioned sources stay pinned, and `pi update` doesn't move them.
  - The settings can narrow what a package loads, per kind (`"skills": []`, `"!extensions/legacy.ts"`), and
    `pi config` turns individual resources on and off.
  - Project settings install missing packages **automatically on startup**.
- **Discovery happens without any install:**
  - `~/.pi/agent/{extensions,skills,prompts,themes}/`
  - project `.pi/…`, and `.agents/skills/` in cwd and its parent folders
  - `AGENTS.md` and `CLAUDE.md` context files
  - Each kind has a switch to turn it off: `--no-extensions`, `--no-skills`, `--no-prompt-templates`,
    `--no-context-files`. Explicit `-e` and `--skill` paths still load with discovery off.
- **Trust model: none.** The docs say packages "run with full system access" and to "review source code before
  installing". There is no signing, no permissions and no sandbox. Pi is a developer tool on the developer's own
  machine, so that is reasonable there. It is not enough for a kitchen tablet.

**What we take from pi:**
- the package shape (`package.json` plus a key per kind)
- the sources (npm, git and local, pinned)
- the skill format, unchanged, so a skill written for pi, Claude Code or Codex works here too
- per-kind filtering
- loading the assistant's pieces through pi's own `--skill` / `-e`, rather than our own loader

**What we don't take:**
- running arbitrary extensions from a package
- auto-install from settings
- auto-discovery in folders the agent itself can write

## 2. What a "customization" is in OpenHouse today

All paths are under the display folder (`files/display/` in the shell).

| Piece | Where it lives | Made by | Undo | In backups | Shareable as is? |
|---|---|---|---|---|---|
| **An app** | `webapp/apps/<id>/`: flat files `app.json` (`{"name"}`, optional `screensaver`, `tabIcon`: chat/src/tab-icons.js, `today`: §15), `icon.svg`, `index.html`, `main.js`, more js/css, optional `widget.html` (its card on Today, §15) | the assistant, the builder, the workshop MCP `write_file` | git, one commit per change (`bridge/edits.js`) | yes | **Yes.** It's a folder, and the family's data isn't in it (next row) |
| The app's data | lists, chores, meals, events, rewards in `house.json` (`bridge/house.js`); app-private data in `appdata/<id>/*.json` | the app, through `/kit/openhouse.js` | no | yes | No. It is the family's |
| **Tabs and look** | `webapp/apps/home/style.json`: `tabs`, `palette` (paper/linen/sage/mist/dusk), `colors {bg, sheet, ink, accent}`, `type` (clean/serif/round/hand), `density`, `backdrop` | `set_home`, the Tabs and look sheet (`setLook`) | git | yes | **Yes**, the look keys. The tabs are a suggestion (they name the family's own apps) |
| Notes, widgets, timers | `chats/door.json` | the assistant, the family | trash and `put_back` | yes | No, these are this week's |
| **The assistant's rules** | `bridge/CHAT.md`, `DOOR.md`, `AGENT.md`, `CURATE.md`, `HEARTBEAT.md`, `chat-prompt.md`: shipped, replaced on every update | us | — | no | No. They're ours |
| The family's preferences | `preferences.md`: up to 40 one-line bullets, injected as "they win over the defaults" | `remember_preference` | no | yes (since c1792f6) | Not really. They're personal ("Leo is allergic to nuts") |
| The assistant's skills | **none.** Pi gets no `--skill`, no settings and no project `.pi/` (the box only syncs `apps/`) | — | — | — | (this proposal) |
| **Heartbeat checks** | code: six functions in `bridge/heartbeat.js`, what to do per kind in `HEARTBEAT.md` | us | — | — | Not as code. Possibly as data later (§4) |
| **Device drivers** | code: `bridge/devices/drivers/*.js`, a fixed import list | us | — | — | No |
| **Device recipes** | data: `devices.json`, validated by `bridge/devices/recipe.js` (http, udp or wait steps, LAN only, risky words force approval) | `save_recipe` | no | yes | **Yes.** They're data, and the bridge already checks them |

Building blocks that already exist:
- **Seeding with an update rule** (`device/runtime-start.sh`). Starting apps are copied in once. A newer one replaces
  the family's copy only if every commit touching it came from us. Ports replace an old app only if its sha256
  matches. That is exactly the update rule a shared app needs.
- **One change = one git commit** on `webapp/`, and `undo_latest` reverts it. An install that lands as one commit is
  undone with no new code.
- **The approval card** `POST /approve {title, detail, pin}` (shell `DeviceAccess.approve`). It blocks the agent's
  tool call until a person answers, and the agent can't answer it. Rewards and risky device actions use it.
- **Per-app keys.** Every app call carries `x-openhouse-key`, an HMAC of the app id. `APP_RULES` (`bridge/apps.js`)
  already decides which routes an app may call. Today that list is the same for every app.
- **The workshop MCP** (`bridge/workshop.js`): a paired computer with scope `workshop` changes apps through the same
  edit lock.

**A gap found on the way, now fixed (c1792f6):** pi's cwd in the agent's app is the app folder, and pi used to start
without `--no-extensions` or `--no-skills`, so anything the agent wrote into pi's folders would load on pi's next
start. pi now starts with `--no-extensions --no-skills --no-prompt-templates --no-themes` and loads only what the
bridge names (`-e builtin:mcp`, pi-web-access). That is the base plugin skills build on: the bridge adds `--skill`
paths for installed plugins, and nothing else gets in.

## 3. The shareable unit: an OpenHouse plugin

A plugin is a folder, a git repo or a tarball:

```
twins-chores/
  package.json
  README.md               what a family reads before taking it (shown on the card and the index page)
  preview.png             1280x800, shown before install
  apps/
    twins-chores/         an app folder exactly as on the tablet
      app.json
      icon.svg
      index.html
      main.js
  looks/
    sage-quiet.json       the look keys of style.json only
  skills/                 a pi skill, unchanged format
    swim-meet-week/
      SKILL.md
  devices/
    projector-x100.json   a device recipe (recipe.js format)
```

```json
{
  "name": "twins-chores",
  "version": "1.2.0",
  "description": "A chore chart for two kids who share a room: one column each, swaps on Saturdays.",
  "keywords": ["openhouse-plugin", "pi-package"],
  "license": "MIT",
  "openhouse": {
    "apps": ["apps/twins-chores"],
    "looks": ["looks/sage-quiet.json"],
    "devices": ["devices/projector-x100.json"],
    "tabs": [{ "app": "twins-chores", "name": "Chores" }],
    "image": "preview.png",
    "made": "2026-11-19"
  },
  "pi": { "skills": ["skills"], "extensions": [] }
}
```

**Rules:**
- Paths are relative to the root, as in pi. With no `openhouse` key, the convention folders `apps/`, `looks/`,
  `devices/` and `skills/` are used.
- `pi.extensions` must be empty (§5). The installer refuses a plugin with extensions, and also refuses
  `node_modules`, symlinks, `.git` inside an app, files over 5 MB and more than 200 files.
- `tabs` are **offered**, never forced: the card asks "Add a Chores tab?".
- **An app's `app.json` gains two optional fields:**
  - `uses`: which house data and abilities it needs, e.g. `["chores", "rewards", "say", "store"]`. The names map onto
    `APP_RULES` route groups: lists, chores, meals, events, rewards, checklists, photos, weather, say, timer, phone,
    store, home (`/door`, `/board`).
  - `reaches`: which outside hosts it may fetch, e.g. `["api.open-meteo.com"]`, or `"*.example.com"` for any name
    under example.com (§12).
  - The family's own apps don't need either field and keep everything, as today. The fields bind shared apps (§5).
- **Because it is a pi package too**, the same repo installs on a laptop with `pi install git:…` (for its skills),
  and npm works if someone wants to publish there. We don't need npm ourselves.

**What is never in a plugin:**
- house data, `appdata`, photos, notes, `household.json`, `preferences.md`, sign-ins
- code for the bridge or the shell

Starter data (a set of chores, a morning routine) is plausible later as a declared, previewed `data/` file that goes
in through the house tools. It is left out of v1.

## 4. Each kind of piece

| Piece | v1? | How it installs | Runs where | Undo |
|---|---|---|---|---|
| App | **yes** | copied into `webapp/apps/<id>/`. A clashing id becomes `<id>-2`. Tabs added if the family says yes | the app's WebView, with its `uses` and `reaches` enforced | one git commit |
| Look | **yes** | `setLook` with the look keys only (`cleanLook` validates) | nothing runs | one git commit (the same as the app's, if both) |
| Assistant skill | **v2** | copied into `webapp/assistant/skills/<pkg>/<skill>/` (git, so undo covers it), synced into the agent's app read-only, passed to pi as `--skill` | read by the model when the description matches. It can only ask the model to use tools it already has | one git commit |
| Prompt template | v2, maybe | as skills (`--prompt-template`). There's no `/` on a tablet, so little use beyond the workshop | — | — |
| Device recipe | **v2** | `save_recipe` with recipe.js's `validate()`; risky actions still ask | the bridge, as data, to the device's own LAN address | remove the recipe |
| Heartbeat check | later | needs a **data-only check format** first: "when <house data condition> then a finding with this text", e.g. "no chores ticked by 7 PM". Interpreted by the bridge, never executed | the bridge | remove |
| pi extension | **no** (only ours) | only as part of an OpenHouse update, pinned in the image like pi-web-access | — | — |
| Device driver (JS) | **no** | OpenHouse update | — | — |

For skills, it is pi's mechanism rather than a parallel one. The bridge decides *which* skill folders exist. Pi does
the rest with its own `--skill`: discovery, the descriptions in the prompt, and reading `SKILL.md` on demand.
Families' skills are the same files people share for pi, Claude Code and Codex, so the skill ecosystem comes for free.
The one OpenHouse rule is about tools: a skill can only *ask*, and the tools enforce what's allowed. For example,
"use put_note for the meet schedule" works, while "run this script" fails because a shared skill's `scripts/` are not
copied.

## 5. Safety on a family and kids' device

The threat to plan for is a shared app or skill that, deliberately or by accident:
1. sends the family's data somewhere (names, calendar, photos),
2. shows a kid something it shouldn't, or
3. breaks the tablet or the assistant.

The measures, in order of how much they carry:

1. **Installing needs someone, always.**
   - Whoever starts it (the assistant, the workshop MCP, a link), the bridge shows the approval card with `pin: true`:
     *"Add "Twins chores" from github.com/…? One app and a look. It can see your chores and rewards. It can't reach
     the internet."* Yes needs the PIN.
   - Nothing the agent sends can answer the card (the existing `/approve` rule).
   - Updates and removals go through the same card. Removals can skip the PIN, since undo is there anyway.
2. **What a shared app may touch is enforced, not asked for nicely.**
   - **House data:** `APP_RULES` becomes per app. The bridge already knows the calling app from its HMAC key. An
     installed app gets only the route groups in its `uses`. It never gets undo, delete, the builder, devices (since
     §14, only their controls, through the card),
     screens or household writes, which is the same as every app today.
   - **The internet:**
     - Today any app page can `fetch` anywhere, and no CSP is set. Shared apps get a CSP from the dev server,
       `default-src 'self'; connect-src 'self' <reaches>; img-src 'self' data: blob: <reaches>`.
     - The shell's WebView blocks off-origin requests outside `reaches` as a second layer
       (`shouldInterceptRequest`).
     - `reaches` is shown on the card, word for word.
     - This is the measure that makes "family data only goes to services they opted into" hold for code someone else
       wrote: the family opts in on the card.
   - The `installed` flag and the granted `uses`/`reaches` live in `webapp/plugins.json` (below), not in the app's
     own `app.json`. An app can't widen its rights by editing itself, and neither can the assistant asked to "make it
     use the calendar too". That change is an update that asks again.
3. **No code outside the page.**
   - Plugins carry no pi extensions, drivers or heartbeat code (§4).
   - pi loads only what the bridge names (fixed in c1792f6, §2). Installed skills are added as explicit `--skill`
     paths. Never give pi a project `settings.json`, so its auto-install can't happen.
   - Not covered yet: `--no-context-files`. An `AGENTS.md` the agent writes in its own copy of the app folder would
     be read at the next start. It is instructions only, no code, but it's one more flag to add.
4. **One change, undoable.**
   - The install is one commit, "Added Twins chores (github.com/x/y @ 3f2a1c9)", and `undo_latest` removes it.
   - Because it is a normal change, the assistant can then change the app by talking, like any other. At that point it
     becomes the family's own version (see updates).
5. **Review before it runs.** The card says what's in the plugin. The assistant can also be asked "what does this
   do?" before Yes: it reads the files with `read_file` through a `look_at_plugin` tool. For the index (§7), a
   person (us) looks at each commit before it is listed. An automated pass runs first: the install validator, a scan
   for `fetch`, `eval`, `new Function` and dynamic `import`, and an AI read of the code against `README.md`.
6. **Kids.** A kid can't install anything, because of the PIN. A shared app shows on the Apps tab like any other. If a
   family wants a "made by another family" marker in the app list, that's a small line on the card in Settings, not a
   badge.

**Not a safety measure:** signing plugins. A pinned commit hash already says "exactly these bytes", and the index
says "we looked at these bytes". Signing adds key management for no gain at this size.

### `webapp/plugins.json`, the lock file (in git, so undo keeps it right)

```json
{
  "twins-chores": {
    "source": "git:github.com/somefamily/twins-chores",
    "commit": "3f2a1c9e…",
    "version": "1.2.0",
    "installed": "2026-11-19T18:02:00Z",
    "apps": { "twins-chores": { "uses": ["chores", "rewards", "say"], "reaches": [], "files": { "main.js": "sha256…", "…": "…" } } },
    "look": true,
    "skills": []
  }
}
```

The bridge reads it at start-up and whenever `webapp/` changes, to build the per-app rules. An app that isn't in it
is the family's own and keeps today's full app rights.

## 6. How a family installs one

The same three steps from every way into the tablet: **fetch and check** (`look_at_plugin {source}`), **show the
card**, **install** (`add_plugin {source}`). All of it lives in a new `bridge/plugins.js`. The bridge does the
fetching, never the agent's app:
- `git clone --depth 1` at the given ref, followed by recording the commit
- or a tarball over https
- or `npm pack` for `npm:` sources

There is no `npm install` and nothing runs.

- **On the tablet, by talking:** "put in the twins chore chart from this link" (the link comes from the phone hand-off
  or a QR code, see the open questions). The assistant calls `look_at_plugin`, says in a sentence what it is, then
  calls `add_plugin`, which waits on the PIN card. The assistant never needs to understand git.
- **From Claude or Codex on the computer (the workshop MCP):**
  - `look_at_plugin` and `add_plugin` show up in the workshop's tool list, with the same card on the tablet.
  - `export_plugin {apps, look?, skills?}` goes the other way. It returns the plugin's files to the computer, where
    Claude or Codex writes them to a folder and, if the person asks, pushes them to *their own* GitHub repo with
    their own `git`. OpenHouse never publishes anything.
- **From a link on openhouse.computer (later):** the index page for a plugin shows the README, the preview, what it
  uses, and a QR code. Scanning it with the family's phone hands the link to the tablet (the phone hand-off that
  exists for flyers and recipes), and the tablet shows the card.
- **From Settings:** a "Plugins" row lists what's installed (source, version, "changed by you" or not),
  with Update and Remove. There's no browsing on the tablet in v1.

**Exporting is where a family's data could leak.**
- Apps don't hold house data, but their code can: "Maya's chores", a photo URL, an address in a countdown. So
  `export_plugin` scans the files for names, places and numbers from `household.json`, house data and
  `preferences.md`, and lists what it found. The assistant then offers to make those generic ("Kid 1") before the
  files leave.
- `appdata`, photos and `preferences.md` are never included.

## 7. Hosting

| Option | For | Against | Verdict |
|---|---|---|---|
| **Any public git repo** (GitHub, GitLab, Codeberg) | free, versioned, forkable ("GitHub for people who'd never call themselves contributors"), pi understands it, pinned commits | a family has to make a repo. Claude or Codex does that for them from the workshop | **v1** |
| An https tarball | simplest to host anywhere | no history | v1, since it's nearly free once git works |
| npm | pi's main channel | needs an npm account, versions are immutable but names squattable, no one in a family has one | accepted as a source because pi does, never required |
| **Our index on openhouse.computer** | discovery by interest ("homeschool", "shared custody week"), a reviewed-commit list, previews | we run and moderate it, which is a review burden | **v2**, a static JSON of `{source, commit, reviewed, tags}` plus pages. It hosts no code: it points at git |
| Hosting the code ourselves (in the cloud service) | one place, takedowns are easy | we're now a code host for kids' devices, with liability | not now |

**Family data rule:**
- Installing from a link contacts only the host in that link, which the person chose on the card.
- Checking for updates contacts the same host, at most once a day, and can be switched off.
- The index is our own service and is only contacted when a family opens it or scans one of its codes.

## 8. Updates

- **Pinned, never automatic.**
  - Once a day the bridge asks each plugin's source for its newest tag or commit: `git ls-remote`, or the index.
  - If there's a newer one, Settings row says "Update available". Optionally, the heartbeat can put one quiet
    note a week on Today.
- **Updating is the same card again**, with what changed: files, and any new `uses` or `reaches`, called out ("now
  also wants to reach api.example.com"). New rights always need the PIN.
- **The family's version wins** (the starting apps' rule).
  - If the installed app's files still match the hashes in `plugins.json`, the update replaces them as one commit.
  - If the family changed the app ("make the stars bigger"), the card says so and offers two choices:
    - *Keep yours* is the default. The app stops tracking updates and becomes theirs.
    - *Take the new one* replaces it as one commit, and their version is one undo away.
  - A merge isn't offered in v1. Later, the assistant could do it.
- **Removing** deletes the app folders and the lock entry as one commit, and undo puts it back. Tabs pointing at a
  removed app go too, in the same commit.

## 9. v1: what's built (2026-11-19)

Apps and looks, from a git link (`github.com/someone/thing`, `git:…@v1`, `…@<commit>`) or an https `.tgz`.

- **`bridge/plugins.js`.** It fetches git at the given ref with only https allowed, no hooks and no links, or
  untars a tarball. It records the commit, then checks what's in the plugin (`checkPlugin`):
  - It refuses pi extensions, links, subfolders in an app, `home`, bad `uses` or `reaches`, more than 200 files and
    more than 5 MB.
  - It leaves out skills and recipes, with a note on the card. Heartbeat checks in an app's app.json are kept, fixed
    by the card (docs/heartbeat.md).
  - Then it puts the plugin in as one change. A clashing app id becomes `<id>-2`. The look and the suggested tabs go
    in through `setLook`, inside the same change. The lock file is `webapp/plugins.json`.
  - Remove is one change too. Undo takes either back, and `rightsOf` follows the lock file through undo.
- **Per-app rights** (`bridge/apps.js`, `bridge/server.js`).
  - The app routes are grouped. The `uses` groups are lists, chores, rewards, meals, events, photos, family, weather,
    home, timer, say, decide, today, days, calendar-events and today-card. The basics (its own data, `/state`, `/apps`, errors) are always allowed.
  - Settings, phone hand-off and the flyer are for the family's own apps only.
  - `GET /house` and `/house/wait` are cut to the groups' keys for a plugin's app (`houseFor`).
  - The family's own apps are unchanged.
- **The internet.** `device/vite.config.mjs` sends a CSP for `apps/<id>/` when `id` is a plugin's app:
  `connect-src`, `img-src` and `media-src` allow `'self'` plus the granted `reaches`. It was checked in a browser
  against the real config: the declared host was reached, another host and an image from it were blocked, inline
  scripts and Vite's hot reload still worked, and the family's own app was untouched.
- **Tools.**
  - For the assistant and the workshop: `look_at_plugin`, `add_plugin` and `remove_plugin` (the tablet's card;
    adding needs the PIN), plus `list_plugins`.
  - For the workshop only: `export_plugin {name, apps, description, look}`. It returns the folder's files and warns
    about lines with the family's names or town. Binary files are left for the computer to copy.
- **Settings → Plugins** (`shell/.../PluginsMenu.kt`): what's on the tablet, each one's rights and whether it was
  changed here, Take it off, and Add from a link (look first, then Add it). The menu's PIN is the person's yes.
- **Tests.** `bridge/test/plugins.test.mjs` covers sources, checks, rights, the card, clash, undo and remove, export
  round-trip, and a real bridge's routes and app key. A real fetch from GitHub was checked by hand.

**Not done yet:**
- **Not tried on the emulator or the tablet.** The main session installs. It needs a runtime-assets and APK build
  (bridge, vite config and shell changed).
- **The WebView's own block** (`shouldInterceptRequest`) as a second layer under the CSP: built (§17).
- **`phone.*` in a plugin's app** goes through the shell (`OpenhouseApp.phone`), not the bridge: refused for it since §17.
- **Updates.** For now an update is a remove plus an add.
- **Not in v1 at all:** skills, recipes, checks and starter data; the index; the QR flow.

## 10. Decisions (2026-11-19) and what's still open

1. **The name is "plugins"**, in the docs and on the tablet: Settings row is "Plugins", the card says "Add
   the Twins chores plugin?".
2. **One git repo per plugin is fine for v1.** Claude or Codex makes the repo for the person from the workshop.
3. **Plugins for the index are reviewed by hand to start.** The automated pass (§5 item 5) runs first and hands the
   reviewer its findings. Unreviewed plugins still install from a link, and the card says they haven't been reviewed.
4. **Shared apps may reach the internet**, only the hosts they declare in `reaches`, shown on the card word for word.
5. **Families can write their own skills by talking (v2), probably.** This is the same `webapp/assistant/skills/`
   folder with the family as author: a new `save_skill` tool writes it under the edit lock (one change, undoable),
   and `export_plugin` can include it. `preferences.md` stays for one-line facts; a skill is for "how we do pizza
   Fridays, step by step".
6. **A data-only heartbeat check format is worth designing, probably**, so checks can be shared in plugins later
   (§4). Not in v1.
7. The pi discovery gap and the backup gap are fixed (c1792f6).

Still open:
- Should installs be blocked while a kid is talking to the assistant, even with the PIN card? The proposal is no,
  because the card already needs someone.
- `--no-context-files` for pi (§5 item 3): add it with v1, or now?


## 11. Every app is a plugin (built 2026-11-19)

**The rule:**
- **Data** changes directly: lists, events, chores, photos and app data (`house.json`, `appdata/`).
- **Settings** change directly too: tab order, the look, the weather's place, calendars (`apps/home/style.json`,
  `household.json`).
- **Everything else is a plugin**: apps, widgets, looks and voice actions, whether it comes from a link, from Claude
  or Codex on a laptop through the workshop, from the assistant on the tablet, or from us.

### Three kinds, one registry

Each plugin is `webapp/plugins/<name>.json`, one file per plugin:
- It is in git with the apps, so undo keeps it right.
- It is outside `apps/`, so neither the assistant nor a computer writes it. The bridge keeps it.
- Every folder in `webapp/apps/` (except `home`) belongs to exactly one plugin.

| Kind | Name | Rights | Version | Comes from |
|---|---|---|---|---|
| `builtin`, OpenHouse's own | `openhouse-<app>` | own (all app routes) | `version` in the app's `app.json` in `defaults/apps`, else a content hash | each release's `defaults/apps` |
| `local`, the household's own | the app id | own | `1.0.<number of its changes>`, counted from git | the assistant, the workshop, a hand edit |
| `shared`, from a link | its package name | only what the card granted: `uses`, `reaches`, `actions` | its `package.json` | `add_plugin` (§9) |

Fields:
- A built-in entry keeps each file's hash, `apps.<id>.files`. It also has `overriddenBy` while the household's
  version is used, and `removed` once it has been taken off.
- A local entry has `overrides` when it is the household's version of a built-in.
- A local plugin's manifest never changes when the app is edited. Its version comes from git. This is on purpose:
  `undo_change` on an older change never conflicts in the manifest.

### The registry follows the files

Every commit the edit lock makes goes through `edits.js` `snapshot`: the bridge sees which apps the commit changed,
and `plugins.js` `reconcile` fixes up their manifests before the commit lands. The manifest change is in the same
commit as the files, so "undo" takes both back together. Nobody fills in a form or writes a manifest.
- **A new app folder** becomes a local plugin, titled from its `app.json`.
- **A changed built-in** becomes a local plugin that overrides it. The built-in stays listed, with `overriddenBy`.
  Our updates then skip it, so their change and our update never collide.
- **A deleted app folder** takes its plugin with it. A built-in is marked `removed` instead, so it never comes back
  (the old `.defaults-seeded` rule).
- **An edit to a shared app** stays shared. Its rights come from the manifest and never from its own `app.json`, so
  "make it use the photos too" doesn't widen what the card granted. That needs `update_plugin`, which asks again.

### Paths, the same for every kind (tools for the assistant and the workshop)

| | built-in | local | shared |
|---|---|---|---|
| install | each start-up adds new ones (`syncBuiltins`) | making an app | `add_plugin`: card with the PIN |
| update | each start-up, only while the tablet's copy is still exactly ours | each change it makes (its version counts them) | `update_plugin`: card, with the PIN if it asks for more. If the household changed it, they choose first, and their version is one undo away |
| undo | `undo_plugin`: their latest change to that app, keeping later changes to the others | the same | the same |
| remove | `remove_plugin`: card, no PIN, undo puts it back | the same | the same |
| put ours back | `reset_plugin` (the household's version is one undo away) | — | — |
| share | — | `export_plugin {plugin}`: the plugin's files back to the computer (§6) | — |

More about each path:
- `list_plugins` lists all three kinds. For a built-in, it also says when a newer version of ours is waiting behind
  the household's own.
- Settings' `GET /plugins` still lists only the shared ones, so the shell's Plugins menu is unchanged.
  `?all=1` lists every plugin. The menu can also call `/plugins/reset` and `/plugins/undo`.
- Our updates and the move are commits made with `quiet`: "undo" never takes them back. `undo_plugin` also skips
  our own commits (`Starting apps…`, `OpenHouse added/updated…`, the move), so it can't empty a built-in. Taking
  ours off is `remove_plugin`.
- `device/runtime-start.sh` no longer seeds or updates the starting apps. The bridge does it at start-up, from
  `display/defaults` (`scripts/runtime-assets.sh` still copies `defaults/apps` there). The ports block (`Moved to
  web`) is unchanged.
- From the workshop, `done_editing` says which plugin the change went into and its version, for example "Whiteboard
  (the household's own, version 1.0.4)". The workshop's instructions and `WORKSHOP.md` explain the rule.
  `connect/` only forwards, so it needs no change.

### Voice actions

An app can offer the voice something to do, in its `app.json`:

```json
"actions": [{ "name": "start", "description": "Start the pasta timer.",
  "parameters": { "properties": { "minutes": { "type": "integer" } }, "required": ["minutes"] },
  "reply": "Pasta timer on.", "open": true }]
```

`"answer": true` lets the app's page say what the voice says (below, under Not done yet: now built). `"wait"`
(seconds, up to 30) is how long the voice waits for that answer (6 s if not set): the Recipes app's web search uses 28.

What's allowed in an action:
- Flat parameters only (string, number, integer or boolean, with an optional `enum`), and names OpenAI accepts.
  `cleanActions` checks them; there's no cap of ours on how many (only OpenAI's own rules apply).
- For a shared app, the actions are fixed when it is added: the card lists them ("the voice can ask it to: …") and
  they are stored in its manifest. Editing it can't add any.
- A built-in or local app's actions are read from its `app.json` as it is now.

How an action runs:
- It is **data only**. Nothing runs outside the app's page:
  1. The bridge checks the arguments.
  2. It puts `{id, action, args}` in the app's inbox, `appdata/<app>/actions.json`.
  3. If `open` is set and the app is a tab, the app's tab is shown.
  4. The voice says `reply`.
- The page does the action with the kit's `onAction((name, args) => …)`. It handles each one once, oldest first,
  including ones asked while the app was closed.
- The voice's tool is named `<app>__<action>`, with dashes in the app id turned into `_`.

Where they plug in:
- `live-tools.js` takes them through `setExtra({tools, call})` (`server.js` hands it `plugins.voiceTools` and
  `plugins.callVoice`).
- They come after the door's tools and the weather, and before `ask_opie` (which stays last). The OpenAI live voice
  and the cloud assistant both get them, and the cloud assistant's router (`agents/cloud.js` `routeFor`) counts them
  as household things, so "start the pasta timer" isn't sent away as changing the tablet.
- The tablet's own assistant doesn't get them as tools. It can change the app itself.

### The one-time move (`migrate`, at the bridge's first start on the new release)

The move makes one commit, "Apps became plugins". It writes `plugins/*.json` and `plugins/.v1`, and turns v1's
`plugins.json` into shared entries. **It changes no app file, nothing in `appdata/`, and not the tabs.** The commit
isn't on the undo stack. Each app is sorted like this:
- **A built-in:** a starting app whose every commit is `Starting apps…` and that has nothing uncommitted (the old
  update rule). The next step, `syncBuiltins`, then brings it up to this release, the way the old seeding would have.
- **The household's version of a built-in:** a starting app the household changed. Our own copy is listed with
  `overriddenBy`.
- **Taken off:** a starting app in `.defaults-seeded` with no folder.
- **The household's own:** every other app.

Reversible:
- Before the move, the tag `before-plugins` marks HEAD.
- `unmigrate()` removes `plugins/` and writes the shared ones back to `plugins.json`. That is one more commit, and
  apps and data again stay as they are.
- Rolling back the release afterwards brings back the old shell seeding. It reads git history the same way, so it
  still leaves the household's apps alone.

**Tried on a copy of a real tablet's backup** (`tablet-20261119-1619-before-1.0.7-local.2.tgz`). The test in
`bridge/test/plugins-model.test.mjs` uses the newest backup from before the move (no `webapp/plugins/.v1`), and a
second test starts the bridge's plugins on the newest backup from after it (nothing moves again, the household's own
stay as they are). Each is skipped where there's no such backup. The tablet itself was never written.
- Built-ins: Calendar, Weather, Chores, Lists, Meals, Photos, Whiteboard (and TV).
- The household's own: the apps it had made itself, and Whiteboard.
- **Weather is the household's**: it was made from the laptop ("Add a Weather tab…") before ours shipped. Ours is
  listed under theirs and our updates leave it alone. `reset_plugin weather` would swap ours in, if they want.
- Every app file (`git ls-files -s`), `apps/home/style.json` and the hash of every file in `appdata/` are identical
  before and after. Nothing is left uncommitted, and the undo stack is unchanged.
- Then `syncBuiltins` updated only the five untouched built-ins. The household's apps were byte for byte the same,
  and so were the tabs and the data. `unmigrate` went back cleanly.

### Not done yet

- **Not on the emulator or the tablet.** The main session installs. It needs runtime-assets plus an APK build (the
  bridge, `device/runtime-start.sh` and `device/vite.config.mjs` changed), after a backup.
- **Settings** (`PluginsMenu.kt`) still lists only plugins from a link. Showing ours and the household's
  there, with Put back ours, is a shell change.
- **A built-in's `version`:** `defaults/apps/*/app.json` has no `"version"` yet, so versions show as content hashes
  until one is added.
- **Voice actions with an answer:** built (2026-11-20, for the Recipes app, docs/recipes.md). An action with
  `"answer": true` is answered by the app's page: what its `onAction` handler returns is what the voice says (the
  bridge waits up to 6 s for `appdata/<app>/replies.json`, else says `reply`). `open` now opens an app that isn't a
  tab in its own window (`door.showApp`). One of the household's own apps (or ours) can ask another for one of its
  declared actions (`POST /apps/ask`, kit `askApp`): the Meals app's Cook. And an app in use hands-free (kit
  `handsFree`) keeps the screen on and tells the live voice what it shows.
- **Looks and widgets as plugins of their own:** a look still comes in with a shared plugin, or is a setting. A
  widget is still part of its app.

## 12. A line on Today, the web through the tablet, a plugin in a folder (2026-11-21)

Built for the School lunch plugin (`plugins/school-lunch/`), and usable by any app:

- **A line of its own on Today** (kit `today.show(text, until)`, `today.clear()`; `POST /today/line`). One per app,
  plain words up to 80 characters, shown with the reminders and suggestions (things.js, kind `app`) until `until` (10
  minutes to a day ahead). Showing again replaces only that app's line; a tap opens its tab; a person's x or Opie's
  `take_down_thing` takes it down, and the same words don't come back until they change. A plugin's app needs
  `"today"` in `uses` (the card says "a line of its own on Today").
  The line is on the sleep screen too, under the events; `today.show(text, until, { sleep: false })` keeps it to
  Today (a busy or live line). Calendar notes (`days.set`) for today are on the sleep screen as well, tomorrow's from
  6 PM. Today cards (`widget.html`) are not: the sleep screen stays plain lines.
- **The web through the tablet** (kit `web.get(url)`, `web.json(url)`; `POST /apps/fetch`, `bridge/app-web.js`), for
  a site that doesn't let other pages read it (no CORS), like Nutrislice's menu API. Only https GETs to the hosts in the
  app's `reaches` (as the card granted, for a shared app; its `app.json` for ours and the household's), never the home
  network (checked on every redirect), no cookies, 3 MB, 30 a minute. An app with no `reaches` gets nothing.
- **`reaches` can name `*.example.com`**: any name under it, not example.com itself. The card shows it as written, and
  the dev server's CSP passes it on as `https://*.example.com`.
- **A plugin can be a folder in a bigger repo**, given as its web page's address:
  `github.com/<owner>/<repo>/tree/<ref>/<folder>` (GitLab's `/-/tree/`, Codeberg's `/src/branch/`). Only that
  folder's files are fetched (a sparse, blob-filtered fetch). This repo's own shared plugins live in `plugins/`.

**School lunch:** `github.com/mrubens/openhouse/tree/main/plugins/school-lunch`. Each kid's name (from the family) and
Nutrislice menu link; the week's lunches per school, today marked; "Lunch: Popcorn Chicken · Beef Taco Meat tomorrow"
on Today on school days; voice actions `lunch {date?, who?}` and `week {who?, next?}`. Its page does all of it, so the
line and the daily refresh happen while the page runs (as a tab once seen, or open).

## 13. Things apps put on the calendar (2026-11-22)

Two kinds, and the app says which (`bridge/day-notes.js`, stored per app in `day-notes.json`; each `set()` replaces
that app's whole set of that kind; never synced; gone with the app):

- **Day notes** (kit `days.set(list)`, `POST /calendar/days`, `uses` `"days"`): a fact about a day with no time
  (lunch, trash day, books due, whose turn). `{date, label, short, text, who?}`: label one word, short up to about 24
  characters, text all of it; one per app a day (per person). The old `{text}` still works ("Label: rest", else the
  app's name as the label). An event is filled, a note is outlined: a day's notes are one hairline card, a row each in the
  household's order, the next thing after the day's events. The Calendar's week shows the whole text with one or two
  notes and each one's short words with more, never cut; Today (under its calendar card), the day view (beside the
  hours, after the all-day things) and the list show the whole text; the month none. A tap shows all of it, the day,
  "From <app>", where that app's notes show (Week and Today, Today only, Nowhere) and Open <app> (kit `shell.openApp`).
- **Events** (kit `events.set(list)`, `POST /calendar/events`, `uses` `"calendar-events"`): someone has to be
  somewhere, or the day changes shape. `{date or start, end?, allDay?, title, place?, who?}`. Merged into the house's
  events (Calendar, Today, Opie) exactly like the family's, read-only, "From <app>", no reminders.
- **The household chooses** (Calendar, From apps; `POST /house/settings {fromApp: {app, show}}` and
  `{fromAppsOrder}`, kept in house.json's settings): Week and Today, Today only (where a new app starts, so the week
  never changes on its own) or Off (its events too), and the order. `view().fromApps` lists the apps.

## 14. The home's speakers and TVs (2026-11-22)

An app can control the devices the tablet already controls (Sonos, Roku, Samsung and LG TVs, Xbox, Bluetooth
speakers, a recipe's device), through the same drivers and the same asks as Opie (`bridge/devices/index.js`
`forApp`). A remote for the Sonos on Today is the first use.

- **Kit** `devices.list({state?})`, `devices.get(id)`, `devices.do(id, action, args?)`; `POST /apps/devices`,
  `/apps/devices/get`, `/apps/devices/do`; `uses` `"devices"` (the card says "the home's speakers and TVs (it asks
  here before turning anything on)"). The family's own apps have it; a plugin's app only through its card.
- **What an app sees:** `{id, name, kind, room, maker, model, present, actions: [{name, says, params, asks}]}`. The
  id is an HMAC of the device's own id with a salt kept in `devices.json`: stable, never an address, MAC or pairing
  token. A device's state (`get`, or `state` after `do`) is the driver's `status` with any address taken out: a Sonos
  says `{state, title, artist, volume, muted}`.
- **The same asks, never weaker:** the first change to a device asks the room "Let <app> control <device>?" once,
  kept per app with the device (the assistant's yes isn't the app's, nor the other way round; taking a device's yes
  back in Settings takes the apps' too). Risky actions (turning on, opening an app or a page on a TV) ask every time,
  naming the app. With no shell to ask (a laptop), the answer is no. One card at a time per app.
- **Never through the kit:** pairing, forgetting, where the tablet's sound goes (`play_here`, `stop_here`),
  installing, settings; scanning, recipes and naming stay with people and Opie. Phones, computers, tablets, routers
  and the display itself aren't listed.
- **Limits:** 60 changes and 120 reads a minute per app (then 429, `{ok: false, limited: true}`).

## 15. A card of its own on Today (2026-11-22)

For an app that's most useful at a glance or a tap (a remote for the speakers, a score, the next bus):

- **The app offers one** with a `widget.html` and `"today": {"size": "small" | "wide"}` in its `app.json`. small is one
  cell of Today's grid; wide is two across (beside the calendar, the whole width of the cards). `GET /apps` lists it as
  `today: "small" | "wide"` (`bridge/apps.js`), else `null`.
- **It runs like the app**: `widget.html` in a sandboxed frame inside a card that looks like the others (the app's name
  above it, like their labels; a tap on the name opens the app), given the app's key and the screen's colors and type
  in its address, so the kit works there with what the app was granted. Its address says `?today=small` or `wide`.
  The page sits on the card's tint (`bg`), keeps about 22 px at the sides, and takes its own taps; a tap on blank space
  does nothing. Kit `shell.openApp(id)` works from it too.
- **The household turns it on**: none show until someone does, in "Tabs and look" (Cards on Today: add, order, take
  off) or by holding the app in Apps (Add to Today). Opie, the text assistant and the workshop use `today_card`
  (`{app, on, position}`; with no app it lists what's on and what could be). Kept as `cards` (app ids, in order) in
  `apps/home/style.json` with the tabs and the look (`POST /door/look {cards}`), so undo takes it back.
- **On Today** the chosen cards come after the weather, chores, dinner and groceries and before the notes and the photo,
  in the household's order, three rows at most; a wide card that doesn't fit the rest of a row starts the next one.
- **A plugin's app needs `"today-card"` in `uses`** (the card says "a card of its own on Today"); without it the app
  offers no card, and exporting or installing one notes it. The household's own apps and ours don't need it.

## 16. Example plugins (2026-11-23)

Thirteen plugins in `plugins/`, each one app, kit APIs only, each with the narrowest `uses`, `reaches` and `actions`,
to try adding and removing plugins and as worked examples: Air quality, Bedtime, Daylight (`sun-and-moon`), For the
sitter (`babysitter`), Bus times, Game days (`game-schedule`), Laundry, Pantry, Reading log, School food (`school-menus`, the
shareable School lunch: any Nutrislice school, found in the app), Trash day (the household's own pickup schedule, or
its city's pickup calendar), Trivia night and Word puzzle. Each README says what it does, what it asks for and what the
household sets up. `scripts/plugin-tarballs.sh` makes their tarballs (package/ at the root,
`<name>-<version>-<commit>.tgz`) for the plugin CDN. Nothing in them is one town's.

**Bus times** came back once a website could be chosen at setup (§18): any agency with a GTFS-realtime feed, picked
from the Mobility Database's catalog or pasted, its stops read from its GTFS zip (`web.bytes`). Left out: **library
books** (no common catalog API that works without someone's sign-in).

The worked examples: **Reading log** (voice actions with structured arguments, a chart on a wide Today card, stars
through Chores), **Pantry** (small judgments with `decide`, dinner into Meals) and **Bedtime** (devices through the
kit's asks, a Today line and card, routines from Chores).

What building them taught, for anyone making one:
- **Take the voice's asks only where the page is showing.** The home screen keeps a hidden copy of every
  `"background": true` app, and an action with `"open"` brings up another; both run `onAction`, so one ask can be done
  twice (a pantry item counted twice). The examples start `onAction` only while the page has a size and isn't hidden
  (`whenShown` in their `ui.js`), give every answering action `"open": true`, and read their saved data again before
  each change, since another copy may have written it.
- **Hidden copies are slow.** The web view runs a hidden frame's timers every 20 to 60 seconds, so an answer from the
  background copy usually misses the bridge's wait (School lunch's voice actions too). The open window answers in a
  second or two once it has started; its first start after an install can take longer than the wait.
- **Wait long enough** (`"wait"`) for anything the answer fetches: 15 to 25 seconds in the examples.
- `replaceChildren(null)` prints "null": the examples' `put()` leaves out nulls.
- **A card on Today is as tall as it needs**, so size its type by the card's width, not its height (`card.css`).
- **A calendar note can carry photos** (`pics: [{text, image}]`, up to 4, each image from a host the app reaches):
  Today's note card shows them small beside their names. School lunch and School food send the day's dishes.

Found and fixed on the way: `GET /house` listed every app's folder once per app with notes on the calendar, several
times a read; with a few such apps it took seconds, and the runtime's watchdog restarted the bridge as stuck (server.js
now lists them once a couple of seconds).

Found on the release emulator, not changed here:
- Removing a plugin leaves its app data (`appdata/<id>`, which the kit says survives a reinstall; a re-add picks it up),
  its Android app shell (`computer.openhouse.app.<id>`), and its line on Today until that line's own time runs out.
- An app's window keeps the key it got when it started; after the bridge restarts without it, its calls are
  "unauthorized" until the window is closed for good.
- Settings, Plugins: the rights are shown as group names ("uses today, today-card"), unlike the install card's words;
  the list repeats each plugin's name and shows its full source; Add from a link only mentions git links.
- Settings' `GET /plugins?all=1` counts each household plugin's changes with git, one run each: 12 seconds on the
  emulator with a dozen apps.
- Trivia night plays on the tablet, not the TV: a screen app can't read its own app data (it would need a GET-only
  `/appdata/<name>` of its own app through the screen), and a shared TV app would replace the TV's layout for as long
  as it's installed (`screenApps` puts the household's own and shared apps first). Both together would let a game show
  on the TV only while it's on.
- A wiped emulator set up without `scripts/tablet-setup.sh` isn't on the power allowlist, and Android then cuts the
  bridge off the internet whenever an app's own window is in front.

## 17. Apps from a link on an origin of their own (2026-11-23)

An audit showed a shared app could escape its card. Fixed:

- **Its own origin.** A shared app's pages are served only at `http://<id>.localhost:5173` (Chromium and Android
  WebView resolve `*.localhost` to this device), never at `127.0.0.1:5173`, where ours and the household's stay. It
  can't read another app's frame or patch its `fetch`, and theirs can't reach it.
  - The home page (`home.jsx` `appOrigin`), the app windows (`WebApps.kt` `appOrigin`) and the door grid load it there.
    `/apps` and `/apps/key` say `shared: true`.
  - **Stored data:** ours and the household's keep their origin, so their localStorage and IndexedDB are as they were.
    A shared app's browser storage starts empty once (none were on the family tablet; its `appdata/` is the bridge's
    and unchanged).
- **Keys never in an address.** The home page hands an app its key by message, to the app's own origin, when the kit
  asks (`{openhouse: 'hello'}` → `{openhouse: 'key'}`); the shell's window still hands it through `OpenhouseApp.key()`.
- **Keys bound to the origin** (`apps.js` `caller`). The bridge takes the page's host from its Origin, else from
  `x-openhouse-host`, which the dev server sets over anything the page sent. A shared app's key works only from
  `<id>.localhost`; ours only from the dev server's usual host or with no page (the shell). `Origin: null` is refused.
- **The dev server serves only what pages need** (`device/vite.config.mjs`): `/apps/<id>/…` (no dot-files, not
  `home`), `/kit`, `/bridge`, `/@vite/client`, `/@vite/env`, `/@id/`, `/node_modules/` (only `.vite` among dot
  names), and `/` for the shell's check. Any path not plainly written (`//`, `/./`, `..`, `\`, encoded slashes, dots or
  letters, `/@fs/`) is a 404. Never `.git` (commit messages say what was asked and by whom), `MEMORY.md`, `plugins/` or
  `src/`. `cors: false`.
- **The CSP on everything** served on a shared app's host, errors and workers included.
- **The web views as a second wall.** A shared app's own window loads only its origin and its `reaches` (https). The
  door's web view refuses a frame on any site but this device's servers and YouTube's embeds.
- **The shell's calls.** A shared app gets no phone card (calendar, album, unlink, share, PIN, photos, flyer…) and
  can open only itself; `OpenhouseDisplay.editing` needs the door's gate (an app's frame tells the home page, which
  passes it on for its own frames).
- **The cards say everything.** Install and update cards list every right first, merged across the apps, never cut
  (the shell's card scrolls), then our notes, and last the plugin's description, marked as its own words.
- **Fixed at install, shown on the card:** `background` (keeps running hidden) and `screens` (for a TV), as with
  `uses`, `reaches`, actions and checks. An update asks again, with the PIN, for any new right, host, voice action,
  check, app, background or TV. (An update never adds tabs or a look.)
- **The web through the bridge** connects to the address it checked (`app-web.js` `pinnedFetch`): no DNS rebinding.
- **A shared app's answer to a voice action** reaches the voice model quoted, short and marked as the app's words.

Tests: `bridge/test/dev-server.test.mjs` (paths, hosts, CSP, files), `apps.test.mjs` (keys and origins),
`plugins.test.mjs` (the pinned address).

**Still open:**
- WebRTC in a shared app's page: CSP can't stop it in Chromium and WebView has no switch, so a data channel to a STUN
  server could carry data out. A script that removes `RTCPeerConnection` could be undone from a blank frame.
- A debug shell pointed at a laptop's dev server (`10.0.2.2:5173`) loads shared apps from `<id>.localhost`, which is
  the emulator itself: shared apps don't load in that setup.

## 18. A website chosen at setup (2026-11-23)

Some apps reach a website the household picks when it sets them up: their transit agency's feed, their city's
calendar. A plugin can't name those hosts in advance, so its app.json says it will choose one:
`"reaches": [{"setup": "transit-feed", "why": "Live arrivals from your transit agency"}]` (up to two, each with a why),
alongside any plain hosts. The install card says "a website you choose when you set it up (Live arrivals from your
transit agency)".

- **Asking.** In its setup the app calls the kit's `reach.ask(host)` (`POST /apps/reach`). The tablet shows a card with
  the PIN: "Let Bus times reach gtfs.example.org?", with the why from when the plugin was added (never words the app
  sends now). Only on a yes does the host join the app's approved hosts, kept in the plugin's manifest
  (`webapp/plugins/<name>.json`, `apps.<id>.chosen`), one change, never in the app's own files.
- **What it may ask for.** Only an app from a link whose card named a website chosen at setup; only a plain host name
  (no wildcard, IP address, port or home-network name); four at most; one card at a time. The household's own apps
  list their hosts in app.json as before.
- **Where it counts.** `reachesOf` (the web through the tablet, `/apps/fetch`, with its address check) and the dev
  server's CSP for the app's own origin both read the manifest, so an approved host works in both, and nothing else
  does. `reach.forget(host)` (`/apps/reach/forget`) drops one without asking. An update keeps the approved hosts while
  the new version still chooses that kind of website; a new kind is a new right, and the update asks again.
- **Settings, Plugins** lists the approved hosts with the plugin's others.
- **Bytes.** A transit feed is protobuf and a timetable a zip: `web.bytes(url)` (`/apps/fetch` with `binary: true`)
  hands the app any type, base64 on the way, up to 20 MB, under the same host and address checks as `web.get`.

Tests: `bridge/test/plugins.test.mjs` (never reachable without a yes, only for the app that asked, not by editing
app.json, refused for anything but a plain host or for an app that didn't say so) and `dev-server.test.mjs` (the CSP).

## 19. A list to choose from, and the household's own versions (2026-11-23)

**OpenHouse's list (the gallery).** Settings, Plugins, "Add a plugin" shows the plugins OpenHouse has reviewed: name,
a line on what it does, a picture if it has one, and what it uses and reaches in the card's words. One that's on the
tablet says so and opens its own page (Remove). "From a link" stays at the bottom for anything else.
- The list is `index.json` next to the tarballs on the plugin CDN (`releases/plugins/index.json`). Each entry:
  `name, title, description, version, commit, tarball, sha256, rights`, and `image` when there's a picture.
  `scripts/plugin-index.mjs` builds it from `plugins/*/package.json` and the tarballs `scripts/plugin-tarballs.sh`
  made, unpacking and checking each one as the tablet does (`checkPlugin`) and writing its rights with `rightsMerged`.
  A picture is `plugins/<name>/preview.png` (or `.jpg`, `.webp`), copied next to its tarball.
- The tablet fetches the list only when someone opens it or asks Opie (kept 10 minutes). It takes only entries whose
  tarball and picture are https on the list's own host and that carry a sha256 (`cleanCatalog`), installs only from
  that tarball, and refuses it if its sha256 differs. The card is made from the tarball itself, never from the list's
  words, and says "Reviewed by OpenHouse". The manifest keeps `source: "catalog:<name>"`, `sha256` and `reviewed`.
- Adding from the list is the same three steps as a link: `look_at_plugin`, the card, `add_plugin`, with the list's name
  as the source (`add_plugin {source: "laundry"}`). Opie's `find_plugins` reads the same list ("what plugins are
  there?"), so "add the laundry one" is the same card and PIN.
- A newer version on the list shows on the plugin's row ("1.1.0 is out") once the list has been fetched, and on the
  plugin's page as "Update to 1.1.0" ("Look for an update" otherwise, which asks its source).
- For trying a list from a laptop, `PLUGIN_INDEX_URL` points elsewhere; with `PLUGINS_LOCAL=1` it may be plain http
  (still only its own host).

**The household's own versions.** A plugin from the list or a link that the household changed shows as "Yours, based
on Laundry 1.0.0", and so does their version of one of ours ("Yours, based on Calendar 1.0", with Put ours back).
When an update arrives for one they changed, they choose:
- **Keep yours:** nothing changes; that version isn't offered again (`skip` in the manifest; a newer one is). A quiet
  commit, not one of their changes.
- **Take theirs:** the new version replaces their changes, as one change (theirs one undo away, as before).
- **Both:** their changes are put onto the household's copy (`merge`). A file only one side changed comes from that
  side; a file both changed goes to the cloud's text model (the same `cloud.ai` the assistant uses) with the version
  both started from. The version a shared app came as is kept in `webapp/plugins/.base/<app>/` (in git with the
  manifests, so undo and backups keep it); for apps added before that, it's found in git by its hashes. The result is
  one change. If the model says it can't be done cleanly, a non-text file changed on both sides, or the cloud isn't set
  up, nothing changes and theirs stays, with the reason.
- **Rights never widen.** The manifest's rights after any choice are the update's own (its package, as its card showed
  and someone approved; new ones need the PIN), never what the household's or the merged `app.json` says.
- Settings asks with three rows (Keep yours, Take theirs, Both). Opie's `update_plugin` says the household changed it
  and takes `choice: keep | theirs | both` (`replace: true` still means theirs).
- Settings' `GET /plugins` now lists the ones from a link or the list and the household's versions of ours; each has
  `basedOn`, `reviewed` and `rights` (the card's words). `POST /plugins/check {name}` says whether there's a newer
  version, what it asks for that's new and whether it was changed here; `POST /plugins/update {name, choice}` does it.

**Private stays private.** The household's own plugins and their versions of anyone's live on the tablet and in its
backups. Nothing here uploads or publishes them; `export_plugin`, asked for by someone, is still the only way out.

Tests: `plugins.test.mjs` (the list's hosts and sha256; a merge keeps both sides and never the household's or the
model's rights; a merge that can't be done changes nothing).

**Later:** the same list as a page on openhouse.computer, with a QR code per plugin that hands its name to the tablet
(the phone hand-off), in the cloud repo's landing page. Not built yet.

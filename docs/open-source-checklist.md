# Open-sourcing OpenHouse: checklist

Prepared 2026-11-23. The plan: this repo (tablet, bridge, web apps, plugins) goes public under MIT as a fresh repo
with one commit; the current history stays in a private archive; the cloud stays private in
`mrubens/openhouse-cloud`. Nothing here has been published, renamed or force-pushed. Delete this file in the
public repo's first commit, or keep it as a record, once the cut-over is done.

## 1. Audit of the working tree (not the history)

The history is not audited: it is full of the family's words (every commit message quotes the user) and old
screenshots, and it stays private in the archive. Only the cleaned tree goes public.

### Secrets: none found

- No keys, tokens, `.env` files, keystores or private keys are tracked (`git ls-files` for `.jks .keystore .p12
  .pem .key .env`, and greps for `sk-…`, `AKIA…`, `ghp_…`, `xox?-`, `BEGIN … PRIVATE`, `storePassword`,
  `keyPassword`, `arn:aws`, 12-digit account IDs: no hits).
- The release key lives outside the repo (`~/.openhouse/release/release.jks`, `scripts/release.sh:23`,
  `scripts/release-key.sh:5`); its passwords are not in the tree.
- Public by design, kept: the releases CDN `https://d15yaylh7unz6h.cloudfront.net` (`shell/gradle.properties:25`,
  `docs/self-update.md:271`, `docs/voice-models.md:31,89`), `openhouse.computer`, the update and voice URLs. A
  CloudFront hostname is not a secret: tablets fetch it in the clear.
- `.gitignore` already keeps out local state (`.cloud/`, `chats/`, logs, `home-mcp.json`, `bridge/web-mcp.json`,
  `bridge/workshop-open.json`, `shell/local.properties`).

### Family specifics: found and cleaned

The repo's sample household is Sam, Alex, Maya and Leo (`webapp/src/data.js`), in Springfield; the sample school is
Maple Elementary (Nutrislice district `springfield`).

| Where | What it was | Now |
|---|---|---|
| `bridge/CHAT.md:52`, `bridge/WORKSHOP.md:26`, `bridge/later.js:2,49,55`, `bridge/server.js:171` | a real child's name in examples | Maya |
| `bridge/live-tools.js:40`, `bridge/screens.js:516`, `bridge/device-tools.js:48`, `chat/src/phone.jsx:93` | a real name in examples | Alex (phone.jsx: a comment only, so the cloud's built copy is unchanged) |
| `bridge/devices/discover.js:242` | a real phone's name | "Sams-iPhone" |
| `bridge/test/house.test.mjs:79-80`, `plugins-model.test.mjs:58`, `weather-tab.test.mjs:12,24`, `apps.test.mjs:43`, `live-tools.test.mjs:14` | real names and the real town in test data | Sam, Alex, Maya, Springfield |
| `plugins/school-lunch/README.md:6,14`, `apps/school-lunch/menu.js:4`, `app.json:16` | the real school's menu link, a real name | `springfield.nutrislice.com/menu/maple/lunch`, Maya |
| `CLAUDE.md:28` | where the private cloud lives | says it is private, for maintainers only, and the rest works without it |
| `docs/*.md` | names, the town, the school, quotes of the user, the Modal workspace name, anecdotes about the family's house | see §2 below |

School lunch keeps working for the household: each kid's menu link was already stored in the plugin's setup on the
tablet (store `setup`), never in the plugin's defaults; only the examples named the real school.

### Removed

- `docs/history.md` (the project's notebook, quoting the user throughout), `REVIEW.md` (an internal code review),
  `docs/lamp-home-brief.md` (an internal product brief). They stay in the archive.
- 55 images and one recording under `docs/` that no remaining doc used (old milestones, emulator and real-tablet
  shots, `voice-choices.m4a`), and `docs/brain-screens-tablet.png` (its weather card named the real town).
- The 15 remaining screenshots were each looked at: sample data only (Sam, Alex, Maya, Leo), no faces, addresses
  or device names.

### Left as is, on purpose

- `~/.openhouse/…` paths in scripts and docs: the product's own dev-state folder (release key, voice sets), not a
  personal path. No personal home-folder paths remain.
- `mrubens` in `github.com/mrubens/openhouse` URLs (`hub/install.sh:4,9`, `hub/install-mac.sh:4,11`, `docs/hub.md`,
  `docs/plugins.md`, `plugins/school-lunch/README.md:29`): the public repo keeps that name.
- Mentions of `mrubens/openhouse-cloud` as a private repo (`CLAUDE.md`, `docs/cloud.md`, `scripts/cloud.sh`,
  `bridge/test/cloud-service.mjs:2`): they say it exists and is private; cloud tests skip without it.
- Device drivers named for products (`bridge/devices/drivers/sonos.js`, `roku.js`, `xbox.js`, `samsung.js`): product
  support, not the household's devices.
- Code comments quoting the user as design rationale ("the user: …"), e.g. `chat/src/home.jsx:242`,
  `shell/.../Buddy.kt:429,434`, `CloudVoiceMenu.kt:73`, `ui/Overlay.kt:114`, `ui/Setup.kt:46`. No personal data, and
  other sessions are editing those files; reword later if wanted.
- `webapp/MEMORY.md`, `webapp/CLAUDE.md`: the seed display's sample memory and rules, sample data only.
- `scripts/wake/testset.py:5,146`: "the user's own takes" means whoever runs it.

### Decisions (all settled 2026-11-23)

1. **License holder: decided.** `LICENSE` stays "Copyright (c) 2026 Roo Code, Inc." (the user, 2026-11-23).
2. **Phone screenshots: decided, kept.** `docs/phone-home.jpg`, `phone-talk.jpg`, `phone-ask.jpg` show a sample note
   naming a real local shop: a faint hint at the town, nothing more. The user is fine keeping them (2026-11-23).
3. **GPL/LGPL binaries: decided, done.** `shell/app/src/main/assets/licenses/` (in the APK too) has the GPL-2.0 text for
   PRoot, the LGPL-3.0 and GPL-3.0 texts for talloc and the BSD notice for libandroid-shmem, with each one's exact
   Termux version (PRoot 5.1.107.102, read from the binary; talloc 2.5.0; libandroid-shmem 0.7), its source
   archive and hash, and the shipped binaries' hashes. The source is public at those links, which covers the repo.
   For tablets sold with the APK, the strict reading of GPL-2.0 wants the source with the binary or a written offer
   to provide it; adding a copy of the two source archives to the releases CDN would settle that.
4. **Google sign-in IDs: decided, kept.** `docs/photos.md:159-160` has the Google Cloud project ID and the OAuth web
   client ID for Google Photos. Client IDs are public by design (they sit in every sign-in page).
5. **The wake model's training data** (no decision needed) includes CC-BY-SA material (Earnings-22). Low risk; keep the attribution list
   in `docs/wake-word.md`.

## 2. What else was cleaned

- `README.md`: says it is open source and what the repo is; plugins and the cloud get a short section each
  (the cloud is a hosted service, not in this repo, and the home works without it); test and build commands; a
  pointer to third-party licenses; "household" rather than "family" and no "kitchen counter" in the pitch.
- License fields in every `package.json` (`bridge`, `chat`, `hub`, `webapp`, `spikes/vendors`; `connect` and
  `plugins/school-lunch` had MIT already).
- `docs/third-party.md`: everything bundled or fetched, with licenses.
- Docs: family names, the town, the school, the user's quotes and the Modal workspace name taken out (per-file
  list in the commit).

## 3. Cut-over (for the main session, with the user; not run)

Do this when no other session is working, from the main checkout, after a last look over the tree
(`git grep -nEf ~/.openhouse/private-words.txt`, the household's names and places, kept outside the repo, should
print nothing; the phone screenshots' shop name is in images only).

1. **Land and freeze.** Merge every session's work to `main`, push, and note the commit: `CUT=$(git rev-parse main)`.
   The plugin-isolation security fixes must be in.
2. **Rename the current repo to the archive** (GitHub keeps it private, with its issues, PRs and settings):
   `gh repo rename openhouse-archive -R mrubens/openhouse`. GitHub redirects the old name to the archive until a new
   repo takes the name, so do step 3 right after.
3. **Make the public repo from one commit of the cleaned tree** (unrelated history, same files):
   ```bash
   ROOT=$(git commit-tree "$CUT^{tree}" -m "OpenHouse")
   gh repo create mrubens/openhouse --private --description "A shared screen for the household that changes when you ask"
   git push https://github.com/mrubens/openhouse.git "$ROOT:refs/heads/main"
   ```
   Create it private, check it on GitHub (files, LICENSE, README rendering, no `docs/history.md`), then
   `gh repo edit mrubens/openhouse --visibility public --accept-visibility-change-consequences`.
4. **Re-point the main checkout's remotes:**
   ```bash
   git remote rename origin archive
   git remote set-url archive https://github.com/mrubens/openhouse-archive.git
   git remote add origin https://github.com/mrubens/openhouse.git
   git fetch origin
   git branch -f archive-main main && git checkout -B main origin/main && git branch -u origin/main
   ```
   (`archive-main` keeps the old history locally; the archive remote has it too.)
5. **Other sessions' worktrees** share this `.git`. A branch based on the old `main` moves over with
   `git rebase --onto origin/main $CUT <branch>` (the trees at `$CUT` and the new root are identical, so it replays
   only that branch's own commits). Never merge old history into the new `main`. Worktrees with nothing unmerged can
   simply be removed. Tell each running session its base changed.
6. **Scripts and the tablet:**
   - Tablet updates don't come from GitHub (they come from the cloud's `/v1/update` and the CDN), so tablets need
     nothing. `scripts/release.sh --ref origin/main` works once `origin` is the new repo.
   - `hub/install.sh`, `hub/install-mac.sh`, `docs/hub.md` point at `github.com/mrubens/openhouse`: right after step
     3, unchanged.
   - The household's School lunch plugin was added from `github.com/mrubens/openhouse/tree/main/plugins/school-lunch`
     at a commit of the old history. That path still resolves in the new repo; the next update check sees a new
     commit with the same files. If its update check fails on the missing commit, add it again from the same link.
   - `scripts/cloud.sh` finds the cloud by `OPENHOUSE_CLOUD`, `../openhouse-cloud` or `~/Code/openhouse-cloud`, and
     passes `OPENHOUSE` as this checkout's path: nothing to change while the main checkout stays where it is.
   - In `openhouse-cloud`: `scripts/openhouse.ts:11` defaults `OPENHOUSE` to `../../openhouse` (a checkout next to
     it) and `README.md:8,17`, `docs/cloud.md:5,15,24,284`, `docs/cloud-beta.md:39,58` link to
     `github.com/mrubens/openhouse/blob/main/docs/…`: still right after the cut-over (now public). None of them link to the
     removed docs.
7. **Then:** push a change to the new repo once to check that pushes, the cloud tests (`scripts/cloud.sh npm test`)
   and a release build all work from the new `origin`.

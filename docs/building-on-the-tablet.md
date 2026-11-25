# Making apps on the tablet

Someone asks the tablet for a game or a small tab ("a reading streak tracker for Maya and Leo"), or to change one of
its apps ("make the text on Chores bigger"), and the tablet makes it: no computer, no AI subscription of their own.
It uses the cloud's cheap text model (`gpt-6-luna`, the cloud assistant's), on rails, and a grown-up says yes on the
tablet before anything goes in. Bigger or open-ended work stays with someone's own Claude or ChatGPT on a computer
(the workshop, `docs/workshop-mcp.md`). Why the rails look like this, with numbers: `docs/luna-build-eval.md`.

## How a request gets there

- **Typed** (`bridge/agents/cloud.js` chat): the first question for any request already sorts out making or changing
  an app (`route: tablet`). That used to answer "use a computer"; now it starts a build (`builder.js request`) and says
  so in a sentence.
- **Voice**: Opie's `make_app` tool (`bridge/live-tools.js`), with what was asked in their words.
- **The shell**: as before, `POST /request {text, app}` (the open app, so "make this bigger" means it).

All three reach the builder (`bridge/builder.js`), which takes the edit lock, shows the work on the tablet (the
shell's build line, and the app opens as it's written), commits one change that undo takes back, and puts everything
back when a run fails or is cancelled. The builder's agent is `agents/cloud.js run`, which is `bridge/rails.js`.

## The rails (`bridge/rails.js`)

1. **One app per request, named first.** The model's first call is `start`: a new `game` or `tab` with an id and a
   name, or a `change` to an app that's there.
2. **Templates that already load** (`bridge/templates/`). A new tab gets an `index.html` that stays as it is: the kit,
   then the app's own `app.css`, then `quiet.css` and `narrow.css` last, so the sizes (`--u`, a phone's under 700 px,
   a tab's in the home screen) and the household's palette always win. The model writes `main.js` and `app.css`. A
   new game gets the engine, `game.js` (a 1920x1080 world that fits the screen, a loop, things with gravity and
   platforms, hit tests, touch buttons that hold, keys, particles, beeps, a Play again card), and writes only
   `main.js` on top of it.
3. **Its own files only.** Writes go into the started app's folder, flat, `.js .css .html .json .svg`, 200 KB each, a
   dozen files. A change can't touch what an app may do in `app.json` (`uses`, `reaches`, `background`, `screens`…).
4. **Checked before it's done.** `check_build` and `done` run the workshop's file checks (`bridge/app-check.js`: every
   script parses, what `index.html` loads is there), what the page threw on the tablet, and slips that load fine (a
   regex with a doubled backslash, which the eval found in an edit that read as done). With Device control on
   (the default on a set-up tablet: `docs/device-control.md`), the model has `look_at_tablet`, a picture of the screen with the app on it. In the eval, looking was what caught
   pages that loaded without errors but looked broken.
5. **A second look at the code** before it's done (`review`: the same cloud call, `role: review`), once: what a
   picture can't show, like state that isn't saved, a game that can't end, or input that only works with keys. Its
   findings go back to the builder to fix. `BUILD_REVIEW=off` leaves it out.
6. **Each step under 30 seconds.** The service stops a model call at 30 s (its HTTP API), so a long file is written
   in parts (`write_file`, then `add_to_file`, about 9,000 characters a step).
7. **A budget**: 40 model calls, and a stop when it makes the same call four times.
8. **A grown-up's yes** (below).

While a new app is being made its page shows one quiet line, "Making Dino Eggs…", not the template or a page half
written: the templates' `index.html` asks the kit (`beingMade`, the bridge's state `making`), which rails sets at
`start` and clears once `check_build` first passes. From then on the family (and `look_at_tablet`) see it as it is.

## A grown-up's yes

The card ("Put Dino Eggs in Apps?") says what the app is in one plain line (the builder's `done` summary, "Dino Eggs:
catch the falling eggs before they crack", never the reviewer's notes about a fix), who asked and what they said, and
what it may use. Its yes always takes the PIN, whether or not the lock is on: a child can't put an app in. A tablet
with no PIN yet asks whoever is there to choose one on the card (the PIN, then its recovery code), and comes back to it.

- **No** ("Don't put it in") puts everything back.
- **Nobody answers** in 3 minutes, or **Not now**: nothing is lost. The change is set aside as a commit under
  `refs/opie/waiting/<id>` in the apps' repo (not their history; `bridge/build-waits.js`, listed in
  `waiting-builds.json`), the files are put back so nothing else waits on it, and any app open on screen for it is
  closed (the `gone` event). Home shows "Dino Eggs is waiting for a grown-up" first among its things; a tap there (or
  Opie's `ask_grownup_again`) puts the change back in, opens the app behind the card and asks again.
- One nobody answers for a day is put back for good, with a line on Home saying so.
- The bridge asks, and only the card's answer counts: `POST /build/open` only puts the card up again. With no shell at
  all to ask (a laptop running the bridge) it goes in as before.

## What an app made here may do

A new app made on the tablet is the household's own plugin, but limited like one from a link
(`plugins.js madeHere`, marked in the plugin registry in the same commit, so undo takes both):

- **None of the family's things** unless its `app.json` asked for some in `uses` and the card showed it. The card's
  yes grants exactly those, and nothing else later: the registry decides, not the app's own file.
- **No websites**, whatever its `app.json` says (`reachesOf` is empty).
- **Its own origin** (`<id>.localhost`), like any app from a link, so its key works only from there.
- Its own saved things (`store`), the house's basics, and errors reported: the basics every app has.

A change to one of OpenHouse's apps or the household's own keeps that app's rights as they were. The change can't
widen them (point 3 above).

`bridge/test/rails.test.mjs` checks this: writes outside the app, out by `..`, into folders, over the template's page
or the engine, and `reaches` or `uses` it can't have are all refused. The new app gets only what the card granted
and no websites, even if its `app.json` later says otherwise. A no on the card keeps nothing, and a change to the
household's app leaves its rights alone. The card always asks for the PIN; one nobody answers is in nowhere and
granted nothing, a later yes puts it in with only what the card said, and a no or a day puts it back.

## Cost and limits

It runs on the household's cloud allowance through `/v1/ai/respond`, like the typed assistant; no change to the
cloud was needed. In the eval a Luna build cost about half a cent and took 30–60 seconds. `BUILD_HERE=off` (the
bridge's environment) leaves making apps to a computer, as before.

## Not done yet

- A setting for it (it's on whenever the cloud assistant is), and a per-day cap on builds.
- Granting an app made here more later (a list it should use) from Settings, rather than by asking for it again.
- The approval card is the general one. As the build ends the app is open behind it, and when it's asked again from
  Home the app opens behind it too; the card itself doesn't show it.
- The cloud's 30 s limit per call is tight for Luna (17–26 s for a whole game file before writing in parts) and
  rules out Terra. Builds would be safer on a route without it (a Lambda function URL, or a streamed answer).
- Undo of a build works as for any change. A failed build tells the family it didn't work in one plain sentence.
  There's no "try again with Terra" yet (`docs/luna-build-eval.md` on when that would help).

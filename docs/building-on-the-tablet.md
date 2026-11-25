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

Where people find it: the Apps tab's "Make an app" tile and the Add apps sheet's "Make your own" panel (both open the
typing box with "Make " typed and an example in the household's names, `PluginsMenu.makeApp`), and the phone setup's
last step. Each leads with asking Opie and keeps the computer's connector (cloud.opie.house/mcp) for bigger work.

All three reach the builder (`bridge/builder.js`), which takes the edit lock, shows the work on the tablet (the
shell's build line, and the app opens as it's written), commits one change that undo takes back, and puts everything
back when a run fails or is cancelled. The builder's agent is `agents/cloud.js run`, which is `bridge/rails.js`.

One build runs at a time. A request made while one is being made ("and make the unclear block say Library") waits
its turn and runs right after it, as its own change with its own card, told what was being made so it lands in the
same app. Up to three wait; `/cancel` clears them with the run. Opie calls `make_app` once for each change asked for.

Asked aloud, Opie says once that it's making it and that the tablet will say when it's ready, and the conversation
ends as usual. While it works, a quiet chip in the bottom corner, on the home screen and over apps, says what's
being made ("Making Reading Streak…"), what it's doing, and what waits after it ("then: …"). Its line fills with
the time a build usually takes, and a tap opens what's being made (`BuildChip`, `Overlay.kt` and `Buddy.kt`). When
it's ready for the card, the tablet says so (`rails.js say`). If the build doesn't work, the tablet says why.

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
   dozen files. A change can't touch what an app may do in `app.json` (`uses`, `reaches`, `background`, `screens`…),
   except that an app made here may *ask*: groups of the family's things in `uses`, and up to four exact websites in
   `reaches` (`"api.weather.gov"`: no `https://`, path, port or `*.`), which it reads with the kit's `web.get` /
   `web.json`. Asking grants nothing; the card does.
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
8. **A grown-up's yes.** The approval card ("Put Dino Eggs in Apps?", with the PIN) says who asked, what was made, and
   what it may use and which websites it may reach. A no, or no answer, puts everything back.

## What an app made here may do

A new app made on the tablet is the household's own plugin, but limited like one from a link
(`plugins.js madeHere`, marked in the plugin registry in the same commit, so undo takes both):

- **None of the family's things** unless its `app.json` asked for some in `uses` and the card showed it. The card's
  yes grants exactly those, and nothing else later: the registry decides, not the app's own file.
- **Only the websites the card named.** The yes grants exactly the hosts the card showed, through the bridge
  (`app-web.js`: https GETs, never the home network). A later change may ask for more, on a new card; its `app.json`
  saying more on its own changes nothing (`reachesOf` reads the registry).
- **Its own origin** (`<id>.localhost`), like any app from a link, so its key works only from there.
- Its own saved things (`store`), the house's basics, and errors reported: the basics every app has.

A change to one of OpenHouse's apps or the household's own keeps that app's rights as they were. The change can't
widen them (point 3 above).

`bridge/test/rails.test.mjs` checks this: writes outside the app, out by `..`, into folders, over the template's page
or the engine, and `uses` or `reaches` it can't have (a `*.` name, a URL, an address, too many) are all refused.
The new app gets only the things and websites the card granted, even if its `app.json` later says otherwise. A no
on the card keeps nothing (nor the websites a later change asked for), and a change to the household's app can't add
any to it.

## Cost and limits

It runs on the household's cloud allowance through `/v1/ai/respond`, like the typed assistant; no change to the
cloud was needed. In the eval a Luna build cost about half a cent and took 30–60 seconds. `BUILD_HERE=off` (the
bridge's environment) leaves making apps to a computer, as before.

## Not done yet

- A setting for it (it's on whenever the cloud assistant is), and a per-day cap on builds.
- Granting an app made here more later (a list it should use) from Settings, rather than by asking for it again.
- The approval card is the general one. It could show the app running behind it, so whoever says yes sees what
  they're putting in.
- The cloud's 30 s limit per call is tight for Luna (17–26 s for a whole game file before writing in parts) and
  rules out Terra. Builds would be safer on a route without it (a Lambda function URL, or a streamed answer).
- Undo of a build works as for any change. A failed build tells the family it didn't work in one plain sentence.
  There's no "try again with Terra" yet (`docs/luna-build-eval.md` on when that would help).

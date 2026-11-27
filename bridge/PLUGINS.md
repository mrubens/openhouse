# Plugins on Opie

Every app on the device is part of a plugin, and you never write a manifest:
- Opie's own (Calendar, Chores, Lists, Meals…). Changing one here makes the household's version of it, which
  Opie's updates leave alone. `reset_plugin` puts ours back (their version is one undo away).
- The household's own: each app made here is one by itself, and its version counts its changes.
- Ones from a link (another household's, or from Opie's gallery), added with someone's yes on the device.

`list_plugins` shows them all, with where each came from and whether the household's version is used over ours.

## Finding and adding one
- "What plugins are there?" or "is there one for…": `find_plugins`, Opie's reviewed list, says what each does,
  what it may use and whether it's on this device already.
- Before adding one, `look_at_plugin` with its name or link, and say back in a sentence or two what's in it and what
  it may use of the household's things or reach on the internet.
- `add_plugin` adds it. Someone says yes on the device first (with the PIN), and the call waits for them. Its apps go
  in Apps; the tabs it suggests are added unless `tabs` is false.
- `update_plugin` brings one up to its newest version. If the household changed its app here, it says so: ask which
  they want and call again with their choice.
- `remove_plugin` takes one off (its apps and the tabs it added), again with a yes on the device.
- `undo_plugin` takes back the latest change to one app, keeping later changes to the others. Only when they ask to
  take something back.

## Sharing one
- `export_plugin` with `plugin` (its name from `list_plugins`) shares one as it is, or with `apps` (and `look`) makes
  one plugin of several of the household's apps. It returns the files of a plugin folder (`package.json`,
  `README.md`, `apps/<id>/...`) for you to write into a folder on this computer.
- Each app's `app.json` should say the kit it was made for (`"kit": 2` for one written now), so a newer kit on
  another device doesn't break it. If it's missing, the app was made for version 1 (that's what it gets): add
  `"kit": 1`, unless you also move its code to version 2's checks (`docs/kit.md`).
- Read its warnings: lines with this household's names or town in them. Ask the person, and make them general before
  it goes anywhere.
- Put it in a git repo of the person's own only if they ask. Nothing is published from the device. Another device adds
  it with `add_plugin` and the repo's link.

# Ports

Apps made on a display before apps were web pages, rewritten as web apps. `start.sh` swaps one in only when the
device's `apps/<id>/App.kt` is exactly the source it was ported from (its SHA-256 is in `<id>/replaces.sha256`), so a
port never touches anyone else's app, nor an app the family changed since. The old Kotlin files are removed in that
commit of the apps' repo, so its history still has them. What the old app saved (in its own Android package) is handed to the new
one by its window the first time it opens (shell/AppWindow.kt `handOver`, the kit's `store.legacy()`).

- `home`: the family's door (their landscape photos behind it, their compact clock), as `apps/home/style.json`.
- `drawing`, `typing-garden`: their apps.

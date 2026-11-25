# Dialogs, cards and settings: the house rules

Everyone in the house uses the tablet, kids included. A dialog should be understood at a glance, from across the room.
Don't make people think.

## Dialogs

- **One question or statement.** The title says what happens: "Add Trash day?", "Remove Maya's calendar?", "Let
  Living room TV show photos and the calendar?". Not a paragraph, not a label like "Is this OK?".
- **Body: one short sentence at most**, and only if it changes the decision ("Then only you can open your backups.").
  Anything else goes behind **More** (`CalmDialog.setMore`, `Calm.more`), or goes away.
- **At most two buttons.** The main one is the verb: Add, Remove, Allow, Install, Restore, Save. Never "OK" or "Yes".
  The other is Cancel or Not now (Back in a menu that leads somewhere). A notice with nothing to decide has Close,
  or is a toast instead.
- **No third button.** A rare option moves into the screen it belongs to, as a quiet link or a row: "Send it from a
  phone" under the calendar link, "Put ours back" under the check-ins prompt, the cloud's own address in Advanced.
- **Red for what can't be put back** (`setDanger`, `Calm.danger`): delete, restore over what's here, forget, remove a
  calendar. Everything that can simply be done again just happens, with a toast at most ("Added Maya's calendar").
- **Confirm only what can't easily be taken back.** Turning a switch on or off, adding, updating: no confirmation.

## Approval cards (plugins, websites, devices, apps, pairing)

These guard the household, so they keep everything a parent must see, shorter:

- The title names the thing and what it gets: "Add Chore chart?", "Let Lunch menu reach api.example.com?".
- **What it may do is a list**: an icon for each kind and a few words (`Calm.rights`; the bridge sends
  `rights: [{kind, text}]` to the shell's `/approve`). Kinds: from (where it comes from, reviewed or not), data,
  devices, cloud, web, offline, voice, watch, background, tv, look, tabs, apps, new (a right an update adds).
- **Never behind More:** a right, the website's host, a device's or app's name, where a plugin comes from and whether
  it was reviewed for Opie's list. Behind More: version and commit, our notes about files left out, the plugin's own description.
- The PIN stays where it was. With the lock on, the card shows the PIN pad and "Type the PIN to add." The verb on the
  button is the same one.
- Not now and the verb, nothing else.

## Settings

- A few sections with labels people would use; each row's current value on its right, never a paragraph under it.
- A switch's row says what it does in two to four words ("Opie uses apps", "PIN Lock"). An explanation is at most a
  one-line subtitle, and only where the name can't carry it.
- Rare and technical settings go in **Advanced**, under "For developers".

## Words

- The same words on the tablet, the phone and the web: Remove (not Take off) on a card, Not now, Allow, Linked devices,
  Use it away from home.
- Never "kitchen", "fridge" or "door". Say household, not family-with-kids.
- Never mention or offer undo in UI text. Taking something back happens when someone asks Opie.
- No "grown-up" or "parent": the PIN is "the PIN".

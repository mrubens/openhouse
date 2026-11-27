# Bluetooth devices

Opie finds, pairs with and uses Bluetooth devices near the tablet, beside the ones on the Wi-Fi: a speaker or
headphones as where the tablet's sound goes, a tag that beeps, a thermometer's reading, and anything a computer's AI
teaches it with a recipe. The landing page says "Opie can connect to anything on your Wi-Fi or Bluetooth"; this is the
Bluetooth half.

## How it fits together

The bridge runs in a runtime with no radio of its own, so the radio work is the shell's and the decisions are the
bridge's, the same split as Opie using other apps (docs/device-control.md).

- **Shell** (`shell/.../Bluetooth.kt`): the device server's `POST /bt {op}`, with its token. Ops: `state`, `scan`
  (BLE and classic discovery at once, plus the paired ones, about 8 s), `pair`, `unpair`, `services` (a BLE device's
  GATT tree), `gatt` (reads, writes, notifications and waits in one connection), `audio` (a speaker: status, connect,
  disconnect) and `volume` (the tablet's media volume). As device owner it grants itself the Bluetooth permissions,
  and turns Bluetooth on if it's off. One op at a time.
- **Bridge** (`bridge/devices/bluetooth.js`): turns what the shell found into devices in the same list as the Wi-Fi
  ones (`bt-<mac>`, `transport: "bluetooth"`), with the standard actions below. A scan (Settings → Devices →
  Look again, or `scan`) looks on the Wi-Fi and over Bluetooth at the same time.
- **Recipes** (`bridge/devices/recipe.js`): `"over": "bluetooth"` for a BLE device nothing built in knows.

## What works

| Device | Actions | How |
|---|---|---|
| Any Bluetooth device (not phones or computers) | `status`, `pair` (asks), `forget` (asks) | Android's pairing; `status` says paired, connected, battery, readings |
| Speaker or headphones (A2DP) | `play_here`, `stop_here`, `set_volume`, `volume_up`, `volume_down` | The speaker becomes where the tablet's media goes; volume is the tablet's media volume, which the speaker follows (absolute volume), and only while it plays there |
| Battery Service (0x180F) | battery in `status` | GATT read of Battery Level (0x2A19) |
| Immediate Alert (0x1802): tags, key finders | `beep`, `stop_beep` | Alert Level (0x2A06) 02 / 00 |
| Environmental Sensing (0x181A) | temperature and humidity in `status` | 0x2A6E (i16, 0.01 °C), 0x2A6F (u16, 0.01 %) |
| Anything else over BLE | what its recipe says | GATT reads, writes and notifications |

Where people use it:

- **Settings → Devices**: Bluetooth devices nearby are under "Also here" with a **Pair** button. Once paired, a
  speaker gets a card with **Play here** (then **Back to the tablet**, **Quieter**, **Louder**), a tag **Beep**, and a
  taught device its simple actions, like any other device.
- **The voice**: a `bluetooth` tool (live-tools.js), offered when the tablet has Bluetooth: list, scan, pair, play_here,
  stop_here, louder, quieter, set_volume, beep, stop_beep, status, forget. "Play it on the kitchen speaker", "pair the
  speaker", "where are my keys".
- **A computer** (the workshop connector) and the agents (`/mcp/home`): `list_devices`, `scan`, `device_info`,
  `device_action`, `name_device`, and now `save_recipe` / `remove_recipe` on the workshop too, so "your AI can teach it"
  holds for a connected computer.

## Teaching a BLE device (recipes)

The computer's AI reads `device_info` first: for a BLE device it connects and lists the services and characteristics
inside, with what each can do (read, write, write_no_response, notify, indicate) and which services are off limits.
Then it writes a recipe from the device's documentation (or a known open protocol), in the same shape as a Wi-Fi one:

```json
{
  "id": "desk-lamp", "name": "Desk lamp", "kind": "light", "over": "bluetooth",
  "sources": ["https://example.org/ledble-protocol"],
  "find": [{ "ble_name": "LEDBLE" }, { "ble_service": "ffd5" }],
  "actions": {
    "turn_off": { "says": "Turn it off", "request": { "ble": { "op": "write", "service": "ffd5", "characteristic": "ffd9", "hex": "cc2433" } } },
    "set_brightness": { "says": "Brightness 0-255", "params": { "level": { "type": "integer", "min": 0, "max": 255, "required": true } },
      "request": { "ble": { "op": "write", "service": "ffd5", "characteristic": "ffd9", "hex": "56{level}{level}{level}00f0aa" } } },
    "state": { "says": "On and how bright", "steps": [
        { "ble": { "op": "listen", "service": "ffd5", "characteristic": "ffd4", "ms": 800 } },
        { "ble": { "op": "write", "service": "ffd5", "characteristic": "ffd9", "hex": "ef0177" } } ],
      "read": { "on": "u8@2", "level": "u8@6" } }
  }
}
```

- `find`: `ble_service`, `ble_name` (part of its name), `maker_id` (the Bluetooth company id in its advertisement) or
  `mac`. No `identity`: the name comes from the device.
- Steps: `ble` with `op` `write` (`hex` or `text`, `response` true by default), `read`, or `listen` (notifications for
  `ms`, armed before the writes, for the common "write a command, get the answer by notification"), and `wait`.
- In `hex`, `{param}` is a number as one byte; `{param:u16le}` and the others (u8 i8 u16le u16be i16le i16be u32le
  u32be) other sizes; true/false is 01/00; a string param must itself be hex (an enum of byte strings).
- `read` decodes the last read or notification: `u8`, `i16le@2/100` (at byte 2, divided by 100), `utf8`, `hex`.
- A recipe adds to a Bluetooth device's standard actions (the lamp keeps its battery `status`).

## Safety

The same guards as the Wi-Fi devices, plus Bluetooth's own:

- **Pairing asks on the tablet**: "Pair Kitchen speaker with the tablet?" (the shell's yes card), then Android's own
  pairing dialog if the device shows a code. A person's own tap on **Pair** in Linked devices is their yes. The yes to
  pairing counts as the yes to using it.
- **The first use of an unpaired BLE device asks once** ("Let the assistant control Keys?"), as a Wi-Fi device's first
  change does; reads (`status`, `state`) never ask. Anything that turns on, opens, unlocks or buys asks every time
  (recipe.js's words, or `"risky": true`). `forget` asks every time.
- **Off limits, whatever a recipe says**, in the bridge's checks and again in the shell, where nothing in the bridge
  can change it: no writes or notifications on firmware-update services (Nordic DFU 0xFE59 and legacy, Silicon Labs
  OTA, TI OAD, Dialog SUOTA), Generic Access (0x1800) and Generic Attribute (0x1801), or HID (0x1812): Opie never
  flashes a device, changes the link's security or types as a keyboard.
- **Logged**: every action and its outcome (including a "no") goes to the speech log (`device-action`); the shell also
  logs each pairing, GATT write and audio switch (`bluetooth`).
- **Kiosk**: Android's pairing dialog belongs to the Settings app, which kiosk mode keeps out. The shell lets the
  Settings and Bluetooth packages into kiosk only for the minute a pairing runs, then takes them out again and comes
  back home.
- **Nothing leaves the house**: scanning and control are local; device names and addresses stay in
  `display/devices.json`. Passing devices with no name that were never paired (phones and tags rotate their
  addresses) aren't listed or kept. Scanning is never used to tell where anyone is (the permission says so:
  `neverForLocation`).

## What doesn't (yet)

- **Opie's live voice on a Bluetooth speaker**: the live voice is a WebRTC call in a web view, and Android keeps calls
  on the tablet's own speaker or a headset's call channel (HFP), not a music speaker (A2DP). Music, timers and other
  media go to the speaker. Untested on the tablet: whether a headset with a microphone takes the voice.
- **Switching a speaker on from the tablet** (`play_here` on a paired speaker that isn't connected): the A2DP
  `connect` call is hidden in the SDK; the shell tries it, and when Android refuses it says to turn the speaker off and
  on (a paired speaker connects by itself). Same for `stop_here` (turning the speaker off works).
- **Standard lights and switches**: Bluetooth's standard ones are Bluetooth Mesh, which needs provisioning; not built.
  Most BLE bulbs and plugs have their own protocols: recipes.
- **Classic (non-BLE) devices other than audio**: paired and listed, no controls (no GATT to write recipes for).
- **Keyboards, mice, game controllers**: they pair through Android; nothing here uses them.
- **Phones and computers**: listed, never paired or controlled from here.
- **Bonding a BLE device that needs a passkey typed in**: Android's dialog asks for it; untested in kiosk mode.

## Tested

- No automated tests (only critical areas have them: see CLAUDE.md).
- Emulator (Android 15, its virtual Bluetooth): see the hand-over note for what ran.
- Not yet on the tablet: everything with a real radio.

## On the tablet: what to try

1. Install the shell and bridge. Device control must be on (the yes cards need it).
2. Settings → Devices → Look again, with a Bluetooth speaker in pairing mode: it should be under "Also here"
   with Pair. Tap Pair; confirm Android's code if it shows one. It should come back with a card.
3. Play here; start music (YouTube in Apps): it should play on the speaker. Louder / Quieter. Back to the tablet.
   If Play here says Android refused, turn the speaker off and on and see whether it connects by itself.
4. By voice: "Opie, play it on the speaker", "turn it up", "pair the speaker" (with another one), "where are my keys"
   with a tag (Tile, Chipolo, or a cheap iTag: the iTag has Immediate Alert).
5. With a BLE thermometer (Xiaomi LYWSD03MMC with stock firmware, Govee) or a BLE bulb: `device_info` from a computer,
   and have the computer's AI write a recipe for it.
6. Check the speech log: pairings, writes and audio switches should all be there.

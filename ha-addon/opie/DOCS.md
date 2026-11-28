# Opie

Opie's hub, in Home Assistant: the household's day, lists, calendar and apps, served to the phones, computers and TVs
on your home network, already connected to this Home Assistant.

## Start

1. Install and start the add-on, then open its **Log** tab. It prints a code, like `K7QF-2M4D-9XPA`.
2. Press **Open Web UI** (or open `http://<your Home Assistant's address>:8788/hub/` on a phone or computer on the
   same Wi-Fi) and type the code. That device is the hub's settings device.
3. Go through the setup: who lives here, where, calendars, photos and a PIN.
4. Under **Home Assistant** on the settings page, choose what Opie may use.

Then add the household's phones, screens and TVs from the settings page. The home screen is at
`http://<address>:8788/screen/`.

## Home Assistant

The add-on talks to this Home Assistant through the Supervisor, with its own token: nobody types an address or a
token. Opie can use only what you pick on the settings page, and only lights, switches, scenes and media players, and
read thermostats. Locks, garage doors and other covers, alarms and cameras are never reachable, nor a scene that sets
one. You can take a pick back at any time.

The token is held by a small process of its own inside the add-on (the keeper); the rest of the hub runs as another
user and never sees it.

## Options

- **https** (`ssl`), **Certificate** (`certfile`), **Private key** (`keyfile`): serve the hub on https with the
  certificate in `/ssl` (the same one Home Assistant uses). Phone browsers let a page use the microphone only on
  https, so this is what talking to Opie from a phone needs. A hub linked to an Opie account gets an https address of
  its own on the home network instead, with nothing to set here.
- **New settings code** (`settings_code`): lost the settings device? Turn this on and restart the add-on: a new code
  is in the Log. Turn it off again after.
- **Forget the PIN** (`forget_pin`): forgot the settings page's PIN? Turn this on and restart the add-on, then choose
  a new one on the settings page. Turn it off again after, or the PIN is forgotten at every start.

## Network

The add-on uses the host's network, so phones and TVs reach it at your Home Assistant's own address and it can find
TVs, speakers and printers on the Wi-Fi. It answers on port 8788 (and 8789 only if you turn on the connector for
Claude and ChatGPT at your own address). Those ports have to be free on the Home Assistant machine.

It isn't shown in Home Assistant's sidebar: phones, TVs and the people in the house reach it without a Home Assistant
account, and every device it serves is paired with a key of its own.

## Data and backups

- The household's things are in the add-on's own folder, which Home Assistant's backups include.
- What the hub keeps sealed (calendar links, your own OpenAI key, the PIN, and the key that seals them) is left out of
  Home Assistant's backups, as it is left out of every Opie backup: after restoring, add those again.
- Opie's own encrypted backups can go to `/share/opie` (turn on the folder under Backups on the settings page), to
  your own storage bucket, or to the Opie cloud.

## Updates

Home Assistant shows each new version of Opie as an update of this add-on.

## Help

Issues: https://github.com/mrubens/openhouse/issues. Opie is open source under the MIT license.

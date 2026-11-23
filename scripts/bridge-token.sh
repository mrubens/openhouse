#!/bin/bash
# Print the display's bridge secret (new each time the tablet starts), fetched over adb: only adb can ask
# (ConfigReceiver needs the DUMP permission). Every request to the bridge needs it, for example:
#   T=$(scripts/bridge-token.sh); curl -H "X-Openhouse-Token: $T" localhost:9787/state
# Set ANDROID_SERIAL when more than one device is connected.
. "$(dirname "$0")/env.sh"
out=$(adb shell am broadcast -n $DISPLAY_PKG/dev.openhouse.shell.ConfigReceiver -a dev.openhouse.shell.CONFIG --ez token true 2>/dev/null | tr -d '\r')
t=$(printf '%s\n' "$out" | sed -n 's/.*data="\([0-9a-f]*\)".*/\1/p')
[ -n "$t" ] || { echo "Couldn't get the bridge token over adb: $out" >&2; exit 1; }
echo "$t"

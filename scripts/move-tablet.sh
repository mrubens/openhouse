#!/bin/bash
# Move a tablet from the prototype's package IDs (dev.openhouse.*) to Opie's (computer.openhouse.*), without a
# factory reset: the family's data, the assistant's sign-in and the tablet's device owner go to the new display, and
# the old apps are removed a day after the new display has been healthy. docs/self-update.md, "Moving to Opie".
#
#   scripts/move-tablet.sh -s SERIAL --release dist/1.0.0 [--no-backup]
#
#   -s SERIAL     the tablet (adb devices): always named, so the move never lands on the wrong device
#   --release DIR an Opie release from scripts/release.sh (display-<v>.apk and host-<v>.apk, signed with the
#                 release key)
#   --no-backup   skip copying the family's folder to ~/Documents/openhouse-backups first
#
#   scripts/move-tablet.sh -s SERIAL --old-again
#
#   On a tablet that already moved, while the old display is still there (a day): put the old display on again, built
#   from this checkout, so the new display can ask it for what it has (the calendar links, which moves before
#   2026-11-20 left behind). Changes nothing else; the new display asks within ten minutes (1.0.5 or later).
#
# What it does: checks the tablet (the old display is its owner, room for a second copy of its data), backs up the
# family's folder, builds the old display once more from this checkout with the handover in it (-Popenhouse.moveTo;
# signed with this Mac's debug key, like the tablet's) and installs it, then the new update cover and display. The old
# display opens the new one, which takes the family's things over, checks them, and becomes the owner.
set -eo pipefail
cd "$(dirname "$0")/.."
. scripts/env.sh
SERIAL= REL= BACKUP=1 AGAIN=
while [ $# -gt 0 ]; do
  case "$1" in
    -s) SERIAL=$2; shift ;;
    --release) REL=$2; shift ;;
    --no-backup) BACKUP= ;;
    --old-again) AGAIN=1 ;;
    *) sed -n '2,25p' "$0"; exit 1 ;;
  esac
  shift
done
A() { adb -s "$SERIAL" "$@"; }
say() { printf '\n== %s\n' "$*"; }
prop() { sed -n "s/^$1=//p" shell/gradle.properties; }
NEW=$(prop openhouse.releaseAppId) OLD=$(prop openhouse.movedFrom)
oldDisplay() { # the old display, built from this checkout with the handover in it, signed with this Mac's debug key
  (cd shell && ./gradlew -q :app:assembleDebug -Popenhouse.appId="$OLD" -Popenhouse.moveTo="$NEW" -Popenhouse.releaseCert="$CERT" \
    -Popenhouse.updateUrl= -Popenhouse.version=0.0.9)
  A install -r -t shell/app/build/outputs/apk/debug/app-debug.apk | tail -1
}
if [ -n "$AGAIN" ]; then
  [ -n "$SERIAL" ] || { sed -n '2,25p' "$0"; exit 1; }
  CERT=$(prop openhouse.releaseCert)
  A shell dpm list-owners | tr -d '\r' | grep -q "admin=$NEW.shell/" || { echo "$NEW.shell isn't this device's owner: it hasn't moved." >&2; exit 1; }
  A shell pm list packages "$OLD.shell" | grep -qx "package:$OLD.shell" || { echo "The old display is gone already: nothing to ask it." >&2; exit 1; }
  say "The old display again, so the new one can ask it"
  oldDisplay
  echo "Done. The new display asks it within ten minutes (adb -s $SERIAL logcat -s Move: 'calendar links from the old display')."
  exit 0
fi
[ -n "$SERIAL" ] && [ -d "$REL" ] || { sed -n '2,25p' "$0"; exit 1; }
DISPLAY=$(ls "$REL"/display-*.apk | grep -v rescue | head -1) HOST=$(ls "$REL"/host-*.apk 2>/dev/null | head -1)
[ -f "$DISPLAY" ] && [ -f "$HOST" ] || { echo "No display-*.apk and host-*.apk in $REL (scripts/release.sh makes them)." >&2; exit 1; }

say "1/5 The tablet"
A get-state >/dev/null
A shell dpm list-owners | tr -d '\r' | grep -q "admin=$OLD.shell/" || { echo "$OLD.shell isn't this device's owner: nothing to move." >&2; exit 1; }
# Room for a second copy of the old display's data, the new assistant's runtime (about 2 GB unpacked) and the family
# apps' new launcher entries: its size and 4 GB more. The old display's copy stays a day.
USED=$({ A shell run-as "$OLD.shell" du -sm . 2>/dev/null || true; } | tail -1 | tr -d '\r' | cut -f1)
FREE=$(A shell df -k /data | tail -1 | awk '{print int($4 / 1024)}' | tr -d '\r')
MARGIN=${OPENHOUSE_MOVE_MARGIN_MB:-4096}
echo "The old display's data: ${USED:-?} MB; free: $FREE MB"
[ -n "$USED" ] && [ "$FREE" -gt $((USED + MARGIN)) ] || { echo "Not enough room to move (needs ${USED:-?} MB and $MARGIN MB more)." >&2; exit 1; }

# The release key's certificate, built into the handover: the old display hands the tablet only to an app signed with it.
CERT=$(prop openhouse.releaseCert)
[ -n "$CERT" ] || CERT=$("$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)/apksigner" verify --print-certs "$DISPLAY" | sed -n 's/.*certificate SHA-256 digest: //p' | head -1)
"$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)/apksigner" verify --print-certs "$DISPLAY" | grep -q "SHA-256 digest: $CERT" || { echo "$DISPLAY isn't signed with the release key ($CERT)." >&2; exit 1; }

if [ -n "$BACKUP" ]; then
  say "2/5 Backing up the family's folder"
  mkdir -p ~/Documents/openhouse-backups
  B=~/Documents/openhouse-backups/tablet-before-move-$(date +%Y%m%d-%H%M).tgz
  A exec-out run-as "$OLD.shell" tar -cf - files/display shared_prefs | gzip > "$B"
  echo "$B ($(du -h "$B" | cut -f1))"
else say "2/5 No backup (--no-backup)"; fi

say "3/5 The old display, with the handover"
oldDisplay

say "4/5 Opie: the update cover and the display"
A install -r "$HOST" | tail -1
A install -r "$DISPLAY" | tail -1
# What tablet-setup.sh gave the old display over adb, which no app can give itself: changing secure settings (device
# control, keep-alive), staying out of battery saving. The microphone it grants itself as the owner (Move.becameOwner).
A shell pm grant "$NEW.shell" android.permission.WRITE_SECURE_SETTINGS
A shell pm grant "$NEW.shell" android.permission.RECORD_AUDIO 2>/dev/null || true
A shell pm grant "$NEW.shell" android.permission.POST_NOTIFICATIONS 2>/dev/null || true
A shell cmd notification allow_listener "$NEW.shell/dev.openhouse.shell.MediaListener" 2>/dev/null || true # music: what's playing (docs/music.md)
A shell dumpsys deviceidle whitelist "+$NEW.shell" >/dev/null
A shell cmd appops set "$NEW.shell" RUN_ANY_IN_BACKGROUND allow 2>/dev/null || true

say "5/5 The old display hands over"
# Awake and in front: the old display opens the new one from its screen, which a sleeping tablet (night, Sleep now)
# doesn't show. Again each minute until the move has started, in case the old display was restarted in the background.
wake() { A shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true; A shell am start -n "$OLD.shell/dev.openhouse.shell.MainActivity" >/dev/null 2>&1 || true; }
wake
# The copy is a minute or two on a tablet (2.4 GB took 17 s to 4 min on an emulator, by how busy the Mac was).
for i in $(seq 1 240); do
  sleep 5
  [ $((i % 12)) = 0 ] && ! A shell pidof "$NEW.shell" >/dev/null 2>&1 && wake
  if A shell dpm list-owners | tr -d '\r' | grep -q "admin=$NEW.shell/"; then
    echo "The tablet's owner is $NEW.shell. The family's folder came over whole (it checks every file)."
    echo "The assistant's sign-in follows once its new app is up; the old apps go a day after the new display has"
    echo "been healthy. Until then the old display is there, untouched, with everything it had."
    exit 0
  fi
done
echo "Not handed over after 20 minutes. adb -s $SERIAL logcat -s Move shows why; the old display is as it was." >&2
exit 1

#!/bin/bash
# Set up a real tablet as the display, over USB, in one go. Written for the Galaxy Tab S10 FE
# (Android 15, One UI 7); should suit any recent Android tablet.
#
# Before you run it, on the tablet:
#   1. Go through Samsung's first-time setup but SKIP adding any accounts (Google, Samsung).
#      Android only lets an app become "device owner" (needed for kiosk mode) on a device with
#      no accounts. You can add accounts afterwards.
#   2. Settings > About tablet > Software information: tap "Build number" 7 times.
#      Settings > Developer options: turn on USB debugging.
#   3. Plug it into this Mac and tap "Allow" on the USB debugging prompt.
#
# Usage: scripts/tablet-setup.sh [voice models dir]
# Afterwards, on the tablet: link it to the family's account (Settings → Account) and turn on Better voice for the
# assistant; connect a computer's Claude or ChatGPT (Settings → Screens and computers) to make apps.
set -e
cd "$(dirname "$0")/.."
. scripts/env.sh
PKG=$DISPLAY_PKG
MODELS=${1:-runtime/voice-models}
PORT=8812 # serves the runtime image to the tablet over USB (adb reverse)

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# Which device: ANDROID_SERIAL if set, else the one connected device that isn't an emulator
# (an emulator can stay running). Every adb call below, and in the scripts it runs, follows it.
if [ -z "$ANDROID_SERIAL" ]; then
  REAL=$(adb devices | awk 'NR>1 && $2=="device" && $1 !~ /^emulator-/ {print $1}')
  if [ "$(printf '%s' "$REAL" | grep -c .)" -ne 1 ]; then
    adb devices -l; echo "Connect one tablet over USB, or pick one: ANDROID_SERIAL=<serial> $0"; exit 1
  fi
  export ANDROID_SERIAL=$REAL
fi
if [ "$(adb shell getprop ro.hardware | tr -d '\r')" = ranchu ]; then echo "$ANDROID_SERIAL is an emulator, not the tablet."; exit 1; fi
say "Tablet: $(adb shell getprop ro.product.model | tr -d '\r'), Android $(adb shell getprop ro.build.version.release | tr -d '\r'), $(adb shell getprop ro.product.cpu.abi | tr -d '\r')"
adb shell wm size; adb shell wm density
adb shell cat /proc/meminfo | head -1; adb shell df -h /data | tail -1

say "1/7 Build and install the shell"
scripts/runtime-assets.sh >/dev/null
(cd shell && ./gradlew -q assembleDebug)
adb install -r -t shell/app/build/outputs/apk/debug/app-debug.apk

say "2/7 Permissions: microphone, settings (device control, keep-alive)"
adb shell pm grant $PKG android.permission.RECORD_AUDIO
adb shell pm grant $PKG android.permission.WRITE_SECURE_SETTINGS
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null || true
# Seeing what the media apps play (docs/music.md): no app can switch its own notification listener on.
adb shell cmd notification allow_listener $PKG/dev.openhouse.shell.MediaListener 2>/dev/null || true

say "3/7 Keep the runtime alive (child-process limit, battery, screen)"
# Android 12+ kills an app's child processes beyond 32, or when they use a lot of CPU. The whole
# runtime is child processes. This is the setting behind Developer options > "Disable child
# process restrictions" on Android 14+; the shell also re-applies it at every start.
adb shell settings put global settings_enable_monitor_phantom_procs false
adb shell device_config set_sync_disabled_for_tests persistent 2>/dev/null || true
adb shell device_config put activity_manager max_phantom_processes 2147483647 2>/dev/null || true
adb shell dumpsys deviceidle whitelist +$PKG >/dev/null
adb shell cmd appops set $PKG RUN_ANY_IN_BACKGROUND allow 2>/dev/null || true
adb shell settings put global stay_on_while_plugged_in 7
adb shell settings put system screen_off_timeout 2147483647

say "4/7 Kiosk mode (device owner) and home screen"
if adb shell dpm set-device-owner $PKG/dev.openhouse.shell.AdminReceiver 2>&1 | tee /dev/stderr | grep -q "Success"; then
  echo "Device owner: kiosk mode on."
else
  echo "Couldn't become device owner (accounts on the tablet?). Everything else still works;"
  echo "kiosk mode needs a reset without accounts, or remove the accounts and run this again."
fi
adb shell cmd package set-home-activity $PKG/dev.openhouse.shell.MainActivity >/dev/null 2>&1 || true

say "5/7 The runtime: served from this Mac over USB, unpacked on the tablet"
[ -f runtime/out/runtime.tar.gz ] || scripts/runtime-build.sh
lsof -ti tcp:$PORT -sTCP:LISTEN >/dev/null || (python3 -m http.server $PORT --bind 127.0.0.1 --directory runtime/out >/dev/null 2>&1 &)
adb reverse tcp:$PORT tcp:$PORT >/dev/null
adb reverse tcp:8811 tcp:8811 >/dev/null 2>&1 || true
# Start it as the home screen (MAIN + HOME). Started as a plain app, it runs in an ordinary task,
# and the first Home press opens a second copy in the home task: two boards, two microphones.
adb shell am start -a android.intent.action.MAIN -c android.intent.category.HOME -n $PKG/dev.openhouse.shell.MainActivity >/dev/null; sleep 2
# Its servers and runtime download: from adb only (ConfigReceiver), then started again to use them.
adb shell am broadcast -n $PKG/dev.openhouse.shell.ConfigReceiver -a dev.openhouse.shell.CONFIG --es bridge http://127.0.0.1:8787 --es ui http://127.0.0.1:5173/ --es runtime http://127.0.0.1:$PORT/runtime.tar.gz >/dev/null
adb shell am start -S -a android.intent.action.MAIN -c android.intent.category.HOME -n $PKG/dev.openhouse.shell.MainActivity >/dev/null
echo "Waiting for the runtime to unpack (a few minutes)…"
for i in $(seq 200); do
  adb shell "run-as $PKG sh -c '[ -L files/rootfs/usr/local/bin/node ] && [ -f files/display/start.sh ]'" 2>/dev/null && break; sleep 3
done

say "6/7 A helper for running commands in the runtime over adb"
# The app's files show up as /data/data/... too: proot's link2symlink points the webapp's git
# objects there, so without that path git sees "bad object HEAD". Re-run this after updating
# the app: the library path changes with every install.
L=$(adb shell pm path $PKG | sed 's#package:##; s#/base.apk##' | tr -d '\r')/lib/arm64
F=/data/user/0/$PKG/files
adb shell "cat > /data/local/tmp/rt.sh" <<EOF
L=$L
F=$F
export PROOT_LOADER=\$L/libproot-loader.so PROOT_TMP_DIR=/data/user/0/$PKG/cache/proot LD_LIBRARY_PATH=\$L
exec \$L/libproot.so --link2symlink -0 -r \$F/rootfs -b /dev -b /proc -b /sys -b \$F/display:\$F/display -b \$F/display:/data/data/$PKG/files/display -w /root /usr/bin/env -i HOME=/root LANG=C.UTF-8 TERM=dumb PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin "\$@"
EOF
adb shell "run-as $PKG sh /data/local/tmp/rt.sh /bin/sh -c 'node -v'"

say "7/7 Voice: the wake model"
scripts/voice-models.sh "$MODELS" || true # fetches only what is missing
if [ -d "$MODELS" ]; then
  ADB=adb scripts/voice-install.sh "$MODELS"
  adb shell "run-as $PKG pkill -f 'node server.js'" 2>/dev/null || true # the shell's watchdog restarts the bridge, which picks them up
else
  echo "Skipped: pass the models folder to install them (see README, 'It knows who's talking')."
fi

adb forward tcp:9797 tcp:8787 >/dev/null # not 9787: the emulator scripts use that one
say "Done. On the tablet: pick ChatGPT or Claude and sign in. Then Settings (the gear) → Voices."
echo "Bridge from this Mac: curl -H \"X-Openhouse-Token: \$(scripts/bridge-token.sh)\" http://localhost:9797/voice/status"

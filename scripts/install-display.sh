#!/bin/bash
# Usage: ANDROID_SERIAL=<device> scripts/install-display.sh [apk]
# Installs a new build of the display without the tablet's own home screen flashing by: the display
# points home at a plain cover in the separate host app (not replaced here) and puts it up; the new
# display takes home back when it starts. Then checks it started, and refreshes the runtime's library
# path in /data/local/tmp/rt.sh. If the install fails, home goes back to the display that's there.
# A rescue build (release.sh's rescue-<v>-for-<v>.apk: the release before, version code +1..9) is refused: it would
# put older code on the tablet under a newer number. OPENHOUSE_RESCUE_OK=1 to go back on purpose.
set -eo pipefail
APK="${1:-$(dirname "$0")/../shell/app/build/outputs/apk/debug/app-debug.apk}"
. "$(dirname "$0")/env.sh"
if [ -z "$OPENHOUSE_RESCUE_OK" ]; then
  VC=$("$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)/aapt2" dump badging "$APK" 2>/dev/null | sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p" | head -1)
  if [[ "$(basename "$APK")" == rescue-* || "$(basename "$APK")" == *-rescue-* ]] || { [ -n "$VC" ] && [ "$VC" -gt 1000 ] && [ $((VC % 100)) -ge 1 ] && [ $((VC % 100)) -le 9 ]; }; then
    echo "$APK is a rescue build (version code $VC): the release before, to go back with. Not installed; OPENHOUSE_RESCUE_OK=1 to install it anyway." >&2; exit 1
  fi
fi
PKG=$DISPLAY_PKG
# Home back to the display, and the cover (pinned, in the host app) taken down.
uncover() {
  adb shell am broadcast -n $PKG/dev.openhouse.shell.PrepareUpdateReceiver -a dev.openhouse.shell.PREPARE_UPDATE --ez cancel true >/dev/null 2>&1 || true
  adb shell am force-stop $HOST_PKG >/dev/null 2>&1 || true
  adb shell am start -a android.intent.action.MAIN -c android.intent.category.HOME -n $PKG/dev.openhouse.shell.MainActivity >/dev/null 2>&1 || true
}
adb shell am broadcast -n $PKG/dev.openhouse.shell.PrepareUpdateReceiver -a dev.openhouse.shell.PREPARE_UPDATE >/dev/null 2>&1 || true
sleep 1.2
if ! out=$(adb install -r -t "$APK" 2>&1) || ! printf '%s\n' "$out" | grep -q '^Success'; then
  printf '%s\n' "$out" | tail -3 >&2
  echo "Install failed; the display that was there stays (home back to it)." >&2
  uncover; exit 1
fi
echo Success
# The new display reopens itself (UpdatedReceiver). Wait for it to be in front.
for i in $(seq 1 30); do
  if adb shell dumpsys activity activities 2>/dev/null | grep -E 'mResumedActivity|topResumedActivity' | grep -qE "$PKG/(dev\.openhouse\.shell)?\.MainActivity"; then started=1; break; fi
  sleep 1
done
if [ -z "$started" ]; then
  echo "The new display didn't come to the front in 30 s; starting it." >&2
  adb shell am start -a android.intent.action.MAIN -c android.intent.category.HOME -n $PKG/dev.openhouse.shell.MainActivity >/dev/null 2>&1 || true
  sleep 3
  adb shell dumpsys activity activities 2>/dev/null | grep -E 'mResumedActivity|topResumedActivity' | grep -qE "$PKG/(dev\.openhouse\.shell)?\.MainActivity" || { echo "It still isn't running: check adb logcat." >&2; exit 1; }
fi
echo "Display running."
L=$(adb shell pm path $PKG | sed 's/package://;s/base.apk//' | tr -d '\r')
adb shell "test -f /data/local/tmp/rt.sh && sed -i 's#^L=.*#L=${L}lib/arm64#' /data/local/tmp/rt.sh" || true

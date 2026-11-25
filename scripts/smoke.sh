#!/bin/bash
# Boot a release before it goes out: on an emulator, its display APK and then its rescue (installed over it, as a
# tablet goes back) each install, start, unpack the release's runtime, the bridge answers /state, the home screen's
# page loads, and nothing of OpenHouse crashes (no FATAL EXCEPTION in logcat). Read-only on the release folder.
#
#   scripts/smoke.sh <release folder> [--serial emulator-NNNN] [--keep]
#
#   (no --serial)  a throwaway emulator: a new AVD in a temporary folder (system-images;android-35;google_apis;arm64-v8a,
#                  as scripts/create-avd.sh), booted with no window on a free port, shut down and deleted after
#   --serial S     an emulator already running. Only emulator-<port> serials of a running emulator are taken: never a
#                  physical device. OpenHouse's release apps are uninstalled from it first (its data with them).
#   --keep         leave the throwaway emulator running after (it says how to stop it)
#
# The runtime is served from the folder over adb reverse (as scripts/tablet-setup.sh does), and updates are pointed at
# nowhere so the emulator never fetches the published manifest. About 90 s on a recent Mac.
set -eo pipefail
cd "$(dirname "$0")/.."
. scripts/env.sh
unset ANDROID_SERIAL # every adb call names the emulator itself (a()), never "the one device"

DIR=$1; shift || true
[ -n "$DIR" ] && [ -f "$DIR/update.json" ] || { sed -n '2,15p' "$0"; exit 1; }
DIR=$(cd "$DIR" && pwd)
SERIAL= KEEP=
while [ $# -gt 0 ]; do
  case "$1" in
    --serial) SERIAL=$2; shift ;;
    --keep) KEEP=1 ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

# --- the release ------------------------------------------------------------------------------------------------------
BT=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
m() { node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = process.argv[2].split(".").reduce((o, k) => o?.[k], m); process.stdout.write(v == null ? "" : String(v))' "$DIR/update.json" "$1"; }
VERSION=$(m version) APK=$(m url) RVERSION=$(m rescue.version) RAPK=$(m rescue.url)
[ -n "$APK" ] && [ -f "$DIR/$APK" ] || { echo "No display APK in $DIR (update.json url: ${APK:-none})." >&2; exit 1; }
[ -z "$RAPK" ] || [ -f "$DIR/$RAPK" ] || { echo "update.json names a rescue, $RAPK, that isn't in $DIR." >&2; exit 1; }
[ -n "$RAPK" ] || echo "Note: this release has no rescue; only the display is checked." >&2
[ -f "$DIR/runtime.tar.gz" ] || { echo "No runtime.tar.gz in $DIR: a fresh display has nothing to unpack." >&2; exit 1; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
[ "$(sha "$DIR/$APK")" = "$(m sha256)" ] || { echo "$APK isn't the file update.json describes (sha256)." >&2; exit 1; }
[ -z "$RAPK" ] || [ "$(sha "$DIR/$RAPK")" = "$(m rescue.sha256)" ] || { echo "$RAPK isn't the file update.json describes (sha256)." >&2; exit 1; }
badging() { "$BT/aapt2" dump badging "$1" 2>/dev/null | sed -n "s/.* $2='\([^']*\)'.*/\1/p" | head -1; }
PKG=$(badging "$DIR/$APK" name)
[ -n "$PKG" ] || { echo "Couldn't read $APK's package name." >&2; exit 1; }
APPID=${PKG%.shell}
[ -z "$RAPK" ] || [ "$(badging "$DIR/$RAPK" name)" = "$PKG" ] || { echo "$RAPK isn't the same app as $APK." >&2; exit 1; }

START=$(date +%s)
el() { echo "$(( $(date +%s) - START ))s"; }
say() { echo "[$(el)] $*"; }
FAILED=

# --- the emulator -----------------------------------------------------------------------------------------------------
WORK=$(mktemp -d "${TMPDIR:-/tmp}/openhouse-smoke.XXXXXX")
EMU_PID= SERVER_PID=
cleanup() {
  set +e
  [ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; }
  if [ -n "$EMU_PID" ]; then
    if [ -n "$KEEP" ]; then echo "The emulator stays up ($SERIAL): adb -s $SERIAL emu kill, then rm -rf $WORK"; return; fi
    say "Shutting the emulator down…"
    adb -s "$SERIAL" emu kill >"$WORK/kill.log" 2>&1 || cat "$WORK/kill.log" >&2
    # The emulator runs as its own qemu process (the launcher may be gone): ours is the one on our AVD and port.
    for _ in $(seq 30); do pgrep -f -- "-avd smoke -port $PORT " >/dev/null || break; sleep 1; done
    pkill -f -- "-avd smoke -port $PORT " 2>/dev/null || true
    kill "$EMU_PID" 2>/dev/null || true
  elif [ -n "$OK_SERIAL" ]; then
    adb -s "$SERIAL" reverse --remove "tcp:$RPORT" >/dev/null 2>&1 || true
    adb -s "$SERIAL" forward --remove "tcp:$FPORT" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# Is <serial> an emulator? Its name says emulator-<port>, adb lists it so, and the device itself says it's one (qemu).
is_emulator() {
  [[ "$1" =~ ^emulator-[0-9]+$ ]] || return 1
  adb devices | tr -d '\r' | grep -qE "^$1[[:space:]]+device$" || return 1
  [ "$(adb -s "$1" shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r')" = 1 ] ||
    [ "$(adb -s "$1" shell getprop ro.boot.qemu 2>/dev/null | tr -d '\r')" = 1 ]
}
OK_SERIAL= # set once $SERIAL is known to be an emulator: until then a() refuses
a() { [ -n "$OK_SERIAL" ] && [ "$OK_SERIAL" = "$SERIAL" ] || { echo "not an emulator: $SERIAL" >&2; exit 1; }; adb -s "$SERIAL" "$@"; }

if [ -n "$SERIAL" ]; then
  is_emulator "$SERIAL" || { echo "$SERIAL isn't a running emulator (emulator-<port>, and the device says it's one). Smoke tests never use a physical device." >&2; exit 1; }
else
  IMG="system-images;android-35;google_apis;arm64-v8a"
  [ -d "$ANDROID_HOME/system-images/android-35/google_apis/arm64-v8a" ] || { echo "No $IMG: sdkmanager \"$IMG\" (about 1.5 GB), or --serial a running emulator." >&2; exit 1; }
  for p in $(seq 5560 2 5584); do
    adb devices | grep -q "^emulator-$p[[:space:]]" && continue
    lsof -ti "tcp:$p" -sTCP:LISTEN >/dev/null 2>&1 && continue
    lsof -ti "tcp:$((p + 1))" -sTCP:LISTEN >/dev/null 2>&1 && continue
    PORT=$p; break
  done
  [ -n "$PORT" ] || { echo "No free emulator port in 5560-5584." >&2; exit 1; }
  SERIAL=emulator-$PORT
  export ANDROID_AVD_HOME=$WORK/avd; mkdir -p "$ANDROID_AVD_HOME"
  echo no | avdmanager create avd -f -n smoke -k "$IMG" -d pixel_tablet >/dev/null
  CFG=$ANDROID_AVD_HOME/smoke.avd/config.ini
  { echo hw.ramSize=4096; echo disk.dataPartition.size=8G; echo hw.lcd.width=1920; echo hw.lcd.height=1080
    echo hw.lcd.density=160; echo hw.initialOrientation=landscape; echo hw.audioInput=no; echo showDeviceFrame=no; } >> "$CFG"
  say "Booting a throwaway emulator ($SERIAL)…"
  emulator -avd smoke -port "$PORT" -no-window -no-audio -no-snapshot -no-boot-anim -gpu swiftshader_indirect \
    -crash-report-mode never -no-metrics -dns-server 8.8.8.8,1.1.1.1 >"$WORK/emulator.log" 2>&1 &
  EMU_PID=$!
  for _ in $(seq 180); do
    kill -0 "$EMU_PID" 2>/dev/null || { tail -20 "$WORK/emulator.log" >&2; echo "The emulator stopped." >&2; exit 1; }
    [ "$(adb -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break
    sleep 2
  done
  is_emulator "$SERIAL" || { echo "The emulator didn't come up in 6 minutes." >&2; exit 1; }
fi
OK_SERIAL=$SERIAL
say "Using $SERIAL ($(a shell getprop ro.product.model | tr -d '\r'), Android $(a shell getprop ro.build.version.release | tr -d '\r'))"
for p in "$PKG" "$APPID.host" "$APPID.agent"; do a uninstall "$p" >/dev/null 2>&1 || true; done

# The runtime, from the release folder, at 127.0.0.1:<RPORT> on the emulator; the bridge, at localhost:<FPORT> here.
free_port() { for p in $(seq "$1" "$2"); do lsof -ti "tcp:$p" -sTCP:LISTEN >/dev/null 2>&1 || { echo "$p"; return; }; done; }
RPORT=$(free_port 18800 18899) FPORT=$(free_port 18900 18999)
python3 -m http.server "$RPORT" --bind 127.0.0.1 --directory "$DIR" >"$WORK/http.log" 2>&1 &
SERVER_PID=$!
a reverse "tcp:$RPORT" "tcp:$RPORT" >/dev/null
a forward "tcp:$FPORT" tcp:8787 >/dev/null

token() { a shell am broadcast -n "$PKG/dev.openhouse.shell.ConfigReceiver" -a dev.openhouse.shell.CONFIG --ez token true 2>/dev/null | tr -d '\r' | sed -n 's/.*data="\([0-9a-f]*\)".*/\1/p'; }
crashes() { # FATAL EXCEPTIONs in any of OpenHouse's processes since the log was cleared
  a logcat -d -b crash -b main 2>/dev/null | tr -d '\r' | grep -A2 'FATAL EXCEPTION' | grep -E "Process: $APPID(\.|,)" | sort -u
}
home() { a shell am start -S -a android.intent.action.MAIN -c android.intent.category.HOME -n "$PKG/dev.openhouse.shell.MainActivity" >/dev/null; }

# check <label> <apk> <version> <wait s>: install it (over what's there), start it, wait for the bridge and home page.
check() {
  local label=$1 apk=$2 version=$3 wait=$4 t0 out code
  t0=$(date +%s)
  say "$label: installing $(basename "$apk")…"
  a logcat -c -b all >/dev/null 2>&1 || a logcat -c
  if ! out=$(a install -r "$apk" 2>&1) || ! printf '%s\n' "$out" | grep -q '^Success'; then
    printf '%s\n' "$out" | tail -3 >&2; echo "FAIL $label: didn't install." >&2; FAILED=1; return 1
  fi
  local want got; want=$(badging "$apk" versionCode)
  for _ in $(seq 10); do # the package manager can take a moment to list it
    got=$(a shell pm list packages --show-versioncode "$PKG" | tr -d '\r' | sed -n "s/^package:$PKG versionCode:\([0-9]*\).*/\1/p")
    [ "$got" = "$want" ] && break; sleep 1
  done
  [ -n "$want" ] && [ "$got" = "$want" ] || { echo "FAIL $label: installed as version code ${got:-none}, not $want." >&2; FAILED=1; return 1; }
  # Its runtime from here, and no manifest (an emulator must never fetch or install the published release).
  a shell am broadcast -n "$PKG/dev.openhouse.shell.ConfigReceiver" -a dev.openhouse.shell.CONFIG \
    --es runtime "http://127.0.0.1:$RPORT/runtime.tar.gz" --es update_url "http://127.0.0.1:9/update.json" >/dev/null
  home
  local state= page= tok
  for _ in $(seq $((wait / 3))); do
    if [ -z "$(a shell pidof "$PKG" | tr -d '\r')" ]; then sleep 3; [ -n "$(a shell pidof "$PKG" | tr -d '\r')" ] || home; fi
    tok=$(token)
    if [ -n "$tok" ] && curl -sf --max-time 5 -H "X-Openhouse-Token: $tok" "http://127.0.0.1:$FPORT/state" -o "$WORK/state.json"; then
      state=1
      code=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' -H "X-Openhouse-Token: $tok" "http://127.0.0.1:$FPORT/screen/?display")
      [ "$code" = 200 ] && { page=1; break; }
    fi
    [ -n "$(crashes)" ] && break
    sleep 3
  done
  sleep 5 # a crash just after it came up counts too
  local c; c=$(crashes)
  if [ -n "$c" ]; then
    echo "FAIL $label: FATAL EXCEPTION ($c)" >&2
    a logcat -d -b crash 2>/dev/null | tr -d '\r' | grep -A25 'FATAL EXCEPTION' | head -60 >&2
    FAILED=1; return 1
  fi
  [ -n "$state" ] || { echo "FAIL $label: the bridge never answered /state in ${wait}s." >&2; a logcat -d -s Runtime Setup | tail -20 >&2; FAILED=1; return 1; }
  [ -n "$page" ] || { echo "FAIL $label: the bridge answers, but /screen/?display gave $code." >&2; FAILED=1; return 1; }
  say "ok $label $version: installed, started, /state and the home page answer, no crash ($(( $(date +%s) - t0 ))s)"
}

check display "$DIR/$APK" "$VERSION" 900 || true
if [ -n "$RAPK" ] && [ -z "$FAILED" ]; then check rescue "$DIR/$RAPK" "$RVERSION" 300 || true; fi

if [ -n "$FAILED" ]; then say "Smoke test FAILED for $VERSION: don't publish it."; exit 1; fi
say "Smoke test passed for $VERSION${RAPK:+ and its rescue $RVERSION}."

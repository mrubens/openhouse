#!/bin/bash
# Build, install and launch the shell app on the running emulator.
set -e
. "$(dirname "$0")/env.sh"
cd "$(dirname "$0")/../shell"
./gradlew -q assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n $DISPLAY_PKG/dev.openhouse.shell.MainActivity "$@"

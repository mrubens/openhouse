#!/bin/bash
# Usage: start-emulator.sh [avd] [port]   e.g. start-emulator.sh 4096        (display-4096, emulator-5554)
#                                               start-emulator.sh devices 5556 (display-devices, emulator-5556)
# One emulator per session/worktree: each has its own AVD (an APFS clone of display-4096, made with
# `cp -c -R`) and its own console port, so its adb serial is emulator-<port>. Never uploads crash
# reports or metrics.
. "$(dirname "$0")/env.sh"
exec emulator -avd "display-${1:-4096}" -port "${2:-5554}" -no-snapshot-save -no-boot-anim -gpu host -crash-report-mode never -no-metrics -dns-server 8.8.8.8,1.1.1.1

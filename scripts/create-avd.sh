#!/bin/bash
# 15.6" 1920x1080 landscape tablet, Google APIs image (no Play Store, so adb root works).
# Usage: create-avd.sh [ram_mb]   (default 4096)
set -e
. "$(dirname "$0")/env.sh"
RAM=${1:-4096}
NAME=display-${RAM}
IMG="system-images;android-35;google_apis;arm64-v8a"
echo no | avdmanager create avd -f -n "$NAME" -k "$IMG" -d pixel_tablet >/dev/null
CFG="$HOME/.android/avd/$NAME.avd/config.ini"
set_cfg() { grep -q "^$1=" "$CFG" && sed -i '' "s|^$1=.*|$1=$2|" "$CFG" || echo "$1=$2" >> "$CFG"; }
set_cfg hw.lcd.width 1920
set_cfg hw.lcd.height 1080
set_cfg hw.lcd.density 160
set_cfg hw.ramSize "$RAM"
set_cfg hw.initialOrientation landscape
set_cfg hw.keyboard yes
set_cfg hw.gpu.enabled yes
set_cfg hw.gpu.mode auto
set_cfg hw.audioInput yes
set_cfg disk.dataPartition.size 8G
set_cfg showDeviceFrame no
echo "created $NAME"

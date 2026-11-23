#!/bin/bash
# Run OpenHouse as a hub on a Mac, natively (docs/hub.md): it finds the TVs, speakers and printers on the Wi-Fi, which
# Docker Desktop can't. A desktop Mac (a mini) that stays on is the right kind; a laptop sleeps with its lid shut.
#   curl -fsSL https://raw.githubusercontent.com/mrubens/openhouse/main/hub/install-mac.sh | bash
#   or from a checkout: hub/install-mac.sh
# Puts OpenHouse in ~/OpenHouse (a git checkout, so the settings page can update it), Node 22 inside it, the household's
# things in ~/Library/Application Support/OpenHouse Hub, and starts it at login as a LaunchAgent that keeps the Mac from
# sleeping while it runs (caffeinate). Run again to repair or update. To take it off:
#   launchctl bootout gui/$(id -u)/computer.openhouse.hub; rm ~/Library/LaunchAgents/computer.openhouse.hub.plist
set -euo pipefail
REPO=${OPENHOUSE_REPO:-https://github.com/mrubens/openhouse.git}
BRANCH=${OPENHOUSE_BRANCH:-main}
CODE=${OPENHOUSE_CODE:-$HOME/OpenHouse}
DATA=${OPENHOUSE_DATA:-$HOME/Library/Application Support/OpenHouse Hub}
LABEL=computer.openhouse.hub
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_VERSION=22.23.4
[ "$(uname -s)" = Darwin ] || { echo "This is for a Mac. On Linux: hub/install.sh"; exit 1; }
[ "$(id -u)" != 0 ] || { echo "Run it as yourself, not with sudo."; exit 1; }

echo "== git"
if ! xcode-select -p >/dev/null 2>&1; then
  echo "git comes with Apple's command line tools: install them (a window opens), then run this again."
  xcode-select --install || true; exit 1
fi

echo "== OpenHouse in $CODE"
if [ -d "$CODE/.git" ]; then echo "(keeping the checkout there)"; else git clone --branch "$BRANCH" "$REPO" "$CODE"; fi

echo "== Node $NODE_VERSION"
case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) echo "Not a Mac this runs on: $(uname -m)"; exit 1 ;; esac
NODE="$CODE/.node"
if ! "$NODE/bin/node" -v 2>/dev/null | grep -q "^v$NODE_VERSION$"; then
  rm -rf "$NODE" && mkdir -p "$NODE"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-$ARCH.tar.gz" | tar -xz -C "$NODE" --strip-components 1
fi
export PATH="$NODE/bin:$PATH"

echo "== building (a minute or two)"
bash "$CODE/hub/build.sh"

echo "== starting at login"
mkdir -p "$DATA" "$HOME/Library/LaunchAgents" && chmod 700 "$DATA"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/caffeinate</string><string>-i</string><string>-s</string><string>/bin/bash</string><string>$CODE/hub/start.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENHOUSE_DATA</key><string>$DATA</string>
    <key>OPENHOUSE_CODE_DIR</key><string>$CODE</string>
    <key>OPENHOUSE_INSTALL</key><string>git</string>
    <key>PATH</key><string>$NODE/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$DATA/hub.log</string>
  <key>StandardErrorPath</key><string>$DATA/hub.log</string>
</dict>
</plist>
PL
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "== waiting for it"
for i in $(seq 1 90); do [ -s "$DATA/hub-setup.txt" ] && break; curl -fsS -o /dev/null http://127.0.0.1:8788/hub/ 2>/dev/null && break; sleep 1; done
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
echo
if [ -s "$DATA/hub-setup.txt" ]; then sed "s#<this machine's address>#${IP:-this Mac}#" "$DATA/hub-setup.txt"; else echo "It's running: open http://${IP:-this Mac}:8788/hub/ on a settings device."; fi
echo "If macOS asks whether node may accept incoming connections, say Allow: that's phones reaching the hub."
echo "Logs: $DATA/hub.log"

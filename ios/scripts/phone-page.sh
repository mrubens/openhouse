#!/bin/sh
# Xcode build phase (project.yml): builds the phone page into the app (chat/phone-page.mjs), so the app serves its own
# copy (App/PhonePage.swift). Fails the build rather than make an app without its page.
set -e
for d in "$HOME/.local/share/mise/shims" "$HOME/.volta/bin" /opt/homebrew/bin /usr/local/bin; do PATH="$PATH:$d"; done
command -v node >/dev/null || { echo "error: the phone page needs node (https://nodejs.org) to build"; exit 1; }
CHAT="$SRCROOT/../chat"
[ -d "$CHAT/node_modules/esbuild" ] || (cd "$CHAT" && npm ci --no-audit --no-fund)
node "$CHAT/phone-page.mjs" "$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/PhonePage"

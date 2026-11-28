#!/bin/bash
# Update a hub installed from a checkout (hub/install.sh on Linux, hub/install-mac.sh): to the newest release (a v* tag
# on the branch, only ever forward), build, and let the bridge restart (bridge/hub.js POST /hub/update runs this, then
# exits; systemd or launchd starts it on the new code). A build that fails puts the version before back. Docker hubs
# pull a new image instead. (On Linux the keeper runs its own copy of its code: sudo hub/install.sh moves that on.)
#   --back  the version before the last update, again (Go back on the settings page; hub/start.sh does it by itself
#           when the new version stops within a minute of starting). The next update moves forward from there.
set -euo pipefail
cd "$(dirname "$0")/.."
G=$(git rev-parse --git-dir)
if [ "${1:-}" = --back ]; then
  [ -s "$G/opie-previous" ] || { echo "no version to go back to"; exit 1; }
  P=$(cat "$G/opie-previous") NOW=$(git rev-parse HEAD)
  echo "$(date '+%F %T') going back from ${NOW:0:7} to ${P:0:7}"
  git reset -q --hard "$P"
  # (the version to go back to is forgotten only once it's built; if it doesn't build, the one we were on comes back)
  if hub/build.sh; then rm -f "$G/opie-previous"; exit 0; fi
  echo "$(date '+%F %T') ${P:0:7} didn't build: staying on ${NOW:0:7}"
  git reset -q --hard "$NOW"; hub/build.sh || true
  exit 1
fi
NOW=$(git rev-parse HEAD)
echo "$(date '+%F %T') updating from ${NOW:0:7}"
B=$(git rev-parse --abbrev-ref HEAD); [ "$B" != HEAD ] || B=main
git fetch -q --tags origin "$B"
# The newest release tag on the branch that's ahead of here (never back, never a commit between releases).
TO=$(git tag -l 'v*' --merged "origin/$B" --sort=-v:refname | head -1)
[ -n "$TO" ] || { echo "no release to update to"; exit 1; }
TO_SHA=$(git rev-parse "$TO^{commit}")
git merge-base --is-ancestor "$NOW" "$TO_SHA" || { echo "$TO isn't ahead of ${NOW:0:7}: staying"; exit 0; }
[ "$TO_SHA" != "$NOW" ] || { echo "already at $TO"; exit 0; }
git reset -q --hard "$TO_SHA"
if ! hub/build.sh; then
  echo "$(date '+%F %T') $TO didn't build: back to ${NOW:0:7}"
  git reset -q --hard "$NOW"; hub/build.sh || true
  exit 1
fi
echo "$NOW" > "$G/opie-previous"; date +%s > "$G/opie-updated"
echo "$(date '+%F %T') now at $TO ($(git rev-parse --short HEAD))"

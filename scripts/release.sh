#!/bin/bash
# Build a release of the display for self-update (docs/self-update.md): the display APK (carrying the bridge and the
# update cover), signed with the release key, its rescue build, and the manifest the tablets read (update.json).
#
#   scripts/release.sh 0.3.0 --rescue v0.2.0 [--rollout 10] [--min 0.2.0] [--notes "Timers keep going"] \
#       [--ref HEAD] [--update-url https://…/update.json] [--out dist/0.3.0] [--publish github]
#
#   --ref REF        what to build (default HEAD), from a clean checkout of it: nothing uncommitted goes out
#   --rescue REF     the release before (its tag): built again with a version code one above this one's, so a tablet
#                    this release breaks can go back to it. Without one, tablets install it only when someone asks.
#   --rescue-version the rescue's version name (default: REF without its leading v)
#   --rollout N      percentage of tablets offered it (default 100); raise it later by editing update.json
#   --min VERSION    tablets older than this take it whatever the rollout, at the next quiet moment
#   --update-url URL where the built display looks for updates (default: openhouse.updateUrl in shell/gradle.properties)
#   --publish github upload to a GitHub release v<version> with gh (ask first: this is public). Otherwise the folder
#                    in --out is what to put on a static host, as it is.
#   --local N        a build for one tablet, never published: <version> is the release it builds on (the newest the
#                    tablet has, published or local), and it's named <version>-local.N with version code
#                    <version's> + 10 + N (N 1..79). Above that release and its rescue (+1), below the next published
#                    one (+100), so the next release still updates the tablet and no number is used up. No rescue;
#                    the cloud's release.ts refuses it.
#
# The release key never goes in the repo. By default it's ~/.openhouse/release/release.jks (made once by
# scripts/release-key.sh), its password in the login keychain ("roo-home-release-key"):
#   OPENHOUSE_RELEASE_KS       the keystore             OPENHOUSE_RELEASE_ALIAS  its key's alias (release)
#   OPENHOUSE_RELEASE_KS_PASS  its password, as apksigner takes it: pass:…, env:NAME, file:… (default: the keychain,
#                              else asks)
#   OPENHOUSE_LINEAGE          a lineage file, only for a package that tablets ran debug builds of (release-key.sh
#                              --lineage); OpenHouse's own IDs have none
set -eo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
. scripts/env.sh
BT=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)

VERSION=$1; shift || true
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { sed -n '2,25p' "$0"; exit 1; }
REF=HEAD RESCUE= RESCUE_VERSION= ROLLOUT=100 MIN= NOTES= OUT= PUBLISH= LOCAL=
URL=${OPENHOUSE_UPDATE_URL:-$(sed -n 's/^openhouse.updateUrl=//p' shell/gradle.properties)}
# Releases are built under OpenHouse's own IDs (openhouse.releaseAppId), whatever openhouse.appId says for debug builds.
APPID=$(sed -n 's/^openhouse.releaseAppId=//p' shell/gradle.properties)
[ -n "$APPID" ] || { echo "No openhouse.releaseAppId in shell/gradle.properties." >&2; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF=$2; shift ;;
    --rescue) RESCUE=$2; shift ;;
    --rescue-version) RESCUE_VERSION=$2; shift ;;
    --rollout) ROLLOUT=$2; shift ;;
    --min) MIN=$2; shift ;;
    --notes) NOTES=$2; shift ;;
    --update-url) URL=$2; shift ;;
    --out) OUT=$2; shift ;;
    --publish) PUBLISH=$2; shift ;;
    --local) LOCAL=$2; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
  shift
done
if [ -n "$LOCAL" ]; then
  [[ "$LOCAL" =~ ^[0-9]+$ ]] && [ "$LOCAL" -ge 1 ] && [ "$LOCAL" -le 79 ] || { echo "--local takes 1 to 79." >&2; exit 1; }
  [ -z "$RESCUE$PUBLISH" ] || { echo "A --local build has no rescue and isn't published." >&2; exit 1; }
fi
BASE=$VERSION; [ -n "$LOCAL" ] && VERSION=$BASE-local.$LOCAL
OUT=${OUT:-dist/$VERSION}
[ -n "$URL" ] || echo "Note: no update URL (shell/gradle.properties openhouse.updateUrl, or --update-url): tablets running this release won't look for the next one unless it's set over adb." >&2
KS=${OPENHOUSE_RELEASE_KS:-$HOME/.openhouse/release/release.jks}
ALIAS=${OPENHOUSE_RELEASE_ALIAS:-release}
LINEAGE=${OPENHOUSE_LINEAGE:-}
[ -f "$KS" ] || { echo "No release key at $KS (scripts/release-key.sh makes one; docs/self-update.md)." >&2; exit 1; }
if [ -z "$OPENHOUSE_RELEASE_KS_PASS" ] && P=$(security find-generic-password -s roo-home-release-key -a release -w 2>/dev/null); then export OPENHOUSE_KS_P=$P; OPENHOUSE_RELEASE_KS_PASS=env:OPENHOUSE_KS_P; fi
if [ -z "$OPENHOUSE_RELEASE_KS_PASS" ]; then read -rsp "Release key password: " P; echo; export OPENHOUSE_KS_P=$P; OPENHOUSE_RELEASE_KS_PASS=env:OPENHOUSE_KS_P; fi

code() { IFS=. read -r a b c <<< "$1"; echo $(( a * 1000000 + b * 10000 + c * 100 )); }
CODE=$(( $(code "$BASE") + ${LOCAL:+10 + $LOCAL} + 0 ))
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
WORK=$(mktemp -d); trap 'cd "$ROOT"; for w in "$WORK"/src-*; do [ -d "$w" ] && git worktree remove --force "$w" >/dev/null 2>&1; done; rm -rf "$WORK"' EXIT

# Sign: the release key, with the lineage when there is one (tablets signed with the debug key take it then).
# APK Signature Scheme v3 only, with the rotation applied from Android 9 on (the display needs 10): v1 and v2 would have
# to be signed with the oldest key in the lineage, the debug key, and no Android the display runs on reads them.
sign() {
  local in=$1 out=$2
  "$BT/zipalign" -f -p 4 "$in" "$WORK/aligned.apk"
  local lin=(--v2-signing-enabled true); [ -n "$LINEAGE" ] && [ -f "$LINEAGE" ] && lin=(--lineage "$LINEAGE" --rotation-min-sdk-version 28 --v2-signing-enabled false)
  "$BT/apksigner" sign --ks "$KS" --ks-key-alias "$ALIAS" --ks-pass "$OPENHOUSE_RELEASE_KS_PASS" "${lin[@]}" \
    --min-sdk-version 29 --v1-signing-enabled false --v3-signing-enabled true --out "$out" "$WORK/aligned.apk"
  "$BT/apksigner" verify --min-sdk-version 29 "$out"
}

# build <ref> <versionName> <versionCode> <out.apk>: a clean checkout of ref, its bridge bundled, the update cover signed
# first and carried inside, then the display signed. (A rescue ref from before 1.0.9 has the agent's app too, built and
# carried as it was then.)
build() {
  local ref=$1 name=$2 vcode=$3 dest=$4 src="$WORK/src-$3"
  git worktree add --detach "$src" "$ref" >/dev/null
  [ -d "$ROOT/chat/node_modules" ] && ln -s "$ROOT/chat/node_modules" "$src/chat/node_modules"
  echo "Building $name ($vcode) from $(git -C "$src" rev-parse --short HEAD)…"
  (cd "$src" && scripts/runtime-assets.sh >/dev/null)
  local agent=()
  if [ -d "$src/shell/agent" ]; then # a ref from before 1.0.9 carries the agent's app: built and signed as it was
    (cd "$src/shell" && ./gradlew -q :agent:assembleRelease -Popenhouse.release=true -Popenhouse.appId="$APPID")
    sign "$src/shell/agent/build/outputs/apk/release/agent-release-unsigned.apk" "$WORK/agent-$vcode.apk"
    agent=(-Popenhouse.agentApk="$WORK/agent-$vcode.apk")
  fi
  # The update cover, carried in the display (which installs it as owner: a QR-set-up tablet needs no adb for it) and
  # beside it (install-display.sh, move-tablet.sh). An older ref without the asset just ignores openhouse.hostApk.
  (cd "$src/shell" && ./gradlew -q :host:assembleRelease -Popenhouse.appId="$APPID")
  sign "$src/shell/host/build/outputs/apk/release/host-release-unsigned.apk" "$WORK/host-$vcode.apk"
  (cd "$src/shell" && ./gradlew -q :app:assembleRelease -Popenhouse.version="$name" -Popenhouse.versionCode="$vcode" \
    "${agent[@]}" -Popenhouse.hostApk="$WORK/host-$vcode.apk" -Popenhouse.updateUrl="$URL" -Popenhouse.appId="$APPID")
  sign "$src/shell/app/build/outputs/apk/release/app-release-unsigned.apk" "$dest"
  [ -z "$HOST_OUT" ] || cp "$WORK/host-$vcode.apk" "$HOST_OUT"
  # The Claude app's download this display carries (scripts/build-mcpb.sh), for its https copy: the Connect screen links
  # releases/connect/<first 16 hex of its sha256>/ (bridge/connect-page.js), so it goes up with the release.
  if [ -n "$EXT_OUT" ] && [ -f "$src/bridge/public/connect/extension.json" ]; then
    local h; h=$(node -p "require('$src/bridge/public/connect/extension.json').sha256.slice(0, 16)")
    mkdir -p "$EXT_OUT/$h" && cp "$src/bridge/public/connect/"{openhouse.mcpb,openhouse-mcp.mjs,extension.json} "$EXT_OUT/$h/"
  fi
}

APK=display-$VERSION.apk
HOST_OUT="$OUT/host-$VERSION.apk" EXT_OUT=$([ -z "$LOCAL" ] && echo "$OUT/connect") build "$REF" "$VERSION" "$CODE" "$OUT/$APK"
if [ -n "$RESCUE" ]; then
  RESCUE_VERSION=${RESCUE_VERSION:-${RESCUE#v}}
  # Not display-*.apk: a rescue is the release before, installed only to go back (a glob for the display missed it).
  RAPK=rescue-$RESCUE_VERSION-for-$VERSION.apk
  build "$RESCUE" "$RESCUE_VERSION" $((CODE + 1)) "$OUT/$RAPK"
fi

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
size() { stat -f %z "$1"; }
node - "$OUT/update.json" <<EOF
const fs = require('fs');
const m = { schema: 1, version: '$VERSION', versionCode: $CODE, url: '$APK', sha256: '$(sha "$OUT/$APK")', size: $(size "$OUT/$APK"),
  rollout: $ROLLOUT, notes: $(printf '%s' "$NOTES" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))'),
  released: new Date().toISOString() };
if ('$MIN') m.minVersion = '$MIN';
if ('$RESCUE') m.rescue = { version: '$RESCUE_VERSION', versionCode: $((CODE + 1)), url: '${RAPK:-}', sha256: '$( [ -n "$RESCUE" ] && sha "$OUT/$RAPK")', size: $( [ -n "$RESCUE" ] && size "$OUT/$RAPK" || echo 0) };
fs.writeFileSync(process.argv[2], JSON.stringify(m, null, 2) + '\n');
EOF
echo; cat "$OUT/update.json"; echo "In $OUT"
# The extension's https copy is its own upload, like the voice set: until it's up, the tablet serves its own copy.
for d in "$OUT"/connect/*/; do [ -d "$d" ] && echo "Extension: AWS_PROFILE=openhouse-admin scripts/cloud.sh node scripts/release.ts --extension \"${d%/}\""; done

if [ "$PUBLISH" = github ]; then
  # update.json goes up as an asset of the newest release: https://github.com/<owner>/<repo>/releases/latest/download/update.json
  gh release create "v$VERSION" "$OUT/$APK" ${RAPK:+"$OUT/$RAPK"} "$OUT/update.json" --title "$VERSION" --notes "${NOTES:-Display $VERSION}"
fi

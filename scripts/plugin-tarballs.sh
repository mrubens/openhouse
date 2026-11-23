#!/bin/bash
# Tarballs of this repo's plugins (plugins/<name>/), to add from a link: package/ at the root, from a commit (git
# archive, so only what's committed goes out), named <name>-<version>-<commit>.tgz, as the CDN serves them at
# https://d15yaylh7unz6h.cloudfront.net/releases/plugins/. Uploading is a separate, asked-for step.
#
#   scripts/plugin-tarballs.sh [--ref REF] [--out dist/plugins] [name...]   (no names: every plugin)
set -eo pipefail
cd "$(dirname "$0")/.."
REF=HEAD OUT=dist/plugins NAMES=()
while [ $# -gt 0 ]; do
  case $1 in --ref) REF=$2; shift ;; --out) OUT=$2; shift ;; *) NAMES+=("$1") ;; esac; shift
done
COMMIT=$(git rev-parse --short=7 "$REF^{commit}")
[ ${#NAMES[@]} -gt 0 ] || NAMES=($(git ls-tree --name-only "$REF" plugins/ | sed 's#plugins/##'))
mkdir -p "$OUT"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
for n in "${NAMES[@]}"; do
  git cat-file -e "$REF:plugins/$n/package.json" 2>/dev/null || { echo "plugins/$n has no package.json at $REF" >&2; exit 1; }
  V=$(git show "$REF:plugins/$n/package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
  rm -rf "$TMP/package" && mkdir "$TMP/package"
  git archive "$REF" "plugins/$n" | tar -x -C "$TMP/package" --strip-components 2
  F="$OUT/$n-$V-$COMMIT.tgz"
  COPYFILE_DISABLE=1 tar -czf "$F" -C "$TMP" --uid 0 --gid 0 --uname '' --gname '' package 2>/dev/null || COPYFILE_DISABLE=1 tar -czf "$F" -C "$TMP" package
  echo "$F  https://d15yaylh7unz6h.cloudfront.net/releases/plugins/$(basename "$F")"
done

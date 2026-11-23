#!/bin/bash
# Build the display's Linux runtime (runtime/Dockerfile) into runtime/out/runtime.tar.gz.
# Hard links are flattened so the shell can unpack it with Android's own tar, without root.
set -e
cd "$(dirname "$0")/../runtime"
docker build --platform linux/arm64 -t openhouse-runtime .
mkdir -p out
docker run --rm --platform linux/arm64 -v "$PWD/out:/out" openhouse-runtime \
  tar --hard-dereference --one-file-system --numeric-owner --exclude=./out --exclude=./proc --exclude=./sys --exclude=./dev \
      --exclude=./var/cache/apt -czf /out/runtime.tar.gz -C / .
ls -la out/runtime.tar.gz

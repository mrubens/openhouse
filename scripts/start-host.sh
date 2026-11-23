#!/bin/bash
# M0: dev server + bridge on the host. Emulator reaches them at 10.0.2.2.
cd "$(dirname "$0")/.."
(cd webapp && npm run dev) & 
BRIDGE_DEV=1 AGENT_MODEL="${AGENT_MODEL:-opus}" node bridge/server.js & # on the Mac: no bridge secret (bridge/auth.js)
wait

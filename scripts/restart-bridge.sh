#!/bin/bash
# Restart only the bridge (the listening process; the emulator also holds sockets to :8787).
cd "$(dirname "$0")/.."
kill $(lsof -ti tcp:8787 -sTCP:LISTEN) 2>/dev/null; sleep 0.5
BRIDGE_DEV=1 AGENT_MODEL="${AGENT_MODEL:-opus}" nohup node bridge/server.js >> bridge.log 2>&1 &
for i in $(seq 1 20); do curl -s localhost:8787/state >/dev/null && break; sleep 0.3; done
echo "bridge up (AGENT_MODEL=${AGENT_MODEL:-opus})"

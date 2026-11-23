# Source me: tool paths for the prototype.
export JAVA_HOME="${JAVA_HOME:-$HOME/.sdkman/candidates/java/17.0.12-tem}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$JAVA_HOME/bin:$PATH"
# The apps' package IDs, from the one place they're set (shell/gradle.properties, openhouse.appId).
_oh_props="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)/shell/gradle.properties"
export OPENHOUSE_APP_ID="${OPENHOUSE_APP_ID:-$(sed -n 's/^openhouse.appId=//p' "$_oh_props" 2>/dev/null)}"
OPENHOUSE_APP_ID=${OPENHOUSE_APP_ID:-dev.openhouse}
export DISPLAY_PKG=$OPENHOUSE_APP_ID.shell AGENT_PKG=$OPENHOUSE_APP_ID.agent HOST_PKG=$OPENHOUSE_APP_ID.host
unset _oh_props

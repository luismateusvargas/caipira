#!/usr/bin/env sh
# Caipira launcher — always uses the bundled Node 22 runtime.
# better-sqlite3 is compiled against Node 22's ABI; a system Node of another major will not load it.
CAIPIRA_HOME="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
CAIPIRA_NODE="$CAIPIRA_HOME/node22/node-v22.20.0-linux-x64/bin/node"
if [ ! -x "$CAIPIRA_NODE" ]; then
  echo "[caipira] bundled Node 22 runtime not found at \"$CAIPIRA_NODE\"." >&2
  exit 1
fi
exec "$CAIPIRA_NODE" "$CAIPIRA_HOME/install.js" "$@"

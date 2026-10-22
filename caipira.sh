#!/usr/bin/env sh
# Caipira launcher — uses bundled Node 22 when its SQLite addon loads, else Node on PATH.
CAIPIRA_SCRIPT="$0"
while [ -L "$CAIPIRA_SCRIPT" ]; do
  CAIPIRA_PARENT="$(cd -P "$(dirname "$CAIPIRA_SCRIPT")" && pwd)" || exit 1
  CAIPIRA_SCRIPT="$(readlink "$CAIPIRA_SCRIPT")" || exit 1
  case "$CAIPIRA_SCRIPT" in /*) ;; *) CAIPIRA_SCRIPT="$CAIPIRA_PARENT/$CAIPIRA_SCRIPT" ;; esac
done
CAIPIRA_DIR="$(cd -P "$(dirname "$CAIPIRA_SCRIPT")" && pwd)" || exit 1
case "$(uname -s)" in
  Darwin) CAIPIRA_OS=darwin ;;
  Linux) CAIPIRA_OS=linux ;;
  *) echo '[caipira] unsupported operating system' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) CAIPIRA_ARCH=x64 ;;
  arm64|aarch64) CAIPIRA_ARCH=arm64 ;;
  *) echo '[caipira] unsupported architecture' >&2; exit 1 ;;
esac
CAIPIRA_NODE="$CAIPIRA_DIR/node22/node-v22.20.0-$CAIPIRA_OS-$CAIPIRA_ARCH/bin/node"
if [ -x "$CAIPIRA_NODE" ] && ! NODE_PATH="$CAIPIRA_DIR/node_modules${NODE_PATH:+:$NODE_PATH}" "$CAIPIRA_NODE" -e "require('better-sqlite3')" >/dev/null 2>&1; then
  CAIPIRA_NODE=''
fi
if [ -z "$CAIPIRA_NODE" ] || [ ! -x "$CAIPIRA_NODE" ]; then
  CAIPIRA_NODE="$(command -v node 2>/dev/null || true)"
  if [ -z "$CAIPIRA_NODE" ]; then
    echo '[caipira] Node.js 20, 22, or 24 is required; install Node.js or restore the bundled Node 22 runtime.' >&2
    exit 1
  fi
fi
case "$1" in
  explore)
    shift
    exec "$CAIPIRA_NODE" "$CAIPIRA_DIR/explore-server.js" "$@"
    ;;
esac
exec "$CAIPIRA_NODE" "$CAIPIRA_DIR/install.js" "$@"

#!/usr/bin/env sh
# Caipira launcher — always uses the deployment's pinned Node 22 runtime.
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
  *) echo '[caipira] unsupported operating system; run caipira install on a supported host' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) CAIPIRA_ARCH=x64 ;;
  arm64|aarch64) CAIPIRA_ARCH=arm64 ;;
  *) echo '[caipira] unsupported architecture; run caipira install on a supported host' >&2; exit 1 ;;
esac
CAIPIRA_LIBC=''
if [ "$CAIPIRA_OS" = linux ]; then
  if ldd --version 2>&1 | case "$(cat)" in *musl*) true ;; *) false ;; esac; then
    CAIPIRA_LIBC=-musl
  fi
fi
CAIPIRA_NODE="$CAIPIRA_DIR/node22/node-v22.23.4-$CAIPIRA_OS-$CAIPIRA_ARCH$CAIPIRA_LIBC/bin/node"
if [ ! -x "$CAIPIRA_NODE" ] || [ "$("$CAIPIRA_NODE" --version 2>/dev/null)" != v22.23.4 ]; then
  echo '[caipira] bundled Node 22.23.4 is missing or invalid; run caipira install' >&2
  exit 1
fi
case "$1" in
  explore)
    shift
    exec "$CAIPIRA_NODE" "$CAIPIRA_DIR/explore-server.js" "$@"
    ;;
esac
exec "$CAIPIRA_NODE" "$CAIPIRA_DIR/install.js" "$@"

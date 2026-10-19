#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Install Hewn from this checkout: exact dependencies (npm ci), `hewn` on your PATH, then a check.
#   git clone https://github.com/hewntools/hewn.git ~/hewn && cd ~/hewn && git checkout <tag> && ./install.sh
set -eu
cd "$(dirname "$0")"
APP="$(pwd)"

fail() { printf '✖ %s\n' "$1" >&2; exit 1; }

command -v git >/dev/null || fail "git is required"
command -v node >/dev/null || fail "Node.js 24 or newer is required: https://nodejs.org (or: nvm install 24)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 24 ] || fail "Node.js 24 or newer is required (this is $(node --version)): nvm install 24"

echo "Installing dependencies (npm ci)…"
npm ci --no-audit --no-fund --loglevel=error

chmod +x packages/cli/src/cli.ts
# `hewn` on PATH: npm's global bin if we may write there, else ~/.local/bin.
BIN="$(npm prefix -g)/bin"
if [ -w "$BIN" ]; then
  ln -sf "$APP/packages/cli/src/cli.ts" "$BIN/hewn"
else
  BIN="$HOME/.local/bin"
  mkdir -p "$BIN"
  ln -sf "$APP/packages/cli/src/cli.ts" "$BIN/hewn"
fi
echo "✔ hewn → $BIN/hewn"
HEWN=hewn
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    echo "! $BIN isn't on your PATH. Add it to your shell profile: export PATH=\"$BIN:\$PATH\""
    HEWN="$BIN/hewn"
    ;;
esac

echo "✔ Hewn $("$BIN/hewn" version)"
cat <<NEXT

Your data will live in ${HEWN_HOME:-$APP/data}, with nightly backups next to it.
  Data elsewhere:    set HEWN_HOME before installing the service, e.g. HEWN_HOME=~/Documents/hewn $HEWN service install
  Backups elsewhere: $HEWN backup dir <path>  (e.g. a synced folder)

Next:
  $HEWN service install    run Hewn in the background (starts at login, restarts if it stops)
  $HEWN doctor             check everything is ready (each problem comes with the fix)
  $HEWN open               open it in your browser: the first run takes it from there
NEXT

#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Hewn's one-line install, served as https://hewn.tools/install.sh:
#   curl -fsSL https://hewn.tools/install.sh | sh
# Checks Node.js 24; on Linux and WSL also glibc, the sandbox (bubblewrap, installed with apt when
# it's missing and this runs in a terminal) and, on WSL, systemd. Then installs @hewntools/cli with
# npm (into ~/.local when npm's global folder needs sudo), and says what's next. Contributors
# install from a checkout instead (./install.sh).
#   HEWN_PACKAGE   what to install instead of @hewntools/cli: a version (@hewntools/cli@0.4.0) or a .tgz
#   HEWN_NO_SUDO=1 never run sudo; only say what to install
set -eu

# Everything runs from main, so a download cut short runs nothing.
main() {
  fail() {
    printf '✖ %s\n' "$1" >&2
    exit 1
  }
  command -v node >/dev/null 2>&1 || fail "Hewn needs Node.js 24 or newer: https://nodejs.org (or with nvm: nvm install 24)"
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 24 ] || fail "Hewn needs Node.js 24 or newer (this is $(node --version)). With nvm: nvm install 24"
  command -v npm >/dev/null 2>&1 || fail "npm is missing (it comes with Node.js)"
  [ "$(uname -s)" = Linux ] && linux_checks

  pkg="${HEWN_PACKAGE:-@hewntools/cli}"
  prefix=$(npm prefix -g)
  dir="$prefix/lib/node_modules"
  [ -d "$dir" ] || dir="$prefix"
  if [ ! -w "$dir" ]; then
    prefix="$HOME/.local"
    echo "npm's global folder ($dir) needs sudo; installing into $prefix instead."
  fi

  echo "Installing Hewn with npm…"
  npm install -g --prefix "$prefix" --no-audit --no-fund --no-update-notifier --loglevel=error "$pkg"

  bin="$prefix/bin"
  hewn=hewn
  case ":$PATH:" in
    *":$bin:"*) ;;
    *)
      hewn="$bin/hewn"
      echo "! $bin isn't on your PATH. Add it to your shell profile: export PATH=\"$bin:\$PATH\""
      ;;
  esac
  echo "✔ Hewn $("$bin/hewn" version) ($bin/hewn)"

  cat <<NEXT

Your data will live in ~/.hewn, with nightly backups in ~/.hewn-backups.
  Data elsewhere: set HEWN_HOME before installing the service, e.g. HEWN_HOME=~/Documents/hewn $hewn service install

Next:
  $hewn service install    run Hewn in the background (starts at login, restarts if it stops)
  $hewn doctor             check everything is ready (each problem comes with the fix)
  $hewn open               open it in your browser: the first run takes it from there
NEXT
}

# Linux and WSL: what Hewn needs from the system, fixed where it's safe to, explained where it isn't.
linux_checks() {
  troubleshooting="https://github.com/hewntools/hewn/blob/main/docs/troubleshooting.md"
  glibc=$(ldd --version 2>/dev/null | head -1 | sed 's/.* //')
  case "$glibc" in
    2.[0-9] | 2.1[0-9] | 2.2[0-7]) fail "Hewn needs glibc 2.28 or newer (this system has $glibc): Ubuntu 22.04 or newer works. See $troubleshooting" ;;
  esac

  # The sandbox: bubblewrap.
  if ! command -v bwrap >/dev/null 2>&1; then
    if [ "${HEWN_NO_SUDO:-}" != 1 ] && command -v apt-get >/dev/null 2>&1 && [ -t 1 ] && [ -r /dev/tty ]; then
      echo "Hewn's sandbox needs bubblewrap. Installing it: sudo apt-get install -y bubblewrap"
      sudo apt-get install -y bubblewrap </dev/tty || echo "! That didn't work. Install it yourself: sudo apt install bubblewrap"
    else
      echo "! Hewn's sandbox needs bubblewrap: sudo apt install bubblewrap (or your distribution's package)"
    fi
  fi
  # Ubuntu 24.04 and later may refuse bubblewrap's user namespaces (AppArmor).
  if command -v bwrap >/dev/null 2>&1 && ! bwrap --ro-bind / / true >/dev/null 2>&1; then
    echo "! bubblewrap is installed but can't start (AppArmor on Ubuntu 24.04?). The fix: $troubleshooting#sandbox-linux"
  fi

  # WSL: the background service needs systemd.
  if grep -qi microsoft /proc/version 2>/dev/null && [ "$(ps -p 1 -o comm= 2>/dev/null)" != systemd ]; then
    cat <<WSL
! On WSL, Hewn's background service needs systemd, which is off here. To turn it on:
    1. sudo sh -c 'printf "[boot]\\nsystemd=true\\n" >> /etc/wsl.conf'
    2. In Windows (PowerShell): wsl --shutdown
    3. Open your distribution again, then: hewn service install
WSL
  fi
}

main "$@"

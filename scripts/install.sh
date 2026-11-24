#!/usr/bin/env bash
# inbox-orchestrator installer for macOS.
# Usage: curl -fsSL https://raw.githubusercontent.com/gunrmic/inbox-orchestrator/main/scripts/install.sh | bash
#
# Clones the repo to ~/.inbox-orchestrator-app, builds it, and links the `ibo` command.
# Re-running it updates to the latest version.
set -euo pipefail

REPO="${IBO_REPO:-https://github.com/gunrmic/inbox-orchestrator.git}"
APP_DIR="${IBO_APP_DIR:-$HOME/.inbox-orchestrator-app}"

say() { printf "\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\033[31m%s\033[0m\n" "$*" >&2; exit 1; }

[[ "$(uname)" == "Darwin" ]] || say "Not macOS: installing anyway for development (Reminders and launchd will not work)."

command -v node >/dev/null || fail "Node.js 22.13+ is required. Install it with: brew install node"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || fail "Node.js 22.13+ is required for its built-in SQLite (found $(node -v)). Run: brew upgrade node"
command -v git >/dev/null || fail "git is required. Install Xcode Command Line Tools: xcode-select --install"

# Remove a broken global install left by an earlier `npm install -g github:...` attempt.
npm uninstall -g inbox-orchestrator >/dev/null 2>&1 || true

if [[ -d "$APP_DIR/.git" ]]; then
  say "Updating $APP_DIR..."
  git -C "$APP_DIR" pull --ff-only --quiet
else
  say "Downloading to $APP_DIR..."
  git clone --depth 1 --quiet "$REPO" "$APP_DIR"
fi

cd "$APP_DIR"
# --ignore-scripts: no package runs code at install time (avoids native binaries such as
# esbuild, which only the test tooling needs). The build itself is plain TypeScript.
say "Installing dependencies..."
npm ci --ignore-scripts --no-fund --no-audit --loglevel=error
say "Building..."
node node_modules/typescript/bin/tsc -p tsconfig.json
chmod +x dist/cli.js
touch .ibo-installed  # marks this checkout as an install that may update itself
npm prune --omit=dev --ignore-scripts --no-fund --no-audit --loglevel=error

say "Linking the ibo command..."
BIN_DIR="$(npm prefix -g)/bin"
mkdir -p "$BIN_DIR"
ln -sf "$APP_DIR/dist/cli.js" "$BIN_DIR/ibo"

command -v ibo >/dev/null || fail "Installed, but 'ibo' is not on your PATH. Add $BIN_DIR to PATH."

if [[ "${IBO_SKIP_OPTIONAL:-}" == "1" ]]; then
  : # tests: skip interactive optional installs
elif ! command -v claude >/dev/null; then
  say "Claude Code is not installed. It runs code tasks in git projects."
  read -r -p "Install Claude Code now? [Y/n] " yn </dev/tty || yn="y"
  [[ "${yn:-y}" =~ ^[Nn] ]] || npm install -g @anthropic-ai/claude-code
fi

say "Installed $(ibo --version)."

# Updating an existing install, or no terminal to talk to: stop here.
if [[ "${IBO_SKIP_OPTIONAL:-}" == "1" || "${IBO_NO_SETUP:-}" == "1" ]] || [[ ! -r /dev/tty ]]; then
  echo "  Run 'ibo setup' to connect Gmail, pick a model and discover your projects."
  exit 0
fi

say "Setting up (Gmail sign-in, local model, project discovery)..."
exec ibo setup </dev/tty

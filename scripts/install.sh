#!/usr/bin/env bash
# inbox-orchestrator installer for macOS.
# Usage: curl -fsSL https://raw.githubusercontent.com/gunrmic/inbox-orchestrator/main/scripts/install.sh | bash
set -euo pipefail

say() { printf "\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\033[31m%s\033[0m\n" "$*" >&2; exit 1; }

[[ "$(uname)" == "Darwin" ]] || fail "This installer is for macOS. On Linux, run: npm install -g github:gunrmic/inbox-orchestrator"

command -v node >/dev/null || fail "Node.js 20+ is required. Install it with: brew install node"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
(( NODE_MAJOR >= 20 )) || fail "Node.js 20+ is required (found $(node -v))."
command -v git >/dev/null || fail "git is required. Install Xcode Command Line Tools: xcode-select --install"

say "Installing inbox-orchestrator..."
npm install -g github:gunrmic/inbox-orchestrator

if ! command -v claude >/dev/null; then
  say "Claude Code is not installed. It runs code tasks in git projects."
  read -r -p "Install Claude Code now? [Y/n] " yn </dev/tty || yn="y"
  [[ "${yn:-y}" =~ ^[Nn] ]] || npm install -g @anthropic-ai/claude-code
fi

if ! command -v ollama >/dev/null; then
  say "Optional: Ollama runs email triage locally for free (email stays on your Mac)."
  echo "  brew install ollama && ollama serve"
fi

say "Done. Next steps:"
cat <<'EOF'
  ibo setup          # Anthropic key, Gmail (read-only), local model
  ibo onboard        # discover your projects and tools, answer a few questions
  ibo install-agent  # run in the background at login
  ibo doctor         # check everything
EOF

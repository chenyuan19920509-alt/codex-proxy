#!/usr/bin/env bash
# One-click installer for codex-proxy
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()  { echo -e "${GREEN}[OK]${NC}   $*"; }
fail(){ echo -e "${RED}[FAIL]${NC} $*"; exit 1; }
warn(){ echo -e "${YELLOW}[WARN]${NC} $*"; }
step(){ echo; echo -e "── $* ──"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

step "Checking Node.js"
if command -v node &>/dev/null; then
  NODE_VER=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
  [ "$NODE_VER" -ge 18 ] 2>/dev/null && ok "Node.js $(node --version)" || fail "Node.js $(node --version) too old; need >= 18"
else
  fail "Node.js not found"
fi

step "Checking codex CLI"
if npm list -g codex --depth=0 &>/dev/null; then
  ok "codex CLI installed globally"
else
  warn "codex CLI not found; installing..."
  npm install -g @openai/codex-cli 2>/dev/null || npm install -g codex 2>/dev/null || fail "Failed to install codex CLI"
  ok "codex CLI installed"
fi

step "Creating config directory"
mkdir -p ~/.config/codex-proxy && ok "~/.config/codex-proxy/ ready"

step "Updating PATH"
PATH_LINE="export PATH=\"$SCRIPTS_DIR:\$PATH\""
if grep -qF "$SCRIPTS_DIR" ~/.bashrc 2>/dev/null; then
  ok "scripts/ already in PATH"
else
  printf '\n# codex-proxy tools\n%s\n' "$PATH_LINE" >> ~/.bashrc
  ok "Added scripts/ to ~/.bashrc"
fi

step "Installing config template"
mkdir -p ~/.codex
if [ -f ~/.codex/config.toml ]; then
  ok "~/.codex/config.toml already exists (skipped)"
else
  [ -f "$PROJECT_DIR/models/template.conf" ] && cp "$PROJECT_DIR/models/template.conf" ~/.codex/config.toml
  ok "config.toml installed to ~/.codex/"
fi

step "Starting proxy"
export PATH="$SCRIPT_DIR:$PATH"
proxy-ctl start && ok "Proxy started"

step "Health check"
sleep 2
HEALTH=$(env -u HTTP_PROXY -u HTTPS_PROXY curl -s http://127.0.0.1:4446/health 2>/dev/null || echo "")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  ok "Proxy healthy: $HEALTH"
else
  warn "Health check inconclusive: ${HEALTH:-no response}"
fi

echo
ok "Installation complete!  Run 'proxy-ctl status' to check the proxy."

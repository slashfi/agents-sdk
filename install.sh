#!/bin/sh
set -e

# ADK — Agent Development Kit
# https://registry.slash.com
#
# Usage: curl -fsSL https://registry.slash.com/adk/install.sh | sh

PACKAGE="@slashfi/agents-sdk"

main() {
  echo "Installing ADK..."
  echo ""

  # Detect package manager
  if command -v bun >/dev/null 2>&1; then
    PM="bun"
    INSTALL="bun add -g"
  elif command -v npm >/dev/null 2>&1; then
    PM="npm"
    INSTALL="npm install -g"
  else
    echo "Error: No package manager found. Install Node.js (https://nodejs.org) or Bun (https://bun.sh) first."
    exit 1
  fi

  echo "Using $PM to install $PACKAGE"
  $INSTALL "$PACKAGE"

  echo ""
  echo "\033[32m✓\033[0m ADK installed successfully!"
  echo ""
  echo "Quick start:"
  echo "  adk init --target claude    # Install skill for Claude Code"
  echo "  adk init --target cursor    # Install skill for Cursor"
  echo "  adk init --target codex     # Install skill for Codex"
  echo ""
  echo "All presets: claude, cursor, codex, copilot, windsurf, hermes"
  echo ""
  echo "Next steps:"
  echo "  adk registry browse public  # Browse available agents"
  echo "  adk ref add <name>          # Install an agent"
  echo "  adk ref call <name> <tool>  # Call a tool"
}

main

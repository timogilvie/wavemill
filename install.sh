#!/usr/bin/env bash
set -euo pipefail

# Wavemill Installation Script
# Makes wavemill command globally accessible

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WAVEMILL="$SCRIPT_DIR/wavemill"

echo "Installing Wavemill CLI..."
echo ""

# Option 1: Try /usr/local/bin (requires sudo)
if [[ -w /usr/local/bin ]]; then
  ln -sf "$WAVEMILL" /usr/local/bin/wavemill
  echo "✓ Installed to: /usr/local/bin/wavemill"
  echo ""
  echo "Run 'wavemill help' to get started!"
  exit 0
fi

# Option 2: Try with sudo
echo "⚠  /usr/local/bin is not writable. Requesting sudo access..."
if sudo -n true 2>/dev/null; then
  # Can sudo without password
  sudo ln -sf "$WAVEMILL" /usr/local/bin/wavemill
  echo "✓ Installed to: /usr/local/bin/wavemill"
  echo ""
  echo "Run 'wavemill help' to get started!"
  exit 0
else
  # Need password for sudo
  echo ""
  read -p "Install to /usr/local/bin? (requires sudo) [Y/n] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]?$ ]]; then
    sudo ln -sf "$WAVEMILL" /usr/local/bin/wavemill
    echo "✓ Installed to: /usr/local/bin/wavemill"
    echo ""
    echo "Run 'wavemill help' to get started!"
    exit 0
  fi
fi

# Option 3: Add to PATH via shell profile
echo ""
echo "Alternative: Add wavemill directory to your PATH"
echo ""
echo "Add this line to your ~/.zshrc or ~/.bashrc:"
echo ""
echo "  export PATH=\"$SCRIPT_DIR:\$PATH\""
echo ""
echo "Then reload your shell:"
echo "  source ~/.zshrc  # or source ~/.bashrc"
echo ""
echo "Or create an alias:"
echo "  alias wavemill='$WAVEMILL'"

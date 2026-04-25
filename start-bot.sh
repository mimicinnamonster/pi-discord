#!/bin/zsh
# Launch wrapper for pi-discord bot

# Save and restore PATH after sourcing shell configs
export ORIGINAL_PATH="/Users/michal/.local/share/mise/shims:/Users/michal/.local/share/mise/installs/node/25.9.0/bin:/Users/michal/.local/share/mise/installs/bun/1.3.11/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Source shell configurations (they may modify PATH)
[[ -f ~/.zshrc ]] && source ~/.zshrc
[[ -f ~/.zprofile ]] && source ~/.zprofile
[[ -f ~/.zshenv ]] && source ~/.zshenv

# Restore essential PATH
export PATH="$ORIGINAL_PATH"

# Change to project directory
cd /Users/michal/Projects/pi-discord

# Use absolute path to bun
BUN_PATH="/Users/michal/.local/share/mise/installs/bun/1.3.11/bin/bun"
exec "$BUN_PATH" run start:debug 2>&1 1>> /Users/michal/Projects/pi-discord/logs.txt

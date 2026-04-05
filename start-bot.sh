#!/bin/zsh
# Launch wrapper for pi-discord bot
# Ensures full shell environment is loaded

# Source all shell configurations for any additional env
[[ -f ~/.zshrc ]] && source ~/.zshrc
[[ -f ~/.zprofile ]] && source ~/.zprofile
[[ -f ~/.zshenv ]] && source ~/.zshenv

# Change to project directory
cd /Users/michal/Projects/pi-discord

exec bun run dev:debug 2>&1 1> /Users/michal/Projects/pi-discord/logs.txt

# Code Guide
- typescript
- prioritize simplicity and readability of the code
- prefer simpler functions
- avoid mutable state

# Tests
- every confirmed working correctly change must be covered by tests, and all other tests must be confirmed are still passing

# Build process
- use bun

# Launchd Service
The bot runs as a LaunchAgent for automatic startup and restart.

## Files
- `com.michal.pi-discord.plist` - LaunchAgent configuration
- `start-bot.sh` - Wrapper script with shell environment

## Features

## Management Commands
```bash

# View logs
tail -f /Users/michal/Projects/pi-discord/logs.txt
```

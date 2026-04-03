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
- Starts at system boot (`RunAtLoad`)
- Auto-restarts if killed (`KeepAlive`)
- Runs in debug mode (`DISCORD_DEBUG=true`)
- Logs to `logs.txt`
- Inherits full user shell environment

## Management Commands
```bash
# Check status
launchctl list | grep pi-discord

# View logs
tail -f /Users/michal/Projects/pi-discord/logs.txt

# Restart service
launchctl unload ~/Library/LaunchAgents/com.michal.pi-discord.plist
launchctl load ~/Library/LaunchAgents/com.michal.pi-discord.plist

# Stop service
launchctl unload ~/Library/LaunchAgents/com.michal.pi-discord.plist
```

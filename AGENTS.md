# Code Guide
- typescript
- prioritize simplicity and readability of the code
- prefer simpler functions
- avoid mutable state

# Tests
- every confirmed working correctly change must be covered by tests, and all other tests must be confirmed are still passing

# Build process
- use bun

# Discord Bot Restart
To restart the pi-discord bot (must be done in one command so the shell doesn't die):

```bash
OLD=$(pgrep -f "bun run index.ts") && cd /Users/michal/Projects/pi-discord && nohup bun start:debug > logs.txt 2>&1 & sleep 2 && kill -9 $OLD 2>/dev/null; true
```

Validation after restart:
```bash
ps aux | grep "bun.*index" | grep -v grep  # Should show exactly 1 process
tail logs.txt  # Should show "Bot is ready"
```

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

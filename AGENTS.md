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

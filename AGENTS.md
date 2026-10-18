# pi-discord

Discord bot for the pi coding agent.

## Getting Started

1. Clone the repository
2. Run `npm install`
3. Create `.env` with your `DISCORD_BOT_TOKEN`
4. Run `npm start`

## Development

- `npm run dev` - Run with auto-reload
- `npm test` - Run tests
- `npm run build` - Type-check

## Deployment via launchd (macOS)

Template files are provided:
- `com.pi-discord.plist.example` - LaunchAgent configuration
- `start-bot.sh.example` - Wrapper script

Copy and customize these files, then:
```bash
cp com.pi-discord.plist.example ~/Library/LaunchAgents/com.pi-discord.plist
cp start-bot.sh.example start-bot.sh  # Edit paths in start-bot.sh
launchctl load ~/Library/LaunchAgents/com.pi-discord.plist
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token |
| `DISCORD_DEBUG` | No | Enable debug logging (`true`) |
| `PI_DISCORD_SESSION_DIR` | No | Custom session directory (default: `~/.pi-discord/sessions`) |

## Architecture

- `src/index.ts` - Main bot entry point with Discord client setup
- `src/session-store.ts` - Session management (pi agent sessions per channel)
- `src/branch-manager.ts` - Discord reply tree ↔ pi session tree mapping
- `src/typing-manager.ts` - Typing indicator management
- `src/token-stats.ts` - Token utilization statistics
- `src/model-utils.ts` - Model search/filter utilities

## License

MIT

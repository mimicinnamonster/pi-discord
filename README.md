# pi-discord

Discord integration for the [pi coding agent](https://github.com/badlogic/pi-mono).

## Overview

This extension integrates Discord with pi, allowing you to:
- Chat with AI in Discord DMs
- Create conversation threads in servers
- Approve/reject tool calls via emoji reactions
- Make choices via numbered message replies

## Setup

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" section
4. Enable these **Privileged Gateway Intents**:
   - `Message Content Intent`
   - `Server Members Intent` (optional, for member tracking)
5. Copy the bot token

### 2. Configure Environment

```bash
# Set your bot token
export DISCORD_BOT_TOKEN=your_bot_token_here

# Optional: Enable debug logging
export DISCORD_DEBUG=true

# Optional: Custom session directory
export SESSION_DIR=~/.assistant-discord
```

### 3. Invite the Bot

Use this OAuth2 URL to invite the bot to your server:
```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=1024&scope=bot
```

Replace `YOUR_CLIENT_ID` with your application's client ID from the Developer Portal.

## Usage

### As a pi Extension

The extension is auto-discovered when placed in `.pi/extensions/` or `~/.pi/agent/extensions/`:

```bash
# Navigate to this project
cd /path/to/pi-discord

# Run pi with the extension
pi

# Or specify explicitly
pi -e ./.pi/extensions/discord/index.ts
```

### As Standalone Bot

You can also run the bot standalone for testing:

```bash
# Using ts-node
npx ts-node standalone.ts

# Or compile and run
npx tsc standalone.ts
node standalone.js
```

## Commands

In Discord, use these slash-style commands:

| Command | Description |
|---------|-------------|
| `/new` | Start a new conversation |
| `/save` | Save the current session |
| `/status` | Show bot and session status |
| `/help` | Show available commands |

## Tools

The extension registers these tools for use by the LLM:

| Tool | Description |
|------|-------------|
| `discord_send` | Send a message to a Discord channel |
| `discord_reply` | Reply to a specific message |
| `discord_create_thread` | Create a new thread in a channel |
| `discord_status` | Get the bot's current status |

## Extension Architecture

```
.pi/extensions/discord/
└── index.ts          # Main extension entry point
```

The extension:
1. Registers Discord-related tools via `pi.registerTool()`
2. Registers commands via `pi.registerCommand()`
3. Handles lifecycle events via `pi.on()`
4. Uses `ctx.ui` for user confirmations and selections

## Events

The extension subscribes to these pi events:

- `session_start` - Initialize Discord connection
- `session_shutdown` - Clean up Discord connection
- `tool_call` - Optional approval gate for dangerous operations
- `agent_start/end` - Track agent lifecycle
- `model_select` - Track model changes

## Security

- Bot messages are ignored to prevent loops
- Dangerous tool calls can require explicit approval
- Sessions are isolated per user/DM or per thread

## Troubleshooting

### Bot not responding?

1. Verify `DISCORD_BOT_TOKEN` is set correctly
2. Check "Message Content Intent" is enabled in Developer Portal
3. Ensure the bot is in your server
4. Enable debug mode: `export DISCORD_DEBUG=true`

### Commands not working?

Make sure you're typing the full command with `/` prefix, e.g., `/help`

### Thread not creating?

The bot needs "Create Public Threads" and "Send Messages" permissions in the channel.

## License

MIT

# pi-discord 🎮💬

**Discord bot integration for [pi coding agent](https://github.com/mimicinnamonster/pi-coding-agent).**

Turn any Discord channel (DM, thread, or server text channel) into a full pi coding agent session. Send messages, ask questions, run code, review files — the agent responds directly in Discord, with thinking indicators, tool execution tracking, and multi-message output.

## Features

### 🧠 Full Agent Session per Channel
Each Discord channel gets its own isolated pi agent session with persistent history (survives bot restarts).

### 🔧 Live Tool Execution
See what the agent is doing in real-time — running tools, thinking, handling errors — all streamed to Discord.

### 🖼️ Image Support
Send images as Discord attachments — the agent can see and analyze them.

### 🌿 Branching & History
- **Reply branching** — reply to any previous bot message to fork the conversation
- **`/label` / `/labels`** — bookmark any point in the conversation
- **`/merge`** — merge changes from a branch into the current thread
- **`/summary`** — preview what would be merged

### ⌨️ Slash Commands
| Command | Description |
|---|---|
| `/model [name]` | Switch AI model (e.g. `/model anthropic/claude-sonnet-4`) |
| `/models [query]` | List/search available models |
| `/thinking [level]` | Set thinking/effort level |
| `/session` | Show session stats (messages, tokens, cost) |
| `/stats` | Show token utilization & delta |
| `/settings` | Show current agent settings |
| `/cwd [path]` | View/change working directory |
| `/queue [prompt]` | Queue a prompt for after current task |
| `/clear` | Reset session (start fresh) |
| `/reload` | Reload extensions, skills, and themes |
| `/label [name]` | Label current position |
| `/labels` | List all labels |
| `/merge [name]` | Merge from a label or reply |
| `/summary [name]` | Summarize branch changes |
| `/help` | Show all commands |
| `/exit` | Shut down the bot |
| `/stop` | Stop current agent operation |

### 💻 Bash Integration
- `!command` — run a bash command (added to agent context)
- `!!command` — run a bash command (hidden from agent context)

## Quick Start

### Prerequisites
- [Bun](https://bun.sh) >= 1.0
- A [Discord bot token](https://discord.com/developers/applications)
- pi coding agent configuration (API keys set up via `pi` CLI)

### Setup

```bash
# Clone and install
git clone https://github.com/mimicinnamonster/pi-discord.git
cd pi-discord
bun install

# Configure your bot token
export DISCORD_BOT_TOKEN="your-token-here"

# Run
bun start
```

### Discord Bot Setup
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application and bot
3. Enable these **Privileged Gateway Intents**:
   - `MESSAGE CONTENT INTENT`
   - `SERVER MEMBERS INTENT` (optional, for guild features)
4. Invite the bot with `bot` scope and these permissions:
   - Send Messages
   - Read Message History
   - Attach Files
   - Use External Emojis (optional)

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | ✅ Yes | — | Discord bot token |
| `DISCORD_DEBUG` | No | `false` | Enable debug logging |
| `PI_DISCORD_SESSION_DIR` | No | `~/.pi-discord/sessions` | Custom session storage path |

## Deployment (macOS launchd)

Template files are included for running as a LaunchAgent:

```bash
cp com.pi-discord.plist.example ~/Library/LaunchAgents/com.pi-discord.plist
cp start-bot.sh.example start-bot.sh
# Edit start-bot.sh with your paths and token
launchctl load ~/Library/LaunchAgents/com.pi-discord.plist
```

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Discord    │────▶│  pi-discord  │────▶│  pi Agent    │
│  Client     │     │  (index.ts)  │     │  Session     │
└─────────────┘     └──────────────┘     └──────────────┘
                          │
                    ┌─────┴──────┐
                    │  Session   │
                    │  Store     │
                    │ (per chat) │
                    └────────────┘
```

- **`src/index.ts`** — Discord client setup, message routing, command handlers
- **`src/session-store.ts`** — pi session lifecycle (create, persist, restore)
- **`src/branch-manager.ts`** — Discord reply tree ↔ pi session tree mapping
- **`src/typing-manager.ts`** — Typing indicator management (respects rate limits)
- **`src/token-stats.ts`** — Token utilization tracking and alerts
- **`src/model-utils.ts`** — Model search and filtering

## Development

```bash
bun dev           # Run with auto-reload
bun dev:debug     # Run with debug logging + auto-reload
bun test          # Run tests
bun test:run      # Run tests once
bun build         # Type-check only
```

## License

MIT

# pi-discord 🎮💬

**Discord bot integration for [pi coding agent](https://github.com/mimicinnamonster/pi-coding-agent).**

Turn any Discord channel (DM, thread, or server text channel) into a full pi coding agent session. Send messages, ask questions, run code, review files — the agent responds directly in Discord, with thinking indicators, tool execution tracking, and multi-message output.

## Features

### 🧠 Full Agent Session per Channel
Each Discord channel gets its own isolated pi agent session with persistent history (survives bot restarts).

### 🔧 Live Tool Execution
See what the agent is doing in real-time — running tools, thinking, handling errors — all streamed to Discord.

### 🖼️ Image Support
Send images as Discord attachments — the agent can see and analyze them. Local files can
be inspected with the built-in `look_at_file` tool.

Images are **automatically downscaled/compressed** before being sent to the model
(max 1568px long edge, ~1MB, JPEG quality 80) so large photos don't bloat the request
payload — heavy multimodal requests made some providers (e.g. opencode-go) drop the
stream mid-generation. Files with an image extension but no real image content (e.g. an
HTML 404 page saved as `.jpg`) are rejected with a clear error instead of a provider 400.
If resizing is unavailable it falls back to the original image.

### 🧠 Channel Memory (`remember` tool)
The agent has a `remember` tool for persistent per-channel memory: whatever the
agent is told to remember is stored keyed by **Discord channel**, not pi session
UUID, so it survives bot restarts, `/session`, `/clear`, `/compact`, `/resume`,
`/fork` and reply-based forks within the same channel. The memory is injected
into the system prompt at the start of every turn via the official
`before_agent_start` extension hook. Legacy `memory-<sessionId>.json` sidecars
from earlier versions are migrated automatically on startup.

### 🎛️ Model-controlled Thinking (`thinkingmode` tool)
The model can raise or lower its own thinking/reasoning effort with the
`thinkingmode` tool (default: `off` — it only escalates for genuinely complex
tasks). The chosen level and the enable flag are persisted per Discord channel;
`/thinkingmode on|off` controls whether the model may change its own level, and
`/hide thinkingmode` suppresses its notifications.

### ⏰ Scheduled Prompts
Cron jobs (configured via the `pi-schedule-prompt` extension) fire into the channel's
session and stream the response to Discord. The bot keeps sessions alive for channels
with enabled jobs and **catches up runs missed while the bot was offline** (crash,
`/kill`, laptop battery): shortly after startup and every minute it checks for jobs
whose `nextRun` passed, advances the schedule *before* delivering (so a crash can't
duplicate a run), and retries on delivery failure. Unhandled exceptions/rejections are
logged and swallowed instead of killing the bot — scheduled jobs survive process hiccups.

### ⌨️ Persistent Typing Indicator
The "typing…" indicator stays visible for the entire turn instead of fading after ~10s:
it re-triggers every 7s (safely under Discord's 5s rate limit, before the 10s expiry)
and stops on `agent_end`, on failure, or via a 30-minute dead-man timer that guards
against a turn dying without a clean end event. It shows immediately for real prompts,
and stays up through tool calls, bash commands, retries, and long generations.

### 🌿 Branching & History
- **Reply branching** — reply to any previous bot message to fork the conversation
- **`/fork [label]`** — snapshot the current session (resumable via `/resume`) and continue in a full-context copy
- **`/label` / `/labels`** — bookmark any point in the conversation
- **`/merge`** — merge changes from a branch into the current thread
- **`/summary`** — preview what would be merged

### ⌨️ Slash Commands
| Command | Description |
|---|---|
| `/model [name]` | Switch AI model (e.g. `/model anthropic/claude-sonnet-4`) |
| `/models [query]` | List/search available models |
| `/thinking [level]` | Set thinking/effort level |
| `/thinkingmode on\|off` | Allow/prevent the model from changing its own thinking level via the `thinkingmode` tool |
| `/session` | Show session stats (messages, tokens, cost) |
| `/stats` | Show token utilization & delta |
| `/settings` | Show current agent settings |
| `/hide thinking\|tools\|thinkingmode` | Hide thinking/tool/thinking-mode-notification blocks in this channel |
| `/show thinking\|tools\|thinkingmode` | Show thinking/tool/thinking-mode-notification blocks in this channel |
| `/cwd [path]` | View/change working directory |
| `/queue [prompt]` | Queue a prompt for after current task |
| `/clear` | Reset session (start fresh) |
| `/reload` | Reload extensions, skills, and themes |
| `/fork [label]` | Snapshot current session and continue in a full-context copy (pre-fork state resumable via `/resume`) |
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
- [Node.js](https://nodejs.org) >= 22.19 (for `vitest`/test tooling; the bot itself runs on Bun).
  With [mise](https://mise.jdx.dev), the pinned version is picked up automatically from `.mise.toml` — run `mise trust` once if prompted.
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

### ⚠️ Calendar access (ical) when running under launchd

When the bot runs as a launchd LaunchAgent, macOS attributes any EventKit/Calendar
request (e.g. the `ical` CLI used by agent sessions) to **bun** — the process that
launchd spawns. bun is a hardened-runtime binary, and macOS **auto-denies**
Calendar access for hardened-runtime binaries unless they carry the
`com.apple.security.personal-information.calendars` entitlement.

The fix is to re-sign bun with that entitlement (plus Reminders):

```bash
./scripts/re-sign-bun.sh
```

This re-signs the bun binary ad-hoc with the Calendar/Reminders entitlements,
enabling the one-time macOS permission prompt (click **Allow** on the
"bun wants to access your calendar" dialog).

> **Caveat:** any bun update or reinstall (e.g. `mise upgrade bun`) overwrites
> the signature and silently breaks calendar access again. Re-run
> `./scripts/re-sign-bun.sh` after every bun update.

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

- **`src/index.ts`** — Discord client setup, message routing, command handlers, scheduled-prompt keeper
- **`src/session-store.ts`** — pi session lifecycle (create, persist, restore), image validation
- **`src/branch-manager.ts`** — Discord reply tree ↔ pi session tree mapping
- **`src/typing-manager.ts`** — Typing indicator management (renewal + dead-man switch, respects rate limits)
- **`src/image-utils.ts`** — Image downscaling/compression for LLM payloads
- **`src/session-memory.ts`** — Channel-scoped `remember` memory persistence + system-prompt injection
- **`src/thinking-mode.ts`** — Channel-scoped `thinkingmode` tool (model-controlled thinking level)
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

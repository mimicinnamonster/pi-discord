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
- [Node.js](https://nodejs.org) >= 22.19
  With [mise](https://mise.jdx.dev), the pinned version is picked up automatically from `.mise.toml` — run `mise trust` once if prompted.
- A [Discord bot token](https://discord.com/developers/applications)
- pi coding agent configuration (API keys set up via `pi` CLI)

### Setup

```bash
# Clone and install
git clone https://github.com/mimicinnamonster/pi-discord.git
cd pi-discord
npm install

# Configure your bot token
export DISCORD_BOT_TOKEN="your-token-here"

# Run
npm start
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
request (e.g. the `ical` CLI used by agent sessions) to the **Node.js** binary —
the process that launchd spawns. Node is a hardened-runtime binary, and macOS
**auto-denies** Calendar access for hardened-runtime binaries unless they carry the
`com.apple.security.personal-information.calendars` entitlement.

The fix is to re-sign Node with that entitlement (plus Reminders):

```bash
./scripts/re-sign-node.sh
```

This re-signs the Node binary ad-hoc with the Calendar/Reminders entitlements,
enabling the one-time macOS permission prompt (click **Allow** on the
"node wants to access your calendar" dialog).

> **Caveat:** any Node update or reinstall (e.g. `mise upgrade node`) overwrites
> the signature and silently breaks calendar access again. Re-run
> `./scripts/re-sign-node.sh` after every Node update.

## Deployment (Linux systemd)

Run the bot as a systemd service so it comes back after a crash or reboot. Two
shapes work — pick whichever matches how the host is administered:

- **System unit** — install to `/etc/systemd/system/pi-discord.service` with
  `User=<user>`, then `sudo systemctl restart pi-discord`.
- **User unit** — install to `~/.config/systemd/user/pi-discord.service`, then
  `systemctl --user restart pi-discord`. Needs `loginctl enable-linger <user>`,
  otherwise it only runs while that user is logged in.

Minimal unit body:

```ini
[Unit]
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<user>
WorkingDirectory=/home/<user>/Projects/pi-discord
ExecStart=<node-bin> --env-file-if-exists=.env src/index.ts
Environment=PATH=<mise-shims>:<pi-bin>:/usr/local/bin:/usr/bin:/bin
Environment=PI_DISCORD_BOT=1
Environment=PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=<pi-coding-agent-root>
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> **User unit:** drop `User=<user>` (the user manager ignores it) and set
> `WantedBy=default.target`. A `multi-user.target` unit enabled with
> `systemctl --user` is linked into a target the user manager never reaches, so it
> silently never starts at boot.

### Unit gotchas

- **`ExecStart` must use an absolute node path, not `node`.** systemd's PATH does
  not include the mise shims dir, and the shim resolves its version from the
  checkout's `.mise.toml` — so this path has to track that pin.
- **`--env-file-if-exists=.env` is required.** `src/index.ts` reads
  `process.env.DISCORD_BOT_TOKEN` directly with no dotenv; without the flag the
  process exits 1 with "DISCORD_BOT_TOKEN environment variable is required".
- **`PATH` must still contain the mise shims and the `pi` bin dir**, even though
  `ExecStart` is absolute: the bot spawns child agent processes that shell out to
  `node`, `npm`, and `git`.
- **`PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT` must be set** to the absolute path
  of the local `@earendil-works/pi-coding-agent` install. pi-subagents cannot
  infer it from `argv[1]` in an embedded-SDK process, and otherwise fails every
  delegation with `ERR_MODULE_NOT_FOUND`.
- **Set `PI_DISCORD_BOT=1`** so a global `parent-tools-lockdown` extension, if one
  is installed, skips this process — the bot locks its own parent tool set in code.
- Runtime state (`sessions/`, plus per-feature state such as `email-state.json`)
  lives in `~/.pi-discord/`, outside the checkout, so redeploys never touch it.

### Deploying updates

The server checkout is **pull-only**:

```bash
cd ~/Projects/pi-discord
git pull --ff-only
sudo systemctl restart pi-discord   # or: systemctl --user restart pi-discord
```

`origin` is the public HTTPS URL, so the host needs no SSH key and stores no
credentials. Anonymous HTTPS is read-only by design — push from a development
machine, not from the server.

### Diagnosing a hang

A wedged run shows up as the bot going quiet while every new message is answered
with 🛑 *Interrupted by user*. The self-heal sweep recovers these on its own and
every recovery logs a `[watchdog]` line, including a snapshot of the outstanding
subagent runs (`runId`, `state`, `pid`, `pidAlive`, `ageMs`) — that line names
the child that pinned the settle path.

When the journal is not enough, capture the live state. The process is idle by
definition (it is parked on a promise), so CPU profiling proves nothing and
`gdb -p <pid> -batch -ex bt` only shows `epoll_wait`.

```ini
# in the unit — quote it: systemd splits an unquoted Environment= on spaces
Environment="NODE_OPTIONS=--report-on-signal --report-signal=SIGUSR2 --report-directory=/var/lib/pi-discord/reports"
ExecStartPre=/bin/mkdir -p /var/lib/pi-discord/reports
```

```bash
kill -USR2 <bot pid>        # writes report.<date>.<pid>.0.001.json
jq '.libuv[] | select(.is_active) | {type, localEndpoint, remoteEndpoint, firesInMsFromNow}' \
  /var/lib/pi-discord/reports/report.*.json
```

The `libuv` section is what matters: an active TCP write/listen handle on a
provider socket with no matching progress is the fingerprint of a stalled
stream. `javascriptStack` is present but usually empty for a signal-triggered
report — Node only fills it when the report comes from a JS error — so for the
actual parked frame use the inspector: start the unit with
`--inspect=127.0.0.1:9229` (or send `SIGUSR1`), attach, run `Debugger.pause`, then
read the stack plus `process._getActiveHandles()` and
`process._getActiveRequests()`.

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
npm run dev           # Run with auto-reload
npm run dev:debug     # Run with debug logging + auto-reload
npm test              # Run tests
npm run test:run      # Run tests once
npm run build         # Type-check only
```

## License

MIT

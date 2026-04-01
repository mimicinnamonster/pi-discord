# pi-discord Project Plan

## Project Overview

- **Name**: pi-discord
- **Type**: Standalone Discord bot using pi as a library
- **Core Functionality**: Discord bot that creates independent pi sessions for each DM/thread, allowing AI chat via Discord
- **Target Users**: Developers using pi coding agent who want Discord-based interaction

---

## Current State

- ✅ Project skeleton created
- ✅ Dependencies configured (discord.js, pi-coding-agent)
- ✅ Standalone implementation complete
- ✅ Proper SDK usage with:
  - `AuthStorage` for API key management
  - `ModelRegistry` for model selection
  - `SessionManager` for session persistence
  - `SettingsManager` for settings
  - `createCodingTools` with proper cwd
- ✅ Session persistence to disk
- ✅ Session restoration on restart (sessions survive bot restarts)
- ✅ Test coverage for session persistence
- ✅ Response streaming to Discord channels
- ✅ Tool execution notifications
- ✅ Graceful shutdown

## Pending Tasks

- [ ] Tool call approval via emoji reactions
- [ ] Tool call approval via emoji reactions
- [ ] Slash commands for all pi commands
- [ ] Better streaming implementation (real-time token output)
- [ ] README documentation

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    pi-discord (You)                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Discord ────▶ MessageHandler ────▶ AgentSession      │
│     ▲                                    │              │
│     │                                    ▼              │
│     │                            ┌─────────────┐       │
│     │                            │  pi SDK     │       │
│     │                            │  - Auth     │       │
│     │                            │  - Models   │       │
│     │                            │  - Tools    │       │
│     │                            │  - Sessions │       │
│     │                            └─────────────┘       │
│     │                                    │              │
│     └────────────────────────────────────┘              │
│                      Responses                           │
└─────────────────────────────────────────────────────────┘
```

## SDK Integration

We use pi as a **library** via the SDK:

```typescript
import {
  AuthStorage,        // API key management
  createAgentSession, // Create sessions
  ModelRegistry,      // Model selection
  SessionManager,     // Session persistence
  SettingsManager,    // Settings
  codingTools,        // Built-in tools
  createCodingTools,  // Tool factory with custom cwd
} from "@mariozechner/pi-coding-agent";
```

### Available from SDK:

| Feature | Available | Notes |
|---------|-----------|-------|
| `AgentSession` | ✅ | Core session with all agent capabilities |
| `codingTools` | ✅ | read, bash, edit, write tools |
| Event subscription | ✅ | message_start/update/end, tool execution |
| `sendUserMessage()` | ✅ | Send messages to agent |
| Model selection | ✅ | Via session.setModel() |
| Thinking levels | ✅ | Via session.setThinkingLevel() |
| Session persistence | ✅ | Via SessionManager |
| `steer()` / `followUp()` | ✅ | Queue messages during streaming |
| Custom tools | ✅ | Via customTools option |
| Extensions | ✅ | Via DefaultResourceLoader |

### Session Lifecycle:

1. **Create**: `createAgentSession()` with `SessionManager.create()`
2. **Subscribe**: `session.subscribe()` for events
3. **Prompt**: `session.sendUserMessage()` or `session.prompt()`
4. **Stream**: Events stream back to Discord
5. **Persist**: Sessions saved to disk automatically

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token |
| `DISCORD_DEBUG` | No | Enable debug logging |
| `PI_DISCORD_SESSION_DIR` | No | Session storage directory (default: ~/.pi-discord/sessions) |

## Session Persistence

Sessions are stored in:
- `~/.pi-discord/sessions/index.json` - Session index
- `~/.pi-discord/sessions/discord-{channelId}.jsonl` - Individual session files

## File Structure

```
pi-discord/
├── index.ts              # Main bot entry point
├── session-store.ts      # Session management module
├── session-store.test.ts # Unit tests for session persistence
├── vitest.config.ts     # Test configuration
├── package.json
├── tsconfig.json
└── PLAN.md              # This file
```

## Test Coverage

The session persistence behavior is tested with 16 test cases:
- Index persistence (save/load)
- Session path generation (deterministic, not timestamp-based)
- Session existence checks
- Multi-channel support
- Index persistence across store instances
- Corrupted file handling

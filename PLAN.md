# Discord /Commands Implementation Plan

## Overview
Enable slash commands from Discord to work with pi agent, without needing to add each command on both sides.

## Current State
- Commands in pi are handled in two ways:
  1. **Built-in commands** (`/settings`, `/model`, `/session`, etc.) - hardcoded in `InteractiveMode.setupEditorSubmitHandler()`
  2. **Extension commands** - registered via `pi.registerCommand()`, executed via `session.prompt()`

- Built-in commands are intercepted BEFORE `session.prompt()` is called
- Extension commands are handled inside `session.prompt()` via `_tryExecuteExtensionCommand()`

---

## ✅ COMPLETED FEATURES

| Feature | Implementation | Notes |
|---------|---------------|-------|
| Bash `!command` | `index.ts` | Run bash command, include in context |
| Bash `!!command` | `index.ts` | Run bash command, exclude from context |
| `/session` | `index.ts` | Shows stats, tokens, cost, message counts |
| Session persistence | `session-store.ts` | Sessions persist across restarts |
| Typing indicators | `typing-manager.ts` | Shows "typing..." in Discord |
| Message deletion sync | `index.ts` | Discord delete → session delete |
| Bulk deletion | `index.ts` | Handles `messageDeleteBulk` event |
| Long message handling | `index.ts` | Auto-uploads as file when >2000 chars |
| Code block splitting | `index.ts` | Preserves code blocks when splitting |
| Message interruption | `index.ts` | New message aborts current operation |
| Automatic reconnection | `index.ts` | Reconnects on disconnect |

---

## Key Findings

### Built-in Commands List
| Command | Category | Description | Discord |
|---------|----------|-------------|---------|
| `/settings` | Settings | Open settings menu | Complex |
| `/model [search]` | Model | Select model | Complex |
| `/export [path]` | IO | Export session as HTML or JSONL | ✅ Easy |
| `/import <path>` | IO | Import session from JSONL | ⚠️ Medium |
| `/share` | IO | Share session as GitHub gist | ⚠️ Medium |
| `/copy` | IO | Copy last agent message | ✅ Easy |
| `/session` | Session | Show session info | ✅ Easy |
| `/fork` | Session | Create fork from message | ⚠️ Complex |
| `/tree` | Session | Navigate session tree | ⚠️ Complex |
| `/new` | Session | Start new session | ✅ Done |
| `/compact [instructions]` | Maintenance | Manually compact context | ✅ Easy |
| `/reload` | Maintenance | Reload extensions/skills/themes | ✅ Easy |
| `/debug` | Maintenance | Write debug log | ✅ Easy |
| `/quit` | Meta | Quit pi | ❌ Skip |
| `/login` | Auth | OAuth login | ❌ Skip |
| `/logout` | Auth | OAuth logout | ❌ Skip |
| `/resume` | Session | Resume different session | ❌ Skip |
| `/scoped-models` | Model | Enable/disable models | ❌ Skip |
| `/changelog` | Info | Show what's new | ❌ Skip |
| `/hotkeys` | Info | Show keyboard shortcuts | ❌ Skip |
| `/name [name]` | Settings | Set session display name | ❌ Skip |
| `/arminsayshi` | Easter Egg | Easter egg | ❌ Skip |
| `!command` | Bash | Run bash command | ✅ Implemented |
| `!!command` | Bash | Run bash (excluded from context) | ✅ Implemented |

### Session Display Name
- `/name` sets session display name
- **NOT sent to the model**
- Only used for terminal title, session selector display, persistence

## Implementation Approaches

### Approach 1: Pass-through to session.prompt()
- Send `/command` via `session.prompt("/command")`
- Issue: Built-in commands are intercepted BEFORE `prompt()`, so won't work

### Approach 2: Direct Session API Calls
- Call session methods directly
- Format output for Discord
- Handle events for long-running operations

### Session API Available
```typescript
session.getSessionStats()      // For /session ✅ Done
session.compact()             // For /compact - emits events
session.reload()              // For /reload
session.exportToHtml()        // For /export
session.setSessionName()      // For /name
session.newSession()          // For /new
```

## ctx.ui API (for extension commands)
| Method | Description | Discord Equivalent |
|--------|-------------|-------------------|
| `notify()` | Show notification | ✅ `sendToDiscord()` |
| `confirm()` | Confirmation dialog | ✅ Buttons |
| `select()` | List selection | ✅ Select menu |
| `input()` | Text input | ✅ Modal |
| `onTerminalInput()` | Terminal input | ❌ Not possible |
| `setWidget()` | Display widget | ❌ Not possible |
| `setWorkingMessage()` | Working status | ⚠️ Typing indicator |
| `custom()` | Custom component | ❌ Not possible |
| `setFooter()` | Custom footer | ❌ Not possible |

## Discord Limitations

| Limitation | Impact |
|------------|--------|
| 25 options max per select menu | Models may exceed this |
| 5 text inputs max per modal | Settings with many inputs |
| Single-line text inputs in modals | Multi-line content impossible |
| 3 seconds to respond to interaction | Long operations need deferred responses |
| Buttons can't be dynamically added | Pagination tricky |

---

## REMAINING WORK

### Easy (Simple output) - Priority 1
| Command | Discord Approach | Notes |
|---------|----------------|--------|
| `/copy` | Plain text status | Copy last assistant message |
| `/export [x]` | Plain text with path | Export to HTML/JSONL |
| `/debug` | Plain text status | Write debug log |
| `/reload` | Plain text status | Reload extensions |
| `/new` | Plain text confirmation | Start new session ✅ |
| `/compact [instructions]` | Events + typing | Manual compaction |

### Medium (Events + simple UI)
| Command | Discord Approach |
|---------|----------------|
| `/import [path]` | Button confirm |
| `/share` | Button confirm |

### Complex (Full UI needed) - Priority 2
| Command | Discord Approach | Challenge |
|---------|----------------|-----------|
| `/model [search]` | Select menu | May exceed 25 options |
| `/settings` | Buttons + selects | Many settings, pagination |
| `/fork` | Select menu | May need pagination |
| `/tree` | Select menu | May need pagination |

### Not Applicable (Skip)
| Command | Reason |
|---------|--------|
| `/quit` | Shutdown - not applicable |
| `/login` | OAuth flow - too complex |
| `/logout` | OAuth flow - too complex |
| `/scoped-models` | Ctrl+P cycling concept doesn't translate |
| `/resume` | Session selector - complex UI |
| `/hotkeys` | No keyboard shortcuts in Discord |
| `/changelog` | No terminal/UI to display |
| `/name` | Session display name not visible |
| Easter egg | Doesn't make sense in Discord |

---

## Events Available (already handled)
- `compaction_start` / `compaction_end` - for `/compact`
- `agent_start` / `agent_end` - for general state
- `message_start` / `message_end` - for streaming

---

## Recommended Implementation Order

1. **Phase 1: ✅ Done** Bash commands
   - `!command` - Run bash command ✅
   - `!!command` - Run bash (excluded from context) ✅

2. **Phase 2: ✅ Done** Easy commands (Simple text output)
   - `/session` ✅
   - `/new` ✅
   - Other easy commands still pending: `/copy`, `/export`, `/reload`, `/compact`, `/debug`

3. **Phase 3: Pending** Event-based 
   - `/compact` - needs integration

4. **Phase 4: Pending** Simple UI
   - `/import` - button confirm
   - `/share` - button confirm

5. **Phase 5: Optional** Complex UI
   - `/model` - only if feasible
   - `/settings` - only if feasible
   - `/fork` - only if feasible
   - `/tree` - only if feasible

---

## Questions/Open Items
- [ ] How to handle commands that need OAuth flow?
- [ ] How to handle Ctrl+P model cycling concept in Discord?
- [ ] What timeout for interactive commands?
- [ ] How to handle pagination for long lists?
- [ ] Error handling for commands that fail?

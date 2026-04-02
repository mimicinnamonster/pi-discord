# Discord /Commands Implementation Plan

## Overview
Enable slash commands from Discord to work with pi agent, without needing to add each command on both sides.

## Current State
- Commands in pi are handled in two ways:
  1. **Built-in commands** (`/settings`, `/model`, `/session`, etc.) - hardcoded in `InteractiveMode.setupEditorSubmitHandler()`
  2. **Extension commands** - registered via `pi.registerCommand()`, executed via `session.prompt()`

- Built-in commands are intercepted BEFORE `session.prompt()` is called
- Extension commands are handled inside `session.prompt()` via `_tryExecuteExtensionCommand()`

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
| `/new` | Session | Start new session | ✅ Easy |
| `/compact [instructions]` | Maintenance | Manually compact context | ✅ Events |
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
| `!command` | Bash | Run bash command | ⚠️ Needs implementation |
| `!!command` | Bash | Run bash (excluded from context) | ⚠️ Needs implementation |

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
session.getSessionStats()      // For /session
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

## Command Feasibility

### Easy (Simple output)
| Command | Discord Approach | Notes |
|---------|----------------|--------|
| `/session` | Plain text with stats | ✅ Makes sense |
| `/copy` | Plain text status | ✅ Makes sense |
| `/export [x]` | Plain text with path | ✅ Makes sense |
| `/debug` | Plain text status | ✅ Makes sense |

### Not Applicable (Skip)
| Command | Reason |
|---------|--------|
| `/name` | Session display name not visible in Discord |
| `/changelog` | No terminal/UI to display changelog |
| `/hotkeys` | No keyboard shortcuts in Discord |
| Easter egg | Doesn't make sense in Discord |

### Medium (Events + simple UI)
| Command | Discord Approach |
|---------|----------------|
| `/compact [instructions]` | Events + typing indicator |
| `/reload` | Plain text status |
| `/new` | Plain text confirmation |

### Complex (Full UI needed)
| Command | Discord Approach | Challenge |
|---------|----------------|-----------|
| `/model [search]` | Select menu | May exceed 25 options |
| `/settings` | Buttons + selects | Many settings, pagination |
| `/fork` | Select menu | May need pagination |
| `/tree` | Select menu | May need pagination |
| `/import [path]` | Button confirm | Simple |
| `/share` | Button confirm | Simple |

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

## Events Available (already handled)
- `compaction_start` / `compaction_end` - for `/compact`
- `agent_start` / `agent_end` - for general state
- `message_start` / `message_end` - for streaming

## Recommended Implementation Order

1. **Phase 1: Bash commands**
   - `!command` - Run bash command
   - `!!command` - Run bash (excluded from context)

2. **Phase 2: Easy commands** (Simple text output)
   - `/session`, `/copy`, `/export`, `/reload`, `/new`

3. **Phase 3: Event-based** 
   - `/compact` - already works via events

4. **Phase 4: Simple UI**
   - `/import` - button confirm
   - `/share` - button confirm

5. **Phase 5: Complex UI (optional)**
   - `/model` - only if feasible
   - `/settings` - only if feasible
   - `/fork` - only if feasible
   - `/tree` - only if feasible

## Questions/Open Items
- [ ] How to handle commands that need OAuth flow?
- [ ] How to handle Ctrl+P model cycling concept in Discord?
- [ ] What timeout for interactive commands?
- [ ] How to handle pagination for long lists?
- [ ] Error handling for commands that fail?

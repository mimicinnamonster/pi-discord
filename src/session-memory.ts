/**
 * Session Memory - persistent per-channel memory for the `remember` tool.
 *
 * Memory is stored in a sidecar JSON file keyed by DISCORD CHANNEL ID
 * (`channel-memory-<channelId>.json` next to the session files). Keying by
 * channel instead of session UUID gives the desired lifecycle for a Discord
 * bot: whatever you tell the agent to remember in a channel stays with that
 * channel, no matter what happens to its underlying pi sessions:
 *
 *   - Bot restart        -> channel memory loaded -> memory restored
 *   - /session           -> NEW session UUID, same channel -> memory restored
 *   - /clear             -> NEW session UUID, same channel -> memory restored
 *   - /compact           -> NEW session UUID, same channel -> memory restored
 *   - /resume            -> old session restored, same channel -> memory restored
 *   - /fork & reply-to-old-message forks -> same channel -> memory intact
 *
 * Previously memory was keyed by the pi session UUID
 * (`memory-<sessionId>.json`). That leaked: /session, /clear and any unflushed
 * session recreation minted a fresh random UUID, so the new session started
 * with no memory even though the user had told the bot to remember things in
 * that channel (observed 2026-08-18: dozens of closed sessions per channel,
 * only a handful of orphaned memory sidecars, active sessions empty). On
 * startup the bot migrates any legacy `memory-<uuid>.json` files into
 * `channel-memory-<channelId>.json` (see SessionStore.migrateLegacyMemoryFiles
 * and the legacy fallback in the extension hook below).
 *
 * System prompt injection uses the SDK's OFFICIAL extension hook
 * `before_agent_start` (createSessionMemoryExtension below): the SDK calls it
 * at the start of every agent turn with the assembled base system prompt, and
 * honors a returned `systemPrompt` for that turn (agent-session.js). This is
 * the designed extension point — no private SDK fields are touched, the
 * memory is re-read from disk every turn, and it automatically survives
 * /reload, tool-set changes and anything else that rebuilds the base prompt.
 *
 * The remember tool additionally patches the LIVE `state.systemPrompt` so the
 * currently running turn sees the new memory immediately (the hook only fires
 * at the start of a turn).
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const MEMORY_MARKER = "agent memory:";

// ============================================================================
// Persistence (channel-scoped)
// ============================================================================

export function getChannelMemoryFilePath(sessionDir: string, channelId: string): string {
	return join(sessionDir, `channel-memory-${channelId}.json`);
}

export function loadChannelMemory(sessionDir: string, channelId: string): string | undefined {
	try {
		const path = getChannelMemoryFilePath(sessionDir, channelId);
		if (!existsSync(path)) return undefined;
		const data = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof data.memory === "string" && data.memory.trim()) return data.memory;
	} catch {
		// Corrupt/missing file -> treat as no memory
	}
	return undefined;
}

export function saveChannelMemory(sessionDir: string, channelId: string, memory: string | undefined): void {
	try {
		const path = getChannelMemoryFilePath(sessionDir, channelId);
		if (!memory || !memory.trim()) {
			if (existsSync(path)) unlinkSync(path);
			return;
		}
		writeFileSync(path, JSON.stringify({ channelId, memory, updatedAt: Date.now() }, null, 2));
	} catch (error) {
		console.error(`[session-memory] Failed to save memory for channel ${channelId}:`, error);
	}
}

// ============================================================================
// Persistence (legacy session-UUID-keyed — kept for migration and tests)
// ============================================================================

export function getMemoryFilePath(sessionDir: string, sessionId: string): string {
	return join(sessionDir, `memory-${sessionId}.json`);
}

export function loadMemory(sessionDir: string, sessionId: string): string | undefined {
	try {
		const path = getMemoryFilePath(sessionDir, sessionId);
		if (!existsSync(path)) return undefined;
		const data = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof data.memory === "string" && data.memory.trim()) return data.memory;
	} catch {
		// Corrupt/missing file -> treat as no memory
	}
	return undefined;
}

export function saveMemory(sessionDir: string, sessionId: string, memory: string | undefined): void {
	try {
		const path = getMemoryFilePath(sessionDir, sessionId);
		if (!memory || !memory.trim()) {
			if (existsSync(path)) unlinkSync(path);
			return;
		}
		writeFileSync(path, JSON.stringify({ memory, updatedAt: Date.now() }, null, 2));
	} catch (error) {
		console.error(`[session-memory] Failed to save memory for ${sessionId}:`, error);
	}
}

// ============================================================================
// System prompt patching
// ============================================================================

/**
 * Insert or replace the "agent memory:" block at the end of a system prompt.
 * Everything from the marker onward is replaced (memory block lives last).
 * Returns the base prompt unchanged when memory is empty/undefined.
 */
export function upsertMemoryBlock(systemPrompt: string, memory: string | undefined): string {
	const markerIndex = systemPrompt.indexOf(MEMORY_MARKER);
	const base =
		markerIndex !== -1
			? systemPrompt.slice(0, markerIndex).replace(/\n+$/, "")
			: systemPrompt.replace(/\n+$/, "");
	if (!memory || !memory.trim()) return base;
	return `${base}\n\n${MEMORY_MARKER}\n${memory}`;
}

/**
 * Patch the CURRENT turn's system prompt so newly remembered memory is visible
 * to the running agent loop immediately (the before_agent_start hook only
 * fires at the start of a turn; the next turn picks it up from disk).
 */
export function patchCurrentSystemPrompt(session: AgentSession, memory: string): void {
	const s = session as unknown as { agent: { state: { systemPrompt: string } } };
	s.agent.state.systemPrompt = upsertMemoryBlock(s.agent.state.systemPrompt, memory);
}

/** Extract the current memory block text (without the marker) from a system prompt. */
export function extractMemoryFromPrompt(systemPrompt: string): string | undefined {
	const markerIndex = systemPrompt.indexOf(MEMORY_MARKER);
	if (markerIndex === -1) return undefined;
	const rest = systemPrompt.slice(markerIndex + MEMORY_MARKER.length).replace(/^\n+/, "");
	return rest.trim() || undefined;
}

// ============================================================================
// Official system prompt injection via the before_agent_start extension hook
// ============================================================================

/**
 * Create an inline extension factory that appends the persisted memory block
 * to the system prompt at the start of every agent turn. Registered via
 * DefaultResourceLoader's `extensionFactories` option.
 *
 * Memory is resolved per DISCORD CHANNEL (channelId is captured at factory
 * creation), so /session, /clear, /compact, /resume, forks and bot restarts
 * all keep the channel's memory. As a migration fallback, when the channel
 * file does not exist yet it also checks the legacy session-UUID sidecar for
 * the current session (memory-<sessionId>.json) and adopts it into the
 * channel file on first use. When the channel has no memory the handler
 * returns undefined and the base prompt is used unchanged.
 */
export function createSessionMemoryExtension(sessionDir: string, channelId: string): ExtensionFactory {
	return (pi) => {
		pi.on("before_agent_start", (event, ctx) => {
			const memory = loadChannelMemory(sessionDir, channelId);
			if (memory !== undefined) {
				return { systemPrompt: upsertMemoryBlock(event.systemPrompt, memory) };
			}

			// Legacy fallback: a session-UUID-keyed sidecar from before memory
			// became channel-scoped. Adopt it into the channel file so future
			// saves go to the channel key and the memory is not lost.
			const sessionId = ctx.sessionManager.getSessionId();
			const legacy = loadMemory(sessionDir, sessionId);
			if (legacy) {
				saveChannelMemory(sessionDir, channelId, legacy);
				return { systemPrompt: upsertMemoryBlock(event.systemPrompt, legacy) };
			}
			return undefined;
		});
	};
}
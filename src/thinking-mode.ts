/**
 * Thinking Mode - persistent per-channel control for the model's own
 * thinking/reasoning level (the `thinkingmode` tool).
 *
 * This is the analog of `remember` for thinking level: a tool the MODEL calls
 * to raise or lower its own reasoning effort, with the chosen level persisted
 * per DISCORD CHANNEL so it follows the channel across everything:
 *
 *   - Bot restart        -> channel level loaded -> level restored
 *   - /session           -> NEW session UUID, same channel -> level restored
 *   - /clear             -> NEW session UUID, same channel -> level restored
 *   - /compact           -> NEW session UUID, same channel -> level restored
 *   - /resume            -> old session restored, same channel -> level restored
 *   - /fork & reply-to-old-message forks -> same channel -> level intact
 *   - crash / /kill      -> level restored on next session creation
 *
 * Keying by channel (not pi session UUID) matches the `remember` design and
 * avoids the session-UUID leaks seen with memory.
 *
 * The tool writes to the SAME mechanism the manual `/thinking` command uses:
 * `session.setThinkingLevel(level)`, so the model-controlled level and the
 * manually controlled level are one and the same. The chosen level is also
 * persisted (channel-scoped) so it survives restarts.
 *
 * Default: NO thinking ("off"). The tool description instructs the model to
 * run at "off" for simple tasks and only raise the level for genuinely complex
 * ones, then drop back to "off" once the complex task is done.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** All thinking levels pi supports, in ascending reasoning effort. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/** The channel's default thinking mode when nothing has been set yet. */
export const DEFAULT_THINKING_MODE = "off";

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// ============================================================================
// Persistence (channel-scoped)
// ============================================================================

export function getChannelThinkingModeFilePath(sessionDir: string, channelId: string): string {
	return join(sessionDir, `channel-thinking-${channelId}.json`);
}

/**
 * Whether the model is currently ALLOWED to change its own thinking level
 * via the `thinkingmode` tool. Controlled by `/thinkingmode on|off`. When
 * disabled the tool still exists and can be called, but its execute refuses
 * and its description tells the model it is unavailable.
 *
 * Default: true (tool enabled). If a channel-sidecar file predates this flag
 * (no `enabled` field), the tool is treated as enabled.
 */
export function isThinkingModeEnabled(sessionDir: string, channelId: string): boolean {
	try {
		const path = getChannelThinkingModeFilePath(sessionDir, channelId);
		if (!existsSync(path)) return true;
		const data = JSON.parse(readFileSync(path, "utf-8"));
		return data.enabled !== false;
	} catch {
		return true;
	}
}

export function setThinkingModeEnabled(sessionDir: string, channelId: string, enabled: boolean): void {
	try {
		const path = getChannelThinkingModeFilePath(sessionDir, channelId);
		let data: Record<string, unknown> = {};
		if (existsSync(path)) {
			try {
				data = JSON.parse(readFileSync(path, "utf-8"));
			} catch {
				data = {};
			}
		}
		data.channelId = channelId;
		data.enabled = enabled;
		data.updatedAt = Date.now();
		writeFileSync(path, JSON.stringify(data, null, 2));
	} catch (error) {
		console.error(`[thinking-mode] Failed to persist enabled state for channel ${channelId}:`, error);
	}
}

export function loadChannelThinkingMode(sessionDir: string, channelId: string): string | undefined {
	try {
		const path = getChannelThinkingModeFilePath(sessionDir, channelId);
		if (!existsSync(path)) return undefined;
		const data = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof data.level === "string" && THINKING_LEVELS.includes(data.level as ThinkingLevel)) {
			return data.level;
		}
	} catch {
		// Corrupt/missing file -> treat as unset
	}
	return undefined;
}

export function saveChannelThinkingMode(sessionDir: string, channelId: string, level: string): void {
	try {
		const path = getChannelThinkingModeFilePath(sessionDir, channelId);
		if (!level || !THINKING_LEVELS.includes(level as ThinkingLevel)) {
			if (existsSync(path)) unlinkSync(path);
			return;
		}
		const enabled = isThinkingModeEnabled(sessionDir, channelId);
		writeFileSync(path, JSON.stringify({ channelId, level, enabled, updatedAt: Date.now() }, null, 2));
	} catch (error) {
		console.error(`[thinking-mode] Failed to save thinking mode for channel ${channelId}:`, error);
	}
}

/**
 * Apply the persisted channel thinking level to a freshly created session.
 * Called right after `createAgentSession` (model must be set for clamping).
 * When the channel has no persisted level yet it defaults to "off" (no
 * thinking), which is the requested default.
 */
export function applyChannelThinkingMode(sessionDir: string, channelId: string, session: AgentSession): void {
	try {
		const level = loadChannelThinkingMode(sessionDir, channelId) ?? DEFAULT_THINKING_MODE;
		session.setThinkingLevel(level as ThinkingLevel);
	} catch (error) {
		console.error(`[thinking-mode] Failed to apply thinking mode for channel ${channelId}:`, error);
	}
}

// ============================================================================
// Tool definition (dynamic description reflects the live current level)
// ============================================================================

/**
 * Build the `thinkingmode` tool. The description is a getter so it always
 * reflects the CURRENT live thinking level and the model's available levels
 * (re-evaluated on every property access). `getSession` returns the live
 * AgentSession (resolved lazily; undefined before the session exists).
 */
export function createThinkingModeTool(opts: {
	sessionDir: string;
	channelId: string;
	getSession: () => AgentSession | undefined;
}): any {
	const { sessionDir, channelId, getSession } = opts;

	function liveLevel(): string {
		const session = getSession();
		if (session?.thinkingLevel) return session.thinkingLevel;
		return loadChannelThinkingMode(sessionDir, channelId) ?? DEFAULT_THINKING_MODE;
	}

	function availableLevels(): string[] {
		const session = getSession();
		const model = session?.model as ({
			reasoning?: boolean;
			thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
		} | undefined);
		if (model) {
			try {
				// Compute the true supported set directly from the model's
				// thinkingLevelMap. A level is supported iff its map entry is
				// non-null AND non-undefined (absent). "off" is always available.
				const mapped = model.thinkingLevelMap;
				if (model.reasoning && mapped) {
					const set = (["off", "minimal", "low", "medium", "high", "xhigh"] as ThinkingLevel[]).filter(
						(level) => {
							if (level === "off") return true;
							const v = mapped[level];
							return v !== null && v !== undefined; // null hides the level
						}
					);
					if (set.length > 1) return set; // at least "off" + a real reasoning level
				}
				// No map → fall back to the SDK's per-model list (which correctly
				// handles non-reasoning models). For reasoning models without a map
				// we defer to the SDK so we don't over-restrict.
				const sdkLevels = session!.getAvailableThinkingLevels();
				if (Array.isArray(sdkLevels) && sdkLevels.length > 0) return [...sdkLevels];
			} catch {
				// Fall through to generic fallback below.
			}
		}
		return [...THINKING_LEVELS];
	}

	// Re-read the enabled flag from disk on every access so the description and
	// execute always reflect the current /thinkingmode on|off state, even after
	// it changes mid-session.
	function enabled(): boolean {
		return isThinkingModeEnabled(sessionDir, channelId);
	}

	return {
		name: "thinkingmode",
		// Getter: always shows the current level + available levels + policy.
		get description() {
			// When the user disabled the tool via /thinkingmode off, the description
			// reflects that the model is NOT allowed to change the thinking level.
			if (!enabled()) {
				return (
					`⚠️ The “thinkingmode” tool is currently DISABLED for this Discord channel ` +
					`(turned off by /thinkingmode off). You are NOT allowed to change the thinking ` +
					`level right now. If you call this tool anyway it will refuse and the thinking ` +
					`level will stay unchanged. Continue working at the current thinking level ` +
					`(${liveLevel()}) until the user re-enables it with /thinkingmode on.`
				);
			}
			const current = liveLevel();
			const available = availableLevels().join(", ");
			return (
				`Control the model's own thinking/reasoning level for this Discord channel. ` +
				`The CURRENT thinking level is: ${current}. ` +
				`Available thinking levels (may vary by model): ${available}. ` +
				`Changing this level takes effect immediately and is persisted for this channel, ` +
				`surviving /session, /clear, /compact, /resume, bot restarts, crashes and forks — ` +
				`it is the same thinking level the /thinking command controls.\n\n` +
				`How to choose which level to set:\n` +
				`- DEFAULT to no thinking ("off") and keep it there. Use "off" for simple, quick questions, ` +
				`straightforward answers, easy lookups, and anything that can be answered correctly and quickly ` +
				`without deep reasoning.\n` +
				`- Raise the level ONLY for genuinely complex tasks that need more analysis: multi-step or ` +
				`multi-factor problems, long debugging sessions, subtle or ambiguous code, architectural or design ` +
				`decisions, large refactors, or any task where skipping careful reasoning risks a wrong or ` +
				`incomplete answer. Also raise the level if you are STRUGGLING — if a task is taking many attempts, ` +
				`repeatedly failing, or you feel you lack the reasoning depth to get it right, increasing the thinking ` +
				`level gives you the room to think it through properly instead of guessing.\n` +
				`- Use the LOWEST level that still reliably solves the task — prefer "low"/"minimal" over ` +
				`"high" when modest reasoning is enough.\n` +
				`- As soon as the next request is simple again, switch BACK to "off" and stay there until the next ` +
				`genuinely complex task. Do not leave thinking raised after a complex task is finished.\n\n` +
				`Call this tool with the exact level you chose. The result will confirm the new current level and ` +
				`the available levels.`
			);
		},
		// Getter: the parameter schema reflects the CURRENT model's supported
		// thinking levels, re-evaluated on every access so it stays in sync with
		// the model in use.
		get parameters() {
			const avail = availableLevels();
			const list = avail.length > 0 ? avail : [...THINKING_LEVELS];
			return {
				type: "object",
				properties: {
					level: {
						type: "string",
						enum: list,
						description:
							"The thinking level to set. Available levels for the current model: " +
							list.join(", ") +
							". Default to 'off' for simple tasks; raise only for complex ones (or when you are struggling and need more reasoning depth); drop back to 'off' when the next task is simple again.",
					},
				},
				required: ["level"],
			};
		},
		execute: async (_toolCallId: string, { level }: { level: string }) => {
			try {
				// Refuse up-front when the tool is disabled, regardless of level.
				if (!enabled()) {
					return {
						content: [
							{
								type: "text",
								text: `❌ The “thinkingmode” tool is currently DISABLED for this channel ("/thinkingmode off"). You are NOT allowed to change the thinking level right now; the thinking level stays at ${liveLevel()}. It will be re-enabled when the user runs /thinkingmode on. Continue working at the current level until then.`,
							},
						],
					};
				}

				const session = getSession();
				if (!session) {
					return { content: [{ type: "text", text: "❌ No active session — cannot change thinking level." }] };
				}

				// Only accept levels the current model really supports. The SDK's
				// setThinkingLevel would clamp anyway, but we surface the true set
				// here so the model knows exactly what it may pick from.
				const avail = availableLevels();
				if (!avail.includes(level)) {
					return {
						content: [
							{
								type: "text",
								text: `❌ Invalid thinking level "${level}" for the current model. Available levels: ${avail.join(", ")}.`,
							},
						],
					};
				}

				const previous = session.thinkingLevel;
				// setThinkingLevel clamps to the model's supported levels.
				session.setThinkingLevel(level as ThinkingLevel);
				const newLevel = session.thinkingLevel;

				// Persist per-channel so the level survives restarts / sessions / crashes.
				saveChannelThinkingMode(sessionDir, channelId, newLevel);

				const available = session.getAvailableThinkingLevels().join(", ");
				const changed = previous === newLevel ? " (already set)" : "";
				return {
					content: [
						{
							type: "text",
							text: `✅ Thinking level changed: ${previous} → ${newLevel}${changed}. Available: ${available}. Persisted for this channel.`,
						},
					],
				};
			} catch (error) {
				return { content: [{ type: "text", text: `❌ Failed to set thinking level: ${error}` }] };
			}
		},
	};
}

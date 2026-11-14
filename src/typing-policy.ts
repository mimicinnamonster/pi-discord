/**
 * Typing indicator policy.
 *
 * The indicator means "the main agent is thinking or writing". It must NOT mean
 * "a turn exists": while the main agent is blocked on a tool — and especially
 * while a subagent is doing the work — Discord should show nothing, so that a
 * silent indicator is a truthful signal that the bot is waiting on delegation.
 *
 * Hiding is delayed by ANTI_FLICKER_MS after a tool starts, and a tool that ends
 * inside that window cancels the pending hide, so a fast tool never blinks the
 * indicator off and on. The delay lives in the state machine (as a decision the
 * caller schedules), not in ad-hoc timers spread across the event handlers.
 *
 * Subagent output must not re-enable typing: tool_execution_update and subagent
 * completion events map to `tool_activity`, which never shows.
 */

/** A tool that finishes inside this window does not hide the indicator at all. */
export const TYPING_ANTI_FLICKER_MS = 1_500;

export interface TypingState {
	/** A turn is in progress: agent_start seen, agent_end not yet. */
	turnActive: boolean;
	/** Tools currently executing (parallel tool calls are possible). */
	toolsInFlight: number;
	/** Last applied visibility: true when the indicator is on. */
	visible: boolean;
	/** A delayed hide is armed for a tool that is still running. */
	hidePending: boolean;
}

export function createTypingState(): TypingState {
	return { turnActive: false, toolsInFlight: 0, visible: false, hidePending: false };
}

export type TypingEvent =
	/** A turn begins: user prompt accepted, queued prompt sent, agent_start. */
	| { type: "turn_start" }
	/** The main agent is producing output: message/text/thinking/compaction/retry. */
	| { type: "generating" }
	/** A tool (including a subagent call) started: the main agent is now blocked. */
	| { type: "tool_start" }
	/** Tool-internal activity that must not change visibility (subagent output). */
	| { type: "tool_activity" }
	/** A tool finished; the main agent may resume writing. */
	| { type: "tool_end" }
	/** The turn is over (agent_end, abort, error, recovery, /stop). */
	| { type: "turn_end" };

export type TypingAction = "show" | "hide" | "keep";

export interface TypingDecision {
	state: TypingState;
	action: TypingAction;
	/** Arm a hide this many ms from now; any later decision cancels it. */
	hideAfterMs?: number;
}

export function decideTyping(previous: TypingState, event: TypingEvent): TypingDecision {
	const state: TypingState = { ...previous };

	switch (event.type) {
		case "turn_start":
			return {
				state: { turnActive: true, toolsInFlight: 0, visible: true, hidePending: false },
				action: "show",
			};

		case "generating":
			// Output from a tool or a subagent is not main-agent generation: while a
			// tool is in flight (or about to hide) the indicator stays off.
			if (!state.turnActive) {
				return {
					state: { turnActive: true, toolsInFlight: 0, visible: true, hidePending: false },
					action: "show",
				};
			}
			if (state.toolsInFlight > 0) {
				return { state, action: "keep" };
			}
			state.visible = true;
			state.hidePending = false;
			return { state, action: "show" };

		case "tool_start": {
			state.toolsInFlight += 1;
			// Nothing to hide when the indicator is already off (nested tool), and a
			// second parallel tool must not restart the anti-flicker window.
			if (!state.visible || state.hidePending) {
				return { state, action: "keep" };
			}
			state.hidePending = true;
			return { state, action: "keep", hideAfterMs: TYPING_ANTI_FLICKER_MS };
		}

		case "tool_activity":
			return { state, action: "keep" };

		case "tool_end": {
			state.toolsInFlight = Math.max(0, state.toolsInFlight - 1);
			if (state.toolsInFlight > 0) {
				return { state, action: "keep" };
			}
			if (state.hidePending) {
				// The tool finished inside the anti-flicker window: stay visible.
				state.hidePending = false;
				return { state, action: "keep" };
			}
			if (!state.turnActive) {
				state.visible = false;
				return { state, action: "hide" };
			}
			state.visible = true;
			return { state, action: "show" };
		}

		case "turn_end":
			return {
				state: { turnActive: false, toolsInFlight: 0, visible: false, hidePending: false },
				action: "hide",
			};
	}
}

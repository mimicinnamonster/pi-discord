import { describe, it, expect } from "vitest";
import {
	createTypingState,
	decideTyping,
	TYPING_ANTI_FLICKER_MS,
	type TypingEvent,
	type TypingState,
} from "../src/typing-policy.ts";

/** Applies a sequence of events, returning the final state and every action taken. */
function run(events: TypingEvent[], start: TypingState = createTypingState()) {
	let state = start;
	const actions: string[] = [];
	let hideAfterMs: number | undefined;
	for (const event of events) {
		const decision = decideTyping(state, event);
		state = decision.state;
		actions.push(decision.action);
		if (decision.hideAfterMs !== undefined) hideAfterMs = decision.hideAfterMs;
	}
	return { state, actions, hideAfterMs };
}

/** Simulates the caller's timer firing: the indicator is now hidden. */
function afterHideTimerFires(state: TypingState): TypingState {
	return { ...state, visible: false, hidePending: false };
}

describe("typing policy", () => {
	describe("main agent generation", () => {
		it("shows the indicator when a turn starts", () => {
			const decision = decideTyping(createTypingState(), { type: "turn_start" });
			expect(decision.action).toBe("show");
			expect(decision.state.visible).toBe(true);
			expect(decision.state.turnActive).toBe(true);
		});

		it("keeps the indicator visible for a text delta", () => {
			const started = decideTyping(createTypingState(), { type: "turn_start" }).state;
			const decision = decideTyping(started, { type: "generating" });
			expect(decision.action).toBe("show");
			expect(decision.state.visible).toBe(true);
		});

		it("starts a turn implicitly when generation arrives first", () => {
			const decision = decideTyping(createTypingState(), { type: "generating" });
			expect(decision.action).toBe("show");
			expect(decision.state.turnActive).toBe(true);
		});
	});

	describe("waiting on tools and subagents", () => {
		it("arms the anti-flicker hide when a subagent tool starts", () => {
			const { state, actions, hideAfterMs } = run([
				{ type: "turn_start" },
				{ type: "tool_start" },
			]);
			expect(actions).toEqual(["show", "keep"]);
			expect(hideAfterMs).toBe(TYPING_ANTI_FLICKER_MS);
			expect(state.hidePending).toBe(true);
			expect(state.toolsInFlight).toBe(1);
		});

		it("does not re-show typing while a tool is in flight, whatever generates", () => {
			const started = decideTyping(createTypingState(), { type: "turn_start" }).state;
			const toolStarted = decideTyping(started, { type: "tool_start" }).state;
			const hidden = afterHideTimerFires(toolStarted);

			// Subagent output and completion notices arrive as tool activity/updates
			expect(decideTyping(hidden, { type: "tool_activity" }).action).toBe("keep");
			// Even a stray generation event must not turn the indicator back on
			expect(decideTyping(hidden, { type: "generating" }).action).toBe("keep");
			expect(decideTyping(hidden, { type: "generating" }).state.visible).toBe(false);
		});

		it("shows the indicator again when a long tool finishes and the turn continues", () => {
			const started = decideTyping(createTypingState(), { type: "turn_start" }).state;
			const toolStarted = decideTyping(started, { type: "tool_start" }).state;
			const hidden = afterHideTimerFires(toolStarted);

			const decision = decideTyping(hidden, { type: "tool_end" });
			expect(decision.action).toBe("show");
			expect(decision.state.visible).toBe(true);
			expect(decision.state.toolsInFlight).toBe(0);
		});

		it("does not hide at all when the tool finishes inside the grace window", () => {
			const started = decideTyping(createTypingState(), { type: "turn_start" }).state;
			const toolStarted = decideTyping(started, { type: "tool_start" }).state;

			const decision = decideTyping(toolStarted, { type: "tool_end" });
			expect(decision.action).toBe("keep");
			expect(decision.state.hidePending).toBe(false);
			expect(decision.state.visible).toBe(true);
		});

		it("keeps the hide pending while a parallel tool is still running", () => {
			const started = decideTyping(createTypingState(), { type: "turn_start" }).state;
			const oneTool = decideTyping(started, { type: "tool_start" }).state;
			const twoTools = decideTyping(oneTool, { type: "tool_start" });
			// Second tool must not restart the anti-flicker window
			expect(twoTools.hideAfterMs).toBeUndefined();
			expect(twoTools.state.toolsInFlight).toBe(2);

			const hidden = afterHideTimerFires(twoTools.state);
			const firstEnded = decideTyping(hidden, { type: "tool_end" });
			expect(firstEnded.action).toBe("keep");
			expect(firstEnded.state.visible).toBe(false);
		});

		it("hides instead of showing when a tool ends after the turn is over", () => {
			const started = decideTyping(createTypingState(), { type: "turn_start" }).state;
			const ended = decideTyping(started, { type: "turn_end" }).state;
			const toolEnded = decideTyping({ ...ended, toolsInFlight: 1 }, { type: "tool_end" });
			expect(toolEnded.action).toBe("hide");
			expect(toolEnded.state.visible).toBe(false);
		});
	});

	describe("turn end", () => {
		it("hides and resets on turn end", () => {
			const { state, actions } = run([
				{ type: "turn_start" },
				{ type: "generating" },
				{ type: "turn_end" },
			]);
			expect(actions.at(-1)).toBe("hide");
			expect(state).toEqual(createTypingState());
		});

		it("hides on abort or recovery even with a tool still counted", () => {
			const started = decideTyping(createTypingState(), { type: "turn_start" }).state;
			const busy = decideTyping(started, { type: "tool_start" }).state;
			const decision = decideTyping(busy, { type: "turn_end" });
			expect(decision.action).toBe("hide");
			expect(decision.state).toEqual(createTypingState());
		});
	});
});

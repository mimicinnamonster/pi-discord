/**
 * Interrupt Decision Tests
 * Exercises the real shouldInterruptForIncomingMessage() predicate used by
 * handleMessage in src/index.ts (index.ts itself is not importable under
 * test — it validates DISCORD_BOT_TOKEN and calls process.exit at module load).
 */

import { describe, it, expect } from "vitest";
import { shouldInterruptForIncomingMessage, type InterruptDecisionInput } from "../src/interrupt-decision.ts";

/** A normal mid-run state: model streaming, plain user message. */
const midRun: InterruptDecisionInput = {
	modelActive: true,
	nonInterruptingCommand: false,
};

describe("shouldInterruptForIncomingMessage", () => {
	it("interrupts when the model is actively running", () => {
		expect(shouldInterruptForIncomingMessage(midRun)).toBe(true);
	});

	it("interrupts while the model is retrying", () => {
		// isModelActive() includes isRetrying, so a retry backoff must be
		// interruptible: a new message aborts the run instead of waiting it out.
		expect(shouldInterruptForIncomingMessage({ modelActive: true, nonInterruptingCommand: false })).toBe(true);
	});

	it("interrupts regardless of pending background subagent work", () => {
		// Background subagents run in their own detached process group, so
		// aborting the main turn leaves them running. There is deliberately no
		// input for "background work pending": it must not suppress an interrupt.
		const input: InterruptDecisionInput = { modelActive: true, nonInterruptingCommand: false };
		expect(shouldInterruptForIncomingMessage(input)).toBe(true);
	});

	it("never interrupts for non-interrupting commands", () => {
		expect(shouldInterruptForIncomingMessage({ ...midRun, nonInterruptingCommand: true })).toBe(false);
	});

	it("does nothing when the model is inactive", () => {
		expect(shouldInterruptForIncomingMessage({ ...midRun, modelActive: false })).toBe(false);
		expect(
			shouldInterruptForIncomingMessage({ modelActive: false, nonInterruptingCommand: true }),
		).toBe(false);
	});
});

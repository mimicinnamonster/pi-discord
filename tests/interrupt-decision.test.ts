/**
 * Interrupt Decision Tests
 * Exercises the real shouldInterruptForIncomingMessage() predicate used by
 * handleMessage in src/index.ts (index.ts itself is not importable under
 * test — it validates DISCORD_BOT_TOKEN and calls process.exit at module load).
 */

import { describe, it, expect } from "vitest";
import { shouldInterruptForIncomingMessage, type InterruptDecisionInput } from "../src/interrupt-decision.ts";

/** A normal mid-run state: model streaming, nothing special pending. */
const midRun: InterruptDecisionInput = {
	modelActive: true,
	nonInterruptingCommand: false,
	awaitingAgentEnd: false,
	retrying: false,
	compacting: false,
	bashRunning: false,
	pendingBackgroundWork: false,
};

describe("shouldInterruptForIncomingMessage", () => {
	it("interrupts when the model is actively running (real interruption preserved)", () => {
		// Mid-run even with background subagents pending: the main turn is
		// genuinely executing, so a user message must still abort it.
		expect(shouldInterruptForIncomingMessage({ ...midRun, pendingBackgroundWork: true })).toBe(true);
		expect(shouldInterruptForIncomingMessage(midRun)).toBe(true);
	});

	it("does not interrupt when only the background-subagent drain remains", () => {
		// Final turn ended (awaitingAgentEnd), no retry/compaction/bash, and the
		// session only still looks active because pi-subagents is draining.
		expect(
			shouldInterruptForIncomingMessage({
				...midRun,
				awaitingAgentEnd: true,
				pendingBackgroundWork: true,
			}),
		).toBe(false);
	});

	it("still interrupts in the turn_end→agent_end gap when no background work is pending", () => {
		// Without pending subagents the settle window is momentary; behavior is
		// unchanged from before (interrupt as usual).
		expect(
			shouldInterruptForIncomingMessage({
				...midRun,
				awaitingAgentEnd: true,
				pendingBackgroundWork: false,
			}),
		).toBe(true);
	});

	it("still interrupts during retry even if a turn previously settled", () => {
		expect(
			shouldInterruptForIncomingMessage({
				...midRun,
				awaitingAgentEnd: true,
				pendingBackgroundWork: true,
				retrying: true,
			}),
		).toBe(true);
	});

	it("still interrupts during compaction even if a turn previously settled", () => {
		expect(
			shouldInterruptForIncomingMessage({
				...midRun,
				awaitingAgentEnd: true,
				pendingBackgroundWork: true,
				compacting: true,
			}),
		).toBe(true);
	});

	it("still interrupts during bash execution even if a turn previously settled", () => {
		expect(
			shouldInterruptForIncomingMessage({
				...midRun,
				awaitingAgentEnd: true,
				pendingBackgroundWork: true,
				bashRunning: true,
			}),
		).toBe(true);
	});

	it("never interrupts for non-interrupting commands", () => {
		expect(
			shouldInterruptForIncomingMessage({
				...midRun,
				nonInterruptingCommand: true,
			}),
		).toBe(false);
		expect(
			shouldInterruptForIncomingMessage({
				...midRun,
				awaitingAgentEnd: true,
				pendingBackgroundWork: true,
				nonInterruptingCommand: true,
			}),
		).toBe(false);
	});

	it("does nothing when the model is inactive", () => {
		expect(shouldInterruptForIncomingMessage({ ...midRun, modelActive: false })).toBe(false);
		expect(
			shouldInterruptForIncomingMessage({
				...midRun,
				modelActive: false,
				awaitingAgentEnd: true,
				pendingBackgroundWork: true,
			}),
		).toBe(false);
	});
});

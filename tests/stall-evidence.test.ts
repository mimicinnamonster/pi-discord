/**
 * Evidence rules for the stall watchdogs.
 *
 * These boundaries were wrong in production on 2026-11-15 and cost ten hours of
 * silence: the interrupt sequence erased the completion marker, and the same
 * sequence refreshed the silence clock, so the post-completion check refused
 * with "no terminal message" and the idle watchdog's threshold kept restarting
 * while the user kept asking whether it was stuck.
 *
 * The rules under test are pure, so each of those failure modes is pinned
 * directly instead of through a live session (src/index.ts cannot be imported:
 * it validates DISCORD_BOT_TOKEN and exits at load).
 */

import { describe, it, expect } from "vitest";
import {
	clearsTerminalMarker,
	deriveTranscriptCompletionEvidence,
	isLivenessEvent,
	shouldEscalateStallRefusal,
	STALL_ESCALATION_SWEEPS,
	type StallEventLike,
} from "../src/stall-evidence.ts";
import { parseTranscriptTail, type TranscriptTail } from "../src/completion-orphans.ts";

function event(overrides: Partial<StallEventLike>): StallEventLike {
	return { type: "message_update", ...overrides };
}

function tail(overrides: Partial<TranscriptTail> = {}): TranscriptTail {
	return { unparseableLines: 0, meaningfulCount: 1, ...overrides };
}

function assistantLine(at: string, stopReason?: string): string {
	return JSON.stringify({
		type: "message",
		message: { role: "assistant", content: "done", ...(stopReason ? { stopReason } : {}) },
		timestamp: at,
	});
}

describe("isLivenessEvent", () => {
	it("counts real generation and tool work", () => {
		expect(isLivenessEvent(event({ type: "agent_start" }))).toBe(true);
		expect(isLivenessEvent(event({ type: "message_start", message: { role: "assistant" } }))).toBe(true);
		expect(isLivenessEvent(event({ type: "message_update" }))).toBe(true);
		expect(isLivenessEvent(event({ type: "tool_execution_start" }))).toBe(true);
		expect(isLivenessEvent(event({ type: "tool_execution_update" }))).toBe(true);
		expect(isLivenessEvent(event({ type: "tool_execution_end" }))).toBe(true);
	});

	it("does not count our own interruption landing", () => {
		// The abort pair: an aborted message, then the run's end and settle.
		expect(isLivenessEvent(event({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } }))).toBe(false);
		expect(isLivenessEvent(event({ type: "agent_end" }))).toBe(false);
		expect(isLivenessEvent(event({ type: "agent_settled" }))).toBe(false);
	});

	it("does not count end-of-run bookkeeping", () => {
		expect(isLivenessEvent(event({ type: "auto_retry_end" }))).toBe(false);
		expect(isLivenessEvent(event({ type: "auto_compaction_end" }))).toBe(false);
	});
});

describe("clearsTerminalMarker", () => {
	it("survives an interrupt and the end of the run", () => {
		// The exact events that erased the evidence during the 10-hour wedge.
		expect(clearsTerminalMarker(event({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } }))).toBe(false);
		expect(clearsTerminalMarker(event({ type: "agent_end" }))).toBe(false);
		expect(clearsTerminalMarker(event({ type: "agent_settled" }))).toBe(false);
		expect(clearsTerminalMarker(event({ type: "auto_retry_end" }))).toBe(false);
	});

	it("is cleared by a genuinely new turn", () => {
		expect(clearsTerminalMarker(event({ type: "agent_start" }))).toBe(true);
		expect(clearsTerminalMarker(event({ type: "message_start", message: { role: "user" } }))).toBe(true);
		expect(clearsTerminalMarker(event({ type: "message_start", message: { role: "assistant" } }))).toBe(true);
	});

	it("is cleared when the turn continues past the message", () => {
		// A tool batch, resumed generation, or an automatic retry/compaction all
		// mean the run is working again rather than settling.
		expect(clearsTerminalMarker(event({ type: "tool_execution_start" }))).toBe(true);
		expect(clearsTerminalMarker(event({ type: "message_update" }))).toBe(true);
		expect(clearsTerminalMarker(event({ type: "auto_compaction_start" }))).toBe(true);
		expect(clearsTerminalMarker(event({ type: "auto_retry_start" }))).toBe(true);
	});
});

describe("deriveTranscriptCompletionEvidence", () => {
	it("recovers the marker when the transcript ends at a terminal assistant message", () => {
		const parsed = parseTranscriptTail(assistantLine("2026-11-14T21:40:57.152Z", "stop"));
		expect(deriveTranscriptCompletionEvidence(parsed)).toEqual({
			terminalAt: Date.parse("2026-11-14T21:40:57.152Z"),
			stopReason: "stop",
		});
	});

	it("refuses when something meaningful happened after the assistant message", () => {
		const parsed = parseTranscriptTail(
			[
				assistantLine("2026-11-14T21:40:57.152Z", "stop"),
				JSON.stringify({ type: "message", message: { role: "user", content: "status?" }, timestamp: "2026-11-14T21:46:14.451Z" }),
			].join("\n")
		);
		expect(deriveTranscriptCompletionEvidence(parsed)).toBeNull();
	});

	it("refuses when the assistant message continued with a tool batch", () => {
		const parsed = parseTranscriptTail(assistantLine("2026-11-14T21:40:57.152Z", "toolUse"));
		expect(deriveTranscriptCompletionEvidence(parsed)).toBeNull();
	});

	it("refuses when the transcript records no stop reason at all", () => {
		const parsed = parseTranscriptTail(assistantLine("2026-11-14T21:40:57.152Z"));
		expect(deriveTranscriptCompletionEvidence(parsed)).toBeNull();
	});

	it("refuses a tail with no assistant message", () => {
		expect(deriveTranscriptCompletionEvidence(tail({ lastMeaningfulKind: "notify" }))).toBeNull();
		expect(
			deriveTranscriptCompletionEvidence(tail({ lastMeaningfulKind: "assistant", lastAssistantTerminal: true }))
		).toBeNull();
	});
});

describe("shouldEscalateStallRefusal", () => {
	it("escalates only after the same refusal repeats for consecutive sweeps", () => {
		expect(shouldEscalateStallRefusal("subagent-work-pending", 1)).toBe(false);
		expect(shouldEscalateStallRefusal("subagent-work-pending", STALL_ESCALATION_SWEEPS - 1)).toBe(false);
		expect(shouldEscalateStallRefusal("subagent-work-pending", STALL_ESCALATION_SWEEPS)).toBe(true);
	});

	it("escalates the timing-based refusals too", () => {
		expect(shouldEscalateStallRefusal("within-grace", STALL_ESCALATION_SWEEPS)).toBe(true);
		expect(shouldEscalateStallRefusal("event-since-terminal", STALL_ESCALATION_SWEEPS)).toBe(true);
	});

	it("never escalates a refusal that rests on observable work", () => {
		// A long tool run or a live child process is work: repeating that answer must
		// never become a licence to tear the turn down.
		expect(shouldEscalateStallRefusal("tool-in-flight", 99)).toBe(false);
		expect(shouldEscalateStallRefusal("child-process-alive", 99)).toBe(false);
		expect(shouldEscalateStallRefusal("not-active", 99)).toBe(false);
		expect(shouldEscalateStallRefusal("no-terminal-message", 99)).toBe(false);
	});

	it("does not escalate when the check did not refuse", () => {
		expect(shouldEscalateStallRefusal(null, 99)).toBe(false);
	});
});

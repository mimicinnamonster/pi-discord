/**
 * Orphaned background-completion tests.
 *
 * The wake exists because pi-subagents' completion notice is delivered through
 * the process that started the run: when that process is gone (a restart while a
 * workflow was in flight), the notice is written to the transcript and nothing
 * else happens. Observed live: `subagent-notify` persisted at 20:37:38.864Z, the
 * next turn only at 21:02:08 after the user typed "status?".
 *
 * These cases pin the detection to the transcript, and pin the guards that keep
 * it from waking twice or announcing work that is still running.
 */

import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
	buildWakePrompt,
	isFinishedRunState,
	isOrphanCompletion,
	MAX_ORPHAN_AGE_MS,
	ORPHAN_MIN_AGE_MS,
	parseTranscriptTail,
	readTranscriptTail,
} from "../src/completion-orphans.ts";

const NOW = Date.parse("2026-11-14T21:10:00.000Z");

/** One JSONL transcript line for a `subagent-notify` custom message. */
function notifyLine(at: string, content = "Background task failed: worker — process exited"): string {
	return JSON.stringify({ type: "custom_message", customType: "subagent-notify", content, timestamp: at });
}

/** One JSONL transcript line for an assistant message. */
function assistantLine(at: string, text = "here you go"): string {
	return JSON.stringify({ type: "message", message: { role: "assistant", content: text }, timestamp: at });
}

/** One JSONL transcript line for a user message. */
function userLine(at: string, text = "status?"): string {
	return JSON.stringify({ type: "message", message: { role: "user", content: text }, timestamp: at });
}

/** Metadata record: present in every real transcript, carries no meaning. */
function metadataLine(at: string, type = "model_change"): string {
	return JSON.stringify({ type, timestamp: at });
}

function input(overrides: Partial<Parameters<typeof isOrphanCompletion>[0]> = {}) {
	return {
		channelId: "1492621695352045762",
		tail: parseTranscriptTail(""),
		now: NOW,
		isWoken: () => false,
		...overrides,
	};
}

describe("transcript tail parsing", () => {
	it("ignores metadata records when deciding what happened last", () => {
		const tail = parseTranscriptTail(
			[
				assistantLine("2026-11-14T20:37:00.000Z"),
				notifyLine("2026-11-14T20:37:38.864Z"),
				metadataLine("2026-11-14T20:37:39.000Z"),
			].join("\n")
		);
		expect(tail.lastMeaningfulKind).toBe("notify");
		expect(tail.lastNotifyAt).toBe(Date.parse("2026-11-14T20:37:38.864Z"));
		expect(tail.lastAssistantAt).toBe(Date.parse("2026-11-14T20:37:00.000Z"));
	});

	it("records a user message as meaningful so a notify followed by a reply is not an orphan", () => {
		const tail = parseTranscriptTail(
			[notifyLine("2026-11-14T20:37:38.864Z"), userLine("2026-11-14T21:02:08.000Z")].join("\n")
		);
		expect(tail.lastMeaningfulKind).toBe("user");
	});

	it("counts unparseable lines without throwing and keeps the parseable ones", () => {
		const tail = parseTranscriptTail(
			["{not json", notifyLine("2026-11-14T20:37:38.864Z"), "   ", '{"type":"message"'].join("\n")
		);
		expect(tail.unparseableLines).toBe(2);
		expect(tail.lastMeaningfulKind).toBe("notify");
	});

	it("treats a transcript of only garbage as no evidence at all", () => {
		const tail = parseTranscriptTail("garbage\n{{{\n");
		expect(tail.meaningfulCount).toBe(0);
		expect(tail.lastMeaningfulKind).toBeUndefined();
	});

	it("reads only the tail of a large file and still parses whole records", () => {
		const dir = mkdtempSync(join(tmpdir(), "orphan-tail-"));
		const path = join(dir, "discord-1.jsonl");
		const filler = Array.from({ length: 500 }, (_, i) =>
			assistantLine(`2026-11-14T19:${String(i % 60).padStart(2, "0")}:00.000Z`, "x".repeat(200))
		).join("\n");
		writeFileSync(path, `${filler}\n${notifyLine("2026-11-14T20:37:38.864Z")}\n`);

		const tail = parseTranscriptTail(readTranscriptTail(path, 8 * 1024));
		expect(tail.lastMeaningfulKind).toBe("notify");
		expect(tail.unparseableLines).toBe(0);
	});
});

describe("orphan completion decision", () => {
	it("wakes when a notify has nothing after it (the owner-process-death case)", () => {
		const tail = parseTranscriptTail(
			[assistantLine("2026-11-14T20:30:00.000Z"), notifyLine("2026-11-14T20:37:38.864Z")].join("\n")
		);
		const decision = isOrphanCompletion(input({ tail }));
		expect(decision.orphan).toBe(true);
		expect(decision.detectedBy).toBe("notify");
		expect(decision.key).toBe(`notify:${Date.parse("2026-11-14T20:37:38.864Z")}`);
	});

	it("does not wake when the notify was answered (healthy path)", () => {
		const tail = parseTranscriptTail(
			[notifyLine("2026-11-14T20:37:38.864Z"), assistantLine("2026-11-14T20:37:40.000Z")].join("\n")
		);
		expect(isOrphanCompletion(input({ tail })).orphan).toBe(false);
	});

	it("does not wake the same completion twice", () => {
		const tail = parseTranscriptTail(notifyLine("2026-11-14T20:37:38.864Z"));
		const decision = isOrphanCompletion(input({ tail, isWoken: (key) => key.startsWith("notify:") }));
		expect(decision.orphan).toBe(false);
		expect(decision.refusal).toBe("already-woken");
	});

	it("waits out the grace period instead of racing the healthy delivery", () => {
		const tail = parseTranscriptTail(notifyLine("2026-11-14T21:09:50.000Z"));
		const decision = isOrphanCompletion(input({ tail, now: Date.parse("2026-11-14T21:10:00.000Z") }));
		expect(decision.orphan).toBe(false);
		expect(decision.refusal).toBe("too-recent");
		expect(ORPHAN_MIN_AGE_MS).toBeLessThanOrEqual(120_000);
	});

	it("leaves a day-old completion alone rather than resuming it unprompted", () => {
		const tail = parseTranscriptTail(notifyLine("2026-11-13T19:00:00.000Z"));
		const decision = isOrphanCompletion(input({ tail }));
		expect(decision.orphan).toBe(false);
		expect(decision.refusal).toBe("too-old");
		expect(NOW - Date.parse("2026-11-13T19:00:00.000Z")).toBeGreaterThan(MAX_ORPHAN_AGE_MS);
	});

	it("wakes for a finished run that never wrote a notify at all", () => {
		const tail = parseTranscriptTail(assistantLine("2026-11-14T20:30:00.000Z"));
		const decision = isOrphanCompletion(
			input({
				tail,
				finishedRun: {
					runId: "a68f7721-0000-4000-8000-000000000000",
					state: "complete",
					endedAt: Date.parse("2026-11-14T20:32:22.000Z"),
					pidAlive: false,
					hasResult: false,
				},
			})
		);
		expect(decision.orphan).toBe(true);
		expect(decision.detectedBy).toBe("run");
		expect(decision.runId).toBe("a68f7721-0000-4000-8000-000000000000");
	});

	it("never wakes for a finished run whose runner is still alive", () => {
		const tail = parseTranscriptTail(assistantLine("2026-11-14T20:30:00.000Z"));
		const decision = isOrphanCompletion(
			input({
				tail,
				finishedRun: {
					runId: "run-alive",
					state: "complete",
					endedAt: Date.parse("2026-11-14T20:32:22.000Z"),
					pidAlive: true,
				},
			})
		);
		expect(decision.orphan).toBe(false);
		expect(decision.refusal).toBe("run-still-live");
	});

	it("ignores a finished run the transcript already moved past", () => {
		const tail = parseTranscriptTail(assistantLine("2026-11-14T20:45:00.000Z"));
		const decision = isOrphanCompletion(
			input({
				tail,
				finishedRun: {
					runId: "run-old",
					state: "complete",
					endedAt: Date.parse("2026-11-14T20:32:22.000Z"),
					pidAlive: false,
				},
			})
		);
		expect(decision.orphan).toBe(false);
		expect(decision.refusal).toBe("no-orphan");
	});

	it("treats only non-outstanding, non-paused states as finished", () => {
		expect(isFinishedRunState("complete")).toBe(true);
		expect(isFinishedRunState("failed")).toBe(true);
		expect(isFinishedRunState("running")).toBe(false);
		expect(isFinishedRunState("queued")).toBe(false);
		// `paused` is resumable, so it is neither finished nor outstanding work.
		expect(isFinishedRunState("paused")).toBe(false);
	});
});

describe("wake prompt", () => {
	it("says the result is unavailable instead of implying one exists", () => {
		const prompt = buildWakePrompt({
			runId: "a68f7721",
			state: "complete",
			wakeAt: NOW,
			resultAvailable: false,
		});
		expect(prompt).toContain("No result payload exists");
		expect(prompt).not.toContain("is on disk");
		expect(prompt).toContain("Do not ask the user to prompt you again");
	});

	it("includes the notice excerpt when one was written", () => {
		const prompt = buildWakePrompt({
			runId: "run-1",
			state: "failed",
			wakeAt: NOW,
			resultAvailable: true,
			notifyContent: "Background task failed: worker",
		});
		expect(prompt).toContain("Background task failed: worker");
		expect(prompt).toContain("result payload is on disk");
	});
});

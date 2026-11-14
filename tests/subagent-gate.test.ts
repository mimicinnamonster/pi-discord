import { expect, test } from "vitest";
import { createSubagentGate, STALE_ASYNC_WORK_TIMEOUT_MS } from "../src/subagent-gate.ts";

test("gate is disabled: admits any number of subagents in the same channel", () => {
	const gate = createSubagentGate();
	expect(gate.acquireSync("call-1")).toBe(true);
	expect(gate.isGateHeld()).toBe(false);
	expect(gate.acquireSync("call-2")).toBe(true);
	expect(gate.acquireSync("call-3")).toBe(true);
	expect(gate.isGateHeld()).toBe(false);
	gate.releaseSync("call-1");
	gate.releaseSync("call-2");
	gate.releaseSync("call-3");
	expect(gate.isGateHeld()).toBe(false);
});

test("releaseSync for an unknown id is a no-op", () => {
	const gate = createSubagentGate();
	gate.releaseSync("never-acquired");
	expect(gate.isGateHeld()).toBe(false);
});

test("gates are independent per channel", () => {
	const channelA = createSubagentGate();
	const channelB = createSubagentGate();
	expect(channelA.acquireSync("a-1")).toBe(true);
	// channel B is NOT affected by channel A's in-flight subagent
	expect(channelB.acquireSync("b-1")).toBe(true);
	channelA.releaseSync("a-1");
	channelB.releaseSync("b-1");
});

test("async lifecycle never blocks sync subagents (gate disabled)", () => {
	const gate = createSubagentGate();
	gate.onAsyncStarted({});
	expect(gate.isGateHeld()).toBe(false);
	// a sync subagent runs alongside the async one without blocking
	expect(gate.acquireSync("call-1")).toBe(true);
	gate.onAsyncComplete({ status: "completed" });
	expect(gate.isGateHeld()).toBe(false);
	expect(gate.acquireSync("call-2")).toBe(true);
	gate.releaseSync("call-1");
	gate.releaseSync("call-2");
});

test("async-complete clamps at zero", () => {
	const gate = createSubagentGate();
	gate.onAsyncComplete({ status: "completed" });
	expect(gate.isGateHeld()).toBe(false);
});

test("pendingAsyncWork counts in-flight async subagents only", () => {
	const gate = createSubagentGate();
	expect(gate.pendingAsyncWork()).toBe(0);
	gate.onAsyncStarted({});
	gate.onAsyncStarted({});
	expect(gate.pendingAsyncWork()).toBe(2);
	// sync in-flight calls are mid-turn work, not background work
	gate.acquireSync("call-1");
	expect(gate.pendingAsyncWork()).toBe(2);
	gate.releaseSync("call-1");
	expect(gate.pendingAsyncWork()).toBe(2);
	gate.onAsyncComplete({ status: "completed" });
	expect(gate.pendingAsyncWork()).toBe(1);
	gate.onAsyncComplete({ status: "failed" });
	expect(gate.pendingAsyncWork()).toBe(0);
});

test("pendingAsyncWork clamps at zero on stray async-complete", () => {
	const gate = createSubagentGate();
	gate.onAsyncComplete({ status: "completed" });
	expect(gate.pendingAsyncWork()).toBe(0);
});

test("async-complete releases the oldest run when the payload carries no id", () => {
	let clock = 0;
	const gate = createSubagentGate({ now: () => clock });
	gate.onAsyncStarted({});
	clock = 1_000;
	gate.onAsyncStarted({});
	expect(gate.pendingAsyncWork()).toBe(2);
	gate.onAsyncComplete({ status: "completed" });
	expect(gate.pendingAsyncWork()).toBe(1);
});

test("async-complete matches a run by payload id", () => {
	const gate = createSubagentGate();
	gate.onAsyncStarted({ runId: "run-a" });
	gate.onAsyncStarted({ runId: "run-b" });
	gate.onAsyncComplete({ runId: "run-b", status: "completed" });
	expect(gate.pendingAsyncWork()).toBe(1);
	// idempotent: a duplicate completion does not release the other run
	gate.onAsyncComplete({ runId: "run-b", status: "completed" });
	expect(gate.pendingAsyncWork()).toBe(1);
});

test("sweepStaleAsync releases only runs older than the timeout", () => {
	let clock = 0;
	const gate = createSubagentGate({ now: () => clock });
	gate.onAsyncStarted({ runId: "old" });
	clock = 9 * 60_000;
	gate.onAsyncStarted({ runId: "fresh" });

	// 10 minutes after "old" started, "fresh" is only 1 minute old.
	clock = 10 * 60_000;
	expect(gate.sweepStaleAsync()).toEqual(["old"]);
	expect(gate.pendingAsyncWork()).toBe(1);
});

test("sweepStaleAsync is what un-wedges a channel whose run never completes", () => {
	let clock = 0;
	const gate = createSubagentGate({ now: () => clock });
	gate.onAsyncStarted({ runId: "orphaned-e74b8f12" });
	expect(gate.pendingAsyncWork()).toBe(1);

	// 20 hours later the completion event still has not arrived (observed in
	// #forth): the channel must not stay blocked forever.
	clock = 20 * 60 * 60_000;
	const released = gate.sweepStaleAsync(STALE_ASYNC_WORK_TIMEOUT_MS);
	expect(released).toEqual(["orphaned-e74b8f12"]);
	expect(gate.pendingAsyncWork()).toBe(0);
});

test("sweepStaleAsync returns nothing when everything is recent", () => {
	const gate = createSubagentGate({ now: () => 0 });
	gate.onAsyncStarted({ runId: "run-a" });
	expect(gate.sweepStaleAsync()).toEqual([]);
	expect(gate.pendingAsyncWork()).toBe(1);
});

// ============================================================================
// The sync/async split the watchdog relies on
// ============================================================================

test("hasSyncWork reports only in-flight sync tool calls", () => {
	const gate = createSubagentGate();
	expect(gate.hasSyncWork()).toBe(false);

	// An async run is not a sync call: only a live child process can be trusted
	// unconditionally, and an async run's child is detached from this process.
	gate.onAsyncStarted({ runId: "run-a" });
	expect(gate.hasSyncWork()).toBe(false);
	expect(gate.hasActiveWork()).toBe(true);

	gate.acquireSync("call-1");
	expect(gate.hasSyncWork()).toBe(true);

	gate.releaseSync("call-1");
	expect(gate.hasSyncWork()).toBe(false);
});

test("pendingAsyncRuns exposes the ids and start times for store cross-checking", () => {
	let clock = 1_000;
	const gate = createSubagentGate({ now: () => clock });
	gate.onAsyncStarted({ runId: "run-a" });
	clock = 2_000;
	gate.onAsyncStarted({});

	// The synthetic counter advances for every start, id or not: ids stay unique.
	expect(gate.pendingAsyncRuns()).toEqual([
		{ id: "run-a", startedAt: 1_000 },
		{ id: "async-run-2", startedAt: 2_000 },
	]);

	// A run dropped by the sweep disappears from the snapshot too.
	gate.onAsyncComplete({ runId: "run-a", status: "completed" });
	expect(gate.pendingAsyncRuns().map((run) => run.id)).toEqual(["async-run-2"]);
});

test("pendingAsyncRuns is empty once nothing is held", () => {
	const gate = createSubagentGate();
	expect(gate.pendingAsyncRuns()).toEqual([]);
});

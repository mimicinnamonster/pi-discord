import { expect, test } from "vitest";
import { createSubagentGate } from "../src/subagent-gate.ts";

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

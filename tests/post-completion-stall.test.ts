/**
 * Post-completion stall detection.
 *
 * The pure predicate is tested directly; the sweep's fast path is mirrored in a
 * small rig because src/index.ts cannot be imported under test (it validates
 * DISCORD_BOT_TOKEN and exits at module load). The rig calls the real predicate
 * and mirrors only the ordering decisions, which is where the bugs live: whether
 * the end-of-turn work runs once, twice, or not at all.
 */

import { describe, it, expect } from "vitest";
import {
	evaluatePostCompletionStall,
	isPostCompletionStall,
	isTerminalStopReason,
	POST_COMPLETION_STALL_GRACE_MS,
	type PostCompletionStallInput,
} from "../src/post-completion-stall.ts";
import { hasProgressingAsyncWork } from "../src/subagent-run-store.ts";

function input(overrides: Partial<PostCompletionStallInput> = {}): PostCompletionStallInput {
	return {
		modelActive: true,
		msSinceTerminalMessage: POST_COMPLETION_STALL_GRACE_MS + 1,
		eventSinceTerminal: false,
		inFlightToolCount: 0,
		hasPendingSubagentWork: false,
		liveChildProcessCount: 0,
		...overrides,
	};
}

describe("evaluatePostCompletionStall", () => {
	it("calls a quiet run past its final message stalled", () => {
		expect(evaluatePostCompletionStall(input())).toBeNull();
		expect(isPostCompletionStall(input())).toBe(true);
	});

	it("never acts on a run that reports itself inactive", () => {
		expect(evaluatePostCompletionStall(input({ modelActive: false }))).toBe("not-active");
	});

	it("requires a terminal assistant message", () => {
		expect(evaluatePostCompletionStall(input({ msSinceTerminalMessage: undefined }))).toBe(
			"no-terminal-message"
		);
	});

	it("refuses while any event arrived after the final message", () => {
		// The run is still producing: a follow-up turn, a compaction, a queued prompt.
		expect(evaluatePostCompletionStall(input({ eventSinceTerminal: true }))).toBe(
			"event-since-terminal"
		);
	});

	it("refuses while a tool is in flight (silence is work)", () => {
		expect(evaluatePostCompletionStall(input({ inFlightToolCount: 1 }))).toBe("tool-in-flight");
	});

	it("refuses while a subagent drain still owes a completion notice", () => {
		// The children are detached processes: no tool in flight, no child pid, and
		// still real work. This is the case that must not be torn down.
		expect(evaluatePostCompletionStall(input({ hasPendingSubagentWork: true }))).toBe(
			"subagent-work-pending"
		);
	});

	it("refuses while a child process is alive (sync subagent, process tool)", () => {
		expect(evaluatePostCompletionStall(input({ liveChildProcessCount: 2 }))).toBe(
			"child-process-alive"
		);
	});

	it("waits out the grace window before acting", () => {
		expect(evaluatePostCompletionStall(input({ msSinceTerminalMessage: 1_000 }))).toBe(
			"within-grace"
		);
		expect(
			evaluatePostCompletionStall(input({ msSinceTerminalMessage: 1_000, graceMs: 500 }))
		).toBeNull();
	});
});

describe("isTerminalStopReason", () => {
	it("treats stop/length/error/aborted as the end of a turn", () => {
		for (const reason of ["stop", "length", "error", "aborted"]) {
			expect(isTerminalStopReason(reason)).toBe(true);
		}
	});

	it("does not treat a tool batch or an unfinished message as the end", () => {
		expect(isTerminalStopReason("toolUse")).toBe(false);
		expect(isTerminalStopReason("pending")).toBe(false);
	});
});

// ============================================================================
// Fast path: mirrors the sweep in src/index.ts (pass 1)
// ============================================================================

describe("Post-completion fast path", () => {
	const GRACE_MS = 120_000;
	// The generic idle threshold the fast path must NOT wait for.
	const IDLE_THRESHOLD_MS = 45 * 60 * 1000;

	function createRig(options: { abortSettles?: boolean } = {}) {
		const abortSettles = options.abortSettles ?? false;
		let modelActive = true;
		// Marker semantics copied from src/index.ts: set by the terminal assistant
		// message, deleted by every later event.
		let terminalAt: number | undefined = Date.now() - (GRACE_MS + 5_000);
		let lastEventAt = terminalAt;
		let inFlightToolCount = 0;
		let hasPendingSubagentWork = false;
		let liveChildPids: number[] = [];
		let listenerActive = true;
		let hideCount = 0;
		let recoveries = 0;
		const queue = ["queued prompt"];
		const drained: string[] = [];

		function finishTurn(): void {
			inFlightToolCount = 0;
			terminalAt = undefined;
			hideCount++;
			const next = queue.shift();
			if (next) drained.push(next);
		}

		function stallRefusal() {
			return evaluatePostCompletionStall({
				modelActive,
				msSinceTerminalMessage: terminalAt === undefined ? undefined : Date.now() - terminalAt,
				eventSinceTerminal: lastEventAt > (terminalAt ?? Number.POSITIVE_INFINITY),
				inFlightToolCount,
				hasPendingSubagentWork,
				liveChildProcessCount: liveChildPids.length,
				graceMs: GRACE_MS,
			});
		}

		return {
			stallRefusal,
			sweep(): "post-completion" | "generic-idle" {
				if (stallRefusal() === null) {
					recoveries++;
					// Stage 1 of recoverStuckSession(): a plain abort. When it settles the
					// session is kept, so its own agent_end still does the end-of-turn work.
					if (abortSettles) {
						modelActive = false;
						return "post-completion";
					}
					// Stage 2: dispose + recreate. The old subscription dies with the
					// session, so no stale agent_end can arrive afterwards.
					listenerActive = false;
					modelActive = false;
					finishTurn();
					return "post-completion";
				}
				const idleMs = Date.now() - lastEventAt;
				if (modelActive && idleMs >= IDLE_THRESHOLD_MS) recoveries++;
				return "generic-idle";
			},
			/** The SDK's own end of turn, only delivered while the listener lives. */
			agentEnd(): boolean {
				if (!listenerActive) return false;
				finishTurn();
				return true;
			},
			markActivity(): void {
				lastEventAt = Date.now();
				terminalAt = undefined;
			},
			setInFlightToolCount(count: number): void {
				inFlightToolCount = count;
			},
			setLiveChildPids(pids: number[]): void {
				liveChildPids = pids;
			},
			setPendingSubagentWork(pending: boolean): void {
				hasPendingSubagentWork = pending;
			},
			drained: () => drained,
			queue: () => queue,
			hideCount: () => hideCount,
			recoveries: () => recoveries,
			idleMs: () => Date.now() - lastEventAt,
		};
	}

	it("recovers long before the idle threshold, without a confirmation streak", () => {
		const rig = createRig();

		expect(rig.sweep()).toBe("post-completion");

		expect(rig.recoveries()).toBe(1);
		// 2 minutes of silence, not 45: this is the whole point of the fast path.
		expect(rig.idleMs()).toBeLessThan(IDLE_THRESHOLD_MS);
		// The end-of-turn work the missing agent_end never did.
		expect(rig.drained()).toEqual(["queued prompt"]);
		expect(rig.queue()).toEqual([]);
		expect(rig.hideCount()).toBe(1);
	});

	it("does not double-drain or double-hide when a stale agent_end arrives after the rebuild", () => {
		const rig = createRig();

		rig.sweep();
		// dispose() cleared the old session's listeners, so the wedged run's
		// agent_end can no longer reach the handler.
		expect(rig.agentEnd()).toBe(false);

		expect(rig.drained()).toEqual(["queued prompt"]);
		expect(rig.hideCount()).toBe(1);
	});

	it("leaves the end-of-turn work to agent_end when the abort settles", () => {
		const rig = createRig({ abortSettles: true });

		rig.sweep();
		expect(rig.drained()).toEqual([]);

		// The run really did settle, so its agent_end drains the queue exactly once.
		expect(rig.agentEnd()).toBe(true);
		expect(rig.drained()).toEqual(["queued prompt"]);
	});

	it("keeps today's behaviour while a tool is in flight", () => {
		const rig = createRig();
		rig.setInFlightToolCount(1);

		expect(rig.stallRefusal()).toBe("tool-in-flight");
		expect(rig.recoveries()).toBe(0);
	});

	it("keeps today's behaviour while a child process is alive", () => {
		const rig = createRig();
		rig.setLiveChildPids([4242]);

		expect(rig.stallRefusal()).toBe("child-process-alive");
		expect(rig.recoveries()).toBe(0);
	});

	it("keeps today's behaviour while a subagent drain is still waiting", () => {
		const rig = createRig();
		rig.setPendingSubagentWork(true);

		expect(rig.stallRefusal()).toBe("subagent-work-pending");
		expect(rig.recoveries()).toBe(0);
	});

	it("keeps today's behaviour when the run is still emitting events", () => {
		const rig = createRig();
		rig.markActivity();

		expect(rig.stallRefusal()).toBe("no-terminal-message");
		expect(rig.recoveries()).toBe(0);
	});
});

// ============================================================================
// A finished run whose completion notice is still queued is the wedge, not work
// ============================================================================

describe("Post-completion stall with a finished-but-undelivered subagent run", () => {
	const NOW = 10_000_000;

	/**
	 * Mirrors subagentWorkLiveness() in src/index.ts: the gate's counted runs are
	 * resolved against the run store before they may refuse recovery.
	 */
	function stallRefusalWithStore(
		pendingAsyncRuns: { id: string; startedAt: number }[],
		storeRuns: { runId: string; state: string; pidAlive?: boolean; ageMs?: number }[]
	): string | null {
		return evaluatePostCompletionStall({
			modelActive: true,
			msSinceTerminalMessage: POST_COMPLETION_STALL_GRACE_MS + 1,
			eventSinceTerminal: false,
			inFlightToolCount: 0,
			hasPendingSubagentWork: hasProgressingAsyncWork(pendingAsyncRuns, { runs: storeRuns }, { now: NOW }),
			liveChildProcessCount: 0,
		});
	}

	it("recovers: the run is complete but its result was never delivered", () => {
		// Live incident shape (run 853692be): the gate still counted the run because
		// async-complete is delivered through the session, delivery needs an idle
		// session, and the settle path is what is blocked. Reading that tally as work
		// is what kept the channel wedged for 45 minutes with no watchdog line.
		const pending = [{ id: "853692be-1111-2222-3333-444455556666", startedAt: NOW - 30 * 60_000 }];

		expect(stallRefusalWithStore(pending, [])).toBeNull();
	});

	it("refuses while the counted run is still running with a live child", () => {
		const pending = [{ id: "aaaa1111-0000-0000-0000-000000000000", startedAt: NOW - 60_000 }];
		const store = [{ runId: pending[0]!.id, state: "running", pidAlive: true, ageMs: 60_000 }];

		expect(stallRefusalWithStore(pending, store)).toBe("subagent-work-pending");
	});

	it("refuses while the counted run wrote its status moments ago", () => {
		const pending = [{ id: "bbbb2222-0000-0000-0000-000000000000", startedAt: NOW - 60_000 }];
		const store = [{ runId: pending[0]!.id, state: "running", pidAlive: false, ageMs: 10_000 }];

		expect(stallRefusalWithStore(pending, store)).toBe("subagent-work-pending");
	});

	it("recovers when the counted run's pid is dead and its status is stale", () => {
		const pending = [{ id: "cccc3333-0000-0000-0000-000000000000", startedAt: NOW - 60 * 60_000 }];
		const store = [{ runId: pending[0]!.id, state: "running", pidAlive: false, ageMs: 30 * 60_000 }];

		expect(stallRefusalWithStore(pending, store)).toBeNull();
	});
});

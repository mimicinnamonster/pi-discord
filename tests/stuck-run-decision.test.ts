/**
 * Stale-run recovery decision tests.
 *
 * The watchdog exists because a run can park between agent_end and the SDK's
 * settle path, which is the only place `_isAgentRunActive` is cleared. There,
 * `isModelActive()` stays true forever and `abort()` waits on a dead flag.
 *
 * The cases below also pin down the guards that keep the watchdog from killing a
 * healthy turn: a silent-but-working session (tool in flight, sync subagent
 * child, agent_end drain) must never be recovered.
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_STUCK_RUN_THRESHOLD_MS,
	evaluateStuckRun,
	evaluateStuckRunLiveness,
	REQUIRED_CONFIRMING_SWEEPS,
	shouldRecoverStuckRun,
	type StuckRunDecisionInput,
} from "../src/stuck-run-decision.ts";
import { hasProgressingAsyncWork } from "../src/subagent-run-store.ts";

/** Inputs for a session that is silent, idle past the threshold and fully confirmed. */
function wedgedInput(overrides: Partial<StuckRunDecisionInput> = {}): StuckRunDecisionInput {
	return {
		modelActive: true,
		idleMs: DEFAULT_STUCK_RUN_THRESHOLD_MS,
		hasPendingBackgroundWork: false,
		inFlightToolCount: 0,
		hasActiveSubagentWork: false,
		priorConfirmations: REQUIRED_CONFIRMING_SWEEPS - 1,
		...overrides,
	};
}

describe("stuck run decision", () => {
	it("never recovers a healthy active run that is still emitting events", () => {
		expect(shouldRecoverStuckRun(wedgedInput({ idleMs: 2_000 }))).toBe(false);
	});

	it("does not recover while background subagent work is legitimately draining", () => {
		// A drain holds the run open without emitting agent events, so silence
		// alone would otherwise look like a wedge.
		expect(
			shouldRecoverStuckRun(wedgedInput({ idleMs: DEFAULT_STUCK_RUN_THRESHOLD_MS * 5, hasPendingBackgroundWork: true }))
		).toBe(false);
	});

	it("does not recover an idle session that reports no model activity", () => {
		expect(
			shouldRecoverStuckRun(wedgedInput({ modelActive: false, idleMs: DEFAULT_STUCK_RUN_THRESHOLD_MS * 5 }))
		).toBe(false);
	});

	it("does not recover a session with a tool still in flight", () => {
		// A 12-minute build inside a sync child emits nothing at all: the count is
		// the only evidence that the silence is work. Stage 1 of recovery aborts,
		// which would destroy the turn.
		const evaluation = evaluateStuckRun(
			wedgedInput({ inFlightToolCount: 1, idleMs: DEFAULT_STUCK_RUN_THRESHOLD_MS * 2 })
		);
		expect(evaluation.shouldRecover).toBe(false);
		expect(evaluation.refusedBy).toBe("tool-in-flight");
	});

	it("does not recover while a sync subagent call is live in the gate", () => {
		const evaluation = evaluateStuckRun(wedgedInput({ hasActiveSubagentWork: true }));
		expect(evaluation.shouldRecover).toBe(false);
		expect(evaluation.refusedBy).toBe("sync-subagent-work");
	});

	it("requires consecutive confirming sweeps before recovering", () => {
		const first = evaluateStuckRun(wedgedInput({ priorConfirmations: 0 }));
		expect(first.shouldRecover).toBe(false);
		// Still reported as a candidate: the sweep accrues evidence on this tick.
		expect(first.candidate).toBe(true);
		expect(first.refusedBy).toBe("unconfirmed");

		expect(shouldRecoverStuckRun(wedgedInput({ priorConfirmations: REQUIRED_CONFIRMING_SWEEPS - 1 }))).toBe(true);
	});

	it("keeps the threshold above every documented legitimate silent phase", () => {
		// The pi-subagents agent_end drain can legitimately hold a run open for 30
		// minutes and STALE_ASYNC_WORK_TIMEOUT_MS releases background runs at 10.
		expect(DEFAULT_STUCK_RUN_THRESHOLD_MS).toBeGreaterThan(30 * 60 * 1000);
	});

	it("recovers a session that is silent past the threshold with no live work", () => {
		expect(shouldRecoverStuckRun(wedgedInput())).toBe(true);
	});

	it("honours a custom threshold", () => {
		const base = wedgedInput({ idleMs: 30_000, thresholdMs: 60_000 });
		expect(evaluateStuckRun(base).refusedBy).toBe("not-idle");
		expect(shouldRecoverStuckRun({ ...base, idleMs: 60_000 })).toBe(true);
	});

	it("reports the first refusing gate so the watchdog log names it", () => {
		expect(evaluateStuckRun(wedgedInput({ modelActive: false })).refusedBy).toBe("not-active");
		expect(evaluateStuckRun(wedgedInput({ hasPendingBackgroundWork: true })).refusedBy).toBe("async-subagent-work");
		expect(evaluateStuckRun(wedgedInput()).refusedBy).toBe(null);
	});
});

describe("stuck run liveness gates", () => {
	// The parked-message replay gates its abort on this half of the decision, so an
	// unconfirmed-but-silent run counts as wedged there (a replay always runs after
	// the sweep's recovery pass has collected confirmations).

	it("treats a silent run past the threshold as wedged, confirmation notwithstanding", () => {
		expect(evaluateStuckRunLiveness(wedgedInput({ priorConfirmations: 0 }))).toBe(null);
	});

	it("refuses while any live-work signal is present", () => {
		expect(evaluateStuckRunLiveness(wedgedInput({ modelActive: false }))).toBe("not-active");
		expect(evaluateStuckRunLiveness(wedgedInput({ inFlightToolCount: 2 }))).toBe("tool-in-flight");
		expect(evaluateStuckRunLiveness(wedgedInput({ hasActiveSubagentWork: true }))).toBe("sync-subagent-work");
		expect(evaluateStuckRunLiveness(wedgedInput({ hasPendingBackgroundWork: true }))).toBe("async-subagent-work");
		expect(evaluateStuckRunLiveness(wedgedInput({ idleMs: 1_000 }))).toBe("not-idle");
	});

	it("agrees with the full decision on every liveness refusal", () => {
		for (const overrides of [
			{ modelActive: false },
			{ inFlightToolCount: 1 },
			{ hasActiveSubagentWork: true },
			{ hasPendingBackgroundWork: true },
			{ idleMs: 0 },
		]) {
			const input = wedgedInput(overrides);
			expect(evaluateStuckRunLiveness(input)).toBe(evaluateStuckRun(input).refusedBy);
		}
	});
});

// ============================================================================
// The gate's counted runs must be verified before they may refuse recovery
// ============================================================================

describe("async subagent work is verified against the run store", () => {
	const NOW = 10_000_000;

	/**
	 * Mirrors subagentWorkLiveness() in src/index.ts: the gate's in-memory tally is
	 * cross-checked against the run store before it may refuse recovery.
	 */
	function inputFor(
		pendingAsyncRuns: { id: string; startedAt: number }[],
		storeRuns: { runId: string; state: string; pidAlive?: boolean; ageMs?: number }[]
	): StuckRunDecisionInput {
		return wedgedInput({
			hasPendingBackgroundWork: hasProgressingAsyncWork(pendingAsyncRuns, { runs: storeRuns }, { now: NOW }),
		});
	}

	it("recovers a channel whose counted run already finished (the wedge itself)", () => {
		// Live incident: run 853692be reached state=complete, but the gate only drops
		// a run on async-complete, which is delivered through the session. Trusting
		// the tally here deadlocks the very recovery that unblocks delivery.
		const pending = [{ id: "853692be-1111-2222-3333-444455556666", startedAt: NOW - 30 * 60_000 }];

		expect(shouldRecoverStuckRun(inputFor(pending, []))).toBe(true);
	});

	it("still refuses while the counted run has a live child process", () => {
		const pending = [{ id: "aaaa1111-0000-0000-0000-000000000000", startedAt: NOW - 60_000 }];
		const store = [{ runId: pending[0]!.id, state: "running", pidAlive: true, ageMs: 60_000 }];

		expect(evaluateStuckRun(inputFor(pending, store)).refusedBy).toBe("async-subagent-work");
	});

	it("recovers when the counted run's pid is dead and its status is ten minutes old", () => {
		const pending = [{ id: "bbbb2222-0000-0000-0000-000000000000", startedAt: NOW - 60 * 60_000 }];
		const store = [{ runId: pending[0]!.id, state: "running", pidAlive: false, ageMs: 10 * 60_000 }];

		// Dead pid plus ten minutes of silence: the record is stale, not work.
		expect(shouldRecoverStuckRun(inputFor(pending, store))).toBe(true);
	});

	it("still refuses while the counted run wrote its status within the recent window", () => {
		const pending = [{ id: "cccc3333-0000-0000-0000-000000000000", startedAt: NOW - 60_000 }];
		const store = [{ runId: pending[0]!.id, state: "running", pidAlive: false, ageMs: 10_000 }];

		expect(evaluateStuckRun(inputFor(pending, store)).refusedBy).toBe("async-subagent-work");
	});
});

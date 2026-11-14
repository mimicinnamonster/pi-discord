/**
 * Subagent run-store snapshot tests.
 *
 * This snapshot is the only evidence that names *which* subagent run pinned the
 * settle path when the watchdog rebuilds a session: the run's `status.json` is
 * deleted with the session, so a wrong line in the journal points the next
 * investigation at the wrong run. The parser and formatter are therefore tested
 * directly (including the shapes that must never throw), and the store walk is
 * exercised against a real directory tree.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
	formatOutstandingRuns,
	hasProgressingAsyncWork,
	isOutstandingState,
	isProgressingRun,
	parseRunStatus,
	resolveAsyncRunStoreDir,
	RUN_PROGRESS_RECENT_MS,
	summarizeRunStore,
	type OutstandingRun,
	type RunStoreSummary,
} from "../src/subagent-run-store.ts";

function makeStore(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-discord-run-store-"));
	return dir;
}

function run(overrides: Partial<OutstandingRun> = {}): OutstandingRun {
	return { runId: "853692be-1111-2222-3333-444455556666", state: "running", ...overrides };
}

function summary(runs: OutstandingRun[], error?: string): RunStoreSummary {
	return error === undefined ? { dir: "/store", runs } : { dir: "/store", runs: [], error };
}

function writeRun(dir: string, runId: string, status: unknown): void {
	const runDir = join(dir, runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "status.json"), typeof status === "string" ? status : JSON.stringify(status));
}

describe("resolveAsyncRunStoreDir", () => {
	it("uses PI_SUBAGENTS_TEMP_ROOT when set, mirroring pi-subagents", () => {
		const dir = resolveAsyncRunStoreDir({ PI_SUBAGENTS_TEMP_ROOT: "/var/tmp/pi-sa" }, "/ignored");
		expect(dir).toBe(join("/var/tmp/pi-sa", "async-subagent-runs"));
	});

	it("falls back to pi-subagents-<scope> under the temp dir", () => {
		const dir = resolveAsyncRunStoreDir({}, "/tmp/root");
		expect(dir.startsWith(join("/tmp/root", "pi-subagents-"))).toBe(true);
		expect(dir.endsWith(join("async-subagent-runs"))).toBe(true);
	});
});

describe("parseRunStatus", () => {
	it("extracts the fields the diagnostic prints", () => {
		const record = parseRunStatus(
			JSON.stringify({ runId: "abc123", state: "running", pid: 42, lastUpdate: 1000 }),
			"dir-name"
		);
		expect(record).toEqual({ runId: "abc123", state: "running", pid: 42, lastUpdate: 1000 });
	});

	it("falls back to the directory name when runId is missing", () => {
		expect(parseRunStatus(JSON.stringify({ state: "queued" }), "dir-name")).toEqual({
			runId: "dir-name",
			state: "queued",
			pid: undefined,
			lastUpdate: undefined,
		});
	});

	it("returns null for malformed JSON instead of throwing", () => {
		expect(parseRunStatus('{"state": "running", ', "dir-name")).toBeNull();
	});

	it("returns null when the payload is not an object or has no state", () => {
		expect(parseRunStatus("[]", "dir-name")).toBeNull();
		expect(parseRunStatus('"running"', "dir-name")).toBeNull();
		expect(parseRunStatus(JSON.stringify({ runId: "abc123" }), "dir-name")).toBeNull();
	});

	it("ignores a non-positive pid", () => {
		expect(parseRunStatus(JSON.stringify({ state: "running", pid: 0 }), "dir-name")?.pid).toBeUndefined();
	});
});

describe("isOutstandingState", () => {
	it("counts the states the pi-subagents drain waits on", () => {
		expect(isOutstandingState("queued")).toBe(true);
		expect(isOutstandingState("running")).toBe(true);
	});

	it("excludes terminal states and paused runs", () => {
		// `paused` is a legitimate resumable outcome the drain does not wait on:
		// reporting it would point the reader at the wrong run.
		for (const state of ["complete", "failed", "cancelled", "paused"]) {
			expect(isOutstandingState(state)).toBe(false);
		}
	});
});

describe("formatOutstandingRuns", () => {
	it("says none when nothing is outstanding", () => {
		expect(formatOutstandingRuns([])).toBe("outstanding runs: none");
	});

	it("prints one parenthesised entry per run with a short id", () => {
		const runs: OutstandingRun[] = [
			{ runId: "d90c86c4-aaaa-bbbb", state: "running", pid: 123456, pidAlive: true, ageMs: 480000 },
			{ runId: "f2706143-cccc", state: "queued", pidAlive: undefined, ageMs: undefined },
		];
		expect(formatOutstandingRuns(runs)).toBe(
			"outstanding runs: 2 " +
				"(runId=d90c86c4 state=running pid=123456 pidAlive=true ageMs=480000) " +
				"(runId=f2706143 state=queued pid=none pidAlive=unknown ageMs=?)"
		);
	});

	it("keeps a dead pid distinct from a missing one", () => {
		const runs: OutstandingRun[] = [
			{ runId: "aaaaaaaa-1", state: "running", pid: 99, pidAlive: false, ageMs: 1000 },
		];
		expect(formatOutstandingRuns(runs)).toContain("pid=99 pidAlive=false ageMs=1000");
	});
});

describe("summarizeRunStore", () => {
	it("returns no runs for an empty store", () => {
		const dir = makeStore();
		expect(summarizeRunStore({ dir, pidAlive: () => true })).toEqual({ dir, runs: [] });
	});

	it("reports a running run with a live pid", () => {
		const dir = makeStore();
		writeRun(dir, "run-live", { runId: "run-live-id", state: "running", pid: 1234, lastUpdate: 1000 });
		const summary = summarizeRunStore({ dir, now: 3000, pidAlive: (pid) => pid === 1234 });
		expect(summary.runs).toEqual([
			{ runId: "run-live-id", state: "running", pid: 1234, pidAlive: true, ageMs: 2000 },
		]);
	});

	it("reports a running run whose pid is gone", () => {
		const dir = makeStore();
		writeRun(dir, "run-dead", { runId: "run-dead-id", state: "running", pid: 4321, lastUpdate: 1000 });
		const summary = summarizeRunStore({ dir, now: 2000, pidAlive: () => false });
		expect(summary.runs[0]?.pidAlive).toBe(false);
	});

	it("reports a queued run that never got a pid", () => {
		const dir = makeStore();
		writeRun(dir, "run-queued", { runId: "run-queued-id", state: "queued" });
		const summary = summarizeRunStore({ dir, now: 2000, pidAlive: () => true });
		expect(summary.runs).toEqual([
			{ runId: "run-queued-id", state: "queued", pid: undefined, pidAlive: undefined, ageMs: undefined },
		]);
	});

	it("skips malformed and missing status files without failing", () => {
		const dir = makeStore();
		writeRun(dir, "run-broken", '{"state": "running", ');
		writeRun(dir, "run-ok", { runId: "run-ok-id", state: "running", pid: 7, lastUpdate: 0 });
		mkdirSync(join(dir, "run-empty"), { recursive: true });
		const summary = summarizeRunStore({ dir, now: 0, pidAlive: () => true });
		expect(summary.runs.map((run) => run.runId)).toEqual(["run-ok-id"]);
	});

	it("excludes terminal and paused runs", () => {
		const dir = makeStore();
		writeRun(dir, "run-complete", { runId: "c", state: "complete", pid: 1 });
		writeRun(dir, "run-paused", { runId: "p", state: "paused", pid: 2 });
		expect(summarizeRunStore({ dir, pidAlive: () => true }).runs).toEqual([]);
	});

	it("bounds how many run directories it reads", () => {
		const dir = makeStore();
		for (let index = 0; index < 5; index += 1) {
			writeRun(dir, `run-${index}`, { runId: `id-${index}`, state: "running", pid: 100 + index });
		}
		const summary = summarizeRunStore({ dir, maxRuns: 2, pidAlive: () => true });
		expect(summary.runs).toHaveLength(2);
	});

	it("reports the oldest run first, where the age is known", () => {
		const dir = makeStore();
		writeRun(dir, "run-new", { runId: "new", state: "running", pid: 1, lastUpdate: 900 });
		writeRun(dir, "run-old", { runId: "old", state: "running", pid: 2, lastUpdate: 100 });
		const summary = summarizeRunStore({ dir, now: 1000, pidAlive: () => true });
		expect(summary.runs.map((run) => run.runId)).toEqual(["old", "new"]);
	});

	it("returns an error instead of throwing when the store is unreadable", () => {
		const missing = join(tmpdir(), `pi-discord-run-store-missing-${Date.now()}`);
		const summary = summarizeRunStore({ dir: missing });
		expect(summary.runs).toEqual([]);
		expect(summary.error).toContain("cannot read");
	});
});

// ============================================================================
// Progressing work: the input the watchdog must not deadlock on
// ============================================================================

describe("isProgressingRun", () => {
	it("trusts a live pid over any timestamp", () => {
		// A long-running child writes its status rarely; the process is the evidence.
		expect(isProgressingRun(run({ pid: 99, pidAlive: true, ageMs: 60 * 60_000 }))).toBe(true);
	});

	it("treats a dead pid with a recent status write as progressing", () => {
		expect(isProgressingRun(run({ pid: 99, pidAlive: false, ageMs: 10_000 }))).toBe(true);
	});

	it("treats a dead pid with an old status write as finished", () => {
		expect(isProgressingRun(run({ pid: 99, pidAlive: false, ageMs: 10 * 60_000 }))).toBe(false);
	});

	it("treats a queued run with no pid and an old status as finished", () => {
		expect(isProgressingRun(run({ state: "queued", ageMs: 10 * 60_000 }))).toBe(false);
	});

	it("assumes work when there is no timestamp to say otherwise", () => {
		// No pid and no lastUpdate: nothing says it stopped, so hands off.
		expect(isProgressingRun(run({ state: "queued" }))).toBe(true);
	});

	it("honours a custom recent window", () => {
		expect(isProgressingRun(run({ pidAlive: false, ageMs: 5_000 }), 1_000)).toBe(false);
	});
});

describe("hasProgressingAsyncWork", () => {
	const NOW = 10_000_000;

	it("ignores a finished run the gate still counts (the wedge itself)", () => {
		// Live incident shape: run 853692be completed, its result was never delivered,
		// so the gate kept it. The store has no entry for it -> not work.
		const pending = [{ id: "853692be-1111-2222-3333-444455556666", startedAt: NOW - 30 * 60_000 }];
		expect(hasProgressingAsyncWork(pending, summary([]), { now: NOW })).toBe(false);
	});

	it("reports a run that is still running with a live child", () => {
		const pending = [{ id: "aaaa1111-0000-0000-0000-000000000000", startedAt: NOW - 60_000 }];
		const store = summary([run({ runId: pending[0]!.id, pid: 42, pidAlive: true, ageMs: 60_000 })]);
		expect(hasProgressingAsyncWork(pending, store, { now: NOW })).toBe(true);
	});

	it("reports a run with a dead pid whose status was just written", () => {
		const pending = [{ id: "bbbb2222-0000-0000-0000-000000000000", startedAt: NOW - 60_000 }];
		const store = summary([run({ runId: pending[0]!.id, pid: 42, pidAlive: false, ageMs: 10_000 })]);
		expect(hasProgressingAsyncWork(pending, store, { now: NOW })).toBe(true);
	});

	it("ignores a run with a dead pid and a stale status", () => {
		const pending = [{ id: "cccc3333-0000-0000-0000-000000000000", startedAt: NOW - 60 * 60_000 }];
		const store = summary([run({ runId: pending[0]!.id, pid: 42, pidAlive: false, ageMs: 30 * 60_000 })]);
		expect(hasProgressingAsyncWork(pending, store, { now: NOW })).toBe(false);
	});

	it("treats a just-started run with no status yet as work", () => {
		// The gap between the gate's async-started event and the first status write.
		const pending = [{ id: "dddd4444-0000-0000-0000-000000000000", startedAt: NOW - 5_000 }];
		expect(hasProgressingAsyncWork(pending, summary([]), { now: NOW })).toBe(true);
	});

	it("matches a counted id against the store by short id", () => {
		const pending = [{ id: "eeee5555-0000-0000-0000-000000000000", startedAt: NOW - 60_000 }];
		const store = summary([run({ runId: "eeee5555-ffff-ffff-ffff-ffffffffffff", pid: 7, pidAlive: true })]);
		expect(hasProgressingAsyncWork(pending, store, { now: NOW })).toBe(true);
	});

	it("fails closed when the store cannot be read", () => {
		// An unverifiable input must never be the reason a live turn is destroyed.
		const pending = [{ id: "ffff6666-0000-0000-0000-000000000000", startedAt: NOW - 60 * 60_000 }];
		expect(hasProgressingAsyncWork(pending, summary([], "cannot read /store: ENOENT"), { now: NOW })).toBe(
			true
		);
	});

	it("is false when the gate counts nothing", () => {
		expect(hasProgressingAsyncWork([], summary([run({ pid: 1, pidAlive: true })]), { now: NOW })).toBe(false);
	});

	it("uses the exported recent window by default", () => {
		const pending = [{ id: "99998888-0000-0000-0000-000000000000", startedAt: NOW - 60_000 }];
		const aging = summary([run({ runId: pending[0]!.id, pid: 42, pidAlive: false, ageMs: RUN_PROGRESS_RECENT_MS + 1 })]);
		expect(hasProgressingAsyncWork(pending, aging, { now: NOW })).toBe(false);
	});
});

/**
 * Snapshot of outstanding subagent runs, for watchdog diagnostics.
 *
 * When the watchdog decides to rebuild a session it names *why* only in terms of
 * the parent: "idle 45 minutes", "post-completion stall 120s after final
 * message". That is not enough to act on. The pi-subagents drain that keeps a
 * run active waits on async-run status files, and a single run whose status was
 * never terminalised pins it indefinitely — but nothing in the bot's own state
 * says which run that is.
 *
 * This module reads that store directly and renders one line per outstanding
 * run, so the journal shows the culprit (`runId`, `state`, `pid`, `pidAlive`,
 * `ageMs`) instead of requiring a live debugger session.
 *
 * Store layout is mirrored from the pi-subagents package, not guessed:
 * `TEMP_ROOT_DIR` is `$PI_SUBAGENTS_TEMP_ROOT` when set, else
 * `os.tmpdir()/pi-subagents-<scope>` where the scope is `uid-<uid>` (see
 * `pi-subagents/src/shared/types.js:60-107`), and `ASYNC_DIR` is
 * `<tempRoot>/async-subagent-runs`.
 *
 * Diagnostics must never be able to break the recovery they describe: every
 * filesystem failure is reported in the summary instead of thrown.
 */

import { readdirSync, readFileSync } from "fs";
import { tmpdir, userInfo } from "os";
import { join, resolve } from "path";
import { isProcessAlive } from "./child-process-probe.ts";

/** Bound on how many runs are read and printed: a diagnostic line, not a report. */
export const MAX_SUMMARIZED_RUNS = 20;

/**
 * States the pi-subagents drain is waiting for (`listAsyncRuns({states:["queued",
 * "running"]})`). `paused` is deliberately excluded: it is a resumable outcome
 * that the drain does not wait on, so reporting it as outstanding would point at
 * the wrong run.
 */
const OUTSTANDING_STATES: ReadonlySet<string> = new Set(["queued", "running"]);

/** Prefix length for a run id: long enough to find the run dir, short enough to read. */
const SHORT_RUN_ID_LENGTH = 8;

/** The subset of a run's `status.json` worth printing. */
export interface RunStatusRecord {
	runId: string;
	state: string;
	/** Runner pid as recorded at status-write time; absent while still queuing. */
	pid?: number;
	/** Epoch ms of the last status write. */
	lastUpdate?: number;
}

/** An outstanding run as rendered in the diagnostic line. */
export interface OutstandingRun {
	runId: string;
	state: string;
	pid?: number;
	/** Undefined when the run has no pid yet, so no liveness answer exists. */
	pidAlive?: boolean;
	/** Undefined when `status.json` carried no usable `lastUpdate`. */
	ageMs?: number;
}

export interface RunStoreSummary {
	/** Directory the snapshot was taken from, or undefined when unresolvable. */
	dir?: string;
	runs: OutstandingRun[];
	/** Set when the store could not be resolved or read; `runs` is then empty. */
	error?: string;
}

interface SummarizeOptions {
	dir?: string | undefined;
	now?: number;
	maxRuns?: number;
	/** Injected so tests can decide liveness without real pids. */
	pidAlive?: (pid: number) => boolean;
}

/**
 * Directory containing the async-run status files.
 *
 * Mirrors the package's own scope resolution so the bot reads the same store its
 * subagent extension writes to: a different scope would silently report "none"
 * while a run is outstanding.
 */
export function resolveAsyncRunStoreDir(
	env: NodeJS.ProcessEnv = process.env,
	tempRoot: string = tmpdir()
): string {
	const configuredRoot = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	const root = configuredRoot
		? resolve(configuredRoot)
		: join(tempRoot, `pi-subagents-${resolveTempScopeId(env)}`);
	return join(root, "async-subagent-runs");
}

function resolveTempScopeId(env: NodeJS.ProcessEnv): string {
	if (typeof process.getuid === "function") return `uid-${process.getuid()}`;
	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = env[key];
		if (value) return `user-${sanitizeSegment(value)}`;
	}
	try {
		const username = userInfo?.().username;
		if (username) return `user-${sanitizeSegment(username)}`;
	} catch {
		// Fall through to home-directory scoping.
	}
	const homedir = env.USERPROFILE ?? env.HOME;
	if (homedir) return `home-${sanitizeSegment(homedir)}`;
	return "shared";
}

function sanitizeSegment(value: string): string {
	const sanitized = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

/**
 * Parse one `status.json`.
 *
 * Returns null for anything unusable (truncated write, non-object, no state)
 * rather than throwing: a partially written status file is exactly the kind of
 * run this diagnostic should still be able to describe by its fallback id.
 */
export function parseRunStatus(json: string, fallbackRunId: string): RunStatusRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	if (typeof record.state !== "string") return null;
	return {
		runId: typeof record.runId === "string" && record.runId ? record.runId : fallbackRunId,
		state: record.state,
		pid: typeof record.pid === "number" && record.pid > 0 ? record.pid : undefined,
		lastUpdate: typeof record.lastUpdate === "number" ? record.lastUpdate : undefined,
	};
}

/** States the drain is still waiting for; everything else is terminal or paused. */
export function isOutstandingState(state: string): boolean {
	return OUTSTANDING_STATES.has(state);
}

/**
 * One compact line, `none` when nothing is outstanding.
 *
 * Short ids and fixed key order so a journal reader can diff two lines by eye.
 */
export function formatOutstandingRuns(runs: readonly OutstandingRun[]): string {
	if (runs.length === 0) return "outstanding runs: none";
	const rendered = runs.map((run) => {
		const id = run.runId.slice(0, SHORT_RUN_ID_LENGTH);
		const pid = run.pid === undefined ? "none" : String(run.pid);
		const alive = run.pidAlive === undefined ? "unknown" : String(run.pidAlive);
		const age = run.ageMs === undefined ? "?" : String(run.ageMs);
		return `(runId=${id} state=${run.state} pid=${pid} pidAlive=${alive} ageMs=${age})`;
	});
	return `outstanding runs: ${runs.length} ${rendered.join(" ")}`;
}

/**
 * Read the store and report the runs the drain may be waiting for.
 *
 * Never throws: an unreadable store yields `error` with no runs, which the caller
 * logs once and then ignores.
 */
export function summarizeRunStore(options: SummarizeOptions = {}): RunStoreSummary {
	const dir = options.dir ?? resolveAsyncRunStoreDir();
	const now = options.now ?? Date.now();
	const maxRuns = options.maxRuns ?? MAX_SUMMARIZED_RUNS;
	const pidAlive = options.pidAlive ?? isProcessAlive;

	let entries: string[];
	try {
		entries = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch (err) {
		return { dir, runs: [], error: `cannot read ${dir}: ${errorMessage(err)}` };
	}

	const runs: OutstandingRun[] = [];
	for (const entry of entries.slice(0, maxRuns)) {
		let record: RunStatusRecord | null;
		try {
			record = parseRunStatus(readFileSync(join(dir, entry, "status.json"), "utf8"), entry);
		} catch {
			// Missing or half-written status.json: nothing to report for this run.
			continue;
		}
		if (!record || !isOutstandingState(record.state)) continue;
		runs.push({
			runId: record.runId,
			state: record.state,
			pid: record.pid,
			pidAlive: record.pid === undefined ? undefined : pidAlive(record.pid),
			ageMs: record.lastUpdate === undefined ? undefined : Math.max(0, now - record.lastUpdate),
		});
	}

	// Oldest first: the run that has been "running" longest is the suspect.
	runs.sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1));
	return { dir, runs };
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

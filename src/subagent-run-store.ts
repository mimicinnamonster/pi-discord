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

/**
 * How recently a run's status must have been written for that alone to count as
 * progress.
 *
 * Covers the gap between a runner starting and its first status write, plus one
 * status-write interval, without ever spanning a plausible pause in a live run.
 */
export const RUN_PROGRESS_RECENT_MS = 90_000;

/**
 * Upper bound on a `pidAlive` hold where the pid's state cannot be classified.
 *
 * On Linux a live pid is direct evidence of work and needs no cap: a zombie is
 * classified dead, so `pidAlive === true` means a running process. The cap exists
 * only for platforms with no procfs, where `true` degrades to "pid allocated" and
 * an unreaped zombie would otherwise pin a channel forever.
 *
 * Thirty minutes is well past the longest plausible runner, so tripping it means
 * the liveness answer is stale rather than that the work is slow.
 */
export const RUN_MAX_HOLD_MS = 30 * 60_000;

/** The subset of a run's `status.json` worth printing. */
export interface RunStatusRecord {
	runId: string;
	state: string;
	/** Runner pid as recorded at status-write time; absent while still queuing. */
	pid?: number;
	/** Epoch ms of the last status write. */
	lastUpdate?: number;
	/** Epoch ms the run terminalised, when the runner recorded it. */
	endedAt?: number;
	/**
	 * Agent session file the run belongs to.
	 *
	 * For this bot that is the channel transcript, which is what lets the orphan
	 * watchdog attribute a finished run to the channel it should have woken.
	 */
	sessionId?: string;
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
	/**
	 * Session file the run belongs to, when the runner recorded one.
	 *
	 * Not printed in the diagnostic line, but carried because it is the only field
	 * that attributes a run to a channel — the watchdog needs it to decide whether
	 * a live run is *this* channel's work or another channel's.
	 */
	sessionId?: string;
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
		endedAt: typeof record.endedAt === "number" ? record.endedAt : undefined,
		sessionId: typeof record.sessionId === "string" && record.sessionId ? record.sessionId : undefined,
	};
}

/** States the drain is still waiting for; everything else is terminal or paused. */
export function isOutstandingState(state: string): boolean {
	return OUTSTANDING_STATES.has(state);
}

/** One async run the channel's subagent gate still counts, with its start time. */
export interface PendingAsyncRunRef {
	id: string;
	startedAt: number;
}

/**
 * Which channel a liveness question is about, and how to attribute a run to one.
 *
 * `status.json.sessionId` is the only field in the store that ties a run to a
 * conversation — for this bot it is the channel transcript the run was launched
 * from — so it is what makes the store usable as an authoritative source rather
 * than a second-hand view filtered by the gate's in-memory tally.
 */
export interface AsyncWorkScope {
	/** Channel being asked about: a run attributed elsewhere must not suppress it. */
	channelId: string;
	/** Channel a run belongs to, or undefined when its `sessionId` cannot be mapped. */
	channelIdForRun: (run: OutstandingRun) => string | undefined;
	/**
	 * Called for a progressing run that cannot be attributed to any channel.
	 *
	 * Such a run is released rather than credited — one we cannot place must not
	 * hold an arbitrary channel open — but the rate is worth seeing, so callers log
	 * it here rather than silently swallowing it.
	 */
	onUnattributedRun?: ((run: OutstandingRun) => void) | undefined;
	/**
	 * Called for a run the channel's tally counts whose `sessionId` maps to no
	 * channel.
	 *
	 * Deliberately separate from `onUnattributedRun`: this one *is* credited (see
	 * the note in the tally pass), so it means "credited with weaker attribution",
	 * not "not credited". Callers keep their own throttle and counter for it so the
	 * two rates can be told apart in the journal.
	 */
	onCountedRunWithoutOwner?: ((run: OutstandingRun) => void) | undefined;
}

/** How a single run's liveness is judged beyond its status age. */
export interface ProgressOptions {
	/**
	 * Whether the pid's state could be classified as live vs zombie.
	 *
	 * Defaults to true on Linux, where `/proc` answers it. False means `pidAlive`
	 * only says "pid allocated", so the hold is capped at `RUN_MAX_HOLD_MS`.
	 */
	stateClassifiable?: boolean | undefined;
	/** Called when `RUN_MAX_HOLD_MS` ends a hold that had no classified state. */
	onHoldCapped?: ((run: OutstandingRun) => void) | undefined;
}

/**
 * Whether a single outstanding run is still doing something.
 *
 * Ordering matters. A live pid is direct evidence of work and is trusted over
 * any timestamp. With no pid and no timestamp (a run that has not written a
 * status yet) there is nothing to say it stopped, so it is assumed to be
 * working — the safe direction for a watchdog that must never destroy a live
 * turn.
 *
 * The live-pid branch is unbounded only where the state actually classifies: on
 * Linux a `Z` reads dead, so `pidAlive === true` is a running process and no age
 * cap may be applied to it. Where the platform cannot classify (no procfs), a
 * zombie reads alive indefinitely, so that hold is capped at `RUN_MAX_HOLD_MS`.
 */
export function isProgressingRun(
	run: OutstandingRun,
	recentMs: number = RUN_PROGRESS_RECENT_MS,
	options: ProgressOptions = {}
): boolean {
	if (run.pidAlive === true) {
		if (options.stateClassifiable ?? process.platform === "linux") return true;
		// Unclassified: "pid allocated" cannot tell a live runner from an unreaped
		// zombie, so the hold needs an upper bound of its own.
		if (run.ageMs !== undefined && run.ageMs > RUN_MAX_HOLD_MS) {
			options.onHoldCapped?.(run);
			return false;
		}
		return true;
	}
	if (run.ageMs === undefined) return true;
	return run.ageMs <= recentMs;
}

/**
 * Whether any async run is genuinely progressing for the channel in scope.
 *
 * The gate's tally is event-driven and its completion event is delivered *through
 * the session* — so the exact wedge that keeps a run from settling also keeps
 * that run in the tally: delivery needs an idle session, the session is not idle
 * because the settle path is blocked, and the settle path is blocked by a drain
 * waiting for that delivery. Reading the tally as "work in progress" therefore
 * deadlocks the recovery that would break the loop.
 *
 * The run store is the ground truth, and with a `scope` it is authoritative: the
 * tally is only a fast-path hint, never the sole veto. That distinction matters
 * because `pendingAsyncRuns()` is per-session state, so a session replacement
 * drops the accounting for runs that are still alive — the case that produced
 * "outstanding runs: none" in the journal immediately before a teardown. A run
 * the gate has forgotten is still work while its process lives, and only the
 * store can say so.
 *
 * A run absent from the store's outstanding set has terminalised (complete/failed
 * or paused) or never wrote a status; in either case it is not work, unless it
 * started so recently that its status may simply not exist yet. That is what
 * bounds the suppression: a finished run cannot hold a channel open beyond one
 * status interval. Fails closed (reports work) when the store could not be read,
 * because an unverifiable diagnostic must never be the reason a live turn is torn
 * down.
 *
 * Without a `scope` there is no way to attribute store runs to a channel, so
 * unscoped callers keep the tally-only behaviour — including, as before, the
 * empty tally early exit.
 */
export function hasProgressingAsyncWork(
	pendingRuns: readonly PendingAsyncRunRef[],
	summary: RunStoreSummary,
	options: {
		now?: number;
		recentMs?: number;
		scope?: AsyncWorkScope;
		stateClassifiable?: boolean | undefined;
		onHoldCapped?: ((run: OutstandingRun) => void) | undefined;
	} = {}
): boolean {
	const scope = options.scope;
	if (scope === undefined && pendingRuns.length === 0) return false;
	if (summary.error) return true;

	const now = options.now ?? Date.now();
	const recentMs = options.recentMs ?? RUN_PROGRESS_RECENT_MS;
	const progress: ProgressOptions = {
		stateClassifiable: options.stateClassifiable,
		onHoldCapped: options.onHoldCapped,
	};
	const outstanding = new Map(summary.runs.map((run) => [shortRunId(run.runId), run]));
	const counted = new Set<string>();

	for (const pending of pendingRuns) {
		const key = shortRunId(pending.id);
		counted.add(key);
		const record = outstanding.get(key);
		if (record === undefined) {
			// Not outstanding on disk: terminalised, or still too young to have written
			// a status. Only the latter is work.
			if (now - pending.startedAt < recentMs) return true;
			continue;
		}
		if (scope !== undefined) {
			const owner = scope.channelIdForRun(record);
			// Ownership of a *counted* run is not decided by the sessionId mapping.
			// The tally is per-DiscordSession state, so membership means this channel's
			// own gate recorded the start event: it is stronger ownership evidence than
			// `sessionId` -> transcript, which is a path this bot parses and that older
			// status files do not always carry. Crediting on the tally is therefore the
			// conservative direction — releasing a counted run because its sessionId is
			// missing or unparsable is exactly the teardown bug this pass exists to
			// prevent, for the runs we can least afford to drop. Only a *positive*
			// attribution to another channel overrides it.
			//
			// The asymmetry with the authoritative pass below is deliberate: there, the
			// tally says nothing about the run, so an unmappable sessionId leaves no
			// ownership evidence at all and the channel is released. The two branches are
			// not a duplicated decision that drifted apart — do not "unify" them on
			// release.
			if (owner !== undefined && owner !== scope.channelId) continue;
			if (owner === undefined && isProgressingRun(record, recentMs, progress)) {
				scope.onCountedRunWithoutOwner?.(record);
				return true;
			}
		}
		if (isProgressingRun(record, recentMs, progress)) return true;
	}

	if (scope === undefined) return false;

	// Authoritative pass: runs the tally no longer counts, attributed by transcript.
	for (const run of summary.runs) {
		if (counted.has(shortRunId(run.runId))) continue;
		if (!isProgressingRun(run, recentMs, progress)) continue;
		const owner = scope.channelIdForRun(run);
		if (owner === scope.channelId) return true;
		if (owner === undefined) scope.onUnattributedRun?.(run);
	}
	return false;
}

function shortRunId(runId: string): string {
	return runId.slice(0, SHORT_RUN_ID_LENGTH);
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
			sessionId: record.sessionId,
		});
	}

	// Oldest first: the run that has been "running" longest is the suspect.
	runs.sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1));
	return { dir, runs };
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Every run status the store could parse, outstanding or not. */
export interface RunStatusSnapshot {
	dir?: string;
	runs: RunStatusRecord[];
	/** Set when the store could not be read; `runs` is then empty. */
	error?: string;
}

export interface ListRunStatusesOptions {
	dir?: string;
	maxRuns?: number;
}

/**
 * Read every parseable `status.json` in the async-run store.
 *
 * The diagnostic snapshot above deliberately keeps only outstanding runs; the
 * orphan-completion watchdog needs the opposite half — the runs that already
 * finished — to tell a completion that was announced from one that was silently
 * dropped. Reading is shared so both views describe the same store.
 *
 * Never throws: an unreadable store is reported, not propagated.
 */
export function listRunStatuses(options: ListRunStatusesOptions = {}): RunStatusSnapshot {
	const dir = options.dir ?? resolveAsyncRunStoreDir();
	const maxRuns = options.maxRuns ?? MAX_SUMMARIZED_RUNS;

	let entries: string[];
	try {
		entries = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch (err) {
		return { dir, runs: [], error: `cannot read ${dir}: ${errorMessage(err)}` };
	}

	const runs: RunStatusRecord[] = [];
	for (const entry of entries.slice(0, maxRuns)) {
		try {
			const record = parseRunStatus(readFileSync(join(dir, entry, "status.json"), "utf8"), entry);
			if (record) runs.push(record);
		} catch {
			// Missing or half-written status.json: nothing to report for this run.
		}
	}
	return { dir, runs };
}

/**
 * Directory holding delivered-result payloads, sibling to the run directory.
 *
 * pi-subagents writes `<tempRoot>/async-subagent-results/<runId>-<ts>.json`, so
 * the same temp-root/scope resolution applies.
 */
export function resolveAsyncResultStoreDir(
	env: NodeJS.ProcessEnv = process.env,
	tempRoot: string = tmpdir()
): string {
	const configuredRoot = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	const root = configuredRoot
		? resolve(configuredRoot)
		: join(tempRoot, `pi-subagents-${resolveTempScopeId(env)}`);
	return join(root, "async-subagent-results");
}

/**
 * Path of the result payload for a run, or undefined when it produced none.
 *
 * A run can terminalise without ever writing a result (observed live: run
 * `a68f7721` completed and left nothing), which is exactly the case the wake
 * prompt must report as unavailable rather than silently imply success.
 */
export function findResultPayload(runId: string, options: { dir?: string } = {}): string | undefined {
	const dir = options.dir ?? resolveAsyncResultStoreDir();
	const shortId = shortRunId(runId);
	try {
		const match = readdirSync(dir)
			.filter((name) => name.startsWith(shortId))
			.sort()
			.at(-1);
		return match ? join(dir, match) : undefined;
	} catch {
		return undefined;
	}
}

// Per-channel "max 1 subagent at a time" gate for the pi-discord bot.
//
// NOTE: the gate is currently DISABLED — MAX_CONCURRENT is Infinity, so the
// gate never blocks and any number of subagents may run in a channel at the
// same time. The structure below is kept intact so it can be re-enabled by
// lowering MAX_CONCURRENT again.
//
// Each Discord channel session owns one SubagentGate instance (see
// session-store.ts, createSubagentGateExtension(channelId)), so the limit
// applies per channel: a channel can only ever have one subagent in flight,
// while different channels may run subagents concurrently.
//
// The counter is driven from session-store.ts:
//  - sync subagents: a `tool_call` hook acquires the slot (recording the
//    toolCallId) when the subagent tool is invoked and the slot is free;
//    a `tool_result` hook releases it when that exact call finishes.
//    Blocked invocations never acquire, so even if the SDK emitted a
//    tool_result for a blocked call it would not release the slot.
//  - async subagents: pi-subagents emits lifecycle events on the channel's
//    OWN pi.events bus; this gate tracks them so an async run that outlives
//    its parent turn still holds the slot until it truly completes.
//
// Event-name strings MUST stay in sync with pi-subagents:
//   pi-subagents/src/shared/types.ts:2297-2298
export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

// Infinity disables the gate entirely: holderCount() can never reach it, so
// acquireSync() always succeeds and isGateHeld() is always false.
const MAX_CONCURRENT = Infinity;

/**
 * How long an async run may stay pending before it is treated as orphaned.
 *
 * Without this, a run whose completion event never arrives (crash, killed child
 * process, empty run directory) pins `pendingAsyncWork()` above zero forever.
 * Every incoming message is then queued "behind the drain" instead of being
 * answered — one channel stayed wedged this way for ~20 hours.
 */
export const STALE_ASYNC_WORK_TIMEOUT_MS = 10 * 60_000;

interface AsyncRun {
	id: string;
	startedAt: number;
}

/** One async run the gate still counts, for cross-checking against the run store. */
export interface PendingAsyncRun {
	id: string;
	startedAt: number;
}

export interface SubagentGate {
	isGateHeld(): boolean;
	/**
	 * Number of async (background) subagent runs started in this channel that
	 * have not reported completion yet. Sync in-flight tool calls are excluded:
	 * they only exist mid-turn, while this counter is what can outlive the
	 * main turn (and therefore overlap the agent_end drain in src/index.ts).
	 *
	 * NOT a liveness signal by itself: this tally is released only by
	 * pi-subagents' async-complete event, which is delivered through the session,
	 * so a wedged session keeps finished runs here forever. Watchdog gates must
	 * use pendingAsyncRuns() plus the on-disk run store instead (see
	 * hasProgressingAsyncWork in src/subagent-run-store.ts).
	 */
	pendingAsyncWork(): number;
	/**
	 * The async runs this gate still counts, with their start time.
	 *
	 * The caller resolves each against the run store, which is the ground truth on
	 * whether the run is still progressing.
	 */
	pendingAsyncRuns(): PendingAsyncRun[];
	/**
	 * Sync (in-flight) subagent tool calls in this channel. A sync child emits no
	 * session event for its whole duration, so its silence must not look like a
	 * wedged run — which is why this is the half of the gate the watchdog trusts
	 * unconditionally: a live child process is an unmistakable liveness signal.
	 */
	hasSyncWork(): boolean;
	/**
	 * Any subagent work in this channel, async runs *and* sync in-flight tool
	 * calls. Answers "is anything possibly running", not "is it progressing".
	 */
	hasActiveWork(): boolean;
	acquireSync(toolCallId: string): boolean;
	releaseSync(toolCallId: string): void;
	onAsyncStarted(payload: unknown): void;
	onAsyncComplete(payload: unknown): void;
	/**
	 * Release async runs older than `maxAgeMs` and return their ids. Callers
	 * replay any messages parked behind them.
	 */
	sweepStaleAsync(maxAgeMs?: number): string[];
	blockReason(): string;
	getStatus(): string;
}

export interface SubagentGateOptions {
	/** Injectable clock for tests. */
	now?: () => number;
}

function readPayloadId(payload: unknown): string | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const record = payload as Record<string, unknown>;
	for (const key of ["runId", "id", "agentId", "subagentId"]) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

export function createSubagentGate(options: SubagentGateOptions = {}): SubagentGate {
	const now = options.now ?? Date.now;
	// Tool-call ids of sync subagent invocations that were admitted and are
	// still in flight. Async runs and sync calls share the same slot counter.
	const activeSyncCalls = new Set<string>();
	// Async runs keyed by run id (payload id when pi-subagents provides one,
	// otherwise a synthetic id). Insertion order is start order.
	const asyncRuns = new Map<string, AsyncRun>();
	let syntheticRunCounter = 0;

	const holderCount = () => activeSyncCalls.size + asyncRuns.size;

	return {
		isGateHeld() {
			return holderCount() >= MAX_CONCURRENT;
		},

		pendingAsyncWork(): number {
			return asyncRuns.size;
		},

		pendingAsyncRuns(): PendingAsyncRun[] {
			return [...asyncRuns.values()].map((run) => ({ id: run.id, startedAt: run.startedAt }));
		},

		hasSyncWork(): boolean {
			return activeSyncCalls.size > 0;
		},

		hasActiveWork(): boolean {
			return holderCount() > 0;
		},

		acquireSync(toolCallId: string): boolean {
			if (holderCount() >= MAX_CONCURRENT) {
				return false;
			}
			activeSyncCalls.add(toolCallId);
			return true;
		},

		releaseSync(toolCallId: string): void {
			if (!activeSyncCalls.delete(toolCallId)) {
				console.log(`[subagent-gate] releaseSync(${toolCallId}) had nothing acquired — ignored`);
			}
		},

		onAsyncStarted(payload: unknown): void {
			if (holderCount() >= MAX_CONCURRENT) {
				console.log(`[subagent-gate] async started while gate held (${holderCount()} holders)`);
			}
			syntheticRunCounter++;
			const id = readPayloadId(payload) ?? `async-run-${syntheticRunCounter}`;
			asyncRuns.set(id, { id, startedAt: now() });
		},

		onAsyncComplete(payload: unknown): void {
			const status =
				typeof payload === "object" && payload !== null && typeof (payload as { status?: unknown }).status === "string"
					? (payload as { status: string }).status
					: "unknown";
			if (status !== "completed") {
				console.log(`[subagent-gate] async subagent completed with status: ${status}`);
			}
			const id = readPayloadId(payload);
			if (id !== undefined) {
				// An id that is no longer tracked means a duplicate/unknown completion:
				// never fall through to releasing a different run on its behalf.
				if (!asyncRuns.delete(id)) {
					console.log(`[subagent-gate] async-complete for unknown run ${id} — ignored`);
				}
				return;
			}
			// No id to match on: release the oldest run still pending.
			const oldest = asyncRuns.keys().next();
			if (!oldest.done) {
				asyncRuns.delete(oldest.value);
			} else {
				console.log("[subagent-gate] async-complete with nothing held — ignored");
			}
		},

		sweepStaleAsync(maxAgeMs: number = STALE_ASYNC_WORK_TIMEOUT_MS): string[] {
			const cutoff = now() - maxAgeMs;
			const released: string[] = [];
			for (const [id, run] of asyncRuns) {
				if (run.startedAt <= cutoff) {
					asyncRuns.delete(id);
					released.push(id);
				}
			}
			for (const id of released) {
				console.log(
					`[subagent-gate] Stale async work ${id} timed out after ${Math.round(maxAgeMs / 1000)}s — releasing gate`
				);
			}
			return released;
		},

		blockReason() {
			return "No limit on concurrent subagents in this channel (gate disabled).";
		},

		getStatus() {
			return `subagent gate: ${holderCount()} holder(s), ${holderCount() >= MAX_CONCURRENT ? "busy (gated)" : "free"}`;
		},
	};
}

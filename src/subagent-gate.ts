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

export interface SubagentGate {
	isGateHeld(): boolean;
	/**
	 * Number of async (background) subagent runs started in this channel that
	 * have not reported completion yet. Sync in-flight tool calls are excluded:
	 * they only exist mid-turn, while this counter is what can outlive the
	 * main turn (and therefore overlap the agent_end drain in src/index.ts).
	 */
	pendingAsyncWork(): number;
	acquireSync(toolCallId: string): boolean;
	releaseSync(toolCallId: string): void;
	onAsyncStarted(payload: unknown): void;
	onAsyncComplete(payload: unknown): void;
	blockReason(): string;
	getStatus(): string;
}

export function createSubagentGate(): SubagentGate {
	// Tool-call ids of sync subagent invocations that were admitted and are
	// still in flight. Async runs and sync calls share the same slot counter.
	const activeSyncCalls = new Set<string>();
	let asyncHolders = 0;

	const holderCount = () => activeSyncCalls.size + asyncHolders;

	return {
		isGateHeld() {
			return holderCount() >= MAX_CONCURRENT;
		},

		pendingAsyncWork(): number {
			return asyncHolders;
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

		onAsyncStarted(_payload: unknown): void {
			if (holderCount() >= MAX_CONCURRENT) {
				console.log(`[subagent-gate] async started while gate held (${holderCount()} holders)`);
			}
			asyncHolders++;
		},

		onAsyncComplete(payload: unknown): void {
			const status =
				typeof payload === "object" && payload !== null && typeof (payload as { status?: unknown }).status === "string"
					? (payload as { status: string }).status
					: "unknown";
			if (status !== "completed") {
				console.log(`[subagent-gate] async subagent completed with status: ${status}`);
			}
			if (asyncHolders > 0) {
				asyncHolders--;
			} else {
				console.log("[subagent-gate] async-complete with nothing held — ignored");
			}
		},

		blockReason() {
			return "No limit on concurrent subagents in this channel (gate disabled).";
		},

		getStatus() {
			return `subagent gate: ${holderCount()} holder(s), ${holderCount() >= MAX_CONCURRENT ? "busy (gated)" : "free"}`;
		},
	};
}
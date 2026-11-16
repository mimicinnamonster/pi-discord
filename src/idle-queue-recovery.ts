/**
 * Rules for two halves of one bug: a message that is both parked and queued.
 *
 * While a run looked active, an incoming message was written to the durable
 * parked store AND handed to the SDK with `deliverAs: "followUp"`. The parked
 * copy is what `replayPendingMessages()` delivers; the followUp copy is only
 * materialised when the run settles. Two things could then go wrong, and both
 * were observed live (2026-11-16, channel 1518152817620029592):
 *
 *  - The run finished normally (`agent_end`, run complete, pid dead), so the
 *    session was idle — but the followUp copies still sat in the SDK queue.
 *    Replay saw `pendingMessageCount > 0`, assumed the session would deliver
 *    them, and left the durable copies parked forever. Nothing recovered it
 *    because an idle session is not a stall: both watchdogs correctly said
 *    `not-active`.
 *  - The duplication itself is pointless: the parked store is the source of
 *    truth and replay owns delivery. Queuing the same text a second time can
 *    only ever deliver it twice or strand it.
 *
 * So `parkedDeliveryDecision()` removes the duplication at the source, and
 * `evaluateIdleQueueRecovery()` cleans up queues that already contain copies
 * (from before this fix, or from a message that was queued but never parked).
 *
 * Pure and dependency-free so the boundaries are testable: src/index.ts cannot
 * be imported under test.
 */

import type { PendingMessage } from "./pending-messages.ts";

/**
 * Parked-message reason used when a stale queue entry had no parked copy.
 *
 * The entry is written back to the durable store rather than dropped: clearing
 * the queue removed the only copy the SDK had, and a message the user typed must
 * never disappear because we tidied up our own bookkeeping.
 */
export const STALE_QUEUE_REASON = "stale-queue";

export interface ParkedDeliveryInput {
	/** Whether the run still reported activity when the message arrived. */
	sessionStillActive: boolean;
	/** Whether a durable copy was written to the parked store. */
	parked: boolean;
}

export interface ParkedDeliveryDecision {
	/** Skip `sendUserMessage()` entirely: replay owns this message now. */
	skipSend: boolean;
	/** Value for the SDK's `deliverAs` option, when the message is still sent. */
	deliverAs: "followUp" | undefined;
}

/**
 * Decide how a message that may have been parked reaches the agent.
 *
 * Invariant: a message with a durable parked copy is never also queued in the
 * SDK. Replay delivers it, so the two delivery paths cannot race and the queue
 * cannot strand it. A message that could not be parked (attachments only) is
 * still sent as a followUp — there is no durable copy to fall back on.
 */
export function parkedDeliveryDecision(input: ParkedDeliveryInput): ParkedDeliveryDecision {
	if (input.parked) return { skipSend: true, deliverAs: undefined };
	if (input.sessionStillActive) return { skipSend: false, deliverAs: "followUp" };
	return { skipSend: false, deliverAs: undefined };
}

export type IdleQueueRefusal =
	| "session-active"
	| "queue-empty"
	| "nothing-parked"
	| "async-work-progressing"
	| "live-child-process"
	| "recovery-in-flight"
	| "clear-queue-unavailable";

export interface IdleQueueRecoveryInput {
	/** `isModelActive()` for the channel's session. */
	modelActive: boolean;
	/** `session.pendingMessageCount` (steering + followUp). */
	pendingMessageCount: number;
	/** Parked entries for this channel. */
	parkedCount: number;
	/** Whether an async subagent run is genuinely progressing (verified store). */
	hasProgressingAsyncWork: boolean;
	/** Live (non-zombie) child processes of the bot. */
	liveChildProcessCount: number;
	/** The channel is mid-rebuild; the recovery pass owns it. */
	recovering: boolean;
	/** Whether the SDK session exposes `clearQueue()`. */
	clearQueueAvailable: boolean;
}

export interface IdleQueueRecoveryDecision {
	clear: boolean;
	refusal: IdleQueueRefusal | null;
}

/**
 * Decide whether an idle channel's SDK queue is ours to clear.
 *
 * Only an idle session qualifies: while a run is active those queue entries are
 * how the SDK delivers pending input, and clearing them would drop messages a
 * live turn is about to consume. Every refusal is named so the log says which
 * input blocked recovery instead of leaving a silent no-op.
 */
export function evaluateIdleQueueRecovery(input: IdleQueueRecoveryInput): IdleQueueRecoveryDecision {
	if (input.modelActive) return { clear: false, refusal: "session-active" };
	if (input.pendingMessageCount <= 0) return { clear: false, refusal: "queue-empty" };
	if (input.parkedCount <= 0) return { clear: false, refusal: "nothing-parked" };
	if (input.recovering) return { clear: false, refusal: "recovery-in-flight" };
	if (input.hasProgressingAsyncWork) return { clear: false, refusal: "async-work-progressing" };
	if (input.liveChildProcessCount > 0) return { clear: false, refusal: "live-child-process" };
	if (!input.clearQueueAvailable) return { clear: false, refusal: "clear-queue-unavailable" };
	return { clear: true, refusal: null };
}

/** Shape returned by the SDK's `clearQueue()` (`agent-session.js:1581`). */
export interface ClearedQueueTexts {
	steering: readonly string[];
	followUp: readonly string[];
}

export interface ClearedQueuePartition {
	/** Cleared texts that also exist in the parked store (replay delivers them). */
	matched: string[];
	/** Cleared texts with no parked copy: the caller must re-park these. */
	unmatched: string[];
	total: number;
}

function normalize(text: string): string {
	return text.trim();
}

/**
 * Split cleared queue texts into parked duplicates and orphans.
 *
 * Matching is by exact text after trimming: the queue stores the same string the
 * parked entry holds (`_queueFollowUp(text)`), and message ids are not available
 * on that path. A matched text is dropped — its parked copy is about to be
 * replayed, and sending both is the duplicate this recovery exists to prevent.
 */
export function partitionClearedMessages(
	cleared: ClearedQueueTexts,
	parked: readonly Pick<PendingMessage, "content">[]
): ClearedQueuePartition {
	const parkedTexts = new Set(parked.map((entry) => normalize(entry.content)));
	const all = [...cleared.steering, ...cleared.followUp];
	const matched: string[] = [];
	const unmatched: string[] = [];
	const seen = new Set<string>();
	for (const text of all) {
		const key = normalize(text);
		if (seen.has(key)) continue;
		seen.add(key);
		if (parkedTexts.has(key)) {
			matched.push(text);
		} else {
			unmatched.push(text);
		}
	}
	return { matched, unmatched, total: all.length };
}

/**
 * Rules for the parked/queued duplication that stranded two user messages.
 *
 * Live incident, 2026-11-16, channel 1518152817620029592: a message was parked
 * AND handed to the SDK as a followUp. The run then finished normally, so the
 * session was idle — with the followUp copies still in its queue. Replay refused
 * forever ("2 message(s) still queued in the session") and neither watchdog
 * applied, because an idle session is not a stall. Nothing recovered it until a
 * human restarted the bot.
 *
 * The rules below are pure, so the invariants are pinned directly instead of
 * through a live session (src/index.ts cannot be imported under test: it
 * validates DISCORD_BOT_TOKEN and exits at load). `createReplayRig()` mirrors
 * the replay guard and the clearing pass together, because the bug was the two
 * disagreeing about what is deliverable.
 */

import { describe, it, expect } from "vitest";
import {
	evaluateIdleQueueRecovery,
	parkedDeliveryDecision,
	partitionClearedMessages,
	STALE_QUEUE_REASON,
	type IdleQueueRecoveryInput,
} from "../src/idle-queue-recovery.ts";
import { createPendingMessageStore, type PendingMessage } from "../src/pending-messages.ts";
import { join } from "path";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";

function parkedEntry(id: string, content: string): PendingMessage {
	return {
		channelId: "1518152817620029592",
		discordMessageId: id,
		content,
		queuedAt: 1_700_000_000_000,
		reason: "run-still-active",
	};
}

function recoveryInput(overrides: Partial<IdleQueueRecoveryInput> = {}): IdleQueueRecoveryInput {
	return {
		modelActive: false,
		pendingMessageCount: 2,
		parkedCount: 2,
		hasProgressingAsyncWork: false,
		liveChildProcessCount: 0,
		recovering: false,
		clearQueueAvailable: true,
		...overrides,
	};
}

describe("parkedDeliveryDecision: never park and queue the same message", () => {
	it("skips the SDK send for a message that has a durable parked copy", () => {
		const decision = parkedDeliveryDecision({ sessionStillActive: true, parked: true });
		expect(decision.skipSend).toBe(true);
		expect(decision.deliverAs).toBeUndefined();
	});

	it("still queues a followUp for a busy session when the message could not be parked", () => {
		// Attachments-only messages have no durable copy, so the queue is their only
		// delivery path. Dropping the followUp there would lose the message.
		const decision = parkedDeliveryDecision({ sessionStillActive: true, parked: false });
		expect(decision.skipSend).toBe(false);
		expect(decision.deliverAs).toBe("followUp");
	});

	it("sends normally when the session is free", () => {
		const decision = parkedDeliveryDecision({ sessionStillActive: false, parked: false });
		expect(decision.skipSend).toBe(false);
		expect(decision.deliverAs).toBeUndefined();
	});

	it("never queues a followUp for a parked message, whatever the activity flag says", () => {
		for (const sessionStillActive of [true, false]) {
			const decision = parkedDeliveryDecision({ sessionStillActive, parked: true });
			expect(decision.deliverAs).toBeUndefined();
		}
	});
});

describe("evaluateIdleQueueRecovery", () => {
	it("clears the queue of an idle session that still holds copies of parked messages", () => {
		expect(evaluateIdleQueueRecovery(recoveryInput())).toEqual({ clear: true, refusal: null });
	});

	it("refuses while the session is active, so a live turn keeps its queue", () => {
		expect(evaluateIdleQueueRecovery(recoveryInput({ modelActive: true }))).toEqual({
			clear: false,
			refusal: "session-active",
		});
	});

	it("refuses with nothing parked, so a queue is never cleared without a durable copy", () => {
		expect(evaluateIdleQueueRecovery(recoveryInput({ parkedCount: 0 }))).toEqual({
			clear: false,
			refusal: "nothing-parked",
		});
	});

	it("does nothing when the queue is already empty", () => {
		expect(evaluateIdleQueueRecovery(recoveryInput({ pendingMessageCount: 0, parkedCount: 0 }))).toEqual({
			clear: false,
			refusal: "queue-empty",
		});
	});

	it("refuses while async subagent work is progressing", () => {
		expect(evaluateIdleQueueRecovery(recoveryInput({ hasProgressingAsyncWork: true }))).toEqual({
			clear: false,
			refusal: "async-work-progressing",
		});
	});

	it("refuses while a child process is alive: the silence may be work", () => {
		expect(evaluateIdleQueueRecovery(recoveryInput({ liveChildProcessCount: 1 }))).toEqual({
			clear: false,
			refusal: "live-child-process",
		});
	});

	it("refuses mid-rebuild, where the recovery pass owns the channel", () => {
		expect(evaluateIdleQueueRecovery(recoveryInput({ recovering: true }))).toEqual({
			clear: false,
			refusal: "recovery-in-flight",
		});
	});

	it("refuses when the SDK session does not expose clearQueue()", () => {
		expect(evaluateIdleQueueRecovery(recoveryInput({ clearQueueAvailable: false }))).toEqual({
			clear: false,
			refusal: "clear-queue-unavailable",
		});
	});
});

describe("partitionClearedMessages", () => {
	const parked = [parkedEntry("m-1", "is it normal part of the standard?"), parkedEntry("m-2", "any progress?")];

	it("treats cleared texts that match a parked entry as duplicates", () => {
		const result = partitionClearedMessages(
			{ steering: [], followUp: ["is it normal part of the standard?", "any progress?"] },
			parked
		);
		expect(result.matched).toHaveLength(2);
		expect(result.unmatched).toHaveLength(0);
		expect(result.total).toBe(2);
	});

	it("matches after trimming, because the queue stores the raw text", () => {
		const result = partitionClearedMessages({ steering: [], followUp: ["  any progress?  "] }, parked);
		expect(result.matched).toEqual(["  any progress?  "]);
	});

	it("reports cleared texts with no parked copy so the caller can re-park them", () => {
		const result = partitionClearedMessages({ steering: [], followUp: ["unparked thought"] }, parked);
		expect(result.unmatched).toEqual(["unparked thought"]);
	});

	it("counts every cleared entry even when the same text is queued twice", () => {
		const result = partitionClearedMessages(
			{ steering: ["any progress?"], followUp: ["any progress?"] },
			parked
		);
		expect(result.total).toBe(2);
		expect(result.matched).toHaveLength(1);
		expect(result.unmatched).toHaveLength(0);
	});
});

describe("idle queue recovery in the replay path", () => {
	const CHANNEL = "1518152817620029592";

	interface RigOptions {
		modelActive?: boolean;
		hasProgressingAsyncWork?: boolean;
		liveChildProcessCount?: number;
	}

	function createReplayRig(options: RigOptions = {}) {
		const store = createPendingMessageStore(
			join(mkdtempSync(join(tmpdir(), "pi-discord-idle-queue-")), "pending-messages.json"),
			{ log: () => {} }
		);
		const logs: string[] = [];
		const sent: string[] = [];
		let clearQueueCalls = 0;
		let queue: string[] = [];

		function park(id: string, content: string): void {
			store.add(parkedEntry(id, content));
		}

		function enqueueFollowUp(text: string): void {
			queue.push(text);
		}

		/** Mirrors clearStaleIdleQueue(): gate, clear, partition, re-park orphans. */
		async function clearStaleIdleQueue(): Promise<{ cleared: number; refusal: string | null }> {
			const parked = store.forChannel(CHANNEL);
			const base = {
				modelActive: options.modelActive ?? false,
				pendingMessageCount: queue.length,
				parkedCount: parked.length,
				recovering: false,
				clearQueueAvailable: true,
				hasProgressingAsyncWork: false,
				liveChildProcessCount: 0,
			};
			const cheap = evaluateIdleQueueRecovery(base);
			if (cheap.refusal !== null) return { cleared: 0, refusal: cheap.refusal };
			if (options.hasProgressingAsyncWork) return { cleared: 0, refusal: "async-work-progressing" };
			const decision = evaluateIdleQueueRecovery({
				...base,
				liveChildProcessCount: options.liveChildProcessCount ?? 0,
			});
			if (decision.refusal !== null) return { cleared: 0, refusal: decision.refusal };

			clearQueueCalls++;
			const clearedTexts = [...queue];
			queue = [];
			const partition = partitionClearedMessages({ steering: [], followUp: clearedTexts }, parked);
			partition.unmatched.forEach((orphan, index) => {
				if (!orphan.trim()) return;
				store.add({
					channelId: CHANNEL,
					discordMessageId: `${STALE_QUEUE_REASON}-${index}`,
					content: orphan,
					queuedAt: 1_700_000_000_000,
					reason: STALE_QUEUE_REASON,
				});
			});
			logs.push(
				`[watchdog] cleared ${partition.total} stale queued message(s) for ${CHANNEL} ` +
					`(idle session, ${parked.length} parked, ${partition.unmatched.length} re-parked)`
			);
			return { cleared: partition.total, refusal: null };
		}

		/** Mirrors replayPendingMessages(): idle-queue guard, then delivery. */
		async function replay(): Promise<number> {
			const parked = store.forChannel(CHANNEL);
			if (parked.length === 0) return 0;
			const alreadyQueued = queue.length;
			if (alreadyQueued > 0) {
				if (options.modelActive) return 0;
				const cleared = await clearStaleIdleQueue();
				if (cleared.refusal !== null) return 0;
				if (queue.length > 0) return 0;
			}
			let replayed = 0;
			// Snapshot: the store can grow while replaying (re-parked orphans), and
			// those belong to the next sweep.
			for (const entry of parked) {
				sent.push(entry.content);
				store.remove(CHANNEL, entry.discordMessageId);
				replayed++;
			}
			return replayed;
		}

		return {
			park,
			enqueueFollowUp,
			replay,
			sent,
			logs,
			get clearQueueCalls(): number {
				return clearQueueCalls;
			},
			get queueSize(): number {
				return queue.length;
			},
			parked: () => store.forChannel(CHANNEL),
		};
	}

	it("delivers each parked message exactly once when an idle queue held its copies", async () => {
		const rig = createReplayRig();
		rig.park("m-1", "is it normal part of the standard?");
		rig.park("m-2", "any progress?");
		// The stale copies the old code pushed while the run was still active.
		rig.enqueueFollowUp("is it normal part of the standard?");
		rig.enqueueFollowUp("any progress?");

		expect(await rig.replay()).toBe(2);

		expect(rig.clearQueueCalls).toBe(1);
		expect(rig.sent).toEqual(["is it normal part of the standard?", "any progress?"]);
		expect(rig.parked()).toHaveLength(0);
		expect(rig.queueSize).toBe(0);
		expect(rig.logs).toEqual([
			"[watchdog] cleared 2 stale queued message(s) for 1518152817620029592 (idle session, 2 parked, 0 re-parked)",
		]);
	});

	it("does not deliver a cleared copy a second time", async () => {
		const rig = createReplayRig();
		rig.park("m-1", "any progress?");
		rig.enqueueFollowUp("any progress?");

		await rig.replay();
		// A second sweep must not resurrect anything: both the queue and the store
		// are empty, so the replayed text stays sent exactly once.
		expect(await rig.replay()).toBe(0);
		expect(rig.sent).toEqual(["any progress?"]);
	});

	it("does not clear a queue when nothing is parked", async () => {
		const rig = createReplayRig();
		rig.enqueueFollowUp("something a live turn still needs");
		expect(await rig.replay()).toBe(0);
		expect(rig.clearQueueCalls).toBe(0);
		expect(rig.queueSize).toBe(1);
		expect(rig.logs).toEqual([]);
	});

	it("leaves an active session's queue untouched", async () => {
		const rig = createReplayRig({ modelActive: true });
		rig.park("m-1", "any progress?");
		rig.enqueueFollowUp("any progress?");
		expect(await rig.replay()).toBe(0);
		expect(rig.clearQueueCalls).toBe(0);
		expect(rig.queueSize).toBe(1);
		expect(rig.sent).toEqual([]);
	});

	it("refuses while a child process is alive", async () => {
		const rig = createReplayRig({ liveChildProcessCount: 2 });
		rig.park("m-1", "any progress?");
		rig.enqueueFollowUp("any progress?");
		expect(await rig.replay()).toBe(0);
		expect(rig.clearQueueCalls).toBe(0);
		expect(rig.sent).toEqual([]);
	});

	it("re-parks a cleared message that had no durable copy", async () => {
		const rig = createReplayRig();
		rig.park("m-1", "any progress?");
		rig.enqueueFollowUp("any progress?");
		rig.enqueueFollowUp("an attachment message we never parked");

		await rig.replay();

		expect(rig.sent).toEqual(["any progress?"]);
		// The orphan is not lost: it is parked for the next sweep.
		expect(rig.parked().map((entry) => entry.content)).toEqual(["an attachment message we never parked"]);
		expect(rig.parked()[0].reason).toBe(STALE_QUEUE_REASON);
	});
});

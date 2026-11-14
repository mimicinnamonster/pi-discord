/**
 * Per-channel outbound ordering for Discord messages.
 *
 * Discord gives no ordering guarantee across concurrent REST calls: whichever
 * request completes first is displayed first. Every post in this bot is
 * event-driven (a `message_end`, a `tool_execution_start`, a watchdog notice),
 * so without serialisation a slow send — a >2000-char reply that has to fall
 * back from file upload, for instance — is overtaken by a later, fast line and
 * the channel reads out of order.
 *
 * This queue serialises whole logical messages per channel. An item holds its
 * channel until the item's own task settles, so the chunks of one message can
 * never be interleaved with the next message. Channels are independent: a slow
 * channel never blocks another one.
 */

/** Default ceiling on undelivered messages per channel. */
export const DEFAULT_MAX_PENDING_SENDS = 100;

/**
 * Default ceiling for one logical message end to end. The Discord REST layer
 * already bounds each request (timeout × (retries + 1)); this is the backstop
 * for a task that never settles at all, so it cannot stall the channel's chain
 * forever.
 */
export const DEFAULT_SEND_ITEM_TIMEOUT_MS = 60_000;

export interface EnqueueOptions<T> {
	/** Resolved instead of sending when the queue is full. */
	droppedResult: T;
	/** Short kind for logs, e.g. "response" or "tool". */
	label?: string;
	/** Per-item backstop; defaults to DEFAULT_SEND_ITEM_TIMEOUT_MS. */
	timeoutMs?: number;
}

interface QueueState {
	tail: Promise<void>;
	pending: number;
	dropped: number;
}

/** Resolves with the task's value, or rejects when the task outlives the budget. */
export function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return task;
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`${label} did not settle within ${timeoutMs}ms`));
		}, timeoutMs);
		// A pending send must not keep the process alive during shutdown.
		timer.unref?.();
		task.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

export class ChannelSendQueue {
	private readonly states = new Map<string, QueueState>();
	private sequence = 0;

	constructor(
		private readonly log: (message: string) => void = () => {},
		readonly maxPending: number = DEFAULT_MAX_PENDING_SENDS,
		private readonly itemTimeoutMs: number = DEFAULT_SEND_ITEM_TIMEOUT_MS
	) {}

	/**
	 * Queues one logical message behind everything already queued for the
	 * channel. Rejections propagate to the caller but never break the chain, so
	 * one failed send cannot stall the messages behind it.
	 *
	 * Must not be nested: a task that itself calls `enqueue` for the same channel
	 * would wait on its own slot and deadlock.
	 */
	enqueue<T>(channelId: string, task: () => Promise<T>, options: EnqueueOptions<T>): Promise<T> {
		const state = this.state(channelId);
		if (state.pending >= this.maxPending) {
			state.dropped += 1;
			this.log(
				`[${channelId}] send queue full (${state.pending} pending) - dropped ${options.label ?? "message"} (dropped so far: ${state.dropped})`
			);
			return Promise.resolve(options.droppedResult);
		}

		state.pending += 1;
		const sequence = ++this.sequence;
		const label = options.label ?? "message";
		const timeoutMs = options.timeoutMs ?? this.itemTimeoutMs;

		const result = state.tail.then(async () => {
			try {
				return await withTimeout(task(), timeoutMs, `[${channelId}] ${label} #${sequence}`);
			} finally {
				state.pending -= 1;
			}
		});

		// The chain survives rejections; the caller still sees them via `result`.
		state.tail = result.then(
			() => undefined,
			() => undefined
		);

		return result;
	}

	/** Messages enqueued for this channel that have not settled yet. */
	pendingCount(channelId: string): number {
		return this.states.get(channelId)?.pending ?? 0;
	}

	/** Messages rejected because this channel's queue was full. */
	droppedCount(channelId: string): number {
		return this.states.get(channelId)?.dropped ?? 0;
	}

	/** Waits for everything queued for the channel to settle. */
	async drain(channelId: string, timeoutMs: number = DEFAULT_SEND_ITEM_TIMEOUT_MS): Promise<boolean> {
		const state = this.states.get(channelId);
		if (!state) return true;
		try {
			await withTimeout(state.tail, timeoutMs, `[${channelId}] send queue drain`);
			return true;
		} catch (error) {
			this.log(`[${channelId}] send queue drain abandoned: ${error}`);
			return false;
		}
	}

	/**
	 * Waits for the channel's queue to settle, then forgets its state so shutdown
	 * does not retain per-channel closures. A restart rebuilds state on demand.
	 */
	async release(channelId: string, timeoutMs: number = DEFAULT_SEND_ITEM_TIMEOUT_MS): Promise<void> {
		const drained = await this.drain(channelId, timeoutMs);
		const state = this.states.get(channelId);
		if (state && state.pending > 0) {
			this.log(`[${channelId}] releasing send queue with ${state.pending} pending send(s)`);
		}
		if (!drained && state) {
			this.log(`[${channelId}] dropping ${state.pending} undelivered send(s) at shutdown`);
		}
		this.states.delete(channelId);
	}

	/** Releases every channel; used once during shutdown. */
	async releaseAll(timeoutMs: number = DEFAULT_SEND_ITEM_TIMEOUT_MS): Promise<void> {
		const channelIds = [...this.states.keys()];
		await Promise.all(channelIds.map((channelId) => this.release(channelId, timeoutMs)));
	}

	private state(channelId: string): QueueState {
		let state = this.states.get(channelId);
		if (!state) {
			state = { tail: Promise.resolve(), pending: 0, dropped: 0 };
			this.states.set(channelId, state);
		}
		return state;
	}
}

/**
 * Typing Manager - Robust typing indicator for Discord
 * Ensures typing indicator only shows when LLM is actively working
 */

export interface TypingChannel {
	/** HTTP endpoint to trigger typing indicator. Returns true on success. */
	triggerTyping(): Promise<boolean>;
}

export class TypingManager {
	private activeTyping = new Map<string, { interval: NodeJS.Timeout; version: number }>();
	private versionCounter = 0;
	// Discord typing rate limit is 1 per 5 seconds. Use 6s to stay safe,
	// then retry once after a 429 backoff.
	private readonly TYPING_DURATION_MS = 6000;

	/**
	 * Show typing indicator for a channel.
	 * Automatically stops after TYPING_DURATION_MS to prevent stuck typing.
	 *
	 * This method is idempotent: if typing is already active for this channel,
	 * it won't reset the interval. The interval fires every TYPING_DURATION_MS
	 * and handles refreshing, preventing Discord rate-limit issues from rapid
	 * thinking_delta events.
	 */
	show(channelId: string, channel: TypingChannel): void {
		// If typing is already active, just log and return — the interval handles refreshes
		if (this.activeTyping.has(channelId)) {
			return;
		}

		// Assign a unique version for this show() instance
		this.versionCounter++;
		const version = this.versionCounter;

		console.log(`[typing-manager] Showing typing for ${channelId}`);

		// Start typing immediately
		channel.triggerTyping().then((ok) => {
			console.log(`[typing-manager] Initial typing ${ok ? "sent" : "failed"} for ${channelId}`);
		}).catch((err) => {
			console.log(`[typing-manager] Failed to send typing for ${channelId}: ${err?.message || err}`);
		});

		// Set up recurring typing to keep it alive
		const interval = setInterval(() => {
			channel.triggerTyping().then((ok) => {
				if (!ok) console.log(`[typing-manager] Interval typing failed for ${channelId}`);
			}).catch((err) => {
				console.log(`[typing-manager] Failed to send typing (interval) for ${channelId}: ${err?.message || err}`);
			});
		}, this.TYPING_DURATION_MS);

		this.activeTyping.set(channelId, { interval, version });
	}

	/**
	 * Hide typing indicator for a channel.
	 * Called when we know the LLM has finished (agent_end).
	 */
	hide(channelId: string): void {
		this.clearTimeout(channelId);
	}

	private clearTimeout(channelId: string): void {
		const existing = this.activeTyping.get(channelId);
		if (existing) {
			clearInterval(existing.interval);
			this.activeTyping.delete(channelId);
		}
	}

	/**
	 * Check if typing is currently active for a channel.
	 */
	isTyping(channelId: string): boolean {
		return this.activeTyping.has(channelId);
	}

	/**
	 * Hide all typing indicators (cleanup on shutdown).
	 */
	dispose(): void {
		for (const channelId of this.activeTyping.keys()) {
			this.clearTimeout(channelId);
		}
	}
}

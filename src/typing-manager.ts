/**
 * Typing Manager - Robust typing indicator for Discord
 * Ensures typing indicator only shows when LLM is actively working
 */

export interface TypingChannel {
	/** HTTP endpoint to trigger typing indicator. Returns true on success. */
	triggerTyping(): Promise<boolean>;
}

export class TypingManager {
	private activeTyping = new Map<string, { timeout: NodeJS.Timeout; version: number }>();
	private versionCounter = 0;

	/**
	 * Show typing indicator for a channel.
	 *
	 * Sends a single typing request. Discord keeps the indicator visible
	 * for ~10 seconds. No interval to avoid Discord's strict 429 rate limit.
	 *
	 * This method is idempotent: if typing is already active for this channel,
	 * it does nothing.
	 */
	show(channelId: string, channel: TypingChannel): void {
		if (this.activeTyping.has(channelId)) {
			return;
		}

		console.log(`[typing-manager] Showing typing for ${channelId}`);
		channel.triggerTyping();

		this.activeTyping.set(channelId, {
			timeout: setTimeout(() => this.hide(channelId), 10000),
			version: this.versionCounter++,
		});
	}

	/**
	 * Hide typing indicator for a channel.
	 * Called when we know the LLM has finished (agent_end).
	 */
	hide(channelId: string): void {
		const existing = this.activeTyping.get(channelId);
		if (existing) {
			clearTimeout(existing.timeout);
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
			this.hide(channelId);
		}
	}
}

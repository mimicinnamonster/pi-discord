/**
 * Typing Manager - Robust typing indicator for Discord
 * Ensures typing indicator only shows when LLM is actively working
 */

export interface TypingChannel {
	sendTyping(): Promise<void>;
}

export class TypingManager {
	private activeTyping = new Map<string, NodeJS.Timeout>();
	private readonly TYPING_DURATION_MS = 5000;

	/**
	 * Show typing indicator for a channel.
	 * Automatically stops after TYPING_DURATION_MS to prevent stuck typing.
	 */
	show(channelId: string, channel: TypingChannel): void {
		// Clear any existing timeout for this channel
		this.clearTimeout(channelId);

		// Start typing
		channel.sendTyping().catch(() => {
			// Channel might be unavailable, ignore
			this.activeTyping.delete(channelId);
		});

		// Set up recurring typing to keep it alive
		const interval = setInterval(() => {
			channel.sendTyping().catch(() => {
				this.clearTimeout(channelId);
			});
		}, this.TYPING_DURATION_MS);

		this.activeTyping.set(channelId, interval);
	}

	/**
	 * Hide typing indicator for a channel.
	 * Called when we know the LLM has finished (message_end).
	 */
	hide(channelId: string): void {
		this.clearTimeout(channelId);
	}

	private clearTimeout(channelId: string): void {
		const existing = this.activeTyping.get(channelId);
		if (existing) {
			clearInterval(existing);
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

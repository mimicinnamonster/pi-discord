/**
 * Typing Manager - Robust typing indicator for Discord
 * Ensures typing indicator only shows when LLM is actively working
 */

export interface TypingChannel {
	sendTyping(): Promise<void>;
}

export class TypingManager {
	private activeTyping = new Map<string, { interval: NodeJS.Timeout; version: number }>();
	private versionCounter = 0;
	private readonly TYPING_DURATION_MS = 5000;

	/**
	 * Show typing indicator for a channel.
	 * Automatically stops after TYPING_DURATION_MS to prevent stuck typing.
	 */
	show(channelId: string, channel: TypingChannel): void {
		// Clear any existing interval for this channel
		this.clearTimeout(channelId);

		// Assign a unique version so stale catch handlers can't affect newer intervals
		this.versionCounter++;
		const version = this.versionCounter;

		console.log(`[typing-manager] Showing typing for ${channelId}`);

		// Start typing immediately
		channel.sendTyping().catch(() => {
			// Only clear if our version is still the active one
			// (a newer show() call may have replaced us)
			const active = this.activeTyping.get(channelId);
			if (active?.version === version) {
				this.clearTimeout(channelId);
			}
		});

		// Set up recurring typing to keep it alive
		const interval = setInterval(() => {
			channel.sendTyping().catch(() => {
				// Only clear if our version is still the active one
				const active = this.activeTyping.get(channelId);
				if (active?.version === version) {
					this.clearTimeout(channelId);
				}
			});
		}, this.TYPING_DURATION_MS);

		this.activeTyping.set(channelId, { interval, version });
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

/**
 * Typing Manager - Robust typing indicator for Discord
 *
 * Keeps the typing indicator visible for as long as agent work is in
 * progress — including the wait for the first API response, long tool
 * executions, compaction and retry backoff.
 *
 * Discord shows "user is typing..." for ~10 seconds per trigger request and
 * rate-limits the /typing endpoint to 1 request per 5 seconds per channel.
 * While active we re-trigger every 7s: safely under the rate limit and well
 * before the 10s expiry, so the indicator never flickers or dies mid-work.
 *
 * The indicator is stopped by:
 *   - an explicit hide() (agent turn finished, /stop, shutdown), or
 *   - the dead-man timer below, if no show() refresh arrives for 30 minutes
 *     (guards against a turn that died without emitting agent_end), or
 *   - the process hanging/crashing — the renewal timer stops firing and
 *     Discord expires the indicator ~10s later, so a dead bot stops looking
 *     busy.
 */

export interface TypingChannel {
	/** HTTP endpoint to trigger typing indicator. Returns true on success. */
	triggerTyping(): Promise<boolean>;
}

export class TypingManager {
	/** How often to re-trigger the typing endpoint while active. */
	private static readonly RENEW_INTERVAL_MS = 7_000;
	/**
	 * Dead-man switch: if no show() refresh arrives for this long, stop
	 * typing. Guards against a turn that died without agent_end (e.g. an
	 * uncaught exception swallowed by the process handler).
	 */
	private static readonly MAX_ACTIVE_MS = 30 * 60_000;

	private activeTyping = new Map<string, { renew: NodeJS.Timeout; deadMan: NodeJS.Timeout }>();

	/**
	 * Show typing indicator for a channel.
	 *
	 * Triggers Discord's typing endpoint immediately and starts a renewal
	 * timer that re-triggers every 7s while active, so the indicator stays
	 * visible for arbitrarily long operations.
	 *
	 * Idempotent for the HTTP trigger: while already active it only refreshes
	 * the dead-man timer, it does not fire another request (the renewal timer
	 * already keeps the indicator alive).
	 */
	show(channelId: string, channel: TypingChannel): void {
		const existing = this.activeTyping.get(channelId);
		if (existing) {
			// Already active — refresh the dead-man timer only.
			clearTimeout(existing.deadMan);
			existing.deadMan = setTimeout(() => this.hide(channelId), TypingManager.MAX_ACTIVE_MS);
			return;
		}

		console.log(`[typing-manager] Showing typing for ${channelId}`);
		channel.triggerTyping();

		const renew = setInterval(() => {
			channel.triggerTyping();
		}, TypingManager.RENEW_INTERVAL_MS);
		// Don't keep the process alive just for a typing indicator.
		renew.unref?.();

		const deadMan = setTimeout(() => this.hide(channelId), TypingManager.MAX_ACTIVE_MS);
		deadMan.unref?.();

		this.activeTyping.set(channelId, { renew, deadMan });
	}

	/**
	 * Hide typing indicator for a channel.
	 * Called when agent work has finished (agent_end, /stop, shutdown).
	 */
	hide(channelId: string): void {
		const existing = this.activeTyping.get(channelId);
		if (existing) {
			clearTimeout(existing.deadMan);
			clearInterval(existing.renew);
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
		for (const channelId of [...this.activeTyping.keys()]) {
			this.hide(channelId);
		}
	}
}

import type { AgentSession } from "@mariozechner/pi-coding-agent";

/**
 * Generates a token utilization status message.
 * Returns null if context usage data is unavailable.
 */
export function generateTokenStatsMessage(
	channelId: string, 
	session: AgentSession, 
	prevTokens: Map<string, { contextPercent: number }>
): { message: string; shouldAlert: boolean } | null {
	const stats = session.getSessionStats();
	const contextUsage = stats.contextUsage;
	const prev = prevTokens.get(channelId);
	const inputTokens = stats.tokens.input;
	const outputTokens = stats.tokens.output;

	// contextUsage can be undefined or have null fields (e.g. post-compaction with no response yet)
	if (!contextUsage || contextUsage.percent == null) {
		return null;
	}

	const contextPct = contextUsage.percent;
	const contextTokens = contextUsage.tokens!;
	const maxWindow = contextUsage.contextWindow;

	let shouldAlert = false;
	let deltaContext = "N/A";

	if (prev) {
		const contextDeltaPct = Math.abs(contextPct - prev.contextPercent);
		deltaContext = `Δ${contextDeltaPct.toFixed(2)}%`;

		if (contextDeltaPct >= 1) {
			shouldAlert = true;
		}
	}

	const message = `📊 **Token Utilization**\n` +
		`**In:** ${inputTokens.toLocaleString()} tok (lifetime)\n` +
		`**Out:** ${outputTokens.toLocaleString()} tok (lifetime)\n` +
		`**Context:** **${contextPct.toFixed(1)}%** | ${contextTokens.toLocaleString()} / ${maxWindow.toLocaleString()} tok | ${deltaContext}`;

	return { message, shouldAlert };
}

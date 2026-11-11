/**
 * Incoming-message interrupt decision for pi-discord.
 *
 * Extracted as a pure function so tests/interrupt-decision.test.ts can exercise
 * the real logic (src/index.ts itself cannot be imported under test: it validates
 * DISCORD_BOT_TOKEN and calls process.exit at module load).
 */

export interface InterruptDecisionInput {
	/** DiscordSession.isModelActive(): isStreaming || isRetrying || isCompacting || isBashRunning. */
	modelActive: boolean;
	/** The message is a slash command that must never abort the agent. */
	nonInterruptingCommand: boolean;
}

/**
 * Whether a new user message should abort in-flight model activity
 * (send "🛑 Interrupted by user" + call abortModelActivities()).
 *
 * Rule: interrupt whenever the session reports activity and the message is not
 * a non-interrupting command.
 *
 * There is deliberately no exception for pending background subagent work.
 * Async subagents run in their own detached process group, so aborting the main
 * turn does not touch them; waiting for them to drain before accepting a new
 * message is what let a wedged turn swallow every subsequent message, /exit
 * included.
 */
export function shouldInterruptForIncomingMessage(input: InterruptDecisionInput): boolean {
	return input.modelActive && !input.nonInterruptingCommand;
}

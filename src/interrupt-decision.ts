/**
 * Incoming-message interrupt decision for pi-discord.
 *
 * Extracted as a pure function so tests/interruption.test.ts can exercise the
 * real logic (src/index.ts itself cannot be imported under test: it validates
 * DISCORD_BOT_TOKEN and calls process.exit at module load).
 */

export interface InterruptDecisionInput {
	/** DiscordSession.isModelActive(): isStreaming || isRetrying || isCompacting || isBashRunning. */
	modelActive: boolean;
	/** The message is a slash command that must never abort the agent. */
	nonInterruptingCommand: boolean;
	/**
	 * The run's final turn has ended (turn_end with a non-toolUse stop reason)
	 * but the public agent_end event has not been observed yet. The
	 * pi-subagents extension drains background subagents inside its agent_end
	 * handler, which the SDK runs BEFORE emitting agent_end to subscribers —
	 * so this window can stay open for minutes while isStreaming is still true.
	 */
	awaitingAgentEnd: boolean;
	/** Session flags that keep the run interruptible regardless of the drain. */
	retrying: boolean;
	compacting: boolean;
	bashRunning: boolean;
	/** SubagentGate reports async (background) subagent runs still pending. */
	pendingBackgroundWork: boolean;
}

/**
 * Whether a new user message should abort in-flight model activity
 * (send "🛑 Interrupted by user" + call abortModelActivities()).
 *
 * Normal rule: interrupt whenever the session reports activity and the message
 * is not a non-interrupting command. Exception — "drain only": when the main
 * turn has already ended (awaitingAgentEnd), no retry/compaction/bash is
 * running, and the only reason the session still looks active is pi-subagents
 * draining background subagents in its agent_end handler, there is nothing to
 * interrupt: abort() would not stop the background runs (they are separate
 * processes), so the caller queues the message as a follow-up instead of
 * reporting an interruption.
 */
export function shouldInterruptForIncomingMessage(input: InterruptDecisionInput): boolean {
	if (!input.modelActive || input.nonInterruptingCommand) {
		return false;
	}
	const onlyDrainingBackgroundWork =
		input.awaitingAgentEnd &&
		!input.retrying &&
		!input.compacting &&
		!input.bashRunning &&
		input.pendingBackgroundWork;
	return !onlyDrainingBackgroundWork;
}

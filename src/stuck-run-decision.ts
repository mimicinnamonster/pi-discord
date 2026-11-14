/**
 * Stale-run recovery decision for pi-discord.
 *
 * Extracted as a pure function so tests/stuck-run-decision.test.ts can exercise
 * the real logic (src/index.ts itself cannot be imported under test: it validates
 * DISCORD_BOT_TOKEN and calls process.exit at module load).
 */

export interface StuckRunDecisionInput {
	/** DiscordSession.isModelActive(): isStreaming || isRetrying || isCompacting || isBashRunning. */
	modelActive: boolean;
	/** Milliseconds since the session last emitted any SDK event. */
	idleMs: number;
	/** Silence after which an active run is considered wedged. */
	thresholdMs?: number;
	/**
	 * Async subagent work that is still *progressing*, i.e. verified against the run
	 * store rather than read off the gate's in-memory tally. A finished run whose
	 * completion notice is still queued is the wedge itself, not work.
	 */
	hasPendingBackgroundWork: boolean;
	/**
	 * Sync subagent tool calls currently executing in this channel. A sync child
	 * emits no session event for its whole duration, so this is the only signal
	 * that silence is work rather than a wedge.
	 */
	inFlightToolCount: number;
	/** Sync subagent tool calls currently executing: a live child process is work. */
	hasActiveSubagentWork: boolean;
	/** Confirming sweeps already observed for this channel (see REQUIRED_CONFIRMING_SWEEPS). */
	priorConfirmations: number;
}

/**
 * Silence after which an active run is treated as a candidate for recovery.
 *
 * Deliberately larger than every legitimate silent phase in this bot: the
 * pi-subagents drain documented in src/index.ts ("can hold open for up to 30
 * minutes") and STALE_ASYNC_WORK_TIMEOUT_MS (10 minutes). A threshold at or
 * below those would abort a healthy turn — an abort sets the run's abort flag,
 * so it does not merely wait, it destroys the output.
 *
 * The wedge this recovers from parks a run between `agent_end` and the SDK's
 * settle path (`_emitAgentSettled`), which is the only place `_isAgentRunActive`
 * — and therefore `isStreaming` — is cleared. Nothing in that phase has a
 * deadline, so it can park until the process restarts.
 */
export const DEFAULT_STUCK_RUN_THRESHOLD_MS = 45 * 60 * 1000;

/**
 * Consecutive confirming sweeps before a candidate is recovered.
 *
 * One tick of silence is a measurement; two are a confirmation. Together with
 * DEFAULT_STUCK_RUN_THRESHOLD_MS this means a false positive needs ~45 minutes
 * of total silence with no tool in flight and no child process alive.
 */
export const REQUIRED_CONFIRMING_SWEEPS = 2;

export type StuckRunRefusal =
	| "not-active"
	| "tool-in-flight"
	| "sync-subagent-work"
	| "async-subagent-work"
	| "not-idle"
	| "unconfirmed";

/** Those refusals that mean "live work is probably happening", i.e. hands off. */
export type StuckRunLivenessRefusal = Exclude<StuckRunRefusal, "unconfirmed">;

export interface StuckRunEvaluation {
	/** True only when every gate passes, i.e. the session should be recovered. */
	shouldRecover: boolean;
	/** True when the session looks wedged but confirmation is still pending. */
	candidate: boolean;
	/** The gate that refused recovery, or null when shouldRecover is true. */
	refusedBy: StuckRunRefusal | null;
}

/**
 * The liveness half of the decision: is this active run plausibly still working?
 *
 * Exported because the parked-message replay needs the same answer before it may
 * abort a run (see replayPendingMessages in src/index.ts). It returns the refusing
 * gate, or null when the run looks wedged. Confirmation is deliberately not part
 * of this half: it exists to stop a single background tick from acting, not to
 * declare a silent run alive.
 */
export function evaluateStuckRunLiveness(input: StuckRunDecisionInput): StuckRunLivenessRefusal | null {
	const thresholdMs = input.thresholdMs ?? DEFAULT_STUCK_RUN_THRESHOLD_MS;

	if (!input.modelActive) return "not-active";
	// A tool call in flight emits nothing until it ends, so silence here is work.
	if (input.inFlightToolCount > 0) return "tool-in-flight";
	// A sync subagent call is a live child process, and its silence is work.
	if (input.hasActiveSubagentWork) return "sync-subagent-work";
	// A drain waiting on async children keeps the run open without emitting agent
	// events. Only runs that are still progressing count: a completed run with an
	// undelivered result is the signature of this wedge, so treating it as work
	// would make this watchdog refuse exactly the case it exists for.
	if (input.hasPendingBackgroundWork) return "async-subagent-work";
	if (input.idleMs < thresholdMs) return "not-idle";
	return null;
}

/**
 * Evaluate the recovery gates in refusal order and report which one refused.
 *
 * The reason exists for the `[watchdog]` log line: it is what lets an operator
 * tell "the bot refused to recover a live turn" from "the bot never noticed".
 */
export function evaluateStuckRun(input: StuckRunDecisionInput): StuckRunEvaluation {
	const refuse = (refusedBy: StuckRunRefusal, candidate: boolean): StuckRunEvaluation => ({
		shouldRecover: false,
		candidate,
		refusedBy,
	});

	const livenessRefusal = evaluateStuckRunLiveness(input);
	if (livenessRefusal) return refuse(livenessRefusal, false);

	if (input.priorConfirmations + 1 < REQUIRED_CONFIRMING_SWEEPS) return refuse("unconfirmed", true);

	return { shouldRecover: true, candidate: true, refusedBy: null };
}

/** Whether the session should be recovered by force instead of waited on. */
export function shouldRecoverStuckRun(input: StuckRunDecisionInput): boolean {
	return evaluateStuckRun(input).shouldRecover;
}

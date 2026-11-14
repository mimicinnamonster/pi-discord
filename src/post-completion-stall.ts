/**
 * Post-completion stall decision for pi-discord.
 *
 * Extracted as a pure function so tests/post-completion-stall.test.ts can
 * exercise the real logic (src/index.ts itself cannot be imported under test:
 * it validates DISCORD_BOT_TOKEN and exits at process load).
 *
 * The SDK emits its public `agent_end` only after every awaited extension
 * `agent_end` handler resolves (agent-session.js:811-812 -> :962-963), and clears
 * the run-active latch even later (:533 in the `finally` of :1103). A handler
 * that waits on a drain that never completes therefore keeps the run "active"
 * after the turn is finished in every way a user can observe: the final
 * assistant message is already persisted, the transcript stops growing, and no
 * further event ever arrives.
 *
 * That is a precise signature, unlike raw silence. Silence is ambiguous (a tool
 * emits nothing for its whole duration, and so does a sync subagent child), which
 * is why the idle watchdog in src/stuck-run-decision.ts needs a 45-minute
 * threshold and a confirmation streak. "The last message of the turn is on disk
 * and nothing has happened since" is not ambiguous: the turn is over.
 *
 * The one thing that does produce work without emitting an event after the final
 * message is a subagent drain: the children run detached, so they are neither a
 * tool in flight nor a child process of the bot, and only the gate accounting
 * knows about them. That gate is checked first and is itself bounded — orphaned
 * runs are released by sweepStaleBackgroundWork() after
 * STALE_ASYNC_WORK_TIMEOUT_MS — so this path can still fire for the wedge where
 * the completion notice never arrives, just not before a live drain finishes.
 */

/**
 * Silence after the final assistant message before the turn is called stalled.
 *
 * Short by design: only the settle path itself can still be running at this
 * point, and a healthy one finishes in milliseconds. Two minutes leaves room for
 * a slow final Discord send and a queued-prompt handoff without ever treating the
 * settle window as work.
 */
export const POST_COMPLETION_STALL_GRACE_MS = 120_000;

/** Stop reasons that end a turn: the run can only be settling after one of them. */
export const TERMINAL_STOP_REASONS: readonly string[] = ["stop", "length", "error", "aborted"];

/**
 * Why a run was not treated as stalled. Every value except `null` means "leave it
 * alone", and each names a concrete liveness signal rather than a measurement.
 */
export type PostCompletionStallRefusal =
	| "not-active"
	| "no-terminal-message"
	| "event-since-terminal"
	| "subagent-work-pending"
	| "tool-in-flight"
	| "within-grace"
	| "child-process-alive";

export interface PostCompletionStallInput {
	/** DiscordSession.isModelActive(): isStreaming || isRetrying || isCompacting || isBashRunning. */
	modelActive: boolean;
	/**
	 * Milliseconds since this turn's terminal assistant message, or undefined when
	 * no terminal message has been seen since the last activity.
	 */
	msSinceTerminalMessage: number | undefined;
	/**
	 * A session event arrived after that message, so the run is still producing.
	 * Redundant with clearing the marker on every event by design: both are cheap
	 * and can only push towards refusing, never towards tearing a turn down.
	 */
	eventSinceTerminal: boolean;
	/** Tool calls currently executing: a tool emits nothing until it ends. */
	inFlightToolCount: number;
	/**
	 * Subagent work the session still owes a completion notice for: async runs that
	 * have not reported (detached processes, invisible to a child-process probe) or
	 * a sync gate holder. Checked before the grace window so a live drain is never
	 * mistaken for a stalled settle path.
	 */
	hasPendingSubagentWork: boolean;
	/** Live (non-zombie) child processes of the bot, e.g. a sync subagent child. */
	liveChildProcessCount: number;
	/** Silence after the terminal message required to call the turn stalled. */
	graceMs?: number;
}

/**
 * Whether a terminal assistant message ends a turn, i.e. the run cannot be in the
 * middle of a tool batch. `toolUse` continues the turn, and `pending` has not
 * produced a final message at all.
 */
export function isTerminalStopReason(stopReason: string): boolean {
	return TERMINAL_STOP_REASONS.includes(stopReason);
}

/**
 * Evaluate the stall gates in refusal order and report which one refused.
 *
 * Returns null when the run is provably past its last message with nothing
 * producing work — the caller may then rebuild the session without waiting for
 * the idle threshold or a confirmation streak.
 */
export function evaluatePostCompletionStall(
	input: PostCompletionStallInput
): PostCompletionStallRefusal | null {
	const graceMs = input.graceMs ?? POST_COMPLETION_STALL_GRACE_MS;

	// A settled run reports inactive even if a stale `message_end` marker survived.
	if (!input.modelActive) return "not-active";
	if (input.msSinceTerminalMessage === undefined) return "no-terminal-message";
	if (input.eventSinceTerminal) return "event-since-terminal";
	// A drain waiting on detached children is work even with no tool in flight.
	if (input.hasPendingSubagentWork) return "subagent-work-pending";
	if (input.inFlightToolCount > 0) return "tool-in-flight";
	if (input.msSinceTerminalMessage < graceMs) return "within-grace";
	if (input.liveChildProcessCount > 0) return "child-process-alive";
	return null;
}

/** Boolean form for callers that only need the decision. */
export function isPostCompletionStall(input: PostCompletionStallInput): boolean {
	return evaluatePostCompletionStall(input) === null;
}

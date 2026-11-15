/**
 * Evidence rules shared by the two stall watchdogs.
 *
 * Both watchdogs exist for the same failure: the SDK keeps a run "active" until
 * its settle path finishes (agent-session.js:533/:1103), and that path can stay
 * parked forever behind an awaited extension hook. Two inputs decide whether a
 * channel is wedged: is the run producing work, and is the turn's final message
 * already on disk.
 *
 * Both inputs are easy to corrupt, and doing so disabled recovery for ten hours
 * on the server (2026-11-15, channel 1518152817620029592):
 *
 *  - The turn's final message was observed, then our own interrupt sequence
 *    emitted events which erased that observation, so the stall check refused
 *    with "no terminal message" forever.
 *  - The same interrupt sequence refreshed the liveness clock, so the idle
 *    watchdog's 45-minute silence kept restarting, and a user who kept asking
 *    postponed recovery indefinitely.
 *
 * The rules below are deliberately asymmetric: only *positive work* refreshes
 * the clock, and only a *new turn* erases the completion marker. End-of-run and
 * interruption events are neither.
 *
 * Pure and dependency-free (structural event type) so the boundaries are
 * testable without a live session: src/index.ts cannot be imported under test.
 */

import type { PostCompletionStallRefusal } from "./post-completion-stall.ts";
import type { TranscriptTail } from "./completion-orphans.ts";

/**
 * Structural subset of the SDK's session events that these rules need.
 *
 * Declared here rather than imported so tests can build fixtures as literals.
 */
export interface StallEventLike {
	type: string;
	message?: { role?: string; stopReason?: string };
}

/**
 * Event types that prove the main agent is producing work.
 *
 * Every accepted type is emitted while the model or a tool is actually running:
 * streaming deltas, a new message, a tool call. Everything else — `agent_end`,
 * `agent_settled`, `message_end` with stop reason `aborted`, retry and
 * compaction notices — is bookkeeping that also fires when our own interrupt
 * lands, so counting it as liveness is what let the silence clock reset forever.
 */
const LIVENESS_EVENT_TYPES: ReadonlySet<string> = new Set([
	"agent_start",
	"message_start",
	"message_update",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

/** Whether an event counts as the model/tools doing work. */
export function isLivenessEvent(event: StallEventLike): boolean {
	return LIVENESS_EVENT_TYPES.has(event.type);
}

/**
 * Event types that mean the turn moved on and the previous final message is no
 * longer "the last thing that happened".
 *
 * A new turn (`agent_start`, `message_start`), resumed generation
 * (`message_update`), the start of a tool batch, or a retry/compaction all prove
 * the run continued past that message. Interrupt and end-of-run events do not:
 * the turn is over in both cases, which is exactly the state the stall detector
 * needs to keep seeing.
 */
const TERMINAL_MARKER_CLEARING_TYPES: ReadonlySet<string> = new Set([
	"agent_start",
	"message_start",
	"message_update",
	"tool_execution_start",
	"auto_compaction_start",
	"auto_retry_start",
]);

/**
 * Whether an event invalidates the "terminal message then silence" evidence.
 *
 * Never true for `agent_end`, `agent_settled` or an `aborted` message: those are
 * the events our own interrupt produces, and treating them as continuation is
 * what erased the evidence at the exact moment the run went dead.
 */
export function clearsTerminalMarker(event: StallEventLike): boolean {
	return TERMINAL_MARKER_CLEARING_TYPES.has(event.type);
}

/**
 * How many consecutive identical refusals are tolerated before the stall check
 * recovers anyway.
 *
 * Sweeps run every 60s, so three is roughly three minutes of the same answer —
 * far longer than the settle path a healthy run needs (milliseconds) and far
 * shorter than the idle watchdog's 45 minutes. The streak resets on any liveness
 * event, so a run that is genuinely working can never accumulate it.
 */
export const STALL_ESCALATION_SWEEPS = 3;

/**
 * Refusals that may be escalated.
 *
 * These three rest on bookkeeping or on timing ("could still be settling"), and
 * each has been wrong in production: the subagent tally is released through the
 * session a wedge keeps busy, and the grace and event-since checks are derived
 * from clocks our own interrupt used to reset. The remaining refusals rest on
 * directly observable work — a tool running, a live child process, an inactive
 * run with nothing to recover — so escalating them would destroy healthy turns.
 */
const ESCALATABLE_REFUSALS: ReadonlySet<PostCompletionStallRefusal> = new Set([
	"subagent-work-pending",
	"within-grace",
	"event-since-terminal",
]);

/** Whether a repeatedly refused stall check should recover anyway. */
export function shouldEscalateStallRefusal(
	refusal: PostCompletionStallRefusal | null,
	streak: number
): boolean {
	if (refusal === null) return false;
	if (!ESCALATABLE_REFUSALS.has(refusal)) return false;
	return streak >= STALL_ESCALATION_SWEEPS;
}

/** Completion evidence recovered from a transcript instead of from events. */
export interface TranscriptCompletionEvidence {
	/** Epoch ms of the assistant message that ended the turn. */
	terminalAt: number;
	/** Stop reason recorded for that message. */
	stopReason: string;
}

/**
 * Recover the completion marker from the transcript.
 *
 * The event that set the marker is in-process memory, so a restart, a recreated
 * session, or a marker erased earlier loses it. The transcript is durable and is
 * the same ground truth the orphan watchdog already reads: if its newest
 * meaningful record is an assistant message with a terminal stop reason, then the
 * turn's last message is on disk and nothing has happened since — the marker's
 * exact meaning.
 *
 * Returns null when the newest meaningful record is anything else (a later user
 * message, a notify, a tool record) or when the assistant message ended in a
 * tool batch, which continues the turn.
 */
export function deriveTranscriptCompletionEvidence(tail: TranscriptTail): TranscriptCompletionEvidence | null {
	if (tail.lastMeaningfulKind !== "assistant") return null;
	if (tail.lastAssistantTerminal !== true) return null;
	if (tail.lastAssistantAt === undefined) return null;
	return { terminalAt: tail.lastAssistantAt, stopReason: tail.lastAssistantStopReason ?? "stop" };
}

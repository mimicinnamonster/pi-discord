/**
 * Wake the channel when a background completion notice is orphaned.
 *
 * pi-subagents reports an async run by writing a `subagent-notify` record into
 * the transcript and then delivering it through the live process. When that
 * process is gone — a restart while the workflow was still running — the record
 * lands and nothing else happens: no turn starts, and the bot stays silent until
 * a human prompts it. Observed live: the notice was persisted at 20:37:38.864Z
 * and the next turn only began at 21:02:08, when the user typed "status?".
 *
 * The transcript itself is the ground truth for "was this announced?", so the
 * detection reads it: a notify record with no assistant message after it, or a
 * finished run whose end is newer than everything the transcript recorded. The
 * wake decision is pure so the boundary cases (metadata records, a notify that
 * was answered, a still-running child) are testable without a live session.
 */

import { closeSync, openSync, readSync, statSync } from "fs";

/**
 * Grace before an orphan is considered announced-and-lost.
 *
 * The healthy path wakes the bot within ~100 ms of the notify being written, so
 * anything above a few seconds is already abnormal. Two minutes keeps the
 * watchdog from racing a slow-but-working delivery while still reacting long
 * before a human would notice the silence.
 */
export const ORPHAN_MIN_AGE_MS = 120_000;

/**
 * How old an orphan may be and still be worth resuming.
 *
 * Beyond a day the completion is history: waking the bot with it would post a
 * stale report into the channel, which is worse than staying quiet until the
 * next user message.
 */
export const MAX_ORPHAN_AGE_MS = 24 * 60 * 60_000;

/** Bytes read from the end of a transcript. A tail, not the whole file. */
export const TRANSCRIPT_TAIL_BYTES = 128 * 1024;

/** Custom record type pi-subagents writes for completion/failure notices. */
export const SUBAGENT_NOTIFY_TYPE = "subagent-notify";

/** Transcript record types that carry no conversational meaning. */
const METADATA_TYPES: ReadonlySet<string> = new Set([
	"session",
	"session_info",
	"model_change",
	"thinking_level_change",
	"compaction",
	"branch",
	"branch_summary",
	"label",
	"custom_state",
	"thinking_level",
]);

/** How much of a notify's text is kept for the wake prompt. */
const NOTIFY_EXCERPT_CHARS = 400;

export type TranscriptKind = "assistant" | "user" | "notify" | "other";

/** What the end of a channel's transcript says about its last turn. */
export interface TranscriptTail {
	/** Kind of the newest record that carries meaning, ignoring metadata. */
	lastMeaningfulKind?: TranscriptKind;
	/** Epoch ms of that record. */
	lastMeaningfulAt?: number;
	/** Epoch ms of the newest assistant message. */
	lastAssistantAt?: number;
	/** Epoch ms of the newest subagent notification. */
	lastNotifyAt?: number;
	/** Excerpt of that notification, for the wake prompt. */
	lastNotifyContent?: string;
	/** Lines that could not be parsed; a corrupt tail is skipped, not trusted. */
	unparseableLines: number;
	/** Meaningful records seen in the tail, newest last. */
	meaningfulCount: number;
}

/** A run in this channel that has already terminalised. */
export interface FinishedRunRef {
	runId: string;
	state: string;
	/** Epoch ms the run ended (or last wrote its status). */
	endedAt?: number;
	/** False when the recorded pid no longer exists; `undefined` when unknown. */
	pidAlive?: boolean;
	/** Whether a result payload exists for the run. */
	hasResult?: boolean;
}

export type OrphanRefusal =
	| "no-orphan"
	| "too-recent"
	| "too-old"
	| "no-timestamp"
	| "already-woken"
	| "run-still-live";

export interface OrphanCompletionInput {
	channelId: string;
	tail: TranscriptTail;
	/** Newest terminalised run in this channel, if the store knows one. */
	finishedRun?: FinishedRunRef;
	now: number;
	/** Injectable for tests; defaults to ORPHAN_MIN_AGE_MS. */
	minAgeMs?: number;
	maxAgeMs?: number;
	/** Idempotency check over previously woken keys. */
	isWoken: (key: string) => boolean;
}

export interface OrphanCompletionDecision {
	orphan: boolean;
	refusal: OrphanRefusal | null;
	/** Idempotency key: one wake per notify record / finished run. */
	key?: string;
	runId?: string;
	state?: string;
	/** Epoch ms of the event that should have woken the channel. */
	wakeAt?: number;
	/** `notify` when a delivered-but-ignored notice was found, `run` otherwise. */
	detectedBy?: "notify" | "run";
}

/** A single transcript record, reduced to what the decision needs. */
interface ParsedRecord {
	kind: TranscriptKind;
	at: number;
	content?: string;
}

/**
 * Parse transcript JSONL into a tail summary.
 *
 * Malformed lines are counted and skipped: a half-written last line is the
 * normal outcome of reading a live transcript, and throwing on it would disable
 * the watchdog exactly while it is needed.
 */
export function parseTranscriptTail(text: string): TranscriptTail {
	const tail: TranscriptTail = { unparseableLines: 0, meaningfulCount: 0 };
	const lines = text.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let record: ParsedRecord | null;
		try {
			record = parseRecord(trimmed);
		} catch {
			record = null;
		}
		if (record === null) {
			tail.unparseableLines++;
			continue;
		}
		tail.meaningfulCount++;
		if (tail.lastMeaningfulAt === undefined || record.at >= tail.lastMeaningfulAt) {
			tail.lastMeaningfulKind = record.kind;
			tail.lastMeaningfulAt = record.at;
		}
		if (record.kind === "assistant" && (tail.lastAssistantAt === undefined || record.at >= tail.lastAssistantAt)) {
			tail.lastAssistantAt = record.at;
		}
		if (record.kind === "notify" && (tail.lastNotifyAt === undefined || record.at >= tail.lastNotifyAt)) {
			tail.lastNotifyAt = record.at;
			tail.lastNotifyContent = record.content;
		}
	}
	return tail;
}

function parseRecord(line: string): ParsedRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, any>;
	const type = typeof record.type === "string" ? record.type : "";
	if (!type || METADATA_TYPES.has(type)) return null;

	const at = parseTimestamp(record.timestamp ?? record.ts);
	if (at === null) return null;

	if (type === "custom_message") {
		const customType = typeof record.customType === "string" ? record.customType : "";
		if (customType === SUBAGENT_NOTIFY_TYPE) {
			return { kind: "notify", at, content: excerpt(record.content) };
		}
		return { kind: "other", at };
	}
	if (type === "message") {
		const role = record.message?.role;
		if (role === "assistant") return { kind: "assistant", at };
		if (role === "user") return { kind: "user", at };
		return { kind: "other", at };
	}
	return { kind: "other", at };
}

function parseTimestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return null;
}

function excerpt(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length > NOTIFY_EXCERPT_CHARS ? `${trimmed.slice(0, NOTIFY_EXCERPT_CHARS)}…` : trimmed;
}

/**
 * Read the end of a transcript file.
 *
 * Returns an empty string for a missing file: a channel with no transcript is
 * simply not a candidate.
 */
export function readTranscriptTail(filePath: string, maxBytes: number = TRANSCRIPT_TAIL_BYTES): string {
	let fd: number | undefined;
	try {
		fd = openSync(filePath, "r");
		const size = statSync(filePath).size;
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		if (length <= 0) return "";
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, start);
		const text = buffer.toString("utf-8");
		// A slice from the middle starts mid-record; that line is not parseable.
		return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Already closed; nothing to do.
			}
		}
	}
}

/** Whether a run state means the run will not produce more work. */
export function isFinishedRunState(state: string): boolean {
	return state !== "queued" && state !== "running" && state !== "paused";
}

/**
 * Decide whether this channel is owed a wake.
 *
 * Two shapes, in priority order:
 *  - a `subagent-notify` record with nothing meaningful after it (the notice was
 *    written and never turned into a turn — the owner-process-death case);
 *  - a finished run whose end is newer than everything the transcript recorded
 *    (the completion was never announced at all).
 *
 * Both are only acted on once the grace period has passed, and both are keyed so
 * a restart cannot wake the same completion twice.
 */
export function isOrphanCompletion(input: OrphanCompletionInput): OrphanCompletionDecision {
	const { tail, finishedRun, now } = input;
	const minAgeMs = input.minAgeMs ?? ORPHAN_MIN_AGE_MS;
	const maxAgeMs = input.maxAgeMs ?? MAX_ORPHAN_AGE_MS;

	const notifyOrphan =
		tail.lastMeaningfulKind === "notify" && tail.lastNotifyAt !== undefined
			? {
					key: `notify:${tail.lastNotifyAt}`,
					wakeAt: tail.lastNotifyAt,
					detectedBy: "notify" as const,
				}
			: undefined;

	const runOrphan =
		finishedRun &&
		tail.lastMeaningfulAt !== undefined &&
		finishedRun.endedAt !== undefined &&
		finishedRun.endedAt > tail.lastMeaningfulAt
			? {
					key: `run:${finishedRun.runId}`,
					wakeAt: finishedRun.endedAt,
					detectedBy: "run" as const,
				}
			: undefined;

	const candidate = notifyOrphan ?? runOrphan;
	if (!candidate) {
		return { orphan: false, refusal: "no-orphan", detectedBy: notifyOrphan ? "notify" : undefined };
	}

	if (input.isWoken(candidate.key)) {
		return { orphan: false, refusal: "already-woken", key: candidate.key, detectedBy: candidate.detectedBy };
	}

	const ageMs = now - candidate.wakeAt;
	if (ageMs < minAgeMs) {
		return {
			orphan: false,
			refusal: "too-recent",
			key: candidate.key,
			wakeAt: candidate.wakeAt,
			detectedBy: candidate.detectedBy,
		};
	}
	if (ageMs > maxAgeMs) {
		return {
			orphan: false,
			refusal: "too-old",
			key: candidate.key,
			wakeAt: candidate.wakeAt,
			detectedBy: candidate.detectedBy,
		};
	}

	// A finished run whose runner is still alive is finishing its own cleanup; the
	// notice (if any) is still coming, so waking now would duplicate it.
	if (candidate.detectedBy === "run" && finishedRun?.pidAlive === true) {
		return {
			orphan: false,
			refusal: "run-still-live",
			key: candidate.key,
			wakeAt: candidate.wakeAt,
			detectedBy: candidate.detectedBy,
		};
	}

	return {
		orphan: true,
		refusal: null,
		key: candidate.key,
		runId: finishedRun?.runId,
		state: finishedRun?.state,
		wakeAt: candidate.wakeAt,
		detectedBy: candidate.detectedBy,
	};
}

export interface BuildWakePromptInput {
	runId?: string;
	state?: string;
	wakeAt: number;
	/** False when the run left no result file; the prompt must say so. */
	resultAvailable: boolean;
	/** Excerpt of the notice that never turned into a turn. */
	notifyContent?: string;
}

/**
 * Prompt that makes the bot react to a completion it never saw.
 *
 * It states only what is on disk: the run id and state when the store has them,
 * the notice excerpt when there is one, and whether a result payload exists. The
 * instruction is to continue, not to summarise a result that may be missing.
 */
export function buildWakePrompt(input: BuildWakePromptInput): string {
	const when = new Date(input.wakeAt).toISOString();
	const parts: string[] = [
		"A background subagent task finished, but its completion notice never reached you — no turn started, " +
			"so this is your first chance to react to it.",
	];
	parts.push(
		input.runId
			? `Run: ${input.runId} (${input.state ?? "unknown state"}), ended ${when}.`
			: `Notice written ${when}.`
	);
	parts.push(
		input.resultAvailable
			? "Its result payload is on disk."
			: "No result payload exists for this run, so its output is unavailable."
	);
	if (input.notifyContent) {
		parts.push(`The notice it wrote:\n\n"""\n${input.notifyContent}\n"""`);
	}
	parts.push(
		"Continue from where the work left off: report the outcome to the channel, using the result if it is " +
			"available and saying plainly that it is unavailable if it is not. Do not ask the user to prompt you " +
			"again for this."
	);
	return parts.join("\n\n");
}

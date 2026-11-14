/**
 * pi-discord - Standalone Discord Bot
 * Discord integration for pi coding agent using the SDK
 */

import { Client, GatewayIntentBits, ChannelType, ThreadChannel, DMChannel, TextChannel, NewsChannel, Message } from "discord.js";
import { createSessionStore, sweepStaleBackgroundWork, type ClosedSessionInfo, type DiscordSession } from "./session-store.ts";
import { shouldInterruptForIncomingMessage } from "./interrupt-decision.ts";
import { evaluateStuckRun, evaluateStuckRunLiveness, DEFAULT_STUCK_RUN_THRESHOLD_MS, REQUIRED_CONFIRMING_SWEEPS, type StuckRunEvaluation } from "./stuck-run-decision.ts";
import {
	evaluatePostCompletionStall,
	isTerminalStopReason,
	POST_COMPLETION_STALL_GRACE_MS,
	type PostCompletionStallInput,
	type PostCompletionStallRefusal,
} from "./post-completion-stall.ts";
import { probeLiveChildProcesses, isProcessAlive } from "./child-process-probe.ts";
import {
	findResultPayload,
	formatOutstandingRuns,
	hasProgressingAsyncWork,
	listRunStatuses,
	summarizeRunStore,
} from "./subagent-run-store.ts";
import {
	buildWakePrompt,
	isFinishedRunState,
	isOrphanCompletion,
	parseTranscriptTail,
	readTranscriptTail,
	type FinishedRunRef,
	type OrphanCompletionDecision,
} from "./completion-orphans.ts";
import { createOrphanWakeStore, ORPHAN_WAKES_FILE } from "./orphan-wake-store.ts";
import { isNonRetryableModelError, retryHintForModelError } from "./retry-policy.ts";
import { splitMessagePreservingCodeBlocks, DISCORD_CHUNK_LIMIT } from "./message-chunker.ts";
import { STALE_ASYNC_WORK_TIMEOUT_MS } from "./subagent-gate.ts";
import { createPendingMessageStore, PENDING_MESSAGES_FILE } from "./pending-messages.ts";
import { saveChannelThinkingMode, setThinkingModeEnabled, isThinkingModeEnabled, loadChannelThinkingMode, DEFAULT_THINKING_MODE } from "./thinking-mode.ts";
import { TypingManager, type TypingChannel } from "./typing-manager.ts";
import { generateTokenStatsMessage } from "./token-stats.ts";
import type { AgentSession, AgentSessionEvent, SessionMessageEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { generateSummary, prepareBranchEntries } from "@earendil-works/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";
import { writeFileSync, readFileSync, existsSync, readdirSync, openSync, readSync, closeSync, statSync } from "fs";
import { Cron } from "croner";
import {
	decideCatchup,
	jobBelongsToChannel,
	jobNeedsRebind,
	type ScheduledJobLike,
} from "./schedule-catchup.ts";
import {
	loadBranchMetadata,
	saveBranchMetadata,
	findCommonAncestor,
	getMessagesBetween,
	formatMergedMessages,
} from "./branch-manager.ts";

// ============================================================================
// Configuration
// ============================================================================

const discordToken = process.env.DISCORD_BOT_TOKEN;
const debug = process.env.DISCORD_DEBUG === "true";
const sessionDir = process.env.PI_DISCORD_SESSION_DIR || join(homedir(), ".pi-discord", "sessions");

/**
 * Upper bound on how long an incoming message waits for the previous run to
 * abort. The SDK's abort() awaits waitForIdle(), which pi-subagents' agent_end
 * drain can hold open for up to 30 minutes; blocking message handling that long
 * is what made /exit and every follow-up appear ignored.
 */
const abortWaitTimeoutMs = Number(process.env.PI_DISCORD_ABORT_WAIT_MS) || 5_000;

/** How long /exit waits for a clean shutdown before forcing process exit. */
const shutdownHardExitTimeoutMs = Number(process.env.PI_DISCORD_SHUTDOWN_TIMEOUT_MS) || 3_000;

/**
 * Silence after which an active run is treated as wedged (see
 * src/stuck-run-decision.ts). Overridable so a canary can prove recovery works
 * without waiting 45 minutes.
 */
const stuckRunThresholdMs =
	Number(process.env.PI_DISCORD_STUCK_RUN_THRESHOLD_MS) || DEFAULT_STUCK_RUN_THRESHOLD_MS;

/**
 * Silence after a turn's final assistant message before it counts as stalled (see
 * src/post-completion-stall.ts). Overridable so a canary can prove the fast path
 * without waiting two minutes.
 */
const postCompletionStallGraceMs =
	Number(process.env.PI_DISCORD_POST_COMPLETION_STALL_MS) || POST_COMPLETION_STALL_GRACE_MS;

// ============================================================================
// Logging
// ============================================================================

function log(...args: unknown[]) {
	if (debug) {
		console.log(`[discord][${new Date().toISOString()}]`, ...args);
	}
}

// ============================================================================
// Validate Configuration
// ============================================================================

if (!discordToken) {
	console.error("[discord] ERROR: DISCORD_BOT_TOKEN environment variable is required");
	process.exit(1);
}

// ============================================================================
// Global State
// ============================================================================

let discordClient: Client | null = null;
const sessionStore = createSessionStore({ sessionDir, debug });
const typingManager = new TypingManager();

// ============================================================================
// Process resilience — scheduled prompts must survive process death
// (/kill, external kill, laptop battery, crashes). Log loudly and keep running:
// the session keeper below re-creates sessions and catches up any missed runs.
//
// One known-benign case is rate-limited instead: pi-schedule-prompt's CronWidget
// throws "extension ctx is stale after session replacement" every 30s for the
// lifetime of the process, which buries real errors in the journal.
// ============================================================================
const STALE_EXTENSION_CTX_PATTERN = "extension ctx is stale";
let staleExtensionCtxSuppressed = 0;

function isStaleExtensionCtxError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes(STALE_EXTENSION_CTX_PATTERN);
}

process.on("uncaughtException", (err) => {
	if (isStaleExtensionCtxError(err)) {
		staleExtensionCtxSuppressed++;
		if (staleExtensionCtxSuppressed % 100 === 1) {
			log(`[discord] Suppressed stale-extension-ctx exception (${staleExtensionCtxSuppressed} so far, benign)`);
		}
		return;
	}
	console.error("[discord] Uncaught exception (keeping bot alive):", err);
});
process.on("unhandledRejection", (reason) => {
	if (isStaleExtensionCtxError(reason)) {
		staleExtensionCtxSuppressed++;
		return;
	}
	console.error("[discord] Unhandled rejection (keeping bot alive):", reason);
});

// Track Discord message IDs to session entry indices for deletion handling
// Map structure: channelId -> discordMessageId -> { sessionIndex, type: 'user' | 'assistant' | 'tool' | 'thinking' }
const discordMessageToSession = new Map<string, Map<string, { sessionIndex: number; type: string }>>();
const sessionMessageIndex = new Map<string, number>(); // Track current message index per channel

// Epoch ms of the last SDK event per channel. The 60s self-heal sweep uses the
// gap together with isModelActive() to tell a wedged run (active but silent)
// from a healthy one: see src/stuck-run-decision.ts.
const lastSdkEventAt = new Map<string, number>();

// Consecutive confirming sweeps per channel. Cleared by every liveness signal,
// so recovery needs REQUIRED_CONFIRMING_SWEEPS silent sweeps in a row.
const stuckRunConfirmations = new Map<string, number>();

// Tool calls currently executing per channel (tool_execution_start -> end). A
// running tool emits no session event, so silence during one is work, not a
// wedge — the sweep refuses recovery while this is non-zero.
const inFlightToolCounts = new Map<string, number>();

/**
 * Epoch ms of the terminal assistant message that ended this channel's turn.
 *
 * Set on `message_end` for a terminal stop reason and deleted by every later
 * event, so its presence means "the turn's last message is on disk and nothing
 * has happened since" — the signature of a run whose settle path never finished.
 * See src/post-completion-stall.ts.
 */
const terminalMessageAt = new Map<string, number>();

/** Whether the event is the assistant message that ends a turn (not a tool batch). */
function isTerminalAssistantMessage(event: AgentSessionEvent): boolean {
	if (event.type !== "message_end") return false;
	if (event.message.role !== "assistant") return false;
	return isTerminalStopReason(event.message.stopReason);
}

/**
 * Record SDK activity for a channel.
 *
 * Every liveness signal goes through here so the watchdog's silence
 * measurement and its confirmation streak can never drift apart.
 */
function stampSdkActivity(channelId: string): void {
	lastSdkEventAt.set(channelId, Date.now());
	stuckRunConfirmations.delete(channelId);
}

/**
 * Pids of this process's live children, excluding the probe's own `ps` child
 * and any zombie children.
 *
 * The last-resort liveness probe before the watchdog destroys a session: sync
 * subagent runs and process-tool commands are real child processes, and their
 * silence must never be read as a wedge even if the gate accounting were wrong.
 *
 * An empty list is also returned when `ps` is unavailable — the event/tool/
 * subagent gates still apply, and refusing to recover at all would restore the
 * wedge this watchdog exists to clear.
 */
async function findLiveChildPids(): Promise<number[]> {
	return probeLiveChildProcesses();
}

// The run store is a diagnostic, so an unresolvable one must be reported once
// rather than on every recovery attempt (a sweep can hit several channels).
let runStoreUnavailableLogged = false;

/**
 * Log which subagent runs are outstanding before a session is torn down.
 *
 * The watchdog's own reason string describes the parent (idle, stalled) but not
 * the child that pinned it. An outstanding run with a live pid and a growing age
 * is the signature of a runner that never terminalised its status, which is what
 * keeps the drain — and therefore the settle path — waiting.
 *
 * Never throws and never blocks: a failed snapshot must not cost the recovery
 * that is already justified.
 */
function logOutstandingSubagentRuns(channelId: string): void {
	try {
		const summary = summarizeRunStore();
		if (summary.error) {
			if (runStoreUnavailableLogged) return;
			runStoreUnavailableLogged = true;
			console.warn(`[watchdog] ${channelId} ${formatOutstandingRuns([])} (store unavailable: ${summary.error})`);
			return;
		}
		console.warn(`[watchdog] ${channelId} ${formatOutstandingRuns(summary.runs)}`);
	} catch (err) {
		if (runStoreUnavailableLogged) return;
		runStoreUnavailableLogged = true;
		console.warn(`[watchdog] ${channelId} ${formatOutstandingRuns([])} (snapshot failed: ${String(err)})`);
	}
}

/**
 * How often a refusing stall check may repeat its snapshot for one channel.
 *
 * The sweep runs every 60s and a legitimate drain can hold for 30 minutes, so an
 * unthrottled line would be noise exactly when nothing is wrong. Five minutes
 * keeps a wedged channel visible without burying the journal.
 */
const STALL_REFUSAL_LOG_INTERVAL_MS = 5 * 60_000;

/** Last time each channel logged a refused stall check, for the throttle above. */
const stallRefusalLoggedAt = new Map<string, number>();

/**
 * Log why the stall fast path refused, with the run snapshot.
 *
 * Only the subagent gate is logged: every other refusal rests on something
 * directly observable (a tool, a pid, a timestamp), while this one rests on
 * pi-subagents' bookkeeping — the one input that can be wrong, and the one that
 * produced a silent 45-minute non-recovery on the server.
 */
function logStallRefusal(channelId: string, refusal: PostCompletionStallRefusal): void {
	if (refusal !== "subagent-work-pending") return;
	const now = Date.now();
	const last = stallRefusalLoggedAt.get(channelId) ?? 0;
	if (now - last < STALL_REFUSAL_LOG_INTERVAL_MS) return;
	stallRefusalLoggedAt.set(channelId, now);
	try {
		const summary = summarizeRunStore();
		const snapshot = summary.error
			? `${formatOutstandingRuns([])} (store unavailable: ${summary.error})`
			: formatOutstandingRuns(summary.runs);
		console.warn(`[watchdog] ${channelId} stall check refused by ${refusal} - ${snapshot}`);
	} catch (err) {
		console.warn(`[watchdog] ${channelId} stall check refused by ${refusal} (snapshot failed: ${String(err)})`);
	}
}


// Track the last thinking message ID per channel for editing
const lastThinkingMessageId = new Map<string, string>();

// Track previous token counts per channel for utilization alerts
const previousTokens = new Map<string, { contextPercent: number; inputTokens: number; outputTokens: number }>();

// Track queued prompts per channel (persisted to disk)
const promptQueue = new Map<string, string[]>();

// User messages parked because the channel was still draining background
// subagent work. Persisted to disk so a wedged run (or a restart) cannot lose
// them; entries are removed once the message shows up in the session.
const pendingMessages = createPendingMessageStore(join(sessionDir, PENDING_MESSAGES_FILE));

//
// Background completions already announced by the orphan watchdog. Persisted so a
// restart cannot wake the same completion twice and post its report again.
// See src/completion-orphans.ts.
const orphanWakes = createOrphanWakeStore(join(sessionDir, ORPHAN_WAKES_FILE));

// Track active session labels per channel (set via /label or /session [label])
const sessionLabels = new Map<string, string>();

// ============================================================================
// Per-channel output visibility settings (/hide, /show) — persisted to disk
// ============================================================================

interface ChannelOutputSettings {
	hideThinking: boolean;
	hideTools: boolean;
	hideThinkingMode: boolean;
}

const channelOutputSettings = new Map<string, ChannelOutputSettings>();

function getChannelOutputSettings(channelId: string): ChannelOutputSettings {
	let settings = channelOutputSettings.get(channelId);
	if (!settings) {
		settings = { hideThinking: false, hideTools: false, hideThinkingMode: false };
		channelOutputSettings.set(channelId, settings);
	}
	return settings;
}

function saveChannelOutputSettings(): void {
	try {
		const obj: Record<string, ChannelOutputSettings> = {};
		for (const [ch, s] of channelOutputSettings) {
			if (s.hideThinking || s.hideTools || s.hideThinkingMode) obj[ch] = s;
		}
		writeFileSync(join(sessionDir, "channel-output-settings.json"), JSON.stringify(obj, null, 2));
	} catch {}
}

function loadChannelOutputSettings(): void {
	try {
		const path = join(sessionDir, "channel-output-settings.json");
		if (existsSync(path)) {
			const obj = JSON.parse(readFileSync(path, "utf-8"));
			for (const [ch, s] of Object.entries(obj)) {
				const raw = s as Record<string, unknown>;
				channelOutputSettings.set(ch, {
					hideThinking: raw.hideThinking === true,
					hideTools: raw.hideTools === true,
					hideThinkingMode: raw.hideThinkingMode === true,
				});
			}
		}
	} catch {}
}

function savePromptQueue(): void {
	try {
		const obj: Record<string, string[]> = {};
		for (const [ch, q] of promptQueue) {
			if (q.length > 0) obj[ch] = q;
		}
		writeFileSync(join(sessionDir, "queues.json"), JSON.stringify(obj, null, 2));
	} catch {}
}

function loadPromptQueue(): void {
	try {
		const path = join(sessionDir, "queues.json");
		if (existsSync(path)) {
			const obj = JSON.parse(readFileSync(path, "utf-8"));
			for (const [ch, q] of Object.entries(obj)) {
				promptQueue.set(ch, q as string[]);
			}
		}
	} catch {}
}

/** Build a map of session UUID → channel ID by scanning Discord session files. */
function buildSessionChannelMap(): Map<string, string> {
	const uuidToChannel = new Map<string, string>();
	const sessionDir = join(homedir(), ".pi-discord", "sessions");
	if (!existsSync(sessionDir)) return uuidToChannel;
	try {
		for (const file of readdirSync(sessionDir)) {
			const match = file.match(/^discord-(\d+)\.jsonl$/);
			if (!match) continue;
			const chId = match[1];
			try {
				const firstLine = readFileSync(join(sessionDir, file), "utf-8").split("\n")[0];
				const meta = JSON.parse(firstLine);
				if (meta.id) uuidToChannel.set(meta.id, chId);
			} catch {}
		}
	} catch {}
	return uuidToChannel;
}

/**
 * Channels whose "binding already current" debug line has been logged, so the
 * 60s keeper does not repeat it for every job on every tick.
 */
const bindSkipLogged = new Set<string>();

/**
 * Point every job of a Discord channel at the channel's LIVE session UUID.
 *
 * The live runtime id (`getSessionStats().sessionId`) is the only source of
 * truth: it is exactly what pi-schedule-prompt compares against at fire time
 * (scheduler.ts:61, :205-211), and a mismatch makes it return silently, with
 * no log anywhere.
 *
 * Writes only when the stored id differs. Rewriting an equal id would be a
 * no-op for correctness but a write race for the scheduler: it arms the cron
 * against the id it loaded, and the store being touched after that point is
 * what used to orphan jobs on every restart.
 *
 * Returns true when the store was modified.
 */
function setChannelJobsSessionSync(channelId: string, sessionId: string): boolean {
	const path = join(process.cwd(), ".pi", "schedule-prompts.json");
	if (!existsSync(path)) return false;
	try {
		const data = JSON.parse(readFileSync(path, "utf-8"));
		const jobs: ScheduledJobLike[] = data.jobs || [];
		let dirty = false;
		let loggedSkip = false;
		for (const job of jobs) {
			if (!jobBelongsToChannel(job, channelId)) continue;
			if (!jobNeedsRebind(job, channelId, sessionId)) {
				if (!loggedSkip) loggedSkip = true;
				continue;
			}
			job.session = sessionId;
			dirty = true;
			console.log(`[discord] Bound job ${job.name || job.id} to session ${sessionId} for channel ${channelId}`);
		}
		if (dirty) {
			writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
		}
		if (!dirty && loggedSkip) {
			const key = `${channelId}:${sessionId}`;
			if (!bindSkipLogged.has(key)) {
				bindSkipLogged.add(key);
				console.log(`[discord] Job binding already current for channel ${channelId} (session ${sessionId}) - no write`);
			}
		}
		return dirty;
	} catch {}
	return false;
}

/**
 * Rebind all scheduled jobs for a channel to the channel's live session UUID.
 * Called after any operation that replaces/recreates the session (/session,
 * /compact, /clear, /resume, /cwd) and every 60s by the session keeper as a
 * self-heal. A stale binding (job.session pointing at a replaced session) is
 * silently skipped by BOTH the pi-schedule-prompt extension (isLoadedFor) and
 * the keeper's catch-up, so leaving it stale means the job never fires again.
 */
function rebindChannelJobsToLiveSession(channelId: string): void {
	const discordSession = sessionStore.get(channelId);
	if (!discordSession) return;
	const sessionId = discordSession.session.getSessionStats().sessionId;
	if (setChannelJobsSessionSync(channelId, sessionId)) {
		console.log(`[discord] Rebound scheduled jobs to live session ${sessionId} for channel ${channelId}`);
	}
}

/**
 * Restore sessions for channels with scheduled prompts.
 *
 * On startup, reads schedule-prompts.json, creates Discord sessions for every
 * channel with a scheduled job so the pi-schedule-prompt scheduler has a live
 * session to fire into, and then binds each job to that session's runtime id.
 *
 * CRITICAL: never bind from the on-disk session file's meta id. That is a
 * second source of truth for the same value and the two disagree whenever a
 * session is recreated; the scheduler compares the stored id against the live
 * one at fire time (scheduler.ts:61, :205-211) and skips silently on mismatch.
 * Binding happens once, after the session exists, from the live id only.
 *
 * Also never bind before the session exists: `job.session` must not be deleted
 * (undefined makes the job fire in ALL channels, isLoadedFor returns true).
 */
function restoreScheduledSessions(): void {
	try {
		const path = join(process.cwd(), ".pi", "schedule-prompts.json");
		if (!existsSync(path)) return;

		const data = JSON.parse(readFileSync(path, "utf-8"));
		const jobs: any[] = data.jobs || [];
		if (jobs.length === 0) return;

		// Build UUID → channelId map from existing Discord sessions
		const uuidToChannel = buildSessionChannelMap();

		let dirty = false;
		const channelsToCreate = new Set<string>();

		for (const job of jobs) {
			// --- Resolve channel from description (persisted format) ---
			const descMatch = job.description?.match(/^channel:(\d+)/);
			if (descMatch) {
				channelsToCreate.add(descMatch[1]);
			}

			// --- Resolve channel from session UUID ---
			if (job.session) {
				const chId = uuidToChannel.get(job.session);
				if (chId) {
					channelsToCreate.add(chId);
					// Persist the channel association so we don't need the UUID next time
					if (!job.description?.startsWith("channel:")) {
						job.description = `channel:${chId} - ${job.description || "auto"}`;
						dirty = true;
					}
					// Keep job.session — the session file still exists with this UUID.
					// getOrCreate() below will open the existing file, preserving the UUID.
				} else if (descMatch) {
					// Stale session UUID, but the job is routable by channel. Keep the
					// stale id in the file for now (deleting it would make the job fire
					// in every channel); it is rewritten from the live id below, after
					// the channel's session has been created.
				} else {
					// No channel info at all — truly orphaned session reference.
					// Safe to delete because there's no way to route it.
					delete job.session;
					dirty = true;
				}
			} else if (descMatch) {
				// Job has channel info but no session field. Leave it unbound until
				// the live session exists: binding from the on-disk file id here is
				// what created the second source of truth. The scheduler re-reads the
				// store at fire time, so binding after creation is sufficient.
			}
		}

		// Save ONLY if we have non-stale updates (description changes, orphaned sessions cleared)
		// Do NOT save stale-session deletions — we'll update those after creating sessions.
		if (dirty) {
			writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
			console.log(`[discord] Prepared session references, identified ${channelsToCreate.size} channel(s) for scheduled prompts`);
		}

		// Now create sessions for all identified channels, then bind each job to
		// the session's live runtime id. A single creation pass - the old code
		// disposed and re-created the session twice to "pick up" the rebind,
		// which minted a new UUID on every pass and never converged.
		const promises: Array<Promise<void>> = [];
		for (const chId of channelsToCreate) {
			console.log(`[discord] Pre-creating session for scheduled channel ${chId}`);
			const p = sessionStore.getOrCreate(chId).then((discordSession) => {
				const sessionId = discordSession.session.getSessionStats().sessionId;
				setChannelJobsSessionSync(chId, sessionId);
			}).catch((err) => {
				console.error(`[discord] Failed to pre-create session for ${chId}:`, err);
			});
			promises.push(p);
		}

		Promise.all(promises).then(() => {
			if (dirty) {
				try {
					writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
					console.log(`[discord] Saved job session bindings`);
				} catch {}
			}
		}).catch(() => {});
	} catch {}
}

/**
 * Periodically ensure that every enabled cron job has a live Discord session.
 *
 * pi-schedule-prompt only fires while a session is open in this directory.
 * Since pi-discord creates sessions on-demand when users chat, cron jobs at
 * quiet hours would be silently skipped. This keeper checks every 60 seconds
 * and creates sessions for any channel that has an enabled scheduled job but
 * no active session.
 *
 * CRITICAL: Never deletes `job.session` first — setting it to undefined makes
 * the job fire in ALL channels (isLoadedFor returns true for everyone) — and
 * never binds from the on-disk session file either. The session is created once
 * per channel and the job is then bound to that session's live runtime id; the
 * scheduler re-reads the store at fire time, so it does not need to be re-armed
 * for a rebind to take effect.
 */
function startSessionKeeper(deps: {
	subscribedSessions: Set<string>;
	sessionSubscriptions: Map<string, SessionSubscription>;
	/** Channels currently being rebuilt by the stale-run watchdog. */
	recoveringChannels: Set<string>;
}): void {
	/**
	 * Ensure the channel's session is subscribed so agent output (from the
	 * extension's on-time fires AND our catch-up fires) is forwarded to Discord.
	 * Subscriptions normally only exist after a user message; without this,
	 * a keeper-created session's scheduled run would be invisible.
	 */
	async function ensureCronSubscription(chId: string): Promise<void> {
		const discordSession = sessionStore.get(chId);
		if (!discordSession) return;
		const sessionId = discordSession.session.getSessionStats().sessionId;
		if (cronSubscribedSessions.get(chId) === sessionId) return;
		// The channel's session may already be subscribed from a user message
		// (handleMessage) — subscribeToSession appends a listener without dedup,
		// so subscribing again would make every agent event fire TWICE and the
		// user would receive every thinking block / response / tool message
		// twice. If a subscription already exists, just record the binding for
		// this pass and move on.
		if (deps.subscribedSessions.has(chId)) {
			cronSubscribedSessions.set(chId, sessionId);
			return;
		}
		// The watchdog is midway through replacing this channel's session; it
		// re-subscribes when it finishes, so subscribing here would add a second
		// listener and post every event twice.
		if (deps.recoveringChannels.has(chId)) return;
		const channel = await fetchChannelObject(chId);
		if (!channel) return;
		try {
			const sub = subscribeToSession(discordSession.session, chId, channel, typingManager, sessionDir, getChannelOutputSettings);
			deps.sessionSubscriptions.set(chId, sub);
			deps.subscribedSessions.add(chId);
			cronSubscribedSessions.set(chId, sessionId);
			console.log(`[discord] Subscribed cron session for channel ${chId} (session ${sessionId})`);
		} catch (err) {
			console.error(`[discord] Failed to subscribe cron session for channel ${chId}:`, err);
		}
	}

	/**
	 * Fire any scheduled job whose fire time was missed (bot was down: /kill,
	 * crash, deploy restart, laptop off). This is what makes the schedule
	 * survive process death — the extension only fires while its session is
	 * alive and has loaded the job; the bot catches up the rest.
	 *
	 * Due slots are computed from the cron expression (see schedule-catchup.ts),
	 * NOT from `nextRun`: pi-schedule-prompt only persists `nextRun` after a
	 * successful fire, so gating on it made a never-fired job impossible to
	 * catch up, forever.
	 */
	const catchupInFlight = new Set<string>();
	const catchupSkipLogged = new Set<string>();

	async function fireMissedScheduledJobs(chId: string, jobs: any[]): Promise<void> {
		const discordSession = sessionStore.get(chId);
		if (!discordSession) return;
		const sessionId = discordSession.session.getSessionStats().sessionId;
		const now = Date.now();

		for (const job of jobs) {
			const decision = decideCatchup(job, { nowMs: now });

			if (decision.action === "none") {
				// Only the never-fired case is worth a line: that is the state the
				// old `!job.nextRun` gate hid completely, and it is the one that
				// looks like "the scheduler is broken" from the outside.
				if (!job.nextRun && decision.reason !== "disabled" && decision.reason !== "not-cron" && !catchupSkipLogged.has(job.id)) {
					catchupSkipLogged.add(job.id);
					console.log(
						`[discord] Catch-up: job "${job.name}" (${job.id}) not fired - reason=${decision.reason}, ` +
						`anchor=${decision.anchor?.source ?? "none"}${decision.anchor?.anchorMs ? ` (${new Date(decision.anchor.anchorMs).toISOString()})` : ""}`,
					);
				}
				continue;
			}

			// Session-bound jobs only fire in their own session (same rule as
			// pi-schedule-prompt's isLoadedFor).
			if (job.session && job.session !== sessionId) {
				console.log(`[discord] Catch-up: job "${job.name}" (${job.id}) is bound to ${job.session}, not this session ${sessionId} - skipping`);
				continue;
			}

			// Two overlapping sweeps (60s tick + initial run) must not double-fire.
			if (catchupInFlight.has(job.id)) continue;
			catchupInFlight.add(job.id);

			const slot = decision.slot!;
			const missed = decision.missedSlots ?? 1;
			console.log(
				`[discord] Catching up missed scheduled job "${job.name}" (${job.id}) for channel ${chId}: ` +
				`${missed} slot(s) since ${decision.anchor?.source ?? "unknown"}, firing the most recent (${slot.toISOString()})`,
			);

			// Advance BEFORE delivering so a crash in between cannot re-fire the
			// same slot: lastRun is set to the SLOT time (not now), so the next
			// tick sees no due slot. Older missed slots are coalesced into this
			// one rather than dumped into the channel as a burst of stale runs.
			const nextRun = getNextCronRun(job.schedule) ?? new Date(now + 24 * 3600 * 1000).toISOString();
			updateScheduledJob(job.id, {
				lastRun: slot.toISOString(),
				lastStatus: "success",
				runCount: (job.runCount ?? 0) + 1,
				nextRun,
			});

			const channel = await fetchChannelObject(chId);
			if (channel) {
				sendToDiscord(
					channel,
					`⏰ Running scheduled job **"${job.name}"** — was scheduled for ${slot.toLocaleString("en-GB", { timeZone: "Europe/Amsterdam" })}, executing now (it missed its scheduled time — e.g. the bot was offline or the session was recreated).`,
				).catch(() => {});
			}

			// Inject the prompt into the session; the cron subscription forwards
			// the agent's response to Discord.
			discordSession.session.sendUserMessage([{ type: "text", text: job.prompt }]).catch((err) => {
				console.error(`[discord] Failed to deliver scheduled prompt ${job.id}:`, err);
				// Delivery failed — roll lastRun back so the next tick retries.
				updateScheduledJob(job.id, { lastStatus: "error", lastRun: job.lastRun, nextRun: job.nextRun });
			}).finally(() => {
				catchupInFlight.delete(job.id);
			});
		}
	}

	/**
	 * One full scheduled-check pass: ensure sessions exist for channels with
	 * enabled jobs, subscribe them, and catch up any missed runs.
	 */
	async function runScheduledCheck(): Promise<void> {
		const path = join(process.cwd(), ".pi", "schedule-prompts.json");
		if (!existsSync(path)) return;

		const data = JSON.parse(readFileSync(path, "utf-8"));
		const jobs: any[] = data.jobs || [];

		// Map channel -> enabled jobs, and which channels still need a session.
		const channelJobs = new Map<string, any[]>();
		const channelsNeeded = new Set<string>();
		for (const job of jobs) {
			if (!job.enabled) continue;
			const descMatch = job.description?.match(/^channel:(\d+)/);
			if (!descMatch) continue;
			const chId = descMatch[1];
			if (!channelJobs.has(chId)) channelJobs.set(chId, []);
			channelJobs.get(chId)!.push(job);
			if (!sessionStore.has(chId)) channelsNeeded.add(chId);
		}
		if (channelJobs.size === 0) return;

		// --- Create sessions for channels that don't have one ---
		// One creation pass per channel, then bind the job to the live runtime id.
		// The old flow pre-bound from the on-disk file id and then disposed and
		// re-created the session to "pick up" the rebind, which minted a fresh
		// UUID each pass and left the store rewritten after the cron was armed.
		for (const chId of channelsNeeded) {
			try {
				const discordSession = await sessionStore.getOrCreate(chId);
				const sessionId = discordSession.session.getSessionStats().sessionId;
				setChannelJobsSessionSync(chId, sessionId);
				console.log(`[discord] Session keeper: created session for channel ${chId} (session ${sessionId})`);
			} catch (err) {
				console.error(`[discord] Session keeper: failed to create session for ${chId}:`, err);
			}
		}

		// --- Rebind stale bindings, subscribe, and catch up missed runs ---
		for (const [chId, channelJobsArr] of channelJobs) {
			// Self-heal: if the channel's live session UUID drifted from the jobs'
			// binding (any /session, /compact, /clear, /resume, /cwd or crash can
			// orphan them), rebind now — otherwise BOTH the extension (isLoadedFor)
			// and the catch-up below silently skip the job forever.
			rebindChannelJobsToLiveSession(chId);
			// Re-read jobs so fireMissedScheduledJobs sees the corrected binding.
			let freshJobs: any[] = channelJobsArr;
			try {
				const fresh = JSON.parse(readFileSync(path, "utf-8"));
				freshJobs = (fresh.jobs || []).filter((j: any) => j.description?.startsWith(`channel:${chId}`));
			} catch {}
			await ensureCronSubscription(chId);
			await fireMissedScheduledJobs(chId, freshJobs);
		}
	}

	// Run once shortly after startup so missed runs (crash, /kill, battery
	// death) fire soon after the bot comes back — no need to wait for the
	// first 60s tick.
	setTimeout(() => {
		runScheduledCheck().catch((err) => console.error(`[discord] Initial scheduled check error:`, err));
	}, 10_000);

	setInterval(() => {
		runScheduledCheck().catch((err) => console.error(`[discord] Session keeper error:`, err));
	}, 60_000);
}

/**
 * Cached Discord channel objects for cron delivery (avoids repeated fetches).
 */
const cronChannelCache = new Map<string, DMChannel | TextChannel | NewsChannel>();

/**
 * channelId -> sessionId that the cron subscription is currently bound to.
 */
const cronSubscribedSessions = new Map<string, string>();

/**
 * Fetch (and cache) the Discord channel object for a channel ID.
 */
async function fetchChannelObject(chId: string): Promise<DMChannel | TextChannel | NewsChannel | undefined> {
	const cached = cronChannelCache.get(chId);
	if (cached) return cached;
	if (!discordClient) return undefined;
	try {
		const fetched = await discordClient.channels.fetch(chId);
		const channel = fetched as DMChannel | TextChannel | NewsChannel | null;
		if (channel) cronChannelCache.set(chId, channel);
		return channel ?? undefined;
	} catch (err) {
		console.error(`[discord] Failed to fetch channel ${chId}:`, err);
		return undefined;
	}
}

/**
 * Compute the next occurrence of a 6-field cron expression (local timezone,
 * same as pi-schedule-prompt/croner). Returns an ISO string or null.
 */
function getNextCronRun(schedule: string): string | null {
	try {
		return new Cron(schedule, () => {}).nextRun()?.toISOString() ?? null;
	} catch {
		return null;
	}
}

/**
 * Update a job in .pi/schedule-prompts.json. Returns true when updated.
 */
function updateScheduledJob(jobId: string, partial: Record<string, unknown>): boolean {
	const path = join(process.cwd(), ".pi", "schedule-prompts.json");
	try {
		const data = JSON.parse(readFileSync(path, "utf-8"));
		const job = (data.jobs || []).find((j: any) => j.id === jobId);
		if (!job) return false;
		Object.assign(job, partial);
		writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
		return true;
	} catch (err) {
		console.error(`[discord] Failed to update scheduled job ${jobId}:`, err);
		return false;
	}
}

// Track pending Discord message IDs being processed (for branch metadata)
// Map structure: channelId -> discordMessageId
const pendingDiscordMessages = new Map<string, string>();

/**
 * After deleting a message at index, decrement all tracked indices higher than it.
 */
function fixIndicesAfterDeletion(channelId: string, deletedIndex: number): void {
	const channelMap = discordMessageToSession.get(channelId);
	if (!channelMap) return;

	for (const [msgId, tracked] of channelMap.entries()) {
		if (tracked.sessionIndex > deletedIndex) {
			tracked.sessionIndex--;
		}
	}
}

// ============================================================================
// Helper Functions
// ============================================================================

function isThread(channel: unknown): channel is ThreadChannel {
	return (channel as ThreadChannel)?.isThread?.() === true;
}

/**
 * Escape content to prevent Discord markdown issues in code blocks.
 * Replaces triple backticks with a safe alternative.
 */
function escapeForCodeBlock(text: string): string {
	return text.replace(/```/g, "`\u200b``\u200b``");
}

// ============================================================================
// /sessions helpers — list resumable sessions with a first-message preview
// ============================================================================

/** Read only the head of a file. Session JSONL files can grow huge (REPL
 * transcripts, tool output), but the first user message lives near the top,
 * so reading the whole file just to preview it would be wasteful. */
function readFileHead(path: string, maxBytes = 262_144): string {
	try {
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(maxBytes);
			const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
			return buffer.subarray(0, bytesRead).toString("utf-8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

/** The marker pi-compact seeds a fresh session with. Stripped from previews so
 * the summary itself (which tells you what the session was about) is shown. */
const COMPACT_MARKER = /^\[Previous conversation summary — the full history was closed and can be restored with \/resume [\w-]+\]/;

/**
 * Extract the first non-empty user message from a pi session JSONL file head,
 * collapsed to a single line — used as a "what was this session about" preview.
 * Returns undefined when no user message can be read (e.g. file is missing or
 * not a session file).
 */
function extractFirstUserMessagePreview(fileHead: string, maxPreview = 140): { text: string; isCompacted: boolean } | undefined {
	let raw: string | undefined;
	for (const line of fileHead.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // corrupt/foreign line — skip
		}
		if (entry?.type !== "message") continue;
		if (entry.message?.role !== "user") continue;
		const content = entry.message.content;
		if (typeof content === "string") {
			raw = content;
		} else if (Array.isArray(content)) {
			raw = content
				.map((part: any) =>
					part?.type === "text" ? part.text
					: part?.type === "image" ? "[📷 image]"
					: "")
				.filter((p: string) => typeof p === "string" && p.trim().length > 0)
				.join(" ");
		}
		raw = raw?.replace(/\s+/g, " ").trim();
		if (raw) break; // found the first non-empty user message
	}
	if (!raw) return undefined;

	const isCompacted = COMPACT_MARKER.test(raw);
	if (isCompacted) raw = raw.replace(COMPACT_MARKER, "").trim();
	if (!raw) return undefined; // nothing but the marker — no usable preview
	if (raw.length > maxPreview) raw = raw.slice(0, maxPreview - 1).trimEnd() + "…";
	return { text: raw, isCompacted };
}

// ============================================================================
// Discord Message Handling
// ============================================================================

/**
 * Detect content type and determine appropriate file extension.
 */
function getContentExtension(text: string, type?: string): string {
	// Check for git diff output
	if (text.includes("diff --git") || text.startsWith("diff ") || text.match(/^--- |^\+\+\+ /m)) {
		return "diff";
	}

	// Check for git patch
	if (text.match(/^From [a-f0-9]+ /m) || text.includes("--- a/") || text.includes("--- a\\")) {
		return "patch";
	}

	// Check for JSON
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		return "json";
	}
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return "json";
	}

	// Check for HTML/XML
	if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || trimmed.startsWith("<?xml")) {
		return "html";
	}

	// Check for log files
	if (type === "tool" && text.includes("command")) {
		return "sh";
	}

	// Default to txt for plain text output
	return "md";
}

/**
 * Upload text content as a Discord attachment file.
 */
async function uploadAsFile(
	channel: DMChannel | TextChannel | NewsChannel,
	text: string,
	filename: string = "output.txt",
	type?: string
): Promise<Message | null> {
	try {
		// Determine appropriate extension based on content
		const ext = getContentExtension(text, type);
		const finalFilename = filename.replace(/\.[^.]+$/, `.${ext}`);

		log(`[${channel.id}] Uploading as file: ${finalFilename} (${text.length} chars)`);
		// Use files array format for discord.js
		const msg = await channel.send({
			content: "📎 Output attached",
			files: [{
				attachment: Buffer.from(text, "utf-8"),
				name: finalFilename,
			}],
		});
		log(`[${channel.id}] File uploaded successfully: ${msg.id}`);
		return msg;
	} catch (error) {
		log(`[${channel.id}] ERROR uploading file: ${error}`);
		return null;
	}
}

/**
 * Threshold for uploading as file instead of splitting.
 * Discord has a 2000 char limit per message.
 * We use 2000 to trigger file upload before splitting would fail.
 */
const FILE_UPLOAD_THRESHOLD = 2000;

/** Update the previous token tracking data for delta calculations */
function updatePreviousTokens(
	channelId: string,
	session: AgentSession
) {
	const stats = session.getSessionStats();
	const contextUsage = stats.contextUsage;
	const contextPercent = contextUsage?.percent ?? 0;
	previousTokens.set(channelId, {
		contextPercent,
		inputTokens: stats.tokens.input,
		outputTokens: stats.tokens.output,
	});
}

async function sendToDiscord(
	channel: DMChannel | TextChannel | NewsChannel,
	text: string,
	options?: { trackInSession?: boolean; type?: string; replyToMessageId?: string }
): Promise<Message[]> {
	if (!text.trim()) return [];

	log(`[${channel.id}] sendToDiscord called with: "${text.substring(0, 100)}" (${text.length} chars)`);

	// For very long messages, upload as a file instead of splitting
	if (text.length > FILE_UPLOAD_THRESHOLD) {
		log(`[${channel.id}] Message exceeds ${FILE_UPLOAD_THRESHOLD} chars, uploading as file`);
		const msg = await uploadAsFile(channel, text, "output.txt", options?.type);
		if (msg) {
			// Track the file message if needed
			if (options?.trackInSession) {
				if (!discordMessageToSession.has(channel.id)) {
					discordMessageToSession.set(channel.id, new Map());
				}
				const channelMap = discordMessageToSession.get(channel.id)!;
				const currentIndex = sessionMessageIndex.get(channel.id) ?? 0;
				channelMap.set(msg.id, { sessionIndex: currentIndex, type: options.type ?? "unknown" });
			}
			return [msg];
		}
		// If upload failed, fall back to splitting
		log(`[${channel.id}] File upload failed, falling back to splitting`);
	}

	// Every chunk must be strictly under Discord's 2000-char content limit; the
	// chunker enforces that invariant (see src/message-chunker.ts).
	const chunks = splitMessagePreservingCodeBlocks(text, DISCORD_CHUNK_LIMIT);

	log(`[${channel.id}] Will send ${chunks.length} chunk(s)`);

	const sentMessages: Message[] = [];

	// Send chunks sequentially to preserve order
	let isFirstChunk = true;
	for (const chunk of chunks) {
		log(`[${channel.id}] Actually sending chunk: "${chunk.substring(0, 50)}..."`);
		try {
			const sendOptions = isFirstChunk && options?.replyToMessageId
				? { content: chunk, reply: { messageReference: options.replyToMessageId } }
				: chunk;
			const msg = await channel.send(sendOptions);
			isFirstChunk = false;
			log(`[${channel.id}] Message sent successfully: ${msg.id}`);
			sentMessages.push(msg);

			// Track Discord message ID for session deletion handling
			if (options?.trackInSession) {
				if (!discordMessageToSession.has(channel.id)) {
					discordMessageToSession.set(channel.id, new Map());
				}
				const channelMap = discordMessageToSession.get(channel.id)!;
				const currentIndex = sessionMessageIndex.get(channel.id) ?? 0;
				channelMap.set(msg.id, { sessionIndex: currentIndex, type: options.type ?? "unknown" });
			}
		} catch (sendError) {
			log(`[${channel.id}] ERROR sending message: ${sendError}`);
			throw sendError; // Re-throw so callers can handle
		}
	}

	return sentMessages;
}

/**
 * Direct fetch to Discord typing endpoint — bypasses Discord.js's sendTyping()
 * which wraps the REST client and can cause issues with rate-limit retries.
 */
function createTypingChannel(channelId: string): TypingChannel {
	return {
		triggerTyping: async () => {
			const token = discordClient?.token;
			if (!token) return false;
			try {
				const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/typing`, {
					method: "POST",
					headers: { "Authorization": `Bot ${token}` },
				});
				if (res.status === 429) {
					// Rate limited — Discord keeps the limit per token, just skip
					return false;
				}
				return res.ok;
			} catch {
				return false;
			}
		},
	};
}

/**
 * The end-of-turn work that must happen however the end of the turn was noticed.
 *
 * `agent_end` is the SDK's own signal, but it is only emitted after every awaited
 * extension handler resolves, so a stalled settle path means it never arrives at
 * all. The turn is still over — its final message is already in the transcript —
 * so the watchdog's post-completion fast path runs this too instead of leaving the
 * typing indicator pulsing and a queued prompt undrained.
 *
 * Exactly one of the two callers drains the queue in practice: after a session
 * recreation the disposed session's listeners are gone, so the stale `agent_end`
 * cannot fire a second time.
 */
async function finishChannelTurn(
	channelId: string,
	channel: DMChannel | TextChannel | NewsChannel,
	session: AgentSession,
	typing: TypingManager
): Promise<void> {
	// A finished turn cannot still hold a tool: drop the count so a lost
	// tool_execution_end can never disable the watchdog for this channel.
	inFlightToolCounts.delete(channelId);
	terminalMessageAt.delete(channelId);
	// Agent turn fully finished — stop typing until the next user message
	// or queued prompt starts a new turn (agent_start re-shows it).
	typing.hide(channelId);

	// Token utilization alert (catches the final response if message_end did not fire)
	try {
		const statsResult = generateTokenStatsMessage(channelId, session, previousTokens);
		if (statsResult && statsResult.shouldAlert) {
			sendToDiscord(channel, statsResult.message, { trackInSession: false }).catch(() => {});
		}
		updatePreviousTokens(channelId, session);
	} catch (e) {
		log(`[${channelId}] Error calculating token utilization: ${e}`);
	}

	// Process queued prompts
	const queue = promptQueue.get(channelId);
	if (!queue || queue.length === 0) return;
	const nextPrompt = queue.shift();
	if (!nextPrompt) return;
	promptQueue.set(channelId, queue);
	savePromptQueue();
	log(`[${channelId}] Processing queued prompt: ${nextPrompt.slice(0, 50)}...`);
	try {
		await sendToDiscord(
			channel,
			`📤 **Executing queued prompt:**\n${nextPrompt.length > 200 ? nextPrompt.slice(0, 200) + "..." : nextPrompt}`,
			{ trackInSession: false }
		);
		await session.sendUserMessage(nextPrompt);
	} catch (e) {
		log(`[${channelId}] Error processing queue: ${e}`);
	}
}

/**
 * What the message handler and the parked-message replay need from a subscription.
 *
 * `waitForUserMessageDelivered` is what makes a replay observable: the SDK's
 * sendUserMessage() resolves only once the whole turn settles, and the turn a
 * replay exists for is the wedged one that never settles. Delivery is therefore
 * observed on the user `message_start` event instead.
 */
interface SessionSubscription {
	setPendingDiscordMessageId: (id: string, isReply: boolean) => void;
	/** Resolves true when that Discord message is appended as a user message. */
	waitForUserMessageDelivered: (discordMessageId: string, timeoutMs: number) => Promise<boolean>;
}

function subscribeToSession(
	session: AgentSession,
	channelId: string,
	channel: DMChannel | TextChannel | NewsChannel,
	typingManager: TypingManager,
	sessionDir: string,
	getOutputSettings: (channelId: string) => ChannelOutputSettings
): SessionSubscription {
	const typingChannel = createTypingChannel(channelId);
	const responseBuffer: string[] = [];
	const thinkingBuffer: string[] = [];
	let lastUserMessageEntryId: string | undefined;
	let lastDiscordMessageId: string | undefined;
	let lastMessageIsReply = false;
	let pendingDiscordMsgId: string | undefined;
	let pendingIsReply = false;
	/** Replay waiters, keyed by Discord message id, woken on the user message_start. */
	const deliveryWaiters = new Map<string, Set<(delivered: boolean) => void>>();

	/** Wakes a parked-message replay as soon as its text reaches the session. */
	function notifyUserMessageDelivered(discordMessageId: string): void {
		const waiters = deliveryWaiters.get(discordMessageId);
		if (!waiters) return;
		deliveryWaiters.delete(discordMessageId);
		for (const finish of [...waiters]) finish(true);
	}
	// Captured at agent_end (synchronous, all messages appended) for use in .then()
	let capturedAssistantEntryId: string | null = null;

	// Baseline before the first event arrives, so a session that never emits
	// anything is still measured from its subscription.
	stampSdkActivity(channelId);

	session.subscribe(async (event: AgentSessionEvent) => {
		// Any event counts as activity: this is what the stale-run watchdog in the
		// 60s sweep compares against. See src/stuck-run-decision.ts.
		stampSdkActivity(channelId);
		// The terminal assistant message marks the end of the turn's output; every
		// other event (including agent_end itself) means the run is still working,
		// so the marker only survives if the settle path went silent. See
		// src/post-completion-stall.ts.
		if (isTerminalAssistantMessage(event)) {
			terminalMessageAt.set(channelId, Date.now());
		} else {
			terminalMessageAt.delete(channelId);
		}
		switch (event.type) {
			case "agent_start":
				log(`[${channelId}] Agent starting...`);
				// A new turn cannot inherit a tool from the previous one.
				inFlightToolCounts.delete(channelId);
				responseBuffer.length = 0;
				// LLM is processing - show typing indicator
				typingManager.show(channelId, typingChannel);
				break;

			case "message_start":
				if (event.message.role === "user") {
					// Capture pending discord info - entry id captured on message_end when appended
					lastDiscordMessageId = pendingDiscordMsgId;
					lastMessageIsReply = pendingIsReply;
					// The message finally reached the session: drop its durable parking
					// entry (it was only parked while the channel was draining
					// background work). See src/pending-messages.ts.
					if (lastDiscordMessageId) {
						pendingMessages.remove(channelId, lastDiscordMessageId);
						notifyUserMessageDelivered(lastDiscordMessageId);
					}
					log(`[${channelId}] User message started, discordMsg=${lastDiscordMessageId}, isReply=${lastMessageIsReply}`);
				} else if (event.message.role === "assistant") {
					log(`[${channelId}] Assistant message started`);
					responseBuffer.length = 0;
					thinkingBuffer.length = 0;
					// Increment session index for this new assistant message
					const currentIdx = (sessionMessageIndex.get(channelId) ?? 0) + 1;
					sessionMessageIndex.set(channelId, currentIdx);
					// LLM is generating response - show typing indicator
					typingManager.show(channelId, typingChannel);
				}
				break;

			case "message_update": {
				const assistantEvent = event.assistantMessageEvent;
				log(`[${channelId}] message_update type: ${assistantEvent?.type}`);
				if (assistantEvent?.type === "text_delta") {
					log(`[${channelId}] text_delta: "${assistantEvent.delta}" (${assistantEvent.delta?.length || 0} chars)`);
					responseBuffer.push(assistantEvent.delta);
				}
				if (assistantEvent?.type === "thinking_delta") {
					log(`[${channelId}] thinking_delta: "${assistantEvent.delta}"`);
					// Show typing indicator when thinking starts
					typingManager.show(channelId, typingChannel);
					thinkingBuffer.push(assistantEvent.delta);
					// Only send when thinking is complete (on message_end) to avoid spam
				}
				break;
			}

			case "message_end":
				if (event.message.role === "assistant") {
					// Send thinking only once when complete (not streaming)
					const fullThinking = thinkingBuffer.join("");
					const outputSettings = getOutputSettings(channelId);
					if (!outputSettings.hideThinking && fullThinking.trim().length > 10) {
						log(`[${channelId}] Sending completed thinking (${fullThinking.length} chars)`);
						sendToDiscord(channel, `💭 Thinking\n\`\`\`\n${escapeForCodeBlock(fullThinking)}\n\`\`\``, { trackInSession: true, type: "thinking" }).catch(() => {});
					}

					// Send response and collect Discord message IDs to be mapped at agent_end
					const fullResponse = responseBuffer.join("");
					if (fullResponse.trim()) {
						log(`[${channelId}] Sending response (${fullResponse.length} chars)`);
						const replyToId = lastMessageIsReply ? lastDiscordMessageId : undefined;
						sendToDiscord(channel, fullResponse, { trackInSession: true, type: "response", replyToMessageId: replyToId }).then((msgs) => {
							// Use capturedAssistantEntryId set at agent_end (synchronous before this .then())
							const assistantEntryId = capturedAssistantEntryId;
							if (assistantEntryId && msgs.length > 0) {
								const metadata = loadBranchMetadata(sessionDir, channelId);
								for (const msg of msgs) {
									metadata.discordMsgToPiEntryId.set(msg.id, assistantEntryId);
									log(`[${channelId}] Tracked bot response ${msg.id} → Pi entry ${assistantEntryId}`);
								}
								saveBranchMetadata(sessionDir, channelId, metadata);
							}
						}).catch((error) => {
							console.error(`[${channelId}] Failed to send response:`, error);
						});
					} else if (event.message.stopReason === "error" && event.message.errorMessage) {
						// SEND ERROR TO DISCORD
						console.error(`[${channelId}] Model Error: ${event.message.errorMessage}`);
						log(`[${channelId}] Sending error response: ${event.message.errorMessage}`);
						sendToDiscord(channel, `❌ **Model Error**\n\`\`\`\n${escapeForCodeBlock(event.message.errorMessage)}\n\`\`\``, { trackInSession: true, type: "response" }).catch(() => {});
					}

					responseBuffer.length = 0;
					thinkingBuffer.length = 0;
					// Don't hide typing on message_end — it fires mid-turn for tool calls,
					// causing flickering. agent_end handles the final cleanup.
				}
				break;

			case "tool_execution_start": {
				log(`[${channelId}] Tool started: ${event.toolName}`);
				// Counted for the stale-run watchdog: a tool emits nothing until it
				// ends, so a long build must not read as a wedged run.
				inFlightToolCounts.set(channelId, (inFlightToolCounts.get(channelId) ?? 0) + 1);
				// Skip sending (and index tracking) when tools are hidden
				if (!getOutputSettings(channelId).hideTools) {
					const args = escapeForCodeBlock(JSON.stringify(event.args, null, 2));
					// Increment session index for tool calls
					const currentIdx = (sessionMessageIndex.get(channelId) ?? 0) + 1;
					sessionMessageIndex.set(channelId, currentIdx);
					sendToDiscord(channel, `🔧 Running \`${event.toolName}\`\n\`\`\`json\n${args}\n\`\`\``, { trackInSession: true, type: "tool" }).catch(() => {});
				}
				// Keep typing indicator visible during tool execution
				typingManager.show(channelId, typingChannel);
				break;
			}

			case "tool_execution_update":
				// Streaming tool output — keep typing alive for long-running tools
				typingManager.show(channelId, typingChannel);
				break;

			case "tool_execution_end":
				log(`[${channelId}] Tool ended: ${event.toolName} (error: ${event.isError})`);
				inFlightToolCounts.set(channelId, Math.max(0, (inFlightToolCounts.get(channelId) ?? 0) - 1));
				// Turn continues after the tool (more LLM calls may follow)
				typingManager.show(channelId, typingChannel);
				const outputSettings = getOutputSettings(channelId);
				if (event.isError) {
					if (!outputSettings.hideTools) {
						const result = escapeForCodeBlock(JSON.stringify(event.result, null, 2));
						sendToDiscord(channel, `⚠️ Tool execution failed\n\`\`\`json\n${result}\n\`\`\``, { trackInSession: true, type: "tool-error" }).catch(() => {});
					}
				} else {
					if (event.toolName === "thinkingmode") {
						// The MODEL changed its own thinking level via the `thinkingmode`
						// tool. Post a dedicated notification, gated by `/hide
						// thinkingmode` (separate from general tool/thinking output).
						if (!outputSettings.hideThinkingMode) {
							const level = session?.thinkingLevel ?? "off";
							sendToDiscord(channel, `🧠 The model changed the thinking level to **${level}** for this channel.`, { trackInSession: true, type: "tool-success" }).catch(() => {});
						}
					} else {
						// Send success result for tools like 'remember'
						if (!outputSettings.hideTools && typeof event.result === 'string' && event.result.startsWith('✅')) {
							sendToDiscord(channel, event.result, { trackInSession: true, type: "tool-success" }).catch(() => {});
						}
					}
				}
				break;

			case "agent_end":
				log(`[${channelId}] Agent ended`);
				// Capture assistant entry NOW (synchronous, all messages appended)
				// The .then() callback will use this to track bot response Discord msg IDs
				capturedAssistantEntryId = session.sessionManager.getLeafId();
				await finishChannelTurn(channelId, channel, session, typingManager);
				break;

			case "compaction_start":
				typingManager.show(channelId, typingChannel);
				log(`[${channelId}] Compacting context...`);
				sendToDiscord(channel, "📦 Compacting context...").catch(() => {});
				break;

			case "compaction_end":
				if (!event.willRetry) {
					// Terminal compaction (threshold cleanup, or overflow recovery that
					// won't retry): the turn is done. The next agent_start re-shows.
					typingManager.hide(channelId);
				}
				// Overflow compaction with willRetry continues via agent.continue() —
				// keep typing visible through the retry.
				log(`[${channelId}] Compaction complete`);
				break;

			case "auto_retry_start":
				typingManager.show(channelId, typingChannel);
				log(`[${channelId}] Retrying (attempt ${event.attempt}/${event.maxAttempts}). Error message: ${event.errorMessage}`);
				if (isNonRetryableModelError(event.errorMessage)) {
					// Retrying cannot fix a 402/401/400/context-overflow: cancel the backoff
					// and tell the user what to do. The SDK creates the retry
					// AbortController right AFTER emitting this event, so abortRetry() is a
					// no-op until the next tick.
					log(`[${channelId}] Non-retryable model error - cancelling retries`);
					setTimeout(() => session.abortRetry(), 0);
					typingManager.hide(channelId);
					sendToDiscord(
						channel,
						`⛔ **Not retrying** — this error cannot succeed on retry.\n\`\`\`\n${escapeForCodeBlock(event.errorMessage)}\n\`\`\`\n${retryHintForModelError(event.errorMessage)}`
					).catch(() => {});
					break;
				}
				sendToDiscord(channel, `⚠️ Retrying (attempt ${event.attempt}/${event.maxAttempts})...\nError:\n\`\`\`\n${escapeForCodeBlock(event.errorMessage)}\n\`\`\``).catch(() => {});
				break;

			case "auto_retry_end":
				if (event.success) {
					// Retry succeeded — the turn continues with more LLM calls/tools.
					typingManager.show(channelId, typingChannel);
				} else {
					// Retries exhausted — the turn is over.
					typingManager.hide(channelId);
				}
				log(`[${channelId}] Retry ${event.success ? "succeeded" : "failed"}`);
        if (!event.success) {
          sendToDiscord(channel, "🛑 Retry failed...").catch(() => {});
        }
				break;
		}
	});

	return {
		setPendingDiscordMessageId: (id: string, isReply: boolean) => {
			pendingDiscordMsgId = id;
			pendingIsReply = isReply;
		},
		waitForUserMessageDelivered: (discordMessageId: string, timeoutMs: number) =>
			new Promise<boolean>((resolve) => {
				const waiters = deliveryWaiters.get(discordMessageId) ?? new Set<(delivered: boolean) => void>();
				deliveryWaiters.set(discordMessageId, waiters);
				let settled = false;
				const finish = (delivered: boolean) => {
					if (settled) return;
					settled = true;
					waiters.delete(finish);
					if (waiters.size === 0) deliveryWaiters.delete(discordMessageId);
					clearTimeout(timer);
					resolve(delivered);
				};
				const timer = setTimeout(() => finish(false), timeoutMs);
				// A pending waiter must not keep the process alive during shutdown.
				timer.unref?.();
				waiters.add(finish);
			}),
	};
}

// ============================================================================
// Main
// ============================================================================

async function main() {
	console.log("[discord] Starting pi-discord bot...");
	console.log(`[discord] Session directory: ${sessionDir}`);

	// =========================================================================
	// Initialize Discord Client
	// =========================================================================
	discordClient = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.DirectMessages,
			GatewayIntentBits.MessageContent,
			GatewayIntentBits.DirectMessageReactions,
			GatewayIntentBits.GuildMessageReactions,
		],
	});

	// Handle Discord ready
	discordClient.once("clientReady", () => {
		console.log(`[discord] Bot logged in as ${discordClient?.user?.tag}`);
	});

	// Handle errors
	discordClient.on("error", (error) => {
		console.error("[discord] Client error:", error);
	});

	// Handle disconnection with auto-reconnect
	discordClient.on("disconnect", () => {
		log("Discord client disconnected, attempting to reconnect...");
		setTimeout(() => {
			discordClient?.login(discordToken);
		}, 5000);
	});

	// Login to Discord
	await discordClient.login(discordToken);

	// =========================================================================
	// Message Handler
	// =========================================================================
	discordClient.on("messageCreate", async (message) => {
		// Ignore bot messages
		if (message.author.bot) return;

		// If there's no text AND no attachments, ignore the message
		if (!message.content?.trim() && message.attachments.size === 0) return;

		log(`[${message.channelId}] Message from ${message.author.tag}: ${message.content?.slice(0, 100) || "[No text]"}...`);

		// Handle DM channels
		if (message.channel.type === ChannelType.DM) {
			await handleMessage(message.channel as DMChannel, message);
			return;
		}

		// Handle thread messages
		if (isThread(message.channel)) {
			await handleMessage(message.channel, message);
			return;
		}

		// Handle regular text channel messages
		if (message.channel.type === ChannelType.GuildText) {
			await handleMessage(message.channel as TextChannel, message);
			return;
		}
	});

	// =========================================================================
	// Message Deletion Handler
	// =========================================================================
	discordClient.on("messageDelete", async (message) => {
		const channelId = message.channelId;
		const discordMessageId = message.id;

		log(`[${channelId}] Message deleted: ${discordMessageId}`);

		// Clean up branch metadata
		const metadata = loadBranchMetadata(sessionDir, channelId);
		metadata.discordMsgToPiEntryId.delete(discordMessageId);
		metadata.discordMsgParent.delete(discordMessageId);

		// Remove labels pointing to this message
		for (const [labelName, labelInfo] of metadata.labels) {
			if (labelInfo.discordMessageId === discordMessageId) {
				metadata.labels.delete(labelName);
				log(`[${channelId}] Removed label ${labelName} (Discord message deleted)`);
			}
		}

		saveBranchMetadata(sessionDir, channelId, metadata);

		// Look up if we track this Discord message in the old tracking system
		const channelMap = discordMessageToSession.get(channelId);
		if (!channelMap) {
			log(`[${channelId}] No tracked messages for this channel`);
			return;
		}

		const tracked = channelMap.get(discordMessageId);
		if (!tracked) {
			log(`[${channelId}] Warning: Deleted message ${discordMessageId} was not tracked in session`);
			return;
		}

		// Get the session and remove the corresponding message
		const discordSession = sessionStore.get(channelId);
		if (!discordSession) {
			log(`[${channelId}] No session found for channel`);
			channelMap.delete(discordMessageId);
			return;
		}

		const { session } = discordSession;
		const messages = session.messages;

		// Find and remove the message at the tracked index
		if (tracked.sessionIndex >= 0 && tracked.sessionIndex < messages.length) {
			const removed = messages.splice(tracked.sessionIndex, 1);
			log(`[${channelId}] Removed message from session: ${removed[0]?.role} (index ${tracked.sessionIndex})`);
			// Fix indices after deletion to prevent drift
			fixIndicesAfterDeletion(channelId, tracked.sessionIndex);
		} else {
			log(`[${channelId}] Warning: Session index ${tracked.sessionIndex} out of bounds (${messages.length} messages)`);
		}

		// Remove from tracking map
		channelMap.delete(discordMessageId);
	});

	discordClient.on("messageDeleteBulk", async (messages) => {
		// Group messages by channel and sort by index descending
		const byChannel = new Map<string, Array<{ msgId: string; tracked: { sessionIndex: number; type: string } }>>();

		for (const message of messages.values()) {
			const channelId = message.channelId;
			const discordMessageId = message.id;

			log(`[${channelId}] Bulk message deleted: ${discordMessageId}`);

			const channelMap = discordMessageToSession.get(channelId);
			if (!channelMap) continue;

			const tracked = channelMap.get(discordMessageId);
			if (!tracked) {
				log(`[${channelId}] Warning: Bulk-deleted message ${discordMessageId} was not tracked in session`);
				continue;
			}

			if (!byChannel.has(channelId)) {
				byChannel.set(channelId, []);
			}
			byChannel.get(channelId)!.push({ msgId: discordMessageId, tracked });
		}

		// Process each channel
		for (const [channelId, deletions] of byChannel) {
			// Sort by index descending so we delete from high to low
			deletions.sort((a, b) => b.tracked.sessionIndex - a.tracked.sessionIndex);

			const discordSession = sessionStore.get(channelId);
			if (!discordSession) continue;

			const { session } = discordSession;
			const sessionMessages = session.messages;

			for (const { msgId, tracked } of deletions) {
				const channelMap = discordMessageToSession.get(channelId)!;
				channelMap.delete(msgId);

				if (tracked.sessionIndex >= 0 && tracked.sessionIndex < sessionMessages.length) {
					const removed = sessionMessages.splice(tracked.sessionIndex, 1);
					log(`[${channelId}] Removed message from session: ${removed[0]?.role} (index ${tracked.sessionIndex})`);
					// Fix indices after deletion
					fixIndicesAfterDeletion(channelId, tracked.sessionIndex);
				}
			}
		}
	});

	// =========================================================================
	// Channel Rename Handler
	// =========================================================================
	discordClient.on("channelUpdate", async (oldChannel, newChannel) => {
		// Only track text channels and DMs
		if (oldChannel.type !== ChannelType.GuildText && oldChannel.type !== ChannelType.DM) {
			return;
		}

		const channelId = oldChannel.id;
		const oldName = oldChannel.type === ChannelType.DM ? "DM" : (oldChannel as TextChannel).name;
		const newName = newChannel.type === ChannelType.DM ? "DM" : (newChannel as TextChannel).name;

		if (oldName !== newName) {
			log(`[${channelId}] Channel renamed: "${oldName}" → "${newName}"`);
			// Update the channel name in session store so the system prompt reflects the rename
			sessionStore.setChannelName(channelId, newName);
			log(`[${channelId}] Updated session channel name to "${newName}"`);
		}
	});

	// =========================================================================
	// Branch Command Handlers
	// =========================================================================

	/**
	 * /label [name] - Label the current message's pi entry
	 */
	async function handleLabel(
		channel: DMChannel | TextChannel | NewsChannel | ThreadChannel,
		message: Message,
		labelName?: string
	): Promise<void> {
		const channelId = channel.id;
		const discordSession = sessionStore.get(channelId);
		
		if (!discordSession) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ No session for this channel");
			return;
		}

		const metadata = loadBranchMetadata(sessionDir, channelId);
		
		// Resolve target message: use the replied-to message if this is a reply,
		// otherwise fall back to the main branch tip (most recent bot response).
		let targetDiscordMsgId: string | undefined;
		if (message.reference?.messageId) {
			targetDiscordMsgId = message.reference.messageId;
		} else if (metadata.mainBranchTip) {
			// mainBranchTip is the assistant entry ID — find the Discord msg that maps to it
			for (const [discordId, piId] of metadata.discordMsgToPiEntryId) {
				if (piId === metadata.mainBranchTip) {
					targetDiscordMsgId = discordId;
					break;
				}
			}
		}

		if (!targetDiscordMsgId) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ No message to label — reply to a message or send a message first");
			return;
		}

		// Find which pi entry corresponds to the target Discord message
		const piEntryId = metadata.discordMsgToPiEntryId.get(targetDiscordMsgId);
		if (!piEntryId) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ Target message not found in session");
			return;
		}

		// Use provided name or auto-generate
		const name = labelName || `label-${++metadata.labelCounter}`;

		// Check if label already exists
		if (metadata.labels.has(name)) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `❌ Label \`${name}\` already exists`);
			return;
		}

		// Track in metadata
		metadata.labels.set(name, {
			piEntryId,
			discordMessageId: targetDiscordMsgId,
			timestamp: Date.now(),
		});

		saveBranchMetadata(sessionDir, channelId, metadata);
		await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `✅ Labeled as \`${name}\``);
	}

	/**
	 * /labels - Show all labels in this channel
	 */
	async function handleLabels(
		channel: DMChannel | TextChannel | NewsChannel | ThreadChannel
	): Promise<void> {
		const channelId = channel.id;
		const metadata = loadBranchMetadata(sessionDir, channelId);

		const lines: string[] = [];
		
		for (const [labelName] of metadata.labels) {
			lines.push(`• \`${labelName}\``);
		}

		const output = lines.length > 0 
			? lines.join("\n")
			: "No labels found";

		await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `**Labels in this channel:**\n${output}`);
	}

	/**
	 * /sessions - List every session that can be returned to via /resume, each
	 * with the first user message as a "what was this about" preview.
	 *
	 * Sources: closed-sessions.json (registered) plus orphaned timestamped
	 * backup files on disk (discord-<channel>-<ts>.jsonl) that were never
	 * registered — e.g. moved by older bot versions or manual cleanup — so no
	 * resumable session is left out. Sorted most-recently-closed first; the
	 * shown window shrinks from the end so the message always fits Discord's
	 * 2000-char limit, with a pointer to /resume for the rest.
	 */
	async function handleSessions(
		channel: DMChannel | TextChannel | NewsChannel | ThreadChannel
	): Promise<void> {
		const channelId = channel.id;
		const MAX_SESSIONS = 10;
		const MAX_PREVIEW = 140;

		const registered = sessionStore.getClosedSessions(channelId);

		// Orphaned backup files never registered in closed-sessions.json
		const seenFiles = new Set(registered.map(s => s.sessionFile));
		const orphans: ClosedSessionInfo[] = [];
		try {
			for (const name of readdirSync(sessionDir)) {
				const m = name.match(new RegExp(`^discord-${channelId}-(\\d+)\\.jsonl$`));
				if (!m) continue;
				const file = join(sessionDir, name);
				if (seenFiles.has(file)) continue;
				const head = readFileHead(file);
				let sessionId = "";
				for (const line of head.split("\n")) {
					if (!line.trim()) continue;
					try {
						const entry = JSON.parse(line);
						if (entry?.type === "session" && entry.id) { sessionId = entry.id; break; }
					} catch { /* not JSON — keep scanning */ }
				}
				if (!sessionId) continue; // unreadable file — skip it
				orphans.push({
					channelId,
					sessionId,
					sessionFile: file,
					sessionName: `discord-${channelId}`,
					closedAt: Number(m[1]),
				});
			}
		} catch {}

		// Merge, dedupe by file (a fork keeps the same sessionId as the live
		// session, so sessionId alone is ambiguous), newest closed first.
		const byFile = new Map<string, ClosedSessionInfo>();
		for (const s of [...registered, ...orphans]) byFile.set(s.sessionFile, s);
		const sessions = [...byFile.values()].sort((a, b) => b.closedAt - a.closedAt);

		if (sessions.length === 0) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
				"📭 No closed sessions to return to in this channel. Use `/session` or `/fork` to save one.");
			return;
		}

		// Build entry lines once (the reads are the expensive part), then trim
		// the shown window from the end until the message fits under Discord's
		// 2000-char limit — better than a file upload for a listing command.
		const MAX_CHARS = 1900; // headroom under the 2000-char Discord limit
		const entryLines: string[] = [];
		for (const s of sessions.slice(0, MAX_SESSIONS)) {
			let head = `• \`${s.sessionId}\``;
			if (s.label) head += ` [${s.label.replace(/`/g, "'")}]`;
			head += ` — closed ${new Date(s.closedAt).toLocaleString("en-GB", { timeZone: "Europe/Amsterdam" })}`;
			entryLines.push(head);

			const preview = extractFirstUserMessagePreview(readFileHead(s.sessionFile), MAX_PREVIEW);
			if (preview) {
				const tag = preview.isCompacted ? "📦 compacted: " : "💬 ";
				entryLines.push(`   ${tag}${preview.text}`);
			} else if (existsSync(s.sessionFile)) {
				entryLines.push("   *(no readable first message)*");
			} else {
				entryLines.push("   ⚠️ *(session file missing — /resume will not be able to restore it)*");
			}
		}

		let take = Math.min(MAX_SESSIONS, sessions.length);
		let output = "";
		while (take > 0) {
			const hidden = sessions.length - take;
			const footer = hidden > 0
				? `\n…and ${hidden} more. Use \`/resume\` for the full list, or \`/resume <id or label>\` to jump in.`
				: `\nUse \`/resume <id or label>\` to jump into one.`;
			output = `📚 **Sessions you can return to (${sessions.length}):**\n${entryLines.slice(0, take * 2).join("\n")}\n${footer}`;
			if (output.length <= MAX_CHARS) break;
			take--;
		}
		await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, output);
	}

	/**
	 * /merge [name] - Merge branch from labeled entry or previous message
	 */
	async function handleMerge(
		channel: DMChannel | TextChannel | NewsChannel | ThreadChannel,
		message: Message,
		labelName?: string
	): Promise<void> {
		const channelId = channel.id;
		const discordSession = sessionStore.get(channelId);
		
		if (!discordSession) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ No session for this channel");
			return;
		}

		const { session } = discordSession;
		const metadata = loadBranchMetadata(sessionDir, channelId);

		// Determine source branch
		let sourcePiEntryId: string | undefined;
		
		if (labelName) {
			// Merge from labeled entry
			const label = metadata.labels.get(labelName);
			if (!label) {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `❌ Label \`${labelName}\` not found`);
				return;
			}
			sourcePiEntryId = label.piEntryId;
		} else {
			// Merge from replied-to message, or fall back to mainBranchTip
			if (message.reference?.messageId) {
				sourcePiEntryId = metadata.discordMsgToPiEntryId.get(message.reference.messageId);
				if (!sourcePiEntryId) {
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "⚠️ Replied-to message not in session");
					return;
				}
			} else {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ Specify a label name or reply to the message you want to merge from");
				return;
			}
		}

		// Current position: if /merge is a reply, use that message's pi entry (for sub-branch merges).
		// Otherwise fall back to mainBranchTip (main branch merges).
		let currentPiEntryId: string | null | undefined;
		if (message.reference?.messageId) {
			currentPiEntryId = metadata.discordMsgToPiEntryId.get(message.reference.messageId);
			if (!currentPiEntryId) {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ Replied-to message not tracked in session");
				return;
			}
		} else {
			currentPiEntryId = metadata.mainBranchTip;
		}
		if (!currentPiEntryId) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ No current position — send a message first");
			return;
		}

		// Find fork point (common ancestor)
		const forkEntryId = findCommonAncestor(
			sourcePiEntryId,
			currentPiEntryId,
			session.sessionManager
		);

		if (forkEntryId === currentPiEntryId) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "⚠️ Already on same branch, no merge needed");
			return;
		}

		// Get all messages from fork point to source leaf
		const sourceMessages = getMessagesBetween(
			forkEntryId,
			sourcePiEntryId,
			session.sessionManager
		);

		// Create merge message summarizing what we're merging
		const mergeContent = formatMergedMessages(sourceMessages);
		const mergeMessage = `Merged from branch:\n\n${mergeContent}`;

		try {
			// Branch to current position and silently inject merged content
			// (no LLM turn - just append to tree and sync agent context)
			session.sessionManager.branch(currentPiEntryId);
			const mergeEntryId = session.sessionManager.appendMessage({
				role: "user",
				content: mergeMessage,
				timestamp: Date.now(),
			});

			// Sync agent's in-memory context to include the merged content
			const ctx = session.sessionManager.buildSessionContext();
			session.agent.state.messages = ctx.messages

			const updatedMeta = loadBranchMetadata(sessionDir, channelId);

			// Remap the current tip Discord message to the merge entry,
			// so subsequent replies to the merged tip continue from the merge result.
			for (const [discordId, piId] of updatedMeta.discordMsgToPiEntryId) {
				if (piId === currentPiEntryId) {
					updatedMeta.discordMsgToPiEntryId.set(discordId, mergeEntryId);
					log(`[${channelId}] Remapped current tip ${discordId} → merge entry ${mergeEntryId}`);
				}
			}

			if (currentPiEntryId === updatedMeta.mainBranchTip) {
				// Main branch merge: advance mainBranchTip
				updatedMeta.mainBranchTip = mergeEntryId;
				log(`[${channelId}] Updated main branch tip after merge to ${mergeEntryId}`);
			} else {
				log(`[${channelId}] Sub-branch merge at ${currentPiEntryId}, mainBranchTip unchanged`);
			}
			saveBranchMetadata(sessionDir, channelId, updatedMeta);

			// Send confirmation and track it → mergeEntryId so replies to it continue from the merge
			const confirmMsgs = await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "✅ Branch merged");
			if (confirmMsgs.length > 0) {
				const finalMeta = loadBranchMetadata(sessionDir, channelId);
				for (const msg of confirmMsgs) {
					finalMeta.discordMsgToPiEntryId.set(msg.id, mergeEntryId);
					log(`[${channelId}] Tracked merge confirmation ${msg.id} → Pi entry ${mergeEntryId}`);
				}
				saveBranchMetadata(sessionDir, channelId, finalMeta);
			}
		} catch (error) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `❌ Merge failed: ${error}`);
		}
	}

	/**
	 * /summary [name] - Show merged branch messages (summary of changes)
	 */
	async function handleSummary(
		channel: DMChannel | TextChannel | NewsChannel | ThreadChannel,
		message: Message,
		labelName?: string
	): Promise<void> {
		const channelId = channel.id;
		const discordSession = sessionStore.get(channelId);
		
		if (!discordSession) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ No session for this channel");
			return;
		}

		const { session } = discordSession;
		const metadata = loadBranchMetadata(sessionDir, channelId);

		// Determine source branch (same logic as merge)
		let sourcePiEntryId: string | undefined;
		
		if (labelName) {
			const label = metadata.labels.get(labelName);
			if (!label) {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `❌ Label \`${labelName}\` not found`);
				return;
			}
			sourcePiEntryId = label.piEntryId;
		} else {
			// Source from replied-to message
			if (message.reference?.messageId) {
				sourcePiEntryId = metadata.discordMsgToPiEntryId.get(message.reference.messageId);
				if (!sourcePiEntryId) {
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "⚠️ Replied-to message not in session");
					return;
				}
			} else {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ Specify a label name or reply to the message you want to summarize");
				return;
			}
		}

		// Current position: reply target if replying, else mainBranchTip
		let currentPiEntryId: string | null | undefined;
		if (message.reference?.messageId) {
			currentPiEntryId = metadata.discordMsgToPiEntryId.get(message.reference.messageId);
			if (!currentPiEntryId) {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ Replied-to message not tracked in session");
				return;
			}
		} else {
			currentPiEntryId = metadata.mainBranchTip;
		}
		if (!currentPiEntryId) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ No current position — send a message first");
			return;
		}

		// Find fork point
		const forkEntryId = findCommonAncestor(
			sourcePiEntryId,
			currentPiEntryId,
			session.sessionManager
		);

		if (forkEntryId === currentPiEntryId) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "⚠️ Already on same branch");
			return;
		}

		// Get messages to summarize
		const sourceMessages = getMessagesBetween(
			forkEntryId,
			sourcePiEntryId,
			session.sessionManager
		);

		// Format and show the summary
		const summaryContent = formatMergedMessages(sourceMessages);
		const summaryMessage = `**Summary of branch changes:**\n\n${summaryContent}`;

		try {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, summaryMessage);
		} catch (error) {
			console.error(`[${channelId}] Summary error:`, error);
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `❌ Summary failed: ${error}`);
		}
	}

	// =========================================================================
	// Tools
	// =========================================================================
	// Note: handleRemember is now handled by the session tool definition in session-store.ts
	// and routed via tool_execution_end in subscribeToSession.

	// =========================================================================
	// Message Processing
	// =========================================================================
	const subscribedSessions = new Set<string>();
	const sessionSubscriptions = new Map<string, SessionSubscription>();
	/** Channels with a parked-message replay in flight (guards the 60s sweep). */
	const replaysInFlight = new Set<string>();
	/**
	 * Channels whose session is being rebuilt by recoverStuckSession().
	 *
	 * The rebuild deletes the subscription binding and then awaits getOrCreate()
	 * and fetchChannelObject(), so a message or the cron keeper arriving in that
	 * window would subscribe the same session a second time — and subscribeToSession
	 * cannot dedup, so every event would post twice forever.
	 */
	const recoveringChannels = new Set<string>();
	/**
	 * Recoveries in flight per channel.
	 *
	 * A user message arriving mid-rebuild must wait for that same rebuild and
	 * deliver into it, not skip recovery and hand its prompt to a disposed
	 * session. Deduping on the promise is what makes recoverStuckSession() safe to
	 * call from both the sweep and the first-contact path in handleMessage().
	 */
	const recoveriesInFlight = new Map<string, Promise<boolean>>();
	let subscribeCount = 0;
	let sendCount = 0;

	/**
	 * Split the channel's subagent work into "provably live" and "only counted".
	 *
	 * `sync` is a subagent tool call holding a live child process: work by
	 * construction. `async` comes from the gate's in-memory tally, which is
	 * released only by pi-subagents' async-complete event — and that event is
	 * delivered through the session, so the wedge that blocks the settle path also
	 * blocks the release. Reading that tally as work in progress deadlocks the
	 * recovery that would break the loop, so each counted run is resolved against
	 * the on-disk run store instead.
	 *
	 * A run that is terminal, or whose pid is dead and whose status is older than
	 * RUN_PROGRESS_RECENT_MS, is not work — its pending delivery is a consequence
	 * of the wedge, not evidence against recovering from it. When the store cannot
	 * be read the async half reports live: an unverifiable input must not be the
	 * reason a turn is destroyed.
	 */
	function subagentWorkLiveness(
		discordSession: DiscordSession
	): { sync: boolean; async: boolean } {
		const sync = discordSession.hasSyncSubagentWork();
		const pendingRuns = discordSession.pendingAsyncRuns();
		if (pendingRuns.length === 0) return { sync, async: false };
		return { sync, async: hasProgressingAsyncWork(pendingRuns, summarizeRunStore()) };
	}

	/**
	 * Why re-delivering parked messages may not abort this channel's active run.
	 *
	 * Returns the refusing liveness gate, a child-process summary, or null when the
	 * run looks wedged and aborting it is the only way forward. Deliberately the same
	 * gates as the watchdog minus confirmation: a replay runs after the sweep's
	 * recovery pass, so an unconfirmed silent run already collected its confirmations
	 * there.
	 */
	async function parkedReplayAbortRefusal(
		discordSession: DiscordSession,
		channelId: string
	): Promise<string | null> {
		const work = subagentWorkLiveness(discordSession);
		const refusal = evaluateStuckRunLiveness({
			modelActive: discordSession.isModelActive(),
			idleMs: Date.now() - (lastSdkEventAt.get(channelId) ?? Date.now()),
			thresholdMs: stuckRunThresholdMs,
			hasPendingBackgroundWork: work.async,
			inFlightToolCount: inFlightToolCounts.get(channelId) ?? 0,
			hasActiveSubagentWork: work.sync,
			priorConfirmations: 0,
		});
		if (refusal) return refusal;
		const childPids = await findLiveChildPids();
		if (childPids.length > 0) return `child-processes(${childPids.join(",")})`;
		return null;
	}

	/**
	 * How long a replay waits for the delivered user message to surface before it
	 * leaves the durable copy parked for a later sweep.
	 */
	const REPLAY_DELIVERY_TIMEOUT_MS = 30_000;

	/**
	 * Register the Discord-forwarding subscriber for a channel's session, once.
	 *
	 * Anything that sends a prompt without a Discord message behind it (a replayed
	 * parked message, a scheduled job, the orphan-completion wake) is invisible
	 * until the session has a subscriber: the agent's output is forwarded from
	 * session events, so without one the answer posts nowhere. Returns the existing
	 * subscription when there is one, and undefined when the channel cannot be
	 * fetched.
	 */
	function ensureChannelSubscription(
		channelId: string,
		discordSession: DiscordSession,
		channel?: DMChannel | TextChannel | NewsChannel
	): SessionSubscription | undefined {
		const existing = sessionSubscriptions.get(channelId);
		if (existing) return existing;
		if (!channel) {
			log(`[${channelId}] Cannot subscribe: channel object unavailable`);
			return undefined;
		}
		const subscription = subscribeToSession(
			discordSession.session,
			channelId,
			channel,
			typingManager,
			sessionDir,
			getChannelOutputSettings
		);
		sessionSubscriptions.set(channelId, subscription);
		subscribedSessions.add(channelId);
		return subscription;
	}

	/**
	 * How long a wake prompt is given to be handed to the session before the wake is
	 * recorded as sent.
	 *
	 * `sendUserMessage()` resolves only when the whole run settles, and the run this
	 * wake exists for is the one that never settled — awaiting it would hang the
	 * sweep. Acceptance is what matters here: a rejection is detectable immediately,
	 * and anything else means the prompt is in the session.
	 */
	const ORPHAN_WAKE_ACCEPT_MS = 2_000;

	/** How far back the sweep looks for a channel transcript worth inspecting. */
	const ORPHAN_SCAN_LOOKBACK_MS = 48 * 60 * 60_000;

	/** Runs inspected per orphan check. Generous: each status file is a few KB. */
	const ORPHAN_RUN_SCAN_LIMIT = 500;

	/** `discord-<channelId>.jsonl` is the live transcript; timestamped files are backups. */
	const ACTIVE_TRANSCRIPT_PATTERN = /^discord-(\d+)\.jsonl$/;

	/** Channel id encoded in a session path, if this is a channel transcript. */
	function channelIdFromSessionPath(sessionPath: string | undefined): string | undefined {
		if (!sessionPath) return undefined;
		const name = sessionPath.slice(sessionPath.lastIndexOf("/") + 1);
		return name.match(/^discord-(\d+)(?:-\d+)?\.jsonl$/)?.[1];
	}

	/**
	 * Channels worth checking for an orphaned completion: live subscriptions plus
	 * recently written channel transcripts.
	 *
	 * The transcripts are included because the orphan case that matters most (a
	 * restart that killed the run which would have announced itself) leaves exactly
	 * one trace: the notify record in that file, with no session loaded for the
	 * channel yet.
	 */
	function orphanCandidateChannels(): string[] {
		const candidates = new Set<string>(subscribedSessions);
		try {
			const cutoff = Date.now() - ORPHAN_SCAN_LOOKBACK_MS;
			for (const name of readdirSync(sessionDir)) {
				const channelId = name.match(ACTIVE_TRANSCRIPT_PATTERN)?.[1];
				if (!channelId) continue;
				try {
					if (statSync(join(sessionDir, name)).mtimeMs < cutoff) continue;
				} catch {
					continue;
				}
				candidates.add(channelId);
			}
		} catch (err) {
			log(`[discord] Orphan sweep: cannot list ${sessionDir}: ${String(err)}`);
		}
		return [...candidates];
	}

	/**
	 * Newest run in this channel that has already terminalised.
	 *
	 * Attribution uses the run's recorded `sessionId`, which for this bot is the
	 * channel transcript. A run that finished without announcing itself is the
	 * second orphan shape: no notify record exists at all, so there is nothing in
	 * the transcript to detect.
	 */
	function newestFinishedRun(channelId: string): FinishedRunRef | undefined {
		// The diagnostic snapshot caps at a handful of runs; here the whole store has to
		// be considered, because the run that matters may sort anywhere in it.
		const snapshot = listRunStatuses({ maxRuns: ORPHAN_RUN_SCAN_LIMIT });
		if (snapshot.error) return undefined;
		let newest: FinishedRunRef | undefined;
		for (const run of snapshot.runs) {
			if (!isFinishedRunState(run.state)) continue;
			if (channelIdFromSessionPath(run.sessionId) !== channelId) continue;
			const endedAt = run.endedAt ?? run.lastUpdate;
			if (endedAt === undefined) continue;
			if (newest && (newest.endedAt ?? 0) >= endedAt) continue;
			newest = {
				runId: run.runId,
				state: run.state,
				endedAt,
				pidAlive: run.pid === undefined ? undefined : isProcessAlive(run.pid),
				hasResult: findResultPayload(run.runId) !== undefined,
			};
		}
		return newest;
	}

	/**
	 * Send the wake for a confirmed orphan and record it.
	 *
	 * The completion is re-evaluated just before sending: subscribing and creating a
	 * session can take long enough for the normal delivery path to catch up, and a
	 * second report would be a duplicate message.
	 */
	async function wakeOrphanedCompletion(
		channelId: string,
		decision: OrphanCompletionDecision
	): Promise<boolean> {
		const channel = await fetchChannelObject(channelId);
		if (!channel) {
			log(`[watchdog] ${channelId} orphan completion cannot be announced: channel unavailable`);
			return false;
		}

		let discordSession = sessionStore.get(channelId);
		if (!discordSession) {
			// Channel name, not the channel object: getOrCreate() uses it for the
			// session header, and it resolves the transcript path itself.
			discordSession = await sessionStore.getOrCreate(
				channelId,
				"name" in channel && typeof channel.name === "string" ? channel.name : undefined
			);
		}
		if (discordSession.isModelActive()) {
			log(`[watchdog] ${channelId} orphan completion deferred: session became active`);
			return false;
		}

		ensureChannelSubscription(channelId, discordSession, channel);

		const tail = parseTranscriptTail(readTranscriptTail(currentTranscriptPath(channelId, discordSession)));
		const finishedRun = newestFinishedRun(channelId);
		const recheck = isOrphanCompletion({
			channelId,
			tail,
			finishedRun,
			now: Date.now(),
			isWoken: (key) => orphanWakes.has(key),
		});
		if (!recheck.orphan) {
			log(`[watchdog] ${channelId} orphan completion withdrawn (${recheck.refusal})`);
			return false;
		}

		const prompt = buildWakePrompt({
			runId: recheck.runId ?? finishedRun?.runId,
			state: recheck.state ?? finishedRun?.state,
			wakeAt: recheck.wakeAt ?? decision.wakeAt ?? Date.now(),
			resultAvailable: finishedRun?.hasResult === true,
			notifyContent: tail.lastNotifyContent,
		});

		const sendOutcome = discordSession.session.sendUserMessage(prompt).then(
			() => ({ kind: "settled" as const }),
			(error: unknown) => ({ kind: "rejected" as const, error })
		);
		const acceptance = await Promise.race([
			sendOutcome,
			new Promise<{ kind: "pending" }>((finish) => setTimeout(() => finish({ kind: "pending" }), ORPHAN_WAKE_ACCEPT_MS)),
		]);

		if (acceptance.kind === "rejected") {
			// Nothing was queued, so the next sweep retries instead of marking it done.
			console.error(
				`[watchdog] ${channelId} orphan completion wake rejected (will retry): ${String(acceptance.error)}`
			);
			return false;
		}

		const key = recheck.key ?? decision.key;
		if (key) orphanWakes.mark(key);
		console.warn(
			`[watchdog] orphan completion run=${recheck.runId ?? finishedRun?.runId ?? "unknown"} channel=${channelId} ` +
				`ageMs=${Date.now() - (recheck.wakeAt ?? decision.wakeAt ?? Date.now())} via=${recheck.detectedBy ?? "notify"}`
		);
		return true;
	}

	/** Transcript a channel's live session writes to, falling back to the default path. */
	function currentTranscriptPath(channelId: string, discordSession?: DiscordSession): string {
		return discordSession?.session.sessionFile || join(sessionDir, `discord-${channelId}.jsonl`);
	}

	/**
	 * Announce background completions that were written to a transcript but never
	 * delivered, so the bot reacts without a user prompt.
	 *
	 * Runs on startup (a restart mid-workflow is the observed cause) and on every
	 * sweep. Deliberately narrow: a channel with parked messages is left to the
	 * replay path, an active session is left alone, and every wake is keyed so a
	 * restart cannot post the same completion twice.
	 */
	async function runOrphanCompletionSweep(): Promise<void> {
		for (const channelId of orphanCandidateChannels()) {
			try {
				if (recoveringChannels.has(channelId)) continue;
				// The replay path owns a channel whose waiters are already queued.
				if (pendingMessages.forChannel(channelId).length > 0) continue;

				const discordSession = sessionStore.get(channelId);
				if (discordSession?.isModelActive()) continue;

				const tail = parseTranscriptTail(
					readTranscriptTail(currentTranscriptPath(channelId, discordSession))
				);
				// An unreadable tail is not evidence of an orphan; only an unparseable
				// mixture with zero usable records is worth refusing on.
				if (tail.meaningfulCount === 0) continue;

				const decision = isOrphanCompletion({
					channelId,
					tail,
					finishedRun: newestFinishedRun(channelId),
					now: Date.now(),
					isWoken: (key) => orphanWakes.has(key),
				});
				if (!decision.orphan) continue;

				await wakeOrphanedCompletion(channelId, decision);
			} catch (err) {
				console.error(`[discord] Orphan completion check failed for ${channelId}:`, err);
			}
		}
	}

	/**
	 * Re-send messages parked while the channel was draining background subagent
	 * work (see src/pending-messages.ts) now that the blocking run is gone.
	 *
	 * Entries stay parked when the session is still busy or the send fails, so a
	 * later sweep retries them instead of losing the message.
	 */
	async function replayPendingMessages(channelId: string): Promise<number> {
		const parked = pendingMessages.forChannel(channelId);
		if (parked.length === 0) return 0;
		// The 60s sweep runs fire-and-forget: without this guard a slow replay (it
		// used to await an unbounded abort) overlapped the next tick and re-sent the
		// same parked snapshot.
		if (replaysInFlight.has(channelId)) {
			log(`[${channelId}] Replay already in flight - skipping ${parked.length} parked message(s)`);
			return 0;
		}

		const discordSession = sessionStore.get(channelId);
		if (!discordSession) {
			log(`[${channelId}] Cannot replay ${parked.length} parked message(s): no session for this channel`);
			return 0;
		}

		replaysInFlight.add(channelId);
		try {
			// A replay without a subscription is invisible: the user message never
			// surfaces as an event, so delivery cannot be observed and the answer would
			// post nowhere. Subscribe first, exactly as handleMessage() does.
			if (!sessionSubscriptions.has(channelId)) {
				const replayChannel = await fetchChannelObject(channelId);
				if (replayChannel) {
					ensureChannelSubscription(channelId, discordSession, replayChannel);
					log(`[${channelId}] Replay: subscribed to the session so delivery can be observed`);
				}
			}
			if (discordSession.isModelActive()) {
				// Parked messages are re-delivered for a run that swallowed them, but an
				// active run is not by itself proof of a wedge: a long bash tool or a sync
				// subagent child holds the turn open without emitting anything. Aborting
				// those every 60s is exactly the live-work destruction the watchdog gates
				// exist to prevent, so ask the same gates first and leave the messages
				// parked when they refuse.
				const refusal = await parkedReplayAbortRefusal(discordSession, channelId);
				if (refusal) {
					log(
						`[${channelId}] Replay: not aborting the active run (${refusal}) - leaving ${parked.length} message(s) parked`
					);
					return 0;
				}
				// Nothing can be delivered while a wedged run (a stuck agent_end drain)
				// holds the session, so abort it - bounded, or the replay itself would hang.
				log(`[${channelId}] Replay: aborting stuck model activity before re-delivering ${parked.length} message(s)`);
				await abortModelActivitiesBounded(discordSession, channelId);
			}

			// Messages already sitting in the SDK's follow-up queue are delivered by the
			// session itself; replaying them as well would send them twice. Leave them
			// parked and let a later sweep retry once that queue has drained.
			//
			// This raw count includes followUps this process pushed while the run was
			// still active, so the guard is only correct because the 60s self-heal
			// sweep runs recoverStuckSession() for every channel BEFORE it calls this
			// function: recovery recreates the session, which empties that queue. Do
			// not reorder those two passes.
			const alreadyQueued = discordSession.session.pendingMessageCount;
			if (alreadyQueued > 0) {
				log(`[${channelId}] Replay: ${alreadyQueued} message(s) still queued in the session - leaving ${parked.length} parked for a later sweep`);
				return 0;
			}

			let replayed = 0;
			for (const entry of parked) {
				if (discordSession.isModelActive()) {
					log(`[${channelId}] Replay: session active again, leaving ${parked.length - replayed} message(s) parked`);
					break;
				}
				log(`[${channelId}] Replaying queued message ${entry.discordMessageId}: ${entry.content.slice(0, 50)}`);
				// Delivery, not turn completion, decides whether the entry is done. The SDK's
				// sendUserMessage() resolves only when the whole run settles
				// (sendUserMessage -> prompt -> the run's finally), and a run can wedge
				// AFTER its final assistant message - the exact failure this replay exists
				// for. Awaiting it left an already-delivered message parked forever: seen
				// live as "Replaying queued message <id>" with no matching
				// "[pending-messages] Delivered queued message <id>", still on disk, and
				// replayed a second time after the next restart.
				const subscription = sessionSubscriptions.get(channelId);
				subscription?.setPendingDiscordMessageId(entry.discordMessageId, false);
				const sendOutcome = discordSession.session.sendUserMessage(entry.content).then(
					() => ({ kind: "settled" as const }),
					(error: unknown) => ({ kind: "rejected" as const, error })
				);
				const delivered = subscription?.waitForUserMessageDelivered(
					entry.discordMessageId,
					REPLAY_DELIVERY_TIMEOUT_MS
				);
				const outcome = await Promise.race([
					sendOutcome,
					...(delivered ? [delivered.then((ok) => ({ kind: "delivered" as const, ok }))] : []),
				]);

				if (outcome.kind === "rejected") {
					// Nothing was queued: leave it parked and stop this sweep so a failing
					// session is not hammered with the rest of the backlog.
					log(`[${channelId}] Replay failed for ${entry.discordMessageId} (stays parked): ${outcome.error}`);
					break;
				}
				if (outcome.kind === "delivered" && !outcome.ok) {
					// No delivery event within the window and the run never settled either.
					// Keep the durable copy: a later sweep retries once the session is free.
					log(
						`[${channelId}] Replay: ${entry.discordMessageId} not confirmed delivered within ` +
							`${REPLAY_DELIVERY_TIMEOUT_MS}ms - stays parked`
					);
					break;
				}

				pendingMessages.remove(channelId, entry.discordMessageId);
				replayed++;
			}
			return replayed;
		} finally {
			replaysInFlight.delete(channelId);
		}
	}

	function getChannelDisplayName(channel: DMChannel | TextChannel | NewsChannel | ThreadChannel): string {
		if (channel.type === ChannelType.DM) {
			const dmChannel = channel as DMChannel;
			return dmChannel.recipient?.username || "DM";
		}
		return ((channel as TextChannel | NewsChannel | ThreadChannel).name) || "Unknown";
	}

	/**
	 * Run the abort for the interrupt path with a hard time limit.
	 *
	 * The SDK's abort() awaits waitForIdle(), which stays open while pi-subagents
	 * drains background subagents inside its agent_end handler (default timeout
	 * 30 minutes) — and aborting does not stop that drain, because async subagents
	 * are detached processes in their own process group. Waiting for it is what
	 * made a new message look ignored, so give up after abortWaitTimeoutMs and let
	 * the send path queue the message as a follow-up instead.
	 *
	 * Never throws. Returns true when the abort settled within the limit.
	 */
	async function abortModelActivitiesBounded(discordSession: DiscordSession, channelId: string): Promise<boolean> {
		const abortSettled = discordSession.abortModelActivities().then(
			() => true,
			(error) => {
				log(`[${channelId}] Abort failed: ${error}`);
				return true;
			}
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => {
				log(
					`[${channelId}] abort did not settle within ${abortWaitTimeoutMs}ms (run still draining) - continuing`
				);
				resolve(false);
			}, abortWaitTimeoutMs);
		});
		try {
			return await Promise.race([abortSettled, timedOut]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/**
	 * Evaluate the watchdog gates for a channel's current session.
	 *
	 * The 60s sweep and the first-contact path in handleMessage() must ask exactly
	 * the same question — "is this active run provably wedged?" — so both call this
	 * instead of assembling the inputs twice. A second copy of the gate list is how
	 * a live turn ends up destroyed by one path while the other refuses.
	 */
	function evaluateStuckRunForChannel(channelId: string, discordSession: DiscordSession): StuckRunEvaluation {
		const work = subagentWorkLiveness(discordSession);
		return evaluateStuckRun({
			modelActive: discordSession.isModelActive(),
			idleMs: Date.now() - (lastSdkEventAt.get(channelId) ?? Date.now()),
			thresholdMs: stuckRunThresholdMs,
			hasPendingBackgroundWork: work.async,
			inFlightToolCount: inFlightToolCounts.get(channelId) ?? 0,
			hasActiveSubagentWork: work.sync,
			priorConfirmations: stuckRunConfirmations.get(channelId) ?? 0,
		});
	}

	/**
	 * Ask the post-completion stall question for a channel's current session.
	 *
	 * Two phases because the child-process probe is a subprocess: the cheap gates
	 * (is the run active, did its final message land, has anything happened since,
	 * is a tool running, how long has it been) decide whether probing is worth
	 * anything at all. `liveChildProcessCount: 0` in phase one is not a claim — it
	 * simply cannot refuse there, and phase two re-evaluates with the real count.
	 *
	 * Returns the refusing gate, or null when the turn is provably over and its
	 * settle path never finished.
	 */
	async function evaluatePostCompletionStallForChannel(
		channelId: string,
		discordSession: DiscordSession
	): Promise<{ refusal: PostCompletionStallRefusal | null; liveChildPids: number[] }> {
		const terminalAt = terminalMessageAt.get(channelId);
		const work = subagentWorkLiveness(discordSession);
		const base: PostCompletionStallInput = {
			modelActive: discordSession.isModelActive(),
			msSinceTerminalMessage: terminalAt === undefined ? undefined : Date.now() - terminalAt,
			eventSinceTerminal:
				terminalAt !== undefined && (lastSdkEventAt.get(channelId) ?? 0) > terminalAt,
			inFlightToolCount: inFlightToolCounts.get(channelId) ?? 0,
			// Async subagent children run detached (own process group), so they are
			// neither a tool in flight nor a child of this process: only the gate
			// accounting can see that a drain is legitimately still waiting — and that
			// accounting is cross-checked against the run store, because a *finished*
			// run whose completion notice is still queued is the wedge itself.
			hasPendingSubagentWork: work.sync || work.async,
			liveChildProcessCount: 0,
			graceMs: postCompletionStallGraceMs,
		};

		const cheapRefusal = evaluatePostCompletionStall(base);
		if (cheapRefusal !== null) return { refusal: cheapRefusal, liveChildPids: [] };

		const liveChildPids = await findLiveChildPids();
		const refusal = evaluatePostCompletionStall({
			...base,
			liveChildProcessCount: liveChildPids.length,
		});
		return { refusal, liveChildPids };
	}

	/**
	 * Heal a wedged channel when the user writes into it, instead of answering 🛑.
	 *
	 * Waiting for the sweep means the first prompt after a wedge is answered with
	 * "🛑 Interrupted by user" and then parked behind a run that can never settle:
	 * the user's message is destroyed either way, so there is nothing to protect by
	 * waiting. Two detections can admit a channel here: the post-completion stall
	 * (precise — the turn's final message is on disk and nothing has happened since)
	 * or the generic idle watchdog (silent past the 45-minute threshold, confirmation
	 * streak met).
	 *
	 * Returns true when the channel is usable and the caller must skip the interrupt
	 * path; false when the gates refused and today's interrupt behaviour applies.
	 */
	async function recoverWedgedSessionOnFirstContact(
		channelId: string,
		discordSession: DiscordSession
	): Promise<boolean> {
		const evaluation = evaluateStuckRunForChannel(channelId, discordSession);
		const stall = await evaluatePostCompletionStallForChannel(channelId, discordSession);
		const stalled = stall.refusal === null;
		if (!evaluation.shouldRecover && !stalled) return false;

		// Last resort before destroying a session, same as in the sweep: a live
		// child (sync subagent, process tool) means the silence is work. The stall
		// probe already checked; the idle path has not.
		if (!stalled) {
			const childPids = await findLiveChildPids();
			if (childPids.length > 0) {
				console.warn(
					`[watchdog] ${channelId} first contact refused: ${childPids.length} child process(es) alive (pids ${childPids.join(",")})`
				);
				return false;
			}
		}

		const terminalAt = terminalMessageAt.get(channelId);
		const idleMs = Date.now() - (lastSdkEventAt.get(channelId) ?? Date.now());
		const since = stalled
			? `post-completion stall ${terminalAt === undefined ? 0 : Date.now() - terminalAt}ms after final message`
			: `idle ${Math.round(idleMs / 1000)}s`;
		console.warn(`[watchdog] ${channelId} first-contact recovery, ${since} - no interrupt message`);
		try {
			await recoverStuckSession(channelId);
		} catch (err) {
			console.error(`[discord] First-contact recovery failed for ${channelId}:`, err);
			return false;
		}
		return true;
	}

	/**
	 * Force a wedged channel back to a usable session.
	 *
	 * A run can park between `agent_end` and the SDK's settle path, and only that
	 * settle path clears `_isAgentRunActive` — so `isModelActive()` stays true,
	 * every incoming message looks like an interrupt, and `abort()` waits on a flag
	 * nothing will ever clear (its bounded wait always times out). That phase has
	 * no deadline, so the only remaining lever is to throw the session object away
	 * and reopen it from the transcript: `dispose()` + `getOrCreate()` is the same
	 * path /cwd already uses. The recreated session has an empty follow-up queue,
	 * which is what lets replayPendingMessages() deliver the parked messages.
	 *
	 * Returns true when the session had to be recreated.
	 */
	async function recoverStuckSession(channelId: string): Promise<boolean> {
		const existing = recoveriesInFlight.get(channelId);
		if (existing) {
			log(`[watchdog] ${channelId} recovery already in flight - waiting for it`);
			return existing;
		}
		recoveringChannels.add(channelId);
		// .finally() stands outside recreateStuckSession() on purpose: an early
		// `return false` inside it resolves the promise in the same tick, and a
		// guard cleared before the map entry exists would leave a resolved promise
		// behind that every later recovery would await forever.
		const recovery = recreateStuckSession(channelId).finally(() => {
			recoveringChannels.delete(channelId);
			recoveriesInFlight.delete(channelId);
		});
		recoveriesInFlight.set(channelId, recovery);
		return recovery;
	}

	async function recreateStuckSession(channelId: string): Promise<boolean> {
		const discordSession = sessionStore.get(channelId);
		if (!discordSession) return false;

		// Logged here rather than at each call site: every recovery goes through
		// this function, and the snapshot is only useful right before the teardown
		// that would destroy the evidence.
		logOutstandingSubagentRuns(channelId);

		const idleMs = Date.now() - (lastSdkEventAt.get(channelId) ?? Date.now());
		const idleSeconds = Math.round(idleMs / 1000);

		// Stage 1: a plain abort is cheap and keeps the live session (and its
		// context), so try it first — a run that is merely slow still settles.
		const abortSettled = await abortModelActivitiesBounded(discordSession, channelId);
		if (abortSettled && !discordSession.isModelActive()) {
			log(`[watchdog] ${channelId} idle ${idleSeconds}s, abort settled - session kept`);
			return false;
		}

		// Stage 2: still active after the bounded abort, so the run cannot settle.
		// console.warn, not log(): log() is gated on DISCORD_DEBUG, and a session
		// teardown on a live channel must be visible in the journal.
		console.warn(`[watchdog] ${channelId} idle ${idleSeconds}s, abort did not settle - recreating session`);
		sessionStore.dispose(channelId);
		// The wedged turn never reached its agent_end cleanup, so its typing
		// indicator would otherwise keep pulsing until Discord's own timeout.
		typingManager.hide(channelId);
		// Drop every per-channel binding to the dead session, or the re-subscribe
		// below makes every agent event fire twice (the duplicate-output hazard
		// subscribeToSession() cannot dedup by itself).
		subscribedSessions.delete(channelId);
		sessionSubscriptions.delete(channelId);
		sessionMessageIndex.delete(channelId);
		discordMessageToSession.delete(channelId);
		lastSdkEventAt.delete(channelId);
		stuckRunConfirmations.delete(channelId);
		terminalMessageAt.delete(channelId);
		// The wedged run's tool is gone with it; a stale count would otherwise
		// block the next recovery for this channel.
		inFlightToolCounts.delete(channelId);
		cronSubscribedSessions.delete(channelId); // keeper re-binds on its next pass

		const recreated = await sessionStore.getOrCreate(channelId, sessionStore.getChannelName(channelId));
		const channel = await fetchChannelObject(channelId);
		if (channel) {
			// Replayed prompts must stream their output somewhere: without a
			// subscription the agent would answer into the void.
			const sub = subscribeToSession(
				recreated.session,
				channelId,
				channel,
				typingManager,
				sessionDir,
				getChannelOutputSettings
			);
			subscribedSessions.add(channelId);
			sessionSubscriptions.set(channelId, sub);
			log(`[watchdog] ${channelId} session recreated and re-subscribed`);
		} else {
			// handleMessage() subscribes on the next user message instead.
			log(`[watchdog] ${channelId} session recreated without a channel object - subscribing on next message`);
		}
		stampSdkActivity(channelId);
		return true;
	}

	/**
	 * Shut the bot down for /exit.
	 *
	 * shutdown() can hang (disposing sessions waits on the same agent_end drain),
	 * so a hard exit is armed first: the user asked to exit, and an unresponsive
	 * bot that ignores /exit is worse than a slightly unclean exit.
	 */
	async function exitBot(
		channel: DMChannel | TextChannel | NewsChannel | ThreadChannel,
		channelId: string
	): Promise<void> {
		// Armed before anything that can block: sendToDiscord() rethrows channel.send
		// failures (missing permissions, unresolvable channel, 429) and shutdown()
		// waits on the same agent_end drain that made /exit look ignored. The user
		// asked to exit, so nothing here may prevent or delay it.
		setTimeout(() => {
			console.error(`[discord] Shutdown did not finish within ${shutdownHardExitTimeoutMs}ms - forcing exit`);
			process.exit(0);
		}, shutdownHardExitTimeoutMs).unref();

		const queue = promptQueue.get(channelId);
		if (queue && queue.length > 0) {
			try {
				await sendToDiscord(
					channel as DMChannel | TextChannel | NewsChannel,
					`⚠️ **Exiting with ${queue.length} queued prompt(s) that will be lost:**\n${queue.map((p, i) => `${i + 1}. ${p.length > 80 ? p.slice(0, 80) + '...' : p}`).join('\n')}`
				);
				promptQueue.delete(channelId);
			} catch (error) {
				// Keep the queue so savePromptQueue() below persists it for the restart.
				console.error("[discord] Failed to announce discarded queued prompts:", error);
			}
		}
		try {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "😵 Exiting");
		} catch (error) {
			console.error("[discord] Failed to send exit notice:", error);
		}
		try {
			savePromptQueue();
		} catch (error) {
			console.error("[discord] Failed to save the prompt queue on exit:", error);
		}
		shutdown().catch((error) => {
			console.error("[discord] Shutdown failed - forcing exit:", error);
			process.exit(1);
		});
	}

	async function handleMessage(
		channel: DMChannel | TextChannel | NewsChannel | ThreadChannel,
		message: any
	): Promise<void> {
		const channelId = channel.id;
		const channelName = getChannelDisplayName(channel);

		// /exit is control-plane: it must work even when the session is wedged.
		// Handling it before any session lookup, subscribe or abort means it can
		// never be parked behind a turn that never settles.
		if (message.content?.trim() === "/exit") {
			await exitBot(channel, channelId);
			return;
		}

		// Show typing immediately for real prompts (non-command messages) so the
		// user sees activity during session setup, image downloads and the wait
		// for the first API response — not just once streaming starts. Command
		// messages (slash/!/..) are handled below and show typing only where
		// they actually trigger work.
		const messageContent = message.content?.trim() ?? "";
		if (!messageContent.startsWith("/") && !messageContent.startsWith("!")) {
			typingManager.show(channelId, createTypingChannel(channelId));
		}

		sessionStore.setChannelName(channelId, channelName);
		let discordSession = await sessionStore.getOrCreate(channelId, channelName);
		// Both are reassigned below when the watchdog rebuilds the session under us —
		// the disposed object would silently swallow the prompt.
		let session = discordSession.session;

		// Store Discord message ID for tracking in session
		// We'll track it when the message_start event fires
		const currentDiscordMsgId = message.id;

		// Track user message for deletion handling (old approach for assistant/tool messages)
		// User messages are at index = session.messages.length before we add them
		const userMessageIndex = session.messages.length;
		if (!discordMessageToSession.has(channelId)) {
			discordMessageToSession.set(channelId, new Map());
		}
		discordMessageToSession.get(channelId)!.set(message.id, {
			sessionIndex: userMessageIndex,
			type: "user"
		});

		// Check for non-interrupting commands (slash commands that should not abort the agent)
		const isNonInterruptingCommand = message.content === "/session" || message.content.startsWith("/session ") ||
			message.content === "/fork" || message.content.startsWith("/fork ") ||
			message.content === "/new" ||
			message.content === "/resume" || message.content.startsWith("/resume ") ||
			message.content === "/queue" || message.content.startsWith("/queue ") ||
			message.content === "/label" || message.content.startsWith("/label ") ||
			message.content === "/labels" ||
			message.content === "/sessions" ||
			message.content === "/cwd" || message.content.startsWith("/cwd ") ||
			message.content === "/channel" ||
			message.content === "/help" ||
			message.content === "/session" ||
			message.content === "/models" || message.content.startsWith("/models ") ||
			message.content === "/model" || message.content.startsWith("/model ") ||
			message.content === "/settings" ||
			message.content === "/hide" || message.content.startsWith("/hide ") ||
			message.content === "/show" || message.content.startsWith("/show ") ||
			message.content === "/compact" || message.content.startsWith("/compact ");

		// Only abort if the agent is active AND this is not a non-interrupting command.
		// Any new message aborts the running main turn: async background subagents
		// live in their own process group and keep running, so there is nothing to
		// wait for (waiting is what used to swallow messages behind a stuck turn).
		const shouldInterrupt = shouldInterruptForIncomingMessage({
			modelActive: discordSession.isModelActive(),
			nonInterruptingCommand: isNonInterruptingCommand,
		});
		if (shouldInterrupt) {
			// The run may be wedged rather than busy: a wedged run never settles, so
			// interrupting it only parks this prompt behind a queue nothing drains.
			// Same gates as the 60s sweep, so the two paths cannot disagree about
			// whether this silence is work.
			const healed = await recoverWedgedSessionOnFirstContact(channelId, discordSession);
			// Recovery either replaced the session or, when its rebuild failed, left the
			// channel with none: dispose() sets no flag, so prompt() on the old object
			// would run on an orphan the store no longer tracks. Re-read the store on
			// both outcomes instead of trusting the local reference.
			const storedSession = sessionStore.get(channelId);
			if (storedSession && storedSession !== discordSession) {
				discordSession = storedSession;
				session = storedSession.session;
				// The rebuild dropped this channel's Discord→session index, so re-register
				// the prompt at its place in the fresh transcript (message deletion and
				// reply branching read that index).
				const index = discordMessageToSession.get(channelId) ?? new Map();
				discordMessageToSession.set(channelId, index);
				index.set(message.id, { sessionIndex: session.messages.length, type: "user" });
			} else if (!storedSession) {
				// The watchdog disposed the wedged session and the rebuild failed (e.g.
				// getOrCreate threw): there is nothing left to deliver into, so park the
				// text durably and say so rather than dropping it on an orphan.
				console.error(`[${channelId}] Recovery left no session - parking message ${message.id}`);
				const undeliverableText = (message.content ?? "").trim();
				if (undeliverableText) {
					pendingMessages.add({
						channelId,
						discordMessageId: message.id,
						authorId: message.author?.id,
						authorName: message.author?.username,
						content: message.content ?? "",
						queuedAt: Date.now(),
						reason: "recovery-failed",
					});
				}
				typingManager.hide(channelId);
				await sendToDiscord(
					channel as DMChannel | TextChannel | NewsChannel,
					"⚠️ Session recovery failed - your message is queued and will be retried."
				).catch(() => {});
				return;
			}
			if (!healed) {
				log(`[${channelId}] User interrupted - aborting current operation`);
				sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "🛑 Interrupted by user").catch(() => {});
				// Bounded: abort() can stay open for as long as the agent_end drain. The
				// send path below parks the message if the session is still busy.
				await abortModelActivitiesBounded(discordSession, channelId);
				// dont hide typing manager, fall through to sending the interrupted message to the agent
			}
		}

		// Store the Discord message ID so it can be tracked when the user message is processed
		if (currentDiscordMsgId) {
			pendingDiscordMessages.set(channelId, currentDiscordMsgId);
		}

		// Subscribe to session events once
		// FIX: Add to set BEFORE calling subscribeToSession to prevent race condition
		// where two rapid messages could both pass the has() check before either adds
		if (recoveringChannels.has(channelId)) {
			// The watchdog is replacing this channel's session right now; it
			// re-subscribes when it is done. Subscribing here as well would leave two
			// listeners on one session and post every event twice.
			log(`[${channelId}] Session recovery in flight - subscription handled by the watchdog`);
		} else if (!subscribedSessions.has(channelId)) {
			subscribedSessions.add(channelId);
			subscribeCount++;
			log(`[${channelId}] Subscribing to session (total subscriptions: ${subscribeCount})`);
			const sub = subscribeToSession(session, channelId, channel as DMChannel | TextChannel | NewsChannel, typingManager, sessionDir, getChannelOutputSettings);
			sessionSubscriptions.set(channelId, sub);
		} else {
			log(`[${channelId}] Already subscribed, skipping`);
		}

		log(`[${channelId}] handleMessage complete. sendToDiscord called ${sendCount} times total so far`);

		// Update last activity
		sessionStore.touch(channelId);

		// Handle reply branching - update metadata before sending message
		const metadata = loadBranchMetadata(sessionDir, channelId);

		// Prepare content for the agent (text + images)
		const agentContent: any[] = [];
		if (message.content?.trim()) {
			agentContent.push({ type: "text", text: message.content });
		}

		// Add image attachments
		log(`[${channelId}] Processing ${message.attachments?.size ?? 0} attachments`);
		if (message.attachments) {
			for (const attachment of message.attachments.values()) {
				log(`[${channelId}] Attachment found: ${JSON.stringify({ id: attachment?.id, url: attachment?.url, contentType: attachment?.contentType })}`);
				if (!attachment || !attachment.url) {
					log(`[${channelId}] Attachment missing URL!`);
					continue;
				}

				const urlWithoutQuery = attachment.url.split('?')[0];
				const isImage = attachment.contentType?.startsWith('image/') || 
								 /\.(jpg|jpeg|png|gif|webp)$/i.test(urlWithoutQuery);
				
				if (isImage) {
					const mimeType = attachment.contentType || 
									 (urlWithoutQuery.endsWith('.png') ? 'image/png' : 
									  urlWithoutQuery.endsWith('.gif') ? 'image/gif' : 
									  urlWithoutQuery.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
					try {
						const response = await fetch(attachment.url);
						const buffer = await response.arrayBuffer();
						const base64Data = Buffer.from(buffer).toString('base64');
						log(`[${channelId}] Base64 conversion: length=${base64Data.length}, snippet=${base64Data.slice(0, 30)}...`);
						log(`[${channelId}] Adding image attachment: ${attachment.url} (MIME: ${mimeType})`);

						// Downscale/compress images before sending to the LLM. Discord
						// attachments are often multi-MB photos; sending them at full size
						// makes every request carry megabytes of base64 per image. Heavy
						// multimodal payloads make some providers (e.g. opencode-go) drop
						// the stream before it finishes ("Stream ended without
						// finish_reason"). Falls back to the original if resizing fails.
						const { downscaleImage } = await import("./image-utils.ts");
						const downscaled = await downscaleImage(base64Data, mimeType);
						const imageData = downscaled.data;
						const imageMime = downscaled.mimeType;
						if (downscaled.wasDownscaled) {
							log(`[${channelId}] Image downscaled: ${base64Data.length} → ${imageData.length} base64 chars (${imageMime})`);
						}

						const imagePart = {
							type: "image",
							data: imageData,
							mimeType: imageMime,
						};
						log(`[${channelId}] imagePart data starts with: ${imageData.startsWith('http') ? 'URL (WRONG)' : 'Base64 (CORRECT)'}`);
						agentContent.push(imagePart);
					} catch (e) {
						log(`[${channelId}] Failed to fetch image ${attachment.url}: ${e}`);
					}
				} else {
					log(`[${channelId}] Skipping non-image attachment: ${attachment.url} (MIME: ${attachment.contentType})`);
				}
			}
		}

		if (message.content === "/help") {
			const helpText = `📖 **pi-discord Help Guide**\n\n` +
				`**General Commands**\n` +
				`• \`/session [label]\` - Close current session and start fresh (label for /resume [label])\n` +
				`• \`/session\` - Show current session info and stats\n` +
				`• \`/stats\` - Show token utilization and changes\n` +
				`• \`/channel\` - Show current channel info (ID, name)\n` +
				`• \`/cwd\` - Show current working directory\n` +
				`• \`/cwd [path]\` - Change session working directory\n` +
				`• \`/queue [prompt]\` - Queue a prompt to run after current task\n` +
				`• \`/resume [id or label]\` - Resume a previously closed session\n` +
				`• \`/clear\` - Reset session and start fresh\n` +
				`• \`/reload\` - Reload extensions, skills, and themes\n` +
				`• \`/exit\` - Shut down the bot\n` +
				`• \`/stop\` - Stop current agent operation\n` +
				`• \`/compact [instructions]\` - Start a fresh session with a summary of this one (original stays resumable via /resume)\n\n` +
				`**Model & Settings**\n` +
				`• \`/models\` - List available models\n` +
				`• \`/model [provider/id]\` - Change current model\n` +
				`• \`/thinking [level]\` - Set thinking level (e.g., \`/thinking high\`)\n` +
				`• \`/settings\` - Show current agent settings\n` +
				`• \`/hide thinking|tools\` - Hide thinking/tool call blocks in this channel\n` +
				`• \`/show thinking|tools\` - Show thinking/tool call blocks in this channel\n\n` +
				`**Branching & History**\n` +
				`• \`/fork [label]\` - Create a NEW session (new id) with the full history copied in; original stays resumable via /resume\n` +
				`• \`/label [name]\` - Label current session for /resume [label]\n` +
				`• \`/labels\` - List all closed/labeled sessions\n` +
				`• \`/sessions\` - List resumable sessions with a preview of each\n` +
				`• \`/merge [name]\` - Merge branch from label or reply\n` +
				`• \`/summary [name]\` - Summarize changes from a branch\n\n` +
				`**Bash Integration**\n` +
				`• \`!command\` - Execute bash command (added to context)\n` +
				`• \`!!command\` - Execute bash command (hidden from context)`;
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, helpText);
			return;
		}

		if (message.content === "/channel") {
			const channelInfo = `📌 **Channel Info**\n` +
				`**ID:** \`${channelId}\`\n` +
				`**Name:** ${channel.type === ChannelType.DM ? 'DM' : `\`${(channel as TextChannel).name}\``}\n` +
				`**Type:** ${ChannelType[channel.type]}\n` +
				`**Session tracked:** ✅ (by channelId, survives renames)`;
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, channelInfo);
			return;
		}

		if (message.content === "/queue" || message.content.startsWith("/queue ")) {
			const prompt = message.content.slice("/queue ".length).trim();
			if (!prompt) {
				const queue = promptQueue.get(channelId) || [];
				if (queue.length === 0) {
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "📭 Queue is empty");
				} else {
					const queueText = queue.map((p, i) => `${i + 1}. ${p.length > 80 ? p.slice(0, 80) + '...' : p}`).join('\n');
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `📋 **Queued prompts** (${queue.length}):\n${queueText}`);
				}
				return;
			}

			// Add to queue
			if (!promptQueue.has(channelId)) {
				promptQueue.set(channelId, []);
			}
			promptQueue.get(channelId)!.push(prompt);
			const position = promptQueue.get(channelId)!.length;
			savePromptQueue();
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `📥 Prompt queued (#${position}): ${prompt.length > 100 ? prompt.slice(0, 100) + '...' : prompt}`);
			return;
		}

		if (message.content === "/stop") {
			typingManager.hide(channelId);
			return;
		}

		// Handle bash commands (!command or !!command)
		if (message.content.startsWith("!")) {
			const isExcluded = message.content.startsWith("!!");
			const command = isExcluded 
				? message.content.slice(2).trim()
				: message.content.slice(1).trim();

			if (!command) {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ Usage: `!command` or `!!command`");
				return;
			}

			log(`[${channelId}] Executing bash command: ${command}`);
			typingManager.show(channelId, createTypingChannel(channelId));

			try {
				const output: string[] = [];
				await session.executeBash(command, (chunk) => {
					output.push(chunk);
				}, { excludeFromContext: isExcluded });

				const fullOutput = output.join("");
				if (fullOutput) {
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `📄 Output:\n\`\`\`\n${escapeForCodeBlock(fullOutput)}\n\`\`\``);
				} else {
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "✅ Command executed (no output)");
				}
			} catch (error) {
				console.error(`[${channelId}] Bash error:`, error);
				// Truncate error message to avoid exceeding Discord's limit
				const errorStr = String(error);
				const truncatedError = errorStr.length > 1800 ? errorStr.substring(0, 1800) + "... (truncated)" : errorStr;
				const errorMessage = `❌ Bash error: ${truncatedError}`;
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, errorMessage);
			} finally {
				// Bash execution doesn't emit agent events — hide typing explicitly.
				typingManager.hide(channelId);
			}
			return;
		}

		// Handle /cwd command
		if (message.content === "/cwd" || message.content.startsWith("/cwd ")) {
			if (message.content === "/cwd") {
				const cwd = session.sessionManager.getCwd();
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `📂 Current working directory:\n\`${cwd}\``);
			} else {
				const newCwd = message.content.slice("/cwd ".length).trim();
				if (!newCwd) {
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ Usage: `/cwd [path]`");
				} else {
					try {
						const expandedPath = await sessionStore.changeCwd(channelId, newCwd);
						// changeCwd recreates the session — rebind scheduled jobs to the
						// recreated session's UUID (it can drift if the file is gone).
						rebindChannelJobsToLiveSession(channelId);
						await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `✅ Changed working directory to:\n\`${expandedPath}\``);

						// changeCwd recreates the session with the new cwd — clear the
						// subscription/tracking state so the recreated session gets
						// subscribed on the next message.
						subscribedSessions.delete(channelId);
						sessionSubscriptions.delete(channelId);
						sessionMessageIndex.delete(channelId);
						discordMessageToSession.delete(channelId);
					} catch (error) {
						console.error(`[${channelId}] /cwd error:`, error);
						await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `❌ Error changing directory: ${error}`);
					}
				}
			}
			return;
		}

		if (message.content === "/stats") {
			const statsResult = generateTokenStatsMessage(channelId, session, previousTokens);
			if (statsResult) {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, statsResult.message);
			} else {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ No token stats available for this session.");
			}
			return;
		}

		// /exit is handled at the top of handleMessage, before the session is
		// touched, so a wedged turn can never swallow it.

		// Handle /session command
		// /session - Close current session and start fresh (no label)
		// /session [label] - Close current session and start fresh with a label
		if (message.content === "/session" || message.content.startsWith("/session ")) {
			const label = message.content.slice("/session".length).trim();

			try {
				// Capture old session stats BEFORE closing (session is disposed after)
				const oldStats = session.getSessionStats();
				const oldStatsResult = generateTokenStatsMessage(channelId, session, previousTokens);
				const oldSessionId = oldStats.sessionId;

				await sessionStore.closeAndNewSession(channelId, label || undefined);

				// Create the new session, then rebind scheduled jobs to its UUID.
				// The old dispose/recreate "restart dance" was unreliable: a brand-
				// new session doesn't flush its file until the first message, so
				// every getOrCreate minted a NEW random UUID and the job ended up
				// bound to a ghost session — silently skipped by both the extension
				// and the keeper. We bind once to whatever UUID is actually live;
				// the session keeper re-checks and self-heals every 60s anyway and
				// catches up any missed runs.
				// CRITICAL: We DO NOT delete job.session first — doing so would make
				// the job fire in ALL channels (isLoadedFor returns true for undefined).
				await sessionStore.getOrCreate(channelId);
				rebindChannelJobsToLiveSession(channelId);

				// If a label was provided, label the new active session too
				if (label) {
					sessionLabels.set(channelId, label);
				}

				// Clear branch metadata for new session
				const meta = loadBranchMetadata(sessionDir, channelId);
				meta.discordMsgToPiEntryId.clear();
				meta.discordMsgParent.clear();
				meta.mainBranchTip = null;
				meta.labelCounter = 0;
				meta.labels.clear();
				saveBranchMetadata(sessionDir, channelId, meta);

				// Remove this channel from subscribed sessions so the new session gets subscribed
				subscribedSessions.delete(channelId);
				sessionSubscriptions.delete(channelId);
				sessionMessageIndex.delete(channelId);
				discordMessageToSession.delete(channelId);

				// Build message: stats first, then resume hint, then new session confirmation
				const resumeArg = label || oldSessionId;
				const resumeHint = `Use \`/resume ${resumeArg}\` to resume this session.`;

				let msg = '';
				if (oldStatsResult) {
					msg += oldStatsResult.message + '\n\n';
				} else {
					// Fallback basic stats when context usage data is unavailable
					msg += `📊 **Token Utilization**\n`;
					msg += `**In:** ${oldStats.tokens.input.toLocaleString()} tok\n`;
					msg += `**Out:** ${oldStats.tokens.output.toLocaleString()} tok\n`;
					msg += `**Messages:** ${oldStats.totalMessages ?? '?'}\n`;
					msg += `\n`;
				}
				msg += `${resumeHint}\n\n`;
				msg += `✅ New session started.`;

				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, msg);
			} catch (error) {
				console.error(`[${channelId}] /session error:`, error);
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
					`❌ Error: ${error}`
				);
			}
			return;
		}

		// Handle /fork command
		// /fork - Fork the pi-native way: create a NEW session (fresh UUID) via
		//         SessionManager.createBranchedSession() with the full history
		//         (root → current position, incl. tool calls and labels)
		//         replayed into it, and continue working there. The ORIGINAL
		//         pre-fork session becomes a resumable snapshot.
		// /fork [label] - Same, with a label for the snapshot
		if (message.content === "/fork" || message.content.startsWith("/fork ")) {
			const label = message.content.slice("/fork".length).trim();

			try {
				// Capture old session stats BEFORE forking (the manager is
				// transformed to the new session inside forkSession)
				const oldStats = session.getSessionStats();
				const oldStatsResult = generateTokenStatsMessage(channelId, session, previousTokens);
				const oldSessionId = oldStats.sessionId;

				await sessionStore.forkSession(channelId, label || undefined);

				const newSessionId = session.getSessionStats().sessionId;

				// The same AgentSession now represents the forked session (new
				// UUID) — rebind scheduled jobs to the new UUID.
				rebindChannelJobsToLiveSession(channelId);

				// The forked session replays history with FRESH entry ids, so the
				// old Discord-side branch metadata (labels, reply tree,
				// mainBranchTip) no longer resolves — clear it like /session does.
				// Replies to pre-fork bot messages can't branch across the fork.
				const meta = loadBranchMetadata(sessionDir, channelId);
				meta.discordMsgToPiEntryId.clear();
				meta.discordMsgParent.clear();
				meta.mainBranchTip = null;
				meta.labelCounter = 0;
				meta.labels.clear();
				saveBranchMetadata(sessionDir, channelId, meta);

				// Message-index tracking is invalidated by the replayed history —
				// rebuild it fresh on the next messages. The session subscription
				// is intentionally KEPT: the same AgentSession keeps streaming.
				sessionMessageIndex.delete(channelId);
				discordMessageToSession.delete(channelId);

				// Build message: stats first, then resume hint, then fork confirmation
				const resumeArg = label || oldSessionId;
				const resumeHint = `Use \`/resume ${resumeArg}\` to return to the pre-fork session.`;

				let msg = '';
				if (oldStatsResult) {
					msg += oldStatsResult.message + '\n\n';
				} else {
					// Fallback basic stats when context usage data is unavailable
					msg += `📊 **Token Utilization**\n`;
					msg += `**In:** ${oldStats.tokens.input.toLocaleString()} tok\n`;
					msg += `**Out:** ${oldStats.tokens.output.toLocaleString()} tok\n`;
					msg += `**Messages:** ${oldStats.totalMessages ?? '?'}\n`;
					msg += `\n`;
				}
				msg += `${resumeHint}\n\n`;
				msg += `🌿 Forked — new session \`${newSessionId}\` created with the full history copied in.`;

				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, msg);
			} catch (error) {
				console.error(`[${channelId}] /fork error:`, error);
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
					`❌ Error: ${error}`
				);
			}
			return;
		}

		// Handle /sessions command - list all resumable sessions with previews
		if (message.content === "/sessions") {
			await handleSessions(channel);
			return;
		}

		// Handle /resume command - resume a previously closed session
		if (message.content === "/resume" || message.content.startsWith("/resume ")) {
			const arg = message.content.slice("/resume".length).trim();

			if (!arg) {
				// List closed sessions for this channel
				const closed = sessionStore.getClosedSessions(channelId);
				if (closed.length === 0) {
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
						"📭 No previously closed sessions for this channel. Use `/session` first."
					);
				} else {
					const lines = closed.map(s => {
						const date = new Date(s.closedAt).toLocaleString();
						const lab = s.label ? ` [${s.label}]` : "";
						return `• \`${s.sessionId}\`${lab} — ${s.sessionName} (closed ${date})`;
					});
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
						`**Closed sessions for this channel:**\n${lines.join("\n")}\n\nUse \`/resume <id or label>\` to resume one.`
					);
				}
				return;
			}

			const sessionId = arg;
			try {
				const resumed = await sessionStore.resumeSession(channelId, sessionId);
				if (!resumed) {
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
						`❌ Session \`${sessionId}\` not found in closed sessions. Use \`/resume\` to list available sessions.`
					);
					return;
				}

				// Load the restored session and rebind scheduled jobs to its UUID.
				// (The restored file exists on disk, so its UUID is stable here;
				// the session keeper also self-heals and catches up missed runs.)
				// CRITICAL: We do NOT delete job.session first — doing so would make
				// the job fire in ALL channels (isLoadedFor returns true for undefined).
				await sessionStore.getOrCreate(channelId);
				rebindChannelJobsToLiveSession(channelId);

				// Clear tracking state for the resumed session
				subscribedSessions.delete(channelId);
				sessionSubscriptions.delete(channelId);
				sessionMessageIndex.delete(channelId);
				discordMessageToSession.delete(channelId);

				// Clear branch metadata for the resumed session (starts fresh tracking)
				const meta = loadBranchMetadata(sessionDir, channelId);
				meta.discordMsgToPiEntryId.clear();
				meta.discordMsgParent.clear();
				meta.mainBranchTip = null;
				meta.labelCounter = 0;
				meta.labels.clear();
				saveBranchMetadata(sessionDir, channelId, meta);

				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
					`✅ Resumed session \`${sessionId}\``
				);
			} catch (error) {
				console.error(`[${channelId}] /resume error:`, error);
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
					`❌ Error resuming session: ${error}`
				);
			}
			return;
		}

		// Handle /clear command - start a new session (no confirmation)
		if (message.content === "/clear") {
			log(`[${channelId}] Starting new session`);
			sessionStore.reset(channelId);
			// reset() mints a fresh session UUID in place — rebind scheduled jobs to
			// it or every job stays orphaned (silently skipped) until restart.
			rebindChannelJobsToLiveSession(channelId);
			metadata.discordMsgToPiEntryId.clear()
			metadata.discordMsgParent.clear()
			metadata.mainBranchTip = null;
			metadata.labelCounter = 0;
			metadata.labels.clear();
			promptQueue.delete(channelId); // Clear queued prompts
			savePromptQueue();
			saveBranchMetadata(sessionDir, channelId, metadata);
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "✅ Started new session. What would you like to work on?");
			return;
		}

		// Handle /reload command - reload extensions/skills/themes
		if (message.content === "/reload") {
			log(`[${channelId}] Reloading extensions`);
			try {
				await session.reload();
				// Re-apply settings overrides after reload as it wipes in-memory settings
				const discordSession = sessionStore.get(channelId);
				if (discordSession) {
					discordSession.applySessionSettingsOverrides();
					// /reload rebuilds the base system prompt, but the
					// before_agent_start memory hook is part of the reloaded
					// extension set — no re-application needed.
				}
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "✅ Extensions, skills, and themes reloaded.");
			} catch (error) {
				console.error(`[${channelId}] /reload error:`, error);
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `❌ Reload failed: ${error}`);
			}
			return;
		}

		if (message.content === "/models") {
			const available = (await session.modelRuntime.getAvailable()).map(({provider,id}) =>`${provider}/${id}`);
			const availableJson = escapeForCodeBlock(JSON.stringify(available, null, 2));
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `🤖 Models:\n\`\`\`json\n${availableJson}\n\`\`\``);
			return;
		}

		if (message.content === "/settings") {
			const settings = (session.settingsManager)
			const settingsJSON = escapeForCodeBlock(JSON.stringify(settings, null, 2));
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `⚙️ Settings:\n\`\`\`json\n${settingsJSON}\n\`\`\``);
			return;
		}

		// Handle /hide and /show — per-channel output visibility for thinking/tool blocks
		if (message.content === "/hide" || message.content.startsWith("/hide ") ||
			message.content === "/show" || message.content.startsWith("/show ")) {
			const isHide = message.content.startsWith("/hide");
			const target = message.content.slice(isHide ? "/hide".length : "/show".length).trim().toLowerCase();
			const settings = getChannelOutputSettings(channelId);

			const targets: Record<string, keyof ChannelOutputSettings> = {
				thinking: "hideThinking",
				tools: "hideTools",
				thinkingmode: "hideThinkingMode",
			};

			// No target — show current state
			if (!target) {
				const state =
					`👁 **Output visibility in this channel**\n` +
					`• 💭 Thinking: ${settings.hideThinking ? "🔴 hidden" : "🟢 shown"}\n` +
					`• 🔧 Tools: ${settings.hideTools ? "🔴 hidden" : "🟢 shown"}\n` +
					`• 🧠 Thinking-mode notifications: ${settings.hideThinkingMode ? "🔴 hidden" : "🟢 shown"}\n\n` +
					`Use \`/hide thinking|tools|thinkingmode\` or \`/show thinking|tools|thinkingmode\` to change.`;
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, state);
				return;
			}

			const key = targets[target];
			if (!key) {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
					`❌ Unknown target \`${target}\`. Use \`thinking\`, \`tools\`, or \`thinkingmode\`.`);
				return;
			}

			settings[key] = isHide;
			saveChannelOutputSettings();
			const label =
				target === "thinking" ? "💭 thinking blocks"
				: target === "thinkingmode" ? "🧠 thinking-mode notifications"
				: "🔧 tool call blocks";
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
				`✅ ${isHide ? "Hidden" : "Showing"} ${label} in this channel.`);
			return;
		}

		if (message.content.startsWith("/thinking ")) {
			const thinking = message.content.replace('/thinking ', '')
			try {
				console.log('setting thinking ' + thinking)
				session.setThinkingLevel(thinking)
				// Keep the manual /thinking command and the model-controlled
				// `thinkingmode` tool in sync by persisting the choice per-channel.
				saveChannelThinkingMode(sessionDir, channelId, session.thinkingLevel)
				const available = session.getAvailableThinkingLevels()
				await sendToDiscord(channel as TextChannel, `🧠 Thinking level: ${session.thinkingLevel}. Available levels: ${available.join(', ')}`)
			} catch (error) {
				console.error(`[${channelId}] Error setting thinking mode "${thinking}":`, error);
				await (channel as DMChannel | TextChannel | NewsChannel).send(
					`❌ Sorry, I encountered an error while setting thinking level "${thinking}".\n\`\`\`json\n${error}\`\`\``
				);
			}
			return;
		}

		if (message.content == "/thinking") {
			const available = session.getAvailableThinkingLevels()
			await sendToDiscord(channel as TextChannel, `🧠 Thinking level: ${session.thinkingLevel}. Available levels: ${available.join(', ')}`)
			return;
		}

		// /thinkingmode on|off — enable/disable the model's ability to change its
		// own thinking level via the `thinkingmode` tool. The enabled state is
		// persisted per channel and reflected in the tool's description + output.
		if (message.content === "/thinkingmode" || message.content.startsWith("/thinkingmode ")) {
			const arg = message.content.replace("/thinkingmode", "").trim().toLowerCase();
			const enabled = isThinkingModeEnabled(sessionDir, channelId);
			const current = session.thinkingLevel || loadChannelThinkingMode(sessionDir, channelId) || DEFAULT_THINKING_MODE;

			if (arg === "") {
				// No argument — report current state.
				await sendToDiscord(channel as TextChannel,
					enabled
						? `🧠 The model **may** change its own thinking level (thinkingmode tool enabled). Current level: ${current}. Use \`/thinkingmode off\` to disable.`
						: `🧠 The model may **NOT** change its own thinking level (thinkingmode tool disabled). Current level: ${current}. Use \`/thinkingmode on\` to enable.`);
				return;
			}

			if (arg === "on" || arg === "off") {
				const newState = arg === "on";
				setThinkingModeEnabled(sessionDir, channelId, newState);
				await sendToDiscord(channel as TextChannel,
					newState
						? `✅ The model may **now** change its own thinking level (thinkingmode tool enabled). Current level: ${current}.`
						: `🛑 The model may **not** change its own thinking level (thinkingmode tool disabled). Current level: ${current}. The tool's description now tells the model it is disabled.`);
				return;
			}

			await sendToDiscord(channel as TextChannel,
				`❌ Unknown argument \`${arg}\`. Use \`/thinkingmode on\` to enable or \`/thinkingmode off\` to disable the model's ability to change its thinking level.`);
			return;
		}

		if (message.content.startsWith("/models ")) {
			const search = message.content.replace("/models ", "").trim();
			const available = await session.modelRuntime.getAvailable();
			const { filterModels } = await import("./model-utils.ts");
			const found = filterModels(available, search).map(({provider,id}) =>`${provider}/${id}`);
			const foundJson = escapeForCodeBlock(JSON.stringify(found, null, 2));
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `🤖 Models:\n\`\`\`json\n${foundJson}\n\`\`\``);
			return;
		}

		if (message.content === "/model") {
			const modelData = escapeForCodeBlock(JSON.stringify(session.model, null, 2));
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `🤖 Model data:\n\`\`\`json\n${modelData}\n\`\`\``);
			return;
		}

		if (message.content.startsWith("/model ")) {
			const search = message.content.replace("/model ", "").trim();
			try {
				const available = await session.modelRuntime.getAvailable();
				const { findModel } = await import("./model-utils.ts");
				const m = findModel(available, search);

				if (!m) {
					throw new Error(`No model matching "${search}" found among available models`);
				}

				await discordSession.setModel(m.provider, m.id);
				sessionStore.updateModel(channelId, `${m.provider}/${m.id}`);
				const modelData = escapeForCodeBlock(JSON.stringify(session.model, null, 2));
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `🤖 Changed to ${m.provider}/${m.id}:\n\`\`\`json\n${modelData}\n\`\`\``);
			} catch (error) {
				console.error(`[${channelId}] Error setting model from "${search}":`, error);
				try {
					await (channel as DMChannel | TextChannel | NewsChannel).send(
						`❌ Sorry, I encountered an error while setting your model "${search}".\n\`\`\`json\n${error}\`\`\``
					);
				} catch {
					// Channel might be unavailable
				}
			}
			return;
		}

		// Handle branch commands
		// Session label: /label shows current, /label [name] sets it
		if (message.content === "/label") {
			const currentLabel = sessionLabels.get(channelId);
			if (currentLabel) {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
					`🏷 Session label: \`${currentLabel}\` (use \`/resume ${currentLabel}\` to return later)`
				);
			} else {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
					"🏷 No session label set. Use `/label <name>` to set one, then `/session` to close and label it."
				);
			}
			return;
		}

		if (message.content.startsWith("/label ")) {
			const labelName = message.content.slice("/label ".length).trim();
			sessionLabels.set(channelId, labelName);
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
				`🏷 Session labeled \`${labelName}\`. Use \`/session\` to close and save, then \`/resume ${labelName}\` to return.`
			);
			return;
		}

		if (message.content === "/labels") {
			await handleLabels(channel);
			return;
		}

		if (message.content === "/merge") {
			await handleMerge(channel, message);
			return;
		}

		if (message.content.startsWith("/merge ")) {
			const labelName = message.content.slice("/merge ".length).trim();
			await handleMerge(channel, message, labelName);
			return;
		}

		if (message.content === "/summary") {
			await handleSummary(channel, message);
			return;
		}

		if (message.content.startsWith("/summary ")) {
			const labelName = message.content.slice("/summary ".length).trim();
			await handleSummary(channel, message, labelName);
			return;
		}

		// Handle /compact command
		// /compact - Start a FRESH session seeded with a summary of the current
		// one. The original session is left unchanged on disk and stays
		// resumable via /resume <session id>.
		// /compact [instructions] - Add custom focus for the summary
		if (message.content === "/compact" || message.content.startsWith("/compact ")) {
			const instructions = message.content.slice("/compact".length).trim();
			if (session.isCompacting) {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "📦 Already compacting, please wait...");
				return;
			}
			try {
				// Show typing during the (potentially slow) summarization LLM call
				typingManager.show(channelId, createTypingChannel(channelId));

				// 1) Stop anything still running (the agent may be mid-turn since
				//    /compact is a non-interrupting command).
				await discordSession.abortModelActivities();

				// 2) Generate the summary WITHOUT mutating the current session:
				//    the original must stay byte-for-byte intact so /resume can
				//    restore it. prepareBranchEntries skips tool results, so the
				//    summarization input is much smaller than the real context.
				const entries = session.sessionManager.getBranch();
				const { messages } = prepareBranchEntries(entries);
				const settings = session.settingsManager.getCompactionSettings();
				const currentModel = session.model;
				if (!currentModel) throw new Error("No model is selected for this session");
				const authResult = await session.modelRuntime.getAuth(currentModel);
				if (!authResult) throw new Error(`Failed to resolve auth for provider ${currentModel.provider}`);
				const apiKey = authResult.auth.apiKey;
				if (!apiKey) throw new Error(`No API key found for provider ${currentModel.provider}`);
				const headers = authResult.auth.headers
					? Object.fromEntries(Object.entries(authResult.auth.headers).filter((entry): entry is [string, string] => entry[1] !== null))
					: undefined;
				const requestModel = authResult.auth.baseUrl ? { ...currentModel, baseUrl: authResult.auth.baseUrl } : currentModel;
				const summary = await generateSummary(
					messages,
					requestModel,
					settings.reserveTokens,
					apiKey,
					headers,
					undefined, // signal
					instructions || undefined,
					undefined, // previousSummary
					session.thinkingLevel
				);

				// 3) Capture old session stats, then close it — it's preserved on
				//    disk (timestamped backup) and listed for /resume. `remember`
				//    memory is channel-scoped (channel-memory-<channelId>.json),
				//    so it survives the close/recreate automatically — nothing to
				//    carry over here.
				const oldStats = session.getSessionStats();
				const oldSessionId = oldStats.sessionId;
				await sessionStore.closeAndNewSession(channelId);

				// 4) Create the new session and rebind scheduled jobs to its UUID.
				//    (Same reasoning as /session: the old dispose/recreate dance
				//    minted fresh random UUIDs because unflushed sessions don't
				//    write their file; the keeper self-heals + catches up anyway.)
				await sessionStore.getOrCreate(channelId);
				rebindChannelJobsToLiveSession(channelId);

				// 5) Seed the new session with ONLY the compacted context — silent
				//    injection (no agent turn), so the summary is the opening context.
				const compactedSession = sessionStore.get(channelId)!.session;
				// (Channel-scoped remember memory is picked up automatically by the
				// before_agent_start hook on the first turn — no UUID carry needed.)
				compactedSession.sessionManager.appendMessage({
					role: "user",
					content: `[Previous conversation summary — the full history was closed and can be restored with /resume ${oldSessionId}]\n\n${summary}`,
					timestamp: Date.now(),
				});
				// Force-persist the seeded session to disk. The pi SDK's
				// SessionManager._persist() defers ALL file writes until an
				// assistant message exists in the session (see its hasAssistant
				// guard). Without this, a fresh compacted session containing only
				// the seeded summary (a user message) is never written to disk —
				// if the bot restarts before the first real assistant response,
				// the whole compacted context is silently lost and the channel
				// comes back as an empty session (observed 2026-08-14 in the
				// forth channel: /compact 22:48 → bot restart 09:32 → fresh
				// empty session 09:58). Appending this minimal assistant marker
				// triggers the flush so the summary survives restarts.
				compactedSession.sessionManager.appendMessage({
					role: "assistant",
					// A real AssistantMessage also carries the model identity; SDK session
					// readers (stats, resume, compaction checks) expect these fields.
					api: currentModel.api,
					provider: currentModel.provider,
					model: currentModel.id,
					// Content must be an ARRAY (not a string): getSessionStats() and
					// other SDK paths call content.filter() on assistant messages.
					content: [{ type: "text", text: `[Session compacted, previous conversation summarized above. The full history is available in session ${oldSessionId}]` }],
					timestamp: Date.now(),
					// The marker is a real assistant message in the session, so the
					// SDK's next-prompt compaction check (_checkCompaction) reads its
					// usage/stopReason, and getSessionStats() reads usage.cost.total.
					// Without these, the next user message crashes ("TypeError:
					// undefined is not an object (evaluating 'usage.totalTokens')") or
					// /resume crashes ("assistantMsg.content.filter is not a
					// function"). Zeroed usage keeps shouldCompact() at 0 → no
					// false threshold compaction.
					stopReason: "stop",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				});
				const ctx = compactedSession.sessionManager.buildSessionContext();
				compactedSession.agent.state.messages = ctx.messages;

				// 6) Reset Discord-side tracking for the new session (like /session)
				subscribedSessions.delete(channelId);
				sessionSubscriptions.delete(channelId);
				sessionMessageIndex.delete(channelId);
				discordMessageToSession.delete(channelId);
				const meta = loadBranchMetadata(sessionDir, channelId);
				meta.discordMsgToPiEntryId.clear();
				meta.discordMsgParent.clear();
				meta.mainBranchTip = null;
				meta.labelCounter = 0;
				meta.labels.clear();
				saveBranchMetadata(sessionDir, channelId, meta);

				// 7) Confirm — no need to dump the summary into Discord; the new
				//    session has it in context and /resume restores the full history.
				const totalTokens = oldStats.tokens.input + oldStats.tokens.output;
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
					`✅ **Session compacted** — started a fresh session seeded with a summary of the previous one (~${totalTokens.toLocaleString()} tokens of history → summary).\n\nUse \`/resume ${oldSessionId}\` to go back to the original session.`);
			} catch (error) {
				console.error(`[${channelId}] /compact error:`, error);
				typingManager.hide(channelId);
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
					`❌ Compaction failed:\n${escapeForCodeBlock(String(error))}`);
			}
			return;
		}
		
		// Helper: branch the session tree and sync agent's in-memory messages
		const branchAndSync = (entryId: string) => {
				try {
					session.sessionManager.branch(entryId);
					const ctx = session.sessionManager.buildSessionContext();
					session.agent.state.messages = ctx.messages
					return true;
				} catch {
					return false;
				}
		};

		if (message.reference) {
			// This is a reply - find the parent entry and branch there
			const parentMsgId = message.reference.messageId;
			const parentPiEntryId = metadata.discordMsgToPiEntryId.get(parentMsgId);
			
			if (parentPiEntryId && branchAndSync(parentPiEntryId)) {
				log(`[${channelId}] Branched to parent entry ${parentPiEntryId}`);
			} else {
				// Parent not found - warn but continue
				log(`[${channelId}] Warning: Parent message ${parentMsgId} not tracked in session`);
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, 
					`⚠️ Parent message not found in session history, continuing in main branch`);
			}
		} else {
			// Non-reply: branch to persisted main branch tip (survives restarts)
			const mainTip = metadata.mainBranchTip;
			if (mainTip && branchAndSync(mainTip)) {
				log(`[${channelId}] Branched to main branch tip ${mainTip}`);
			} else if (mainTip) {
				// mainBranchTip exists but entry is missing (crash/restart) — try latest leaf
				const leafId = session.sessionManager.getLeafId();
				if (leafId && branchAndSync(leafId)) {
					log(`[${channelId}] mainBranchTip stale, branched to latest leaf ${leafId}`);
				} else {
					log(`[${channelId}] Tree is empty, creating new root`);
				}
			} else {
				// mainBranchTip is null (e.g. after /clear) — start fresh
				log(`[${channelId}] Tree is empty, creating new root`);
			}
		}

		// Tell the subscription about this Discord message before sending
		sessionSubscriptions.get(channelId)?.setPendingDiscordMessageId(message.id, !!message.reference);

		// Send user message to pi agent
		// Set once the SDK accepted the message: a failure afterwards (branch metadata,
		// Discord bookkeeping) must not park an already-delivered message.
		let delivered = false;
		try {
			const finalContent: any[] = [];
			
			if (agentContent.length > 0) {
				finalContent.push(...agentContent);
			} else if (message.content) {
				finalContent.push({ type: "text", text: message.content });
			} else {
				finalContent.push({ type: "text", text: " " });
			}

			log(`[${channelId}] Sending content to agent. Type: array (length ${finalContent.length})`);
			if (finalContent.length > 0) {
				finalContent.forEach((part, i) => {
					if (part.type === 'image') {
						log(`[${channelId}] Part ${i} (image) data snippet: ${part.data?.slice(0, 50)}...`);
					}
				});
			}
			// Ensure typing is active for the whole agent turn (covers slash commands
			// that fell through to the agent, e.g. unknown commands or spaced-out
			// commands, and re-asserts after the pre-processing above).
			typingManager.show(channelId, createTypingChannel(channelId));
			// Park a durable copy before handing the message to the SDK whenever the
			// session still reports activity after the bounded abort wait (a wedged
			// agent_end drain, or a tool that ignores its abort signal). A followUp
			// only materialises when the current run settles; if that run never
			// settles the message would be lost. See src/pending-messages.ts.
			const sessionStillActive = discordSession.isModelActive();
			if (sessionStillActive) {
				const parkedText = message.content ?? "";
				if (parkedText.trim()) {
					pendingMessages.add({
						channelId,
						discordMessageId: message.id,
						authorId: message.author?.id,
						authorName: message.author?.username,
						content: parkedText,
						queuedAt: Date.now(),
						reason: "run-still-active",
					});
				} else {
					log(
						`[${channelId}] Message ${message.id} has no text (attachments only) and cannot be parked for replay`
					);
				}
			}
			// While the aborted run is still winding down a bare send would throw
			// "Agent is already processing" — queue it as a follow-up instead, which
			// runs as soon as that run settles. If it settled in the meantime,
			// isStreaming is false and the message runs normally.
			await session.sendUserMessage(finalContent, sessionStillActive ? { deliverAs: "followUp" } : undefined);
			delivered = true;

			// Track user Discord message → user Pi entry
			// getLeafId() is the assistant entry; its parent is the user entry.
			// Omitted when the message was only queued behind a run that is still
			// settling: no entries were appended yet, so the leaf still points at the
			// previous turn and the mapping would record a wrong entry. Leaving it
			// unset makes later reply-branching to that message fall back to the main
			// branch instead of forking from the wrong place.
			const assistantLeafId = sessionStillActive && session.isStreaming
				? undefined
				: session.sessionManager.getLeafId();
			if (assistantLeafId) {
				const assistantEntry = session.sessionManager.getEntry(assistantLeafId);
				const userEntryId = assistantEntry?.parentId ?? assistantLeafId;
				const metadata = loadBranchMetadata(sessionDir, channelId);
				metadata.discordMsgToPiEntryId.set(message.id, userEntryId);
				saveBranchMetadata(sessionDir, channelId, metadata);
				log(`[${channelId}] Tracked Discord message ${message.id} → Pi entry ${userEntryId}`);
				// Update persisted main branch tip for non-reply messages
				if (!message.reference) {
					const updatedMeta = loadBranchMetadata(sessionDir, channelId);
					updatedMeta.mainBranchTip = assistantLeafId;
					saveBranchMetadata(sessionDir, channelId, updatedMeta);
					log(`[${channelId}] Updated main branch tip to ${assistantLeafId}`);
				}
			}
		} catch (error) {
			console.error(`[${channelId}] Error sending message:`, error);
			// The turn died without agent_end — stop typing so the user knows
			// nothing is running anymore.
			typingManager.hide(channelId);
			// The usual cause is a run that never settled: the SDK rejects a new
			// prompt with "Agent is already processing" while the old run is still
			// streaming. Park the text so replayPendingMessages() and the 60s sweep
			// can deliver it later instead of dropping it on the floor.
			const undeliveredText = (message.content ?? "").trim();
			if (!delivered && undeliveredText) {
				pendingMessages.add({
					channelId,
					discordMessageId: message.id,
					authorId: message.author?.id,
					authorName: message.author?.username,
					content: message.content ?? "",
					queuedAt: Date.now(),
					reason: "send-failed",
				});
			}
			try {
				await (channel as DMChannel | TextChannel | NewsChannel).send(
					!delivered && undeliveredText
						? "⏳ The previous turn is still winding down, so I queued your message — it will be delivered automatically."
						: "❌ Sorry, I encountered an error processing your message."
				);
			} catch {
				// Channel might be unavailable
			}
		}
	}

	// =========================================================================
	// Graceful Shutdown
	// =========================================================================
	async function shutdown() {
		log("Shutting down...");

		// Flush anything that only lives in memory. Parked user messages are
		// already on disk (persisted before they reached the SDK); the /queue
		// prompt list is only written on mutation, so flush it here to be safe.
		const parkedCount = pendingMessages.size();
		savePromptQueue();
		if (parkedCount > 0) {
			log(`${parkedCount} parked user message(s) stay on disk and will be replayed on startup`);
		}

		// Dispose typing manager (stops all typing indicators)
		typingManager.dispose();

		// Dispose all sessions (saves index)
		sessionStore.disposeAll();

		// Destroy Discord client
		discordClient?.destroy();

		console.log("[discord] Shutdown complete");
		process.exit(0);
	}

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// Restore persisted prompt queues from disk
	loadPromptQueue();

	// Restore per-channel output visibility settings (/hide, /show) from disk
	loadChannelOutputSettings();

	// Restore sessions for channels with scheduled prompts
	restoreScheduledSessions();

	// Keep sessions alive for enabled cron jobs (pi-schedule-prompt only fires
	// while a session is open) and catch up runs missed while the bot was down.
	startSessionKeeper({ subscribedSessions, sessionSubscriptions, recoveringChannels });

	// Pre-create sessions for channels with queued prompts so they survive restarts
	for (const chId of promptQueue.keys()) {
		console.log(`[discord] Pre-creating session for channel ${chId} (${promptQueue.get(chId)?.length || 0} queued prompts)`);
		sessionStore.getOrCreate(chId).catch((err) => {
			console.error(`[discord] Failed to pre-create session for ${chId}:`, err);
		});
	}

	// Re-deliver user messages that were parked behind background subagent work
	// when the process last stopped. They were persisted for exactly this case.
	log(
		`Parked-message store armed: ${pendingMessages.size()} message(s) on disk, ` +
			`orphaned background work released after ${STALE_ASYNC_WORK_TIMEOUT_MS / 60_000} min`
	);
	const restartParkedChannels = [...new Set(pendingMessages.all().map((entry) => entry.channelId))];
	for (const chId of restartParkedChannels) {
		const count = pendingMessages.forChannel(chId).length;
		console.log(`[discord] Replaying ${count} parked message(s) for channel ${chId} after restart`);
		try {
			await sessionStore.getOrCreate(chId);
			await replayPendingMessages(chId);
		} catch (err) {
			console.error(`[discord] Replay after restart failed for ${chId} (stays parked):`, err);
		}
	}

	// One catch-up pass for background completions that were written to a transcript
	// but never announced: a restart while a workflow was still running is how that
	// happens, and without this the channel stays silent until a human prompts it.
	try {
		await runOrphanCompletionSweep();
	} catch (err) {
		console.error("[discord] Orphan completion sweep at startup failed:", err);
	}

	// Self-heal: release orphaned background subagent runs (completion event never
	// arrived), recover channels whose run wedged between agent_end and the SDK's
	// settle path, and replay anything parked. Runs without user input, so a
	// wedged channel recovers on its own instead of silently swallowing every
	// message until the process is restarted.
	async function runSelfHealSweep(): Promise<void> {
		const releasedChannels = sweepStaleBackgroundWork();
		const candidates = new Set([
			...releasedChannels,
			...subscribedSessions,
			...pendingMessages.all().map((entry) => entry.channelId),
		]);

		// Ordered passes, not one loop: recovery MUST complete for every candidate
		// before any replay starts (see the guard in replayPendingMessages). A
		// session whose run never settles still reports its own followUps as queued,
		// so replaying first would leave the parked messages parked behind a queue
		// nothing can drain.
		for (const chId of candidates) {
			const discordSession = sessionStore.get(chId);
			if (!discordSession) {
				stuckRunConfirmations.delete(chId);
				terminalMessageAt.delete(chId);
				continue;
			}

			// Fast path: the turn's final assistant message is on disk and nothing has
			// happened since, so the run is settling and never will. Precise enough to
			// act without the idle threshold or the confirmation streak — the generic
			// watchdog below stays for every other shape of wedge.
			const stall = await evaluatePostCompletionStallForChannel(chId, discordSession);
			if (stall.refusal === null) {
				const terminalAt = terminalMessageAt.get(chId) ?? Date.now();
				console.warn(
					`[watchdog] ${chId} post-completion stall ${Date.now() - terminalAt}ms after final message - recovering`
				);
				try {
					const recreated = await recoverStuckSession(chId);
					if (recreated) {
						// The stale agent_end never ran and never will: the subscription died
						// with the session, so the end-of-turn work has to happen here.
						const fresh = sessionStore.get(chId);
						const stallChannel = await fetchChannelObject(chId);
						if (fresh && stallChannel) {
							await finishChannelTurn(chId, stallChannel, fresh.session, typingManager);
						} else {
							// No channel to stream a queued prompt into, so the queue waits for
							// the next message instead of being sent into the void.
							typingManager.hide(chId);
							terminalMessageAt.delete(chId);
						}
					}
				} catch (err) {
					console.error(`[discord] Post-completion recovery failed for ${chId}:`, err);
				} finally {
					stuckRunConfirmations.delete(chId);
				}
				continue;
			}

			// The only refusal that is not directly observable is the subagent gate, so
			// it is the only one worth a periodic snapshot: it names the run that is
			// (or is not) holding recovery off.
			logStallRefusal(chId, stall.refusal);

			const idleMs = Date.now() - (lastSdkEventAt.get(chId) ?? Date.now());
			const evaluation = evaluateStuckRunForChannel(chId, discordSession);

			// Only a session that looks wedged but is not yet confirmed accrues
			// evidence; every other outcome clears it (a live signal was seen).
			if (!evaluation.candidate) {
				stuckRunConfirmations.delete(chId);
				continue;
			}
			const confirmations = (stuckRunConfirmations.get(chId) ?? 0) + 1;
			stuckRunConfirmations.set(chId, confirmations);

			if (!evaluation.shouldRecover) {
				console.warn(
					`[watchdog] ${chId} idle ${Math.round(idleMs / 1000)}s, recovery refused by ${evaluation.refusedBy} ` +
						`(confirmation ${confirmations}/${REQUIRED_CONFIRMING_SWEEPS})`
				);
				continue;
			}

			// Last resort before the destructive path: a live child process is work
			// (a sync subagent child emits no events for its whole duration), so the
			// gate accounting above being wrong must not cost a healthy turn.
			//
			// Accepted tradeoff: this refuses on ANY child, so a long-lived child
			// started by a tool (dev server, daemon) keeps recovery disabled for that
			// channel until it exits. That is the safe direction - a stale run left in
			// place, never a destroyed turn - and the pids are logged so an operator
			// can see exactly what held it off.
			const childPids = await findLiveChildPids();
			if (childPids.length > 0) {
				console.warn(
					`[watchdog] ${chId} idle ${Math.round(idleMs / 1000)}s, but ${childPids.length} child process(es) are alive ` +
						`(pids ${childPids.join(",")}) - not recovering`
				);
				stuckRunConfirmations.delete(chId);
				continue;
			}

			try {
				await recoverStuckSession(chId);
			} catch (err) {
				console.error(`[discord] Watchdog recovery failed for ${chId}:`, err);
			} finally {
				stuckRunConfirmations.delete(chId);
			}
		}

		// Announce completions that were written to a transcript but never delivered.
		// After the recovery pass (a rebuilt session is idle by then) and before the
		// replay pass, which owns any channel that still has parked messages.
		await runOrphanCompletionSweep();

		for (const chId of candidates) {
			if (sessionStore.get(chId)?.hasPendingBackgroundWork()) continue; // legitimately draining still			// A channel mid-rebuild is being handled by the recovery pass; replaying
			// against a session that is about to be disposed would post into nowhere.
			if (recoveringChannels.has(chId)) continue;
			// Without a subscription the replayed prompt is answered into the void and
			// the parked copy is dropped after the send, so wait for the next message
			// (or the keeper) to re-subscribe instead of losing it.
			if (!sessionSubscriptions.has(chId)) continue;
			replayPendingMessages(chId).catch((err) => {
				console.error(`[discord] Replay sweep error for ${chId}:`, err);
			});
		}
	}

	// A sweep can outlive its own 60s interval (recovery awaits a bounded abort per
	// channel), and two overlapping sweeps would let one channel accrue both of its
	// confirming ticks inside a single idle window.
	let sweepInFlight = false;
	setInterval(() => {
		if (sweepInFlight) {
			console.warn("[discord] Self-heal sweep still running from the previous tick - skipping this one");
			return;
		}
		sweepInFlight = true;
		runSelfHealSweep()
			.catch((err) => {
				console.error("[discord] Self-heal sweep error:", err);
			})
			.finally(() => {
				sweepInFlight = false;
			});
	}, 60_000);

	console.log("[discord] Bot is ready and listening for messages!");
}

// ============================================================================
// Run
// ============================================================================

main().catch((error) => {
	console.error("[discord] Fatal error:", error);
	process.exit(1);
});

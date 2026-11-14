/**
 * Session Store - Manages Discord channel to pi session mappings
 * with persistence to disk.
 */

import {
	createAgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createCodingTools,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionFactory,
	DefaultResourceLoader,
	discoverAndLoadExtensions,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync, readdirSync } from "fs";
import { createSessionMemoryExtension, getChannelMemoryFilePath, getMemoryFilePath, loadMemory, patchCurrentSystemPrompt, saveChannelMemory } from "./session-memory.ts";
import { applyChannelThinkingMode, createThinkingModeTool } from "./thinking-mode.ts";
import {
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	createSubagentGate,
	type PendingAsyncRun,
	type SubagentGate,
} from "./subagent-gate.ts";

// ============================================================================
// Types
// ============================================================================

export interface ClosedSessionInfo {
	channelId: string;
	sessionId: string;
	sessionFile: string; // backup file path
	sessionName: string;
	closedAt: number;
	label?: string;
}

/**
 * Ensure the system prompt carries today's local date (YYYY-MM-DD, en-CA).
 * pi >= 0.84 no longer injects a date line; older versions had one to update.
 */
export function withCurrentDate(prompt: string, now: Date = new Date()): string {
	const localDate = now.toLocaleDateString('en-CA');
	if (/Current date: \d{4}-\d{2}-\d{2}/.test(prompt)) {
		return prompt.replace(/Current date: \d{4}-\d{2}-\d{2}/, `Current date: ${localDate}`);
	}
	return `${prompt}\n\nCurrent date: ${localDate}`;
}

// ============================================================================
// Parent Tool Allowlist
// ============================================================================

// Tools the Discord-facing PARENT session may use directly. `subagent` keeps
// the delegation-only lockdown (the parent must never do work itself; child
// agents resolve their own full tool plans). `schedule_prompt` is the one
// direct exception: registered by the pi-schedule-prompt extension (loaded
// from the ~/.pi/agent settings packages), it lets the model schedule prompts
// for its channel without round-tripping through the subagent tool. The bot's
// session keeper (src/index.ts) already watches the extension's
// .pi/schedule-prompts.json storage, so directly-created jobs are rebound to
// live sessions and caught up after restarts like any other scheduled prompt.
export const PARENT_TOOL_ALLOWLIST = ["subagent", "schedule_prompt"];

/**
 * Filter the desired parent allowlist down to tools actually present in the
 * session's tool registry. setActiveToolsByName silently drops unknown names
 * (e.g. when the pi-schedule-prompt extension is not installed), so filtering
 * here keeps the active set — and its log line — truthful.
 */
export function buildParentToolAllowlist(registeredToolNames: Iterable<string>): string[] {
	const registered = new Set(registeredToolNames);
	return PARENT_TOOL_ALLOWLIST.filter((name) => registered.has(name));
}

/**
 * Auto-retry budget for failed model requests. Lowered from 10: a non-retryable
 * provider error (out of balance, context overflow) used to burn ~10 minutes of
 * exponential backoff before the user saw anything actionable. Non-retryable
 * errors are additionally cancelled outright by the auto_retry_start handler in
 * src/index.ts (see src/retry-policy.ts).
 */
const DEFAULT_MAX_RETRIES = 3;

function resolveMaxRetries(): number {
	const fromEnv = Number(process.env.PI_DISCORD_MAX_RETRIES);
	return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_MAX_RETRIES;
}

/**
 * Ceiling for an idle provider stream body.
 *
 * The CLI installs an undici dispatcher that caps idle response bodies
 * (configureHttpDispatcher, DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000), but the bot
 * imports the library entry (dist/index.js), which never configures it. The only
 * remaining lever is the per-request `timeoutMs`, derived from
 * `settings.httpIdleTimeoutMs` — and a human config may set that to 0, which the
 * SDK expands to 2147483647 ms (~24.8 days). With no cap, a stream that stalls
 * inside the post-run/settle phase parks the run forever: the run-active latch
 * only clears when the run settles (see the stale-run watchdog in src/index.ts).
 *
 * 600_000 (10 minutes) is deliberately longer than the CLI default: a long
 * reasoning turn must not be cut off mid-stream, and the watchdog recovers a
 * genuinely stalled run in about two minutes anyway, so this value only has to
 * be finite. It exists to stop a *never*-ending body, not a slow one.
 */
const PROVIDER_HTTP_IDLE_TIMEOUT_MS = 600_000;

/** Session settings that must survive `session.reload()` (it wipes in-memory overrides). */
function applySettingsOverrides(settingsManager: SettingsManager): void {
	settingsManager.applyOverrides({
		retry: { enabled: true, maxRetries: resolveMaxRetries() },
		httpIdleTimeoutMs: PROVIDER_HTTP_IDLE_TIMEOUT_MS,
	});
}

// Per-channel "max 1 subagent at a time" gate. Each channel session gets its
// own SubagentGate instance (created here, keyed only by this session), so
// channels are independent: one channel's in-flight subagent never blocks
// another channel, while a single channel can never run two subagents at
// once (sync or async). Sync subagent invocations are admitted/blocked at
// tool_call time; tool_result releases the slot. Async subagent lifecycle
// events (pi-subagents emits them on this session's own pi.events bus) are
// tracked so async runs hold the slot for their full lifetime.
//
// The live gate is also registered per channel so DiscordSession (and through
// it the interrupt decision in src/index.ts) can ask whether background
// subagent work is still pending while the session reports isStreaming during
// the pi-subagents agent_end drain.
const subagentGates = new Map<string, SubagentGate>();

function createSubagentGateExtension(channelId: string): ExtensionFactory {
	const gate = createSubagentGate();
	subagentGates.set(channelId, gate);
	return (pi: ExtensionAPI): void => {
		const api = pi as {
			on(event: string, handler: (event: { toolName?: string; toolCallId?: string }) => any): void;
			events: { on(channel: string, handler: (data: unknown) => void): unknown };
		};
		api.on("tool_call", (event) => {
			if (event?.toolName !== "subagent") return undefined;
			if (!gate.acquireSync(event.toolCallId ?? "")) {
				return { block: true, reason: gate.blockReason() };
			}
			return undefined;
		});
		api.on("tool_result", (event) => {
			if (event?.toolName === "subagent") gate.releaseSync(event.toolCallId ?? "");
			return undefined;
		});
		api.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (data) => gate.onAsyncStarted(data));
		api.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => gate.onAsyncComplete(data));
	};
}

/**
 * Release orphaned async subagent runs (one whose completion event never
 * arrived) in every channel. Returns the channel ids whose gate was released so
 * the caller can replay messages parked behind the drain.
 */
export function sweepStaleBackgroundWork(maxAgeMs?: number): string[] {
	const releasedChannels: string[] = [];
	for (const [channelId, gate] of subagentGates) {
		if (gate.sweepStaleAsync(maxAgeMs).length > 0) {
			releasedChannels.push(channelId);
		}
	}
	return releasedChannels;
}

export class DiscordSession {
	channelId: string;
	session: AgentSession;
	lastActivity: number;

	constructor(channelId: string, session: AgentSession, lastActivity: number) {
		this.channelId = channelId;
		this.session = session;
		this.lastActivity = lastActivity;
	}

	async setModel(provider: string, model: string) {
		const m = this.session.modelRuntime.getModel(provider, model)
		if (!m) throw new Error(`Can't find model ${provider}/${model}`)
		await this.session.setModel(m);
		this.applySessionSettingsOverrides();
	}

	/**
	 * Public so the Discord layer can re-apply the overrides after
	 * `session.reload()`, which resets in-memory settings.
	 */
	applySessionSettingsOverrides() {
		applySettingsOverrides(this.session.settingsManager);
	}

	isModelActive() {
		return this.session.isStreaming || this.session.isRetrying || this.session.isCompacting || this.session.isBashRunning || this.session.isRetrying;
	}

	async abortModelActivities() {
		this.session.abortCompaction();
		this.session.abortRetry();
		await this.session.abort();
	}

	/**
	 * True while async (background) subagent runs started in this channel have
	 * not completed yet. Used by the self-heal sweep in src/index.ts to tell a
	 * legitimately draining channel from one whose completion event was lost.
	 */
	hasPendingBackgroundWork(): boolean {
		return (subagentGates.get(this.channelId)?.pendingAsyncWork() ?? 0) > 0;
	}

	/**
	 * True while *any* subagent work is live in this channel, including sync
	 * tool calls. A sync child produces no session event while it runs, so the
	 * stale-run watchdog (src/stuck-run-decision.ts) must not read that silence
	 * as a wedge.
	 */
	hasActiveSubagentWork(): boolean {
		return subagentGates.get(this.channelId)?.hasActiveWork() ?? false;
	}

	/**
	 * True while a sync subagent tool call is executing in this channel.
	 *
	 * This is the half of the gate the watchdog may trust on its own: a sync child
	 * is a live process, so its silence is work by construction.
	 */
	hasSyncSubagentWork(): boolean {
		return subagentGates.get(this.channelId)?.hasSyncWork() ?? false;
	}

	/**
	 * Async runs the gate still counts, for cross-checking against the run store.
	 *
	 * The gate cannot drop a run on its own: only pi-subagents' async-complete
	 * event releases it, and that event is delivered through the session. Callers
	 * must resolve these against the store (hasProgressingAsyncWork) rather than
	 * treating a non-zero count as work in progress.
	 */
	pendingAsyncRuns(): PendingAsyncRun[] {
		return subagentGates.get(this.channelId)?.pendingAsyncRuns() ?? [];
	}
}

export interface SessionIndex {
	sessions: Record<string, { channelId: string; sessionFile: string; lastActivity: number; model?: string; cwd?: string }>;
}

// ============================================================================
// Session Store Class
// ============================================================================

// ============================================================================
// Tool Logic
// ============================================================================

// NOTE: executeLookAtFile is now defined inline in createPiSession so it has
// access to sessionRef for sendUserMessage (avoiding image-in-tool-result crashes
// with text-only models). The standalone function is kept for unit testing.

/** Reads and validates an image file. Exported for unit testing. */
/**
 * Validate that a buffer contains actual image data by checking magic bytes.
 * Prevents sending HTML error pages (404, etc.) stored as .jpg files to the API,
 * which causes 400 errors from providers like opencode-go.
 */
function isValidImageData(buffer: Buffer): boolean {
	if (buffer.length < 4) return false;

	// JPEG: starts with FF D8 FF
	if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return true;

	// PNG: starts with 89 50 4E 47 (\x89PNG)
	if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return true;

	// GIF: starts with GIF87a or GIF89a
	if (buffer.slice(0, 6).toString('ascii') === 'GIF87a' || buffer.slice(0, 6).toString('ascii') === 'GIF89a') return true;

	// WebP: starts with RIFF....WEBP
	if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return true;

	return false;
}

export async function readImageFile(args: { path: string }, cwd: string): Promise<{ absolutePath: string; base64Data: string; mimeType: string }> {
	const fs = await import("fs");
	const pathMod = await import("path");

	const absolutePath = args.path.startsWith("~")
		? pathMod.join(homedir(), args.path.slice(1))
		: pathMod.resolve(cwd, args.path);

	if (!fs.existsSync(absolutePath)) {
		throw new Error(`FILE_NOT_FOUND: ${absolutePath}`);
	}

	const ext = pathMod.extname(absolutePath).toLowerCase();
	const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
	if (!imageExts.includes(ext)) {
		throw new Error(`UNSUPPORTED_FORMAT: ${ext}. Supported: ${imageExts.join(', ')}`);
	}

	const buffer = fs.readFileSync(absolutePath);

	// Validate that the file actually contains image data (not HTML error pages, etc.)
	if (!isValidImageData(buffer)) {
		const preview = buffer.slice(0, 100).toString('utf-8').replace(/\n/g, ' ').trim();
		throw new Error(`NOT_AN_IMAGE: File has image extension but does not contain valid image data. Content preview: ${preview}`);
	}

	const base64Data = buffer.toString('base64');

	const mimeTypes: Record<string, string> = {
		'.jpg': 'image/jpeg',
		'.jpeg': 'image/jpeg',
		'.png': 'image/png',
		'.gif': 'image/gif',
		'.webp': 'image/webp',
	};
	const mimeType = mimeTypes[ext] || 'image/jpeg';

	return { absolutePath, base64Data, mimeType };
}

export class SessionStore {
	private sessions = new Map<string, DiscordSession>();
	private pendingSessions = new Map<string, Promise<DiscordSession>>();
	private sessionDir: string;
	private debug: boolean;
	private channelNames = new Map<string, string>();

	constructor(options?: { sessionDir?: string; debug?: boolean }) {
		this.sessionDir = options?.sessionDir || join(homedir(), ".pi-discord", "sessions");
		this.debug = options?.debug || false;

		// Ensure session directory exists
		if (!existsSync(this.sessionDir)) {
			mkdirSync(this.sessionDir, { recursive: true });
		}

		// Adopt legacy session-UUID-keyed memory sidecars (memory-<uuid>.json)
		// into the channel-scoped files (channel-memory-<channelId>.json) so
		// nothing the user told the bot to remember is lost after this upgrade.
		this.migrateLegacyMemoryFiles();
	}

	/**
	 * One-time migration of legacy `memory-<sessionId>.json` sidecars to
	 * channel-scoped `channel-memory-<channelId>.json`. Maps each session UUID
	 * to its channel via closed-sessions.json (explicit pairs) and by scanning
	 * the session header of every `discord-<channelId>[-<ts>].jsonl` file.
	 * When several legacy sessions of one channel carry memory, the most
	 * recently updated one wins. Legacy files are left in place (never
	 * deleted) — they are simply no longer read.
	 */
	private migrateLegacyMemoryFiles(): void {
		try {
			const sessionIdToChannel = new Map<string, string>();

			// 1) closed-sessions.json holds explicit sessionId -> channelId pairs
			for (const closed of this.loadClosedSessions()) {
				sessionIdToChannel.set(closed.sessionId, closed.channelId);
			}

			// 2) Scan the session header of every discord-*.jsonl file (active
			//    default files and timestamped backups) for its session UUID.
			const dir = this.sessionDir;
			for (const name of readdirSync(dir)) {
				if (!name.startsWith("discord-") || !name.endsWith(".jsonl")) continue;
				const m = name.match(/^discord-(\d+)(?:-\d+)?\.jsonl$/);
				if (!m) continue;
				const channelId = m[1];
				let header: { type?: string; id?: string } | undefined;
				try {
					header = JSON.parse(readFileSync(join(dir, name), "utf-8").split("\n", 1)[0]);
				} catch {
					continue;
				}
				if (header?.type === "session" && header.id) {
					sessionIdToChannel.set(header.id, channelId);
				}
			}

			// 3) Adopt every legacy sidecar into its channel's memory file.
			let migrated = 0;
			for (const name of readdirSync(dir)) {
				const m = name.match(/^memory-([\w-]+)\.json$/);
				if (!m) continue;
				const sessionId = m[1];
				const channelId = sessionIdToChannel.get(sessionId);
				if (!channelId) continue;
				const legacy = loadMemory(dir, sessionId);
				if (!legacy) continue;

				const channelPath = getChannelMemoryFilePath(dir, channelId);
				if (existsSync(channelPath)) {
					let existingUpdated = 0;
					try {
						existingUpdated = JSON.parse(readFileSync(channelPath, "utf-8"))?.updatedAt ?? 0;
					} catch {
						// Corrupt channel file -> overwrite below
					}
					let legacyUpdated = 0;
					try {
						legacyUpdated = JSON.parse(readFileSync(getMemoryFilePath(dir, sessionId), "utf-8"))?.updatedAt ?? 0;
					} catch {
						// Ignore
					}
					if (existingUpdated >= legacyUpdated) continue;
				}

				writeFileSync(channelPath, JSON.stringify({ channelId, memory: legacy, updatedAt: Date.now() }, null, 2));
				migrated++;
				this.log(`[memory] Migrated legacy session memory ${sessionId} → channel ${channelId}`);
			}
			if (migrated > 0) {
				this.log(`[memory] Legacy memory migration complete (${migrated} file(s) adopted)`);
			}
		} catch (error) {
			this.log("Legacy memory migration failed:", error);
		}
	}

	// ============================================================================
	// Logging
	// ============================================================================

	private log(...args: unknown[]) {
		if (this.debug) {
			console.log(`[session-store][${new Date().toISOString()}]`, ...args);
		}
	}

	// ============================================================================
	// Path Helpers
	// ============================================================================

	private getSessionIndexPath(): string {
		return join(this.sessionDir, "index.json");
	}

	private getSessionPath(channelId: string): string {
		return join(this.sessionDir, `discord-${channelId}.jsonl`);
	}

	/**
	 * Timestamped sibling path for a session file that does not exist yet.
	 *
	 * `renameSync` overwrites its destination silently, so every backup name must
	 * be unique on disk, not just unique by millisecond. Forking a session and
	 * then resuming it inside the same `Date.now()` millisecond used to make
	 * `resumeSession`'s swap land on the pre-fork snapshot's path: the snapshot was
	 * overwritten by the forked file, and the "resumed" session came back with the
	 * fork's UUID instead of the snapshot's. Probing for a free name keeps each
	 * backup distinct (see the `-1`, `-2` suffixes after the timestamp).
	 */
	private uniqueBackupPath(sessionFile: string, timestamp: number = Date.now()): string {
		const base = sessionFile.replace(/\.jsonl$/, "");
		let candidate = `${base}-${timestamp}.jsonl`;
		let suffix = 1;
		while (existsSync(candidate)) {
			candidate = `${base}-${timestamp}-${suffix}.jsonl`;
			suffix += 1;
		}
		return candidate;
	}

	// ============================================================================
	// Index Persistence
	// ============================================================================

	loadIndex(): SessionIndex {
		const path = this.getSessionIndexPath();
		try {
			if (existsSync(path)) {
				return JSON.parse(readFileSync(path, "utf-8"));
			}
		} catch (error) {
			this.log("Failed to load session index:", error);
		}
		return { sessions: {} };
	}

	saveIndex(index: SessionIndex): void {
		const path = this.getSessionIndexPath();
		try {
			writeFileSync(path, JSON.stringify(index, null, 2));
		} catch (error) {
			this.log("Failed to save session index:", error);
		}
	}

	// ============================================================================
	// Session Management
	// ============================================================================

	private async createPiSession(channelId: string, sessionPath: string, channelName?: string, cwdOverride?: string): Promise<AgentSession> {
		this.log(`Creating session for channel ${channelId}: ${sessionPath}`);

		// Set up auth and model registry
		const agentDir = join(homedir(), ".pi", "agent");
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});

		// Create or open session manager first to determine the CWD
		let sessionManager: SessionManager;
		if (existsSync(sessionPath)) {
			this.log(`Opening existing session: ${sessionPath}`);
			sessionManager = SessionManager.open(sessionPath, this.sessionDir, cwdOverride);
		} else {
			this.log(`Creating new session: ${sessionPath}`);
			sessionManager = SessionManager.create(cwdOverride || process.cwd(), this.sessionDir);
			// Set the session file path to our custom path
			sessionManager.setSessionFile(sessionPath);
		}

		const cwd = sessionManager.getCwd() || process.cwd();
		this.log(`Using CWD for session: ${cwd}`);

		// Tool allowlist - use string names as per v0.68.0+ API
		// Pass undefined to use default built-in tools, or explicit list like ["read", "bash", "edit", "write"]
		// Note: createCodingTools() returns Tool[] but createAgentSession now expects string[]
		const tools: string[] | undefined = undefined;

		// Add custom remember tool
		let sessionRef: AgentSession | undefined;
		const rememberTool = {
			name: "remember",
			description: "Session memory. Persisted per-channel: survives /session, /clear, /compact, bot restarts, /resume, and forks within the same Discord channel. Use to remember tasks, preferences, or key facts the agent should track and focus on across conversations in this channel.",
			parameters: {
				type: "object",
				properties: {
					memory: {
						type: "string",
						description: "The information to remember, formatted as bullet points.",
					},
				},
				required: ["memory"],
			},
				execute: async (_toolCallId: string, { memory }: { memory: string }) => {
				try {
					// Persist per DISCORD CHANNEL so memory follows the channel across
					// /session, /clear, /compact, restarts, /resume and forks (keying
					// by pi session UUID leaked whenever a fresh UUID was minted).
					const session = sessionRef!;
					saveChannelMemory(this.sessionDir, channelId, memory);
					// Patch the CURRENT turn's system prompt so the running agent
					// loop sees the new memory right away. Future turns pick it up
					// automatically via the before_agent_start extension hook.
					patchCurrentSystemPrompt(session, memory);
					return { content: [{ type: "text", text: "✅ Memory updated successfully (persisted for this channel)." }] };
				} catch (error) {
					return { content: [{ type: "text", text: `❌ Failed to update memory: ${error}` }] };
				}
			},
		};

		const thinkingModeTool = createThinkingModeTool({
			sessionDir: this.sessionDir,
			channelId,
			// Lazy resolver: both the tool's execute and its dynamic description
			// (which reads the live thinking level) use it.
			getSession: () => sessionRef,
		});

		const lookAtFileTool = {
			name: "look_at_file",
			description: "Read a local image file from disk and 'see' it. Use this when you need to analyze a photo, screenshot, or image file on the local filesystem.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Absolute path to the image file (e.g. ~/Pictures/error.png).",
					},
				},
				required: ["path"],
			},
			execute: async (_toolCallId: string, { path }: { path: string }) => {
				try {
					const { absolutePath, base64Data, mimeType } = await readImageFile({ path }, sessionRef!.sessionManager.getCwd());

					// Downscale/compress so heavy images don't bloat the context payload
					// (some providers drop streams on large multimodal requests).
					const { downscaleImage } = await import("./image-utils.ts");
					const downscaled = await downscaleImage(base64Data, mimeType);

					// Inject the image via sendUserMessage (like Discord attachments) so it
					// arrives as a user message, not tool result content. This avoids crashes
					// with text-only models that can't handle image parts in tool results.
					await sessionRef!.sendUserMessage([
						{ type: "text", text: `[Attached Image: ${absolutePath}]` },
						{ type: "image", data: downscaled.data, mimeType: downscaled.mimeType }
					], { deliverAs: "followUp" });

					// Return proper content array — Google provider requires arrays for toolResult
					return { content: [{ type: "text", text: `✅ Image loaded from: ${absolutePath}` }] };
				} catch (error: any) {
					const msg = error?.message || String(error);
					const text = msg.startsWith("FILE_NOT_FOUND:")
						? `❌ File not found at path: ${msg.slice("FILE_NOT_FOUND:".length).trim()}`
						: msg.startsWith("UNSUPPORTED_FORMAT:")
						? `❌ ${msg.slice("UNSUPPORTED_FORMAT:".length).trim()}`
						: msg.startsWith("NOT_AN_IMAGE:")
						? `❌ ${msg.slice("NOT_AN_IMAGE:".length).trim()}`
						: `❌ Error reading image file: ${msg}`;
					return { content: [{ type: "text", text }] };
				}
			},
		};

		// Load settings and apply overrides
		const finalCwd = cwd || process.cwd();
		const settingsManager = SettingsManager.create(finalCwd, agentDir);
		applySettingsOverrides(settingsManager);

		// Store channel name if provided
		if (channelName) {
			this.channelNames.set(channelId, channelName);
		}

		// load resources
		const getChannelName = () => this.channelNames.get(channelId) || channelName || "Discord";
		const resourceLoader = new DefaultResourceLoader({
			cwd: finalCwd,
			agentDir,
			settingsManager,
			// Official `before_agent_start` hook: appends persisted `remember`
			// memory to the system prompt at the start of every agent turn.
			// Channel-scoped: memory follows the channel, not the pi session UUID.
		extensionFactories: [
				createSessionMemoryExtension(this.sessionDir, channelId),
				createSubagentGateExtension(channelId),
			],
			appendSystemPrompt: [`\n\nYou are running on Discord (in a channel named "${getChannelName()}"), use @here in your every message that talks directly to the users (do not use it when just calling tools or thinking about something).`],
			systemPromptOverride: (basePrompt) => {
				if (!basePrompt) return basePrompt;
				let prompt = withCurrentDate(basePrompt);

				// Dynamically update channel name (handles renames)
				const chanName = getChannelName();
				prompt = prompt.replace(
					/You are running on Discord \(in a channel named "[^"]*"\)/,
					`You are running on Discord (in a channel named "${chanName}")`
				);

				return prompt;
			}
		});
		try {
			await resourceLoader.reload();
		} catch (error) {
			this.log(`[${channelId}] Warning: Failed to reload resources (this may affect some automatic tool/resource discovery): ${error}`);
		}

		// Load or create the session file
		const agent = await createAgentSession({
			cwd,
			agentDir: join(homedir(), ".pi", "agent"),
			modelRuntime,
			tools,
			// pi >= 0.84.3 added a built-in `powershell` tool (Windows-only). It is
			// force-activated in our sessions by the pi-readonly-ssh strict-mode bug
			// (it does setActiveTools(getAllTools() minus bash)), so the model sees it
			// and calls it on macOS, getting "only available on Windows". Exclude it.
			excludeTools: ["powershell"],
			customTools: [rememberTool, lookAtFileTool, thinkingModeTool],
			sessionManager,
			settingsManager,
			resourceLoader
		});

		const { session } = agent

		sessionRef = session;

		// Re-apply after creation: building the session reloads settings from disk,
		// which discards the overrides applied above. Without this the bot would
		// inherit the human `httpIdleTimeoutMs: 0` (~24.8 days) and a stalled
		// stream body could park a run forever. Prefer the session's manager (it is
		// what buildRequestOptions reads) and fall back to the one we created for
		// sessions/mocks that do not expose it.
		applySettingsOverrides(session.settingsManager ?? settingsManager);

		// Restore the channel's persisted thinking mode (channel-scoped, defaults
		// to "off") onto this freshly created session so it survives restarts,
		// /session, /clear, /compact, /resume, forks and crashes.
		applyChannelThinkingMode(this.sessionDir, channelId, session);

		// `bindExtensions` accepts only UI/command bindings (uiContext, mode,
		// commandContextActions, abortHandler, shutdownHandler, onError); there is
		// no `mcp` key, so the former `{ mcp: mcpAdapter }` payload was silently
		// ignored. `pi-mcp-adapter` is an ExtensionFactory and belongs in
		// DefaultResourceLoader's `extensionFactories` if MCP is wanted back.
		await session.bindExtensions({});

		// The Discord-facing PARENT session is locked to a strict allowlist
		// (PARENT_TOOL_ALLOWLIST): `subagent` for delegation, plus the direct
		// `schedule_prompt` tool (pi-schedule-prompt extension) so the model can
		// schedule channel prompts without going through the subagent tool. All
		// built-in coding tools and the SDK custom tools
		// (remember/look_at_file/thinkingmode) are intentionally NOT in the
		// parent's active set. The global TUI-side lockdown extension
		// (~/.pi/agent/extensions/parent-tools-lockdown.ts) already skips bot
		// processes via PI_DISCORD_BOT=1, so THIS block is the single source of
		// truth for the bot parent's restriction.
		// Note: setActiveToolsByName is a strict allowlist resolved against the
		// tool registry (unknown names are silently dropped); it does NOT
		// propagate to pi-subagents children, which resolve their own tool plans.
		const registeredToolNames = session.getAllTools().map((tool) => tool.name);
		const parentToolAllowlist = buildParentToolAllowlist(registeredToolNames);
		const droppedTools = PARENT_TOOL_ALLOWLIST.filter((name) => !registeredToolNames.includes(name));
		session.setActiveToolsByName(parentToolAllowlist);
		this.log(
			`[${channelId}] Parent tool allowlist applied (${parentToolAllowlist.length}): ${parentToolAllowlist.join(", ")}` +
				(droppedTools.length > 0 ? ` (dropped, not in registry: ${droppedTools.join(", ")})` : ""),
		);

		if (agent.extensionsResult.errors.length > 0) {
			this.log(`[${channelId}] extensions results errors: ${agent.extensionsResult.errors.map(it => `${it.error} at ${it.path}`)}`);
		}

		// Set session name for identification
		session.setSessionName(`discord-${channelId}`);

		// Persisted `remember` memory is applied automatically on every turn by
		// the before_agent_start extension hook (it re-reads the sidecar file for
		// this session's UUID), so nothing to restore here — the hook covers bot
		// restarts, /resume and any other session recreation.

		return session;
	}

	setChannelName(channelId: string, name: string): void {
		this.channelNames.set(channelId, name);
	}

	getChannelName(channelId: string): string {
		return this.channelNames.get(channelId) || "Discord";
	}

	async getOrCreate(channelId: string, channelName?: string): Promise<DiscordSession> {
		// Fast path: already in memory
		const existing = this.sessions.get(channelId);
		if (existing) {
			this.log(`[${channelId}] getOrCreate: returning cached session`);
			return existing;
		}

		// Pending path: another call is already creating this session
		const pending = this.pendingSessions.get(channelId);
		if (pending) {
			this.log(`[${channelId}] getOrCreate: waiting for pending session`);
			return pending;
		}

		this.log(`[${channelId}] getOrCreate: creating new session (${this.pendingSessions.size} pending)`);
		// Create new session (only one per channel)
		const createPromise = this.doCreateSession(channelId, channelName);
		this.pendingSessions.set(channelId, createPromise);

		try {
			const discordSession = await createPromise;
			return discordSession;
		} finally {
			// Clean up pending promise after completion
			this.pendingSessions.delete(channelId);
		}
	}

	private async doCreateSession(channelId: string, channelName?: string): Promise<DiscordSession> {
		const index = this.loadIndex();
		const indexed = index.sessions[channelId];

		// Use stored session file path if available, otherwise use default
		const defaultPath = this.getSessionPath(channelId);
		const sessionPath = indexed?.sessionFile || defaultPath;

		// Check if the session file actually exists at the stored path
		let sessionFile = sessionPath;
		let exists = existsSync(sessionFile);

		// If the stored path doesn't exist (e.g., after home dir rename), use default
		if (!exists && indexed?.sessionFile) {
			this.log(`Session file not found at ${sessionPath}, trying default path ${defaultPath}`);
			sessionFile = defaultPath;
			exists = existsSync(sessionFile);
		}

		if (exists) {
			this.log(`Found existing session for channel ${channelId}: ${sessionPath}`);
		} else {
			this.log(`Creating new session for channel ${channelId}: ${sessionPath}`);
		}

		const session = await this.createPiSession(channelId, sessionFile, channelName, indexed?.cwd);

		// Restore persisted model if available
		if (indexed?.model) {
			this.log(`[${channelId}] Restoring model: ${indexed.model}`);
			// Split on the FIRST slash only — model IDs may contain slashes
			// themselves (e.g. vastai-qwen38/unsloth/Qwen3.8-27B-GGUF:Q4_K_M,
			// openrouter/google/gemma-4-26b-a4b-it:free). A naive split('/')
			// truncated the ID to "unsloth" so the registry lookup always failed
			// and the channel silently fell back to the default model after
			// /session, /clear, /compact or a bot restart.
			const slashIndex = indexed.model.indexOf('/');
			if (slashIndex === -1) {
				this.log(`[${channelId}] Warning: Persisted model ${indexed.model} has no provider prefix`);
			} else {
				const provider = indexed.model.slice(0, slashIndex);
				const modelId = indexed.model.slice(slashIndex + 1);
				const m = session.modelRuntime.getModel(provider, modelId);
				if (m) {
					await session.setModel(m);
				} else {
					this.log(`[${channelId}] Warning: Persisted model ${indexed.model} not found in registry`);
				}
			}
		}

		const discordSession = new DiscordSession(
			channelId,
			session,
			Date.now(),
		);

		// Store in memory
		this.sessions.set(channelId, discordSession);

		// Update index with session file path and preserve other metadata
		const newIndex = this.loadIndex();
		const currentMeta = newIndex.sessions[channelId] || {};
		newIndex.sessions[channelId] = {
			...currentMeta,
			channelId,
			sessionFile: sessionFile,
			lastActivity: discordSession.lastActivity,
		};
		this.saveIndex(newIndex);

		return discordSession;
	}

	// Update last activity for a session
	touch(channelId: string): void {
		const discordSession = this.sessions.get(channelId);
		if (discordSession) {
			discordSession.lastActivity = Date.now();

			// Update index
			const index = this.loadIndex();
			if (index.sessions[channelId]) {
				index.sessions[channelId].lastActivity = discordSession.lastActivity;
				this.saveIndex(index);
			}
		}
	}

	updateModel(channelId: string, model: string): void {
		const index = this.loadIndex();
		if (index.sessions[channelId]) {
			index.sessions[channelId].model = model;
			this.saveIndex(index);
		}
	}

	// Get a session if it exists (without creating)
	get(channelId: string): DiscordSession | undefined {
		return this.sessions.get(channelId);
	}

	// Dispose a specific session
	dispose(channelId: string): void {
		const discordSession = this.sessions.get(channelId);
		if (discordSession) {
			discordSession.session.dispose();
			this.sessions.delete(channelId);
		}
		subagentGates.delete(channelId);
	}

	// Dispose all sessions and save index
	disposeAll(): void {
		const index = this.loadIndex();

		for (const [channelId, discordSession] of this.sessions) {
			if (index.sessions[channelId]) {
				index.sessions[channelId].lastActivity = discordSession.lastActivity;
			}
			discordSession.session.dispose();
		}

		this.saveIndex(index);
		this.sessions.clear();
		subagentGates.clear();
	}

	// Get all active session channel IDs
	keys(): string[] {
		return Array.from(this.sessions.keys());
	}

	// Check if a session exists in memory
	has(channelId: string): boolean {
		return this.sessions.has(channelId);
	}

	// Get the session file path for a channel
	getSessionFile(channelId: string): string {
		return this.getSessionPath(channelId);
	}

	// Check if a session file exists on disk
	sessionExists(channelId: string): boolean {
		return existsSync(this.getSessionPath(channelId));
	}

	// ============================================================================
	// Closed Sessions (for /new and /resume)
	// ============================================================================

	private getClosedSessionsPath(): string {
		return join(this.sessionDir, "closed-sessions.json");
	}

	private loadClosedSessions(): ClosedSessionInfo[] {
		const path = this.getClosedSessionsPath();
		try {
			if (existsSync(path)) {
				return JSON.parse(readFileSync(path, "utf-8"));
			}
		} catch (error) {
			this.log("Failed to load closed sessions:", error);
		}
		return [];
	}

	private saveClosedSessions(sessions: ClosedSessionInfo[]): void {
		const path = this.getClosedSessionsPath();
		try {
			writeFileSync(path, JSON.stringify(sessions, null, 2));
		} catch (error) {
			this.log("Failed to save closed sessions:", error);
		}
	}

	/**
	 * Close the current session for a channel and start a new one.
	 * Returns the closed session's ID.
	 */
	async closeAndNewSession(channelId: string, label?: string): Promise<string> {
		const discordSession = this.sessions.get(channelId);
		if (!discordSession) {
			throw new Error("No active session for this channel");
		}

		const stats = discordSession.session.getSessionStats();
		const sessionId = stats.sessionId;
		const oldSessionFile = stats.sessionFile || this.getSessionPath(channelId);
		const defaultPath = this.getSessionPath(channelId);
		const sessionName = discordSession.session.sessionName || `discord-${channelId}`;

		// Generate backup filename with timestamp
		const timestamp = Date.now();
		const backupFile = this.uniqueBackupPath(oldSessionFile, timestamp);

		this.log(`[${channelId}] Closing session ${sessionId}, moving ${oldSessionFile} → ${backupFile}`);

		// Dispose from memory first (releases file handles)
		this.dispose(channelId);

		// Rename old session file to backup (copy if the defaultPath differs,
		// because we need to also clean up the stale default path file below)
		if (existsSync(oldSessionFile)) {
			if (oldSessionFile !== defaultPath) {
				// Session file was changed (e.g., by /clear which calls newSession()),
				// so copy instead of rename to preserve the file for /resume
				copyFileSync(oldSessionFile, backupFile);
			} else {
				renameSync(oldSessionFile, backupFile);
			}
		}

		// Always clean up the default path (discord-{channelId}.jsonl) after rename.
		// The rename already moved oldSessionFile. The defaultPath may still
		// exist if oldSessionFile was a different path (e.g., from a previous
		// /clear or /new). Remove it unconditionally to prevent stale sessions
		// from being reloaded on restart (causing "invalid base64 data" errors).
		if (existsSync(defaultPath)) {
			this.log(`[${channelId}] Removing stale default path file: ${defaultPath}`);
			unlinkSync(defaultPath);
		}

		// Store closed session info
		const closedSessions = this.loadClosedSessions();
		closedSessions.push({
			channelId,
			sessionId,
			sessionFile: backupFile,
			sessionName,
			closedAt: timestamp,
			label,
		});
		this.saveClosedSessions(closedSessions);

		// Keep the channel in the active index so its metadata (cwd, model) survives
		// /session, but reset the session file so the next getOrCreate starts fresh
		// (the old file was moved to a timestamped backup above).
		const index = this.loadIndex();
		const existingMeta = index.sessions[channelId] || {};
		index.sessions[channelId] = {
			...existingMeta,
			channelId,
			sessionFile: defaultPath,
			lastActivity: Date.now(),
		};
		this.saveIndex(index);

		this.log(`[${channelId}] Closed session ${sessionId}, stored as ${backupFile}`);

		return sessionId;
	}

	/**
	 * Fork the current session the pi-native way: mint a NEW session (fresh
	 * UUID) via SessionManager.createBranchedSession() — which replays the
	 * full conversation path (root → current leaf: messages, tool calls,
	 * compaction summaries, model/thinking history, labels) into a brand-new
	 * session file — then move that file onto the channel's default path so
	 * the live session keeps the bot's "default path = live session"
	 * convention (startup, cron, memory all rely on it).
	 *
	 * The ORIGINAL pre-fork session (old UUID) is saved as a resumable
	 * snapshot and registered in closed-sessions.json (label works too).
	 * Returns the snapshot's session id (old UUID).
	 */
	async forkSession(channelId: string, label?: string): Promise<string> {
		const discordSession = this.sessions.get(channelId);
		if (!discordSession) {
			throw new Error("No active session for this channel");
		}

		// Don't fork mid-turn — the manager gets transformed below.
		await discordSession.abortModelActivities();

		const { session } = discordSession;
		const oldStats = session.getSessionStats();
		const oldSessionId = oldStats.sessionId;
		const oldSessionFile = oldStats.sessionFile || this.getSessionPath(channelId);
		const defaultPath = this.getSessionPath(channelId);
		const sessionName = session.sessionName || `discord-${channelId}`;
		const leafId = session.sessionManager.getLeafId();
		if (!leafId) {
			throw new Error("Cannot fork: session has no conversation yet");
		}
		// Guard BEFORE any mutation: createBranchedSession transforms the manager
		// immediately but defers writing the file until the first assistant
		// message — a fork with no assistant content would strand the manager
		// half-transformed. Refuse instead.
		const hasAssistant = session.sessionManager.getBranch(leafId).some(
			(e: any) => e.type === "message" && e.message?.role === "assistant"
		);
		if (!hasAssistant) {
			throw new Error("Cannot fork: session has no assistant content yet");
		}

		// 1) Snapshot the pre-fork state to a distinct backup path (resumable
		//    via /resume <id>). The default path itself must NOT be registered
		//    as a closed-session file — resumeSession unlinks the default path
		//    before restoring, which would destroy the snapshot.
		const timestamp = Date.now();
		const backupFile = this.uniqueBackupPath(oldSessionFile, timestamp);
		if (existsSync(oldSessionFile)) {
			if (oldSessionFile === defaultPath) {
				copyFileSync(oldSessionFile, backupFile);
			} else {
				// Live file is already at a distinct path (e.g. after /clear) —
				// moving it frees the default path for the fork below.
				renameSync(oldSessionFile, backupFile);
			}
		} else {
			throw new Error("Cannot fork: session file not found on disk");
		}

		// 2) Create the NEW session (new UUID, full history) with pi's own
		//    fork primitive. It re-points the current SessionManager in place
		//    to represent the new session and writes the new file.
		const forkedPath = session.sessionManager.createBranchedSession(leafId);
		if (!forkedPath) {
			throw new Error("Cannot fork: failed to create forked session");
		}
		if (!existsSync(forkedPath)) {
			// No assistant content yet — createBranchedSession defers writing the
			// file until the first assistant message. Nothing meaningful to fork.
			throw new Error("Cannot fork: session has no assistant content yet");
		}

		// 3) Move the fork onto the channel default path (the live slot).
		if (existsSync(defaultPath)) {
			// Only ever the stale pre-fork copy (old UUID) — its snapshot lives
			// at backupFile, so it's safe to remove.
			this.log(`[${channelId}] Removing stale default path file: ${defaultPath}`);
			unlinkSync(defaultPath);
		}
		renameSync(forkedPath, defaultPath);
		session.sessionManager.setSessionFile(defaultPath);

		// 4) Rebuild the agent's in-memory context for the forked session so
		//    the next turn carries the full history (same as /compact does).
		const ctx = session.sessionManager.buildSessionContext();
		session.agent.state.messages = ctx.messages;

		// 5) Register the original session as a resumable snapshot
		const closedSessions = this.loadClosedSessions();
		closedSessions.push({
			channelId,
			sessionId: oldSessionId,
			sessionFile: backupFile,
			sessionName,
			closedAt: timestamp,
			label,
		});
		this.saveClosedSessions(closedSessions);

		// 6) Keep the channel's index pointing at the live (now forked) session
		//    and preserve its metadata (cwd, model).
		const index = this.loadIndex();
		const existingMeta = index.sessions[channelId] || {};
		index.sessions[channelId] = {
			...existingMeta,
			channelId,
			sessionFile: defaultPath,
			lastActivity: Date.now(),
		};
		this.saveIndex(index);

		this.log(`[${channelId}] Forked session ${oldSessionId} → new session; pre-fork snapshot stored as ${backupFile}`);

		return oldSessionId;
	}

	/**
	 * Resume a previously closed session.
	 * Closes the current session, restores the old one by session ID.
	 */
	async resumeSession(channelId: string, sessionIdOrLabel: string): Promise<boolean> {
		// Find the closed session by ID or label
		const closedSessions = this.loadClosedSessions();
		const idx = closedSessions.findIndex(s =>
			s.sessionId === sessionIdOrLabel || s.label === sessionIdOrLabel
		);
		if (idx === -1) {
			return false;
		}

		const closedInfo = closedSessions[idx];
		const backupFile = closedInfo.sessionFile;

		if (!existsSync(backupFile)) {
			this.log(`[${channelId}] Closed session file not found: ${backupFile}`);
			// Clean up stale entry
			closedSessions.splice(idx, 1);
			this.saveClosedSessions(closedSessions);
			return false;
		}

		// Close current session if any
		const currentSession = this.sessions.get(channelId);
		if (currentSession) {
			// Capture stats BEFORE dispose (session methods may fail after dispose)
			const currentStats = currentSession.session.getSessionStats();
			const currentSessionName = currentSession.session.sessionName || `discord-${channelId}`;
			// Use the actual session file path (may differ from defaultPath after /clear)
			const currentFile = currentStats.sessionFile || this.getSessionPath(channelId);

			// Dispose current session from memory
			this.dispose(channelId);

			// Move current session file to a backup
			if (existsSync(currentFile)) {
				const swapTimestamp = Date.now();
				// Must not collide with the snapshot being restored below: a same-millisecond
				// fork would otherwise clobber it (see uniqueBackupPath).
				const swappedFile = this.uniqueBackupPath(currentFile, swapTimestamp);
				renameSync(currentFile, swappedFile);

				// Add the current session to closed sessions too, so it's not lost
				closedSessions.push({
					channelId,
					sessionId: currentStats.sessionId,
					sessionFile: swappedFile,
					sessionName: currentSessionName,
					closedAt: swapTimestamp,
				});

				this.log(`[${channelId}] Moved current session to ${swappedFile}`);
			}
		}

		// Restore the target session file back to the default path
		const defaultPath = this.getSessionPath(channelId);
		// If default path already exists (stale file from before /clear),
		// remove it first to avoid renameSync failure
		if (existsSync(defaultPath)) {
			this.log(`[${channelId}] Removing stale file at default path: ${defaultPath}`);
			unlinkSync(defaultPath);
		}
		renameSync(backupFile, defaultPath);
		this.log(`[${channelId}] Restored session ${closedInfo.sessionId}: ${backupFile} → ${defaultPath}`);

		// Update index to point to default path, preserving channel metadata (cwd, model)
		const index = this.loadIndex();
		const existingMeta = index.sessions[channelId] || {};
		index.sessions[channelId] = {
			...existingMeta,
			channelId,
			sessionFile: defaultPath,
			lastActivity: Date.now(),
		};
		this.saveIndex(index);

		// Remove from closed sessions list
		closedSessions.splice(idx, 1);
		this.saveClosedSessions(closedSessions);

		return true;
	}

	/**
	 * Get all closed sessions for a channel.
	 */
	getClosedSessions(channelId: string): ClosedSessionInfo[] {
		return this.loadClosedSessions().filter(s => s.channelId === channelId);
	}

	/**
	 * Get all closed sessions across all channels.
	 */
	getAllClosedSessions(): ClosedSessionInfo[] {
		return this.loadClosedSessions();
	}

	// Change the working directory for a channel and return the expanded path.
	// The session is recreated so the new cwd takes effect immediately; if the
	// session file exists it is reopened with the new cwd as an override, which
	// preserves the conversation context across the change.
	async changeCwd(channelId: string, newCwd: string): Promise<string> {
		const expandedPath = newCwd.startsWith("~") 
			? join(homedir(), newCwd.slice(1)) 
			: newCwd;

		const index = this.loadIndex();
		if (!index.sessions[channelId]) {
			index.sessions[channelId] = { channelId, sessionFile: this.getSessionPath(channelId), lastActivity: Date.now() };
		}
		index.sessions[channelId].cwd = expandedPath;
		this.saveIndex(index);

		this.dispose(channelId);
		await this.getOrCreate(channelId);

		return expandedPath;
	}

	reset(channelId: string): void {
		const discordSession = this.sessions.get(channelId);
		if (discordSession) {
			this.log(`[${channelId}] Resetting session`);
			const session = discordSession.session;
			const sessionManager = session.sessionManager;
			const defaultPath = this.getSessionPath(channelId);

			// Preserve the current session as a resumable backup (like /session)
			// instead of stranding it: /clear used to let SessionManager.newSession()
			// repoint writes at a timestamped <ts>_<uuid>.jsonl file, so after a
			// restart the bot reopened the OLD discord-<channel>.jsonl and the
			// "cleared" state silently reverted (full zombie session + its memory
			// resurrected with it).
			let backupFile: string | undefined;
			let oldSessionId: string | undefined;
			try {
				const stats = session.getSessionStats();
				oldSessionId = stats.sessionId;
				const oldFile = stats.sessionFile || defaultPath;
				if (oldSessionId && existsSync(oldFile)) {
					const ts = Date.now();
					backupFile = this.uniqueBackupPath(oldFile, ts);
					renameSync(oldFile, backupFile);
				}
			} catch {
				// Best-effort; stats may be unavailable mid-stream
			}

			// Clear any stale default-path file so the fresh session owns it
			if (existsSync(defaultPath)) {
				unlinkSync(defaultPath);
			}

			// Reset both the Agent state (messages) and the session manager (file state)
			session.agent.reset();
			sessionManager.newSession();
			// SessionManager.newSession() points at a timestamped file; repoint
			// writes at the channel default path so restarts open the new session.
			if (sessionManager.getSessionFile() !== defaultPath) {
				sessionManager.setSessionFile(defaultPath);
			}

			if (backupFile && oldSessionId) {
				const closedSessions = this.loadClosedSessions();
				closedSessions.push({
					channelId,
					sessionId: oldSessionId,
					sessionFile: backupFile,
					sessionName: session.sessionName || `discord-${channelId}`,
					closedAt: Date.now(),
				});
				this.saveClosedSessions(closedSessions);
			}

			// Update last activity
			this.touch(channelId);
		}
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createSessionStore(options?: { sessionDir?: string; debug?: boolean }): SessionStore {
	return new SessionStore(options);
}

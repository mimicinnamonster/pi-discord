/**
 * Session Store - Manages Discord channel to pi session mappings
 * with persistence to disk.
 */

import {
	AuthStorage,
	createAgentSession,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	createCodingTools,
	type AgentSession,
	DefaultResourceLoader,
	discoverAndLoadExtensions,
} from "@mariozechner/pi-coding-agent";
import mcpAdapter from "pi-mcp-adapter";
import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

// ============================================================================
// Types
// ============================================================================

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
		const m = this.session.modelRegistry.find(provider, model)
		if (!m) throw new Error(`Can't find model ${provider}/${model}`)
		await this.session.setModel(m);
		this.applyRetryOverrides();
	}

	private applyRetryOverrides() {
		this.session.settingsManager.applyOverrides({
			retry: { enabled: true, maxRetries: 10 },
		});
	}

	isModelActive() {
		return this.session.isStreaming || this.session.isRetrying || this.session.isCompacting || this.session.isBashRunning || this.session.isRetrying;
	}

	async abortModelActivities() {
		this.session.abortCompaction();
		this.session.abortRetry();
		await this.session.abort();
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

	constructor(options?: { sessionDir?: string; debug?: boolean }) {
		this.sessionDir = options?.sessionDir || join(homedir(), ".pi-discord", "sessions");
		this.debug = options?.debug || false;

		// Ensure session directory exists
		if (!existsSync(this.sessionDir)) {
			mkdirSync(this.sessionDir, { recursive: true });
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

	private async createPiSession(channelId: string, sessionPath: string, cwdOverride?: string): Promise<AgentSession> {
		this.log(`Creating session for channel ${channelId}: ${sessionPath}`);

		// Set up auth and model registry
		const agentDir = join(homedir(), ".pi", "agent");
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));

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
			description: "Temporary session memory. Adds info to the system prompt for this session only (lost on /clear or restart). Use to remember tasks, preferences, or key facts the agent should track and focus on during this conversation.",
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
					const memoryBlock = `agent memory:\n${memory}`;
					const current = sessionRef!["agent"].state.systemPrompt;
					const marker = "agent memory:";
					const markerIndex = current.indexOf(marker);
					if (markerIndex !== -1) {
						// Replace from the marker, strip trailing newlines from existing prefix
						const base = current.slice(0, markerIndex).replace(/\n+$/, "");
						sessionRef!["agent"].state.systemPrompt = base + `\n\n${memoryBlock}`;
					} else {
						// Append
						sessionRef!["agent"].state.systemPrompt = current + `\n\n${memoryBlock}`;
					}
					return { content: [{ type: "text", text: "✅ Memory updated successfully." }] };
				} catch (error) {
					return { content: [{ type: "text", text: `❌ Failed to update memory: ${error}` }] };
				}
			},
		};

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

					// Inject the image via sendUserMessage (like Discord attachments) so it
					// arrives as a user message, not tool result content. This avoids crashes
					// with text-only models that can't handle image parts in tool results.
					await sessionRef!.sendUserMessage([
						{ type: "text", text: `[Attached Image: ${absolutePath}]` },
						{ type: "image", data: base64Data, mimeType: mimeType }
					], { deliverAs: "nextTurn" });

					// Return proper content array — Google provider requires arrays for toolResult
					return { content: [{ type: "text", text: `✅ Image loaded from: ${absolutePath}` }] };
				} catch (error: any) {
					const msg = error?.message || String(error);
					const text = msg.startsWith("FILE_NOT_FOUND:")
						? `❌ File not found at path: ${msg.slice("FILE_NOT_FOUND:".length).trim()}`
						: msg.startsWith("UNSUPPORTED_FORMAT:")
						? `❌ ${msg.slice("UNSUPPORTED_FORMAT:".length).trim()}`
						: `❌ Error reading image file: ${msg}`;
					return { content: [{ type: "text", text }] };
				}
			},
		};

		// Load settings and apply overrides
		const finalCwd = cwd || process.cwd();
		const settingsManager = SettingsManager.create(finalCwd, agentDir);
		settingsManager.applyOverrides({
			retry: { enabled: true, maxRetries: 10 },
		});

		// load resources
		const resourceLoader = new DefaultResourceLoader({
			cwd: finalCwd,
			agentDir,
			settingsManager,
			appendSystemPrompt: [`/n/nYou are running on Discord, use @here in your every message that talks directly to the users (do not use it when just calling tools or thinking about something).`],
			systemPromptOverride: (basePrompt) => {
				if (!basePrompt) return basePrompt;
				const now = new Date();
				const localDate = now.toLocaleDateString('en-CA');
				let prompt = basePrompt.replace(/Current date: \d{4}-\d{2}-\d{2}/, `Current date: ${localDate}`);

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
			authStorage,
			modelRegistry,
			tools,
			customTools: [rememberTool, lookAtFileTool],
			sessionManager,
			settingsManager,
			resourceLoader
		});

		const { session } = agent

		sessionRef = session;

    await session.bindExtensions({
        mcp: mcpAdapter,
    });

		if (agent.extensionsResult.errors.length > 0) {
			this.log(`[${channelId}] extensions results errors: ${agent.extensionsResult.errors.map(it => `${it.error} at ${it.path}`)}`);
		}

		// Set session name for identification
		session.setSessionName(`discord-${channelId}`);

		// Restore agent memory from session file if it exists
		try {
			const systemPrompt = session.systemPrompt;
			if (systemPrompt) {
				const memoryMarker = "agent memory:";
				const memoryIndex = systemPrompt.indexOf(memoryMarker);
				if (memoryIndex !== -1) {
					this.log(`[${channelId}] Restored memory from system prompt`);
				}
			}
		} catch (error) {
			this.log(`[${channelId}] Failed to check for restored memory: ${error}`);
		}

		return session;
	}

	async getOrCreate(channelId: string): Promise<DiscordSession> {
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
		const createPromise = this.doCreateSession(channelId);
		this.pendingSessions.set(channelId, createPromise);

		try {
			const discordSession = await createPromise;
			return discordSession;
		} finally {
			// Clean up pending promise after completion
			this.pendingSessions.delete(channelId);
		}
	}

	private async doCreateSession(channelId: string): Promise<DiscordSession> {
		const index = this.loadIndex();
		const indexed = index.sessions[channelId];

		// Use stored session file path if available, otherwise use default
		const sessionPath = indexed?.sessionFile || this.getSessionPath(channelId);
		const exists = existsSync(sessionPath);

		if (exists) {
			this.log(`Found existing session for channel ${channelId}: ${sessionPath}`);
		} else {
			this.log(`Creating new session for channel ${channelId}: ${sessionPath}`);
		}

		const session = await this.createPiSession(channelId, sessionPath, indexed?.cwd);

		// Restore persisted model if available
		if (indexed?.model) {
			this.log(`[${channelId}] Restoring model: ${indexed.model}`);
			const [provider, modelId] = indexed.model.split('/');
			const m = session.modelRegistry.find(provider, modelId);
			if (m) {
				await session.setModel(m);
			} else {
				this.log(`[${channelId}] Warning: Persisted model ${indexed.model} not found in registry`);
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
			sessionFile: sessionPath,
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

	// Reset a session (clear messages, start fresh)
	async changeCwd(channelId: string, newCwd: string): Promise<void> {
		const expandedPath = newCwd.startsWith("~") 
			? join(homedir(), newCwd.slice(1)) 
			: newCwd;

		const index = this.loadIndex();
		if (index.sessions[channelId]) {
			index.sessions[channelId].cwd = expandedPath;
			this.saveIndex(index);
		}
		this.dispose(channelId);
	}

	reset(channelId: string): void {
		const discordSession = this.sessions.get(channelId);
		if (discordSession) {
			this.log(`[${channelId}] Resetting session`);
			// Reset both the Agent state (messages) and the session manager (file state)
			discordSession.session.agent.reset();
			discordSession.session.sessionManager.newSession();

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

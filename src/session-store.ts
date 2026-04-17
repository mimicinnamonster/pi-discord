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

		const cwd = sessionManager.getCwd();
		this.log(`Using CWD for session: ${cwd}`);

		// Create tools with session-specific cwd
		const tools = createCodingTools(cwd);

		// Load settings and apply overrides
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.applyOverrides({
			retry: { enabled: true, maxRetries: 10 },
		});

		// load resources
		const resourceLoader = new DefaultResourceLoader({
			appendSystemPrompt: [`/n/nYou are running on Discord, use @here in your every message that talks directly to the users (do not use it when just calling tools or thinking about something).`],
			systemPromptOverride: (basePrompt) => {
				if (!basePrompt) return basePrompt;
				const now = new Date();
				const localDate = now.toLocaleDateString('en-CA');
				return basePrompt.replace(/Current date: \d{4}-\d{2}-\d{2}/, `Current date: ${localDate}`);
			}
		});
		await resourceLoader.reload()

		// Load or create the session file
		const agent = await createAgentSession({
			cwd,
			agentDir: join(homedir(), ".pi", "agent"),
			authStorage,
			modelRegistry,
			tools,
			sessionManager,
			settingsManager,
			resourceLoader
		});

		const { session } = agent

    await session.bindExtensions({});

		if (agent.extensionsResult.errors.length > 0) {
			this.log(`[${channelId}] extensions results errors: ${agent.extensionsResult.errors.map(it => `${it.error} at ${it.path}`)}`);
		}

		// Set session name for identification
		session.setSessionName(`discord-${channelId}`);

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

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

export interface DiscordSession {
	channelId: string;
	session: AgentSession;
	lastActivity: number;
}

export interface SessionIndex {
	sessions: Record<string, { channelId: string; sessionFile: string; lastActivity: number }>;
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

	private async createPiSession(channelId: string, sessionPath: string): Promise<AgentSession> {
		this.log(`Creating session for channel ${channelId}: ${sessionPath}`);

		// Set up auth and model registry
		const authStorage = AuthStorage.create(join(this.sessionDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(this.sessionDir, "models.json"));

		// Create tools with session-specific cwd
		const cwd = process.cwd();
		const tools = createCodingTools(cwd);

		// Create or open session manager
		let sessionManager: SessionManager;
		if (existsSync(sessionPath)) {
			this.log(`Opening existing session: ${sessionPath}`);
			sessionManager = SessionManager.open(sessionPath, this.sessionDir);
		} else {
			this.log(`Creating new session: ${sessionPath}`);
			sessionManager = SessionManager.create(cwd, this.sessionDir);
			// Set the session file path to our custom path
			sessionManager.setSessionFile(sessionPath);
		}

		// Load settings and apply overrides
		const settingsManager = SettingsManager.create(cwd, join(homedir(), ".pi", "agent"));
		settingsManager.applyOverrides({
			retry: { enabled: true, maxRetries: 10 },
		});

		// load resources
		const resourceLoader = new DefaultResourceLoader({
			appendSystemPrompt: `/n/nYou are running on Discord, use @here in your every message that talks directly to the users (do not use it when just calling tools or thinking about something).`
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

		const session = await this.createPiSession(channelId, sessionPath);
		const discordSession: DiscordSession = {
			channelId,
			session,
			lastActivity: Date.now(),
		};

		// Store in memory
		this.sessions.set(channelId, discordSession);

		// Update index with session file path
		const newIndex = this.loadIndex();
		newIndex.sessions[channelId] = {
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
			index.sessions[channelId] = {
				channelId,
				sessionFile: this.getSessionPath(channelId),
				lastActivity: discordSession.lastActivity,
			};
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
			index.sessions[channelId] = {
				channelId,
				sessionFile: this.getSessionPath(channelId),
				lastActivity: discordSession.lastActivity,
			};
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

/**
 * Session Store Tests
 * Tests for the session persistence behavior
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../src/session-store.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";

/**
 * Session-context messages are a union that includes BashExecutionMessage,
 * which has no `content`. These assertions only ever read text-bearing
 * messages, so narrow once here instead of casting at each call site.
 */
function messageText(message: unknown): string {
	return (message as { content: Array<{ text: string }> }).content[0].text;
}

describe("SessionStore", () => {
	const testDir = join(tmpdir(), `pi-discord-test-${Date.now()}`);
	let store: SessionStore;

	beforeEach(() => {
		// Create test directory
		if (!existsSync(testDir)) {
			mkdirSync(testDir, { recursive: true });
		}

		store = new SessionStore({
			sessionDir: testDir,
			debug: false,
		});
	});

	afterEach(() => {
		// Cleanup
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("Index Persistence", () => {
		it("should return empty index when no index file exists", () => {
			const index = store.loadIndex();
			expect(index.sessions).toEqual({});
		});

		it("should save and load index correctly", () => {
			const index = {
				sessions: {
					"channel-1": {
						channelId: "channel-1",
						sessionFile: "/path/to/session.jsonl",
						lastActivity: 1234567890,
					},
				},
			};

			store.saveIndex(index);
			const loaded = store.loadIndex();

			expect(loaded.sessions["channel-1"]).toEqual(index.sessions["channel-1"]);
		});

		it("should return empty index on corrupted file", () => {
			// Create a corrupted index file
			const indexPath = join(testDir, "index.json");
			writeFileSync(indexPath, "invalid json{");

			// Create fresh store to read the corrupted file
			const freshStore = new SessionStore({ sessionDir: testDir });
			const index = freshStore.loadIndex();
			expect(index.sessions).toEqual({});
		});
	});

	describe("Session Path Generation", () => {
		it("should generate correct session file path", () => {
			const path = store.getSessionFile("123456789");
			expect(path).toBe(join(testDir, "discord-123456789.jsonl"));
		});

		it("should handle Discord channel IDs", () => {
			const channelId = "1489016529117904976";
			const path = store.getSessionFile(channelId);
			expect(path).toBe(join(testDir, `discord-${channelId}.jsonl`));
		});

		it("should use consistent naming pattern", () => {
			const path1 = store.getSessionFile("channel-1");
			const path2 = store.getSessionFile("channel-2");

			expect(path1).toContain("discord-channel-1.jsonl");
			expect(path2).toContain("discord-channel-2.jsonl");
			expect(path1).not.toBe(path2);
		});
	});

	describe("Session Existence Check", () => {
		it("should return false when session file does not exist", () => {
			expect(store.sessionExists("nonexistent")).toBe(false);
		});

		it("should return true when session file exists", () => {
			// Create a fake session file
			const sessionPath = join(testDir, "discord-existing-channel.jsonl");
			writeFileSync(sessionPath, '{"type":"session","id":"test","timestamp":"2024-01-01T00:00:00Z","cwd":"/test"}');

			expect(store.sessionExists("existing-channel")).toBe(true);

			// Cleanup
			unlinkSync(sessionPath);
		});
	});

	describe("In-Memory Session Management", () => {
		it("should start with empty keys", () => {
			expect(store.keys()).toEqual([]);
		});

		it("should return undefined for non-existent session", () => {
			expect(store.get("any-channel")).toBeUndefined();
		});

		it("should return false for non-existent session check", () => {
			expect(store.has("any-channel")).toBe(false);
		});
	});

	describe("Retry Settings Persistence", () => {
		it("should apply the maxRetries override when the model is set", async () => {
			const channelId = "retry-test-channel";
			const discordSession = await store.getOrCreate(channelId);

			// The initial value comes from the developer's global pi settings
			// (~/.pi/agent/settings.json), so only the override is asserted here.

			// Simulate setModel which re-applies overrides.
			// pi >= 0.84 validates auth in setModel, so pick a model the
			// current environment actually has credentials for.
			const available = await discordSession.session.modelRuntime.getAvailable();
			const target = available.find((m) => m.provider === "google" && m.id === "gemma-4-31b-it") ?? available[0];
			await discordSession.setModel(target.provider, target.id);
			expect(discordSession.session.settingsManager.getRetrySettings().maxRetries).toBe(3);
		});
	});

	describe("CWD Management", () => {
		it("should expand ~ and persist cwd in the index", async () => {
			const channelId = "cwd-expand-channel";
			await store.getOrCreate(channelId);
			await store.changeCwd(channelId, "~/Projects/rotz");

			const index = store.loadIndex();
			expect(index.sessions[channelId].cwd).toBe(join(homedir(), "Projects/rotz"));
		});

		it("should return the expanded path", async () => {
			const channelId = "cwd-return-channel";
			await store.getOrCreate(channelId);

			const expanded = await store.changeCwd(channelId, "~");
			expect(expanded).toBe(homedir());
		});

		it("should recreate the session with the new cwd applied", async () => {
			const channelId = "cwd-recreate-channel";
			await store.getOrCreate(channelId);
			await store.changeCwd(channelId, "~/Projects/rotz");

			const discordSession = await store.getOrCreate(channelId);
			expect(discordSession.session.sessionManager.getCwd()).toBe(join(homedir(), "Projects/rotz"));
		});

		it("should work for a channel without an existing session", async () => {
			const channelId = "cwd-fresh-channel";
			await store.changeCwd(channelId, "~/Projects/rotz");

			const index = store.loadIndex();
			expect(index.sessions[channelId].cwd).toBe(join(homedir(), "Projects/rotz"));

			const discordSession = await store.getOrCreate(channelId);
			expect(discordSession.session.sessionManager.getCwd()).toBe(join(homedir(), "Projects/rotz"));
		});

		it("should preserve conversation context across a cwd change", async () => {
			const channelId = "cwd-context-channel";
			const sessionId = "cwd-context-session";
			const ts = new Date().toISOString();
			// Write a valid v3 session file with a header + two messages
			// (array content parts — the format getSessionStats expects)
			writeFileSync(store.getSessionFile(channelId), [
				{ type: "session", version: 3, id: sessionId, timestamp: ts, cwd: "/tmp" },
				{ type: "message", id: "m1", parentId: null, timestamp: ts, message: { role: "user", content: [{ type: "text", text: "Remember this" }] } },
				{ type: "message", id: "m2", parentId: "m1", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "Noted" }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } },
			].map((e) => JSON.stringify(e)).join("\n") + "\n");

			await store.getOrCreate(channelId);
			await store.changeCwd(channelId, "~/Projects/rotz");

			// The recreated session must keep the old conversation, with the new cwd
			const discordSession = await store.getOrCreate(channelId);
			expect(discordSession.session.sessionManager.getCwd()).toBe(join(homedir(), "Projects/rotz"));
			const context = discordSession.session.sessionManager.buildSessionContext();
			expect(context.messages.length).toBeGreaterThanOrEqual(2);
			expect(messageText(context.messages[0])).toBe("Remember this");
			expect(messageText(context.messages[1])).toBe("Noted");
		});
	});

	describe("Session Close Metadata", () => {
		// Multiple real SDK session creations (getOrCreate + changeCwd's implicit
		// recreation + closeAndNewSession + getOrCreate) routinely exceed the
		// default 5s vitest timeout, so give this integration-style test its own.
		it("should preserve cwd and model when closing a session", async () => {
			const channelId = "close-meta-channel";
			await store.getOrCreate(channelId);
			await store.changeCwd(channelId, "~/Projects/rotz");
			store.updateModel(channelId, "test-provider/test-model");

			await store.closeAndNewSession(channelId);

			const index = store.loadIndex();
			expect(index.sessions[channelId]).toBeDefined();
			expect(index.sessions[channelId].cwd).toBe(join(homedir(), "Projects/rotz"));
			expect(index.sessions[channelId].model).toBe("test-provider/test-model");

			// The new session should pick up the preserved cwd
			const discordSession = await store.getOrCreate(channelId);
			expect(discordSession.session.sessionManager.getCwd()).toBe(join(homedir(), "Projects/rotz"));
		}, 30000);
	});

	describe("Session Resume", () => {
		/**
		 * Write a valid v3 session file (header + user + assistant message) at the
		 * channel's default path, so closeAndNewSession can back it up and
		 * resumeSession can restore it — mirroring a real persisted conversation.
		 */
		function writeSessionFixture(channelId: string, sessionId: string, cwd: string = "/tmp"): string {
			const path = store.getSessionFile(channelId);
			const ts = new Date().toISOString();
			const entries = [
				{ type: "session", version: 3, id: sessionId, timestamp: ts, cwd },
				{ type: "message", id: "msg-1", parentId: null, timestamp: ts, message: { role: "user", content: [{ type: "text", text: "Hello there" }] } },
				{ type: "message", id: "msg-2", parentId: "msg-1", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "Hi!" }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } },
			];
			writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
			return path;
		}

		it("should resume a closed session by ID", async () => {
			const channelId = "resume-by-id-channel";
			const sessionId = "resume-session-id-001";
			writeSessionFixture(channelId, sessionId);

			const discordSession = await store.getOrCreate(channelId);
			expect(discordSession.session.getSessionStats().sessionId).toBe(sessionId);

			const closedId = await store.closeAndNewSession(channelId);
			expect(closedId).toBe(sessionId);

			expect(await store.resumeSession(channelId, sessionId)).toBe(true);

			// Session file restored to the default path and reopened with the same ID
			expect(existsSync(store.getSessionFile(channelId))).toBe(true);
			const restored = await store.getOrCreate(channelId);
			expect(restored.session.getSessionStats().sessionId).toBe(sessionId);
		});

		it("should resume a closed session by label", async () => {
			const channelId = "resume-by-label-channel";
			const sessionId = "resume-session-id-002";
			writeSessionFixture(channelId, sessionId);

			await store.getOrCreate(channelId);
			await store.closeAndNewSession(channelId, "my-label");

			expect(await store.resumeSession(channelId, "my-label")).toBe(true);

			const restored = await store.getOrCreate(channelId);
			expect(restored.session.getSessionStats().sessionId).toBe(sessionId);
		});

		it("should restore the conversation context on resume", async () => {
			const channelId = "resume-context-channel";
			const sessionId = "resume-session-id-003";
			writeSessionFixture(channelId, sessionId);

			await store.getOrCreate(channelId);
			await store.closeAndNewSession(channelId);

			expect(await store.resumeSession(channelId, sessionId)).toBe(true);

			const restored = await store.getOrCreate(channelId);
			const context = restored.session.sessionManager.buildSessionContext();
			expect(context.messages.length).toBeGreaterThanOrEqual(2);
			expect(messageText(context.messages[0])).toBe("Hello there");
			expect(messageText(context.messages[1])).toBe("Hi!");
		});

		it("should remove the entry from closed sessions after resume", async () => {
			const channelId = "resume-cleanup-channel";
			const sessionId = "resume-session-id-004";
			writeSessionFixture(channelId, sessionId);

			await store.getOrCreate(channelId);
			await store.closeAndNewSession(channelId);
			expect(store.getClosedSessions(channelId).length).toBe(1);

			expect(await store.resumeSession(channelId, sessionId)).toBe(true);
			expect(store.getClosedSessions(channelId)).toEqual([]);
		});

		it("should preserve cwd and model metadata across close and resume", async () => {
			const channelId = "resume-meta-channel";
			const sessionId = "resume-session-id-005";
			writeSessionFixture(channelId, sessionId);

			await store.getOrCreate(channelId);
			await store.changeCwd(channelId, "~/Projects/rotz");
			store.updateModel(channelId, "test-provider/test-model");
			await store.closeAndNewSession(channelId);

			expect(await store.resumeSession(channelId, sessionId)).toBe(true);

			const index = store.loadIndex();
			expect(index.sessions[channelId].cwd).toBe(join(homedir(), "Projects/rotz"));
			expect(index.sessions[channelId].model).toBe("test-provider/test-model");

			const restored = await store.getOrCreate(channelId);
			expect(restored.session.sessionManager.getCwd()).toBe(join(homedir(), "Projects/rotz"));
		});

		it("should return false for an unknown session ID or label", async () => {
			const channelId = "resume-unknown-channel";
			expect(await store.resumeSession(channelId, "does-not-exist")).toBe(false);
		});

		it("should clean up stale closed-session entries whose file is missing", async () => {
			const channelId = "resume-stale-channel";
			// Seed closed-sessions.json with an entry pointing at a nonexistent file
			writeFileSync(join(testDir, "closed-sessions.json"), JSON.stringify([{
				channelId,
				sessionId: "stale-session-id",
				sessionFile: join(testDir, "does-not-exist.jsonl"),
				sessionName: "discord-resume-stale-channel",
				closedAt: Date.now(),
			}]));

			expect(await store.resumeSession(channelId, "stale-session-id")).toBe(false);
			expect(store.getClosedSessions(channelId)).toEqual([]);
		});
	});

	describe("Session Fork", () => {
		/**
		 * Write a valid v3 session file (header + user + assistant message) at the
		 * channel's default path, so forkSession can snapshot it — mirroring a real
		 * persisted conversation.
		 */
		function writeSessionFixture(channelId: string, sessionId: string, cwd: string = "/tmp"): string {
			const path = store.getSessionFile(channelId);
			const ts = new Date().toISOString();
			const entries = [
				{ type: "session", version: 3, id: sessionId, timestamp: ts, cwd },
				{ type: "message", id: "msg-1", parentId: null, timestamp: ts, message: { role: "user", content: [{ type: "text", text: "Hello there" }] } },
				{ type: "message", id: "msg-2", parentId: "msg-1", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "Hi!" }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } },
			];
			writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
			return path;
		}

		it("should create a NEW session (new UUID) with the full history after fork", async () => {
			const channelId = "fork-context-channel";
			const sessionId = "fork-session-id-001";
			writeSessionFixture(channelId, sessionId);

			await store.getOrCreate(channelId);
			await store.forkSession(channelId);

			const forked = await store.getOrCreate(channelId);
			// New UUID: the fork is an independent session (pi's native fork),
			// while the original is preserved as a resumable snapshot
			expect(forked.session.getSessionStats().sessionId).not.toBe(sessionId);
			expect(store.getClosedSessions(channelId)[0].sessionId).toBe(sessionId);

			// Full history was copied into the new session
			const context = forked.session.sessionManager.buildSessionContext();
			expect(context.messages.length).toBeGreaterThanOrEqual(2);
			expect(messageText(context.messages[0])).toBe("Hello there");
			expect(messageText(context.messages[1])).toBe("Hi!");

			// The live file at the default path carries the NEW UUID so
			// restarts reopen the fork (not the pre-fork state)
			const header = JSON.parse(readFileSync(store.getSessionFile(channelId), "utf-8").split("\n")[0]);
			expect(header.id).toBe(forked.session.getSessionStats().sessionId);
		});

		it("should register the pre-fork state as a resumable snapshot", async () => {
			const channelId = "fork-snapshot-channel";
			const sessionId = "fork-session-id-002";
			writeSessionFixture(channelId, sessionId);

			await store.getOrCreate(channelId);
			await store.forkSession(channelId);

			const closed = store.getClosedSessions(channelId);
			expect(closed.length).toBe(1);
			expect(closed[0].sessionId).toBe(sessionId);
			expect(existsSync(closed[0].sessionFile)).toBe(true);

			// Snapshot is resumable and restores the original context
			expect(await store.resumeSession(channelId, sessionId)).toBe(true);
			const restored = await store.getOrCreate(channelId);
			expect(restored.session.getSessionStats().sessionId).toBe(sessionId);
			const context = restored.session.sessionManager.buildSessionContext();
			expect(context.messages.length).toBeGreaterThanOrEqual(2);
		});

		it("should fork with a label and resume by label", async () => {
			const channelId = "fork-label-channel";
			const sessionId = "fork-session-id-003";
			writeSessionFixture(channelId, sessionId);

			await store.getOrCreate(channelId);
			await store.forkSession(channelId, "pre-experiment");

			expect(store.getClosedSessions(channelId)[0].label).toBe("pre-experiment");
			expect(await store.resumeSession(channelId, "pre-experiment")).toBe(true);
		});

		it("should preserve cwd and model metadata across fork", async () => {
			const channelId = "fork-meta-channel";
			const sessionId = "fork-session-id-004";
			writeSessionFixture(channelId, sessionId);

			await store.getOrCreate(channelId);
			await store.changeCwd(channelId, "~/Projects/rotz");
			store.updateModel(channelId, "test-provider/test-model");
			await store.forkSession(channelId);

			const index = store.loadIndex();
			expect(index.sessions[channelId].cwd).toBe(join(homedir(), "Projects/rotz"));
			expect(index.sessions[channelId].model).toBe("test-provider/test-model");
		});

		it("should throw when there is no active session", async () => {
			await expect(store.forkSession("no-session-channel")).rejects.toThrow("No active session");
		});
	});

	describe("Session Reset", () => {
		it("should reset session messages when reset is called", async () => {
			const channelId = "reset-test-channel";

			// Create a session and add messages
			const discordSession = await store.getOrCreate(channelId);
			const { session } = discordSession;

			// Verify we have a session
			expect(session).toBeDefined();

			// Simulate adding messages (in real code this happens via session.prompt)
			session.messages.push(
				{ role: "user", content: "Hello" } as any,
				{ role: "assistant", content: "Hi there" } as any
			);

			// Verify messages were added
			expect(session.messages.length).toBeGreaterThan(0);

			// Call reset
			store.reset(channelId);

			// Verify messages were cleared
			expect(session.messages.length).toBe(0);
		});

		it("should update lastActivity when reset is called", async () => {
			const channelId = "reset-activity-channel";

			// Create a session
			const discordSession = await store.getOrCreate(channelId);
			const afterCreate = discordSession.lastActivity;

			// Wait a tiny bit to ensure time passes
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Capture time before reset
			const beforeReset = Date.now();

			// Reset the session
			store.reset(channelId);

			// Verify lastActivity was updated to a time >= beforeReset
			expect(discordSession.lastActivity).toBeGreaterThanOrEqual(beforeReset);
		});

		it("should not throw when resetting non-existent session", () => {
			// Should not throw even if channel doesn't exist
			expect(() => store.reset("non-existent-channel")).not.toThrow();
		});

		it("should keep session in memory after reset", async () => {
			const channelId = "reset-memory-channel";

			// Create a session
			await store.getOrCreate(channelId);
			expect(store.has(channelId)).toBe(true);

			// Reset
			store.reset(channelId);

			// Session should still be in memory
			expect(store.has(channelId)).toBe(true);
		});
	});
});

describe("Concurrent Session Creation", () => {
	const testDir = join(tmpdir(), `pi-discord-concurrent-${Date.now()}`);

	beforeEach(() => {
		if (!existsSync(testDir)) {
			mkdirSync(testDir, { recursive: true });
		}
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it("should only create one session when getOrCreate is called concurrently", async () => {
		const store = new SessionStore({ sessionDir: testDir, debug: false });
		const channelId = "concurrent-channel-test";

		// Track how many times createPiSession is called
		let createCount = 0;
		const originalCreate = store["createPiSession"].bind(store);
		(store as any)["createPiSession"] = async function (...args: Parameters<typeof originalCreate>) {
			createCount++;
			return originalCreate(...args);
		};

		// Call getOrCreate 5 times concurrently for the same channel
		const promises = Array(5).fill(null).map(() => store.getOrCreate(channelId));
		const sessions = await Promise.all(promises);

		// Should only have created ONE session
		expect(createCount).toBe(1);

		// All 5 calls should return the SAME session object
		const firstSession = sessions[0];
		for (const session of sessions) {
			expect(session).toBe(firstSession);
		}
	});

	it("should handle different channels independently", async () => {
		const store = new SessionStore({ sessionDir: testDir, debug: false });

		// Create sessions for different channels concurrently
		const results = await Promise.all([
			store.getOrCreate("channel-a"),
			store.getOrCreate("channel-b"),
			store.getOrCreate("channel-c"),
		]);

		// Each channel should have its own session
		expect(results[0].channelId).toBe("channel-a");
		expect(results[1].channelId).toBe("channel-b");
		expect(results[2].channelId).toBe("channel-c");

		// Sessions should be different objects
		expect(results[0]).not.toBe(results[1]);
		expect(results[0]).not.toBe(results[2]);
		expect(results[1]).not.toBe(results[2]);
	});
});

describe("Session Persistence Behavior", () => {
	/**
	 * These tests verify the core session persistence contract:
	 * 1. Session file paths are stored in the index
	 * 2. The index persists across store instances
	 * 3. Session files use consistent naming (not timestamps)
	 */

	it("should store session file paths in index", () => {
		const testDir = join(tmpdir(), `pi-discord-index-test-${Date.now()}`);

		if (!existsSync(testDir)) {
			mkdirSync(testDir, { recursive: true });
		}

		try {
			const store = new SessionStore({ sessionDir: testDir });
			const index = {
				sessions: {
					"test-channel": {
						channelId: "test-channel",
						sessionFile: join(testDir, "discord-test-channel.jsonl"),
						lastActivity: Date.now(),
					},
				},
			};

			store.saveIndex(index);

			// Verify by loading with a fresh store instance
			const freshStore = new SessionStore({ sessionDir: testDir });
			const loaded = freshStore.loadIndex();

			expect(loaded.sessions["test-channel"]).toBeDefined();
			expect(loaded.sessions["test-channel"].channelId).toBe("test-channel");
			expect(loaded.sessions["test-channel"].sessionFile).toContain("discord-test-channel.jsonl");
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("should preserve custom session file paths", () => {
		const testDir = join(tmpdir(), `pi-discord-custom-path-test-${Date.now()}`);

		if (!existsSync(testDir)) {
			mkdirSync(testDir, { recursive: true });
		}

		try {
			const customSessionPath = join(testDir, "my-custom-session-name.jsonl");
			const store = new SessionStore({ sessionDir: testDir });

			const index = {
				sessions: {
					"my-channel": {
						channelId: "my-channel",
						sessionFile: customSessionPath,
						lastActivity: Date.now(),
					},
				},
			};

			store.saveIndex(index);

			// Load and verify the stored path is preserved
			const freshStore = new SessionStore({ sessionDir: testDir });
			const loaded = freshStore.loadIndex();

			expect(loaded.sessions["my-channel"].sessionFile).toBe(customSessionPath);
			expect(loaded.sessions["my-channel"].sessionFile).not.toBe(
				join(testDir, "discord-my-channel.jsonl")
			);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("should use deterministic session file names (not timestamp-based)", () => {
		const testDir = join(tmpdir(), `pi-discord-deterministic-test-${Date.now()}`);

		if (!existsSync(testDir)) {
			mkdirSync(testDir, { recursive: true });
		}

		try {
			const channelId = "1489016529117904976";
			const store = new SessionStore({ sessionDir: testDir });

			// Get the session path
			const sessionPath = store.getSessionFile(channelId);

			// The path should contain the channel ID, not a timestamp
			expect(sessionPath).toContain(channelId);
			expect(sessionPath).toContain("discord-");
			expect(sessionPath).toContain(".jsonl");

			// The path should NOT contain a timestamp pattern (YYYY-MM-DD...)
			// Timestamps would look like 2026-04-01T...
			expect(sessionPath).not.toMatch(/20\d{2}-\d{2}-\d{2}T/);

			// Calling it again should return the same path
			const samePath = store.getSessionFile(channelId);
			expect(samePath).toBe(sessionPath);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("should allow multiple channels with unique session files", () => {
		const testDir = join(tmpdir(), `pi-discord-multi-test-${Date.now()}`);

		if (!existsSync(testDir)) {
			mkdirSync(testDir, { recursive: true });
		}

		try {
			const store = new SessionStore({ sessionDir: testDir });
			const channel1 = "channel-123";
			const channel2 = "channel-456";

			const path1 = store.getSessionFile(channel1);
			const path2 = store.getSessionFile(channel2);

			expect(path1).not.toBe(path2);
			expect(path1).toContain(channel1);
			expect(path2).toContain(channel2);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("should persist index across multiple store instances", () => {
		const testDir = join(tmpdir(), `pi-discord-persist-test-${Date.now()}`);

		if (!existsSync(testDir)) {
			mkdirSync(testDir, { recursive: true });
		}

		try {
			// Create first store and save data
			const store1 = new SessionStore({ sessionDir: testDir });
			store1.saveIndex({
				sessions: {
					"persist-channel": {
						channelId: "persist-channel",
						sessionFile: join(testDir, "discord-persist-channel.jsonl"),
						lastActivity: 1234567890,
					},
				},
			});

			// Create second store (simulating app restart) and verify data persists
			const store2 = new SessionStore({ sessionDir: testDir });
			const loaded = store2.loadIndex();

			expect(loaded.sessions["persist-channel"]).toBeDefined();
			expect(loaded.sessions["persist-channel"].lastActivity).toBe(1234567890);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});

describe("Legacy memory migration", () => {
	it("should adopt memory-<sessionId>.json sidecars into channel-memory-<channelId>.json on startup", () => {
		const testDir = join(tmpdir(), `pi-discord-memory-migrate-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });

		try {
			// A closed-session backup file whose session header carries the UUID
			// that the legacy sidecar is keyed on.
			writeFileSync(
				join(testDir, "discord-111222333-1785000000000.jsonl"),
				'{"type":"session","id":"legacy-session-abc","timestamp":"2026-08-01T00:00:00Z","cwd":"/tmp"}\n',
			);
			writeFileSync(
				join(testDir, "memory-legacy-session-abc.json"),
				JSON.stringify({ memory: "Legacy note", updatedAt: 100 }),
			);

			// Constructing the store triggers the migration.
			new SessionStore({ sessionDir: testDir });

			const channelFile = join(testDir, "channel-memory-111222333.json");
			expect(existsSync(channelFile)).toBe(true);
			const data = JSON.parse(readFileSync(channelFile, "utf-8"));
			expect(data.memory).toBe("Legacy note");

			// The legacy sidecar is left in place (never deleted).
			expect(existsSync(join(testDir, "memory-legacy-session-abc.json"))).toBe(true);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("should map sessions via closed-sessions.json too", () => {
		const testDir = join(tmpdir(), `pi-discord-memory-migrate2-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });

		try {
			writeFileSync(
				join(testDir, "closed-sessions.json"),
				JSON.stringify([
					{
						channelId: "444555666",
						sessionId: "closed-session-xyz",
						sessionFile: join(testDir, "discord-444555666-1785000000000.jsonl"),
					sessionName: "discord-444555666",
					closedAt: 1785000000000,
				},
			]),
			);
			writeFileSync(
				join(testDir, "memory-closed-session-xyz.json"),
				JSON.stringify({ memory: "Closed session memory", updatedAt: 100 }),
			);

			new SessionStore({ sessionDir: testDir });

			const channelFile = join(testDir, "channel-memory-444555666.json");
			expect(existsSync(channelFile)).toBe(true);
			const data = JSON.parse(readFileSync(channelFile, "utf-8"));
			expect(data.memory).toBe("Closed session memory");
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("should leave unmappable legacy sidecars untouched", () => {
		const testDir = join(tmpdir(), `pi-discord-memory-migrate3-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });

		try {
			writeFileSync(
				join(testDir, "memory-unknown-session.json"),
				JSON.stringify({ memory: "Orphaned", updatedAt: 100 }),
			);

			new SessionStore({ sessionDir: testDir });

			expect(existsSync(join(testDir, "memory-unknown-session.json"))).toBe(true);
			expect(existsSync(join(testDir, "channel-memory-unknown-session.json"))).toBe(false);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});

/**
 * Session Store Tests
 * Tests for the session persistence behavior
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../src/session-store";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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
		it("should apply maxRetries override and persist it through setModel", async () => {
			const channelId = "retry-test-channel";
			const discordSession = await store.getOrCreate(channelId);
			
			// Initial check (should be 10 from createPiSession)
			expect(discordSession.session.settingsManager.getRetrySettings().maxRetries).toBe(10);

			// Simulate setModel which re-applies overrides
			await discordSession.setModel("google", "gemma-4-31b-it");
			expect(discordSession.session.settingsManager.getRetrySettings().maxRetries).toBe(10);
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
		(store as any)["createPiSession"] = async function (...args: any[]) {
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

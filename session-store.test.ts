/**
 * Session Store Tests
 * Tests for the session persistence behavior
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "./session-store";
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

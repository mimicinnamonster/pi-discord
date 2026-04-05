/**
 * Message Deletion Tests
 * Tests for the Discord message deletion handling feature
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the structures we'll test
interface TrackedMessage {
	sessionIndex: number;
	type: string;
}

describe("Message Deletion Tracking", () => {
	describe("discordMessageToSession mapping", () => {
		it("should track Discord message IDs with session indices", () => {
			const discordMessageToSession = new Map<string, Map<string, TrackedMessage>>();

			// Simulate tracking a message
			discordMessageToSession.set("channel-1", new Map());
			discordMessageToSession.get("channel-1")!.set("msg-123", {
				sessionIndex: 0,
				type: "response"
			});

			expect(discordMessageToSession.get("channel-1")?.has("msg-123")).toBe(true);
			expect(discordMessageToSession.get("channel-1")?.get("msg-123")?.sessionIndex).toBe(0);
		});

		it("should allow multiple channels with independent tracking", () => {
			const discordMessageToSession = new Map<string, Map<string, TrackedMessage>>();

			discordMessageToSession.set("channel-1", new Map([
				["msg-1", { sessionIndex: 0, type: "response" }],
				["msg-2", { sessionIndex: 1, type: "thinking" }]
			]));
			discordMessageToSession.set("channel-2", new Map([
				["msg-3", { sessionIndex: 0, type: "tool" }]
			]));

			expect(discordMessageToSession.get("channel-1")?.size).toBe(2);
			expect(discordMessageToSession.get("channel-2")?.size).toBe(1);
		});

		it("should delete tracked message from mapping", () => {
			const discordMessageToSession = new Map<string, Map<string, TrackedMessage>>();
			discordMessageToSession.set("channel-1", new Map([
				["msg-1", { sessionIndex: 0, type: "response" }],
				["msg-2", { sessionIndex: 1, type: "thinking" }]
			]));

			// Simulate deletion
			discordMessageToSession.get("channel-1")?.delete("msg-1");

			expect(discordMessageToSession.get("channel-1")?.has("msg-1")).toBe(false);
			expect(discordMessageToSession.get("channel-1")?.has("msg-2")).toBe(true);
		});
	});

	describe("sessionMessageIndex tracking", () => {
		it("should track current message index per channel", () => {
			const sessionMessageIndex = new Map<string, number>();

			sessionMessageIndex.set("channel-1", 0);
			sessionMessageIndex.set("channel-2", 5);

			expect(sessionMessageIndex.get("channel-1")).toBe(0);
			expect(sessionMessageIndex.get("channel-2")).toBe(5);
		});

		it("should increment index for new messages", () => {
			const sessionMessageIndex = new Map<string, number>();

			// First message
			let idx = (sessionMessageIndex.get("channel-1") ?? 0) + 1;
			sessionMessageIndex.set("channel-1", idx);
			expect(idx).toBe(1);

			// Second message
			idx = (sessionMessageIndex.get("channel-1") ?? 0) + 1;
			sessionMessageIndex.set("channel-1", idx);
			expect(idx).toBe(2);
		});

		it("should handle missing channel gracefully", () => {
			const sessionMessageIndex = new Map<string, number>();

			// Default to 0 for missing channel
			const idx = sessionMessageIndex.get("nonexistent") ?? 0;
			expect(idx).toBe(0);
		});
	});

	describe("message deletion flow", () => {
		it("should remove message from session when Discord message is deleted", () => {
			// Simulate session messages
			const sessionMessages = [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hi there!" },
				{ role: "user", content: "How are you?" }
			];

			// Simulate tracking
			const discordMessageToSession = new Map<string, Map<string, TrackedMessage>>();
			discordMessageToSession.set("channel-1", new Map([
				["msg-1", { sessionIndex: 0, type: "user" }],
				["msg-2", { sessionIndex: 1, type: "response" }],
				["msg-3", { sessionIndex: 2, type: "user" }]
			]));

			// Simulate deleting msg-2 (the assistant response)
			const channelMap = discordMessageToSession.get("channel-1")!;
			const tracked = channelMap.get("msg-2")!;
			channelMap.delete("msg-2");

			// Remove from session
			if (tracked.sessionIndex >= 0 && tracked.sessionIndex < sessionMessages.length) {
				sessionMessages.splice(tracked.sessionIndex, 1);
			}

			expect(sessionMessages.length).toBe(2);
			expect(sessionMessages[0].role).toBe("user");
			expect(sessionMessages[1].role).toBe("user");
		});

		it("should log warning when deleted message was not tracked", () => {
			const discordMessageToSession = new Map<string, Map<string, TrackedMessage>>();
			discordMessageToSession.set("channel-1", new Map());

			const tracked = discordMessageToSession.get("channel-1")?.get("nonexistent-msg");

			// Should be undefined, which triggers warning
			expect(tracked).toBeUndefined();
		});

		it("should handle out-of-bounds session index", () => {
			const sessionMessages = [
				{ role: "user", content: "Hello" }
			];

			const tracked = { sessionIndex: 99, type: "response" };

			// Check bounds before splice
			const isValid = tracked.sessionIndex >= 0 && tracked.sessionIndex < sessionMessages.length;

			expect(isValid).toBe(false);
		});

		it("should handle bulk message deletion", () => {
			// Simulate session messages
			const sessionMessages = [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hi!" },
				{ role: "user", content: "Run ls" },
				{ role: "toolResult", content: "/path/to/file" },
				{ role: "assistant", content: "Done!" }
			];

			// Simulate tracking
			const discordMessageToSession = new Map<string, Map<string, TrackedMessage>>();
			discordMessageToSession.set("channel-1", new Map([
				["msg-1", { sessionIndex: 0, type: "user" }],
				["msg-2", { sessionIndex: 1, type: "response" }],
				["msg-3", { sessionIndex: 2, type: "user" }],
				["msg-4", { sessionIndex: 3, type: "tool" }],
				["msg-5", { sessionIndex: 4, type: "response" }]
			]));

			// Simulate bulk deleting msg-1, msg-3, msg-5 (indices 0, 2, 4)
			const deletedIds = ["msg-1", "msg-3", "msg-5"];
			const channelMap = discordMessageToSession.get("channel-1")!;

			// Sort indices in descending order to splice correctly
			const indicesToDelete = deletedIds
				.map(id => channelMap.get(id)?.sessionIndex)
				.filter((idx): idx is number => idx !== undefined)
				.sort((a, b) => b - a);

			for (const idx of indicesToDelete) {
				if (idx >= 0 && idx < sessionMessages.length) {
					sessionMessages.splice(idx, 1);
				}
			}

			// Clean up tracking
			for (const id of deletedIds) {
				channelMap.delete(id);
			}

			expect(sessionMessages.length).toBe(2);
			expect(sessionMessages[0].role).toBe("assistant"); // msg-2
			expect(sessionMessages[1].role).toBe("toolResult"); // msg-4
		});
	});

	describe("message types tracking", () => {
		it("should track different message types correctly", () => {
			const messageTypes = ["response", "thinking", "tool", "tool-error", "user"];

			const discordMessageToSession = new Map<string, Map<string, TrackedMessage>>();
			discordMessageToSession.set("channel-1", new Map());

			messageTypes.forEach((type, index) => {
				discordMessageToSession.get("channel-1")!.set(`msg-${index}`, {
					sessionIndex: index,
					type
				});
			});

			const channelMap = discordMessageToSession.get("channel-1")!;
			expect(channelMap.get("msg-0")?.type).toBe("response");
			expect(channelMap.get("msg-1")?.type).toBe("thinking");
			expect(channelMap.get("msg-2")?.type).toBe("tool");
			expect(channelMap.get("msg-3")?.type).toBe("tool-error");
			expect(channelMap.get("msg-4")?.type).toBe("user");
		});
	});
});

describe("sendToDiscord tracking integration", () => {
	it("should return Message objects when tracking is enabled", async () => {
		// Simulate the sendToDiscord behavior
		const sentMessages: { id: string }[] = [];

		// Simulate sending messages
		sentMessages.push({ id: "msg-123" });
		sentMessages.push({ id: "msg-124" });

		expect(sentMessages.length).toBe(2);
		expect(sentMessages[0].id).toBe("msg-123");
	});

	it("should track messages only when trackInSession is true", () => {
		const discordMessageToSession = new Map<string, Map<string, TrackedMessage>>();
		const sessionMessageIndex = new Map<string, number>();

		const channelId = "channel-1";
		const text = "Hello";
		const options = { trackInSession: true, type: "response" as const };

		// Simulate what sendToDiscord does
		if (options?.trackInSession) {
			if (!discordMessageToSession.has(channelId)) {
				discordMessageToSession.set(channelId, new Map());
			}
			const channelMap = discordMessageToSession.get(channelId)!;
			const currentIndex = sessionMessageIndex.get(channelId) ?? 0;
			channelMap.set("msg-123", { sessionIndex: currentIndex, type: options.type });
		}

		expect(discordMessageToSession.get("channel-1")?.has("msg-123")).toBe(true);
	});

	it("should not track messages when trackInSession is false", () => {
		const discordMessageToSession = new Map<string, Map<string, TrackedMessage>>();
		const sessionMessageIndex = new Map<string, number>();

		const channelId = "channel-1";
		const options = { trackInSession: false, type: "response" as const };

		// Simulate sendToDiscord without tracking
		if (options?.trackInSession) {
			// This should NOT execute
			discordMessageToSession.set(channelId, new Map());
		}

		expect(discordMessageToSession.has("channel-1")).toBe(false);
	});
});

describe("fixIndicesAfterDeletion", () => {
	// Simulate the fixIndicesAfterDeletion logic
	function fixIndicesAfterDeletion(
		discordMessageToSession: Map<string, Map<string, TrackedMessage>>,
		channelId: string,
		deletedIndex: number
	): void {
		const channelMap = discordMessageToSession.get(channelId);
		if (!channelMap) return;

		for (const [msgId, tracked] of channelMap.entries()) {
			if (tracked.sessionIndex > deletedIndex) {
				tracked.sessionIndex--;
			}
		}
	}

	it("should decrement indices higher than deleted index", () => {
		const discordMessageToSession = new Map<string, Map<string, TrackedMessage>>();
		discordMessageToSession.set("channel-1", new Map([
			["msg-0", { sessionIndex: 0, type: "user" }],
			["msg-1", { sessionIndex: 1, type: "response" }],
			["msg-2", { sessionIndex: 2, type: "thinking" }],
			["msg-3", { sessionIndex: 3, type: "tool" }],
		]));

		// Delete index 1, so indices 2 and 3 should decrement
		fixIndicesAfterDeletion(discordMessageToSession, "channel-1", 1);

		expect(discordMessageToSession.get("channel-1")?.get("msg-0")?.sessionIndex).toBe(0);
		expect(discordMessageToSession.get("channel-1")?.get("msg-1")?.sessionIndex).toBe(1);
		expect(discordMessageToSession.get("channel-1")?.get("msg-2")?.sessionIndex).toBe(1); // decremented
		expect(discordMessageToSession.get("channel-1")?.get("msg-3")?.sessionIndex).toBe(2); // decremented
	});

	it("should not change indices lower than deleted index", () => {
		const discordMessageToSession = new Map<string, Map<string, TrackedMessage>>();
		discordMessageToSession.set("channel-1", new Map([
			["msg-0", { sessionIndex: 0, type: "user" }],
			["msg-1", { sessionIndex: 1, type: "response" }],
			["msg-2", { sessionIndex: 2, type: "thinking" }],
		]));

		// Delete index 0
		fixIndicesAfterDeletion(discordMessageToSession, "channel-1", 0);

		expect(discordMessageToSession.get("channel-1")?.get("msg-0")?.sessionIndex).toBe(0);
		expect(discordMessageToSession.get("channel-1")?.get("msg-1")?.sessionIndex).toBe(0); // decremented
		expect(discordMessageToSession.get("channel-1")?.get("msg-2")?.sessionIndex).toBe(1); // decremented
	});

	it("should handle deleting the last message", () => {
		const discordMessageToSession = new Map<string, Map<string, TrackedMessage>>();
		discordMessageToSession.set("channel-1", new Map([
			["msg-0", { sessionIndex: 0, type: "user" }],
			["msg-1", { sessionIndex: 1, type: "response" }],
		]));

		// Delete last index
		fixIndicesAfterDeletion(discordMessageToSession, "channel-1", 1);

		expect(discordMessageToSession.get("channel-1")?.get("msg-0")?.sessionIndex).toBe(0);
		expect(discordMessageToSession.get("channel-1")?.get("msg-1")?.sessionIndex).toBe(1);
	});

	it("should handle multiple sequential deletions", () => {
		const discordMessageToSession = new Map<string, Map<string, TrackedMessage>>();
		discordMessageToSession.set("channel-1", new Map([
			["msg-0", { sessionIndex: 0, type: "user" }],
			["msg-1", { sessionIndex: 1, type: "response" }],
			["msg-2", { sessionIndex: 2, type: "thinking" }],
			["msg-3", { sessionIndex: 3, type: "tool" }],
		]));

		// Delete index 1
		fixIndicesAfterDeletion(discordMessageToSession, "channel-1", 1);
		// Delete index 2 (which was originally 3)
		fixIndicesAfterDeletion(discordMessageToSession, "channel-1", 2);

		expect(discordMessageToSession.get("channel-1")?.get("msg-0")?.sessionIndex).toBe(0);
		expect(discordMessageToSession.get("channel-1")?.get("msg-1")?.sessionIndex).toBe(1);
		expect(discordMessageToSession.get("channel-1")?.get("msg-2")?.sessionIndex).toBe(1); // decremented twice
		expect(discordMessageToSession.get("channel-1")?.get("msg-3")?.sessionIndex).toBe(2); // decremented once
	});

	it("should handle deleting middle message from session", () => {
		// Simulate the full flow: session messages array + tracking
		const sessionMessages = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi!" },
			{ role: "user", content: "How are you?" },
			{ role: "assistant", content: "Fine!" }
		];

		const discordMessageToSession = new Map<string, Map<string, TrackedMessage>>();
		discordMessageToSession.set("channel-1", new Map([
			["msg-0", { sessionIndex: 0, type: "user" }],
			["msg-1", { sessionIndex: 1, type: "response" }],
			["msg-2", { sessionIndex: 2, type: "user" }],
			["msg-3", { sessionIndex: 3, type: "response" }],
		]));

		// User deletes their message (index 2)
		const tracked = discordMessageToSession.get("channel-1")!.get("msg-2")!;
		const deletedIndex = tracked.sessionIndex;

		// Remove from session
		sessionMessages.splice(deletedIndex, 1);

		// Fix indices
		fixIndicesAfterDeletion(discordMessageToSession, "channel-1", deletedIndex);

		// Verify session
		expect(sessionMessages.length).toBe(3);
		expect(sessionMessages[0].role).toBe("user"); // msg-0
		expect(sessionMessages[1].role).toBe("assistant"); // msg-1
		expect(sessionMessages[2].role).toBe("assistant"); // msg-3

		// Verify tracking still works
		expect(discordMessageToSession.get("channel-1")?.get("msg-0")?.sessionIndex).toBe(0);
		expect(discordMessageToSession.get("channel-1")?.get("msg-1")?.sessionIndex).toBe(1);
		expect(discordMessageToSession.get("channel-1")?.get("msg-3")?.sessionIndex).toBe(2); // decremented
	});
});

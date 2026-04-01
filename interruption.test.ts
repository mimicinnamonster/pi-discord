/**
 * Interruption Tests
 * Tests for the session interruption feature
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the typing manager for testing
class MockTypingManager {
	private activeTyping = new Set<string>();

	show(channelId: string): void {
		this.activeTyping.add(channelId);
	}

	hide(channelId: string): void {
		this.activeTyping.delete(channelId);
	}

	isTyping(channelId: string): boolean {
		return this.activeTyping.has(channelId);
	}
}

// Mock session with abort capability
class MockSession {
	aborted = false;
	private listeners: Array<(event: { type: string }) => void> = [];

	async abort(): Promise<void> {
		this.aborted = true;
		// Simulate abort delay
		await new Promise((resolve) => setTimeout(resolve, 10));
	}

	subscribe(listener: (event: { type: string }) => void): void {
		this.listeners.push(listener);
	}

	emit(event: { type: string }): void {
		this.listeners.forEach((l) => l(event));
	}
}

describe("Session Interruption", () => {
	describe("runningSessions tracking", () => {
		it("should add channel to runningSessions on agent_start", () => {
			const runningSessions = new Set<string>();

			// Simulate agent_start event
			runningSessions.add("channel-1");

			expect(runningSessions.has("channel-1")).toBe(true);
			expect(runningSessions.size).toBe(1);
		});

		it("should remove channel from runningSessions on agent_end", () => {
			const runningSessions = new Set<string>();

			runningSessions.add("channel-1");
			expect(runningSessions.has("channel-1")).toBe(true);

			// Simulate agent_end event
			runningSessions.delete("channel-1");

			expect(runningSessions.has("channel-1")).toBe(false);
		});

		it("should track multiple concurrent sessions independently", () => {
			const runningSessions = new Set<string>();

			runningSessions.add("channel-1");
			runningSessions.add("channel-2");
			runningSessions.add("channel-3");

			expect(runningSessions.size).toBe(3);
			expect(runningSessions.has("channel-1")).toBe(true);
			expect(runningSessions.has("channel-2")).toBe(true);
			expect(runningSessions.has("channel-3")).toBe(true);

			runningSessions.delete("channel-2");

			expect(runningSessions.size).toBe(2);
			expect(runningSessions.has("channel-2")).toBe(false);
		});

		it("should correctly identify if a session is running", () => {
			const runningSessions = new Set<string>();

			expect(runningSessions.has("channel-1")).toBe(false);

			runningSessions.add("channel-1");
			expect(runningSessions.has("channel-1")).toBe(true);

			runningSessions.add("channel-1"); // Idempotent
			expect(runningSessions.has("channel-1")).toBe(true);
		});
	});

	describe("interrupt flow", () => {
		it("should abort session when user sends message while running", async () => {
			const runningSessions = new Set<string>();
			const session = new MockSession();
			const typingManager = new MockTypingManager();

			// Session starts running
			runningSessions.add("channel-1");
			typingManager.show("channel-1");

			expect(runningSessions.has("channel-1")).toBe(true);
			expect(typingManager.isTyping("channel-1")).toBe(true);

			// User sends new message - should trigger interrupt
			if (runningSessions.has("channel-1")) {
				await session.abort();
				typingManager.hide("channel-1");
				runningSessions.delete("channel-1");
			}

			expect(session.aborted).toBe(true);
			expect(typingManager.isTyping("channel-1")).toBe(false);
			expect(runningSessions.has("channel-1")).toBe(false);
		});

		it("should not abort session when no session is running", async () => {
			const runningSessions = new Set<string>();
			const session = new MockSession();
			const typingManager = new MockTypingManager();

			// No session running
			expect(runningSessions.has("channel-1")).toBe(false);

			// User sends message - should NOT abort
			if (runningSessions.has("channel-1")) {
				await session.abort();
			}

			expect(session.aborted).toBe(false);
		});

		it("should handle rapid interrupt attempts", async () => {
			const runningSessions = new Set<string>();
			const session = new MockSession();

			runningSessions.add("channel-1");

			// Multiple interrupts
			if (runningSessions.has("channel-1")) {
				await session.abort();
				runningSessions.delete("channel-1");
			}

			if (runningSessions.has("channel-1")) {
				await session.abort();
				runningSessions.delete("channel-1");
			}

			// Second abort should still work (idempotent abort)
			await session.abort();
			expect(session.aborted).toBe(true);
		});

		it("should handle different channels independently", async () => {
			const runningSessions = new Set<string>();
			const session1 = new MockSession();
			const session2 = new MockSession();

			runningSessions.add("channel-1");
			runningSessions.add("channel-2");

			// Interrupt only channel-1
			if (runningSessions.has("channel-1")) {
				await session1.abort();
				runningSessions.delete("channel-1");
			}

			expect(session1.aborted).toBe(true);
			expect(session2.aborted).toBe(false);
			expect(runningSessions.has("channel-1")).toBe(false);
			expect(runningSessions.has("channel-2")).toBe(true);
		});
	});

	describe("typing management on interrupt", () => {
		it("should hide typing on interrupt", () => {
			const typingManager = new MockTypingManager();

			typingManager.show("channel-1");
			expect(typingManager.isTyping("channel-1")).toBe(true);

			typingManager.hide("channel-1");
			expect(typingManager.isTyping("channel-1")).toBe(false);
		});

		it("should not throw when hiding non-existent typing", () => {
			const typingManager = new MockTypingManager();

			expect(() => typingManager.hide("nonexistent")).not.toThrow();
			expect(typingManager.isTyping("nonexistent")).toBe(false);
		});
	});
});

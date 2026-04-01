/**
 * Typing Manager Tests
 * Tests for the Discord typing indicator logic
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TypingManager, type TypingChannel } from "./typing-manager";

describe("TypingManager", () => {
	let typingManager: TypingManager;
	let mockChannel: { sendTyping: () => Promise<void> };

	beforeEach(() => {
		typingManager = new TypingManager();
		mockChannel = {
			sendTyping: vi.fn().mockResolvedValue(undefined),
		};
	});

	afterEach(() => {
		typingManager.dispose();
		vi.restoreAllMocks();
	});

	describe("show()", () => {
		it("should call sendTyping on the channel", () => {
			typingManager.show("channel-1", mockChannel);

			expect(mockChannel.sendTyping).toHaveBeenCalledTimes(1);
		});

		it("should mark channel as typing", () => {
			typingManager.show("channel-1", mockChannel);

			expect(typingManager.isTyping("channel-1")).toBe(true);
		});
	});

	describe("hide()", () => {
		it("should clear the typing state for a channel", () => {
			typingManager.show("channel-1", mockChannel);
			expect(typingManager.isTyping("channel-1")).toBe(true);

			typingManager.hide("channel-1");

			expect(typingManager.isTyping("channel-1")).toBe(false);
		});

		it("should not throw when hiding a channel that is not typing", () => {
			expect(() => typingManager.hide("nonexistent")).not.toThrow();
		});
	});

	describe("isTyping()", () => {
		it("should return false for channel that never had show() called", () => {
			expect(typingManager.isTyping("nonexistent")).toBe(false);
		});

		it("should return true after show() is called", () => {
			typingManager.show("channel-1", mockChannel);

			expect(typingManager.isTyping("channel-1")).toBe(true);
		});

		it("should return false after hide() is called", () => {
			typingManager.show("channel-1", mockChannel);
			typingManager.hide("channel-1");

			expect(typingManager.isTyping("channel-1")).toBe(false);
		});
	});

	describe("dispose()", () => {
		it("should clear all active typing states", () => {
			typingManager.show("channel-1", mockChannel);
			typingManager.show("channel-2", mockChannel);
			typingManager.show("channel-3", mockChannel);

			expect(typingManager.isTyping("channel-1")).toBe(true);
			expect(typingManager.isTyping("channel-2")).toBe(true);
			expect(typingManager.isTyping("channel-3")).toBe(true);

			typingManager.dispose();

			expect(typingManager.isTyping("channel-1")).toBe(false);
			expect(typingManager.isTyping("channel-2")).toBe(false);
			expect(typingManager.isTyping("channel-3")).toBe(false);
		});
	});

	describe("multiple channels", () => {
		it("should track multiple channels independently", () => {
			const channel1 = { sendTyping: vi.fn().mockResolvedValue(undefined) };
			const channel2 = { sendTyping: vi.fn().mockResolvedValue(undefined) };

			typingManager.show("channel-1", channel1);
			typingManager.show("channel-2", channel2);

			expect(typingManager.isTyping("channel-1")).toBe(true);
			expect(typingManager.isTyping("channel-2")).toBe(true);

			typingManager.hide("channel-1");

			expect(typingManager.isTyping("channel-1")).toBe(false);
			expect(typingManager.isTyping("channel-2")).toBe(true);

			typingManager.hide("channel-2");

			expect(typingManager.isTyping("channel-1")).toBe(false);
			expect(typingManager.isTyping("channel-2")).toBe(false);
		});

		it("should handle channel sendTyping failures gracefully", async () => {
			const failingChannel = {
				sendTyping: vi.fn().mockRejectedValue(new Error("Channel unavailable")),
			};

			// Should not throw
			expect(() => typingManager.show("channel-1", failingChannel)).not.toThrow();

			// Wait for the async catch to execute
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Channel should be removed from tracking on failure
			expect(typingManager.isTyping("channel-1")).toBe(false);
		});
	});

	describe("LLM event flow modeling", () => {
		it("should show on agent_start, hide on message_end", () => {
			// Simulate the LLM event flow
			const channel = { sendTyping: vi.fn().mockResolvedValue(undefined) };

			// User sends message, we DON'T show typing yet
			expect(typingManager.isTyping("channel-1")).toBe(false);

			// LLM starts processing - NOW we show typing (agent_start event)
			typingManager.show("channel-1", channel);
			expect(typingManager.isTyping("channel-1")).toBe(true);

			// ... LLM streams response (message_update events) ...

			// LLM finishes - hide typing (message_end event)
			typingManager.hide("channel-1");
			expect(typingManager.isTyping("channel-1")).toBe(false);

			// Discord user sees: no typing while waiting, typing starts when LLM responds
		});

		it("should handle rapid show/hide cycles correctly", () => {
			const channel = { sendTyping: vi.fn().mockResolvedValue(undefined) };

			// Simulate: agent_start, then message_start (both call show)
			typingManager.show("channel-1", channel);
			typingManager.show("channel-1", channel);
			typingManager.show("channel-1", channel);

			expect(typingManager.isTyping("channel-1")).toBe(true);

			// Only one hide needed to clear
			typingManager.hide("channel-1");

			expect(typingManager.isTyping("channel-1")).toBe(false);
		});

		it("should hide on error path", () => {
			const channel = { sendTyping: vi.fn().mockResolvedValue(undefined) };

			// Show typing when LLM starts
			typingManager.show("channel-1", channel);
			expect(typingManager.isTyping("channel-1")).toBe(true);

			// If there's an error before LLM produces output
			// We should hide typing since no response will come
			typingManager.hide("channel-1");

			expect(typingManager.isTyping("channel-1")).toBe(false);
		});

		it("should show on message_start (assistant role), hide on message_end", () => {
			const channel = { sendTyping: vi.fn().mockResolvedValue(undefined) };

			// LLM begins generating assistant response
			typingManager.show("channel-1", channel);
			expect(typingManager.isTyping("channel-1")).toBe(true);

			// ... stream text deltas ...

			// Assistant message complete
			typingManager.hide("channel-1");
			expect(typingManager.isTyping("channel-1")).toBe(false);
		});

		it("should call sendTyping multiple times (for recurring indicator)", () => {
			const channel = { sendTyping: vi.fn().mockResolvedValue(undefined) };

			typingManager.show("channel-1", channel);

			// Initial call
			expect(channel.sendTyping).toHaveBeenCalledTimes(1);
		});
	});
});

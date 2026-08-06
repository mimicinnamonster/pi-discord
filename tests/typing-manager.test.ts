import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TypingManager } from "../src/typing-manager";

describe("TypingManager", () => {
	let typingManager: TypingManager;
	let mockChannel: { triggerTyping: () => Promise<boolean> };

	beforeEach(() => {
		typingManager = new TypingManager();
		mockChannel = {
			triggerTyping: vi.fn().mockResolvedValue(true),
		};
	});

	afterEach(() => {
		typingManager.dispose();
	});

	describe("show()", () => {
		it("should call triggerTyping on first show", () => {
			typingManager.show("channel-1", mockChannel);
			expect(mockChannel.triggerTyping).toHaveBeenCalledTimes(1);
		});

		it("should mark channel as typing", () => {
			typingManager.show("channel-1", mockChannel);
			expect(typingManager.isTyping("channel-1")).toBe(true);
		});

		it("should be idempotent — second show() does not call triggerTyping again", () => {
			typingManager.show("channel-1", mockChannel);
			typingManager.show("channel-1", mockChannel);
			expect(mockChannel.triggerTyping).toHaveBeenCalledTimes(1);
		});

		it("should re-activate after hide()", () => {
			typingManager.show("channel-1", mockChannel);
			typingManager.hide("channel-1");
			typingManager.show("channel-1", mockChannel);
			expect(mockChannel.triggerTyping).toHaveBeenCalledTimes(2);
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
			expect(() => typingManager.hide("channel-1")).not.toThrow();
		});
	});

	describe("isTyping()", () => {
		it("should return false for channel that never had show() called", () => {
			expect(typingManager.isTyping("channel-1")).toBe(false);
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

	describe("renewal (keep typing alive during long operations)", () => {
		it("should re-trigger typing periodically while active", () => {
			vi.useFakeTimers();
			try {
				typingManager.show("channel-1", mockChannel);
				expect(mockChannel.triggerTyping).toHaveBeenCalledTimes(1);

				vi.advanceTimersByTime(7_000);
				expect(mockChannel.triggerTyping).toHaveBeenCalledTimes(2);

				vi.advanceTimersByTime(14_000);
				expect(mockChannel.triggerTyping).toHaveBeenCalledTimes(4);
			} finally {
				vi.useRealTimers();
			}
		});

		it("should stop re-triggering after hide()", () => {
			vi.useFakeTimers();
			try {
				typingManager.show("channel-1", mockChannel);
				typingManager.hide("channel-1");

				vi.advanceTimersByTime(30_000);
				expect(mockChannel.triggerTyping).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it("should not re-trigger for a channel that was never shown", () => {
			vi.useFakeTimers();
			try {
				vi.advanceTimersByTime(30_000);
				expect(mockChannel.triggerTyping).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it("should keep renewing through show() refreshes without double-triggering", () => {
			vi.useFakeTimers();
			try {
				typingManager.show("channel-1", mockChannel);
				// Repeated show() calls (events during a turn) must not fire extra requests
				typingManager.show("channel-1", mockChannel);
				typingManager.show("channel-1", mockChannel);
				expect(mockChannel.triggerTyping).toHaveBeenCalledTimes(1);

				vi.advanceTimersByTime(7_000);
				expect(mockChannel.triggerTyping).toHaveBeenCalledTimes(2);
			} finally {
				vi.useRealTimers();
			}
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
			const channel1 = { triggerTyping: vi.fn().mockResolvedValue(true) };
			const channel2 = { triggerTyping: vi.fn().mockResolvedValue(true) };

			typingManager.show("channel-1", channel1);
			typingManager.show("channel-2", channel2);

			expect(typingManager.isTyping("channel-1")).toBe(true);
			expect(typingManager.isTyping("channel-2")).toBe(true);

			typingManager.hide("channel-1");
			expect(typingManager.isTyping("channel-1")).toBe(false);
			expect(typingManager.isTyping("channel-2")).toBe(true);
		});
	});

	describe("event flow coverage", () => {
		it("should handle show -> hide -> show cycles", () => {
			typingManager.show("channel-1", mockChannel);
			expect(typingManager.isTyping("channel-1")).toBe(true);
			typingManager.hide("channel-1");
			expect(typingManager.isTyping("channel-1")).toBe(false);
			typingManager.show("channel-1", mockChannel);
			expect(typingManager.isTyping("channel-1")).toBe(true);
		});

		it("should handle rapid show calls (thinking_delta spam)", () => {
			typingManager.show("channel-1", mockChannel);
			typingManager.show("channel-1", mockChannel);
			typingManager.show("channel-1", mockChannel);
			typingManager.show("channel-1", mockChannel);
			// Only one triggerTyping call
			expect(mockChannel.triggerTyping).toHaveBeenCalledTimes(1);
		});
	});
});

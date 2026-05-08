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
		it("should call triggerTyping on the channel once for first show", () => {
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
			// triggerTyping only called once — second show() is a no-op
			expect(mockChannel.triggerTyping).toHaveBeenCalledTimes(1);
		});

		it("should re-activate after hide()", () => {
			typingManager.show("channel-1", mockChannel);
			typingManager.hide("channel-1");
			const callCount = mockChannel.triggerTyping.mock.calls.length;
			typingManager.show("channel-1", mockChannel);
			expect(mockChannel.triggerTyping).toHaveBeenCalledTimes(callCount + 1);
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

		it("should keep typing active even when triggerTyping fails", async () => {
			const failingChannel = {
				triggerTyping: vi.fn().mockRejectedValue(new Error("Channel unavailable")),
			};

			typingManager.show("channel-1", failingChannel);

			// Even if triggerTyping fails, the channel should be marked as typing
			expect(typingManager.isTyping("channel-1")).toBe(true);

			// Wait for the initial triggerTyping catch to execute
			await vi.waitFor(() => {
				expect(failingChannel.triggerTyping).toHaveBeenCalled();
			});
		});
	});

	describe("LLM event flow modeling", () => {
		it("should show on agent_start, hide on message_end", () => {
			const channel = { triggerTyping: vi.fn().mockResolvedValue(true) };
			typingManager.show("channel-1", channel);
			expect(typingManager.isTyping("channel-1")).toBe(true);
			typingManager.hide("channel-1");
			expect(typingManager.isTyping("channel-1")).toBe(false);
		});

		it("should handle rapid show/hide cycles correctly", () => {
			const channel = { triggerTyping: vi.fn().mockResolvedValue(true) };
			// Multiple rapid show/hide
			typingManager.show("channel-1", channel);
			typingManager.hide("channel-1");
			typingManager.show("channel-1", channel);
			typingManager.hide("channel-1");
			typingManager.show("channel-1", channel);
			expect(typingManager.isTyping("channel-1")).toBe(true);
		});

		it("should hide on error path", () => {
			const channel = { triggerTyping: vi.fn().mockResolvedValue(true) };
			typingManager.show("channel-1", channel);
			typingManager.hide("channel-1");
			expect(typingManager.isTyping("channel-1")).toBe(false);
		});

		it("should show on message_start (assistant role), hide on message_end", () => {
			const channel = { triggerTyping: vi.fn().mockResolvedValue(true) };
			typingManager.show("channel-1", channel);
			expect(typingManager.isTyping("channel-1")).toBe(true);
			typingManager.hide("channel-1");
			expect(typingManager.isTyping("channel-1")).toBe(false);
		});
	});

	describe("thinking_delta event flow", () => {
		it("should show typing indicator on thinking_delta", () => {
			const channel = { triggerTyping: vi.fn().mockResolvedValue(true) };
			typingManager.show("channel-1", channel);
			expect(typingManager.isTyping("channel-1")).toBe(true);
		});

		it("should keep typing visible through thinking until message_end", () => {
			const channel = { triggerTyping: vi.fn().mockResolvedValue(true) };
			typingManager.show("channel-1", channel);
			typingManager.show("channel-1", channel); // thinking_delta
			expect(typingManager.isTyping("channel-1")).toBe(true);
			typingManager.hide("channel-1");
			expect(typingManager.isTyping("channel-1")).toBe(false);
		});

		it("should transition from thinking to message without losing typing", () => {
			const channel = { triggerTyping: vi.fn().mockResolvedValue(true) };
			typingManager.show("channel-1", channel); // thinking_delta
			typingManager.show("channel-1", channel); // message_start (already active)
			expect(typingManager.isTyping("channel-1")).toBe(true);
			typingManager.hide("channel-1"); // message_end
			expect(typingManager.isTyping("channel-1")).toBe(false);
		});

		it("should handle thinking without any text content", () => {
			const channel = { triggerTyping: vi.fn().mockResolvedValue(true) };
			typingManager.show("channel-1", channel);
			expect(typingManager.isTyping("channel-1")).toBe(true);
			typingManager.hide("channel-1");
			expect(typingManager.isTyping("channel-1")).toBe(false);
		});
	});

	describe("error handling scenarios", () => {
		it("should continue tracking typing even when triggerTyping fails once", () => {
			const channel = {
				triggerTyping: vi
					.fn()
					.mockRejectedValueOnce(new Error("Network error"))
					.mockResolvedValue(true),
			};

			// show() should not throw even when triggerTyping fails
			expect(() => typingManager.show("channel-1", channel)).not.toThrow();
			expect(typingManager.isTyping("channel-1")).toBe(true);
		});

		it("should keep typing active through multiple show() calls", () => {
			const channel = {
				triggerTyping: vi
					.fn()
					.mockRejectedValueOnce(new Error("Network error"))
					.mockRejectedValueOnce(new Error("Rate limited"))
					.mockResolvedValue(true),
			};

			typingManager.show("channel-1", channel);
			expect(typingManager.isTyping("channel-1")).toBe(true);
		});

		it("should handle rapid show/hide with failing triggerTyping", () => {
			const channel = {
				triggerTyping: vi
					.fn()
					.mockRejectedValue(new Error("Network error")),
			};

			typingManager.show("channel-1", channel);
			typingManager.hide("channel-1");
			typingManager.show("channel-1", channel);
			expect(typingManager.isTyping("channel-1")).toBe(true);
		});

		it("stale triggerTyping rejection must not affect active interval", async () => {
			const channel = {
				triggerTyping: vi.fn()
					.mockReturnValueOnce(new Promise((_, reject) => setTimeout(() => reject(new Error("Stale")), 50)))
					.mockResolvedValue(true),
			};

			// show() - creates interval, triggerTyping request pending
			typingManager.show("channel-1", channel);

			// hide() - clears interval but doesn't stop the pending old request
			typingManager.hide("channel-1");

			// show() starts a fresh interval
			typingManager.show("channel-1", channel);
			expect(typingManager.isTyping("channel-1")).toBe(true);

			// The stale promise rejection should not break anything
			await vi.waitFor(() => {
				expect(channel.triggerTyping).toHaveBeenCalledTimes(2);
			});
		});
	});

	describe("message sending correlation", () => {
		it("typing should be visible before message is sent", () => {
			const channel = { triggerTyping: vi.fn().mockResolvedValue(true) };
			typingManager.show("channel-1", channel);
			expect(typingManager.isTyping("channel-1")).toBe(true);
			expect(channel.triggerTyping).toHaveBeenCalled();
		});

		it("typing should be hidden after message ends", () => {
			const channel = { triggerTyping: vi.fn().mockResolvedValue(true) };
			typingManager.show("channel-1", channel);
			typingManager.hide("channel-1");
			expect(typingManager.isTyping("channel-1")).toBe(false);
		});

		it("multiple messages in sequence should manage typing correctly", () => {
			const channel = { triggerTyping: vi.fn().mockResolvedValue(true) };

			typingManager.show("channel-1", channel);
			typingManager.hide("channel-1");
			typingManager.show("channel-1", channel);
			typingManager.hide("channel-1");
			typingManager.show("channel-1", channel);
			expect(typingManager.isTyping("channel-1")).toBe(true);
			typingManager.hide("channel-1");
			expect(typingManager.isTyping("channel-1")).toBe(false);
		});
	});

	describe("tool execution flow", () => {
		it("should keep typing visible during tool execution", () => {
			const channel = { triggerTyping: vi.fn().mockResolvedValue(true) };

			typingManager.show("channel-1", channel);
			expect(typingManager.isTyping("channel-1")).toBe(true);

			// Tool execution happens while typing is visible
			typingManager.show("channel-1", channel); // tool_execution_start

			// Still typing during tool execution
			expect(typingManager.isTyping("channel-1")).toBe(true);

			typingManager.hide("channel-1"); // agent_end
			expect(typingManager.isTyping("channel-1")).toBe(false);
		});

		it("should show typing on tool_execution_start even without prior LLM message", () => {
			const channel = { triggerTyping: vi.fn().mockResolvedValue(true) };
			typingManager.show("channel-1", channel);
			expect(typingManager.isTyping("channel-1")).toBe(true);
			expect(channel.triggerTyping).toHaveBeenCalledTimes(1);
		});

		it("should handle multiple tool calls without hiding typing", () => {
			const channel = { triggerTyping: vi.fn().mockResolvedValue(true) };

			typingManager.show("channel-1", channel);
			typingManager.show("channel-1", channel); // tool 1
			typingManager.show("channel-1", channel); // tool 2
			expect(typingManager.isTyping("channel-1")).toBe(true);
			typingManager.hide("channel-1");
			expect(typingManager.isTyping("channel-1")).toBe(false);
		});
	});
});

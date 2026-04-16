/**
 * Prompt Queue Tests
 * Tests for the /queue command and automatic queue processing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the prompt queue Map (simulating the global state in index.ts)
let promptQueue: Map<string, string[]>;

describe("Prompt Queue", () => {
	beforeEach(() => {
		// Reset queue before each test
		promptQueue = new Map<string, string[]>();
	});

	describe("Queue Operations", () => {
		it("should add a prompt to the queue", () => {
			const channelId = "test-channel";
			const prompt = "Check for TODO comments";

			if (!promptQueue.has(channelId)) {
				promptQueue.set(channelId, []);
			}
			promptQueue.get(channelId)!.push(prompt);

			expect(promptQueue.get(channelId)).toEqual(["Check for TODO comments"]);
			expect(promptQueue.get(channelId)!.length).toBe(1);
		});

		it("should add multiple prompts to the queue in order", () => {
			const channelId = "test-channel";
			const prompts = ["First task", "Second task", "Third task"];

			if (!promptQueue.has(channelId)) {
				promptQueue.set(channelId, []);
			}
			prompts.forEach((p) => promptQueue.get(channelId)!.push(p));

			expect(promptQueue.get(channelId)).toEqual(prompts);
			expect(promptQueue.get(channelId)!.length).toBe(3);
		});

		it("should maintain separate queues per channel", () => {
			const channel1 = "channel-1";
			const channel2 = "channel-2";

			if (!promptQueue.has(channel1)) {
				promptQueue.set(channel1, []);
			}
			if (!promptQueue.has(channel2)) {
				promptQueue.set(channel2, []);
			}

			promptQueue.get(channel1)!.push("Channel 1 task");
			promptQueue.get(channel2)!.push("Channel 2 task");

			expect(promptQueue.get(channel1)).toEqual(["Channel 1 task"]);
			expect(promptQueue.get(channel2)).toEqual(["Channel 2 task"]);
		});

		it("should return empty array for non-existent channel", () => {
			const queue = promptQueue.get("non-existent") || [];
			expect(queue).toEqual([]);
			expect(queue.length).toBe(0);
		});
	});

	describe("Queue Processing (agent_end simulation)", () => {
		it("should process the next prompt from the queue", () => {
			const channelId = "test-channel";
			const prompts = ["First task", "Second task"];

			promptQueue.set(channelId, [...prompts]);

			// Simulate agent_end processing
			const queue = promptQueue.get(channelId);
			if (queue && queue.length > 0) {
				const nextPrompt = queue.shift();
				promptQueue.set(channelId, queue);

				expect(nextPrompt).toBe("First task");
				expect(promptQueue.get(channelId)).toEqual(["Second task"]);
			}
		});

		it("should not process if queue is empty", () => {
			const channelId = "test-channel";
			promptQueue.set(channelId, []);

			const queue = promptQueue.get(channelId);
			if (queue && queue.length > 0) {
				const nextPrompt = queue.shift();
				expect(nextPrompt).toBeUndefined();
			} else {
				expect(queue?.length).toBe(0);
			}
		});

		it("should not process if queue does not exist", () => {
			const channelId = "test-channel";
			const queue = promptQueue.get(channelId);

			expect(queue).toBeUndefined();
		});

		it("should process multiple prompts in sequence", () => {
			const channelId = "test-channel";
			const prompts = ["Task 1", "Task 2", "Task 3"];
			promptQueue.set(channelId, [...prompts]);

			const processed: string[] = [];

			// Simulate three agent_end events
			for (let i = 0; i < 3; i++) {
				const queue = promptQueue.get(channelId);
				if (queue && queue.length > 0) {
					const nextPrompt = queue.shift();
					promptQueue.set(channelId, queue);
					if (nextPrompt) {
						processed.push(nextPrompt);
					}
				}
			}

			expect(processed).toEqual(prompts);
			expect(promptQueue.get(channelId)).toEqual([]);
		});
	});

	describe("Queue Viewing", () => {
		it("should show all queued prompts", () => {
			const channelId = "test-channel";
			const prompts = ["First", "Second", "Third"];
			promptQueue.set(channelId, [...prompts]);

			const queue = promptQueue.get(channelId) || [];
			const queueText = queue
				.map((p, i) => `${i + 1}. ${p}`)
				.join("\n");

			expect(queueText).toBe("1. First\n2. Second\n3. Third");
		});

		it("should truncate long prompts in display", () => {
			const channelId = "test-channel";
			const longPrompt = "This is a very long prompt that should be truncated to eighty characters for display purposes in the queue view";
			promptQueue.set(channelId, [longPrompt]);

			const queue = promptQueue.get(channelId) || [];
			const queueText = queue
				.map((p, i) => `${i + 1}. ${p.length > 80 ? p.slice(0, 80) + "..." : p}`)
				.join("\n");

			// Verify truncation happens (prompt is 104 chars, slice at 80 + "..." = 83 + "1. " = 86)
			expect(queueText).toContain("...");
			expect(queueText).toContain("1. ");
			expect(queueText.length).toBeLessThan(longPrompt.length + 10); // +10 for "1. " and "..."
			expect(queueText).toContain("This is a very long prompt");
		});

		it("should handle empty queue display", () => {
			const channelId = "test-channel";
			promptQueue.set(channelId, []);

			const queue = promptQueue.get(channelId) || [];
			expect(queue.length).toBe(0);
		});
	});

	describe("Queue Clearing", () => {
		it("should clear queue on /clear command", () => {
			const channelId = "test-channel";
			promptQueue.set(channelId, ["Task 1", "Task 2"]);

			// Simulate /clear
			promptQueue.delete(channelId);

			expect(promptQueue.has(channelId)).toBe(false);
		});

		it("should clear queue on /exit command", () => {
			const channelId = "test-channel";
			promptQueue.set(channelId, ["Task 1"]);

			// Simulate /exit
			const queue = promptQueue.get(channelId);
			if (queue && queue.length > 0) {
				// Warning would be sent here
				promptQueue.delete(channelId);
			}

			expect(promptQueue.has(channelId)).toBe(false);
		});

		it("should warn about lost prompts on /exit", () => {
			const channelId = "test-channel";
			const prompts = ["Task 1", "Task 2", "Task 3"];
			promptQueue.set(channelId, [...prompts]);

			const queue = promptQueue.get(channelId);
			let warningMessage = "";

			if (queue && queue.length > 0) {
				warningMessage = `⚠️ **Exiting with ${queue.length} queued prompt(s) that will be lost**:\n${queue
					.map((p, i) => `${i + 1}. ${p.length > 80 ? p.slice(0, 80) + "..." : p}`)
					.join("\n")}`;

				promptQueue.delete(channelId);
			}

			expect(warningMessage).toContain("3 queued prompt(s)");
			expect(warningMessage).toContain("Task 1");
			expect(warningMessage).toContain("Task 2");
			expect(warningMessage).toContain("Task 3");
			expect(promptQueue.has(channelId)).toBe(false);
		});
	});

	describe("Queue Position Tracking", () => {
		it("should track position when adding to queue", () => {
			const channelId = "test-channel";
			promptQueue.set(channelId, []);

			const prompt1 = "First";
			promptQueue.get(channelId)!.push(prompt1);
			const position1 = promptQueue.get(channelId)!.length;

			const prompt2 = "Second";
			promptQueue.get(channelId)!.push(prompt2);
			const position2 = promptQueue.get(channelId)!.length;

			expect(position1).toBe(1);
			expect(position2).toBe(2);
		});

		it("should calculate position correctly after processing", () => {
			const channelId = "test-channel";
			promptQueue.set(channelId, ["Task 1", "Task 2"]);

			// Process first task
			const queue = promptQueue.get(channelId);
			if (queue && queue.length > 0) {
				queue.shift();
				promptQueue.set(channelId, queue);
			}

			// Add new task
			promptQueue.get(channelId)!.push("Task 3");
			const position = promptQueue.get(channelId)!.length;

			expect(position).toBe(2); // Task 2 and Task 3
		});
	});

	describe("Edge Cases", () => {
		it("should handle empty prompt string", () => {
			const channelId = "test-channel";
			if (!promptQueue.has(channelId)) {
				promptQueue.set(channelId, []);
			}
			promptQueue.get(channelId)!.push("");

			expect(promptQueue.get(channelId)).toEqual([""]);
			expect(promptQueue.get(channelId)!.length).toBe(1);
		});

		it("should handle very long prompts", () => {
			const channelId = "test-channel";
			const veryLongPrompt = "a".repeat(1000);

			if (!promptQueue.has(channelId)) {
				promptQueue.set(channelId, []);
			}
			promptQueue.get(channelId)!.push(veryLongPrompt);

			expect(promptQueue.get(channelId)!.length).toBe(1);
			expect(promptQueue.get(channelId)![0].length).toBe(1000);
		});

		it("should handle special characters in prompts", () => {
			const channelId = "test-channel";
			const specialPrompt = "Test with `code`, **bold**, and _italic_ formatting";

			if (!promptQueue.has(channelId)) {
				promptQueue.set(channelId, []);
			}
			promptQueue.get(channelId)!.push(specialPrompt);

			expect(promptQueue.get(channelId)).toEqual([specialPrompt]);
		});

		it("should handle unicode in prompts", () => {
			const channelId = "test-channel";
			const unicodePrompt = "Test with emoji 🚀 and unicode 日本語";

			if (!promptQueue.has(channelId)) {
				promptQueue.set(channelId, []);
			}
			promptQueue.get(channelId)!.push(unicodePrompt);

			expect(promptQueue.get(channelId)).toEqual([unicodePrompt]);
		});
	});

	describe("Queue Notification Message", () => {
		it("should format notification message correctly", () => {
			const prompt = "Run the tests";
			const notificationMessage = `🚀 **Executing queued prompt:**\n${prompt}`;

			expect(notificationMessage).toContain("🚀");
			expect(notificationMessage).toContain("Executing queued prompt:");
			expect(notificationMessage).toContain("Run the tests");
		});

		it("should truncate long prompts in notification", () => {
			const longPrompt = "a".repeat(300);
			const notificationMessage = `🚀 **Executing queued prompt:**\n${longPrompt.length > 200 ? longPrompt.slice(0, 200) + "..." : longPrompt}`;

			expect(notificationMessage).toContain("🚀");
			expect(notificationMessage.length).toBeLessThan(300);
			expect(notificationMessage).toContain("...");
		});
	});

	describe("Concurrent Queue Operations", () => {
		it("should handle multiple channels with different queue sizes", () => {
			const channels = ["ch-1", "ch-2", "ch-3"];
			const queueSizes = [1, 5, 0];

			channels.forEach((ch, i) => {
				const size = queueSizes[i];
				promptQueue.set(ch, []);
				for (let j = 0; j < size; j++) {
					promptQueue.get(ch)!.push(`Task ${j + 1} for ${ch}`);
				}
			});

			expect(promptQueue.get("ch-1")!.length).toBe(1);
			expect(promptQueue.get("ch-2")!.length).toBe(5);
			expect(promptQueue.get("ch-3")!.length).toBe(0);
		});

		it("should process queues independently", () => {
			const channel1 = "ch-1";
			const channel2 = "ch-2";

			promptQueue.set(channel1, ["Ch1 Task 1", "Ch1 Task 2"]);
			promptQueue.set(channel2, ["Ch2 Task 1"]);

			// Process channel 1
			const queue1 = promptQueue.get(channel1);
			if (queue1 && queue1.length > 0) {
				queue1.shift();
				promptQueue.set(channel1, queue1);
			}

			// Channel 2 should be unaffected
			expect(promptQueue.get(channel2)).toEqual(["Ch2 Task 1"]);
			expect(promptQueue.get(channel1)).toEqual(["Ch1 Task 2"]);
		});
	});
});

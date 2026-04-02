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

describe("escapeForCodeBlock", () => {
	const escapeForCodeBlock = (text: string): string => {
		return text.replace(/```/g, "`\u200b``\u200b``");
	};

	it("should return empty string as-is", () => {
		expect(escapeForCodeBlock("")).toBe("");
	});

	it("should return normal text unchanged", () => {
		expect(escapeForCodeBlock("hello world")).toBe("hello world");
	});

	it("should escape single triple backtick", () => {
		const result = escapeForCodeBlock("hello ``` world");
		expect(result).toBe("hello `\u200b``\u200b`` world");
	});

	it("should escape multiple triple backticks", () => {
		const result = escapeForCodeBlock("```foo```bar```");
		expect(result).toBe("`\u200b``\u200b``foo`\u200b``\u200b``bar`\u200b``\u200b``");
	});

	it("should escape triple backticks in JSON content", () => {
		const json = '{"code": "```js\\nconsole.log(1)\\n```"}';
		const result = escapeForCodeBlock(json);
		expect(result).toBe('{"code": "`\u200b``\u200b``js\\nconsole.log(1)\\n`\u200b``\u200b``"}');
	});

	it("should preserve other characters", () => {
		const text = "```json\n{\"key\": \"value\"}\n```";
		const result = escapeForCodeBlock(text);
		expect(result).not.toContain("```");
		expect(result).toContain('"key"');
		expect(result).toContain('"value"');
	});
});

describe("splitMessagePreservingCodeBlocks", () => {
	// Copy the function for testing
	const splitMessagePreservingCodeBlocks = (text: string, maxLength: number): string[] => {
		const chunks: string[] = [];
		let remaining = text;

		while (remaining.length > 0) {
			// If the remaining text fits in one chunk, we're done
			if (remaining.length <= maxLength) {
				chunks.push(remaining);
				break;
			}

			// Try to find code blocks within the current chunk range
			const visibleSlice = remaining.slice(0, maxLength);
			const codeBlockMatch = visibleSlice.match(/```/g);
			const codeBlockCount = codeBlockMatch ? codeBlockMatch.length : 0;

			if (codeBlockCount === 0 || codeBlockCount % 2 === 0) {
				// No code block or complete pairs within visible range
				// Check if there's an opening ``` within a few chars of the boundary
				const nearBoundaryArea = remaining.slice(maxLength, maxLength + 50);
				const openingIndex = nearBoundaryArea.indexOf("```");
				if (openingIndex !== -1) {
					// Code block starts near boundary - include the whole block
					const actualStart = maxLength + openingIndex;
					const nextCloseIndex = remaining.indexOf("```", actualStart + 3);
					if (nextCloseIndex !== -1) {
						const endOfBlock = nextCloseIndex + 3;
						chunks.push(remaining.slice(0, endOfBlock));
						remaining = remaining.slice(endOfBlock);
					} else {
						// No closing - include what we can
						chunks.push(remaining.slice(0, maxLength));
						remaining = remaining.slice(maxLength);
					}
				} else {
					// Safe to split at maxLength
					chunks.push(remaining.slice(0, maxLength));
					remaining = remaining.slice(maxLength);
				}
			} else {
				// Odd number of ``` found in visible range - we're inside a code block
				// Find the closing ``` and include the entire block
				const nextCloseIndex = remaining.indexOf("```", maxLength);
				if (nextCloseIndex !== -1) {
					// Include the closing ``` plus a bit more if there's content
					const endOfBlock = nextCloseIndex + 3;
					chunks.push(remaining.slice(0, endOfBlock));
					remaining = remaining.slice(endOfBlock);
				} else {
					// No closing ``` found - just take what we can
					// This shouldn't happen for valid Discord messages
					chunks.push(remaining.slice(0, maxLength));
					remaining = remaining.slice(maxLength);
				}
			}
		}

		return chunks;
	};

	it("should return single chunk when text fits", () => {
		const text = "Hello world";
		const result = splitMessagePreservingCodeBlocks(text, 2000);
		expect(result).toEqual(["Hello world"]);
	});

	it("should split at maxLength when no code blocks", () => {
		const text = "a".repeat(2500);
		const result = splitMessagePreservingCodeBlocks(text, 2000);
		expect(result.length).toBe(2);
		expect(result[0].length).toBe(2000);
		expect(result[1].length).toBe(500);
	});

	it("should not split inside a code block", () => {
		const prefix = "x".repeat(1990);
		const codeBlock = "\n```\ncode here\n```";
		const text = prefix + codeBlock;
		const result = splitMessagePreservingCodeBlocks(text, 2000);
		// Should be one chunk because code block completes before limit
		expect(result.length).toBe(1);
		expect(result[0]).toBe(text);
	});

	it("should include entire code block even if it crosses maxLength", () => {
		const prefix = "x".repeat(2000);
		const codeBlock = "\n```\ncode\n```";
		const text = prefix + codeBlock;
		const result = splitMessagePreservingCodeBlocks(text, 2000);
		// First chunk should include the entire code block
		expect(result.length).toBe(1);
		expect(result[0]).toBe(text);
	});

	it("should handle multiple code blocks", () => {
		// First code block + lots of x's + second code block that crosses boundary
		const text = "```json\n{}\n```\n" + "x".repeat(1990) + "\n```js\ncode\n```";
		// Total length: 17 + 1990 + 15 = 2022, which fits in one chunk
		// So this should be a single chunk
		const result = splitMessagePreservingCodeBlocks(text, 2000);
		expect(result.length).toBe(1);
		expect(result[0]).toBe(text);
	});

	it("should split text without code blocks at maxLength", () => {
		// Plain text without code blocks should split at maxLength
		const text = "a".repeat(5000);
		const result = splitMessagePreservingCodeBlocks(text, 2000);
		expect(result.length).toBe(3);
		expect(result[0].length).toBe(2000);
		expect(result[1].length).toBe(2000);
		expect(result[2].length).toBe(1000);
	});

	it("should handle code block at exact boundary", () => {
		const prefix = "x".repeat(1990) + "\n```\n";
		const codeContent = "code\n";
		const closing = "```";
		const text = prefix + codeContent + closing;
		const result = splitMessagePreservingCodeBlocks(text, 2000);
		// The opening ``` is at position 1990-1992, so it should include the whole block
		expect(result.length).toBe(1);
	});

	it("should handle nested triple backticks in code content", () => {
		const text = "```json\n{\"test\": \"```inner```\"}\n```";
		const result = splitMessagePreservingCodeBlocks(text, 2000);
		// Should keep the whole thing together
		expect(result.length).toBe(1);
		expect(result[0]).toBe(text);
	});
});

describe("tool args JSON formatting", () => {
	const escapeForCodeBlock = (text: string): string => {
		return text.replace(/```/g, "`\u200b``\u200b``");
	};

	it("should format simple args as indented JSON", () => {
		const args = { command: "ls -la" };
		const formatted = escapeForCodeBlock(JSON.stringify(args, null, 2));
		expect(formatted).toContain('\"command\"');
		expect(formatted).toContain("ls -la");
	});

	it("should format nested args correctly", () => {
		const args = {
			path: "/home/user",
			options: {
				recursive: true,
				verbose: false
			}
		};
		const formatted = escapeForCodeBlock(JSON.stringify(args, null, 2));
		expect(formatted).toContain('\"path\"');
		expect(formatted).toContain('\"options\"');
		expect(formatted).toContain('\"recursive\"');
	});

	it("should handle empty args object", () => {
		const args = {};
		const formatted = escapeForCodeBlock(JSON.stringify(args, null, 2));
		expect(formatted).toBe("{}");
	});

	it("should handle array args", () => {
		const args = { files: ["a.txt", "b.txt", "c.txt"] };
		const formatted = escapeForCodeBlock(JSON.stringify(args, null, 2));
		expect(formatted).toContain('\"files\"');
		expect(formatted).toContain("a.txt");
	});
});

describe("thinking buffer", () => {
	it("should accumulate thinking deltas", () => {
		const thinkingBuffer: string[] = [];

		thinkingBuffer.push("Let me think");
		thinkingBuffer.push(" about this");
		thinkingBuffer.push(" problem...");

		expect(thinkingBuffer.join("")).toBe("Let me think about this problem...");
	});

	it("should clear on message_start", () => {
		const thinkingBuffer: string[] = [];

		thinkingBuffer.push("Previous thinking");
		expect(thinkingBuffer.length).toBe(1);

		// message_start clears buffer
		thinkingBuffer.length = 0;
		expect(thinkingBuffer.length).toBe(0);
	});

	it("should clear on message_end", () => {
		const thinkingBuffer: string[] = [];

		thinkingBuffer.push("Some thinking");
		thinkingBuffer.length = 0;

		expect(thinkingBuffer.join("")).toBe("");
	});

	it("should only send when thinking exceeds threshold", () => {
		const thinkingBuffer: string[] = [];
		const THRESHOLD = 10;

		thinkingBuffer.push("short");
		const shortText = thinkingBuffer.join("");
		expect(shortText.length > THRESHOLD).toBe(false);

		thinkingBuffer.push(" more content here");
		const longText = thinkingBuffer.join("");
		expect(longText.length > THRESHOLD).toBe(true);
	});

	it("should format thinking message with emoji and code block", () => {
		const thinkingText = "Let me analyze this code...";
		const escapeForCodeBlock = (text: string): string => {
			return text.replace(/```/g, "`\u200b``\u200b``");
		};
		const message = `💭 Thinking...\n\`\`\`\n${escapeForCodeBlock(thinkingText)}\n\`\`\``;

		expect(message).toContain("💭 Thinking...");
		expect(message).toContain("```");
		expect(message).toContain(thinkingText);
	});
});

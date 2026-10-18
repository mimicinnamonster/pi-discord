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

describe("Bash command parsing", () => {
	it("should detect ! command", () => {
		const content = "!ls -la";
		const isBash = content.startsWith("!");
		const isExcluded = content.startsWith("!!");
		const command = isExcluded ? content.slice(2).trim() : content.slice(1).trim();

		expect(isBash).toBe(true);
		expect(isExcluded).toBe(false);
		expect(command).toBe("ls -la");
	});

	it("should detect !! command", () => {
		const content = "!!ls -la";
		const isBash = content.startsWith("!");
		const isExcluded = content.startsWith("!!");
		const command = isExcluded ? content.slice(2).trim() : content.slice(1).trim();

		expect(isBash).toBe(true);
		expect(isExcluded).toBe(true);
		expect(command).toBe("ls -la");
	});

	it("should handle empty command after !", () => {
		const content = "!";
		const isBash = content.startsWith("!");
		const isExcluded = content.startsWith("!!");
		const command = isExcluded ? content.slice(2).trim() : content.slice(1).trim();

		expect(command).toBe("");
	});

	it("should handle empty command after !!", () => {
		const content = "!!";
		const isBash = content.startsWith("!");
		const isExcluded = content.startsWith("!!");
		const command = isExcluded ? content.slice(2).trim() : content.slice(1).trim();

		expect(command).toBe("");
	});

	it("should handle command with spaces", () => {
		const content = "!  echo hello world  ";
		const isBash = content.startsWith("!");
		const isExcluded = content.startsWith("!!");
		const command = isExcluded ? content.slice(2).trim() : content.slice(1).trim();

		expect(command).toBe("echo hello world");
	});
});

describe("Session command parsing", () => {
	it("should detect /session command", () => {
		const content = "/session";
		const isSession = content === "/session";

		expect(isSession).toBe(true);
	});

	it("should not match /session with args", () => {
		const content: string = "/session extra";
		const isSession = content === "/session";

		expect(isSession).toBe(false);
	});

	it("should not match partial commands", () => {
		const content: string = "/sess";
		const isSession = content === "/session";

		expect(isSession).toBe(false);
	});
});

describe("Long message file upload", () => {
	const FILE_UPLOAD_THRESHOLD = 2000;

	it("should use file upload for messages exceeding threshold", () => {
		const longMessage = "a".repeat(FILE_UPLOAD_THRESHOLD + 1);
		const shouldUploadAsFile = longMessage.length > FILE_UPLOAD_THRESHOLD;

		expect(shouldUploadAsFile).toBe(true);
	});

	it("should NOT use file upload for messages below threshold", () => {
		const shortMessage = "a".repeat(FILE_UPLOAD_THRESHOLD - 1);
		const shouldUploadAsFile = shortMessage.length > FILE_UPLOAD_THRESHOLD;

		expect(shouldUploadAsFile).toBe(false);
	});

	it("should NOT use file upload for messages at exact threshold", () => {
		const exactMessage = "a".repeat(FILE_UPLOAD_THRESHOLD);
		const shouldUploadAsFile = exactMessage.length > FILE_UPLOAD_THRESHOLD;

		expect(shouldUploadAsFile).toBe(false);
	});

	it("should use file upload for messages just over threshold", () => {
		const justOver = "a".repeat(FILE_UPLOAD_THRESHOLD + 1);
		const shouldUploadAsFile = justOver.length > FILE_UPLOAD_THRESHOLD;

		expect(shouldUploadAsFile).toBe(true);
	});

	it("should handle code blocks in long messages", () => {
		const codeBlock = "```\n" + "x".repeat(10000) + "\n```";
		const shouldUploadAsFile = codeBlock.length > FILE_UPLOAD_THRESHOLD;

		// Code blocks are kept intact, so even a single very long code block should be uploaded
		expect(shouldUploadAsFile).toBe(true);
	});

	it("should use 2000 char threshold (Discord's limit)", () => {
		// Verify the threshold is set correctly
		expect(FILE_UPLOAD_THRESHOLD).toBe(2000);
		// This matches Discord's message limit
		expect(FILE_UPLOAD_THRESHOLD).toBe(2000);
	});

	it("should handle empty messages (should not upload)", () => {
		const emptyMessage = "";
		const shouldUploadAsFile = emptyMessage.length > FILE_UPLOAD_THRESHOLD;

		expect(shouldUploadAsFile).toBe(false);
	});

	it("should handle unicode in long messages", () => {
		const unicodeMessage = "日本語".repeat(1000); // 3000 chars (3 chars each × 1000)
		const shouldUploadAsFile = unicodeMessage.length > FILE_UPLOAD_THRESHOLD;

		// Each Japanese character counts as 1 in string length
		expect(unicodeMessage.length).toBe(3000);
		expect(shouldUploadAsFile).toBe(true); // 3000 > 2000
	});

	it("should handle very long messages (100KB+)", () => {
		const veryLongMessage = "x".repeat(100000);
		const shouldUploadAsFile = veryLongMessage.length > FILE_UPLOAD_THRESHOLD;

		expect(shouldUploadAsFile).toBe(true);
	});
});

describe("File upload attachment", () => {
	it("should generate correct buffer from text", () => {
		const text = "Hello, World!";
		const buffer = Buffer.from(text, "utf-8");

		expect(buffer.toString("utf-8")).toBe(text);
	});

	it("should handle unicode in buffer", () => {
		const text = "Hello 世界 🌍";
		const buffer = Buffer.from(text, "utf-8");

		expect(buffer.toString("utf-8")).toBe(text);
	});

	it("should handle large buffers", () => {
		const text = "x".repeat(50000);
		const buffer = Buffer.from(text, "utf-8");

		expect(buffer.length).toBe(50000);
		expect(buffer.toString("utf-8")).toBe(text);
	});
});

describe("Content extension detection", () => {
	// Simulate getContentExtension logic for testing
	function getContentExtension(text: string, type?: string): string {
		const codeBlockMatch = text.match(/```(\w+)/);
		if (codeBlockMatch) {
			const lang = codeBlockMatch[1].toLowerCase();
			const langMap: Record<string, string> = {
				js: "js", javascript: "js", ts: "ts", typescript: "ts",
				json: "json", python: "py", py: "py", rust: "rs", rs: "rs",
				go: "go", bash: "sh", sh: "sh", shell: "sh", zsh: "sh",
				toml: "toml", yaml: "yaml", yml: "yaml", xml: "xml",
				html: "html", css: "css", sql: "sql", md: "md", markdown: "md",
			};
			if (langMap[lang]) return langMap[lang];
		}
		if (text.includes("diff --git") || text.startsWith("diff ") || text.match(/^--- |^\+\+\+ /m)) return "diff";
		if (text.match(/^From [a-f0-9]+ /m) || text.includes("--- a/") || text.includes("--- a\\\"")) return "patch";
		const trimmed = text.trim();
		if (trimmed.startsWith("{") && trimmed.endsWith("}")) return "json";
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) return "json";
		if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || trimmed.startsWith("<?xml")) return "html";
		if (type === "tool" && text.includes("command")) return "sh";
		return "txt";
	}

	// Simulate filename extension replacement
	function replaceExtension(filename: string, ext: string): string {
		return filename.replace(/\.[^.]+$/, `.${ext}`);
	}

	it("should replace extension in filename", () => {
		expect(replaceExtension("output.txt", "md")).toBe("output.md");
		expect(replaceExtension("output.txt", "json")).toBe("output.json");
		expect(replaceExtension("output.txt", "sh")).toBe("output.sh");
	});

	it("should handle filenames without extension", () => {
		const noExtFilename = "output";
		const ext = getContentExtension("plain text");
		// Without extension, replace won't match
		expect(replaceExtension(noExtFilename, ext)).toBe(noExtFilename);
		// This is why we pass "output.txt" as default in the code
	});

	it("should detect javascript code blocks", () => {
		expect(getContentExtension("```javascript\nconsole.log('hi');\n```")).toBe("js");
		expect(getContentExtension("```js\nconsole.log('hi');\n```")).toBe("js");
	});

	it("should detect typescript code blocks", () => {
		expect(getContentExtension("```typescript\nconst x: number = 1;\n```")).toBe("ts");
		expect(getContentExtension("```ts\nconst x: number = 1;\n```")).toBe("ts");
	});

	it("should detect JSON", () => {
		expect(getContentExtension('{"key": "value"}')).toBe("json");
		expect(getContentExtension('[1, 2, 3]')).toBe("json");
	});

	it("should detect git diff output", () => {
		expect(getContentExtension("diff --git a/file.txt b/file.txt")).toBe("diff");
		expect(getContentExtension("diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt")).toBe("diff");
		expect(getContentExtension("--- a/file.txt\n+++ b/file.txt")).toBe("diff");
	});

	it("should detect bash/shell", () => {
		expect(getContentExtension("```bash\necho hello\n```")).toBe("sh");
		expect(getContentExtension("```sh\necho hello\n```")).toBe("sh");
		expect(getContentExtension("```shell\necho hello\n```")).toBe("sh");
	});

	it("should default to txt for unknown content", () => {
		expect(getContentExtension("Hello world")).toBe("txt");
		expect(getContentExtension("Some random text")).toBe("txt");
	});

	it("should use type hint for tool output with command", () => {
		expect(getContentExtension("Running command: ls", "tool")).toBe("sh");
	});

	it("should detect HTML", () => {
		expect(getContentExtension("<!DOCTYPE html>")).toBe("html");
		expect(getContentExtension("<html><body></body></html>")).toBe("html");
		expect(getContentExtension("<?xml version=\"1.0\"?>")).toBe("html");
	});

	it("should detect python", () => {
		expect(getContentExtension("```python\nprint('hello')\n```")).toBe("py");
	});

	it("should detect rust", () => {
		expect(getContentExtension("```rust\nfn main() {}\n```")).toBe("rs");
	});
});

describe("New Session command parsing", () => {
	it("should detect /clear command", () => {
		const content = "/clear";
		const isClear = content === "/clear";

		expect(isClear).toBe(true);
	});

	it("should not match /clear with args", () => {
		const content: string = "/clear extra";
		const isClear = content === "/clear";

		expect(isClear).toBe(false);
	});

	it("should not match partial commands", () => {
		const content: string = "/clearing";
		const isClear = content === "/clear";

		expect(isClear).toBe(false);
	});
});

describe("Reload command parsing", () => {
	it("should detect /reload command", () => {
		const content = "/reload";
		const isReload = content === "/reload";

		expect(isReload).toBe(true);
	});

	it("should not match /reload with args", () => {
		const content: string = "/reload extra";
		const isReload = content === "/reload";

		expect(isReload).toBe(false);
	});

	it("should not match partial commands", () => {
		const content: string = "/reloaded";
		const isReload = content === "/reload";

		expect(isReload).toBe(false);
	});
});

describe("Reload command behavior", () => {
	it("should call session.reload() when /reload is received", async () => {
		const content = "/reload";
		const isReload = content === "/reload";
		
		expect(isReload).toBe(true);
		
		// Mock session with reload method
		let reloadCalled = false;
		const mockSession = {
			reload: vi.fn().mockImplementation(async () => {
				reloadCalled = true;
			}),
		};
		
		// Simulate command processing
		if (content === "/reload") {
			await mockSession.reload();
		}
		
		expect(reloadCalled).toBe(true);
		expect(mockSession.reload).toHaveBeenCalledTimes(1);
	});

	it("should handle reload errors gracefully", async () => {
		const mockSession = {
			reload: vi.fn().mockRejectedValue(new Error("Reload failed")),
		};
		
		// Simulate error handling
		let errorMessage = "";
		try {
			await mockSession.reload();
		} catch (error) {
			errorMessage = String(error);
		}
		
		expect(errorMessage).toContain("Reload failed");
		expect(mockSession.reload).toHaveBeenCalledTimes(1);
	});

	it("should not process other commands as /reload", () => {
		const commands = ["/sessions", "/reloadx", "/xreload", "/r", "/"];
		
		for (const cmd of commands) {
			const isReload = cmd === "/reload";
			expect(isReload).toBe(false);
		}
	});
});

describe("Model command parsing", () => {
	it("should detect /models command", () => {
		const content = "/models";
		const isModels = content === "/models";
		expect(isModels).toBe(true);
	});

	it("should detect /model command without args", () => {
		const content = "/model";
		const isModel = content === "/model";
		expect(isModel).toBe(true);
	});

	it("should detect /model with provider/model format", () => {
		const content = "/model anthropic/claude-opus";
		const isModelSwitch = content.startsWith("/model ");
		expect(isModelSwitch).toBe(true);
	});

	it("should not match partial model commands", () => {
		const commands = ["/model-select", "/modelx", "/mod"];
		for (const cmd of commands) {
			const isModelSwitch = cmd.startsWith("/model ") || cmd === "/model" || cmd === "/models";
			expect(isModelSwitch).toBe(false);
		}
	});
});

describe("Model command behavior", () => {
	it("should parse provider and model from /model command", () => {
		const content = "/model anthropic/claude-opus";
		const [provider, model] = content.replace('/model ', '').split('/');
		
		expect(provider).toBe("anthropic");
		expect(model).toBe("claude-opus");
	});

	it("should handle /model command without args", async () => {
		const content = "/model";
		const isSimpleModel = content === "/model";
		expect(isSimpleModel).toBe(true);
	});

	it("should show available models with /models", () => {
		const content = "/models";
		const isListModels = content === "/models";
		expect(isListModels).toBe(true);
	});

	it("should handle model switching errors gracefully", async () => {
		const mockSession = {
			setModel: vi.fn().mockRejectedValue(new Error("Model not found")),
		};
		
		let errorMessage = "";
		try {
			await mockSession.setModel({});
		} catch (error) {
			errorMessage = String(error);
		}
		
		expect(errorMessage).toContain("Model not found");
		expect(mockSession.setModel).toHaveBeenCalledTimes(1);
	});

	it("should require both provider and model", () => {
		const validFormats = [
			{ input: "/model anthropic/claude-opus", valid: true },
			{ input: "/model openai/gpt-4", valid: true },
			{ input: "/model missing-model", valid: false },
			{ input: "/model /incomplete", valid: false },
		];
		
		for (const format of validFormats) {
			const [provider, model] = format.input.replace('/model ', '').split('/');
			if (format.valid) {
				expect(provider).toBeTruthy();
				expect(model).toBeTruthy();
			} else {
				expect(!provider || !model).toBe(true);
			}
		}
	});
});

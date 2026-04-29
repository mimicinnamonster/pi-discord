/**
 * Multimodal Message Tests
 * Tests for handling images and multimodal content in Discord messages
 */

import { describe, it, expect, vi } from "vitest";

describe("Multimodal Content Preparation", () => {
	// We replicate the logic from src/index.ts handleMessage to test it in isolation
	function prepareAgentContent(message: {
		content: string | null;
		attachments: Map<string, any>;
	}) {
		const agentContent: any[] = [];
		if (message.content?.trim()) {
			agentContent.push({ type: "text", text: message.content });
		}

		message.attachments.forEach(attachment => {
			if (attachment.contentType?.startsWith('image/')) {
				agentContent.push({
					type: "image",
					data: "base64-mock-data",
					mimeType: attachment.contentType,
				});
			}
		});

		return agentContent;
	}

	it("should prepare text-only content correctly", () => {
		const message = {
			content: "Hello world",
			attachments: new Map()
		};
		const result = prepareAgentContent(message);
		expect(result).toEqual([{ type: "text", text: "Hello world" }]);
	});

	it("should prepare image-only content correctly", () => {
		const message = {
			content: null,
			attachments: new Map([
				["att-1", { contentType: "image/png", url: "https://example.com/img1.png" }]
			])
		};
		const result = prepareAgentContent(message);
		expect(result).toEqual([
			{ type: "image", data: "base64-mock-data", mimeType: "image/png" }
		]);
	});

	it("should prepare mixed text and image content correctly", () => {
		const message = {
			content: "Look at this!",
			attachments: new Map([
				["att-1", { contentType: "image/jpeg", url: "https://example.com/img1.jpg" }],
				["att-2", { contentType: "image/webp", url: "https://example.com/img2.webp" }]
			])
		};
		const result = prepareAgentContent(message);
		expect(result).toEqual([
			{ type: "text", text: "Look at this!" },
			{ type: "image", data: "base64-mock-data", mimeType: "image/jpeg" },
			{ type: "image", data: "base64-mock-data", mimeType: "image/webp" }
		]);
	});

	it("should ignore non-image attachments", () => {
		const message = {
			content: "Here is a file",
			attachments: new Map([
				["att-1", { contentType: "application/pdf", url: "https://example.com/doc.pdf" }],
				["att-2", { contentType: "image/png", url: "https://example.com/img.png" }]
			])
		};
		const result = prepareAgentContent(message);
		expect(result).toEqual([
			{ type: "text", text: "Here is a file" },
			{ type: "image", data: "base64-mock-data", mimeType: "image/png" }
		]);
	});

	it("should handle empty content and empty attachments", () => {
		const message = {
			content: "   ",
			attachments: new Map()
		};
		const result = prepareAgentContent(message);
		expect(result).toEqual([]);
	});

	it("should handle null content and empty attachments", () => {
		const message = {
			content: null,
			attachments: new Map()
		};
		const result = prepareAgentContent(message);
		expect(result).toEqual([]);
	});
});

describe("Discord Bot Message Filtering", () => {
	function shouldIgnoreMessage(content: string | null, attachmentsSize: number) {
		return !content?.trim() && attachmentsSize === 0;
	}

	it("should not ignore message with text", () => {
		expect(shouldIgnoreMessage("Hello", 0)).toBe(false);
	});

	it("should not ignore message with attachments", () => {
		expect(shouldIgnoreMessage(null, 1)).toBe(false);
	});

	it("should not ignore message with both", () => {
		expect(shouldIgnoreMessage("Hello", 1)).toBe(false);
	});

	it("should ignore message with neither", () => {
		expect(shouldIgnoreMessage(null, 0)).toBe(true);
		expect(shouldIgnoreMessage("   ", 0)).toBe(true);
	});
});

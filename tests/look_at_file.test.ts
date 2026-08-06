import { describe, it, expect, vi, beforeEach } from "vitest";
import { readImageFile } from "../src/session-store";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Valid image headers for each format (minimal valid files)
const VALID_IMAGE_BUFFERS: Record<string, Buffer> = {
	// Minimal valid PNG (1x1 transparent pixel)
	".png": Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
		"base64"
	),
	// Minimal valid JPEG (from real JPEG header)
	".jpg": Buffer.from(
		"/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAFRABAQAAAAAAAAAAAAAAAAAAAAf/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=",
		"base64"
	),
	".jpeg": Buffer.from(
		"/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAFRABAQAAAAAAAAAAAAAAAAAAAAf/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=",
		"base64"
	),
	// Minimal valid GIF
	".gif": Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
	// Minimal valid WebP
	".webp": Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64"),
};

describe("SessionStore readImageFile (look_at_file helper)", () => {
	let testSessionDir: string;

	beforeEach(() => {
		testSessionDir = join(tmpdir(), `pi-discord-test-${Date.now()}`);
		mkdirSync(testSessionDir, { recursive: true });
	});

	it("should successfully process a valid image file", async () => {
		const imagePath = join(testSessionDir, "test-image.png");
		const validPng = VALID_IMAGE_BUFFERS[".png"];
		writeFileSync(imagePath, validPng);

		const result = await readImageFile({ path: imagePath }, testSessionDir);

		expect(result.absolutePath).toBe(imagePath);
		expect(result.base64Data).toBe(validPng.toString("base64"));
		expect(result.mimeType).toBe("image/png");
	});

	it("should return error for non-existent file", async () => {
		await expect(readImageFile({ path: "/tmp/non-existent-file-12345.png" }, testSessionDir))
			.rejects.toThrow("FILE_NOT_FOUND");
	});

	it("should return error for unsupported file extension", async () => {
		const textPath = join(testSessionDir, "test.txt");
		writeFileSync(textPath, "hello world");

		await expect(readImageFile({ path: textPath }, testSessionDir))
			.rejects.toThrow("UNSUPPORTED_FORMAT");
	});

	it("should return error for files with image extension but invalid content", async () => {
		const fakePath = join(testSessionDir, "fake.jpg");
		writeFileSync(fakePath, "<html><body>404</body></html>");

		await expect(readImageFile({ path: fakePath }, testSessionDir))
			.rejects.toThrow("NOT_AN_IMAGE");
	});

	it("should detect correct MIME types for different extensions", async () => {
		const cases: [string, string][] = [
			["test.jpg", "image/jpeg"],
			["test.jpeg", "image/jpeg"],
			["test.png", "image/png"],
			["test.gif", "image/gif"],
			["test.webp", "image/webp"],
		];

		for (const [filename, expectedMime] of cases) {
			const ext = "." + filename.split(".")[1];
			const p = join(testSessionDir, filename);
			writeFileSync(p, VALID_IMAGE_BUFFERS[ext]);
			const result = await readImageFile({ path: p }, testSessionDir);
			expect(result.mimeType).toBe(expectedMime);
		}
	});
});

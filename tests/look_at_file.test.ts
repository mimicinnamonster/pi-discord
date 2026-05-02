import { describe, it, expect, vi, beforeEach } from "vitest";
import { readImageFile } from "../src/session-store";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("SessionStore readImageFile (look_at_file helper)", () => {
	let testSessionDir: string;

	beforeEach(() => {
		testSessionDir = join(tmpdir(), `pi-discord-test-${Date.now()}`);
		mkdirSync(testSessionDir, { recursive: true });
	});

	it("should successfully process a valid image file", async () => {
		const imagePath = join(testSessionDir, "test-image.png");
		writeFileSync(imagePath, Buffer.from("fake-image-data"));

		const result = await readImageFile({ path: imagePath }, testSessionDir);

		expect(result.absolutePath).toBe(imagePath);
		expect(result.base64Data).toBe(Buffer.from("fake-image-data").toString("base64"));
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

	it("should detect correct MIME types for different extensions", async () => {
		const { writeFileSync: wfs } = await import("fs");
		
		const cases: [string, string][] = [
			["test.jpg", "image/jpeg"],
			["test.jpeg", "image/jpeg"],
			["test.png", "image/png"],
			["test.gif", "image/gif"],
			["test.webp", "image/webp"],
		];

		for (const [filename, expectedMime] of cases) {
			const p = join(testSessionDir, filename);
			wfs(p, Buffer.from("data"));
			const result = await readImageFile({ path: p }, testSessionDir);
			expect(result.mimeType).toBe(expectedMime);
		}
	});
});

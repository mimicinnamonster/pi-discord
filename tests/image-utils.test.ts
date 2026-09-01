/**
 * downscaleImage tests
 *
 * Covers the image downscaling/compression added in fcf2cab: heavy multimodal
 * payloads made some providers drop streams mid-generation, so attachments and
 * look_at_file images are resized before being sent to the model. The pi SDK's
 * resizeImage is dynamically imported, so we mock it to test all branches
 * (downscaled, not smaller, failure, no result) deterministically.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { downscaleImage } from "../src/image-utils";

// Mock the pi SDK's resizeImage (dynamically imported inside downscaleImage).
// The path resolves to the same module file that src/image-utils.ts imports.
const resizeImageMock = vi.fn();

vi.mock("../node_modules/@earendil-works/pi-coding-agent/dist/utils/image-resize.js", () => ({
	resizeImage: (...args: unknown[]) => resizeImageMock(...args),
}));

describe("downscaleImage", () => {
	beforeEach(() => {
		resizeImageMock.mockReset();
	});

	it("should return the downscaled image when resized data is smaller", async () => {
		const original = "a".repeat(10_000);
		const resized = "b".repeat(2_000);
		resizeImageMock.mockResolvedValue({ data: resized, mimeType: "image/jpeg" });

		const result = await downscaleImage(original, "image/png");

		expect(result.wasDownscaled).toBe(true);
		expect(result.data).toBe(resized);
		expect(result.mimeType).toBe("image/jpeg");

		// resizeImage must receive the image plus sane downscale limits
		expect(resizeImageMock).toHaveBeenCalledTimes(1);
		expect(resizeImageMock).toHaveBeenCalledWith(
			{ type: "image", data: original, mimeType: "image/png" },
			expect.objectContaining({
				maxWidth: expect.any(Number),
				maxHeight: expect.any(Number),
				maxBytes: expect.any(Number),
				jpegQuality: expect.any(Number),
			})
		);
	});

	it("should keep the original when resized data is not smaller", async () => {
		const original = "a".repeat(1_000);
		resizeImageMock.mockResolvedValue({ data: "b".repeat(5_000), mimeType: "image/jpeg" });

		const result = await downscaleImage(original, "image/png");

		expect(result.wasDownscaled).toBe(false);
		expect(result.data).toBe(original);
		expect(result.mimeType).toBe("image/png");
	});

	it("should fall back to the original when resizeImage throws", async () => {
		const original = "a".repeat(10_000);
		resizeImageMock.mockRejectedValue(new Error("Photon failed to load"));

		const result = await downscaleImage(original, "image/webp");

		expect(result.wasDownscaled).toBe(false);
		expect(result.data).toBe(original);
		expect(result.mimeType).toBe("image/webp");
	});

	it("should fall back to the original when resizeImage returns nothing useful", async () => {
		const original = "a".repeat(10_000);
		resizeImageMock.mockResolvedValue(null);

		const result = await downscaleImage(original, "image/png");

		expect(result.wasDownscaled).toBe(false);
		expect(result.data).toBe(original);
		expect(result.mimeType).toBe("image/png");
	});
});

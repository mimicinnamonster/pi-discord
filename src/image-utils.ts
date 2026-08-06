/**
 * Downscale/compress images before sending them to the LLM.
 *
 * Discord attachments and local files are often multi-MB photos. Sending them
 * at full size makes every request carry megabytes of base64 per image, and
 * heavy multimodal payloads make some providers (e.g. opencode-go) drop the
 * stream before it finishes ("Stream ended without finish_reason").
 *
 * Uses the pi SDK's Photon-based resizeImage (via relative node_modules path,
 * since the package exports map only exposes "." and "./hooks"). Falls back to
 * the original image whenever resizing is unavailable or fails.
 */

export interface DownscaledImage {
	data: string;
	mimeType: string;
	wasDownscaled: boolean;
}

/** Max long edge in px — plenty for reading text/OCR from photos. */
const MAX_DIMENSION = 1568;
/** Max encoded (base64) size per image. */
const MAX_BYTES = 1024 * 1024;
const JPEG_QUALITY = 80;

export async function downscaleImage(base64Data: string, mimeType: string): Promise<DownscaledImage> {
	try {
		const { resizeImage } = await import("../node_modules/@mariozechner/pi-coding-agent/dist/utils/image-resize.js");
		const resized = await resizeImage(
			{ type: "image", data: base64Data, mimeType },
			{ maxWidth: MAX_DIMENSION, maxHeight: MAX_DIMENSION, maxBytes: MAX_BYTES, jpegQuality: JPEG_QUALITY }
		);
		if (resized && resized.data && resized.data.length < base64Data.length) {
			return { data: resized.data, mimeType: resized.mimeType, wasDownscaled: true };
		}
	} catch {
		// Resizing unavailable (e.g. Photon failed to load) — keep the original.
	}
	return { data: base64Data, mimeType, wasDownscaled: false };
}

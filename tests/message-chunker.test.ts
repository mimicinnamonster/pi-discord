import { describe, expect, it } from "vitest";
import { DISCORD_CHUNK_LIMIT, splitMessagePreservingCodeBlocks } from "../src/message-chunker.ts";

/**
 * Rebuild the user-visible text from chunks by removing the fence lines the
 * splitter adds to keep each chunk renderable.
 */
function visibleText(chunks: string[]): string {
	return chunks
		.map((chunk, index) => {
			let visible = chunk;
			if (index > 0 && visible.startsWith("```\n")) visible = visible.slice(4);
			if (index < chunks.length - 1 && visible.endsWith("\n```")) visible = visible.slice(0, -4);
			return visible;
		})
		.join("");
}

/** True when a chunk boundary falls between two backticks of the same run. */
function boundarySplitsBackticks(text: string, position: number): boolean {
	return position > 0 && position < text.length && text[position - 1] === "`" && text[position] === "`";
}

function fenceCount(text: string): number {
	return text.split("```").length - 1;
}

/** Boundary offsets of the visible text, i.e. where the splitter cut. */
function boundaryOffsets(chunks: string[]): number[] {
	const offsets: number[] = [];
	let total = 0;
	for (const chunk of chunks.slice(0, -1)) {
		let visible = chunk;
		if (visible.endsWith("\n```")) visible = visible.slice(0, -4);
		total += visible.length;
		offsets.push(total);
	}
	return offsets;
}

describe("splitMessagePreservingCodeBlocks", () => {
	it("returns a single chunk when the text fits", () => {
		expect(splitMessagePreservingCodeBlocks("Hello world", 2000)).toEqual(["Hello world"]);
	});

	it("splits plain text at maxLength", () => {
		const result = splitMessagePreservingCodeBlocks("a".repeat(2500), 2000);
		expect(result.map((chunk) => chunk.length)).toEqual([2000, 500]);
	});

	it("defaults to the Discord chunk limit under the 2000-char API limit", () => {
		expect(DISCORD_CHUNK_LIMIT).toBeLessThan(2000);
		const result = splitMessagePreservingCodeBlocks("a".repeat(DISCORD_CHUNK_LIMIT * 2));
		expect(result.every((chunk) => chunk.length <= DISCORD_CHUNK_LIMIT)).toBe(true);
	});

	it("keeps a short code block that crosses the limit intact", () => {
		const text = "x".repeat(1990) + "\n```\ncode here\n```";
		const result = splitMessagePreservingCodeBlocks(text, 2000);
		// The block does not fit behind the prefix, so it moves to its own chunk.
		expect(result.length).toBe(2);
		expect(result[1]).toContain("```");
		expect(result[1].endsWith("```")).toBe(true);
	});

	it("never returns a chunk over maxLength for a long code block", () => {
		// Regression: a fence opened before the limit used to make the splitter
		// emit the entire remainder as one chunk (observed: 3610 chars -> one
		// chunk -> DiscordAPIError[50035] content[BASE_TYPE_MAX_LENGTH]).
		const text = "```\n" + "line of log output\n".repeat(400) + "```";
		const result = splitMessagePreservingCodeBlocks(text, 1900);
		expect(result.length).toBeGreaterThan(1);
		for (const chunk of result) {
			expect(chunk.length).toBeLessThanOrEqual(1900);
		}
	});

	it("closes and re-opens the fence when splitting inside a code block", () => {
		const text = "```\n" + "code();\n".repeat(400) + "```";
		const result = splitMessagePreservingCodeBlocks(text, 1000);
		expect(result.length).toBeGreaterThan(1);
		// Every chunk but the last is closed, every chunk but the first re-opened.
		for (const chunk of result.slice(0, -1)) {
			expect(chunk.trimEnd().endsWith("```")).toBe(true);
		}
		for (const chunk of result.slice(1)) {
			expect(chunk.startsWith("```")).toBe(true);
		}
	});

	it("does not lose visible text when splitting inside a code block", () => {
		const body = "code();\n".repeat(400);
		const result = splitMessagePreservingCodeBlocks("```\n" + body + "```", 1000);
		const reassembled = result
			.join("")
			.replaceAll("```", "")
			.replaceAll("\n", "");
		expect(reassembled).toBe(body.replaceAll("\n", ""));
	});

	it("handles the 3610-char model-error payload that broke #uo", () => {
		const payload = "❌ **Model Error**\n```\n402: " + "{\"error\":\"credits\"}".repeat(200) + "\n```";
		expect(payload.length).toBeGreaterThan(2000);
		const result = splitMessagePreservingCodeBlocks(payload, DISCORD_CHUNK_LIMIT);
		for (const chunk of result) {
			expect(chunk.length).toBeLessThanOrEqual(DISCORD_CHUNK_LIMIT);
		}
		expect(result.join("")).toContain("Model Error");
	});

	it("handles a code block at the exact boundary", () => {
		const text = "x".repeat(1990) + "\n```\n" + "code\n" + "```";
		const result = splitMessagePreservingCodeBlocks(text, 2000);
		expect(result.every((chunk) => chunk.length <= 2000)).toBe(true);
	});

	it("keeps an unclosed fence from producing an oversized chunk", () => {
		const text = "```json\n" + "{\"k\": 1}\n".repeat(300);
		const result = splitMessagePreservingCodeBlocks(text, 1900);
		expect(result.length).toBeGreaterThan(1);
		for (const chunk of result) {
			expect(chunk.length).toBeLessThanOrEqual(1900);
		}
	});

	it("splits long single-line text with no newline at all", () => {
		const text = "z".repeat(10_000);
		const result = splitMessagePreservingCodeBlocks(text, 1900);
		expect(result.every((chunk) => chunk.length <= 1900)).toBe(true);
		expect(result.join("")).toBe(text);
	});

	// Regression: a fence opening right at the chunk boundary used to be cut in
	// half (chunk0 ended with "`", chunk1 began with "``ts"), so Discord showed
	// literal backticks and the block never re-opened.
	describe("fence opening at the chunk boundary", () => {
		const limit = 1900;
		const cases: Array<[label: string, openingAt: number]> = [
			["limit-3", limit - 3],
			["limit-2", limit - 2],
			["limit-1", limit - 1],
			["limit", limit],
			["limit+1", limit + 1],
			["limit+2", limit + 2],
		];

		it.each(cases)("keeps the fence token whole when it opens at %s", (_label, openingAt) => {
			const text = "a".repeat(openingAt) + "```ts\nconst x = 1;\nconst y = 2;\n```";
			const result = splitMessagePreservingCodeBlocks(text, limit);

			expect(result.every((chunk) => chunk.length <= limit)).toBe(true);
			expect(visibleText(result)).toBe(text);
			for (const offset of boundaryOffsets(result)) {
				expect(boundarySplitsBackticks(text, offset)).toBe(false);
			}
			// The fence must survive intact somewhere, not be shredded across chunks.
			expect(result.some((chunk) => chunk.includes("```ts"))).toBe(true);
		});

		it.each(cases)("never leaves an unclosed block or orphan backticks at %s", (_label, openingAt) => {
			const text = "a".repeat(openingAt) + "```ts\n" + "const v = 1;\n".repeat(200) + "```";
			const result = splitMessagePreservingCodeBlocks(text, limit);

			expect(result.every((chunk) => chunk.length <= limit)).toBe(true);
			expect(visibleText(result)).toBe(text);
			for (const offset of boundaryOffsets(result)) {
				expect(boundarySplitsBackticks(text, offset)).toBe(false);
			}
			// Every chunk of a balanced input must itself be balanced: no chunk may
			// end inside an open block.
			for (const chunk of result) {
				expect(fenceCount(chunk) % 2).toBe(0);
			}
		});
	});

	it("keeps a fence that opens mid-line at the boundary whole", () => {
		const text = "prefix text " + "b".repeat(1880) + "`inline` and ```js\nlet a = 1;\n```";
		const result = splitMessagePreservingCodeBlocks(text, 1900);
		expect(result.every((chunk) => chunk.length <= 1900)).toBe(true);
		expect(visibleText(result)).toBe(text);
		for (const offset of boundaryOffsets(result)) {
			expect(boundarySplitsBackticks(text, offset)).toBe(false);
		}
	});
});

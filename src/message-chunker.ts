/**
 * Discord message chunker.
 *
 * Discord rejects any message whose content exceeds 2000 characters with
 * `DiscordAPIError[50035] content[BASE_TYPE_MAX_LENGTH]` — and it rejects it
 * *permanently*: every retry sends the same oversized payload. That is how a
 * 3610-char error report reached the user as silence.
 *
 * The invariant enforced here: every returned chunk is <= maxLength. Length is
 * measured on the final string, including any fence lines the splitter itself
 * adds, so a chunk can never exceed the limit because of transport syntax.
 */

/** Conservative chunk budget: Discord's hard limit is 2000. */
export const DISCORD_CHUNK_LIMIT = 1900;

const FENCE = "```";

/** Number of non-overlapping ``` occurrences in `text`. */
function countFences(text: string): number {
	let count = 0;
	let index = text.indexOf(FENCE);
	while (index !== -1) {
		count++;
		index = text.indexOf(FENCE, index + FENCE.length);
	}
	return count;
}

/**
 * Move `cut` left so the chunk boundary never lands inside a run of backticks.
 *
 * Cutting between two backticks turns one ``` fence into ``` + `` — Discord then
 * renders the leftovers as literal backticks and never re-opens the block.
 */
function avoidSplittingFence(text: string, cut: number): number {
	let adjusted = cut;
	while (adjusted > 0 && text[adjusted - 1] === "`" && text[adjusted] === "`") {
		adjusted--;
	}
	return adjusted > 0 ? adjusted : cut;
}

/** How far back a boundary may move to land on a newline instead of mid-line. */
const NEWLINE_SNAP_WINDOW = 64;

/** Prefer a newline boundary when one is close behind `cut`. */
function preferNewline(text: string, cut: number): number {
	const newline = text.lastIndexOf("\n", cut - 1);
	if (newline > 0 && cut - (newline + 1) <= NEWLINE_SNAP_WINDOW) return newline + 1;
	return cut;
}

/** Start index of the last complete fence that begins before `cut`, or -1. */
function lastFenceBefore(text: string, cut: number): number {
	return text.lastIndexOf(FENCE, cut - 1);
}

/** Index of the last newline in text[0, limit), or limit when there is none. */
function lastBreakBefore(text: string, limit: number): number {
	const newline = text.lastIndexOf("\n", limit - 1);
	return newline > 0 ? newline + 1 : limit;
}

/**
 * Last-resort hard split that keeps the length invariant even if a heuristic
 * above ever regresses. Prefers a newline boundary to keep text readable.
 */
function forceSplit(chunk: string, maxLength: number): string[] {
	if (chunk.length <= maxLength) return [chunk];
	const parts: string[] = [];
	let remaining = chunk;
	while (remaining.length > maxLength) {
		let cut = avoidSplittingFence(remaining, lastBreakBefore(remaining, maxLength));
		if (cut <= 0) cut = maxLength;
		parts.push(remaining.slice(0, cut));
		remaining = remaining.slice(cut);
	}
	if (remaining.length > 0) parts.push(remaining);
	return parts;
}

/**
 * Split Discord message content into chunks of at most `maxLength` characters,
 * preferring not to break fenced code blocks.
 *
 * When a block is too long to fit in one chunk, the chunk is closed with a fence
 * and the remainder is re-opened with a fresh fence, so both halves still render
 * as code. The added fence lines are transport syntax; no user-visible text is
 * ever dropped.
 */
export function splitMessagePreservingCodeBlocks(text: string, maxLength: number = DISCORD_CHUNK_LIMIT): string[] {
	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}

		const fencesInVisible = countFences(remaining.slice(0, maxLength));

		if (fencesInVisible % 2 === 1) {
			// The boundary lands inside a code block. Cut inside the block, close
			// the fence, and re-open it at the start of the next chunk. "\n```"
			// costs four characters, so the visible part gets maxLength - 4.
			const budget = maxLength - FENCE.length - 1;
			const cut = preferNewline(remaining, avoidSplittingFence(remaining, budget));
			if (countFences(remaining.slice(0, cut)) % 2 === 0) {
				// Retreating over a fence token moved the cut out of the block, so
				// there is nothing to close — emit the prefix as-is.
				chunks.push(remaining.slice(0, cut));
				remaining = remaining.slice(cut);
				continue;
			}
			chunks.push(remaining.slice(0, cut) + "\n" + FENCE);
			remaining = FENCE + "\n" + remaining.slice(cut);
			continue;
		}

		// Boundary is outside any code block. If a block starts just past the
		// limit, close this chunk before the block so the block stays intact —
		// unless the block is itself longer than a chunk, in which case the
		// branch above handles it on the next iteration.
		let cut = maxLength;
		const nearBoundary = remaining.slice(maxLength, maxLength + 50);
		const openingIndex = nearBoundary.indexOf(FENCE);
		if (openingIndex !== -1) {
			const openingAt = maxLength + openingIndex;
			const closingAt = remaining.indexOf(FENCE, openingAt + FENCE.length);
			const blockEnd = closingAt === -1 ? -1 : closingAt + FENCE.length;
			if (blockEnd === -1 || blockEnd > maxLength) {
				// lastBreakBefore can return a position past the limit when the block
				// starts past it; clamp so the chunk stays within maxLength.
				cut = Math.min(lastBreakBefore(remaining, openingAt), maxLength);
			}
		}
		// The plain cut can land inside a backtick run, so back it up first.
		cut = avoidSplittingFence(remaining, cut);
		cut = preferNewline(remaining, cut);
		if (cut <= 0) cut = maxLength;

		if (countFences(remaining.slice(0, cut)) % 2 === 1) {
			// Backing up left the chunk inside a block. Drop back to just before the
			// opening fence so the whole block travels with the next chunk.
			const opening = lastFenceBefore(remaining, cut);
			if (opening > 0) {
				chunks.push(remaining.slice(0, opening));
				remaining = remaining.slice(opening);
				continue;
			}
			// No reachable opening fence: close the chunk instead of leaving it open.
			const budget = Math.min(cut, maxLength - FENCE.length - 1);
			if (budget > 0) {
				chunks.push(remaining.slice(0, budget) + "\n" + FENCE);
				remaining = FENCE + "\n" + remaining.slice(budget);
				continue;
			}
		}

		chunks.push(remaining.slice(0, cut));
		remaining = remaining.slice(cut);
	}

	return chunks.filter((chunk) => chunk.length > 0).flatMap((chunk) => forceSplit(chunk, maxLength));
}

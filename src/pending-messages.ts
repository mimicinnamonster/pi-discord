/**
 * Durable store for user messages that could not be sent to the agent right
 * away because the channel was still draining background subagent work.
 *
 * The pi SDK accepts those messages with `deliverAs: "followUp"` and only
 * materialises them when the current run settles. If the run never settles
 * (an orphaned background subagent keeps its `agent_end` handler waiting), the
 * follow-up dies with the run and the user's message is gone — that is how two
 * messages were silently dropped in #forth.
 *
 * Messages are therefore persisted here BEFORE being handed to the SDK, and the
 * entry is only deleted once the message actually shows up as a user message in
 * the session, or is successfully answered after a replay.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

export interface PendingMessage {
	channelId: string;
	/** Discord message snowflake: the identity used to de-duplicate replays. */
	discordMessageId: string;
	authorId?: string;
	authorName?: string;
	/** Text content exactly as it will be sent to the agent. */
	content: string;
	/** Epoch ms at which the message was parked. */
	queuedAt: number;
	/** Why the message could not go straight to the agent. */
	reason: string;
}

interface PendingMessageFile {
	version: 1;
	messages: PendingMessage[];
}

export interface PendingMessageStore {
	/** Persist a message before it is handed to the SDK. */
	add(message: PendingMessage): void;
	/** Drop a message that has been delivered (or answered after a replay). */
	remove(channelId: string, discordMessageId: string): boolean;
	forChannel(channelId: string): PendingMessage[];
	all(): PendingMessage[];
	size(): number;
}

export interface PendingMessageStoreOptions {
	/** Injectable for tests. */
	now?: () => number;
	/** Injectable for tests; defaults to console.log. */
	log?: (message: string) => void;
}

export const PENDING_MESSAGES_FILE = "pending-messages.json";

export function createPendingMessageStore(
	filePath: string,
	options: PendingMessageStoreOptions = {}
): PendingMessageStore {
	const log = options.log ?? ((message: string) => console.log(message));
	let messages: PendingMessage[] = load();

	function load(): PendingMessage[] {
		try {
			if (!existsSync(filePath)) return [];
			const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<PendingMessageFile>;
			const raw = Array.isArray(parsed?.messages) ? parsed.messages : [];
			return raw.filter(
				(entry): entry is PendingMessage =>
					typeof entry?.channelId === "string" &&
					typeof entry?.discordMessageId === "string" &&
					typeof entry?.content === "string"
			);
		} catch (error) {
			// A corrupt file must not stop the bot: keep the broken file for
			// inspection and start empty rather than crashing on startup.
			log(`[pending-messages] Failed to read ${filePath}: ${error}`);
			return [];
		}
	}

	function persist(): void {
		try {
			const payload: PendingMessageFile = { version: 1, messages };
			mkdirSync(dirname(filePath), { recursive: true });
			const tmpPath = `${filePath}.tmp`;
			// Write-then-rename: a crash mid-write must never truncate the store.
			writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
			renameSync(tmpPath, filePath);
		} catch (error) {
			log(`[pending-messages] Failed to write ${filePath}: ${error}`);
		}
	}

	return {
		add(message: PendingMessage): void {
			const existing = messages.findIndex(
				(entry) => entry.channelId === message.channelId && entry.discordMessageId === message.discordMessageId
			);
			if (existing !== -1) {
				messages[existing] = message;
			} else {
				messages.push(message);
			}
			persist();
			log(
				`[pending-messages] Queueing message ${message.discordMessageId} for ${message.channelId} ` +
					`(${message.reason}) — persisted`
			);
		},

		remove(channelId: string, discordMessageId: string): boolean {
			const before = messages.length;
			messages = messages.filter(
				(entry) => !(entry.channelId === channelId && entry.discordMessageId === discordMessageId)
			);
			if (messages.length === before) return false;
			persist();
			log(`[pending-messages] Delivered queued message ${discordMessageId} in ${channelId}`);
			return true;
		},

		forChannel(channelId: string): PendingMessage[] {
			return messages.filter((entry) => entry.channelId === channelId);
		},

		all(): PendingMessage[] {
			return [...messages];
		},

		size(): number {
			return messages.length;
		},
	};
}

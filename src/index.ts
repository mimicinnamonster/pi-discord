/**
 * pi-discord - Standalone Discord Bot
 * Discord integration for pi coding agent using the SDK
 */

import { Client, GatewayIntentBits, ChannelType, ThreadChannel, DMChannel, TextChannel, NewsChannel, Message } from "discord.js";
import { createSessionStore } from "./session-store";
import { TypingManager } from "./typing-manager";
import { generateTokenStatsMessage } from "./token-stats";
import type { AgentSession, AgentSessionEvent, SessionMessageEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";
import { writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import {
	loadBranchMetadata,
	saveBranchMetadata,
	findCommonAncestor,
	getMessagesBetween,
	formatMergedMessages,
} from "./branch-manager";

// ============================================================================
// Configuration
// ============================================================================

const discordToken = process.env.DISCORD_BOT_TOKEN;
const debug = process.env.DISCORD_DEBUG === "true";
const sessionDir = process.env.PI_DISCORD_SESSION_DIR || join(homedir(), ".pi-discord", "sessions");

// ============================================================================
// Logging
// ============================================================================

function log(...args: unknown[]) {
	if (debug) {
		console.log(`[discord][${new Date().toISOString()}]`, ...args);
	}
}

// ============================================================================
// Validate Configuration
// ============================================================================

if (!discordToken) {
	console.error("[discord] ERROR: DISCORD_BOT_TOKEN environment variable is required");
	process.exit(1);
}

// ============================================================================
// Global State
// ============================================================================

let discordClient: Client | null = null;
const sessionStore = createSessionStore({ sessionDir, debug });
const typingManager = new TypingManager();

// Track Discord message IDs to session entry indices for deletion handling
// Map structure: channelId -> discordMessageId -> { sessionIndex, type: 'user' | 'assistant' | 'tool' | 'thinking' }
const discordMessageToSession = new Map<string, Map<string, { sessionIndex: number; type: string }>>();
const sessionMessageIndex = new Map<string, number>(); // Track current message index per channel

// Track the last thinking message ID per channel for editing
const lastThinkingMessageId = new Map<string, string>();

// Track previous token counts per channel for utilization alerts
const previousTokens = new Map<string, { contextPercent: number; inputTokens: number; outputTokens: number }>();

// Track queued prompts per channel (persisted to disk)
const promptQueue = new Map<string, string[]>();

// Track active session labels per channel (set via /label or /session [label])
const sessionLabels = new Map<string, string>();

function savePromptQueue(): void {
	try {
		const obj: Record<string, string[]> = {};
		for (const [ch, q] of promptQueue) {
			if (q.length > 0) obj[ch] = q;
		}
		writeFileSync(join(sessionDir, "queues.json"), JSON.stringify(obj, null, 2));
	} catch {}
}

function loadPromptQueue(): void {
	try {
		const path = join(sessionDir, "queues.json");
		if (existsSync(path)) {
			const obj = JSON.parse(readFileSync(path, "utf-8"));
			for (const [ch, q] of Object.entries(obj)) {
				promptQueue.set(ch, q as string[]);
			}
		}
	} catch {}
}

/** Build a map of session UUID → channel ID by scanning Discord session files. */
function buildSessionChannelMap(): Map<string, string> {
	const uuidToChannel = new Map<string, string>();
	const sessionDir = join(homedir(), ".pi-discord", "sessions");
	if (!existsSync(sessionDir)) return uuidToChannel;
	try {
		for (const file of readdirSync(sessionDir)) {
			const match = file.match(/^discord-(\d+)\.jsonl$/);
			if (!match) continue;
			const chId = match[1];
			try {
				const firstLine = readFileSync(join(sessionDir, file), "utf-8").split("\n")[0];
				const meta = JSON.parse(firstLine);
				if (meta.id) uuidToChannel.set(meta.id, chId);
			} catch {}
		}
	} catch {}
	return uuidToChannel;
}

/**
 * Restore sessions for channels with scheduled prompts.
 *
 * On startup, reads schedule-prompts.json, strips session-scoping so jobs fire
 * regardless of which pi session created them, and pre-creates Discord sessions
 * for every channel that has an enabled cron job — so the pi-schedule-prompt
 * scheduler has a live session to fire into.
 */
function restoreScheduledSessions(): void {
	try {
		const path = join(process.cwd(), ".pi", "schedule-prompts.json");
		if (!existsSync(path)) return;

		const data = JSON.parse(readFileSync(path, "utf-8"));
		const jobs: any[] = data.jobs || [];
		if (jobs.length === 0) return;

		// Build UUID → channelId map from existing Discord sessions
		const uuidToChannel = buildSessionChannelMap();

		let dirty = false;
		const channelsToCreate = new Set<string>();

		for (const job of jobs) {
			// --- Resolve channel from description (persisted format) ---
			const descMatch = job.description?.match(/^channel:(\d+)/);
			if (descMatch) {
				channelsToCreate.add(descMatch[1]);
			}

			// --- Resolve channel from session UUID (first-time after creation) ---
			if (job.session) {
				const chId = uuidToChannel.get(job.session);
				if (chId) {
					channelsToCreate.add(chId);
					// Persist the channel association so we don't need the UUID next time
					if (!job.description?.startsWith("channel:")) {
						job.description = `channel:${chId} - ${job.description || "auto"}`;
					}
				}
				delete job.session;
				dirty = true;
			}
		}

		if (dirty) {
			writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
			console.log(`[discord] Stripped session field from jobs, identified ${channelsToCreate.size} channel(s) for scheduled prompts`);
		}

		for (const chId of channelsToCreate) {
			console.log(`[discord] Pre-creating session for scheduled channel ${chId}`);
			sessionStore.getOrCreate(chId).catch((err) => {
				console.error(`[discord] Failed to pre-create session for ${chId}:`, err);
			});
		}
	} catch {}
}

/**
 * Periodically ensure that every enabled cron job has a live Discord session.
 *
 * pi-schedule-prompt only fires while a session is open in this directory.
 * Since pi-discord creates sessions on-demand when users chat, cron jobs at
 * quiet hours would be silently skipped. This keeper checks every 60 seconds
 * and creates sessions for any channel that has an enabled scheduled job but
 * no active session.
 */
function startSessionKeeper(): void {
	setInterval(() => {
		try {
			const path = join(process.cwd(), ".pi", "schedule-prompts.json");
			if (!existsSync(path)) return;

			const data = JSON.parse(readFileSync(path, "utf-8"));
			const jobs: any[] = data.jobs || [];

			for (const job of jobs) {
				if (!job.enabled) continue;
				const descMatch = job.description?.match(/^channel:(\d+)/);
				if (!descMatch) continue;
				const chId = descMatch[1];
				if (!sessionStore.has(chId)) {
					console.log(`[discord] Session keeper: creating session for channel ${chId} (job: ${job.name || job.id})`);
					sessionStore.getOrCreate(chId).catch(() => {});
				}
			}
		} catch {}
	}, 60_000);
}

// Track pending Discord message IDs being processed (for branch metadata)
// Map structure: channelId -> discordMessageId
const pendingDiscordMessages = new Map<string, string>();

/**
 * After deleting a message at index, decrement all tracked indices higher than it.
 */
function fixIndicesAfterDeletion(channelId: string, deletedIndex: number): void {
	const channelMap = discordMessageToSession.get(channelId);
	if (!channelMap) return;

	for (const [msgId, tracked] of channelMap.entries()) {
		if (tracked.sessionIndex > deletedIndex) {
			tracked.sessionIndex--;
		}
	}
}

// ============================================================================
// Helper Functions
// ============================================================================

function isThread(channel: unknown): channel is ThreadChannel {
	return (channel as ThreadChannel)?.isThread?.() === true;
}

/**
 * Escape content to prevent Discord markdown issues in code blocks.
 * Replaces triple backticks with a safe alternative.
 */
function escapeForCodeBlock(text: string): string {
	return text.replace(/```/g, "`\u200b``\u200b``");
}

// ============================================================================
// Discord Message Handling
// ============================================================================

function splitMessagePreservingCodeBlocks(text: string, maxLength: number): string[] {
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
}

/**
 * Detect content type and determine appropriate file extension.
 */
function getContentExtension(text: string, type?: string): string {
	// Check for git diff output
	if (text.includes("diff --git") || text.startsWith("diff ") || text.match(/^--- |^\+\+\+ /m)) {
		return "diff";
	}

	// Check for git patch
	if (text.match(/^From [a-f0-9]+ /m) || text.includes("--- a/") || text.includes("--- a\\")) {
		return "patch";
	}

	// Check for JSON
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		return "json";
	}
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return "json";
	}

	// Check for HTML/XML
	if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || trimmed.startsWith("<?xml")) {
		return "html";
	}

	// Check for log files
	if (type === "tool" && text.includes("command")) {
		return "sh";
	}

	// Default to txt for plain text output
	return "md";
}

/**
 * Upload text content as a Discord attachment file.
 */
async function uploadAsFile(
	channel: DMChannel | TextChannel | NewsChannel,
	text: string,
	filename: string = "output.txt",
	type?: string
): Promise<Message | null> {
	try {
		// Determine appropriate extension based on content
		const ext = getContentExtension(text, type);
		const finalFilename = filename.replace(/\.[^.]+$/, `.${ext}`);

		log(`[${channel.id}] Uploading as file: ${finalFilename} (${text.length} chars)`);
		// Use files array format for discord.js
		const msg = await channel.send({
			content: "📎 Output attached",
			files: [{
				attachment: Buffer.from(text, "utf-8"),
				name: finalFilename,
			}],
		});
		log(`[${channel.id}] File uploaded successfully: ${msg.id}`);
		return msg;
	} catch (error) {
		log(`[${channel.id}] ERROR uploading file: ${error}`);
		return null;
	}
}

/**
 * Threshold for uploading as file instead of splitting.
 * Discord has a 2000 char limit per message.
 * We use 2000 to trigger file upload before splitting would fail.
 */
const FILE_UPLOAD_THRESHOLD = 2000;

/** Update the previous token tracking data for delta calculations */
function updatePreviousTokens(
	channelId: string,
	session: AgentSession
) {
	const stats = session.getSessionStats();
	const contextUsage = stats.contextUsage;
	const contextPercent = contextUsage?.percent ?? 0;
	previousTokens.set(channelId, {
		contextPercent,
		inputTokens: stats.tokens.input,
		outputTokens: stats.tokens.output,
	});
}

async function sendToDiscord(
	channel: DMChannel | TextChannel | NewsChannel,
	text: string,
	options?: { trackInSession?: boolean; type?: string; replyToMessageId?: string }
): Promise<Message[]> {
	if (!text.trim()) return [];

	log(`[${channel.id}] sendToDiscord called with: "${text.substring(0, 100)}" (${text.length} chars)`);

	// For very long messages, upload as a file instead of splitting
	if (text.length > FILE_UPLOAD_THRESHOLD) {
		log(`[${channel.id}] Message exceeds ${FILE_UPLOAD_THRESHOLD} chars, uploading as file`);
		const msg = await uploadAsFile(channel, text, "output.txt", options?.type);
		if (msg) {
			// Track the file message if needed
			if (options?.trackInSession) {
				if (!discordMessageToSession.has(channel.id)) {
					discordMessageToSession.set(channel.id, new Map());
				}
				const channelMap = discordMessageToSession.get(channel.id)!;
				const currentIndex = sessionMessageIndex.get(channel.id) ?? 0;
				channelMap.set(msg.id, { sessionIndex: currentIndex, type: options.type ?? "unknown" });
			}
			return [msg];
		}
		// If upload failed, fall back to splitting
		log(`[${channel.id}] File upload failed, falling back to splitting`);
	}

	const maxLength = 2000;
	const chunks = splitMessagePreservingCodeBlocks(text, maxLength);

	log(`[${channel.id}] Will send ${chunks.length} chunk(s)`);

	const sentMessages: Message[] = [];

	// Send chunks sequentially to preserve order
	let isFirstChunk = true;
	for (const chunk of chunks) {
		log(`[${channel.id}] Actually sending chunk: "${chunk.substring(0, 50)}..."`);
		try {
			const sendOptions = isFirstChunk && options?.replyToMessageId
				? { content: chunk, reply: { messageReference: options.replyToMessageId } }
				: chunk;
			const msg = await channel.send(sendOptions);
			isFirstChunk = false;
			log(`[${channel.id}] Message sent successfully: ${msg.id}`);
			sentMessages.push(msg);

			// Track Discord message ID for session deletion handling
			if (options?.trackInSession) {
				if (!discordMessageToSession.has(channel.id)) {
					discordMessageToSession.set(channel.id, new Map());
				}
				const channelMap = discordMessageToSession.get(channel.id)!;
				const currentIndex = sessionMessageIndex.get(channel.id) ?? 0;
				channelMap.set(msg.id, { sessionIndex: currentIndex, type: options.type ?? "unknown" });
			}
		} catch (sendError) {
			log(`[${channel.id}] ERROR sending message: ${sendError}`);
			throw sendError; // Re-throw so callers can handle
		}
	}

	return sentMessages;
}

function subscribeToSession(
	session: AgentSession,
	channelId: string,
	channel: DMChannel | TextChannel | NewsChannel,
	typingManager: TypingManager,
	sessionDir: string
): { setPendingDiscordMessageId: (id: string, isReply: boolean) => void } {
	// Direct fetch to Discord typing endpoint — bypasses Discord.js's sendTyping()
	// which wraps the REST client and can cause issues with rate-limit retries.
	const typingChannel: TypingChannel = {
		triggerTyping: async () => {
			const token = discordClient?.token;
			if (!token) return false;
			try {
				const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/typing`, {
					method: "POST",
					headers: { "Authorization": `Bot ${token}` },
				});
				if (res.status === 429) {
					// Rate limited — Discord keeps the limit per token, just skip
					return false;
				}
				return res.ok;
			} catch {
				return false;
			}
		},
	};
	const responseBuffer: string[] = [];
	const thinkingBuffer: string[] = [];
	let lastUserMessageEntryId: string | undefined;
	let lastDiscordMessageId: string | undefined;
	let lastMessageIsReply = false;
	let pendingDiscordMsgId: string | undefined;
	let pendingIsReply = false;
	// Captured at agent_end (synchronous, all messages appended) for use in .then()
	let capturedAssistantEntryId: string | null = null;


	session.subscribe(async (event: AgentSessionEvent) => {
		switch (event.type) {
			case "agent_start":
				log(`[${channelId}] Agent starting...`);
				responseBuffer.length = 0;
				// LLM is processing - show typing indicator
				typingManager.show(channelId, typingChannel);
				break;

			case "message_start":
				if (event.message.role === "user") {
					// Capture pending discord info - entry id captured on message_end when appended
					lastDiscordMessageId = pendingDiscordMsgId;
					lastMessageIsReply = pendingIsReply;
					log(`[${channelId}] User message started, discordMsg=${lastDiscordMessageId}, isReply=${lastMessageIsReply}`);
				} else if (event.message.role === "assistant") {
					log(`[${channelId}] Assistant message started`);
					responseBuffer.length = 0;
					thinkingBuffer.length = 0;
					// Increment session index for this new assistant message
					const currentIdx = (sessionMessageIndex.get(channelId) ?? 0) + 1;
					sessionMessageIndex.set(channelId, currentIdx);
					// LLM is generating response - show typing indicator
					typingManager.show(channelId, typingChannel);
				}
				break;

			case "message_update": {
				const assistantEvent = event.assistantMessageEvent;
				log(`[${channelId}] message_update type: ${assistantEvent?.type}`);
				if (assistantEvent?.type === "text_delta") {
					log(`[${channelId}] text_delta: "${assistantEvent.delta}" (${assistantEvent.delta?.length || 0} chars)`);
					responseBuffer.push(assistantEvent.delta);
				}
				if (assistantEvent?.type === "thinking_delta") {
					log(`[${channelId}] thinking_delta: "${assistantEvent.delta}"`);
					// Show typing indicator when thinking starts
					typingManager.show(channelId, typingChannel);
					thinkingBuffer.push(assistantEvent.delta);
					// Only send when thinking is complete (on message_end) to avoid spam
				}
				break;
			}

			case "message_end":
				if (event.message.role === "assistant") {
					// Send thinking only once when complete (not streaming)
					const fullThinking = thinkingBuffer.join("");
					if (fullThinking.trim().length > 10) {
						log(`[${channelId}] Sending completed thinking (${fullThinking.length} chars)`);
						sendToDiscord(channel, `💭 Thinking\n\`\`\`\n${escapeForCodeBlock(fullThinking)}\n\`\`\``, { trackInSession: true, type: "thinking" }).catch(() => {});
					}

					// Send response and collect Discord message IDs to be mapped at agent_end
					const fullResponse = responseBuffer.join("");
					if (fullResponse.trim()) {
						log(`[${channelId}] Sending response (${fullResponse.length} chars)`);
						const replyToId = lastMessageIsReply ? lastDiscordMessageId : undefined;
						sendToDiscord(channel, fullResponse, { trackInSession: true, type: "response", replyToMessageId: replyToId }).then((msgs) => {
							// Use capturedAssistantEntryId set at agent_end (synchronous before this .then())
							const assistantEntryId = capturedAssistantEntryId;
							if (assistantEntryId && msgs.length > 0) {
								const metadata = loadBranchMetadata(sessionDir, channelId);
								for (const msg of msgs) {
									metadata.discordMsgToPiEntryId.set(msg.id, assistantEntryId);
									log(`[${channelId}] Tracked bot response ${msg.id} → Pi entry ${assistantEntryId}`);
								}
								saveBranchMetadata(sessionDir, channelId, metadata);
							}
						}).catch((error) => {
							console.error(`[${channelId}] Failed to send response:`, error);
						});
					} else if (event.message.stopReason === "error" && event.message.errorMessage) {
						// SEND ERROR TO DISCORD
						console.error(`[${channelId}] Model Error: ${event.message.errorMessage}`);
						log(`[${channelId}] Sending error response: ${event.message.errorMessage}`);
						sendToDiscord(channel, `❌ **Model Error**\n\`\`\`\n${escapeForCodeBlock(event.message.errorMessage)}\n\`\`\``, { trackInSession: true, type: "response" }).catch(() => {});
					}

					responseBuffer.length = 0;
					thinkingBuffer.length = 0;
					// Don't hide typing on message_end — it fires mid-turn for tool calls,
					// causing flickering. agent_end handles the final cleanup.
				}
				break;

			case "tool_execution_start": {
				log(`[${channelId}] Tool started: ${event.toolName}`);
				const args = escapeForCodeBlock(JSON.stringify(event.args, null, 2));
				// Increment session index for tool calls
				const currentIdx = (sessionMessageIndex.get(channelId) ?? 0) + 1;
				sessionMessageIndex.set(channelId, currentIdx);
				sendToDiscord(channel, `🔧 Running \`${event.toolName}\`\n\`\`\`json\n${args}\n\`\`\``, { trackInSession: true, type: "tool" }).catch(() => {});
				// Keep typing indicator visible during tool execution
				typingManager.show(channelId, typingChannel);
				break;
			}

			case "tool_execution_update":
				// Streaming tool output
				break;

			case "tool_execution_end":
				log(`[${channelId}] Tool ended: ${event.toolName} (error: ${event.isError})`);
				if (event.isError) {
					const result = escapeForCodeBlock(JSON.stringify(event.result, null, 2));
					sendToDiscord(channel, `⚠️ Tool execution failed\n\`\`\`json\n${result}\n\`\`\``, { trackInSession: true, type: "tool-error" }).catch(() => {});
				} else {
					// Send success result for tools like 'remember'
					if (typeof event.result === 'string' && event.result.startsWith('✅')) {
						sendToDiscord(channel, event.result, { trackInSession: true, type: "tool-success" }).catch(() => {});
					}
				}
				break;

			case "agent_end":
				log(`[${channelId}] Agent ended`);
				// Ensure typing is hidden (defensive, normally message_end handles this)
				typingManager.hide(channelId);
				// Capture assistant entry NOW (synchronous, all messages appended)
				// The .then() callback will use this to track bot response Discord msg IDs
				capturedAssistantEntryId = session.sessionManager.getLeafId();

				// Token utilization alert on agent_end (catches final response if message_end didn't fire)
				try {
					const statsResult = generateTokenStatsMessage(channelId, session, previousTokens);
					if (statsResult && statsResult.shouldAlert) {
						sendToDiscord(channel, statsResult.message, { trackInSession: false }).catch(() => {});
					}
					updatePreviousTokens(channelId, session);
				} catch (e) {
					log(`[${channelId}] Error calculating token utilization: ${e}`);
				}

				// Process queued prompts
				try {
					const queue = promptQueue.get(channelId);
					if (queue && queue.length > 0) {
						const nextPrompt = queue.shift();
						if (nextPrompt) {
							promptQueue.set(channelId, queue);
							savePromptQueue();
							log(`[${channelId}] Processing queued prompt: ${nextPrompt.slice(0, 50)}...`);
							
							// Send notification about queued prompt being executed
							await sendToDiscord(channel, `🚀 **Executing queued prompt:**\n${nextPrompt.length > 200 ? nextPrompt.slice(0, 200) + '...' : nextPrompt}`, { trackInSession: false });
							
							// Send the queued prompt to the agent
							await session.sendUserMessage(nextPrompt);
						}
					}
				} catch (e) {
					log(`[${channelId}] Error processing queue: ${e}`);
				}
				break;

			case "compaction_start":
				typingManager.show(channelId, typingChannel);
				log(`[${channelId}] Compacting context...`);
				sendToDiscord(channel, "📦 Compacting context...").catch(() => {});
				break;

			case "compaction_end":
				typingManager.hide(channelId);
				log(`[${channelId}] Compaction complete`);
				break;

			case "auto_retry_start":
				typingManager.show(channelId, typingChannel);
				log(`[${channelId}] Retrying (attempt ${event.attempt}/${event.maxAttempts}). Error message: ${event.errorMessage}`);
				sendToDiscord(channel, `⚠️ Retrying (attempt ${event.attempt}/${event.maxAttempts})...\nError:\n\`\`\`\n${escapeForCodeBlock(event.errorMessage)}\n\`\`\``).catch(() => {});
				break;

			case "auto_retry_end":
				typingManager.hide(channelId);
				log(`[${channelId}] Retry ${event.success ? "succeeded" : "failed"}`);
        if (!event.success) {
          sendToDiscord(channel, "🛑 Retry failed...").catch(() => {});
        }
				break;
		}
	});

	return {
		setPendingDiscordMessageId: (id: string, isReply: boolean) => {
			pendingDiscordMsgId = id;
			pendingIsReply = isReply;
		},
	};
}

// ============================================================================
// Main
// ============================================================================

async function main() {
	console.log("[discord] Starting pi-discord bot...");
	console.log(`[discord] Session directory: ${sessionDir}`);

	// =========================================================================
	// Initialize Discord Client
	// =========================================================================
	discordClient = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.DirectMessages,
			GatewayIntentBits.MessageContent,
			GatewayIntentBits.DirectMessageReactions,
			GatewayIntentBits.GuildMessageReactions,
		],
	});

	// Handle Discord ready
	discordClient.once("clientReady", () => {
		console.log(`[discord] Bot logged in as ${discordClient?.user?.tag}`);
	});

	// Handle errors
	discordClient.on("error", (error) => {
		console.error("[discord] Client error:", error);
	});

	// Handle disconnection with auto-reconnect
	discordClient.on("disconnect", () => {
		log("Discord client disconnected, attempting to reconnect...");
		setTimeout(() => {
			discordClient?.login(discordToken);
		}, 5000);
	});

	// Login to Discord
	await discordClient.login(discordToken);

	// =========================================================================
	// Message Handler
	// =========================================================================
	discordClient.on("messageCreate", async (message) => {
		// Ignore bot messages
		if (message.author.bot) return;

		// If there's no text AND no attachments, ignore the message
		if (!message.content?.trim() && message.attachments.size === 0) return;

		log(`[${message.channelId}] Message from ${message.author.tag}: ${message.content?.slice(0, 100) || "[No text]"}...`);

		// Handle DM channels
		if (message.channel.type === ChannelType.DM) {
			await handleMessage(message.channel as DMChannel, message);
			return;
		}

		// Handle thread messages
		if (isThread(message.channel)) {
			await handleMessage(message.channel, message);
			return;
		}

		// Handle regular text channel messages
		if (message.channel.type === ChannelType.GuildText) {
			await handleMessage(message.channel as TextChannel, message);
			return;
		}
	});

	// =========================================================================
	// Message Deletion Handler
	// =========================================================================
	discordClient.on("messageDelete", async (message) => {
		const channelId = message.channelId;
		const discordMessageId = message.id;

		log(`[${channelId}] Message deleted: ${discordMessageId}`);

		// Clean up branch metadata
		const metadata = loadBranchMetadata(sessionDir, channelId);
		metadata.discordMsgToPiEntryId.delete(discordMessageId);
		metadata.discordMsgParent.delete(discordMessageId);

		// Remove labels pointing to this message
		for (const [labelName, labelInfo] of metadata.labels) {
			if (labelInfo.discordMessageId === discordMessageId) {
				metadata.labels.delete(labelName);
				log(`[${channelId}] Removed label ${labelName} (Discord message deleted)`);
			}
		}

		saveBranchMetadata(sessionDir, channelId, metadata);

		// Look up if we track this Discord message in the old tracking system
		const channelMap = discordMessageToSession.get(channelId);
		if (!channelMap) {
			log(`[${channelId}] No tracked messages for this channel`);
			return;
		}

		const tracked = channelMap.get(discordMessageId);
		if (!tracked) {
			log(`[${channelId}] Warning: Deleted message ${discordMessageId} was not tracked in session`);
			return;
		}

		// Get the session and remove the corresponding message
		const discordSession = sessionStore.get(channelId);
		if (!discordSession) {
			log(`[${channelId}] No session found for channel`);
			channelMap.delete(discordMessageId);
			return;
		}

		const { session } = discordSession;
		const messages = session.messages;

		// Find and remove the message at the tracked index
		if (tracked.sessionIndex >= 0 && tracked.sessionIndex < messages.length) {
			const removed = messages.splice(tracked.sessionIndex, 1);
			log(`[${channelId}] Removed message from session: ${removed[0]?.role} (index ${tracked.sessionIndex})`);
			// Fix indices after deletion to prevent drift
			fixIndicesAfterDeletion(channelId, tracked.sessionIndex);
		} else {
			log(`[${channelId}] Warning: Session index ${tracked.sessionIndex} out of bounds (${messages.length} messages)`);
		}

		// Remove from tracking map
		channelMap.delete(discordMessageId);
	});

	discordClient.on("messageDeleteBulk", async (messages) => {
		// Group messages by channel and sort by index descending
		const byChannel = new Map<string, Array<{ msgId: string; tracked: { sessionIndex: number; type: string } }>>();

		for (const message of messages.values()) {
			const channelId = message.channelId;
			const discordMessageId = message.id;

			log(`[${channelId}] Bulk message deleted: ${discordMessageId}`);

			const channelMap = discordMessageToSession.get(channelId);
			if (!channelMap) continue;

			const tracked = channelMap.get(discordMessageId);
			if (!tracked) {
				log(`[${channelId}] Warning: Bulk-deleted message ${discordMessageId} was not tracked in session`);
				continue;
			}

			if (!byChannel.has(channelId)) {
				byChannel.set(channelId, []);
			}
			byChannel.get(channelId)!.push({ msgId: discordMessageId, tracked });
		}

		// Process each channel
		for (const [channelId, deletions] of byChannel) {
			// Sort by index descending so we delete from high to low
			deletions.sort((a, b) => b.tracked.sessionIndex - a.tracked.sessionIndex);

			const discordSession = sessionStore.get(channelId);
			if (!discordSession) continue;

			const { session } = discordSession;
			const sessionMessages = session.messages;

			for (const { msgId, tracked } of deletions) {
				const channelMap = discordMessageToSession.get(channelId)!;
				channelMap.delete(msgId);

				if (tracked.sessionIndex >= 0 && tracked.sessionIndex < sessionMessages.length) {
					const removed = sessionMessages.splice(tracked.sessionIndex, 1);
					log(`[${channelId}] Removed message from session: ${removed[0]?.role} (index ${tracked.sessionIndex})`);
					// Fix indices after deletion
					fixIndicesAfterDeletion(channelId, tracked.sessionIndex);
				}
			}
		}
	});

	// =========================================================================
	// Channel Rename Handler
	// =========================================================================
	discordClient.on("channelUpdate", async (oldChannel, newChannel) => {
		// Only track text channels and DMs
		if (oldChannel.type !== ChannelType.GuildText && oldChannel.type !== ChannelType.DM) {
			return;
		}

		const channelId = oldChannel.id;
		const oldName = oldChannel.type === ChannelType.DM ? "DM" : (oldChannel as TextChannel).name;
		const newName = newChannel.type === ChannelType.DM ? "DM" : (newChannel as TextChannel).name;

		if (oldName !== newName) {
			log(`[${channelId}] Channel renamed: "${oldName}" → "${newName}"`);
			// Update the channel name in session store so the system prompt reflects the rename
			sessionStore.setChannelName(channelId, newName);
			log(`[${channelId}] Updated session channel name to "${newName}"`);
		}
	});

	// =========================================================================
	// Branch Command Handlers
	// =========================================================================

	/**
	 * /label [name] - Label the current message's pi entry
	 */
	async function handleLabel(
		channel: DMChannel | TextChannel | NewsChannel | ThreadChannel,
		message: Message,
		labelName?: string
	): Promise<void> {
		const channelId = channel.id;
		const discordSession = sessionStore.get(channelId);
		
		if (!discordSession) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ No session for this channel");
			return;
		}

		const metadata = loadBranchMetadata(sessionDir, channelId);
		
		// Resolve target message: use the replied-to message if this is a reply,
		// otherwise fall back to the main branch tip (most recent bot response).
		let targetDiscordMsgId: string | undefined;
		if (message.reference?.messageId) {
			targetDiscordMsgId = message.reference.messageId;
		} else if (metadata.mainBranchTip) {
			// mainBranchTip is the assistant entry ID — find the Discord msg that maps to it
			for (const [discordId, piId] of metadata.discordMsgToPiEntryId) {
				if (piId === metadata.mainBranchTip) {
					targetDiscordMsgId = discordId;
					break;
				}
			}
		}

		if (!targetDiscordMsgId) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ No message to label — reply to a message or send a message first");
			return;
		}

		// Find which pi entry corresponds to the target Discord message
		const piEntryId = metadata.discordMsgToPiEntryId.get(targetDiscordMsgId);
		if (!piEntryId) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ Target message not found in session");
			return;
		}

		// Use provided name or auto-generate
		const name = labelName || `label-${++metadata.labelCounter}`;

		// Check if label already exists
		if (metadata.labels.has(name)) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `❌ Label \`${name}\` already exists`);
			return;
		}

		// Track in metadata
		metadata.labels.set(name, {
			piEntryId,
			discordMessageId: targetDiscordMsgId,
			timestamp: Date.now(),
		});

		saveBranchMetadata(sessionDir, channelId, metadata);
		await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `✅ Labeled as \`${name}\``);
	}

	/**
	 * /labels - Show all labels in this channel
	 */
	async function handleLabels(
		channel: DMChannel | TextChannel | NewsChannel | ThreadChannel
	): Promise<void> {
		const channelId = channel.id;
		const metadata = loadBranchMetadata(sessionDir, channelId);

		const lines: string[] = [];
		
		for (const [labelName] of metadata.labels) {
			lines.push(`• \`${labelName}\``);
		}

		const output = lines.length > 0 
			? lines.join("\n")
			: "No labels found";

		await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `**Labels in this channel:**\n${output}`);
	}

	/**
	 * /merge [name] - Merge branch from labeled entry or previous message
	 */
	async function handleMerge(
		channel: DMChannel | TextChannel | NewsChannel | ThreadChannel,
		message: Message,
		labelName?: string
	): Promise<void> {
		const channelId = channel.id;
		const discordSession = sessionStore.get(channelId);
		
		if (!discordSession) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ No session for this channel");
			return;
		}

		const { session } = discordSession;
		const metadata = loadBranchMetadata(sessionDir, channelId);

		// Determine source branch
		let sourcePiEntryId: string | undefined;
		
		if (labelName) {
			// Merge from labeled entry
			const label = metadata.labels.get(labelName);
			if (!label) {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `❌ Label \`${labelName}\` not found`);
				return;
			}
			sourcePiEntryId = label.piEntryId;
		} else {
			// Merge from replied-to message, or fall back to mainBranchTip
			if (message.reference?.messageId) {
				sourcePiEntryId = metadata.discordMsgToPiEntryId.get(message.reference.messageId);
				if (!sourcePiEntryId) {
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "⚠️ Replied-to message not in session");
					return;
				}
			} else {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ Specify a label name or reply to the message you want to merge from");
				return;
			}
		}

		// Current position: if /merge is a reply, use that message's pi entry (for sub-branch merges).
		// Otherwise fall back to mainBranchTip (main branch merges).
		let currentPiEntryId: string | null | undefined;
		if (message.reference?.messageId) {
			currentPiEntryId = metadata.discordMsgToPiEntryId.get(message.reference.messageId);
			if (!currentPiEntryId) {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ Replied-to message not tracked in session");
				return;
			}
		} else {
			currentPiEntryId = metadata.mainBranchTip;
		}
		if (!currentPiEntryId) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ No current position — send a message first");
			return;
		}

		// Find fork point (common ancestor)
		const forkEntryId = findCommonAncestor(
			sourcePiEntryId,
			currentPiEntryId,
			session.sessionManager
		);

		if (forkEntryId === currentPiEntryId) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "⚠️ Already on same branch, no merge needed");
			return;
		}

		// Get all messages from fork point to source leaf
		const sourceMessages = getMessagesBetween(
			forkEntryId,
			sourcePiEntryId,
			session.sessionManager
		);

		// Create merge message summarizing what we're merging
		const mergeContent = formatMergedMessages(sourceMessages);
		const mergeMessage = `Merged from branch:\n\n${mergeContent}`;

		try {
			// Branch to current position and silently inject merged content
			// (no LLM turn - just append to tree and sync agent context)
			session.sessionManager.branch(currentPiEntryId);
			const mergeEntryId = session.sessionManager.appendMessage({
				role: "user",
				content: mergeMessage,
				timestamp: Date.now(),
			});

			// Sync agent's in-memory context to include the merged content
			const ctx = session.sessionManager.buildSessionContext();
			session.agent.state.messages = ctx.messages

			const updatedMeta = loadBranchMetadata(sessionDir, channelId);

			// Remap the current tip Discord message to the merge entry,
			// so subsequent replies to the merged tip continue from the merge result.
			for (const [discordId, piId] of updatedMeta.discordMsgToPiEntryId) {
				if (piId === currentPiEntryId) {
					updatedMeta.discordMsgToPiEntryId.set(discordId, mergeEntryId);
					log(`[${channelId}] Remapped current tip ${discordId} → merge entry ${mergeEntryId}`);
				}
			}

			if (currentPiEntryId === updatedMeta.mainBranchTip) {
				// Main branch merge: advance mainBranchTip
				updatedMeta.mainBranchTip = mergeEntryId;
				log(`[${channelId}] Updated main branch tip after merge to ${mergeEntryId}`);
			} else {
				log(`[${channelId}] Sub-branch merge at ${currentPiEntryId}, mainBranchTip unchanged`);
			}
			saveBranchMetadata(sessionDir, channelId, updatedMeta);

			// Send confirmation and track it → mergeEntryId so replies to it continue from the merge
			const confirmMsgs = await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "✅ Branch merged");
			if (confirmMsgs.length > 0) {
				const finalMeta = loadBranchMetadata(sessionDir, channelId);
				for (const msg of confirmMsgs) {
					finalMeta.discordMsgToPiEntryId.set(msg.id, mergeEntryId);
					log(`[${channelId}] Tracked merge confirmation ${msg.id} → Pi entry ${mergeEntryId}`);
				}
				saveBranchMetadata(sessionDir, channelId, finalMeta);
			}
		} catch (error) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `❌ Merge failed: ${error}`);
		}
	}

	/**
	 * /summary [name] - Show merged branch messages (summary of changes)
	 */
	async function handleSummary(
		channel: DMChannel | TextChannel | NewsChannel | ThreadChannel,
		message: Message,
		labelName?: string
	): Promise<void> {
		const channelId = channel.id;
		const discordSession = sessionStore.get(channelId);
		
		if (!discordSession) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ No session for this channel");
			return;
		}

		const { session } = discordSession;
		const metadata = loadBranchMetadata(sessionDir, channelId);

		// Determine source branch (same logic as merge)
		let sourcePiEntryId: string | undefined;
		
		if (labelName) {
			const label = metadata.labels.get(labelName);
			if (!label) {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `❌ Label \`${labelName}\` not found`);
				return;
			}
			sourcePiEntryId = label.piEntryId;
		} else {
			// Source from replied-to message
			if (message.reference?.messageId) {
				sourcePiEntryId = metadata.discordMsgToPiEntryId.get(message.reference.messageId);
				if (!sourcePiEntryId) {
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "⚠️ Replied-to message not in session");
					return;
				}
			} else {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ Specify a label name or reply to the message you want to summarize");
				return;
			}
		}

		// Current position: reply target if replying, else mainBranchTip
		let currentPiEntryId: string | null | undefined;
		if (message.reference?.messageId) {
			currentPiEntryId = metadata.discordMsgToPiEntryId.get(message.reference.messageId);
			if (!currentPiEntryId) {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ Replied-to message not tracked in session");
				return;
			}
		} else {
			currentPiEntryId = metadata.mainBranchTip;
		}
		if (!currentPiEntryId) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ No current position — send a message first");
			return;
		}

		// Find fork point
		const forkEntryId = findCommonAncestor(
			sourcePiEntryId,
			currentPiEntryId,
			session.sessionManager
		);

		if (forkEntryId === currentPiEntryId) {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "⚠️ Already on same branch");
			return;
		}

		// Get messages to summarize
		const sourceMessages = getMessagesBetween(
			forkEntryId,
			sourcePiEntryId,
			session.sessionManager
		);

		// Format and show the summary
		const summaryContent = formatMergedMessages(sourceMessages);
		const summaryMessage = `**Summary of branch changes:**\n\n${summaryContent}`;

		try {
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, summaryMessage);
		} catch (error) {
			console.error(`[${channelId}] Summary error:`, error);
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `❌ Summary failed: ${error}`);
		}
	}

	// =========================================================================
	// Tools
	// =========================================================================
	// Note: handleRemember is now handled by the session tool definition in session-store.ts
	// and routed via tool_execution_end in subscribeToSession.

	// =========================================================================
	// Message Processing
	// =========================================================================
	const subscribedSessions = new Set<string>();
	const sessionSubscriptions = new Map<string, { setPendingDiscordMessageId: (id: string, isReply: boolean) => void }>();
	let subscribeCount = 0;
	let sendCount = 0;

	function getChannelDisplayName(channel: DMChannel | TextChannel | NewsChannel | ThreadChannel): string {
		if (channel.type === ChannelType.DM) {
			const dmChannel = channel as DMChannel;
			return dmChannel.recipient?.username || "DM";
		}
		return ((channel as TextChannel | NewsChannel | ThreadChannel).name) || "Unknown";
	}

	async function handleMessage(
		channel: DMChannel | TextChannel | NewsChannel | ThreadChannel,
		message: any
	): Promise<void> {
		const channelId = channel.id;
		const channelName = getChannelDisplayName(channel);
		sessionStore.setChannelName(channelId, channelName);
		const discordSession = await sessionStore.getOrCreate(channelId, channelName);
		const { session } = discordSession;

		// Store Discord message ID for tracking in session
		// We'll track it when the message_start event fires
		const currentDiscordMsgId = message.id;

		// Track user message for deletion handling (old approach for assistant/tool messages)
		// User messages are at index = session.messages.length before we add them
		const userMessageIndex = session.messages.length;
		if (!discordMessageToSession.has(channelId)) {
			discordMessageToSession.set(channelId, new Map());
		}
		discordMessageToSession.get(channelId)!.set(message.id, {
			sessionIndex: userMessageIndex,
			type: "user"
		});

		// Check for non-interrupting commands (slash commands that should not abort the agent)
		const isNonInterruptingCommand = message.content === "/session" || message.content.startsWith("/session ") ||
			message.content === "/new" ||
			message.content === "/resume" || message.content.startsWith("/resume ") ||
			message.content === "/queue" || message.content.startsWith("/queue ") ||
			message.content === "/label" || message.content.startsWith("/label ") ||
			message.content === "/labels" ||
			message.content === "/cwd" || message.content.startsWith("/cwd ") ||
			message.content === "/channel" ||
			message.content === "/help" ||
			message.content === "/session" ||
			message.content === "/models" || message.content.startsWith("/models ") ||
			message.content === "/model" || message.content.startsWith("/model ") ||
			message.content === "/settings";

		// Only abort if the agent is active AND this is not a non-interrupting command
		if (discordSession.isModelActive() && !isNonInterruptingCommand) {
			log(`[${channelId}] User interrupted - aborting current operation`);
			sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "🛑 Interrupted by user").catch(() => {});
			await discordSession.abortModelActivities()
			// dont hide typing manager, fall through to sending the interrupted message to the agent
		}

		// Store the Discord message ID so it can be tracked when the user message is processed
		if (currentDiscordMsgId) {
			pendingDiscordMessages.set(channelId, currentDiscordMsgId);
		}

		// Subscribe to session events once
		// FIX: Add to set BEFORE calling subscribeToSession to prevent race condition
		// where two rapid messages could both pass the has() check before either adds
		if (!subscribedSessions.has(channelId)) {
			subscribedSessions.add(channelId);
			subscribeCount++;
			log(`[${channelId}] Subscribing to session (total subscriptions: ${subscribeCount})`);
			const sub = subscribeToSession(session, channelId, channel as DMChannel | TextChannel | NewsChannel, typingManager, sessionDir);
			sessionSubscriptions.set(channelId, sub);
		} else {
			log(`[${channelId}] Already subscribed, skipping`);
		}

		log(`[${channelId}] handleMessage complete. sendToDiscord called ${sendCount} times total so far`);

		// Update last activity
		sessionStore.touch(channelId);

		// Handle reply branching - update metadata before sending message
		const metadata = loadBranchMetadata(sessionDir, channelId);

		// Prepare content for the agent (text + images)
		const agentContent: any[] = [];
		if (message.content?.trim()) {
			agentContent.push({ type: "text", text: message.content });
		}

		// Add image attachments
		log(`[${channelId}] Processing ${message.attachments?.size ?? 0} attachments`);
		if (message.attachments) {
			for (const attachment of message.attachments.values()) {
				log(`[${channelId}] Attachment found: ${JSON.stringify({ id: attachment?.id, url: attachment?.url, contentType: attachment?.contentType })}`);
				if (!attachment || !attachment.url) {
					log(`[${channelId}] Attachment missing URL!`);
					continue;
				}

				const urlWithoutQuery = attachment.url.split('?')[0];
				const isImage = attachment.contentType?.startsWith('image/') || 
								 /\.(jpg|jpeg|png|gif|webp)$/i.test(urlWithoutQuery);
				
				if (isImage) {
					const mimeType = attachment.contentType || 
									 (urlWithoutQuery.endsWith('.png') ? 'image/png' : 
									  urlWithoutQuery.endsWith('.gif') ? 'image/gif' : 
									  urlWithoutQuery.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
					try {
						const response = await fetch(attachment.url);
						const buffer = await response.arrayBuffer();
						const base64Data = Buffer.from(buffer).toString('base64');
						log(`[${channelId}] Base64 conversion: length=${base64Data.length}, snippet=${base64Data.slice(0, 30)}...`);
						log(`[${channelId}] Adding image attachment: ${attachment.url} (MIME: ${mimeType})`);
						const imagePart = {
							type: "image",
							data: base64Data,
							mimeType: mimeType,
						};
						log(`[${channelId}] imagePart data starts with: ${base64Data.startsWith('http') ? 'URL (WRONG)' : 'Base64 (CORRECT)'}`);
						agentContent.push(imagePart);
					} catch (e) {
						log(`[${channelId}] Failed to fetch image ${attachment.url}: ${e}`);
					}
				} else {
					log(`[${channelId}] Skipping non-image attachment: ${attachment.url} (MIME: ${attachment.contentType})`);
				}
			}
		}

		if (message.content === "/help") {
			const helpText = `📖 **pi-discord Help Guide**\n\n` +
				`**General Commands**\n` +
				`• \`/session\` - Show session statistics and info\n` +
				`• \`/channel\` - Show current channel info (ID, name)\n` +
				`• \`/cwd\` - Show current working directory\n` +
				`• \`/cwd [path]\` - Change session working directory\n` +
				`• \`/stats\` - Show token utilization and changes\n` +
				`• \`/queue [prompt]\` - Queue a prompt to run after current task\n` +
				`• \`/session [label]\` - Close current session (label for /resume [label])\n` +
				`• \`/resume [id or label]\` - Resume a previously closed session\n` +
				`• \`/clear\` - Reset session and start fresh\n` +
				`• \`/reload\` - Reload extensions, skills, and themes\n` +
				`• \`/exit\` - Shut down the bot\n` +
				`• \`/stop\` - Stop current agent operation\n\n` +
				`**Model & Settings**\n` +
				`• \`/models\` - List available models\n` +
				`• \`/model [provider/id]\` - Change current model\n` +
				`• \`/thinking [level]\` - Set thinking level (e.g., \`/thinking high\`)\n` +
				`• \`/settings\` - Show current agent settings\n\n` +
				`**Branching & History**\n` +
				`• \`/label [name]\` - Label current session for /resume [label]\n` +
				`• \`/labels\` - List all closed/labeled sessions\n` +
				`• \`/merge [name]\` - Merge branch from label or reply\n` +
				`• \`/summary [name]\` - Summarize changes from a branch\n\n` +
				`**Bash Integration**\n` +
				`• \`!command\` - Execute bash command (added to context)\n` +
				`• \`!!command\` - Execute bash command (hidden from context)`;
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, helpText);
			return;
		}

		if (message.content === "/channel") {
			const channelInfo = `📌 **Channel Info**\n` +
				`**ID:** \`${channelId}\`\n` +
				`**Name:** ${channel.type === ChannelType.DM ? 'DM' : `\`${(channel as TextChannel).name}\``}\n` +
				`**Type:** ${ChannelType[channel.type]}\n` +
				`**Session tracked:** ✅ (by channelId, survives renames)`;
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, channelInfo);
			return;
		}

		if (message.content === "/queue" || message.content.startsWith("/queue ")) {
			const prompt = message.content.slice("/queue ".length).trim();
			if (!prompt) {
				const queue = promptQueue.get(channelId) || [];
				if (queue.length === 0) {
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "📭 Queue is empty");
				} else {
					const queueText = queue.map((p, i) => `${i + 1}. ${p.length > 80 ? p.slice(0, 80) + '...' : p}`).join('\n');
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `📋 **Queued prompts** (${queue.length}):\n${queueText}`);
				}
				return;
			}

			// Add to queue
			if (!promptQueue.has(channelId)) {
				promptQueue.set(channelId, []);
			}
			promptQueue.get(channelId)!.push(prompt);
			const position = promptQueue.get(channelId)!.length;
			savePromptQueue();
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `📥 Prompt queued (#${position}): ${prompt.length > 100 ? prompt.slice(0, 100) + '...' : prompt}`);
			return;
		}

		if (message.content === "/stop") {
			typingManager.hide(channelId);
			return;
		}

		// Handle bash commands (!command or !!command)
		if (message.content.startsWith("!")) {
			const isExcluded = message.content.startsWith("!!");
			const command = isExcluded 
				? message.content.slice(2).trim()
				: message.content.slice(1).trim();

			if (!command) {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ Usage: `!command` or `!!command`");
				return;
			}

			log(`[${channelId}] Executing bash command: ${command}`);

			try {
				const output: string[] = [];
				await session.executeBash(command, (chunk) => {
					output.push(chunk);
				}, { excludeFromContext: isExcluded });

				const fullOutput = output.join("");
				if (fullOutput) {
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `📄 Output:\n\`\`\`\n${escapeForCodeBlock(fullOutput)}\n\`\`\``);
				} else {
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "✅ Command executed (no output)");
				}
			} catch (error) {
				console.error(`[${channelId}] Bash error:`, error);
				// Truncate error message to avoid exceeding Discord's limit
				const errorStr = String(error);
				const truncatedError = errorStr.length > 1800 ? errorStr.substring(0, 1800) + "... (truncated)" : errorStr;
				const errorMessage = `❌ Bash error: ${truncatedError}`;
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, errorMessage);
			}
			return;
		}

		// Handle /session command
		if (message.content === "/cwd" || message.content.startsWith("/cwd ")) {
			if (message.content === "/cwd") {
				const cwd = session.sessionManager.getCwd();
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `📂 Current working directory:\n\`${cwd}\``);
			} else {
				const newCwd = message.content.slice("/cwd ".length).trim();
				try {
					await sessionStore.changeCwd(channelId, newCwd);
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `✅ Changed working directory to:\n\`${newCwd}\``);
				} catch (error) {
					console.error(`[${channelId}] /cwd error:`, error);
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `❌ Error changing directory: ${error}`);
				}
			}
			return;
		}

		if (message.content === "/stats") {
			const statsResult = generateTokenStatsMessage(channelId, session, previousTokens);
			if (statsResult) {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, statsResult.message);
			} else {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "❌ No token stats available for this session.");
			}
			return;
		}

		if (message.content === "/session") {
			try {
				const stats = session.getSessionStats();
				const sessionName = session.sessionName;

				let info = "**Session Info**\n\n";
				if (sessionName) {
					info += `**Name:** ${sessionName}\n`;
				}
				info += `**File:** ${stats.sessionFile ?? "In-memory"}\n`;
				info += `**ID:** ${stats.sessionId}\n\n`;

				info += "**Messages**\n";
				info += `User: ${stats.userMessages}\n`;
				info += `Assistant: ${stats.assistantMessages}\n`;
				info += `Tool Calls: ${stats.toolCalls}\n`;
				info += `Tool Results: ${stats.toolResults}\n`;
				info += `Total: ${stats.totalMessages}\n\n`;

				info += "**Tokens**\n";
				info += `Input: ${stats.tokens.input.toLocaleString()}\n`;
				info += `Output: ${stats.tokens.output.toLocaleString()}\n`;
				info += `Cache Read: ${stats.tokens.cacheRead.toLocaleString()}\n`;
				info += `Cache Write: ${stats.tokens.cacheWrite.toLocaleString()}\n`;
				info += `Total (lifetime): ${stats.tokens.total.toLocaleString()}\n`;

				if (stats.contextUsage && stats.contextUsage.percent != null) {
					info += `\n**Context Usage**\n`;
					info += `${stats.contextUsage.percent.toFixed(1)}% | ${stats.contextUsage.tokens?.toLocaleString() ?? "?"} / ${stats.contextUsage.contextWindow.toLocaleString()} tok\n`;
				}

				if (stats.cost > 0) {
					info += `\n**Cost:** $${stats.cost.toFixed(4)}\n`;
				}

				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, info);
			} catch (error) {
				console.error(`[${channelId}] /session error:`, error);
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `❌ Error getting session info: ${error}`);
			}
			return;
		}

		if (message.content === "/exit") {
			const queue = promptQueue.get(channelId);
			if (queue && queue.length > 0) {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `⚠️ **Exiting with ${queue.length} queued prompt(s) that will be lost:**\n${queue.map((p, i) => `${i + 1}. ${p.length > 80 ? p.slice(0, 80) + '...' : p}`).join('\n')}`);
				promptQueue.delete(channelId);
			}
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "😵 Exiting");
			savePromptQueue();
			shutdown();
			return;
		}

		// Handle /session command - close current session and start a fresh one
		// /session [label] also labels the session for easy /resume [label]
		if (message.content === "/session" || message.content.startsWith("/session ")) {
			const label = message.content.slice("/session".length).trim() || undefined;
			try {
				// Get stats before closing
				const currentLabel = sessionLabels.get(channelId);
				const stats = session.getSessionStats();
				
				const closedSessionId = await sessionStore.closeAndNewSession(channelId, label);

				// Label the new active session too
				if (label) {
					sessionLabels.set(channelId, label);
				} else {
					sessionLabels.delete(channelId);
				}

				// Clear branch metadata for new session
				const meta = loadBranchMetadata(sessionDir, channelId);
				meta.discordMsgToPiEntryId.clear();
				meta.discordMsgParent.clear();
				meta.mainBranchTip = null;
				meta.labelCounter = 0;
				meta.labels.clear();
				saveBranchMetadata(sessionDir, channelId, meta);

				// Remove this channel from subscribed sessions so the new session gets subscribed
				subscribedSessions.delete(channelId);
				sessionSubscriptions.delete(channelId);
				sessionMessageIndex.delete(channelId);
				discordMessageToSession.delete(channelId);

				const msgs = [];
				if (currentLabel) msgs.push(`🏷 \`${currentLabel}\``);
				msgs.push(`💬 ${stats.totalMessages} msgs`);
				if (stats.contextUsage?.percent != null) {
					msgs.push(`📊 ${Math.round(stats.contextUsage.percent)}% ctx`);
				}
				msgs.push(label ? `🏷 "${label}" → /resume ${label}` : `/resume ${closedSessionId.substring(0, 8)}...`);
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
					`✅ Closed session ${msgs.join(' · ')}`
				);
			} catch (error) {
				console.error(`[${channelId}] /session error:`, error);
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
					`❌ Error: ${error}`
				);
			}
			return;
		}

		// Handle /resume command - resume a previously closed session
		if (message.content === "/resume" || message.content.startsWith("/resume ")) {
			const arg = message.content.slice("/resume".length).trim();

			if (!arg) {
				// List closed sessions for this channel
				const closed = sessionStore.getClosedSessions(channelId);
				if (closed.length === 0) {
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
						"📭 No previously closed sessions for this channel. Use `/session` first."
					);
				} else {
					const lines = closed.map(s => {
						const date = new Date(s.closedAt).toLocaleString();
						const lab = s.label ? ` [${s.label}]` : "";
						return `• \`${s.sessionId}\`${lab} — ${s.sessionName} (closed ${date})`;
					});
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
						`**Closed sessions for this channel:**\n${lines.join("\n")}\n\nUse \`/resume <id or label>\` to resume one.`
					);
				}
				return;
			}

			const sessionId = arg;
			try {
				const resumed = await sessionStore.resumeSession(channelId, sessionId);
				if (!resumed) {
					await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
						`❌ Session \`${sessionId}\` not found in closed sessions. Use \`/resume\` to list available sessions.`
					);
					return;
				}

				// Clear tracking state for the resumed session
				subscribedSessions.delete(channelId);
				sessionSubscriptions.delete(channelId);
				sessionMessageIndex.delete(channelId);
				discordMessageToSession.delete(channelId);

				// Clear branch metadata for the resumed session (starts fresh tracking)
				const meta = loadBranchMetadata(sessionDir, channelId);
				meta.discordMsgToPiEntryId.clear();
				meta.discordMsgParent.clear();
				meta.mainBranchTip = null;
				meta.labelCounter = 0;
				meta.labels.clear();
				saveBranchMetadata(sessionDir, channelId, meta);

				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
					`✅ Resumed session \`${sessionId}\``
				);
			} catch (error) {
				console.error(`[${channelId}] /resume error:`, error);
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
					`❌ Error resuming session: ${error}`
				);
			}
			return;
		}

		// Handle /clear command - start a new session (no confirmation)
		if (message.content === "/clear") {
			log(`[${channelId}] Starting new session`);
			sessionStore.reset(channelId);
			metadata.discordMsgToPiEntryId.clear()
			metadata.discordMsgParent.clear()
			metadata.mainBranchTip = null;
			metadata.labelCounter = 0;
			metadata.labels.clear();
			promptQueue.delete(channelId); // Clear queued prompts
			savePromptQueue();
			saveBranchMetadata(sessionDir, channelId, metadata);
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "✅ Started new session. What would you like to work on?");
			return;
		}

		// Handle /reload command - reload extensions/skills/themes
		if (message.content === "/reload") {
			log(`[${channelId}] Reloading extensions`);
			try {
				await session.reload();
				// Re-apply retry overrides after reload as it wipes in-memory settings
				const discordSession = sessionStore.get(channelId);
				if (discordSession) {
					discordSession.applyRetryOverrides();
				}
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "✅ Extensions, skills, and themes reloaded.");
			} catch (error) {
				console.error(`[${channelId}] /reload error:`, error);
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `❌ Reload failed: ${error}`);
			}
			return;
		}

		if (message.content === "/models") {
			const available = (await session.modelRegistry.getAvailable()).map(({provider,id}) =>`${provider}/${id}`);
			const availableJson = escapeForCodeBlock(JSON.stringify(available, null, 2));
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `🤖 Models:\n\`\`\`json\n${availableJson}\n\`\`\``);
			return;
		}

		if (message.content === "/settings") {
			const settings = (session.settingsManager)
			const settingsJSON = escapeForCodeBlock(JSON.stringify(settings, null, 2));
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `⚙️ Settings:\n\`\`\`json\n${settingsJSON}\n\`\`\``);
			return;
		}

		if (message.content.startsWith("/thinking ")) {
			const thinking = message.content.replace('/thinking ', '')
			try {
				console.log('setting thinking ' + thinking)
				session.setThinkingLevel(thinking)
				const available = session.getAvailableThinkingLevels()
				await sendToDiscord(channel as TextChannel, `🧠 Thinking level: ${session.thinkingLevel}. Available levels: ${available.join(', ')}`)
			} catch (error) {
				console.error(`[${channelId}] Error setting thinking mode "${thinking}":`, error);
				await (channel as DMChannel | TextChannel | NewsChannel).send(
					`❌ Sorry, I encountered an error while setting thinking level "${thinking}".\n\`\`\`json\n${error}\`\`\``
				);
			}
			return;
		}

		if (message.content == "/thinking") {
			const available = session.getAvailableThinkingLevels()
			await sendToDiscord(channel as TextChannel, `🧠 Thinking level: ${session.thinkingLevel}. Available levels: ${available.join(', ')}`)
			return;
		}

		if (message.content.startsWith("/models ")) {
			const search = message.content.replace("/models ", "").trim();
			const available = await session.modelRegistry.getAvailable();
			const { filterModels } = await import("./model-utils.js");
			const found = filterModels(available, search).map(({provider,id}) =>`${provider}/${id}`);
			const foundJson = escapeForCodeBlock(JSON.stringify(found, null, 2));
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `🤖 Models:\n\`\`\`json\n${foundJson}\n\`\`\``);
			return;
		}

		if (message.content === "/model") {
			const modelData = escapeForCodeBlock(JSON.stringify(session.model, null, 2));
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `🤖 Model data:\n\`\`\`json\n${modelData}\n\`\`\``);
			return;
		}

		if (message.content.startsWith("/model ")) {
			const search = message.content.replace("/model ", "").trim();
			try {
				const available = await session.modelRegistry.getAvailable();
				const { findModel } = await import("./model-utils.js");
				const m = findModel(available, search);

				if (!m) {
					throw new Error(`No model matching "${search}" found among available models`);
				}

				await discordSession.setModel(m.provider, m.id);
				sessionStore.updateModel(channelId, `${m.provider}/${m.id}`);
				const modelData = escapeForCodeBlock(JSON.stringify(session.model, null, 2));
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `🤖 Changed to ${m.provider}/${m.id}:\n\`\`\`json\n${modelData}\n\`\`\``);
			} catch (error) {
				console.error(`[${channelId}] Error setting model from "${search}":`, error);
				try {
					await (channel as DMChannel | TextChannel | NewsChannel).send(
						`❌ Sorry, I encountered an error while setting your model "${search}".\n\`\`\`json\n${error}\`\`\``
					);
				} catch {
					// Channel might be unavailable
				}
			}
			return;
		}

		// Handle branch commands
		// Session label: /label shows current, /label [name] sets it
		if (message.content === "/label") {
			const currentLabel = sessionLabels.get(channelId);
			if (currentLabel) {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
					`🏷 Session label: \`${currentLabel}\` (use \`/resume ${currentLabel}\` to return later)`
				);
			} else {
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
					"🏷 No session label set. Use `/label <name>` to set one, then `/session` to close and label it."
				);
			}
			return;
		}

		if (message.content.startsWith("/label ")) {
			const labelName = message.content.slice("/label ".length).trim();
			sessionLabels.set(channelId, labelName);
			await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel,
				`🏷 Session labeled \`${labelName}\`. Use \`/session\` to close and save, then \`/resume ${labelName}\` to return.`
			);
			return;
		}

		if (message.content === "/labels") {
			await handleLabels(channel);
			return;
		}

		if (message.content === "/merge") {
			await handleMerge(channel, message);
			return;
		}

		if (message.content.startsWith("/merge ")) {
			const labelName = message.content.slice("/merge ".length).trim();
			await handleMerge(channel, message, labelName);
			return;
		}

		if (message.content === "/summary") {
			await handleSummary(channel, message);
			return;
		}

		if (message.content.startsWith("/summary ")) {
			const labelName = message.content.slice("/summary ".length).trim();
			await handleSummary(channel, message, labelName);
			return;
		}
		
		// Helper: branch the session tree and sync agent's in-memory messages
		const branchAndSync = (entryId: string) => {
				try {
					session.sessionManager.branch(entryId);
					const ctx = session.sessionManager.buildSessionContext();
					session.agent.state.messages = ctx.messages
					return true;
				} catch {
					return false;
				}
		};

		if (message.reference) {
			// This is a reply - find the parent entry and branch there
			const parentMsgId = message.reference.messageId;
			const parentPiEntryId = metadata.discordMsgToPiEntryId.get(parentMsgId);
			
			if (parentPiEntryId && branchAndSync(parentPiEntryId)) {
				log(`[${channelId}] Branched to parent entry ${parentPiEntryId}`);
			} else {
				// Parent not found - warn but continue
				log(`[${channelId}] Warning: Parent message ${parentMsgId} not tracked in session`);
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, 
					`⚠️ Parent message not found in session history, continuing in main branch`);
			}
		} else {
			// Non-reply: branch to persisted main branch tip (survives restarts)
			const mainTip = metadata.mainBranchTip;
			if (mainTip && branchAndSync(mainTip)) {
				log(`[${channelId}] Branched to main branch tip ${mainTip}`);
			} else if (mainTip) {
				// mainBranchTip exists but entry is missing (crash/restart) — try latest leaf
				const leafId = session.sessionManager.getLeafId();
				if (leafId && branchAndSync(leafId)) {
					log(`[${channelId}] mainBranchTip stale, branched to latest leaf ${leafId}`);
				} else {
					log(`[${channelId}] Tree is empty, creating new root`);
				}
			} else {
				// mainBranchTip is null (e.g. after /clear) — start fresh
				log(`[${channelId}] Tree is empty, creating new root`);
			}
		}

		// Tell the subscription about this Discord message before sending
		sessionSubscriptions.get(channelId)?.setPendingDiscordMessageId(message.id, !!message.reference);

		// Send user message to pi agent
		try {
			const finalContent: any[] = [];
			
			if (agentContent.length > 0) {
				finalContent.push(...agentContent);
			} else if (message.content) {
				finalContent.push({ type: "text", text: message.content });
			} else {
				finalContent.push({ type: "text", text: " " });
			}

			log(`[${channelId}] Sending content to agent. Type: array (length ${finalContent.length})`);
			if (finalContent.length > 0) {
				finalContent.forEach((part, i) => {
					if (part.type === 'image') {
						log(`[${channelId}] Part ${i} (image) data snippet: ${part.data?.slice(0, 50)}...`);
					}
				});
			}
			await session.sendUserMessage(finalContent);

			// Track user Discord message → user Pi entry
			// getLeafId() is the assistant entry; its parent is the user entry
			const assistantLeafId = session.sessionManager.getLeafId();
			if (assistantLeafId) {
				const assistantEntry = session.sessionManager.getEntry(assistantLeafId);
				const userEntryId = assistantEntry?.parentId ?? assistantLeafId;
				const metadata = loadBranchMetadata(sessionDir, channelId);
				metadata.discordMsgToPiEntryId.set(message.id, userEntryId);
				saveBranchMetadata(sessionDir, channelId, metadata);
				log(`[${channelId}] Tracked Discord message ${message.id} → Pi entry ${userEntryId}`);
				// Update persisted main branch tip for non-reply messages
				if (!message.reference) {
					const updatedMeta = loadBranchMetadata(sessionDir, channelId);
					updatedMeta.mainBranchTip = assistantLeafId;
					saveBranchMetadata(sessionDir, channelId, updatedMeta);
					log(`[${channelId}] Updated main branch tip to ${assistantLeafId}`);
				}
			}
		} catch (error) {
			console.error(`[${channelId}] Error sending message:`, error);
			try {
				await (channel as DMChannel | TextChannel | NewsChannel).send(
					"❌ Sorry, I encountered an error processing your message."
				);
			} catch {
				// Channel might be unavailable
			}
		}
	}

	// =========================================================================
	// Graceful Shutdown
	// =========================================================================
	async function shutdown() {
		log("Shutting down...");

		// Dispose typing manager (stops all typing indicators)
		typingManager.dispose();

		// Dispose all sessions (saves index)
		sessionStore.disposeAll();

		// Destroy Discord client
		discordClient?.destroy();

		console.log("[discord] Shutdown complete");
		process.exit(0);
	}

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// Restore persisted prompt queues from disk
	loadPromptQueue();

	// Restore sessions for channels with scheduled prompts
	restoreScheduledSessions();

	// Keep sessions alive for enabled cron jobs (pi-schedule-prompt only fires while a session is open)
	startSessionKeeper();

	// Pre-create sessions for channels with queued prompts so they survive restarts
	for (const chId of promptQueue.keys()) {
		console.log(`[discord] Pre-creating session for channel ${chId} (${promptQueue.get(chId)?.length || 0} queued prompts)`);
		sessionStore.getOrCreate(chId).catch((err) => {
			console.error(`[discord] Failed to pre-create session for ${chId}:`, err);
		});
	}

	console.log("[discord] Bot is ready and listening for messages!");
}

// ============================================================================
// Run
// ============================================================================

main().catch((error) => {
	console.error("[discord] Fatal error:", error);
	process.exit(1);
});

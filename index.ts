/**
 * pi-discord - Standalone Discord Bot
 * Discord integration for pi coding agent using the SDK
 */

import { Client, GatewayIntentBits, ChannelType, ThreadChannel, DMChannel, TextChannel, NewsChannel, Message } from "discord.js";
import { SessionStore, createSessionStore, type DiscordSession } from "./session-store";
import { TypingManager } from "./typing-manager";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";

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

// Track sessions that are currently running (to allow interruption)
const runningSessions = new Set<string>();

// Track Discord message IDs to session entry indices for deletion handling
// Map structure: channelId -> discordMessageId -> { sessionIndex, type: 'user' | 'assistant' | 'tool' | 'thinking' }
const discordMessageToSession = new Map<string, Map<string, { sessionIndex: number; type: string }>>();
const sessionMessageIndex = new Map<string, number>(); // Track current message index per channel

// Track the last thinking message ID per channel for editing
const lastThinkingMessageId = new Map<string, string>();

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

async function sendToDiscord(
	channel: DMChannel | TextChannel | NewsChannel,
	text: string,
	options?: { trackInSession?: boolean; type?: string }
): Promise<Message[]> {
	if (!text.trim()) return [];

	log(`[${channel.id}] sendToDiscord called with: "${text}" (${text.length} chars)`);

	const maxLength = 2000;
	const chunks = splitMessagePreservingCodeBlocks(text, maxLength);

	log(`[${channel.id}] Will send ${chunks.length} chunk(s)`);

	const sentMessages: Message[] = [];

	// Send chunks sequentially to preserve order
	for (const chunk of chunks) {
		log(`[${channel.id}] Actually sending chunk: "${chunk}"`);
		const msg = await channel.send(chunk);
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
	}

	return sentMessages;
}

function subscribeToSession(
	session: AgentSession,
	channelId: string,
	channel: DMChannel | TextChannel | NewsChannel,
	typingManager: TypingManager
): void {
	const responseBuffer: string[] = [];
	const thinkingBuffer: string[] = [];

	session.subscribe((event: AgentSessionEvent) => {
		switch (event.type) {
			case "agent_start":
				log(`[${channelId}] Agent starting...`);
				responseBuffer.length = 0;
				runningSessions.add(channelId);
				// LLM is processing - show typing indicator
				typingManager.show(channelId, channel);
				break;

			case "message_start":
				if (event.message.role === "assistant") {
					log(`[${channelId}] Assistant message started`);
					responseBuffer.length = 0;
					thinkingBuffer.length = 0;
					// Increment session index for this new assistant message
					const currentIdx = (sessionMessageIndex.get(channelId) ?? 0) + 1;
					sessionMessageIndex.set(channelId, currentIdx);
					// LLM is generating response - show typing indicator
					typingManager.show(channelId, channel);
				}
				break;

			case "message_update": {
				const assistantEvent = event.assistantMessageEvent;
				if (assistantEvent?.type === "text_delta") {
					log(`[${channelId}] text_delta: "${assistantEvent.delta}" (${assistantEvent.delta?.length || 0} chars)`);
					responseBuffer.push(assistantEvent.delta);
				}
				if (assistantEvent?.type === "thinking_delta") {
					log(`[${channelId}] thinking_delta: "${assistantEvent.delta}"`);
					// Show typing indicator when thinking starts
					typingManager.show(channelId, channel);
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

					// Note: The response has already been accumulated via text_delta events
					// into responseBuffer. DO NOT push from event.message.content as that
					// would duplicate the content (streaming + final content = double).
					const fullResponse = responseBuffer.join("");
					if (fullResponse.trim()) {
						log(`[${channelId}] Sending response (${fullResponse.length} chars)`);
						sendToDiscord(channel, fullResponse, { trackInSession: true, type: "response" }).catch((error) => {
							console.error(`[${channelId}] Failed to send response:`, error);
						});
					}
					responseBuffer.length = 0;
					thinkingBuffer.length = 0;
					// LLM finished generating - stop typing
					// (Don't stop on agent_end as it comes after message_end)
					typingManager.hide(channelId);
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
				typingManager.show(channelId, channel);
				break;
			}

			case "tool_execution_update":
				// Streaming tool output
				break;

			case "tool_execution_end":
				log(`[${channelId}] Tool ended: ${event.toolName} (error: ${event.isError})`);
				if (event.isError) {
					sendToDiscord(channel, "⚠️ Tool execution failed", { trackInSession: true, type: "tool-error" }).catch(() => {});
				}
				break;

			case "agent_end":
				log(`[${channelId}] Agent ended`);
				runningSessions.delete(channelId);
				// Ensure typing is hidden (defensive, normally message_end handles this)
				typingManager.hide(channelId);
				break;

			case "compaction_start":
				log(`[${channelId}] Compacting context...`);
				sendToDiscord(channel, "📦 Compacting context...").catch(() => {});
				break;

			case "compaction_end":
				log(`[${channelId}] Compaction complete`);
				break;

			case "auto_retry_start":
				log(`[${channelId}] Retrying (attempt ${event.attempt}/${event.maxAttempts})`);
				break;

			case "auto_retry_end":
				log(`[${channelId}] Retry ${event.success ? "succeeded" : "failed"}`);
				break;
		}
	});
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

		// Ignore messages without content
		if (!message.content?.trim()) return;

		log(`[${message.channelId}] Message from ${message.author.tag}: ${message.content.slice(0, 100)}...`);

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

		// Look up if we track this Discord message
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
	// Message Processing
	// =========================================================================
	const subscribedSessions = new Set<string>();
	let subscribeCount = 0;
	let sendCount = 0;

	async function handleMessage(
		channel: DMChannel | TextChannel | NewsChannel | ThreadChannel,
		message: any
	): Promise<void> {
		const channelId = channel.id;
		const discordSession = await sessionStore.getOrCreate(channelId);
		const { session } = discordSession;

		// Track user message for deletion handling
		// User messages are at index = session.messages.length before we add them
		const userMessageIndex = session.messages.length;
		if (!discordMessageToSession.has(channelId)) {
			discordMessageToSession.set(channelId, new Map());
		}
		discordMessageToSession.get(channelId)!.set(message.id, {
			sessionIndex: userMessageIndex,
			type: "user"
		});

		// Abort any ongoing session operation if user sends a new message
		if (runningSessions.has(channelId)) {
			log(`[${channelId}] User interrupted - aborting current operation`);
			sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, "🛑 Interrupted by user").catch(() => {});
			await session.abort();
			typingManager.hide(channelId);
		}

		// Subscribe to session events once
		// FIX: Add to set BEFORE calling subscribeToSession to prevent race condition
		// where two rapid messages could both pass the has() check before either adds
		if (!subscribedSessions.has(channelId)) {
			subscribedSessions.add(channelId);
			subscribeCount++;
			log(`[${channelId}] Subscribing to session (total subscriptions: ${subscribeCount})`);
			subscribeToSession(session, channelId, channel as DMChannel | TextChannel | NewsChannel, typingManager);
		} else {
			log(`[${channelId}] Already subscribed, skipping`);
		}

		log(`[${channelId}] handleMessage complete. sendToDiscord called ${sendCount} times total so far`);

		// Update last activity
		sessionStore.touch(channelId);

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
			typingManager.show(channelId, channel);

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
				await sendToDiscord(channel as DMChannel | TextChannel | NewsChannel, `❌ Bash error: ${error}`);
			} finally {
				typingManager.hide(channelId);
			}
			return;
		}

		// Send user message to pi agent
		try {
			await session.sendUserMessage(message.content);
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

	console.log("[discord] Bot is ready and listening for messages!");
}

// ============================================================================
// Run
// ============================================================================

main().catch((error) => {
	console.error("[discord] Fatal error:", error);
	process.exit(1);
});

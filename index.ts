/**
 * pi-discord - Standalone Discord Bot
 * Discord integration for pi coding agent using the SDK
 */

import { Client, GatewayIntentBits, ChannelType, ThreadChannel, DMChannel, TextChannel, NewsChannel } from "discord.js";
import { SessionStore, createSessionStore, type DiscordSession } from "./session-store";
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

// ============================================================================
// Helper Functions
// ============================================================================

function isThread(channel: unknown): channel is ThreadChannel {
	return (channel as ThreadChannel)?.isThread?.() === true;
}

// ============================================================================
// Discord Message Handling
// ============================================================================

function sendToDiscord(
	channel: DMChannel | TextChannel | NewsChannel,
	text: string
): Promise<void> {
	if (!text.trim()) return Promise.resolve();

	const maxLength = 2000;
	const chunks: string[] = [];

	for (let i = 0; i < text.length; i += maxLength) {
		chunks.push(text.slice(i, i + maxLength));
	}

	// Send chunks sequentially to preserve order
	const sendChunk = (chunk: string): Promise<any> => channel.send(chunk);
	return chunks.reduce((promise, chunk) => promise.then(() => sendChunk(chunk)), Promise.resolve());
}

function subscribeToSession(
	session: AgentSession,
	channelId: string,
	channel: DMChannel | TextChannel | NewsChannel
): void {
	const responseBuffer: string[] = [];

	session.subscribe((event: AgentSessionEvent) => {
		switch (event.type) {
			case "agent_start":
				log(`[${channelId}] Agent starting...`);
				responseBuffer.length = 0;
				break;

			case "message_start":
				if (event.message.role === "assistant") {
					log(`[${channelId}] Assistant message started`);
					responseBuffer.length = 0;
				}
				break;

			case "message_update": {
				const assistantEvent = event.assistantMessageEvent;
				if (assistantEvent?.type === "text_delta") {
					responseBuffer.push(assistantEvent.delta);
				}
				if (assistantEvent?.type === "thinking_delta") {
					// Could send thinking to Discord as a separate message
					// For now, we just accumulate it
				}
				break;
			}

			case "message_end":
				if (event.message.role === "assistant") {
					// Get any remaining content
					const textContent = event.message.content?.find(
						(c: any) => c.type === "text"
					);
					if (textContent?.type === "text" && textContent.text) {
						responseBuffer.push(textContent.text);
					}

					const fullResponse = responseBuffer.join("");
					if (fullResponse.trim()) {
						log(`[${channelId}] Sending response (${fullResponse.length} chars)`);
						sendToDiscord(channel, fullResponse).catch((error) => {
							console.error(`[${channelId}] Failed to send response:`, error);
						});
					}
					responseBuffer.length = 0;
				}
				break;

			case "tool_execution_start":
				log(`[${channelId}] Tool started: ${event.toolName}`);
				sendToDiscord(channel, `🔧 Running \`${event.toolName}\`...`).catch(() => {});
				break;

			case "tool_execution_update":
				// Streaming tool output
				break;

			case "tool_execution_end":
				log(`[${channelId}] Tool ended: ${event.toolName} (error: ${event.isError})`);
				if (event.isError) {
					sendToDiscord(channel, "⚠️ Tool execution failed").catch(() => {});
				}
				break;

			case "agent_end":
				log(`[${channelId}] Agent ended`);
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
	// Message Processing
	// =========================================================================
	const subscribedSessions = new Set<string>();

	async function handleMessage(
		channel: DMChannel | TextChannel | NewsChannel | ThreadChannel,
		message: any
	): Promise<void> {
		const channelId = channel.id;
		const discordSession = await sessionStore.getOrCreate(channelId);
		const { session } = discordSession;

		// Subscribe to session events once
		if (!subscribedSessions.has(channelId)) {
			subscribeToSession(session, channelId, channel as DMChannel | TextChannel | NewsChannel);
			subscribedSessions.add(channelId);
		}

		// Update last activity
		sessionStore.touch(channelId);

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

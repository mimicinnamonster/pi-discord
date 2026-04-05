/**
 * Branch Reply Tests
 * Simulates the Discord reply → pi tree branching scenario.
 *
 * Key scenario:
 *   User: "hello"
 *   Bot:  "Hello!"                        ← bot-msg-1
 *   User: "my fave color is pink"  (reply to bot-msg-1)
 *   Bot:  "That's nice!"                  ← bot-msg-2
 *   User: "what is my fave color"  (reply to bot-msg-1 — branch BEFORE pink)
 *   Bot:  "I don't know!"                 ← bot-msg-3
 *   User: "pick one"               (reply to bot-msg-3)
 *   Bot:  "Blue!"                         ← bot-msg-4
 *
 * The test models the real async gap: bot response tracking happens in a
 * .then() callback AFTER sendUserMessage returns. If the next message arrives
 * before .then() fires, the parent lookup fails ("parent not found").
 *
 * The fix: capture the assistant entry ID at agent_end (synchronous) and store
 * it so the .then() uses a captured value rather than calling getLeafId() late.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { loadBranchMetadata, saveBranchMetadata } from "../src/branch-manager";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Minimal in-memory session tree mock
class MockSessionManager {
	private entries = new Map<string, { id: string; parentId: string | null; role: string; content: string }>();
	private _leafId: string | null = null;
	private idCounter = 0;

	appendEntry(role: "user" | "assistant", content: string): string {
		const id = `entry-${++this.idCounter}`;
		this.entries.set(id, { id, parentId: this._leafId, role, content });
		this._leafId = id;
		return id;
	}

	branch(entryId: string): void {
		if (!this.entries.has(entryId)) throw new Error(`Entry ${entryId} not found`);
		this._leafId = entryId;
	}

	getLeafId(): string | null {
		return this._leafId;
	}

	getEntry(id: string) {
		return this.entries.get(id) ?? null;
	}

	// Walk parent chain from leafId to root
	getBranch(fromId?: string): Array<{ id: string; parentId: string | null; role: string; content: string }> {
		const leafId = fromId ?? this._leafId;
		if (!leafId) return [];
		const path: Array<{ id: string; parentId: string | null; role: string; content: string }> = [];
		let current: string | null = leafId;
		while (current) {
			const entry = this.entries.get(current);
			if (!entry) break;
			path.unshift(entry);
			current = entry.parentId;
		}
		return path;
	}
}

/**
 * Simulate one Discord message turn, accurately modelling index.ts async behaviour:
 *
 * SYNCHRONOUS (happens before next message can arrive):
 *   - branch to parent entry (if reply)
 *   - append user entry
 *   - append assistant entry
 *   - capture assistantEntryId at "agent_end" (= getLeafId())
 *   - track user Discord msg → user Pi entry
 *
 * DEFERRED (models .then() from sendToDiscord - may arrive after next message):
 *   - track bot Discord msg → assistant Pi entry
 *
 * Returns flushBotTracking() to simulate the .then() completing.
 */
function simulateTurn(
	sm: MockSessionManager,
	sessionDir: string,
	channelId: string,
	discordUserMsgId: string,
	userContent: string,
	discordBotMsgId: string,
	botContent: string,
	replyToDiscordMsgId?: string
): { flushBotTracking: () => void } {
	// --- Synchronous part (before next message can arrive) ---
	const metadata = loadBranchMetadata(sessionDir, channelId);

	if (replyToDiscordMsgId) {
		const parentPiEntryId = metadata.discordMsgToPiEntryId.get(replyToDiscordMsgId);
		if (parentPiEntryId) {
			sm.branch(parentPiEntryId);
		}
	} else {
		// Non-reply: use persisted main branch tip (mirrors index.ts)
		if (metadata.mainBranchTip) sm.branch(metadata.mainBranchTip);
	}

	const userEntryId = sm.appendEntry("user", userContent);
	sm.appendEntry("assistant", botContent);

	// agent_end fires synchronously - capture leaf
	const capturedAssistantEntryId = sm.getLeafId()!;

	// Track user msg synchronously
	metadata.discordMsgToPiEntryId.set(discordUserMsgId, userEntryId);
	saveBranchMetadata(sessionDir, channelId, metadata);

	// Update persisted main branch tip for non-reply messages
	if (!replyToDiscordMsgId) {
		metadata.mainBranchTip = capturedAssistantEntryId;
		saveBranchMetadata(sessionDir, channelId, metadata);
	}

	// --- Deferred part (models async .then() from sendToDiscord) ---
	return {
		flushBotTracking: () => {
			const m = loadBranchMetadata(sessionDir, channelId);
			m.discordMsgToPiEntryId.set(discordBotMsgId, capturedAssistantEntryId);
			saveBranchMetadata(sessionDir, channelId, m);
		},
	};
}

describe("Branch Reply - tracking and context isolation", () => {
	let sessionDir: string;
	const channelId = "test-channel";

	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), "pi-discord-test-"));
	});

	it("bot tracking is deferred - not available before flush", () => {
		const sm = new MockSessionManager();

		const { flushBotTracking } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");

		// Before flush: bot-msg-1 not tracked yet
		expect(loadBranchMetadata(sessionDir, channelId).discordMsgToPiEntryId.has("bot-msg-1")).toBe(false);

		flushBotTracking();

		// After flush: tracked
		expect(loadBranchMetadata(sessionDir, channelId).discordMsgToPiEntryId.has("bot-msg-1")).toBe(true);
	});

	it("replying to bot message before flush causes parent-not-found (the race bug)", () => {
		const sm = new MockSessionManager();

		// Turn 1 - do NOT flush
		simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");

		// Next message arrives before flush - bot-msg-1 not found
		const meta = loadBranchMetadata(sessionDir, channelId);
		expect(meta.discordMsgToPiEntryId.has("bot-msg-1")).toBe(false);
	});

	it("replying to bot message after flush works correctly", () => {
		const sm = new MockSessionManager();

		const { flushBotTracking: flush1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		flush1();

		const { flushBotTracking: flush2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!", "bot-msg-1");
		flush2();

		const meta = loadBranchMetadata(sessionDir, channelId);
		expect(meta.discordMsgToPiEntryId.has("bot-msg-1")).toBe(true);
		expect(meta.discordMsgToPiEntryId.has("bot-msg-2")).toBe(true);
	});

	it("branch before pink: reply to bot-msg-1 does not include pink in context", () => {
		const sm = new MockSessionManager();

		const { flushBotTracking: flush1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		flush1();
		const { flushBotTracking: flush2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!", "bot-msg-1");
		flush2();

		// Branch off from bot-msg-1 (before pink)
		const { flushBotTracking: flush3 } = simulateTurn(sm, sessionDir, channelId, "user-msg-3", "what is my fave color", "bot-msg-3", "I don't know!", "bot-msg-1");
		flush3();

		const meta = loadBranchMetadata(sessionDir, channelId);
		const botEntry3 = meta.discordMsgToPiEntryId.get("bot-msg-3")!;
		const branch = sm.getBranch(botEntry3);
		const hasPink = branch.some(e => e.content.toLowerCase().includes("pink"));

		expect(hasPink).toBe(false);
	});

	it("continuing a sub-branch stays isolated from pink", () => {
		const sm = new MockSessionManager();

		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!", "bot-msg-1");
		f2();
		const { flushBotTracking: f3 } = simulateTurn(sm, sessionDir, channelId, "user-msg-3", "what is my fave color", "bot-msg-3", "I don't know!", "bot-msg-1");
		f3();
		const { flushBotTracking: f4 } = simulateTurn(sm, sessionDir, channelId, "user-msg-4", "pick one", "bot-msg-4", "Blue!", "bot-msg-3");
		f4();
		const { flushBotTracking: f5 } = simulateTurn(sm, sessionDir, channelId, "user-msg-5", "what color did you pick", "bot-msg-5", "I picked blue!", "bot-msg-4");
		f5();

		const meta = loadBranchMetadata(sessionDir, channelId);
		const botEntry5 = meta.discordMsgToPiEntryId.get("bot-msg-5")!;
		const branch = sm.getBranch(botEntry5);
		const hasPink = branch.some(e => e.content.toLowerCase().includes("pink"));

		expect(hasPink).toBe(false);
	});

	it("main branch still contains pink after sub-branch diverges", () => {
		const sm = new MockSessionManager();

		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!", "bot-msg-1");
		f2();

		// Sub-branch from bot-msg-1
		const { flushBotTracking: f3 } = simulateTurn(sm, sessionDir, channelId, "user-msg-3", "what is my fave color", "bot-msg-3", "I don't know!", "bot-msg-1");
		f3();

		// Main branch continues from bot-msg-2 (after pink)
		const { flushBotTracking: f4 } = simulateTurn(sm, sessionDir, channelId, "user-msg-4", "remind me my color", "bot-msg-4", "You said pink!", "bot-msg-2");
		f4();

		const meta = loadBranchMetadata(sessionDir, channelId);
		const botEntry4 = meta.discordMsgToPiEntryId.get("bot-msg-4")!;
		const branch = sm.getBranch(botEntry4);
		const hasPink = branch.some(e => e.content.toLowerCase().includes("pink"));

		expect(hasPink).toBe(true);
	});

	it("capturedAssistantEntryId maps to correct (assistant) entry, not user entry", () => {
		const sm = new MockSessionManager();

		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();

		const meta = loadBranchMetadata(sessionDir, channelId);
		const userEntry = meta.discordMsgToPiEntryId.get("user-msg-1")!;
		const botEntry = meta.discordMsgToPiEntryId.get("bot-msg-1")!;

		// They must be different entries
		expect(userEntry).not.toBe(botEntry);

		// Bot entry's parent should be the user entry
		const botNode = sm.getEntry(botEntry)!;
		expect(botNode.parentId).toBe(userEntry);
		expect(botNode.role).toBe("assistant");
	});

	it("non-reply after restart uses persisted main branch tip, not sub-thread leaf", () => {
		const sm = new MockSessionManager();

		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!");
		f2();

		// Reply sub-thread (moves leaf away from main)
		const { flushBotTracking: f3 } = simulateTurn(sm, sessionDir, channelId, "user-msg-3", "what color", "bot-msg-3", "I don't know!", "bot-msg-1");
		f3();
		const { flushBotTracking: f4 } = simulateTurn(sm, sessionDir, channelId, "user-msg-4", "pick one", "bot-msg-4", "Blue!", "bot-msg-3");
		f4();

		// Verify persisted mainBranchTip is bot-msg-2's assistant entry (after pink)
		const metaBefore = loadBranchMetadata(sessionDir, channelId);
		const mainTip = metaBefore.mainBranchTip!;
		expect(mainTip).toBeTruthy();

		// The main tip's branch should contain pink
		const mainBranch = sm.getBranch(mainTip);
		expect(mainBranch.some(e => e.content.toLowerCase().includes("pink"))).toBe(true);

		// The main tip's branch should NOT contain sub-thread content
		expect(mainBranch.some(e => e.content.includes("Blue"))).toBe(false);

		// Now simulate restart: new sm, same sessionDir - non-reply should branch to mainTip
		const sm2 = new MockSessionManager();
		// Rebuild sm2 entries to match (simulate loading from .jsonl)
		// We cheat by branching sm back to mainTip first, then adding a new turn
		sm.branch(mainTip);
		const { flushBotTracking: f5 } = simulateTurn(sm, sessionDir, channelId, "user-msg-5", "what is my fave color", "bot-msg-5", "It's pink!");
		f5();

		const meta5 = loadBranchMetadata(sessionDir, channelId);
		const entry5 = meta5.discordMsgToPiEntryId.get("bot-msg-5")!;
		const branch5 = sm.getBranch(entry5);

		// Should contain pink (main branch context)
		expect(branch5.some(e => e.content.toLowerCase().includes("pink"))).toBe(true);
		// Should NOT contain sub-thread content
		expect(branch5.some(e => e.content.includes("Blue"))).toBe(false);
	});

	it("non-reply message after reply sub-thread stays on main branch (not sub-thread)", () => {
		const sm = new MockSessionManager();

		// Turn 1: hello (non-reply, main branch)
		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();

		// Turn 2: pink (non-reply, main branch)
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!");
		f2();

		// Turn 3: reply sub-thread branching before pink
		const { flushBotTracking: f3 } = simulateTurn(sm, sessionDir, channelId, "user-msg-3", "what is my fave color", "bot-msg-3", "I don't know!", "bot-msg-1");
		f3();
		const { flushBotTracking: f4 } = simulateTurn(sm, sessionDir, channelId, "user-msg-4", "pick one", "bot-msg-4", "Blue!", "bot-msg-3");
		f4();

		// Turn 5: NON-reply — should continue main branch (after pink), NOT the sub-thread
		const { flushBotTracking: f5 } = simulateTurn(sm, sessionDir, channelId, "user-msg-5", "what is my fave color", "bot-msg-5", "It's pink!");
		f5();

		const meta = loadBranchMetadata(sessionDir, channelId);
		const botEntry5 = meta.discordMsgToPiEntryId.get("bot-msg-5")!;
		const branch5 = sm.getBranch(botEntry5);

		// Main branch should contain pink
		const hasPink = branch5.some(e => e.content.toLowerCase().includes("pink"));
		expect(hasPink).toBe(true);

		// And should NOT contain the sub-thread content ("I don't know", "Blue")
		const hasSubThread = branch5.some(e => e.content.includes("Blue"));
		expect(hasSubThread).toBe(false);
	});
});

// ============================================================================
// Helper: simulate /label command resolution logic (mirrors index.ts handleLabel)
// ============================================================================

/**
 * Resolves which Discord message ID to label, given:
 * - replyToDiscordMsgId: the message being replied to (if any)
 * - metadata: current channel branch metadata
 *
 * Mirrors the fixed handleLabel logic in index.ts:
 *   1. If replying to a message, label that message's pi entry
 *   2. Otherwise fall back to mainBranchTip reverse-lookup
 */
function resolveLabelTarget(
	replyToDiscordMsgId: string | undefined,
	metadata: ReturnType<typeof loadBranchMetadata>
): string | undefined {
	if (replyToDiscordMsgId) {
		return replyToDiscordMsgId;
	}
	if (metadata.mainBranchTip) {
		for (const [discordId, piId] of metadata.discordMsgToPiEntryId) {
			if (piId === metadata.mainBranchTip) return discordId;
		}
	}
	return undefined;
}

describe("/label command - resolution logic", () => {
	let sessionDir: string;
	const channelId = "test-channel";

	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), "pi-discord-label-test-"));
	});

	it("/label with no session entry for the command message fails (old bug)", () => {
		// This demonstrates the original bug: /label tried to look up the command
		// message's own ID, which is never tracked in discordMsgToPiEntryId.
		const sm = new MockSessionManager();
		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();

		const meta = loadBranchMetadata(sessionDir, channelId);
		// "/label" command message ID is never tracked - this would have caused
		// the old code to return "❌ Message not found in session"
		const piEntryId = meta.discordMsgToPiEntryId.get("label-cmd-msg-id");
		expect(piEntryId).toBeUndefined();
	});

	it("/label reply to bot message labels that bot message's pi entry", () => {
		const sm = new MockSessionManager();
		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();

		const meta = loadBranchMetadata(sessionDir, channelId);

		// User replies to bot-msg-1 with /label myname
		const targetId = resolveLabelTarget("bot-msg-1", meta);
		expect(targetId).toBe("bot-msg-1");

		const piEntryId = meta.discordMsgToPiEntryId.get(targetId!);
		expect(piEntryId).toBeDefined();

		// Store the label
		meta.labels.set("myname", { piEntryId: piEntryId!, discordMessageId: targetId!, timestamp: Date.now() });
		saveBranchMetadata(sessionDir, channelId, meta);

		const saved = loadBranchMetadata(sessionDir, channelId);
		expect(saved.labels.get("myname")?.piEntryId).toBe(piEntryId);
	});

	it("/label without reply falls back to mainBranchTip (most recent bot response)", () => {
		const sm = new MockSessionManager();
		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!");
		f2();

		const meta = loadBranchMetadata(sessionDir, channelId);

		// No reply - should resolve to bot-msg-2 (the mainBranchTip)
		const targetId = resolveLabelTarget(undefined, meta);
		expect(targetId).toBe("bot-msg-2");

		const piEntryId = meta.discordMsgToPiEntryId.get(targetId!);
		expect(piEntryId).toBeDefined();
		expect(piEntryId).toBe(meta.mainBranchTip);
	});

	it("/label without reply and no session returns undefined", () => {
		// Empty metadata - no mainBranchTip
		const meta = loadBranchMetadata(sessionDir, channelId);
		const targetId = resolveLabelTarget(undefined, meta);
		expect(targetId).toBeUndefined();
	});

	it("/label reply to sub-branch bot message labels that sub-branch entry", () => {
		const sm = new MockSessionManager();
		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!", "bot-msg-1");
		f2();
		// Sub-branch reply
		const { flushBotTracking: f3 } = simulateTurn(sm, sessionDir, channelId, "user-msg-3", "what is my fave color", "bot-msg-3", "I don't know!", "bot-msg-1");
		f3();

		const meta = loadBranchMetadata(sessionDir, channelId);

		// User replies to bot-msg-3 (sub-branch) with /label fork
		const targetId = resolveLabelTarget("bot-msg-3", meta);
		expect(targetId).toBe("bot-msg-3");

		const piEntryId = meta.discordMsgToPiEntryId.get("bot-msg-3")!;
		expect(piEntryId).toBeDefined();

		// The labeled pi entry should NOT be on the main branch (which contains pink)
		const labeledBranch = sm.getBranch(piEntryId);
		expect(labeledBranch.some(e => e.content.toLowerCase().includes("pink"))).toBe(false);
	});

	it("duplicate label name is rejected", () => {
		const sm = new MockSessionManager();
		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();

		const meta = loadBranchMetadata(sessionDir, channelId);
		const piEntryId = meta.discordMsgToPiEntryId.get("bot-msg-1")!;

		// Add label
		meta.labels.set("my-label", { piEntryId, discordMessageId: "bot-msg-1", timestamp: Date.now() });
		saveBranchMetadata(sessionDir, channelId, meta);

		// Attempting to add again - check it already exists
		const meta2 = loadBranchMetadata(sessionDir, channelId);
		expect(meta2.labels.has("my-label")).toBe(true);
	});
});

// ============================================================================
// Helper: simulate /merge and /summary resolution logic
// ============================================================================

/**
 * Simulates the full /merge operation:
 * 1. branch to currentPiEntryId (mainBranchTip)
 * 2. append merge user+assistant turn
 * 3. update mainBranchTip AFTER turn completes (the critical ordering)
 *
 * Returns the new assistant entry ID (merge result).
 */
function simulateMerge(
	sm: MockSessionManager,
	sessionDir: string,
	channelId: string,
	currentPiEntryId: string,  // where to inject merge (reply target or mainBranchTip)
	mergeContent: string,
	confirmDiscordMsgId = `merge-confirm-${Date.now()}`  // Discord ID for the "✅ Branch merged" msg
): { mergeEntryId: string; confirmDiscordMsgId: string } {
	sm.branch(currentPiEntryId);
	const mergeEntryId = sm.appendEntry("user", `Merged from branch:\n\n${mergeContent}`);

	const meta = loadBranchMetadata(sessionDir, channelId);
	if (currentPiEntryId === meta.mainBranchTip) {
		// Main branch merge: advance mainBranchTip
		meta.mainBranchTip = mergeEntryId;
	}
	// Track the confirmation message → mergeEntryId (original mappings preserved)
	meta.discordMsgToPiEntryId.set(confirmDiscordMsgId, mergeEntryId);
	saveBranchMetadata(sessionDir, channelId, meta);

	return { mergeEntryId, confirmDiscordMsgId };
}

/**
 * Resolves source and current Pi entry IDs for /merge and /summary.
 * Mirrors the fixed handleMerge/handleSummary logic in index.ts:
 *   - source: from label name, or from replied-to message
 *   - current: always mainBranchTip (command message is never tracked)
 */
function resolveMergeArgs(
	replyToDiscordMsgId: string | undefined,  // the message /merge is replying TO (determines current position)
	labelName: string | undefined,
	metadata: ReturnType<typeof loadBranchMetadata>,
	sourceReplyToDiscordMsgId?: string  // explicit source (when no label and no reply source)
): { sourcePiEntryId: string | undefined; currentPiEntryId: string | null; error?: string } {
	let sourcePiEntryId: string | undefined;

	if (labelName) {
		const label = metadata.labels.get(labelName);
		if (!label) return { sourcePiEntryId: undefined, currentPiEntryId: null, error: `Label '${labelName}' not found` };
		sourcePiEntryId = label.piEntryId;
	} else if (sourceReplyToDiscordMsgId) {
		sourcePiEntryId = metadata.discordMsgToPiEntryId.get(sourceReplyToDiscordMsgId);
		if (!sourcePiEntryId) return { sourcePiEntryId: undefined, currentPiEntryId: null, error: "Replied-to message not in session" };
	} else {
		return { sourcePiEntryId: undefined, currentPiEntryId: null, error: "Specify a label name or reply to the message to merge from" };
	}

	// Current position: if /merge replies to a message, use that entry; else mainBranchTip
	let currentPiEntryId: string | null;
	if (replyToDiscordMsgId) {
		currentPiEntryId = metadata.discordMsgToPiEntryId.get(replyToDiscordMsgId) ?? null;
		if (!currentPiEntryId) return { sourcePiEntryId, currentPiEntryId: null, error: "Replied-to message not tracked in session" };
	} else {
		currentPiEntryId = metadata.mainBranchTip;
	}
	if (!currentPiEntryId) return { sourcePiEntryId, currentPiEntryId: null, error: "No current position — send a message first" };

	return { sourcePiEntryId, currentPiEntryId };
}

describe("/merge command - resolution logic", () => {
	let sessionDir: string;
	const channelId = "test-channel";

	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), "pi-discord-merge-test-"));
	});

	it("/merge command message ID is not in session - old bug", () => {
		const sm = new MockSessionManager();
		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();

		const meta = loadBranchMetadata(sessionDir, channelId);
		// The /merge command message ID is never tracked
		const piEntryId = meta.discordMsgToPiEntryId.get("merge-cmd-msg-id");
		expect(piEntryId).toBeUndefined();
	});

	it("/merge with label resolves source from label, current from mainBranchTip", () => {
		const sm = new MockSessionManager();
		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!");
		f2();

		// Label bot-msg-1
		const meta = loadBranchMetadata(sessionDir, channelId);
		const bot1Entry = meta.discordMsgToPiEntryId.get("bot-msg-1")!;
		meta.labels.set("checkpoint", { piEntryId: bot1Entry, discordMessageId: "bot-msg-1", timestamp: Date.now() });
		saveBranchMetadata(sessionDir, channelId, meta);

		const meta2 = loadBranchMetadata(sessionDir, channelId);
		const { sourcePiEntryId, currentPiEntryId, error } = resolveMergeArgs(undefined, "checkpoint", meta2);

		expect(error).toBeUndefined();
		expect(sourcePiEntryId).toBe(bot1Entry);
		expect(currentPiEntryId).toBe(meta2.mainBranchTip);
	});

	it("/merge without label or reply returns error", () => {
		const sm = new MockSessionManager();
		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();

		const meta = loadBranchMetadata(sessionDir, channelId);
		const { error } = resolveMergeArgs(undefined, undefined, meta);
		expect(error).toBeTruthy();
	});

	it("/merge reply to bot message uses that as source, mainBranchTip as current", () => {
		const sm = new MockSessionManager();
		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!");
		f2();
		// Sub-branch
		const { flushBotTracking: f3 } = simulateTurn(sm, sessionDir, channelId, "user-msg-3", "what color", "bot-msg-3", "Blue!", "bot-msg-1");
		f3();

		const meta = loadBranchMetadata(sessionDir, channelId);
		// /merge replies to bot-msg-3 (source), sent from main branch (no reply for current)
		const { sourcePiEntryId, currentPiEntryId, error } = resolveMergeArgs(undefined, undefined, meta, "bot-msg-3");

		expect(error).toBeUndefined();
		expect(sourcePiEntryId).toBe(meta.discordMsgToPiEntryId.get("bot-msg-3"));
		expect(currentPiEntryId).toBe(meta.mainBranchTip);
	});

	it("/merge label not found returns error", () => {
		const sm = new MockSessionManager();
		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();

		const meta = loadBranchMetadata(sessionDir, channelId);
		const { error } = resolveMergeArgs(undefined, "nonexistent", meta);
		expect(error).toMatch(/not found/);
	});

	it("merge produces no bot response (silent context injection)", () => {
		const sm = new MockSessionManager();

		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!");
		f2();
		const { flushBotTracking: f3 } = simulateTurn(sm, sessionDir, channelId, "user-msg-3", "what color", "bot-msg-3", "Blue!", "bot-msg-1");
		f3();

		const meta = loadBranchMetadata(sessionDir, channelId);
		const { mergeEntryId } = simulateMerge(sm, sessionDir, channelId, meta.mainBranchTip!, "[assistant]: Blue!");

		// The merge entry is a user message (not assistant)
		const mergeEntry = sm.getEntry(mergeEntryId)!;
		expect(mergeEntry.role).toBe("user");
		expect(mergeEntry.content).toContain("Merged from branch");

		// The leaf after merge is the user entry, not an assistant response
		expect(sm.getLeafId()).toBe(mergeEntryId);
	});

	it("/merge with no mainBranchTip returns error", () => {
		// Empty channel - no messages yet
		const meta = loadBranchMetadata(sessionDir, channelId);
		meta.discordMsgToPiEntryId.set("some-msg", "some-entry");
		saveBranchMetadata(sessionDir, channelId, meta);

		const meta2 = loadBranchMetadata(sessionDir, channelId);
		// No reply (current = mainBranchTip which is null), no label, no source
		const { error } = resolveMergeArgs(undefined, undefined, meta2);
		expect(error).toBeTruthy();
	});

	it("next non-reply after merge continues from merge result (not old mainBranchTip)", () => {
		const sm = new MockSessionManager();

		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!");
		f2();

		// Sub-branch (no pink)
		const { flushBotTracking: f3 } = simulateTurn(sm, sessionDir, channelId, "user-msg-3", "what color", "bot-msg-3", "Blue!", "bot-msg-1");
		f3();

		const metaBefore = loadBranchMetadata(sessionDir, channelId);
		const mainTipBefore = metaBefore.mainBranchTip!;

		// Merge sub-branch into main
		const { mergeEntryId: mergeAssistantEntryId } = simulateMerge(sm, sessionDir, channelId, mainTipBefore, "[assistant]: Blue!");

		// mainBranchTip now points to merge result
		const metaAfterMerge = loadBranchMetadata(sessionDir, channelId);
		expect(metaAfterMerge.mainBranchTip).toBe(mergeAssistantEntryId);
		expect(metaAfterMerge.mainBranchTip).not.toBe(mainTipBefore);

		// Next non-reply continues from merge result
		const { flushBotTracking: f4 } = simulateTurn(sm, sessionDir, channelId, "user-msg-4", "what colors did you see", "bot-msg-4", "Pink and Blue!");
		f4();

		const meta4 = loadBranchMetadata(sessionDir, channelId);
		const botEntry4 = meta4.discordMsgToPiEntryId.get("bot-msg-4")!;
		const branch4 = sm.getBranch(botEntry4);

		// Branch should include the merge user message (silent inject, no bot response)
		expect(branch4.some(e => e.content.includes("Merged from branch"))).toBe(true);
		// And main branch context (pink)
		expect(branch4.some(e => e.content.toLowerCase().includes("pink"))).toBe(true);
		// And the merged sub-branch content (Blue)
		expect(branch4.some(e => e.content.includes("Blue"))).toBe(true);
		// No bot response generated during merge
		const mergeEntry = sm.getEntry(mergeAssistantEntryId)!;
		expect(mergeEntry.role).toBe("user"); // merge entry is user, not assistant
	});

	it("without mainBranchTip update after merge, next non-reply loses merged context", () => {
		const sm = new MockSessionManager();

		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!");
		f2();
		const { flushBotTracking: f3 } = simulateTurn(sm, sessionDir, channelId, "user-msg-3", "what color", "bot-msg-3", "Blue!", "bot-msg-1");
		f3();

		const metaBefore = loadBranchMetadata(sessionDir, channelId);
		const oldMainTip = metaBefore.mainBranchTip!;

		// Buggy merge: append user entry but do NOT update mainBranchTip
		sm.branch(oldMainTip);
		sm.appendEntry("user", "Merged from branch: [assistant]: Blue!");
		// mainBranchTip NOT updated

		// Next non-reply branches from OLD tip - merge result is orphaned
		const { flushBotTracking: f4 } = simulateTurn(sm, sessionDir, channelId, "user-msg-4", "what colors did you see", "bot-msg-4", "Only pink!");
		f4();

		const meta4 = loadBranchMetadata(sessionDir, channelId);
		const botEntry4 = meta4.discordMsgToPiEntryId.get("bot-msg-4")!;
		const branch4 = sm.getBranch(botEntry4);

		// Merge content is NOT in the branch - lost context
		expect(branch4.some(e => e.content.includes("Merged from branch"))).toBe(false);
	});

	it("/merge in sub-branch uses reply target as current position (not mainBranchTip)", () => {
		const sm = new MockSessionManager();

		// Main branch: hello → pink
		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!");
		f2();

		// Sub-branch (no pink)
		const { flushBotTracking: f3 } = simulateTurn(sm, sessionDir, channelId, "user-msg-3", "what color", "bot-msg-3", "Blue!", "bot-msg-1");
		f3();
		const { flushBotTracking: f4 } = simulateTurn(sm, sessionDir, channelId, "user-msg-4", "are you sure", "bot-msg-4", "Yes, Blue!", "bot-msg-3");
		f4();

		const meta = loadBranchMetadata(sessionDir, channelId);
		const mainTip = meta.mainBranchTip!;
		const subBranchTip = meta.discordMsgToPiEntryId.get("bot-msg-4")!;
		const label1PiEntry = meta.discordMsgToPiEntryId.get("bot-msg-2")!;
		const metaWithLabel: ReturnType<typeof loadBranchMetadata> = {
			...meta,
			labels: new Map([["label-1", { piEntryId: label1PiEntry, discordMessageId: "bot-msg-2", timestamp: 0 }]])
		};

		// /merge label-1 sent as reply to bot-msg-4 (in sub-branch)
		const { currentPiEntryId, error } = resolveMergeArgs("bot-msg-4", "label-1", metaWithLabel);

		expect(error).toBeUndefined();
		// current should be bot-msg-4's entry (sub-branch), NOT mainBranchTip
		expect(currentPiEntryId).toBe(subBranchTip);
		expect(currentPiEntryId).not.toBe(mainTip);
	});

	it("/merge in sub-branch injects merge content at sub-branch position", () => {
		const sm = new MockSessionManager();

		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!");
		f2();
		const { flushBotTracking: f3 } = simulateTurn(sm, sessionDir, channelId, "user-msg-3", "what color", "bot-msg-3", "Blue!", "bot-msg-1");
		f3();
		const { flushBotTracking: f4 } = simulateTurn(sm, sessionDir, channelId, "user-msg-4", "are you sure", "bot-msg-4", "Yes, Blue!", "bot-msg-3");
		f4();

		const meta = loadBranchMetadata(sessionDir, channelId);
		const subBranchTip = meta.discordMsgToPiEntryId.get("bot-msg-4")!;
		const mainTip = meta.mainBranchTip!;

		// Merge into sub-branch at bot-msg-4 (don't update mainBranchTip)
		const { mergeEntryId } = simulateMerge(sm, sessionDir, channelId, subBranchTip, "[user]: pink [assistant]: That's nice!");

		// Merge was injected at sub-branch position
		const mergeEntry = sm.getEntry(mergeEntryId)!;
		expect(mergeEntry.parentId).toBe(subBranchTip);

		// mainBranchTip is unchanged
		const metaAfter = loadBranchMetadata(sessionDir, channelId);
		expect(metaAfter.mainBranchTip).toBe(mainTip);

		// The merge entry's branch includes sub-branch content (Blue)
		const mergeBranch = sm.getBranch(mergeEntryId);
		expect(mergeBranch.some(e => e.content.includes("Blue"))).toBe(true);
		expect(mergeBranch.some(e => e.content.includes("Merged from branch"))).toBe(true);
	});

	it("/merge in main branch (no reply) uses mainBranchTip as current", () => {
		const sm = new MockSessionManager();

		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!");
		f2();
		const { flushBotTracking: f3 } = simulateTurn(sm, sessionDir, channelId, "user-msg-3", "what color", "bot-msg-3", "Blue!", "bot-msg-1");
		f3();

		const meta = loadBranchMetadata(sessionDir, channelId);
		const mainTip = meta.mainBranchTip!;
		const label1PiEntry = meta.discordMsgToPiEntryId.get("bot-msg-3")!;
		const metaWithLabel: ReturnType<typeof loadBranchMetadata> = {
			...meta,
			labels: new Map([["label-1", { piEntryId: label1PiEntry, discordMessageId: "bot-msg-3", timestamp: 0 }]])
		};

		// /merge with no reply - current = mainBranchTip
		const { currentPiEntryId, error } = resolveMergeArgs(undefined, "label-1", metaWithLabel);

		expect(error).toBeUndefined();
		expect(currentPiEntryId).toBe(mainTip);
	});

	it("sub-branch merge does NOT update mainBranchTip", () => {
		const sm = new MockSessionManager();

		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!");
		f2();
		const { flushBotTracking: f3 } = simulateTurn(sm, sessionDir, channelId, "user-msg-3", "what color", "bot-msg-3", "Blue!", "bot-msg-1");
		f3();

		const meta = loadBranchMetadata(sessionDir, channelId);
		const mainTipBefore = meta.mainBranchTip!; // bot-msg-2's assistant entry
		const subBranchTip = meta.discordMsgToPiEntryId.get("bot-msg-3")!;

		// Merge INTO sub-branch (currentPiEntryId = subBranchTip, not mainBranchTip)
		const { mergeEntryId: _me } = simulateMerge(sm, sessionDir, channelId, subBranchTip, "[user]: pink");

		// mainBranchTip must NOT change
		const metaAfter = loadBranchMetadata(sessionDir, channelId);
		expect(metaAfter.mainBranchTip).toBe(mainTipBefore);
	});

	it("after sub-branch merge, reply to original bot message continues from merge entry (not sibling)", () => {
		const sm = new MockSessionManager();

		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!");
		f2();
		// Sub-branch
		const { flushBotTracking: f3 } = simulateTurn(sm, sessionDir, channelId, "user-msg-3", "what color", "bot-msg-3", "Blue and purple!", "bot-msg-1");
		f3();

		const meta = loadBranchMetadata(sessionDir, channelId);
		const subBranchTip = meta.discordMsgToPiEntryId.get("bot-msg-3")!;

		// Merge main-branch content into sub-branch
		const { mergeEntryId } = simulateMerge(sm, sessionDir, channelId, subBranchTip, "[user]: pink [assistant]: That's nice!");

		// bot-msg-3 should now map to mergeEntryId (remapped)
		const metaAfter = loadBranchMetadata(sessionDir, channelId);
		expect(metaAfter.discordMsgToPiEntryId.get("bot-msg-3")).toBe(mergeEntryId);

		// Next reply to bot-msg-3 should branch from mergeEntryId (not subBranchTip)
		const { flushBotTracking: f4 } = simulateTurn(sm, sessionDir, channelId, "user-msg-4", "did i pick a color", "bot-msg-4", "Yes, pink!", "bot-msg-3");
		f4();

		const meta4 = loadBranchMetadata(sessionDir, channelId);
		const botEntry4 = meta4.discordMsgToPiEntryId.get("bot-msg-4")!;
		const branch4 = sm.getBranch(botEntry4);

		// Branch should include the merge content (pink)
		expect(branch4.some(e => e.content.includes("Merged from branch"))).toBe(true);
		expect(branch4.some(e => e.content.toLowerCase().includes("pink"))).toBe(true);
		// The user's message should be child of mergeEntryId (not subBranchTip)
		const userEntry4 = sm.getEntry(meta4.discordMsgToPiEntryId.get("user-msg-4")!)!;
		expect(userEntry4.parentId).toBe(mergeEntryId);
	});

	it("without remap, reply to original bot message after sub-branch merge creates sibling (bug)", () => {
		const sm = new MockSessionManager();

		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!");
		f2();
		const { flushBotTracking: f3 } = simulateTurn(sm, sessionDir, channelId, "user-msg-3", "what color", "bot-msg-3", "Blue!", "bot-msg-1");
		f3();

		const meta = loadBranchMetadata(sessionDir, channelId);
		const subBranchTip = meta.discordMsgToPiEntryId.get("bot-msg-3")!;

		// Buggy merge: inject but do NOT remap bot-msg-3
		sm.branch(subBranchTip);
		const mergeEntryId = sm.appendEntry("user", "Merged from branch: pink");
		// (no remap)

		// Next reply to bot-msg-3 still branches to subBranchTip (pre-merge)
		const { flushBotTracking: f4 } = simulateTurn(sm, sessionDir, channelId, "user-msg-4", "did i pick a color", "bot-msg-4", "No!", "bot-msg-3");
		f4();

		const meta4 = loadBranchMetadata(sessionDir, channelId);
		const userEntry4 = sm.getEntry(meta4.discordMsgToPiEntryId.get("user-msg-4")!)!;
		// Parent is subBranchTip (not mergeEntryId) - merge is skipped
		expect(userEntry4.parentId).toBe(subBranchTip);
		expect(userEntry4.parentId).not.toBe(mergeEntryId);
	});

	it("sub-branch merge does not corrupt mainBranchTip - next non-reply continues from main branch", () => {
		const sm = new MockSessionManager();

		const { flushBotTracking: f1 } = simulateTurn(sm, sessionDir, channelId, "user-msg-1", "hello", "bot-msg-1", "Hello!");
		f1();
		const { flushBotTracking: f2 } = simulateTurn(sm, sessionDir, channelId, "user-msg-2", "my fave color is pink", "bot-msg-2", "That's nice!");
		f2();
		const { flushBotTracking: f3 } = simulateTurn(sm, sessionDir, channelId, "user-msg-3", "what color", "bot-msg-3", "Blue!", "bot-msg-1");
		f3();

		const meta = loadBranchMetadata(sessionDir, channelId);
		const mainTipBefore = meta.mainBranchTip!;
		const subBranchTip = meta.discordMsgToPiEntryId.get("bot-msg-3")!;

		// Merge into sub-branch
		const { mergeEntryId: _me } = simulateMerge(sm, sessionDir, channelId, subBranchTip, "[user]: pink");

		// Next non-reply should branch from mainBranchTip (main branch), NOT the sub-branch merge
		const { flushBotTracking: f4 } = simulateTurn(sm, sessionDir, channelId, "user-msg-4", "what is my fave color", "bot-msg-4", "Pink!");
		f4();

		const meta4 = loadBranchMetadata(sessionDir, channelId);
		const botEntry4 = meta4.discordMsgToPiEntryId.get("bot-msg-4")!;
		const branch4 = sm.getBranch(botEntry4);

		// Should be on the main branch (contains pink)
		expect(branch4.some(e => e.content.toLowerCase().includes("pink"))).toBe(true);
		// Should NOT contain sub-branch merge content
		expect(branch4.some(e => e.content.includes("Merged from branch"))).toBe(false);
		// Parent chain should go through main branch tip, not sub-branch
		const mainTipEntry = sm.getEntry(mainTipBefore)!;
		expect(branch4.some(e => e.id === mainTipBefore)).toBe(true);
	});
});

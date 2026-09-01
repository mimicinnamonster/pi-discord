import { describe, it, expect, beforeEach } from "vitest";
import {
	findCommonAncestor,
	getMessagesBetween,
	getLastDeepestLeaf,
	getLastRootDeepestLeaf,
	formatMergedMessages,
	isOrphanedBranch,
	getRootEntries,
	areOnSameBranch,
	loadBranchMetadata,
	saveBranchMetadata,
} from "../src/branch-manager";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { SessionManager, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Mocks
// ============================================================================

class MockSessionManager implements SessionManager {
	private entries = new Map<string, SessionEntry>();

	addEntry(entry: SessionEntry) {
		this.entries.set(entry.id, entry);
	}

	getEntry(id: string): SessionEntry | null {
		return this.entries.get(id) ?? null;
	}

	getBranch(entryId: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		let current: string | null = entryId;
		while (current) {
			const entry = this.getEntry(current);
			if (!entry) break;
			path.unshift(entry);
			current = entry.parentId;
		}
		return path;
	}

	// Other SessionManager methods not needed for branch-manager
	async createSession() {}
	async getSession() {}
	async deleteSession() {}
	async listSessions() {}
}

// Helper to create a message entry
function createMsg(id: string, parentId: string | null, role: string, content: string): SessionMessageEntry {
	return {
		id,
		parentId,
		type: "message",
		message: {
			role,
			content: role === "assistant" ? [{ type: "text", text: content }] : content,
		},
	} as any;
}

// ============================================================================
// Tests
// ============================================================================

describe("Branch Manager Unit Tests", () => {
	let sm: MockSessionManager;

	beforeEach(() => {
		sm = new MockSessionManager();
	});

	describe("findCommonAncestor", () => {
		it("finds the same entry if they are the same", () => {
			sm.addEntry(createMsg("1", null, "user", "hi"));
			expect(findCommonAncestor("1", "1", sm)).toBe("1");
		});

		it("finds the parent as common ancestor", () => {
			sm.addEntry(createMsg("1", null, "user", "hi"));
			sm.addEntry(createMsg("2", "1", "assistant", "hello"));
			sm.addEntry(createMsg("3", "2", "user", "how are you"));
			sm.addEntry(createMsg("4", "2", "user", "what time is it"));

			expect(findCommonAncestor("3", "4", sm)).toBe("2");
		});

		it("finds the root as common ancestor for distant branches", () => {
			sm.addEntry(createMsg("1", null, "user", "hi"));
			sm.addEntry(createMsg("2", "1", "assistant", "hello"));
			sm.addEntry(createMsg("3", "2", "user", "a"));
			sm.addEntry(createMsg("4", "1", "user", "b"));
			sm.addEntry(createMsg("5", "4", "assistant", "c"));

			expect(findCommonAncestor("3", "5", sm)).toBe("1");
		});
	});

	describe("getMessagesBetween", () => {
		it("returns entries from fork point to leaf", () => {
			sm.addEntry(createMsg("1", null, "user", "hi"));
			sm.addEntry(createMsg("2", "1", "assistant", "hello"));
			sm.addEntry(createMsg("3", "2", "user", "a"));
			sm.addEntry(createMsg("4", "3", "assistant", "b"));

			const between = getMessagesBetween("2", "4", sm);
			expect(between.map(e => e.id)).toEqual(["2", "3", "4"]);
		});

		it("returns empty array if fromEntryId is not an ancestor", () => {
			sm.addEntry(createMsg("1", null, "user", "hi"));
			sm.addEntry(createMsg("2", "1", "assistant", "hello"));
			sm.addEntry(createMsg("3", "1", "user", "b"));

			const between = getMessagesBetween("2", "3", sm);
			expect(between).toEqual([]);
		});
	});

	describe("Tree Leaf Utilities", () => {
		const node1: any = {
			entry: { id: "1" },
			children: [
				{
					entry: { id: "2" },
					children: [
						{ entry: { id: "3" }, children: [] }
					]
				},
				{
					entry: { id: "4" },
					children: [
						{
							entry: { id: "5" },
							children: [
								{ entry: { id: "6" }, children: [] }
							]
						}
					]
				}
			]
		};

		it("getLastDeepestLeaf finds the last leaf of the last child", () => {
			expect(getLastDeepestLeaf(node1)).toBe("6");
		});

		it("getLastDeepestLeaf returns null for undefined", () => {
			expect(getLastDeepestLeaf(undefined)).toBeNull();
		});

		it("getLastRootDeepestLeaf finds deepest leaf of the last root", () => {
			const tree = [
				{
					entry: { id: "root1", parentId: null },
					children: [{ entry: { id: "leaf1" }, children: [] }]
				},
				{
					entry: { id: "root2", parentId: null },
					children: [{ entry: { id: "leaf2" }, children: [] }]
				}
			];
			expect(getLastRootDeepestLeaf(tree)).toBe("leaf2");
		});
	});

	describe("formatMergedMessages", () => {
		it("formats user and assistant messages correctly", () => {
			const entries = [
				createMsg("1", null, "user", "Hello there"),
				createMsg("2", "1", "assistant", "Hi! How can I help?"),
			];
			const result = formatMergedMessages(entries);
			expect(result).toBe("[user]: Hello there\n\n[assistant]: Hi! How can I help?");
		});

		it("handles assistant messages with array content", () => {
			const assistantMsg: SessionMessageEntry = {
				id: "2",
				parentId: "1",
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Part 1 " },
						{ type: "text", text: "Part 2" },
						{ type: "image", url: "..." }
					]
				}
			} as any;
			const entries = [
				createMsg("1", null, "user", "Hi"),
				assistantMsg,
			];
			const result = formatMergedMessages(entries);
			expect(result).toBe("[user]: Hi\n\n[assistant]: Part 1 Part 2");
		});

		it("skips non-message entries", () => {
			const entries = [
				createMsg("1", null, "user", "Hi"),
				{ id: "2", parentId: "1", type: "compaction" } as any,
				createMsg("3", "2", "assistant", "Hello"),
			];
			const result = formatMergedMessages(entries);
			expect(result).toBe("[user]: Hi\n\n[assistant]: Hello");
		});
	});

	describe("isOrphanedBranch", () => {
		it("returns false if no parent recorded", () => {
			const meta: any = { discordMsgParent: new Map() };
			expect(isOrphanedBranch("msg1", meta, sm)).toBe(false);
		});

		it("returns true if parent discord msg is not mapped to a pi entry", () => {
			const meta: any = {
				discordMsgParent: new Map([["msg2", "msg1"]]),
				discordMsgToPiEntryId: new Map(),
			};
			expect(isOrphanedBranch("msg2", meta, sm)).toBe(true);
		});

		it("returns false if parent exists in session", () => {
			const meta: any = {
				discordMsgParent: new Map([["msg2", "msg1"]]),
				discordMsgToPiEntryId: new Map([["msg1", "entry1"]]),
			};
			expect(isOrphanedBranch("msg2", meta, sm)).toBe(false);
		});
	});

	describe("areOnSameBranch", () => {
		it("returns true for ancestor and descendant", () => {
			sm.addEntry(createMsg("1", null, "user", "hi"));
			sm.addEntry(createMsg("2", "1", "assistant", "hello"));
			sm.addEntry(createMsg("3", "2", "user", "a"));

			expect(areOnSameBranch("1", "3", sm)).toBe(true);
			expect(areOnSameBranch("3", "1", sm)).toBe(true);
		});

		it("returns false for siblings", () => {
			sm.addEntry(createMsg("1", null, "user", "hi"));
			sm.addEntry(createMsg("2", "1", "assistant", "hello"));
			sm.addEntry(createMsg("3", "1", "user", "b"));

			expect(areOnSameBranch("2", "3", sm)).toBe(false);
		});
	});

	describe("Persistence", () => {
		let sessionDir: string;
		const channelId = "test-channel";

		beforeEach(() => {
			sessionDir = mkdtempSync(join(tmpdir(), "pi-branch-meta-test-"));
		});

		it("saves and loads metadata correctly", () => {
			const meta: any = {
				discordMsgToPiEntryId: new Map([["msg1", "entry1"]]),
				discordMsgParent: new Map([["msg2", "msg1"]]),
				labels: new Map([["label1", { piEntryId: "entry1", discordMessageId: "msg1", timestamp: 123 }]]),
				labelCounter: 5,
				mainBranchTip: "entry1",
			};

			saveBranchMetadata(sessionDir, channelId, meta);
			const loaded = loadBranchMetadata(sessionDir, channelId);

			expect(loaded.discordMsgToPiEntryId.get("msg1")).toBe("entry1");
			expect(loaded.discordMsgParent.get("msg2")).toBe("msg1");
			expect(loaded.labels.get("label1")).toEqual({ piEntryId: "entry1", discordMessageId: "msg1", timestamp: 123 });
			expect(loaded.labelCounter).toBe(5);
			expect(loaded.mainBranchTip).toBe("entry1");
		});

		it("returns defaults when file does not exist", () => {
			const loaded = loadBranchMetadata(sessionDir, channelId);
			expect(loaded.discordMsgToPiEntryId).toBeInstanceOf(Map);
			expect(loaded.labelCounter).toBe(0);
			expect(loaded.mainBranchTip).toBeNull();
		});
	});
});

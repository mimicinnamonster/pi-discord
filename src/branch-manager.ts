/**
 * Branch Manager - Manages Discord reply tree structure
 * Maps Discord messages to pi session tree entries
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { SessionManager, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

// SessionTreeNode is not exported publicly, but we can use duck typing
interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	label?: string;
}

// ============================================================================
// Types
// ============================================================================

export interface ChannelBranches {
	// Discord message ID → Pi entry ID mapping
	discordMsgToPiEntryId: Map<string, string>;

	// Discord message ID → parent Discord message ID (for reply chain traversal)
	discordMsgParent: Map<string, string>;

	// Labels: name → { piEntryId, discordMessageId, timestamp }
	labels: Map<string, {
		piEntryId: string;
		discordMessageId: string;
		timestamp: number;
	}>;

	// Auto-increment counter for label-1, label-2, etc.
	labelCounter: number;

	// The Pi entry ID at the tip of the main (non-reply) branch
	// Persisted so it survives bot restarts
	mainBranchTip: string | null;
}

// ============================================================================
// Persistence
// ============================================================================

function getBranchMetadataPath(sessionDir: string, channelId: string): string {
	return join(sessionDir, `discord-${channelId}-branches.json`);
}

export function loadBranchMetadata(sessionDir: string, channelId: string): ChannelBranches {
	const path = getBranchMetadataPath(sessionDir, channelId);

	try {
		if (existsSync(path)) {
			const content = readFileSync(path, "utf-8");
			const data = JSON.parse(content);

			return {
				discordMsgToPiEntryId: new Map(data.discordMsgToPiEntryId || []),
				discordMsgParent: new Map(data.discordMsgParent || []),
				labels: new Map(
					(data.labels || []).map((entry: any) => [
						entry[0],
						entry[1],
					])
				),
				labelCounter: data.labelCounter || 0,
				mainBranchTip: data.mainBranchTip || null,
			};
		}
	} catch (error) {
		console.error(`[branch-manager] Failed to load metadata for channel ${channelId}:`, error);
	}

	return {
		discordMsgToPiEntryId: new Map(),
		discordMsgParent: new Map(),
		labels: new Map(),
		labelCounter: 0,
		mainBranchTip: null,
	};
}

export function saveBranchMetadata(sessionDir: string, channelId: string, metadata: ChannelBranches): void {
	const path = getBranchMetadataPath(sessionDir, channelId);

	try {
		const data = {
			discordMsgToPiEntryId: Array.from(metadata.discordMsgToPiEntryId.entries()),
			discordMsgParent: Array.from(metadata.discordMsgParent.entries()),
			labels: Array.from(metadata.labels.entries()),
			labelCounter: metadata.labelCounter,
			mainBranchTip: metadata.mainBranchTip,
		};

		writeFileSync(path, JSON.stringify(data, null, 2));
	} catch (error) {
		console.error(`[branch-manager] Failed to save metadata for channel ${channelId}:`, error);
	}
}

// ============================================================================
// Tree Traversal
// ============================================================================

/**
 * Find the common ancestor of two entries in the tree.
 * Walks up from both entries until they meet.
 */
export function findCommonAncestor(
	entryId1: string,
	entryId2: string,
	sessionManager: SessionManager
): string {
	// Collect all ancestors of entryId1
	const ancestors1 = new Set<string>();
	let current = entryId1;

	while (current) {
		ancestors1.add(current);
		const entry = sessionManager.getEntry(current);
		if (!entry) break;
		if (!entry.parentId) break; // Reached root
		current = entry.parentId;
	}

	// Walk up from entryId2 until we find a common ancestor
	current = entryId2;
	while (current) {
		if (ancestors1.has(current)) {
			return current; // Found common ancestor
		}
		const entry = sessionManager.getEntry(current);
		if (!entry) break;
		if (!entry.parentId) break; // Reached root
		current = entry.parentId;
	}

	// No common ancestor found - shouldn't happen in well-formed tree
	return entryId1;
}

/**
 * Get all entries from fork point to leaf (inclusive).
 * Uses tree's getBranch() to get path from root to leaf,
 * then slices to get from fork point onward.
 */
export function getMessagesBetween(
	fromEntryId: string,
	toEntryId: string,
	sessionManager: SessionManager
): SessionEntry[] {
	// Get full path from root to toEntryId
	const fullPath = sessionManager.getBranch(toEntryId);

	// Find starting index (fromEntryId position)
	const startIdx = fullPath.findIndex(e => e.id === fromEntryId);
	if (startIdx === -1) return [];

	// Return entries from fork point onward (inclusive)
	return fullPath.slice(startIdx);
}

/**
 * Get the deepest leaf of a tree node.
 * Recursively traverses children to find the last leaf.
 */
export function getLastDeepestLeaf(treeNode: SessionTreeNode | undefined): string | null {
	if (!treeNode) return null;

	// If this node has children, recurse into the last child
	if (treeNode.children && treeNode.children.length > 0) {
		return getLastDeepestLeaf(treeNode.children[treeNode.children.length - 1]);
	}

	// This is a leaf
	return treeNode.entry.id;
}

/**
 * Find the last root node (entry with parentId === null) in the tree,
 * then return its deepest descendant.
 * Used for non-reply messages which chain sequentially on main branch.
 */
export function getLastRootDeepestLeaf(tree: SessionTreeNode[]): string | null {
	if (tree.length === 0) return null;

	// Get the last root node
	const lastRoot = tree[tree.length - 1];
	return getLastDeepestLeaf(lastRoot);
}

// ============================================================================
// Message Formatting
// ============================================================================

/**
 * Format entries for merge message.
 * Simple format: [role]: content
 */
export function formatMergedMessages(entries: SessionEntry[]): string {
	const lines: string[] = [];

	for (const entry of entries) {
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			const msg = msgEntry.message;
			let contentStr = "";
			
			// Only process messages with content property
			if ("content" in msg && msg.content !== undefined) {
				// Handle string content (user messages)
				if (typeof msg.content === "string") {
					contentStr = msg.content;
				} else if (Array.isArray(msg.content)) {
					// Handle array content (assistant messages)
					// Filter to text content only and trim each part
					const textParts: string[] = [];
					for (const part of msg.content) {
						if (typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
							textParts.push((part as any).text.trim());
						}
					}
					contentStr = textParts.join(" ");
				}
			}
			
			if (contentStr && "role" in msg) {
				lines.push(`[${(msg as any).role}]: ${contentStr}`);
			}
		}
		// Skip non-message entries (compaction, model changes, etc.)
	}

	return lines.join("\n\n");
}

// ============================================================================
// Branch Detection
// ============================================================================

/**
 * Determine if a parent message was deleted (no longer in session).
 * Returns false if parent exists or if no parent is recorded.
 */
export function isOrphanedBranch(
	discordMsgId: string,
	metadata: ChannelBranches,
	sessionManager: SessionManager
): boolean {
	const parentMsgId = metadata.discordMsgParent.get(discordMsgId);
	if (!parentMsgId) return false; // No parent recorded

	const parentEntryId = metadata.discordMsgToPiEntryId.get(parentMsgId);
	if (!parentEntryId) return true; // Parent not in session

	// Parent exists in session
	return false;
}

/**
 * Get all root entries (messages with no parent).
 * Used to find main branch entries.
 */
export function getRootEntries(tree: SessionTreeNode[]): SessionTreeNode[] {
	// Tree nodes with parentId === null are roots
	return tree.filter(node => node.entry.parentId === null);
}

/**
 * Check if two entries are on the same branch path.
 * True if one is an ancestor of the other, or they share a common path.
 */
export function areOnSameBranch(
	entryId1: string,
	entryId2: string,
	sessionManager: SessionManager
): boolean {
	if (entryId1 === entryId2) return true;

	// Get path from root to entryId1
	const path1 = new Set<string>();
	let current = entryId1;
	while (current) {
		path1.add(current);
		const entry = sessionManager.getEntry(current);
		if (!entry || !entry.parentId) break;
		current = entry.parentId;
	}

	// One is an ancestor of the other if:
	// 1. entryId2 is in entryId1's ancestor chain
	// 2. entryId1 is in entryId2's ancestor chain

	// Check if entryId2 is an ancestor of entryId1
	if (path1.has(entryId2)) return true;

	// Check if entryId1 is an ancestor of entryId2
	current = entryId2;
	while (current) {
		if (current === entryId1) return true;
		const entry = sessionManager.getEntry(current);
		if (!entry || !entry.parentId) break;
		current = entry.parentId;
	}

	return false;
}

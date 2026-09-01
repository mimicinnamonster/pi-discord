import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	createSessionMemoryExtension,
	extractMemoryFromPrompt,
	getChannelMemoryFilePath,
	getMemoryFilePath,
	loadChannelMemory,
	loadMemory,
	saveChannelMemory,
	saveMemory,
	upsertMemoryBlock,
	patchCurrentSystemPrompt,
	MEMORY_MARKER,
} from "../src/session-memory";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";

describe("upsertMemoryBlock", () => {
	it("should append the memory block to a prompt without one", () => {
		const result = upsertMemoryBlock("Base prompt", "Likes cats");
		expect(result).toBe("Base prompt\n\nagent memory:\nLikes cats");
	});

	it("should replace an existing memory block", () => {
		const result = upsertMemoryBlock("Base\n\nagent memory:\nOld stuff", "New stuff");
		expect(result).toBe("Base\n\nagent memory:\nNew stuff");
	});

	it("should strip the memory block when memory is empty", () => {
		const result = upsertMemoryBlock("Base\n\nagent memory:\nOld stuff", undefined);
		expect(result).toBe("Base");
	});

	it("should handle a prompt that ends with the marker", () => {
		const result = upsertMemoryBlock("Base\n\nagent memory:", "Mem");
		expect(result).toBe("Base\n\nagent memory:\nMem");
	});
});

describe("memory persistence (per session UUID)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-discord-memory-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("should save and load memory for a session UUID", () => {
		saveMemory(dir, "session-a", "Remember this");
		expect(loadMemory(dir, "session-a")).toBe("Remember this");
	});

	it("should keep memory per session UUID — /session must NOT carry memory over", () => {
		saveMemory(dir, "session-old", "Old session memory");
		// A new session UUID (as minted by /session or /clear) has no memory.
		expect(loadMemory(dir, "session-new")).toBeUndefined();
	});

	it("should return undefined for missing or corrupt files", () => {
		expect(loadMemory(dir, "nope")).toBeUndefined();
		writeFileSync(getMemoryFilePath(dir, "broken"), "not json{");
		expect(loadMemory(dir, "broken")).toBeUndefined();
	});

	it("should delete the file when saving empty memory", () => {
		saveMemory(dir, "session-a", "Something");
		expect(existsSync(getMemoryFilePath(dir, "session-a"))).toBe(true);
		saveMemory(dir, "session-a", undefined);
		expect(existsSync(getMemoryFilePath(dir, "session-a"))).toBe(false);
	});
});

describe("memory persistence (per channel)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-discord-channel-memory-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("should save and load memory keyed by channel", () => {
		saveChannelMemory(dir, "channel-a", "Remember this");
		expect(loadChannelMemory(dir, "channel-a")).toBe("Remember this");
	});

	it("should not leak memory between channels", () => {
		saveChannelMemory(dir, "channel-a", "Channel A memory");
		expect(loadChannelMemory(dir, "channel-b")).toBeUndefined();
	});

	it("should return undefined for missing or corrupt files", () => {
		expect(loadChannelMemory(dir, "nope")).toBeUndefined();
		writeFileSync(getChannelMemoryFilePath(dir, "broken"), "not json{");
		expect(loadChannelMemory(dir, "broken")).toBeUndefined();
	});

	it("should delete the file when saving empty memory", () => {
		saveChannelMemory(dir, "channel-a", "Something");
		expect(existsSync(getChannelMemoryFilePath(dir, "channel-a"))).toBe(true);
		saveChannelMemory(dir, "channel-a", undefined);
		expect(existsSync(getChannelMemoryFilePath(dir, "channel-a"))).toBe(false);
	});
});

describe("createSessionMemoryExtension (official before_agent_start hook)", () => {
	/** Run an ExtensionFactory against a fake pi API and capture its handler. */
	function captureHandler(factory: ExtensionFactory): (event: any, ctx: any) => any {
		let captured: ((event: any, ctx: any) => any) | undefined;
		const fakePi = {
			on: (event: string, handler: (event: any, ctx: any) => any) => {
				if (event === "before_agent_start") captured = handler;
			},
		};
		factory(fakePi as any);
		if (!captured) throw new Error("before_agent_start handler not registered");
		return captured;
	}

	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-discord-ext-memory-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("should append persisted memory to the system prompt for the channel", () => {
		saveChannelMemory(dir, "ch-1", "Prefers lofi");
		const handler = captureHandler(createSessionMemoryExtension(dir, "ch-1"));

		const result = handler(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "Base prompt", systemPromptOptions: {} },
			{ sessionManager: { getSessionId: () => "whatever-session" } },
		);

		expect(result).toEqual({ systemPrompt: "Base prompt\n\nagent memory:\nPrefers lofi" });
	});

	it("should return undefined when the channel has no memory (base prompt unchanged)", () => {
		const handler = captureHandler(createSessionMemoryExtension(dir, "ch-1"));

		const result = handler(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "Base prompt", systemPromptOptions: {} },
			{ sessionManager: { getSessionId: () => "no-memory-session" } },
		);

		expect(result).toBeUndefined();
	});

	it("should keep memory per CHANNEL — a new session UUID (/session, /clear) still sees it", () => {
		saveChannelMemory(dir, "ch-2", "Old channel memory");
		const handler = captureHandler(createSessionMemoryExtension(dir, "ch-2"));

		// A new session UUID (as minted by /session or /clear) still gets the
		// channel's memory — this is exactly the fix for "memory not preserved
		// between sessions in a channel".
		const result = handler(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "Base", systemPromptOptions: {} },
			{ sessionManager: { getSessionId: () => "session-new" } },
		);
		expect(result).toEqual({ systemPrompt: "Base\n\nagent memory:\nOld channel memory" });
	});

	it("should adopt a legacy session-UUID sidecar into the channel file (migration fallback)", () => {
		saveMemory(dir, "legacy-session", "Legacy note");
		const handler = captureHandler(createSessionMemoryExtension(dir, "ch-3"));

		const result = handler(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "Base", systemPromptOptions: {} },
			{ sessionManager: { getSessionId: () => "legacy-session" } },
		);
		expect(result).toEqual({ systemPrompt: "Base\n\nagent memory:\nLegacy note" });

		// Adopted into the channel file so future saves go to the channel key.
		const channelFile = getChannelMemoryFilePath(dir, "ch-3");
		expect(existsSync(channelFile)).toBe(true);
		expect(loadChannelMemory(dir, "ch-3")).toBe("Legacy note");
	});

	it("should replace a stale memory block with the persisted one", () => {
		saveChannelMemory(dir, "ch-1", "Updated memory");
		const handler = captureHandler(createSessionMemoryExtension(dir, "ch-1"));

		const result = handler(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "Base\n\nagent memory:\nStale", systemPromptOptions: {} },
			{ sessionManager: { getSessionId: () => "session-a" } },
		);

		expect(result).toEqual({ systemPrompt: "Base\n\nagent memory:\nUpdated memory" });
	});
});

describe("patchCurrentSystemPrompt (remember tool, current turn only)", () => {
	it("should patch only the live system prompt, never the base prompt", () => {
		const fake = {
			_baseSystemPrompt: "Base prompt",
			agent: { state: { systemPrompt: "Base prompt" } },
		};

		patchCurrentSystemPrompt(fake as unknown as AgentSession, "Likes cats");

		expect(fake.agent.state.systemPrompt).toBe("Base prompt\n\nagent memory:\nLikes cats");
		expect(fake._baseSystemPrompt).toBe("Base prompt"); // untouched — clean approach
		expect(extractMemoryFromPrompt(fake.agent.state.systemPrompt)).toBe("Likes cats");
	});
});

describe("memory lifecycle across session commands", () => {
	it("should model the /session -> /resume -> /compact lifecycle correctly", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-discord-lifecycle-"));
		try {
			const oldSessionId = "uuid-old";
			const newSessionId = "uuid-new";
			const compactedSessionId = "uuid-compacted";

			// Agent remembers something in the old session.
			saveMemory(dir, oldSessionId, "Task: fix the bug");

			// /session: closes old session, mints a new UUID — memory NOT carried.
			expect(loadMemory(dir, newSessionId)).toBeUndefined();

			// /resume: restores the old session file (same UUID) — memory back.
			expect(loadMemory(dir, oldSessionId)).toBe("Task: fix the bug");

			// /compact: the bot explicitly carries memory from old -> new session.
			const carried = loadMemory(dir, oldSessionId);
			saveMemory(dir, compactedSessionId, carried);
			expect(loadMemory(dir, compactedSessionId)).toBe("Task: fix the bug");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

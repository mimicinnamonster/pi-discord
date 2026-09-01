import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSessionStore } from "../src/session-store";
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

// Mock the @earendil-works/pi-coding-agent module
// The session mock carries mutable prompt state so we can verify that the
// remember tool patches the LIVE system prompt only (never the private base
// prompt — memory is injected per-turn via the before_agent_start extension
// hook) and that it persists to disk.
let mockSessionState: {
	_baseSystemPrompt: string;
	agent: { state: { systemPrompt: string } };
};

vi.mock("@earendil-works/pi-coding-agent", () => {
	return {
		ModelRuntime: { create: vi.fn().mockResolvedValue({}) },
		SessionManager: {
			open: vi.fn().mockReturnValue({ getCwd: () => "/tmp/cwd", setSessionFile: vi.fn() }),
			create: vi.fn().mockReturnValue({ getCwd: () => "/tmp/cwd", setSessionFile: vi.fn() }),
		},
		SettingsManager: {
			create: vi.fn().mockReturnValue({ applyOverrides: vi.fn() }),
		},
		createCodingTools: vi.fn().mockReturnValue([{ name: "existing-tool" }]),
		createAgentSession: vi.fn().mockImplementation(() =>
			Promise.resolve({
				session: {
					bindExtensions: vi.fn().mockResolvedValue(undefined),
					setSessionName: vi.fn(),
					dispose: vi.fn(),
					getSessionStats: () => ({ sessionId: "test-session-uuid-1" }),
					...mockSessionState,
				},
				extensionsResult: { errors: [] },
			})
		),
		DefaultResourceLoader: vi.fn().mockImplementation(function () {
			return { reload: vi.fn().mockResolvedValue(undefined) };
		}),
	};
});

function makeTempSessionDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-discord-remember-"));
}

// Initialize the shared session state before EVERY test (the registration test
// also calls getOrCreate, and the mock spreads this state at call time).
beforeEach(() => {
	mockSessionState = {
		_baseSystemPrompt: "Default prompt",
		agent: { state: { systemPrompt: "Default prompt" } },
	};
});

/** Latest createAgentSession invocation (mock calls accumulate across tests). */
async function latestAgentModule(): Promise<any> {
	return (await import("@earendil-works/pi-coding-agent")) as any;
}

async function latestRememberTool(): Promise<any> {
	const agentModule = await latestAgentModule();
	const calls = agentModule.createAgentSession.mock.calls;
	const tools = calls[calls.length - 1][0].customTools;
	return tools.find((t: any) => t.name === "remember");
}

/** The inline memory extension factory passed to DefaultResourceLoader. */
async function latestMemoryExtensionFactory(): Promise<ExtensionFactory> {
	const agentModule = await latestAgentModule();
	const calls = agentModule.DefaultResourceLoader.mock.calls;
	const loaderOptions = calls[calls.length - 1][0];
	const factories: ExtensionFactory[] = loaderOptions.extensionFactories ?? [];
	if (factories.length === 0) throw new Error("session memory extension factory not registered");
	return factories[0];
}

/** Run an ExtensionFactory against a fake pi API and capture its handler. */
function captureExtensionHandler(factory: ExtensionFactory): (event: any, ctx: any) => any {
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

describe("Remember Tool Registration", () => {
	it("should correctly include the remember tool in the tools list passed to createAgentSession", async () => {
		const agentModule = await latestAgentModule();
		const store = createSessionStore({ sessionDir: makeTempSessionDir() });

		await store.getOrCreate("test-channel");

		const callArgs = agentModule.createAgentSession.mock.calls[0][0];
		const tools = callArgs.customTools;

		expect(Array.isArray(tools)).toBe(true);
		const rememberTool = tools.find((t: any) => t.name === "remember");

		expect(rememberTool).toBeDefined();
		expect(rememberTool.description).toContain("Session memory");
		expect(rememberTool.parameters.required).toContain("memory");
	});

	it("should register the session memory before_agent_start extension factory", async () => {
		const store = createSessionStore({ sessionDir: makeTempSessionDir() });
		await store.getOrCreate("test-channel");

		const factory = await latestMemoryExtensionFactory();
		expect(factory).toBeDefined();
	});
});

describe("Remember Tool Execution", () => {
	let sessionDir: string;
	let store: ReturnType<typeof createSessionStore>;

	beforeEach(() => {
		sessionDir = makeTempSessionDir();
		store = createSessionStore({ sessionDir });
	});

	it("should persist memory to disk and patch only the live system prompt", async () => {
		await store.getOrCreate("test-channel");

		const rememberTool = await latestRememberTool();
		const result = await rememberTool.execute("tool-call-1", { memory: "Focused on tests" });

		expect(result).toEqual({ content: [{ type: "text", text: "✅ Memory updated successfully (persisted for this channel)." }] });

		// Channel-scoped sidecar memory file (survives /session, /clear, restarts)
		const memoryFile = join(sessionDir, "channel-memory-test-channel.json");
		expect(existsSync(memoryFile)).toBe(true);
		const stored = JSON.parse(readFileSync(memoryFile, "utf-8"));
		expect(stored.memory).toBe("Focused on tests");

		// Live system prompt patched for the CURRENT turn; the private base
		// prompt is left untouched (per-turn injection is the extension hook's job).
		const liveSession = store.get("test-channel")!.session as any;
		expect(liveSession.agent.state.systemPrompt).toBe("Default prompt\n\nagent memory:\nFocused on tests");
		expect(liveSession._baseSystemPrompt).toBe("Default prompt");
	});

	it("should replace existing memory on second call", async () => {
		await store.getOrCreate("test-channel");

		const rememberTool = await latestRememberTool();
		await rememberTool.execute("tool-call-1", { memory: "Old memory" });
		await rememberTool.execute("tool-call-2", { memory: "New memory content" });

		const liveSession = store.get("test-channel")!.session as any;
		expect(liveSession.agent.state.systemPrompt).toBe("Default prompt\n\nagent memory:\nNew memory content");

		const stored = JSON.parse(readFileSync(join(sessionDir, "channel-memory-test-channel.json"), "utf-8"));
		expect(stored.memory).toBe("New memory content");
	});

	it("should keep memory across /session (closeAndNewSession mints a new UUID)", async () => {
		await store.getOrCreate("test-channel");

		const rememberTool = await latestRememberTool();
		await rememberTool.execute("tool-call-1", { memory: "User preference that must survive /session" });

		// Close the session (new UUID) and recreate — as /session does.
		await store.closeAndNewSession("test-channel");
		await store.getOrCreate("test-channel");

		// The new session's extension hook still returns the channel memory.
		const factory = await latestMemoryExtensionFactory();
		const handler = captureExtensionHandler(factory);
		const result = handler(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "Default prompt", systemPromptOptions: {} },
			{ sessionManager: { getSessionId: () => "brand-new-uuid" } },
		);
		expect(result).toEqual({ systemPrompt: "Default prompt\n\nagent memory:\nUser preference that must survive /session" });
	});

	it("should inject persisted memory on every turn via the extension hook (bot restart / resume)", async () => {
		// Seed the channel memory sidecar BEFORE the session exists — as if a
		// previous bot run had persisted it and the bot restarted.
		writeFileSync(
			join(sessionDir, "channel-memory-test-channel.json"),
			JSON.stringify({ memory: "Remembered across restart" }),
		);

		await store.getOrCreate("test-channel");

		// At session creation the prompts are NOT patched — the official
		// before_agent_start hook injects the memory at the start of each turn.
		const liveSession = store.get("test-channel")!.session as any;
		expect(liveSession.agent.state.systemPrompt).toBe("Default prompt");
		expect(liveSession._baseSystemPrompt).toBe("Default prompt");

		// First turn: the hook must return the base prompt + memory block.
		const factory = await latestMemoryExtensionFactory();
		const handler = captureExtensionHandler(factory);
		const result = handler(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "Default prompt", systemPromptOptions: {} },
			{ sessionManager: { getSessionId: () => "test-session-uuid-1" } },
		);
		expect(result).toEqual({ systemPrompt: "Default prompt\n\nagent memory:\nRemembered across restart" });
	});

	it("should adopt a legacy session-UUID memory sidecar into the channel file", async () => {
		// Old-format sidecar from before memory became channel-scoped.
		writeFileSync(
			join(sessionDir, "memory-test-session-uuid-1.json"),
			JSON.stringify({ memory: "Legacy session memory", updatedAt: 123 }),
		);

		await store.getOrCreate("test-channel");

		const factory = await latestMemoryExtensionFactory();
		const handler = captureExtensionHandler(factory);
		const result = handler(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "Default prompt", systemPromptOptions: {} },
			{ sessionManager: { getSessionId: () => "test-session-uuid-1" } },
		);
		expect(result).toEqual({ systemPrompt: "Default prompt\n\nagent memory:\nLegacy session memory" });

		// Adopted into the channel-scoped file for future saves.
		const channelFile = join(sessionDir, "channel-memory-test-channel.json");
		expect(existsSync(channelFile)).toBe(true);
		const stored = JSON.parse(readFileSync(channelFile, "utf-8"));
		expect(stored.memory).toBe("Legacy session memory");
	});

	it("should leave prompts untouched when no memory exists for the session", async () => {
		await store.getOrCreate("test-channel");
		expect(mockSessionState.agent.state.systemPrompt).toBe("Default prompt");

		// Hook returns undefined -> SDK keeps the base prompt unchanged.
		const factory = await latestMemoryExtensionFactory();
		const handler = captureExtensionHandler(factory);
		const result = handler(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "Default prompt", systemPromptOptions: {} },
			{ sessionManager: { getSessionId: () => "test-session-uuid-1" } },
		);
		expect(result).toBeUndefined();
	});
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSessionStore } from "../src/session-store";
import {
	createThinkingModeTool,
	applyChannelThinkingMode,
	DEFAULT_THINKING_MODE,
	loadChannelThinkingMode,
	isThinkingModeEnabled,
	setThinkingModeEnabled,
} from "../src/thinking-mode";
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Mock @earendil-works/pi-coding-agent with a stateful session that carries a
// mutable thinkingLevel so we can exercise setThinkingLevel + persistence.
let mockSessionState: {
	thinkingLevel: string;
	setThinkingLevel: (level: string) => void;
	getAvailableThinkingLevels: () => string[];
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
	return mkdtempSync(join(tmpdir(), "pi-discord-thinking-"));
}

beforeEach(() => {
	mockSessionState = {
		thinkingLevel: "off",
		// Default mock model exposes ALL levels (a broad, fully-mapped model).
		model: {
			reasoning: true,
			thinkingLevelMap: {
				off: "none",
				minimal: "minimal",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "max",
			},
		},
		setThinkingLevel(level: string) {
			// Clamp like the SDK: only accept known levels.
			if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(level)) {
				this.thinkingLevel = level;
			}
		},
		getAvailableThinkingLevels() {
			return ["off", "minimal", "low", "medium", "high", "xhigh"];
		},
	};
});

async function latestAgentModule(): Promise<any> {
	return (await import("@earendil-works/pi-coding-agent")) as any;
}

async function latestThinkingTool(): Promise<any> {
	const agentModule = await latestAgentModule();
	const calls = agentModule.createAgentSession.mock.calls;
	const tools = calls[calls.length - 1][0].customTools;
	return tools.find((t: any) => t.name === "thinkingmode");
}

describe("Thinking Mode Tool Registration", () => {
	it("should include the thinkingmode tool in customTools passed to createAgentSession", async () => {
		const agentModule = await latestAgentModule();
		const store = createSessionStore({ sessionDir: makeTempSessionDir() });

		await store.getOrCreate("test-channel");

		const callArgs = agentModule.createAgentSession.mock.calls[0][0];
		const tool = (callArgs.customTools as any[]).find((t: any) => t.name === "thinkingmode");

		expect(tool).toBeDefined();
		expect(tool.parameters.required).toContain("level");
		expect(tool.parameters.properties.level.enum).toContain("off");
		expect(tool.parameters.properties.level.enum).toContain("high");
	});

	it("should build a description with current level, available levels, and policy", async () => {
		const store = createSessionStore({ sessionDir: makeTempSessionDir() });
		await store.getOrCreate("test-channel");

		const tool = await latestThinkingTool();
		const desc: string = tool.description;
		expect(desc).toContain("CURRENT thinking level is: off");
		expect(desc).toContain("off");
		expect(desc).toContain("high");
		expect(desc.toLowerCase()).toContain('default to no thinking ("off")');
		expect(desc.toLowerCase()).toContain("switch back to \"off\"");
	});
});

describe("Thinking Mode Tool Execution", () => {
	let sessionDir: string;
	let store: ReturnType<typeof createSessionStore>;

	beforeEach(() => {
		sessionDir = makeTempSessionDir();
		store = createSessionStore({ sessionDir });
	});

	it("should change the live thinking level and persist it per channel", async () => {
		await store.getOrCreate("test-channel");

		const tool = await latestThinkingTool();
		// Description reflects the live (post-creation, default "off") level.
		expect(tool.description).toContain("CURRENT thinking level is: off");

		const result = await tool.execute("call-1", { level: "high" });
		expect(result.content[0].text).toContain("high");

		const liveSession = store.get("test-channel")!.session as any;
		expect(liveSession.thinkingLevel).toBe("high");

		const file = join(sessionDir, "channel-thinking-test-channel.json");
		expect(existsSync(file)).toBe(true);
		const stored = JSON.parse(readFileSync(file, "utf-8"));
		expect(stored.level).toBe("high");
	});

	it("should switch back to 'off' when asked, and persist it", async () => {
		await store.getOrCreate("test-channel");

		const tool = await latestThinkingTool();
		await tool.execute("call-1", { level: "medium" });
		await tool.execute("call-2", { level: "off" });

		const liveSession = store.get("test-channel")!.session as any;
		expect(liveSession.thinkingLevel).toBe("off");

		const stored = JSON.parse(readFileSync(join(sessionDir, "channel-thinking-test-channel.json"), "utf-8"));
		expect(stored.level).toBe("off");
	});

	it("should reject an invalid level", async () => {
		await store.getOrCreate("test-channel");

		const tool = await latestThinkingTool();
		const result = await tool.execute("call-1", { level: "everything" });

		expect(result.content[0].text).toContain("Invalid thinking level");
		const liveSession = store.get("test-channel")!.session as any;
		expect(liveSession.thinkingLevel).toBe("off");
	});

	it("should advertise only the levels the current model actually supports", async () => {
		await store.getOrCreate("test-channel");
		const tool = await latestThinkingTool();

		// Simulate a real DeepSeek V4 Flash-style model: only "high" and "xhigh"
		// are mapped; minimal/low/medium are explicitly null (hidden).
		const liveSession = store.get("test-channel")!.session as any;
		liveSession.model = {
			reasoning: true,
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
		};
		liveSession.thinkingLevel = "off";

		// The schema enum must be the model's true subset: only off + mapped levels.
		const sch = tool.parameters;
		expect(sch.properties.level.enum).toEqual(["off", "high", "xhigh"]);
		expect(sch.properties.level.enum).not.toContain("minimal");
		expect(sch.properties.level.enum).not.toContain("low");
		expect(sch.properties.level.enum).not.toContain("medium");

		// The description lists the same subset.
		expect(tool.description).toContain("Available thinking levels (may vary by model): off, high, xhigh");

		// Setting a level the model does not support is rejected up-front.
		const rejected = await tool.execute("call-1", { level: "medium" });
		expect(rejected.content[0].text).toContain("Invalid thinking level \"medium\" for the current model");
		expect(rejected.content[0].text).toContain("Available levels: off, high, xhigh");
		expect(liveSession.thinkingLevel).toBe("off");

		// A supported level is accepted.
		const accepted = await tool.execute("call-2", { level: "high" });
		expect(accepted.content[0].text).toContain("high");
		expect(liveSession.thinkingLevel).toBe("high");
	});

	it("should exclude levels absent from the model's map (undefined == unsupported)", async () => {
		await store.getOrCreate("test-channel");
		const tool = await latestThinkingTool();

		// A model whose map only covers off/low/medium/high — no "minimal" key at
		// all, and no xhigh. The SDK would wrongly keep "minimal"; our direct
		// computation must drop anything with an absent (undefined) mapping.
		const liveSession = store.get("test-channel")!.session as any;
		liveSession.model = {
			reasoning: true,
			thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high" },
		};
		liveSession.thinkingLevel = "off";

		const sch = tool.parameters;
		expect(sch.properties.level.enum).toEqual(["off", "low", "medium", "high"]);
		expect(sch.properties.level.enum).not.toContain("minimal");
		expect(sch.properties.level.enum).not.toContain("xhigh");

		expect(tool.description).toContain("Available thinking levels (may vary by model): off, low, medium, high");

		const rejected = await tool.execute("call-1", { level: "minimal" });
		expect(rejected.content[0].text).toContain("Invalid thinking level \"minimal\" for the current model");
	});

	it("should keep thinking level across /session (closeAndNewSession mints a new UUID)", async () => {
		await store.getOrCreate("test-channel");

		const tool = await latestThinkingTool();
		await tool.execute("call-1", { level: "high" });

		// Close the session (new UUID) and recreate — as /session does.
		await store.closeAndNewSession("test-channel");
		await store.getOrCreate("test-channel");

		// The recreated session's mock applies the persisted channel level.
		const liveSession = store.get("test-channel")!.session as any;
		expect(liveSession.thinkingLevel).toBe("high");
	});

	it("should restore the persisted level on a fresh session (bot restart)", async () => {
		// Seed the channel sidecar BEFORE the session exists — as if a previous
		// bot run had set it and then the bot restarted.
		writeFileSync(
			join(sessionDir, "channel-thinking-test-channel.json"),
			JSON.stringify({ channelId: "test-channel", level: "high", updatedAt: Date.now() }),
		);

		await store.getOrCreate("test-channel");

		const liveSession = store.get("test-channel")!.session as any;
		expect(liveSession.thinkingLevel).toBe("high");
	});

	it("should default to 'off' when no persisted level exists", async () => {
		await store.getOrCreate("test-channel");
		const liveSession = store.get("test-channel")!.session as any;
		expect(liveSession.thinkingLevel).toBe("off");
		expect(loadChannelThinkingMode(sessionDir, "test-channel")).toBeUndefined();
	});
});

describe("Thinking Mode Tool Disable / Enable", () => {
	let sessionDir: string;
	let store: ReturnType<typeof createSessionStore>;

	beforeEach(() => {
		sessionDir = makeTempSessionDir();
		store = createSessionStore({ sessionDir });
	});

	it("should be enabled by default", () => {
		expect(isThinkingModeEnabled(sessionDir, "test-channel")).toBe(true);
	});

	it("should persist the enabled flag to the channel sidecar", async () => {
		await store.getOrCreate("test-channel");

		setThinkingModeEnabled(sessionDir, "test-channel", false);
		expect(isThinkingModeEnabled(sessionDir, "test-channel")).toBe(false);

		const stored = JSON.parse(readFileSync(join(sessionDir, "channel-thinking-test-channel.json"), "utf-8"));
		expect(stored.enabled).toBe(false);

		setThinkingModeEnabled(sessionDir, "test-channel", true);
		expect(isThinkingModeEnabled(sessionDir, "test-channel")).toBe(true);
	});

	it("should change the tool description to say DISABLED when turned off", async () => {
		await store.getOrCreate("test-channel");
		const tool = await latestThinkingTool();

		expect(tool.description).not.toContain("DISABLED");

		setThinkingModeEnabled(sessionDir, "test-channel", false);
		expect(tool.description).toContain("DISABLED");
		expect(tool.description).toContain("NOT allowed to change the thinking level");

		setThinkingModeEnabled(sessionDir, "test-channel", true);
		expect(tool.description).not.toContain("DISABLED");
	});

	it("should refuse execution with a clear message when disabled", async () => {
		await store.getOrCreate("test-channel");
		const tool = await latestThinkingTool();

		setThinkingModeEnabled(sessionDir, "test-channel", false);
		const result = await tool.execute("call-1", { level: "high" });

		expect(result.content[0].text).toContain("DISABLED");
		expect(result.content[0].text).toContain("NOT allowed to change the thinking level");

		// Level stays unchanged.
		const liveSession = store.get("test-channel"!)!.session as any;
		expect(liveSession.thinkingLevel).toBe("off");
	});

	it("should allow execution again once re-enabled", async () => {
		await store.getOrCreate("test-channel");
		const tool = await latestThinkingTool();

		setThinkingModeEnabled(sessionDir, "test-channel", false);
		setThinkingModeEnabled(sessionDir, "test-channel", true);

		const result = await tool.execute("call-1", { level: "high" });
		expect(result.content[0].text).toContain("high");

		const liveSession = store.get("test-channel")!.session as any;
		expect(liveSession.thinkingLevel).toBe("high");
	});
});

describe("applyChannelThinkingMode", () => {
	it("should apply the persisted level when present", () => {
		const sessionDir = makeTempSessionDir();
		writeFileSync(
			join(sessionDir, "channel-thinking-test-channel.json"),
			JSON.stringify({ channelId: "test-channel", level: "xhigh" }),
		);

		const session = {
			thinkingLevel: "off",
			setThinkingLevel(level: string) {
				this.thinkingLevel = level;
			},
		};
		applyChannelThinkingMode(sessionDir, "test-channel", session as any);
		expect((session as any).thinkingLevel).toBe("xhigh");
	});

	it("should default to 'off' when nothing persisted", () => {
		const sessionDir = makeTempSessionDir();
		const session = {
			thinkingLevel: "medium",
			setThinkingLevel(level: string) {
				this.thinkingLevel = level;
			},
		};
		applyChannelThinkingMode(sessionDir, "test-channel", session as any);
		expect((session as any).thinkingLevel).toBe(DEFAULT_THINKING_MODE);
		expect(DEFAULT_THINKING_MODE).toBe("off");
	});
});

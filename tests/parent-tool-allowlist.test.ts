/**
 * Parent Tool Allowlist Tests
 * The Discord parent session is locked to a strict tool allowlist. These
 * tests pin the desired allowlist (subagent + direct schedule_prompt) and the
 * registry filtering that drops tools missing from the session's registry
 * (e.g. when the pi-schedule-prompt extension is not installed).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildParentToolAllowlist, PARENT_TOOL_ALLOWLIST } from "../src/session-store.ts";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Pure helper: buildParentToolAllowlist
// ---------------------------------------------------------------------------

describe("buildParentToolAllowlist", () => {
	it("keeps every desired tool that exists in the registry", () => {
		const registered = ["read", "bash", "subagent", "remember", "schedule_prompt"];
		expect(buildParentToolAllowlist(registered)).toEqual(["subagent", "schedule_prompt"]);
	});

	it("drops tools missing from the registry instead of relying on silent drops", () => {
		// pi-schedule-prompt extension not installed -> schedule_prompt absent
		expect(buildParentToolAllowlist(["read", "bash", "subagent"])).toEqual(["subagent"]);
	});

	it("returns an empty list when nothing is registered", () => {
		expect(buildParentToolAllowlist([])).toEqual([]);
	});

	it("preserves allowlist order regardless of registry order", () => {
		expect(buildParentToolAllowlist(["schedule_prompt", "subagent"])).toEqual([
			"subagent",
			"schedule_prompt",
		]);
	});

	it("desires exactly subagent and schedule_prompt", () => {
		expect(PARENT_TOOL_ALLOWLIST).toEqual(["subagent", "schedule_prompt"]);
	});
});

// ---------------------------------------------------------------------------
// Wired behavior: createPiSession must apply the filtered allowlist
// ---------------------------------------------------------------------------

/** Registry returned by the mocked session's getAllTools(); mutated per test. */
let mockRegisteredTools: string[] = ["subagent", "schedule_prompt"];

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
					setThinkingLevel: vi.fn(),
					setActiveToolsByName: vi.fn(),
					getAllTools: vi.fn(() => mockRegisteredTools.map((name) => ({ name }))),
					dispose: vi.fn(),
					getSessionStats: () => ({ sessionId: "test-session-uuid-1" }),
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
	return mkdtempSync(join(tmpdir(), "pi-discord-allowlist-"));
}

/** Latest mock session handed out by the mocked createAgentSession. */
async function latestMockSession(): Promise<any> {
	const agentModule = (await import("@earendil-works/pi-coding-agent")) as any;
	const results = agentModule.createAgentSession.mock.results;
	return (await results[results.length - 1].value).session;
}

describe("createPiSession parent allowlist wiring", () => {
	let sessionDir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		mockRegisteredTools = ["subagent", "schedule_prompt"];
		sessionDir = makeTempSessionDir();
	});

	afterEach(() => {
		try {
			rmSync(sessionDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it("activates subagent + schedule_prompt when both are registered", async () => {
		const { createSessionStore } = await import("../src/session-store.ts");
		const store = createSessionStore({ sessionDir });
		await store.getOrCreate("111222333444555666");

		const session = await latestMockSession();
		expect(session.setActiveToolsByName).toHaveBeenCalledWith(["subagent", "schedule_prompt"]);
	});

	it("activates only subagent when schedule_prompt is not in the registry", async () => {
		mockRegisteredTools = ["read", "bash", "subagent"];
		const { createSessionStore } = await import("../src/session-store.ts");
		const store = createSessionStore({ sessionDir });
		await store.getOrCreate("111222333444555666");

		const session = await latestMockSession();
		expect(session.setActiveToolsByName).toHaveBeenCalledWith(["subagent"]);
	});
});

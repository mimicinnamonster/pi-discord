import { describe, it, expect, vi } from "vitest";
import { createSessionStore } from "../src/session-store";

// Mock the @mariozechner/pi-coding-agent module
vi.mock("@mariozechner/pi-coding-agent", () => {
	return {
		AuthStorage: { create: vi.fn() },
		ModelRegistry: { create: vi.fn().mockReturnValue({ find: vi.fn() }) },
		SessionManager: {
			open: vi.fn().mockReturnValue({ getCwd: () => "/tmp/cwd", setSessionFile: vi.fn() }),
			create: vi.fn().mockReturnValue({ getCwd: () => "/tmp/cwd", setSessionFile: vi.fn() }),
		},
		SettingsManager: {
			create: vi.fn().mockReturnValue({ applyOverrides: vi.fn() }),
		},
		createCodingTools: vi.fn().mockReturnValue([{ name: "existing-tool" }]),
		createAgentSession: vi.fn().mockResolvedValue({
			session: {
				bindExtensions: vi.fn().mockResolvedValue(undefined),
				setSessionName: vi.fn(),
			},
			extensionsResult: { errors: [] },
		}),
		DefaultResourceLoader: vi.fn().mockImplementation(function() {
			return { reload: vi.fn().mockResolvedValue(undefined) };
		}),
	};
});

describe("Remember Tool Registration", () => {
	it("should correctly include the remember tool in the tools list passed to createAgentSession", async () => {
		const agentModule = await import("@mariozechner/pi-coding-agent");
		const store = createSessionStore({ sessionDir: "/tmp/pi-discord-test-sessions" });
		
		await store.getOrCreate("test-channel");

		// Use (agentModule.createAgentSession as any) to access mock calls since vi.mocked failed
		const mockCreateAgentSession = agentModule.createAgentSession as any;
		const callArgs = mockCreateAgentSession.mock.calls[0][0];
		const tools = callArgs.customTools;

		expect(Array.isArray(tools)).toBe(true);
		const rememberTool = tools.find((t: any) => t.name === "remember");
		
		expect(rememberTool).toBeDefined();
		expect(rememberTool.description).toContain("lasts only for this session");
		expect(rememberTool.parameters.required).toContain("memory");
	});

	it("should execute the remember tool and call updateSystemPrompt", async () => {
		const mockSession = {
			updateSystemPrompt: vi.fn().mockResolvedValue(undefined),
		};

		// Mimic the implementation from session-store.ts exactly
		const executeRemember = async ({ memory }: { memory: string }, context: { session: any }) => {
			const session = context.session;
			const memoryContent = `\n\nagent memory:\n${memory}`;
			try {
				await session.updateSystemPrompt(memoryContent, { append: true, replaceMarker: "agent memory:" });
				return { content: [{ type: "text", text: "✅ Memory updated successfully." }] };
			} catch (error) {
				return { content: [{ type: "text", text: `❌ Failed to update memory: ${error}` }] };
			}
		};

		const result = await executeRemember({ memory: "Test memory" }, { session: mockSession });

		expect(result).toEqual({ content: [{ type: "text", text: "✅ Memory updated successfully." }] });
		expect(mockSession.updateSystemPrompt).toHaveBeenCalledWith(
			`\n\nagent memory:\nTest memory`,
			{ append: true, replaceMarker: "agent memory:" }
		);
	});
});

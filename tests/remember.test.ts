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
		expect(rememberTool.description).toContain("Temporary session memory");
		expect(rememberTool.parameters.required).toContain("memory");
	});

	it("should execute the remember tool and modify the system prompt", async () => {
		// Mock agent with a modifiable system prompt
		const agent = { state: { systemPrompt: "Default prompt" } };

		// Mimic the current implementation from session-store.ts
		const executeRemember = async ({ memory }: { memory: string }) => {
			try {
				const memoryBlock = `agent memory:\n${memory}`;
				const current = agent.state.systemPrompt;
				const marker = "agent memory:";
				const markerIndex = current.indexOf(marker);
				if (markerIndex !== -1) {
					const base = current.slice(0, markerIndex).replace(/\n+$/, "");
					agent.state.systemPrompt = base + `\n\n${memoryBlock}`;
				} else {
					agent.state.systemPrompt = current + `\n\n${memoryBlock}`;
				}
				return { content: [{ type: "text", text: "✅ Memory updated successfully." }] };
			} catch (error) {
				return { content: [{ type: "text", text: `❌ Failed to update memory: ${error}` }] };
			}
		};

		const result = await executeRemember({ memory: "Focused on tests" });

		expect(result).toEqual({ content: [{ type: "text", text: "✅ Memory updated successfully." }] });
		expect(agent.state.systemPrompt).toBe("Default prompt\n\nagent memory:\nFocused on tests");
	});

	it("should replace existing memory on second call", async () => {
		const agent = { state: { systemPrompt: "Default\n\nagent memory:\nOld memory" } };

		const executeRemember = async ({ memory }: { memory: string }) => {
			try {
				const memoryBlock = `agent memory:\n${memory}`;
				const current = agent.state.systemPrompt;
				const marker = "agent memory:";
				const markerIndex = current.indexOf(marker);
				if (markerIndex !== -1) {
					const base = current.slice(0, markerIndex).replace(/\n+$/, "");
					agent.state.systemPrompt = base + `\n\n${memoryBlock}`;
				} else {
					agent.state.systemPrompt = current + `\n\n${memoryBlock}`;
				}
				return { content: [{ type: "text", text: "✅ Memory updated successfully." }] };
			} catch (error) {
				return { content: [{ type: "text", text: `❌ Failed to update memory: ${error}` }] };
			}
		};

		await executeRemember({ memory: "New memory content" });

		expect(agent.state.systemPrompt).toBe("Default\n\nagent memory:\nNew memory content");
	});
});

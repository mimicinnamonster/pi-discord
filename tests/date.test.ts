import { describe, it, expect, vi } from "vitest";
import { createAgentSession } from "@mariozechner/pi-coding-agent";

describe("Agent Date Awareness", () => {
	it("should have the correct local date in the system prompt when TZ is set", async () => {
		// Set timezone to Amsterdam
		process.env.TZ = "Europe/Amsterdam";
		
		// Simulate April 14, 01:00 AM in Netherlands (UTC+2)
		// This corresponds to April 13, 11:00 PM UTC
		const mockDate = new Date("2026-04-13T23:00:00Z"); 
		vi.setSystemTime(mockDate);

		const { session } = await createAgentSession();
		const prompt = session.systemPrompt;
		
		const localDate = new Date().toLocaleDateString('en-CA'); // Should be 2026-04-14
		
		console.log(`Mocked Time: ${mockDate.toISOString()}`);
		console.log(`Local date: ${localDate}`);
		console.log(`System prompt date: ${prompt.match(/Current date: (\d{4}-\d{2}-\d{2})/)?.[1]}`);

		expect(prompt).toContain(`Current date: ${localDate}`);
	});
});

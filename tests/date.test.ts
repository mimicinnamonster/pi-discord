import { describe, it, expect, vi } from "vitest";
import { withCurrentDate } from "../src/session-store.js";

describe("Agent Date Awareness", () => {
	it("appends the correct local date when the prompt has none (pi >= 0.84)", () => {
		process.env.TZ = "Europe/Amsterdam";

		// April 14, 01:00 AM in Netherlands (UTC+2) = April 13, 11:00 PM UTC
		vi.setSystemTime(new Date("2026-04-13T23:00:00Z"));

		const prompt = withCurrentDate("You are an expert coding assistant.");
		const localDate = new Date().toLocaleDateString("en-CA"); // 2026-04-14

		expect(prompt).toContain(`Current date: ${localDate}`);
	});

	it("replaces an existing date line (older pi prompts)", () => {
		process.env.TZ = "Europe/Amsterdam";
		vi.setSystemTime(new Date("2026-04-13T23:00:00Z"));

		const prompt = withCurrentDate("Intro\nCurrent date: 2020-01-01\nMore");
		const localDate = new Date().toLocaleDateString("en-CA");

		expect(prompt).toContain(`Current date: ${localDate}`);
		expect(prompt).not.toContain("2020-01-01");
	});
});

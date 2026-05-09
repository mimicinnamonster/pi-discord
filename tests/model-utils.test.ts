import { describe, it, expect } from "vitest";
import { findModel, filterModels } from "../src/model-utils";

interface MockModel {
	id: string;
	name: string;
	provider: string;
}

const mockModels: MockModel[] = [
	{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
	{ id: "claude-opus-4-20250514", name: "Claude Opus 4", provider: "anthropic" },
	{ id: "claude-haiku-3-5-sonnet-20241022", name: "Claude Haiku 3.5", provider: "anthropic" },
	{ id: "gpt-4o", name: "GPT-4o", provider: "openai" },
	{ id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
	{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google" },
	{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
	{ id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek" },
];

describe("findModel", () => {
	it("should find exact match by provider/id", () => {
		const result = findModel(mockModels, "anthropic/claude-sonnet-4-20250514");
		expect(result).toBeDefined();
		expect(result!.id).toBe("claude-sonnet-4-20250514");
		expect(result!.provider).toBe("anthropic");
	});

	it("should find fuzzy match when no exact match exists (provider/model)", () => {
		const result = findModel(mockModels, "anthropic/sonnet");
		expect(result).toBeDefined();
		expect(result!.provider).toBe("anthropic");
		expect(result!.id).toContain("sonnet");
	});

	it("should find exact match by single id term", () => {
		const result = findModel(mockModels, "gpt-4o");
		expect(result).toBeDefined();
		expect(result!.id).toBe("gpt-4o");
	});

	it("should find exact match by provider/id string", () => {
		const result = findModel(mockModels, "google/gemini-2.5-flash");
		expect(result).toBeDefined();
		expect(result!.id).toBe("gemini-2.5-flash");
		expect(result!.provider).toBe("google");
	});

	it("should find fuzzy match by single term (name)", () => {
		const result = findModel(mockModels, "Gemini");
		expect(result).toBeDefined();
		expect(result!.provider).toBe("google");
	});

	it("should find fuzzy match by single term (provider)", () => {
		const result = findModel(mockModels, "openai");
		expect(result).toBeDefined();
		expect(result!.provider).toBe("openai");
	});

	it("should find fuzzy match by partial id", () => {
		const result = findModel(mockModels, "claude");
		expect(result).toBeDefined();
		expect(result!.provider).toBe("anthropic");
		expect(result!.id).toContain("claude");
	});

	it("should return undefined for non-matching search", () => {
		const result = findModel(mockModels, "nonexistent-model-xyz");
		expect(result).toBeUndefined();
	});

	it("should find first matching model when multiple results exist", () => {
		const result = findModel(mockModels, "claude");
		expect(result).toBeDefined();
		expect(result!.id).toBe("claude-sonnet-4-20250514"); // first in array
	});

	it("should be case insensitive", () => {
		const result = findModel(mockModels, "ANTHROPIC/CLAUDE-SONNET");
		expect(result).toBeDefined();
		expect(result!.provider).toBe("anthropic");
		expect(result!.id).toContain("sonnet");
	});

	it("should match only by name (not id or provider)", () => {
		const result = findModel(mockModels, "DeepSeek Chat");
		expect(result).toBeDefined();
		expect(result!.provider).toBe("deepseek");
	});
});

describe("filterModels", () => {
	it("should filter by provider/id format (both parts match)", () => {
		const result = filterModels(mockModels, "anthropic/claude");
		expect(result.length).toBeGreaterThan(0);
		for (const m of result) {
			expect(m.provider).toContain("anthropic");
			expect(m.id.toLowerCase()).toContain("claude");
		}
	});

	it("should filter by provider/id format (provider only)", () => {
		const result = filterModels(mockModels, "google/");
		expect(result).toHaveLength(2);
		for (const m of result) {
			expect(m.provider).toBe("google");
		}
	});

	it("should filter by single term matching id", () => {
		const result = filterModels(mockModels, "claude");
		expect(result).toHaveLength(3);
		for (const m of result) {
			expect(m.provider).toBe("anthropic");
		}
	});

	it("should filter by single term matching provider", () => {
		const result = filterModels(mockModels, "openai");
		expect(result).toHaveLength(2);
		for (const m of result) {
			expect(m.provider).toBe("openai");
		}
	});

	it("should filter by single term matching name", () => {
		const result = filterModels(mockModels, "Flash");
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("gemini-2.5-flash");
	});

	it("should return empty array for no match", () => {
		const result = filterModels(mockModels, "nonexistent");
		expect(result).toHaveLength(0);
	});

	it("should be case insensitive", () => {
		const result = filterModels(mockModels, "ANTHROPIC/CLAUDE");
		expect(result.length).toBeGreaterThan(0);
		for (const m of result) {
			expect(m.provider.toLowerCase()).toContain("anthropic");
			expect(m.id.toLowerCase()).toContain("claude");
		}
	});

	it("should return empty array for empty search string", () => {
		const result = filterModels(mockModels, "");
		expect(result).toHaveLength(0);
	});
});

import { describe, it, expect } from "bun:test";
import { generateTokenStatsMessage } from "../src/token-stats";

// Minimal mock for AgentSession with getSessionStats
function mockSession(stats: {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
}) {
	return {
		getSessionStats: () => ({
			tokens: stats.tokens,
			contextUsage: stats.contextUsage,
		}),
	} as any;
}

describe("Token Stats", () => {
	describe("generateTokenStatsMessage", () => {
		it("should return null when contextUsage is undefined", () => {
			const session = mockSession({
				tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
				contextUsage: undefined,
			});
			const prev = new Map();
			const result = generateTokenStatsMessage("ch1", session, prev);
			expect(result).toBeNull();
		});

		it("should return null when contextUsage.percent is null (post-compaction)", () => {
			const session = mockSession({
				tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
				contextUsage: { tokens: null, contextWindow: 128000, percent: null },
			});
			const prev = new Map();
			const result = generateTokenStatsMessage("ch1", session, prev);
			expect(result).toBeNull();
		});

		it("should show correct context percentage (not cumulative)", () => {
			const session = mockSession({
				tokens: { input: 50000, output: 30000, cacheRead: 10000, cacheWrite: 5000, total: 95000 },
				contextUsage: { tokens: 32000, contextWindow: 128000, percent: 25 },
			});
			const prev = new Map();
			const result = generateTokenStatsMessage("ch1", session, prev);
			expect(result).not.toBeNull();
			expect(result!.message).toContain("25.0%");
			expect(result!.message).toContain("32,000 / 128,000");
			expect(result!.message).toContain("50,000 tok");
			expect(result!.message).toContain("30,000 tok");
		});

		it("should show N/A deltas when no previous data", () => {
			const session = mockSession({
				tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
				contextUsage: { tokens: 1500, contextWindow: 128000, percent: 1.17 },
			});
			const prev = new Map();
			const result = generateTokenStatsMessage("ch1", session, prev);
			expect(result).not.toBeNull();
			expect(result!.message).toContain("N/A");
			expect(result!.shouldAlert).toBe(false);
		});

		it("should calculate deltas for In, Out, and Context from previous data", () => {
			const session = mockSession({
				tokens: { input: 55000, output: 32000, cacheRead: 0, cacheWrite: 0, total: 87000 },
				contextUsage: { tokens: 32000, contextWindow: 128000, percent: 25 },
			});
			const prev = new Map<string, { contextPercent: number; inputTokens: number; outputTokens: number }>();
			prev.set("ch1", { contextPercent: 20, inputTokens: 50000, outputTokens: 30000 });
			const result = generateTokenStatsMessage("ch1", session, prev);
			expect(result).not.toBeNull();
			expect(result!.message).toContain("Δ5.00%");
			expect(result!.message).toContain("+5,000");
			expect(result!.message).toContain("+2,000");
		});

		it("should alert when context delta >= 1%", () => {
			const session = mockSession({
				tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
				contextUsage: { tokens: 32000, contextWindow: 128000, percent: 25 },
			});
			const prev = new Map<string, { contextPercent: number; inputTokens: number; outputTokens: number }>();
			prev.set("ch1", { contextPercent: 23.5, inputTokens: 900, outputTokens: 400 });
			const result = generateTokenStatsMessage("ch1", session, prev);
			expect(result!.shouldAlert).toBe(true);
		});

		it("should NOT alert when context delta < 1%", () => {
			const session = mockSession({
				tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
				contextUsage: { tokens: 32000, contextWindow: 128000, percent: 25 },
			});
			const prev = new Map<string, { contextPercent: number; inputTokens: number; outputTokens: number }>();
			prev.set("ch1", { contextPercent: 24.5, inputTokens: 900, outputTokens: 400 });
			const result = generateTokenStatsMessage("ch1", session, prev);
			expect(result!.shouldAlert).toBe(false);
		});

		it("should never show context utilization above 100% even with large lifetime tokens", () => {
			const session = mockSession({
				tokens: { input: 200000, output: 150000, cacheRead: 50000, cacheWrite: 20000, total: 420000 },
				contextUsage: { tokens: 110000, contextWindow: 128000, percent: 85.9 },
			});
			const prev = new Map();
			const result = generateTokenStatsMessage("ch1", session, prev);
			expect(result).not.toBeNull();
			expect(result!.message).toContain("85.9%");
			expect(result!.message).toContain("200,000 tok");
			expect(result!.message).toContain("150,000 tok");
		});

		it("should format message with In, Out, and Context lines", () => {
			const session = mockSession({
				tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
				contextUsage: { tokens: 32000, contextWindow: 128000, percent: 25 },
			});
			const prev = new Map();
			const result = generateTokenStatsMessage("ch1", session, prev);
			expect(result!.message).toMatch(/📊 \*\*Token Utilization\*\*/);
			expect(result!.message).toMatch(/\*\*In:\*\*/);
			expect(result!.message).toMatch(/\*\*Out:\*\*/);
			expect(result!.message).toMatch(/\*\*Context:\*\*/);
		});

		it("should show delta tokens as positive numbers", () => {
			const session = mockSession({
				tokens: { input: 12000, output: 8000, cacheRead: 0, cacheWrite: 0, total: 20000 },
				contextUsage: { tokens: 20000, contextWindow: 128000, percent: 15.6 },
			});
			const prev = new Map<string, { contextPercent: number; inputTokens: number; outputTokens: number }>();
			prev.set("ch1", { contextPercent: 10.0, inputTokens: 5000, outputTokens: 3000 });
			const result = generateTokenStatsMessage("ch1", session, prev);
			expect(result).not.toBeNull();
			expect(result!.message).toContain("+7,000");
			expect(result!.message).toContain("+5,000");
		});
	});
});

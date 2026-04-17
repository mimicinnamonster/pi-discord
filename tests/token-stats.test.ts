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
			expect(result!.message).toContain("95,000 tok");
		});

		it("should not exceed 100% context usage", () => {
			const session = mockSession({
				tokens: { input: 50000, output: 30000, cacheRead: 10000, cacheWrite: 5000, total: 95000 },
				contextUsage: { tokens: 100000, contextWindow: 128000, percent: 78.125 },
			});
			const prev = new Map();
			const result = generateTokenStatsMessage("ch1", session, prev);
			expect(result).not.toBeNull();
			expect(result!.message).toContain("78.1%");
			// Lifetime tokens can exceed context window but percentage is correct
			expect(result!.message).toContain("95,000 tok");
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

		it("should calculate context delta from previous data", () => {
			const session = mockSession({
				tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
				contextUsage: { tokens: 32000, contextWindow: 128000, percent: 25 },
			});
			const prev = new Map<string, { contextPercent: number; cumulativeTotal: number }>();
			prev.set("ch1", { contextPercent: 20, cumulativeTotal: 1000 });
			const result = generateTokenStatsMessage("ch1", session, prev);
			expect(result).not.toBeNull();
			expect(result!.message).toContain("Δ5.00%");
			expect(result!.message).toContain("+500 tok");
		});

		it("should alert when context delta >= 1%", () => {
			const session = mockSession({
				tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
				contextUsage: { tokens: 32000, contextWindow: 128000, percent: 25 },
			});
			const prev = new Map<string, { contextPercent: number; cumulativeTotal: number }>();
			prev.set("ch1", { contextPercent: 23.5, cumulativeTotal: 1000 });
			const result = generateTokenStatsMessage("ch1", session, prev);
			expect(result!.shouldAlert).toBe(true);
		});

		it("should NOT alert when context delta < 1%", () => {
			const session = mockSession({
				tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
				contextUsage: { tokens: 32000, contextWindow: 128000, percent: 25 },
			});
			const prev = new Map<string, { contextPercent: number; cumulativeTotal: number }>();
			prev.set("ch1", { contextPercent: 24.5, cumulativeTotal: 1000 });
			const result = generateTokenStatsMessage("ch1", session, prev);
			expect(result!.shouldAlert).toBe(false);
		});

		it("should never show context utilization above 100% even with large lifetime tokens", () => {
			// Simulate a long session where cumulative tokens far exceed context window
			const session = mockSession({
				tokens: { input: 200000, output: 150000, cacheRead: 50000, cacheWrite: 20000, total: 420000 },
				contextUsage: { tokens: 110000, contextWindow: 128000, percent: 85.9 },
			});
			const prev = new Map();
			const result = generateTokenStatsMessage("ch1", session, prev);
			expect(result).not.toBeNull();
			// Context % is within bounds
			expect(result!.message).toContain("85.9%");
			// But lifetime tokens far exceed context window (this is correct)
			expect(result!.message).toContain("420,000 tok");
		});

		it("should format message with Context and Lifetime lines", () => {
			const session = mockSession({
				tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
				contextUsage: { tokens: 32000, contextWindow: 128000, percent: 25 },
			});
			const prev = new Map();
			const result = generateTokenStatsMessage("ch1", session, prev);
			expect(result!.message).toMatch(/📊 \*\*Token Utilization\*\*/);
			expect(result!.message).toMatch(/\*\*Context:\*\*/);
			expect(result!.message).toMatch(/\*\*Lifetime:\*\*/);
		});
	});
});

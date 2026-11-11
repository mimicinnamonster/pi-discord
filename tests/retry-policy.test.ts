/**
 * Retry Policy Tests
 * Exercises the non-retryable classification used by the auto_retry_start
 * handler in src/index.ts to stop the SDK from retrying errors that can never
 * succeed (402 out of balance, context overflow, bad credentials).
 */

import { describe, it, expect } from "vitest";
import { isNonRetryableModelError, retryHintForModelError } from "../src/retry-policy.ts";

describe("isNonRetryableModelError", () => {
	it("flags the 402 balance error seen in production", () => {
		expect(
			isNonRetryableModelError(
				"402: This request would exceed your remaining balance. You requested up to 935,368 tokens."
			)
		).toBe(true);
	});

	it("flags status-prefixed terminal codes", () => {
		expect(isNonRetryableModelError("400: bad request")).toBe(true);
		expect(isNonRetryableModelError("401: invalid token")).toBe(true);
		expect(isNonRetryableModelError("HTTP 403: forbidden")).toBe(true);
		expect(isNonRetryableModelError("status: 402")).toBe(true);
	});

	it("flags context-window overflow wording", () => {
		expect(isNonRetryableModelError("context_length_exceeded")).toBe(true);
		expect(isNonRetryableModelError("This model's maximum context length is 200000 tokens")).toBe(true);
		expect(isNonRetryableModelError("prompt is too long: 250000 tokens")).toBe(true);
	});

	it("flags credential wording", () => {
		expect(isNonRetryableModelError("Invalid API key provided")).toBe(true);
		expect(isNonRetryableModelError("insufficient balance")).toBe(true);
	});

	it("does not flag transient failures", () => {
		expect(isNonRetryableModelError("429: rate limit exceeded")).toBe(false);
		expect(isNonRetryableModelError("500: internal server error")).toBe(false);
		expect(isNonRetryableModelError("Connection reset by peer")).toBe(false);
		expect(isNonRetryableModelError("socket hang up")).toBe(false);
	});

	it("keeps retrying 429 even when the provider calls it a quota", () => {
		// Google/Gemini wording: a rate limit that clears on backoff.
		expect(
			isNonRetryableModelError(
				"429: You exceeded your current quota, please check your plan and billing details"
			)
		).toBe(false);
		expect(isNonRetryableModelError("HTTP 429: quota exceeded for model gemini-2.5-pro")).toBe(false);
	});

	it("still flags a genuine out-of-balance error", () => {
		expect(
			isNonRetryableModelError(
				"402: This request would exceed your remaining balance. You requested up to 935,368 tokens."
			)
		).toBe(true);
		expect(isNonRetryableModelError("payment required - credit balance is negative")).toBe(true);
	});

	it("does not mistake a token count for a status code", () => {
		// "requested up to 935,368 tokens" contains digits but no status code.
		expect(isNonRetryableModelError("requested up to 935,368 tokens")).toBe(false);
		expect(isNonRetryableModelError("retry attempt 3 of 10")).toBe(false);
	});

	it("ignores empty messages", () => {
		expect(isNonRetryableModelError("")).toBe(false);
	});
});

describe("retryHintForModelError", () => {
	it("points at the balance for quota errors", () => {
		expect(retryHintForModelError("402: insufficient balance")).toContain("balance");
	});

	it("suggests /compact for context overflow", () => {
		const hint = retryHintForModelError("context_length_exceeded");
		expect(hint).toContain("/compact");
		expect(hint).toContain("/session");
	});

	it("points at credentials for auth errors", () => {
		expect(retryHintForModelError("401: invalid api key")).toContain("API key");
	});

	it("falls back to a generic message", () => {
		expect(retryHintForModelError("something odd")).toBe("This error will not resolve by retrying.");
	});
});

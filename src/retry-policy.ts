/**
 * Retry classification for failed model requests.
 *
 * The SDK retries every failed run up to `retry.maxRetries` with exponential
 * backoff. Some provider errors can never succeed on retry — an exhausted
 * balance (402), rejected credentials (401/403), a malformed request (400), or
 * a context-window overflow — so retrying only delays the moment the user
 * learns what to do about it.
 */

/**
 * Provider status codes that are terminal. Matched only in a status position
 * ("402: …", "status 402", "HTTP 403") so a token count or attempt number in
 * the message text is not mistaken for one.
 */
const NON_RETRYABLE_STATUS = /^(?:HTTP\s*)?(?:400|401|402|403)\b\s*[:\-–]|\b(?:status|code)\s*[:=]?\s*(?:400|401|402|403)\b/i;

/**
 * Status codes that are worth retrying. Checked before the wording heuristics
 * because providers describe rate limits with terminal-sounding words: Google
 * answers "429 … You exceeded your current quota", which must still back off.
 */
const RETRYABLE_STATUS = /^(?:HTTP\s*)?429\b\s*[:\-–]|\b(?:status|code)\s*[:=]?\s*429\b/i;

/** Billing wording that no retry can fix. Deliberately excludes bare "quota". */
const NON_RETRYABLE_BILLING = /insufficient balance|remaining balance|out of credit|credit balance|payment required|billing/i;

export function isNonRetryableModelError(errorMessage: string): boolean {
	const message = (errorMessage ?? "").toLowerCase();
	if (!message) return false;
	if (RETRYABLE_STATUS.test(errorMessage)) return false;
	if (NON_RETRYABLE_STATUS.test(errorMessage)) return true;
	if (NON_RETRYABLE_BILLING.test(message)) return true;
	if (message.includes("invalid api key") || message.includes("unauthorized") || message.includes("forbidden")) {
		return true;
	}
	if (message.includes("context_length_exceeded") || message.includes("context length")) return true;
	if (message.includes("context window") || message.includes("maximum context")) return true;
	if (message.includes("prompt is too long") || message.includes("request too large")) return true;
	return false;
}

/** One actionable sentence to send with a non-retryable error. */
export function retryHintForModelError(errorMessage: string): string {
	const message = (errorMessage ?? "").toLowerCase();
	if (NON_RETRYABLE_BILLING.test(message) || message.includes("credit")) {
		return "The provider account is out of balance. Top it up, then resend the message.";
	}
	if (message.includes("api key") || message.includes("unauthorized") || message.includes("forbidden")) {
		return "The provider rejected the credentials. Check the API key configured for this model.";
	}
	if (
		message.includes("context") ||
		message.includes("exceed") ||
		message.includes("too long") ||
		message.includes("too large")
	) {
		return "The session context is likely too large. Use `/compact` to shrink it, or `/session` to start a fresh session.";
	}
	return "This error will not resolve by retrying.";
}

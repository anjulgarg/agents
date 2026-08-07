export interface AssistantFailureLike {
	stopReason?: unknown;
	errorMessage?: unknown;
}

/**
 * Provider failures that are deterministic and should not be retried blindly.
 * Quota, authentication, request-shape, and context failures need operator action.
 */
const NON_RETRYABLE_PROVIDER_ERROR_PATTERN =
	/\b(?:400|401|403|404|422)\b|authentication|unauthori[sz]ed|forbidden|invalid(?: request|_request)|bad request|context (?:length|window)|too (?:large|long)|content policy|safety|insufficient[_ ]quota|\bquota\b|out of budget|billing|permission denied/i;

/**
 * Provider and transport failures that are normally safe to retry with bounded
 * exponential backoff. Keep this local because older installed pi-ai versions
 * do not classify empty Responses API failures as retryable.
 */
const TRANSIENT_PROVIDER_ERROR_PATTERN =
	/\b(?:429|5\d{2})\b|overloaded|rate.?limit|too many requests|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?error|connection.?refused|connection.?lost|upstream.?connect|disconnect\/?reset|reset before headers|connection termination|socket|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|timed? ?out|timeout|terminated|websocket.?closed|websocket.?error|ended without|retry(?:ing|able)|try your request again/i;

const EMPTY_RESPONSE_ERROR_PATTERN = /unknown error|no error details/i;

export function providerErrorText(message: AssistantFailureLike): string {
	return typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
}

/**
 * Return true only for bounded-retry candidates. Empty failure messages are
 * treated as transient because the provider gave no information to classify.
 */
export function isTransientProviderFailure(message: AssistantFailureLike): boolean {
	if (message.stopReason !== "error") return false;
	const errorText = providerErrorText(message);
	if (!errorText) return true;
	if (NON_RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorText)) return false;
	return (
		TRANSIENT_PROVIDER_ERROR_PATTERN.test(errorText) || EMPTY_RESPONSE_ERROR_PATTERN.test(errorText)
	);
}

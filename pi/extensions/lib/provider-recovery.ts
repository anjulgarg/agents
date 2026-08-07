import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isTransientProviderFailure, providerErrorText } from "./provider-retry.ts";

export const PROVIDER_RECOVERY_MESSAGE_TYPE = "provider-recovery";
/** Legacy opt-in attempt cap. The default recovery budget is time-based. */
export const DEFAULT_PROVIDER_RECOVERY_RETRIES = 2;
export const DEFAULT_PROVIDER_RECOVERY_BASE_DELAY_MS = 2_000;
export const DEFAULT_PROVIDER_RECOVERY_MAX_DELAY_MS = 30_000;
export const DEFAULT_PROVIDER_RECOVERY_WINDOW_MS = 60_000;

const PROVIDER_RECOVERY_PROMPT = [
	"[INTERNAL PROVIDER RECOVERY]",
	"The previous model response failed because of a transient provider or network error.",
	"Continue the existing task from the current session state.",
	"Inspect current state before repeating any side effects, and do not mention this recovery message unless recovery fails again.",
].join("\n");

export interface ProviderRecoveryOptions {
	/** Optional legacy attempt cap. Omit it to use the one-minute window only. */
	maxRetries?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	/** Maximum continuous transient-failure recovery window. Defaults to one minute. */
	retryWindowMs?: number;
	/** Injectable clock for deterministic tests. */
	now?: () => number;
}

interface RecoveryState {
	attempts: number;
	retryStartedAt?: number;
	timer?: ReturnType<typeof setTimeout>;
	queuedRecovery: boolean;
	circuitOpen: boolean;
	circuitModelKey?: string;
	closed: boolean;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(minimum, Math.floor(value));
}

function latestAssistantMessage(ctx: ExtensionContext):
	| {
			stopReason?: unknown;
			errorMessage?: unknown;
	  }
	| undefined {
	try {
		const entry = ctx.sessionManager.getLeafEntry();
		if (entry?.type !== "message" || entry.message.role !== "assistant") return undefined;
		return entry.message;
	} catch {
		return undefined;
	}
}

function modelKey(ctx: ExtensionContext): string {
	const model = ctx.model;
	return model ? `${model.provider}/${model.id}` : "unknown";
}

/**
 * Keep a settled parent session alive after the native retry budget is exhausted.
 * Pi's core handles ordinary transient failures first; this is the bounded outer
 * guard for providers that return an unstructured failure response. Once the
 * window is exhausted, a per-model circuit breaker prevents duplicate settled
 * events from replaying the same hidden recovery sequence until a new turn or
 * model selection resets it.
 */
export function registerProviderRecovery(
	pi: ExtensionAPI,
	options: ProviderRecoveryOptions = {},
): () => void {
	const maxRetries =
		options.maxRetries === undefined
			? undefined
			: boundedInteger(options.maxRetries, DEFAULT_PROVIDER_RECOVERY_RETRIES, 0);
	const baseDelayMs = boundedInteger(
		options.baseDelayMs,
		DEFAULT_PROVIDER_RECOVERY_BASE_DELAY_MS,
		0,
	);
	const maxDelayMs = Math.max(
		baseDelayMs,
		boundedInteger(options.maxDelayMs, DEFAULT_PROVIDER_RECOVERY_MAX_DELAY_MS, 0),
	);
	const retryWindowMs = boundedInteger(
		options.retryWindowMs,
		DEFAULT_PROVIDER_RECOVERY_WINDOW_MS,
		0,
	);
	const now = options.now ?? (() => Date.now());
	const state: RecoveryState = {
		attempts: 0,
		queuedRecovery: false,
		circuitOpen: false,
		closed: false,
	};

	const clearTimer = (): void => {
		if (!state.timer) return;
		clearTimeout(state.timer);
		state.timer = undefined;
	};

	const reset = (): void => {
		clearTimer();
		state.attempts = 0;
		state.retryStartedAt = undefined;
		state.queuedRecovery = false;
		state.circuitOpen = false;
		state.circuitModelKey = undefined;
	};

	pi.on("session_start", () => {
		state.closed = false;
		reset();
	});

	pi.on("agent_start", () => {
		// A queued internal recovery preserves its retry window. A normal user
		// turn cancels any delayed recovery and starts a fresh window.
		if (!state.queuedRecovery) reset();
		state.queuedRecovery = false;
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason === "error") {
			if (isTransientProviderFailure(event.message)) state.retryStartedAt ??= now();
			return;
		}
		if (event.message.stopReason !== "aborted") reset();
	});

	pi.on("model_select", () => {
		reset();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (state.closed || state.timer) return;
		const failure = latestAssistantMessage(ctx);
		if (!failure || !isTransientProviderFailure(failure)) return;
		const failedModelKey = modelKey(ctx);
		if (state.circuitOpen) {
			if (state.circuitModelKey === failedModelKey) return;
			state.circuitOpen = false;
			state.circuitModelKey = undefined;
			state.attempts = 0;
			state.retryStartedAt = undefined;
		}

		const failureObservedAt = now();
		state.retryStartedAt ??= failureObservedAt;
		const elapsedMs = Math.max(0, failureObservedAt - state.retryStartedAt);
		if ((maxRetries !== undefined && state.attempts >= maxRetries) || elapsedMs >= retryWindowMs) {
			state.circuitOpen = true;
			state.circuitModelKey = failedModelKey;
			ctx.ui?.notify(
				`Automatic provider recovery stopped for ${failedModelKey}: ${providerErrorText(failure) || "unspecified provider error"}`,
				"error",
			);
			return;
		}

		const attempt = ++state.attempts;
		const backoffMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
		const remainingMs = Math.max(0, retryWindowMs - elapsedMs);
		if (backoffMs >= remainingMs) {
			state.circuitOpen = true;
			state.circuitModelKey = failedModelKey;
			ctx.ui?.notify(
				`Automatic provider recovery stopped for ${failedModelKey}: ${providerErrorText(failure) || "retry window expired"}`,
				"error",
			);
			return;
		}

		state.timer = setTimeout(() => {
			state.timer = undefined;
			if (state.closed) return;
			state.queuedRecovery = true;
			pi.sendMessage(
				{
					customType: PROVIDER_RECOVERY_MESSAGE_TYPE,
					content: PROVIDER_RECOVERY_PROMPT,
					display: false,
					details: {
						attempt,
						error: providerErrorText(failure).slice(0, 200) || "unspecified provider error",
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}, backoffMs);
		state.timer.unref?.();
	});

	pi.on("session_shutdown", () => {
		state.closed = true;
		reset();
	});

	return () => {
		state.closed = true;
		reset();
	};
}

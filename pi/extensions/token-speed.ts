import type {
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";

export type Clock = () => number;
export type TokenEstimator = (text: string) => number;

export const STATUS_KEY = "token-speed";
export const MIN_REPORT_DURATION_MS = 100;
export const LIVE_UPDATE_INTERVAL_MS = 250;
export const WARM_UP_MS = 1000;
export const defaultClock: Clock = () => performance.now();

/** Match Pi's portable chars-per-token heuristic for provisional streaming rates. */
export const defaultTokenEstimator: TokenEstimator = (text) => Math.ceil(text.length / 4);

export function formatTokenSpeed(tokens: number, durationMs: number): string | undefined {
	if (!Number.isFinite(tokens) || tokens <= 0) return undefined;
	if (!Number.isFinite(durationMs) || durationMs < MIN_REPORT_DURATION_MS) return undefined;
	const speed = tokens / (durationMs / 1000);
	if (!Number.isFinite(speed) || speed <= 0) return undefined;
	return `${Math.round(speed)} tok/s`;
}

export function isSuccessfulStopReason(reason: string): boolean {
	return reason === "stop" || reason === "length" || reason === "toolUse";
}

export interface TokenSpeedOptions {
	clock?: Clock;
	estimateTokens?: TokenEstimator;
}

/**
 * Report output tokens per second over the whole generation window.
 *
 * The window runs from the assistant `message_start` (Pi emits it when the
 * provider response stream opens) to the arrival of the last non-empty delta,
 * and the numerator is the provider's own `usage.output`, which already
 * includes reasoning tokens.
 *
 * Measuring only the span between the first and last delta looks like a purer
 * "decode rate" but is not measurable from the client: tokens generated before
 * the first visible delta (prompt prefill and hidden reasoning) still land in
 * `usage.output`, and any transport buffering collapses the observed span. Both
 * effects divide a full-message token count by a fraction of the time that
 * produced it, which is how a 60 tok/s stream is reported as hundreds or
 * thousands of tok/s. The generation window can never be shorter than the time
 * the tokens actually took, so the reported rate can never exceed the real one.
 */
export default function tokenSpeedExtension(
	pi: ExtensionAPI,
	options: TokenSpeedOptions = {},
): void {
	const clock = options.clock ?? defaultClock;
	const estimateTokens = options.estimateTokens ?? defaultTokenEstimator;
	/** Start of the provider response stream, the origin of the generation window. */
	let generationStart: number | undefined;
	let lastChunkTime: number | undefined;
	let lastLiveUpdateTime: number | undefined;
	let streamedOutput = "";
	let lastFinalStatus: string | undefined;

	const resetMeasurement = (): void => {
		generationStart = undefined;
		lastChunkTime = undefined;
		lastLiveUpdateTime = undefined;
		streamedOutput = "";
	};

	const showStatus = (ctx: ExtensionContext, status: string | undefined): void => {
		ctx.ui.setStatus(STATUS_KEY, status ? ctx.ui.theme.fg("accent", status) : undefined);
	};

	const restoreFinalStatus = (ctx: ExtensionContext): void => {
		resetMeasurement();
		showStatus(ctx, lastFinalStatus);
	};

	pi.on("session_start", (_event, ctx) => {
		resetMeasurement();
		lastFinalStatus = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		resetMeasurement();
		lastFinalStatus = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_compact", (_event, ctx) => {
		restoreFinalStatus(ctx);
	});

	pi.on("message_start", (event: MessageStartEvent, ctx) => {
		if (event.message.role !== "assistant") return;
		restoreFinalStatus(ctx);
		generationStart = clock();
	});

	pi.on("message_update", (event: MessageUpdateEvent, ctx) => {
		if (event.message.role !== "assistant") return;
		const streamEvent = event.assistantMessageEvent;
		const isNonEmptyDelta =
			(streamEvent.type === "text_delta" ||
				streamEvent.type === "thinking_delta" ||
				streamEvent.type === "toolcall_delta") &&
			streamEvent.delta.length > 0;
		if (!isNonEmptyDelta) return;
		// Without the stream-open timestamp the window origin is unknown, and any
		// substitute origin would over-report. Stay silent instead.
		if (generationStart === undefined) return;

		const now = clock();
		// Track every chunk, including those skipped by warm-up or throttling.
		lastChunkTime = now;
		streamedOutput += streamEvent.delta;

		if (now < generationStart + WARM_UP_MS) return;
		if (lastLiveUpdateTime !== undefined && now - lastLiveUpdateTime < LIVE_UPDATE_INTERVAL_MS)
			return;

		// Provisional: streamed characters only, so hidden reasoning tokens are
		// missing and the estimate reads low until message_end supplies real usage.
		const formatted = formatTokenSpeed(estimateTokens(streamedOutput), now - generationStart);
		if (!formatted) return;

		lastLiveUpdateTime = now;
		showStatus(ctx, formatted);
	});

	pi.on("message_end", (event: MessageEndEvent, ctx) => {
		if (event.message.role !== "assistant") return;
		const { stopReason, usage } = event.message;
		if (
			!isSuccessfulStopReason(stopReason) ||
			generationStart === undefined ||
			lastChunkTime === undefined ||
			!usage
		) {
			restoreFinalStatus(ctx);
			return;
		}

		// End at the last chunk rather than the message_end clock so post-stream
		// processing latency does not deflate the rate.
		const formatted = formatTokenSpeed(usage.output, lastChunkTime - generationStart);
		if (formatted) lastFinalStatus = formatted;
		restoreFinalStatus(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (generationStart !== undefined) restoreFinalStatus(ctx);
	});
}

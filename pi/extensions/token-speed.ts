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

export function effectiveOutputTokens(
	usage: { output: number; reasoning?: number },
	hadThinkingDelta: boolean,
): number {
	if (usage.reasoning !== undefined && usage.reasoning > 0 && !hadThinkingDelta) {
		return Math.max(0, usage.output - usage.reasoning);
	}
	return usage.output;
}

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

export default function tokenSpeedExtension(
	pi: ExtensionAPI,
	options: TokenSpeedOptions = {},
): void {
	const clock = options.clock ?? defaultClock;
	const estimateTokens = options.estimateTokens ?? defaultTokenEstimator;
	let firstDeltaTime: number | undefined;
	let lastChunkTime: number | undefined;
	let lastLiveUpdateTime: number | undefined;
	let streamedOutput = "";
	let hadThinkingDelta = false;
	let firstChunkEstimate: number | undefined;
	let liveWarmUpUntil: number | undefined;
	let lastFinalStatus: string | undefined;

	const resetMeasurement = (): void => {
		firstDeltaTime = undefined;
		lastChunkTime = undefined;
		lastLiveUpdateTime = undefined;
		streamedOutput = "";
		hadThinkingDelta = false;
		firstChunkEstimate = undefined;
		liveWarmUpUntil = undefined;
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
		if (event.message.role === "assistant") restoreFinalStatus(ctx);
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

		if (streamEvent.type === "thinking_delta") hadThinkingDelta = true;
		streamedOutput += streamEvent.delta;

		const now = clock();
		// Track every chunk, including those skipped by warm-up or throttling.
		lastChunkTime = now;
		if (firstDeltaTime === undefined) {
			firstDeltaTime = now;
			lastLiveUpdateTime = now;
			firstChunkEstimate = estimateTokens(streamEvent.delta);
			liveWarmUpUntil = now + WARM_UP_MS;
			return;
		}

		if (now < liveWarmUpUntil!) return;

		if (lastLiveUpdateTime !== undefined && now - lastLiveUpdateTime < LIVE_UPDATE_INTERVAL_MS)
			return;

		const liveNumerator = Math.max(0, estimateTokens(streamedOutput) - firstChunkEstimate!);
		const formatted = formatTokenSpeed(liveNumerator, now - firstDeltaTime);
		if (!formatted) return;

		lastLiveUpdateTime = now;
		showStatus(ctx, formatted);
	});

	pi.on("message_end", (event: MessageEndEvent, ctx) => {
		if (event.message.role !== "assistant") return;
		const { stopReason, usage } = event.message;
		if (
			!isSuccessfulStopReason(stopReason) ||
			firstDeltaTime === undefined ||
			lastChunkTime === undefined ||
			!usage
		) {
			restoreFinalStatus(ctx);
			return;
		}

		const adjustedNumerator = Math.max(
			0,
			effectiveOutputTokens(usage, hadThinkingDelta) - (firstChunkEstimate ?? 0),
		);
		// Measure interval strictly from first to last non-empty chunk arrival, not message_end clock.
		// This avoids inflated durations from post-stream processing latency.
		const finalDuration = lastChunkTime - firstDeltaTime;
		const formatted = formatTokenSpeed(adjustedNumerator, finalDuration);
		if (formatted) lastFinalStatus = formatted;
		restoreFinalStatus(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (firstDeltaTime !== undefined) restoreFinalStatus(ctx);
	});
}

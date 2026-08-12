import { SHIMMER_TIMING } from "./pi-tui-soft-group/timing.ts";

/** Fastest visual cadence allowed for project-controlled ambient animation. */
export const PROCESS_ANIMATION_FRAME_INTERVAL_MS = SHIMMER_TIMING.frameIntervalMs;

export type ProcessAnimationCallback = (now: number) => void;

interface ProcessAnimationSubscription {
	callback: ProcessAnimationCallback;
	intervalMs: number;
	nextFrameAt: number;
}

interface ProcessAnimationState {
	subscriptions: Map<symbol, ProcessAnimationSubscription>;
	timer?: ReturnType<typeof setInterval>;
	timerIntervalMs?: number;
	timerStarts: number;
	ticks: number;
}

export interface ProcessAnimationDiagnostics {
	subscriptionCount: number;
	timerActive: boolean;
	timerIntervalMs?: number;
	timerStarts: number;
	ticks: number;
}

const PROCESS_ANIMATION_COORDINATOR_KEY = Symbol.for(
	"@anjulgarg/agents.process-animation-coordinator.v1",
);

function sharedState(): ProcessAnimationState {
	const scope = globalThis as typeof globalThis & Record<symbol, unknown>;
	const existing = scope[PROCESS_ANIMATION_COORDINATOR_KEY] as ProcessAnimationState | undefined;
	if (existing?.subscriptions instanceof Map) return existing;
	const created: ProcessAnimationState = {
		subscriptions: new Map(),
		timerStarts: 0,
		ticks: 0,
	};
	scope[PROCESS_ANIMATION_COORDINATOR_KEY] = created;
	return created;
}

function normalizedInterval(intervalMs: number): number {
	const requested = Number.isFinite(intervalMs)
		? Math.max(PROCESS_ANIMATION_FRAME_INTERVAL_MS, Math.floor(intervalMs))
		: PROCESS_ANIMATION_FRAME_INTERVAL_MS;
	return (
		Math.ceil(requested / PROCESS_ANIMATION_FRAME_INTERVAL_MS) * PROCESS_ANIMATION_FRAME_INTERVAL_MS
	);
}

function nextFrameBoundary(now: number, intervalMs: number): number {
	return (Math.floor(now / intervalMs) + 1) * intervalMs;
}

function stopTimer(state: ProcessAnimationState): void {
	if (state.timer) clearInterval(state.timer);
	state.timer = undefined;
	state.timerIntervalMs = undefined;
}

function tick(state: ProcessAnimationState): void {
	state.ticks++;
	const now = Date.now();
	let removedBrokenSubscription = false;
	for (const [id, subscription] of state.subscriptions) {
		if (now < subscription.nextFrameAt) continue;
		subscription.nextFrameAt = nextFrameBoundary(now, subscription.intervalMs);
		try {
			subscription.callback(now);
		} catch {
			state.subscriptions.delete(id);
			removedBrokenSubscription = true;
		}
	}
	if (removedBrokenSubscription) syncTimer(state);
}

function syncTimer(state: ProcessAnimationState): void {
	const intervalMs = [...state.subscriptions.values()].reduce<number | undefined>(
		(minimum, subscription) =>
			Math.min(minimum ?? subscription.intervalMs, subscription.intervalMs),
		undefined,
	);
	if (intervalMs === state.timerIntervalMs && (intervalMs === undefined || state.timer)) return;
	stopTimer(state);
	if (intervalMs === undefined) return;
	const timer = setInterval(() => tick(state), intervalMs);
	timer.unref?.();
	state.timer = timer;
	state.timerIntervalMs = intervalMs;
	state.timerStarts++;
}

/**
 * Join the one process-wide visual frame clock. Requested cadences are rounded
 * up to 200ms multiples so independently loaded extensions share frame
 * boundaries and Pi TUI coalesces their synchronous render requests.
 */
export function subscribeProcessAnimation(
	callback: ProcessAnimationCallback,
	intervalMs = PROCESS_ANIMATION_FRAME_INTERVAL_MS,
): () => void {
	const state = sharedState();
	const id = Symbol("process-animation-subscription");
	const normalized = normalizedInterval(intervalMs);
	state.subscriptions.set(id, {
		callback,
		intervalMs: normalized,
		nextFrameAt: nextFrameBoundary(Date.now(), normalized),
	});
	syncTimer(state);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		state.subscriptions.delete(id);
		syncTimer(state);
	};
}

/** Bounded process-level visibility for diagnostics and regression tests. */
export function getProcessAnimationDiagnostics(): ProcessAnimationDiagnostics {
	const state = sharedState();
	return {
		subscriptionCount: state.subscriptions.size,
		timerActive: state.timer !== undefined,
		timerIntervalMs: state.timerIntervalMs,
		timerStarts: state.timerStarts,
		ticks: state.ticks,
	};
}

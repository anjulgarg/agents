/**
 * Shared timing contract for every shimmer consumer. The 200ms cadence caps
 * repaint work at 5fps; phase remains wall-clock based so renderers stay aligned.
 */
export const SHIMMER_TIMING = Object.freeze({
	frameIntervalMs: 200,
	delayMs: 220,
	fadeInMs: 300,
	sweepMs: 1_250,
	restMs: 320,
} as const);

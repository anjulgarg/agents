/**
 * Shared timing contract for every shimmer consumer. The 250ms cadence caps
 * repaint work at 4fps; phase remains wall-clock based so renderers stay aligned.
 */
export const SHIMMER_TIMING = Object.freeze({
	frameIntervalMs: 250,
	delayMs: 220,
	fadeInMs: 300,
	sweepMs: 1_250,
	restMs: 320,
} as const);

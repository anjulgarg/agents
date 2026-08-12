/**
 * Shared timing contract for every shimmer consumer. The 150ms cadence caps
 * repaint work at about 6.7fps; phase remains wall-clock based so renderers stay aligned.
 */
export const SHIMMER_TIMING = Object.freeze({
	frameIntervalMs: 150,
	delayMs: 220,
	fadeInMs: 300,
	sweepMs: 1_250,
	restMs: 320,
} as const);

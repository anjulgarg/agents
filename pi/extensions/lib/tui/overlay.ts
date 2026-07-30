export interface FullscreenOverlayOptions {
	overlayOptions?: Readonly<Record<string, unknown>>;
}

export interface FullscreenOverlayConfig {
	overlay: true;
	overlayOptions: Record<string, unknown>;
}

/**
 * Shared Pi custom-UI options for a borderless, terminal-sized screen.
 * Specific overlays may override placement details without changing the
 * full-screen contract.
 */
export function fullscreenOverlayOptions(
	overrides: Readonly<Record<string, unknown>> = {},
): FullscreenOverlayConfig {
	return {
		overlay: true,
		overlayOptions: {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			...overrides,
		},
	};
}

/** Descriptive alias for callers that prefer the long form. */
export const fullScreenOverlayOptions = fullscreenOverlayOptions;
export const createFullscreenOverlayOptions = fullscreenOverlayOptions;

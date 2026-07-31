/** Re-export shared soft-group helpers for first-party extensions. */
export {
	SoftGroupTracker,
	SynchronizedShimmerRender,
	bindSoftGroupTracker,
	formatToolDuration,
	renderSoftGroupedCall,
	renderSynchronizedShimmerLine,
	resetToolActivity,
	seedSessionTopology,
	syncToolActivity,
	type SoftGroupItem,
	type SoftGroupStreak,
	type SoftGroupRenderContext,
	type SoftGroupedCallTheme,
	type ToolActivityRenderContext,
	type ToolActivitySnapshot,
	type ToolActivityTheme,
} from "../pi-tui-soft-group/index.ts";

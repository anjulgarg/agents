import type { ToolRenderContext } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import {
	SynchronizedShimmerRender,
	syncToolActivity,
	type ToolActivityTheme,
} from "../pi-tui-soft-group/index.ts";

/** Padding used by first-party tool rows with `renderShell: "self"`. */
export const TOOL_CHAT_PADDING = 1;

export type CollapsedErrorPolicy = "hide" | "show";

export type ExpandableToolRenderOptions = {
	/**
	 * Collapsed-row error visibility.
	 * - `"show"` (default): reveal content when `context.isError` is true
	 * - `"hide"`: stay quiet until Ctrl+O, matching minimal-mode
	 */
	errors?: CollapsedErrorPolicy;
};

export type ToolRevealContext = Pick<ToolRenderContext, "expanded"> & {
	isError?: boolean;
};

const DEFAULT_ACTIVITY_THEME: ToolActivityTheme = {
	fg(name, text) {
		if (name === "muted") return `\x1b[2m${text}\x1b[22m`;
		if (name === "toolTitle") return `\x1b[22m${text}`;
		if (name === "accent") return `\x1b[1m${text}\x1b[22m`;
		return text;
	},
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
	// Attribute-only styling above carries no colour to probe, so name the
	// sweep endpoints directly: the muted grey of tool rows up to a soft white.
	shimmerRamp: ["#8a8a8a", "#ededed"],
};

export function shouldRevealToolDetails(
	context: ToolRevealContext,
	options: ExpandableToolRenderOptions = {},
): boolean {
	if (context.expanded) {
		return true;
	}
	const errors = options.errors ?? "show";
	return errors === "show" && Boolean(context.isError);
}

/** Empty collapsed placeholder for `renderResult` early returns. */
export function emptyCollapsedToolRender(): Component {
	return new Container();
}

/**
 * Wraps tool call/result chrome so collapsed rows stay quiet.
 * Default error policy is `"show"` for existing subagent/team call sites.
 */
export class ExpandableToolRender implements Component {
	constructor(
		private readonly context: ToolRevealContext & Partial<ToolRenderContext>,
		private readonly content: Component,
		private readonly options: ExpandableToolRenderOptions = {},
		private readonly activityTheme?: ToolActivityTheme,
	) {}

	render(width: number): string[] {
		const activity = syncToolActivity(this.context);
		if (activity.active) {
			return new SynchronizedShimmerRender(
				this.content,
				this.activityTheme ?? DEFAULT_ACTIVITY_THEME,
				activity,
				true,
			).render(width);
		}
		return shouldRevealToolDetails(this.context, this.options) ? this.content.render(width) : [];
	}

	invalidate(): void {
		this.content.invalidate?.();
	}
}

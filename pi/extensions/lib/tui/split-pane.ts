import { visibleWidth } from "@earendil-works/pi-tui";
import { fillLine } from "./lines.ts";

export type PaneRenderer = (width: number, height: number) => readonly string[];

export interface SplitPaneOptions {
	width: number;
	height: number;
	left: PaneRenderer;
	right: PaneRenderer;
	narrowPane: "left" | "right";
	breakpoint?: number;
	leftRatio?: number;
	minLeftWidth?: number;
	maxLeftWidth?: number;
	minRightWidth?: number;
	divider?: string;
}

export interface SplitPaneLayout {
	mode: "split" | "narrow";
	width: number;
	height: number;
	leftWidth: number;
	rightWidth: number;
	dividerWidth: number;
}

function boundedSize(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Calculate responsive pane widths without rendering either pane. */
export function getSplitPaneLayout(options: SplitPaneOptions): SplitPaneLayout {
	const targetWidth = boundedSize(options.width);
	const targetHeight = boundedSize(options.height);
	const dividerWidth = visibleWidth(options.divider ?? " │ ");
	const available = targetWidth - dividerWidth;
	const minimumLeft = boundedSize(options.minLeftWidth ?? 32);
	const minimumRight = boundedSize(options.minRightWidth ?? 1);
	const canSplit =
		targetWidth >= boundedSize(options.breakpoint ?? 100) &&
		available >= minimumLeft + minimumRight;

	if (!canSplit) {
		return {
			mode: "narrow",
			width: targetWidth,
			height: targetHeight,
			leftWidth: options.narrowPane === "left" ? targetWidth : 0,
			rightWidth: options.narrowPane === "right" ? targetWidth : 0,
			dividerWidth,
		};
	}

	const maximumLeft = Math.max(
		minimumLeft,
		Math.min(boundedSize(options.maxLeftWidth ?? 46), available - minimumRight),
	);
	const ratio = Number.isFinite(options.leftRatio ?? 0.36)
		? Math.max(0, Math.min(1, options.leftRatio ?? 0.36))
		: 0.36;
	const desiredLeft = Math.floor(available * ratio);
	const leftWidth = Math.max(minimumLeft, Math.min(maximumLeft, desiredLeft));
	return {
		mode: "split",
		width: targetWidth,
		height: targetHeight,
		leftWidth,
		rightWidth: available - leftWidth,
		dividerWidth,
	};
}

/** Render two panes when space permits, otherwise render the active pane at full width. */
export function renderSplitPane(options: SplitPaneOptions): string[] {
	const layout = getSplitPaneLayout(options);
	if (layout.height === 0) return [];

	if (layout.mode === "narrow") {
		const pane = options.narrowPane === "left" ? options.left : options.right;
		const lines = pane(layout.width, layout.height);
		return Array.from({ length: layout.height }, (_, index) =>
			fillLine(lines[index] ?? "", layout.width),
		);
	}

	const divider = options.divider ?? " │ ";
	const leftLines = options.left(layout.leftWidth, layout.height);
	const rightLines = options.right(layout.rightWidth, layout.height);
	return Array.from(
		{ length: layout.height },
		(_, index) =>
			fillLine(leftLines[index] ?? "", layout.leftWidth) +
			divider +
			fillLine(rightLines[index] ?? "", layout.rightWidth),
	);
}

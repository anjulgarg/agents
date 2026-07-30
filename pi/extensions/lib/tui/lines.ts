import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function boundedSize(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Truncate an ANSI-styled line to width and pad it to exactly that width. */
export function fillLine(line: string, width: number, ellipsis = "…"): string {
	const targetWidth = boundedSize(width);
	if (targetWidth === 0) return "";
	const clipped = truncateToWidth(line, targetWidth, ellipsis);
	return clipped + " ".repeat(Math.max(0, targetWidth - visibleWidth(clipped)));
}

function horizontalInset(width: number, paddingX: number): number {
	const targetWidth = boundedSize(width);
	return Math.min(boundedSize(paddingX), Math.floor(Math.max(0, targetWidth - 1) / 2));
}

/** Return the usable width inside symmetric horizontal screen padding. */
export function getContentWidth(width: number, paddingX = 1): number {
	const targetWidth = boundedSize(width);
	return targetWidth - 2 * horizontalInset(targetWidth, paddingX);
}

/** Fit a line inside symmetric padding while preserving the requested width. */
export function insetLine(line: string, width: number, paddingX = 1, ellipsis = "…"): string {
	const targetWidth = boundedSize(width);
	if (targetWidth === 0) return "";
	const inset = horizontalInset(targetWidth, paddingX);
	const padding = " ".repeat(inset);
	return padding + fillLine(line, targetWidth - 2 * inset, ellipsis) + padding;
}

export interface ScreenFrameOptions {
	width: number;
	height: number;
	header?: readonly string[];
	body?: readonly string[];
	footer?: readonly string[];
	/** Add blank rows after the supplied footer, without changing its content. */
	footerPadding?: number;
}

/**
 * Pin header and footer lines while clipping or padding the body to full
 * height. Every returned line has the requested visible width.
 */
export function frameScreen({
	width,
	height,
	header = [],
	body = [],
	footer = [],
	footerPadding = 0,
}: ScreenFrameOptions): string[] {
	const targetHeight = boundedSize(height);
	if (targetHeight === 0) return [];

	const framedHeader = header.slice(0, targetHeight);
	const paddedFooter = [...footer, ...Array.from({ length: boundedSize(footerPadding) }, () => "")];
	const footerCapacity = Math.max(0, targetHeight - framedHeader.length);
	const framedFooter =
		footerCapacity === 0
			? []
			: paddedFooter.slice(Math.max(0, paddedFooter.length - footerCapacity));
	const bodyHeight = Math.max(0, targetHeight - framedHeader.length - framedFooter.length);
	const framedBody = body.slice(0, bodyHeight);
	const padding = Array.from({ length: bodyHeight - framedBody.length }, () => "");

	return [...framedHeader, ...framedBody, ...padding, ...framedFooter].map((line) =>
		fillLine(line, width),
	);
}

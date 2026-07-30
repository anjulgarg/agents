import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { fillLine, getContentWidth, insetLine } from "./lines.ts";
import { createTuiStyles, type TuiStyles, type TuiTheme } from "./theme.ts";

export type KeyHint = string | { key: string; label: string };

export interface TitleOptions {
	width: number;
	title: string;
	subtitle?: string;
	paddingX?: number;
	styles?: TuiStyles;
	theme?: TuiTheme;
}

export interface HeaderOptions extends TitleOptions {
	lines?: readonly string[];
	divider?: boolean;
	dividerCharacter?: string;
}

export interface MetadataOptions {
	width: number;
	lines: readonly string[];
	styles?: TuiStyles;
	theme?: TuiTheme;
}

export interface DividerOptions {
	width: number;
	character?: string;
	paddingX?: number;
	styles?: TuiStyles;
	theme?: TuiTheme;
}

export interface FooterOptions {
	width: number;
	lines?: readonly string[];
	hints?: readonly KeyHint[];
	divider?: boolean;
	dividerCharacter?: string;
	paddingX?: number;
	/** Blank rows after hints. Defaults to one when hints are present. */
	padding?: number;
	styles?: TuiStyles;
	theme?: TuiTheme;
}

function stylesFor(styles: TuiStyles | undefined, theme: TuiTheme | undefined): TuiStyles {
	return styles ?? createTuiStyles(theme);
}

function boundedSize(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function renderHint(hint: KeyHint, styles: TuiStyles): string {
	if (typeof hint === "string") return hint;
	return `${styles.hintKey(hint.key)} ${styles.hintLabel(hint.label)}`;
}

/** Render one exact-width title line, retaining ANSI styling while clipping. */
export function renderTitle({
	width,
	title,
	subtitle,
	paddingX = 1,
	styles: providedStyles,
	theme,
}: TitleOptions): string {
	const styles = stylesFor(providedStyles, theme);
	const text = subtitle
		? `${styles.title(title)} ${styles.hintLabel(subtitle)}`
		: styles.title(title);
	return insetLine(text, width, paddingX);
}

/** Render title, optional context lines, and a restrained divider. */
export function renderHeader({
	width,
	title,
	subtitle,
	lines = [],
	divider = true,
	dividerCharacter = "─",
	paddingX = 1,
	styles: providedStyles,
	theme,
}: HeaderOptions): string[] {
	const styles = stylesFor(providedStyles, theme);
	const rendered = [
		renderTitle({ width, title, subtitle, paddingX, styles }),
		...lines.map((line) => insetLine(styles.header(line), width, paddingX)),
	];
	if (divider)
		rendered.push(renderDivider({ width, character: dividerCharacter, paddingX, styles }));
	return rendered;
}

/** Render wrapped, restrained metadata consistently below screen titles. */
export function renderMetadata({
	width,
	lines,
	styles: providedStyles,
	theme,
}: MetadataOptions): string[] {
	const styles = stylesFor(providedStyles, theme);
	const renderWidth = Math.max(1, boundedSize(width));
	return lines
		.flatMap((line) => wrapTextWithAnsi(styles.metadata(line), renderWidth))
		.map((line) => fillLine(line, width));
}

/** Render a full-width divider using the terminal's visible width. */
export function renderDivider({
	width,
	character = "─",
	paddingX = 1,
	styles: providedStyles,
	theme,
}: DividerOptions): string {
	const styles = stylesFor(providedStyles, theme);
	return insetLine(
		styles.divider(character.repeat(getContentWidth(width, paddingX))),
		width,
		paddingX,
	);
}

/** Render keyboard guidance with a visible key and a readable action label. */
export function renderKeyHints(
	hints: readonly KeyHint[],
	styles?: TuiStyles,
	theme?: TuiTheme,
): string {
	const resolvedStyles = stylesFor(styles, theme);
	return hints.map((hint) => renderHint(hint, resolvedStyles)).join("  ");
}

/**
 * Render footer chrome. A hint row always has at least one blank row after it,
 * preventing keyboard guidance from touching the terminal edge.
 */
export function renderFooter({
	width,
	lines = [],
	hints = [],
	divider = true,
	dividerCharacter = "─",
	paddingX = 1,
	padding = hints.length > 0 ? 1 : 0,
	styles: providedStyles,
	theme,
}: FooterOptions): string[] {
	const styles = stylesFor(providedStyles, theme);
	const rendered: string[] = [];
	if (divider)
		rendered.push(renderDivider({ width, character: dividerCharacter, paddingX, styles }));
	rendered.push(...lines.map((line) => insetLine(styles.footer(line), width, paddingX)));
	if (hints.length > 0) {
		const hintText = renderKeyHints(hints, styles);
		const contentWidth = Math.max(1, getContentWidth(width, paddingX));
		rendered.push(
			...wrapTextWithAnsi(hintText, contentWidth).map((line) => insetLine(line, width, paddingX)),
		);
	}
	const requestedPadding = boundedSize(padding);
	const requiredPadding = hints.length > 0 ? Math.max(1, requestedPadding) : requestedPadding;
	rendered.push(...Array.from({ length: requiredPadding }, () => fillLine("", width)));
	return rendered;
}

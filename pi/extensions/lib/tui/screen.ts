import { frameScreen, insetLine, type ScreenFrameOptions } from "./lines.ts";
import {
	renderFooter,
	renderHeader,
	type FooterOptions,
	type HeaderOptions,
	type KeyHint,
} from "./chrome.ts";
import type { TuiStyles, TuiTheme } from "./theme.ts";

export interface FullscreenScreenOptions extends Omit<ScreenFrameOptions, "header" | "footer"> {
	title: string;
	paddingX?: number;
	/** Horizontal inset for body lines; defaults to paddingX. */
	bodyPaddingX?: number;
	subtitle?: string;
	headerLines?: readonly string[];
	body?: readonly string[];
	footerLines?: readonly string[];
	keyHints?: readonly KeyHint[];
	divider?: boolean;
	dividerCharacter?: string;
	footerPadding?: number;
	styles?: TuiStyles;
	theme?: TuiTheme;
}

/** Compose standard chrome and frame a state-driven full-screen view. */
export function renderFullscreenScreen(options: FullscreenScreenOptions): string[] {
	const paddingX = options.paddingX ?? 1;
	const bodyPaddingX = options.bodyPaddingX ?? paddingX;
	const headerOptions: HeaderOptions = {
		width: options.width,
		title: options.title,
		subtitle: options.subtitle,
		paddingX,
		lines: options.headerLines,
		divider: options.divider,
		dividerCharacter: options.dividerCharacter,
		styles: options.styles,
		theme: options.theme,
	};
	const footerOptions: FooterOptions = {
		width: options.width,
		lines: options.footerLines,
		hints: options.keyHints,
		paddingX,
		divider: options.divider,
		dividerCharacter: options.dividerCharacter,
		padding: options.footerPadding,
		styles: options.styles,
		theme: options.theme,
	};
	return frameScreen({
		width: options.width,
		height: options.height,
		header: renderHeader(headerOptions),
		body: options.body?.map((line) => insetLine(line, options.width, bodyPaddingX)),
		footer: renderFooter(footerOptions),
	});
}

/** Short alias for composition sites that already establish full-screen context. */
export const renderScreen = renderFullscreenScreen;

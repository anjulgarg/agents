/** The small part of Pi's theme API used by the shared TUI primitives. */
export interface TuiTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

export interface TuiStyles {
	title(text: string): string;
	header(text: string): string;
	metadata(text: string): string;
	divider(text: string): string;
	footer(text: string): string;
	hintKey(text: string): string;
	hintLabel(text: string): string;
	selected(text: string): string;
}

/**
 * Keep shared chrome visually quiet and meaningful. Callers can provide their
 * own styles when a screen has a genuine state-specific emphasis.
 */
export function createTuiStyles(theme?: TuiTheme): TuiStyles {
	const color = (name: string, text: string): string => theme?.fg(name, text) ?? text;
	const bold = (text: string): string => theme?.bold?.(text) ?? text;
	return {
		title: (text) => color("accent", bold(text)),
		header: (text) => color("text", text),
		metadata: (text) => color("muted", text),
		divider: (text) => color("borderMuted", text),
		footer: (text) => color("dim", text),
		hintKey: (text) => color("dim", text),
		hintLabel: (text) => color("muted", text),
		selected: (text) => color("accent", text),
	};
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export const CONVERSATION_SEPARATOR_ENTRY_TYPE = "conversation-separator";
const FAINT_ON = "\x1b[2m";
const FAINT_OFF = "\x1b[22m";

class ConversationSeparator implements Component {
	constructor(private readonly color: (text: string) => string) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const padding = width > 2 ? " " : "";
		return [`${padding}${this.color("─".repeat(width - padding.length))}`];
	}

	invalidate(): void {}
}

export default function conversationSeparator(pi: ExtensionAPI): void {
	let pending: ReturnType<typeof setTimeout> | undefined;

	pi.registerEntryRenderer(
		CONVERSATION_SEPARATOR_ENTRY_TYPE,
		(_entry, _options, theme) =>
			new ConversationSeparator(
				(text) => `${FAINT_ON}${theme.fg("borderMuted", text)}${FAINT_OFF}`,
			),
	);

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (pending) clearTimeout(pending);
		pending = setTimeout(() => {
			pending = undefined;
			if (ctx.isIdle()) pi.appendEntry(CONVERSATION_SEPARATOR_ENTRY_TYPE);
		}, 0);
	});

	pi.on("session_shutdown", () => {
		if (pending) clearTimeout(pending);
		pending = undefined;
	});
}

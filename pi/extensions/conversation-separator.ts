import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	isHiddenSubagentWakeEntry,
	isNoopAssistantEntry,
	sessionEntries,
} from "./subagent/wake-turn.ts";

export const CONVERSATION_SEPARATOR_ENTRY_TYPE = "conversation-separator";
const FAINT_ON = "\x1b[2m";
const FAINT_OFF = "\x1b[22m";

class ConversationSeparator implements Component {
	constructor(
		private readonly color: (text: string) => string,
		private readonly hidden = false,
	) {}

	render(width: number): string[] {
		if (this.hidden || width <= 0) return [];
		const padding = width > 2 ? " " : "";
		return [`${padding}${this.color("─".repeat(width - padding.length))}`];
	}

	invalidate(): void {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function isSilentSubagentWakeTurn(entries: unknown[], endIndex = entries.length): boolean {
	for (let index = endIndex - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isRecord(entry)) continue;
		if (isHiddenSubagentWakeEntry(entry)) return true;
		if (entry.type === "custom") continue;
		if (entry.type === "custom_message") {
			if (entry.display === false) continue;
			return false;
		}
		if (entry.type !== "message" || !isRecord(entry.message)) return false;
		if (entry.message.role === "toolResult") continue;
		if (entry.message.role !== "assistant" || !isNoopAssistantEntry(entry)) return false;
	}
	return false;
}

function hiddenSilentSeparatorIds(entries: unknown[]): Set<string> {
	const hidden = new Set<string>();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (
			isRecord(entry) &&
			entry.type === "custom" &&
			entry.customType === CONVERSATION_SEPARATOR_ENTRY_TYPE &&
			typeof entry.id === "string" &&
			isSilentSubagentWakeTurn(entries, index)
		)
			hidden.add(entry.id);
	}
	return hidden;
}

export default function conversationSeparator(pi: ExtensionAPI): void {
	let pending: ReturnType<typeof setTimeout> | undefined;
	let hiddenSeparatorIds = new Set<string>();

	pi.registerEntryRenderer(
		CONVERSATION_SEPARATOR_ENTRY_TYPE,
		(entry, _options, theme) =>
			new ConversationSeparator(
				(text) => `${FAINT_ON}${theme.fg("borderMuted", text)}${FAINT_OFF}`,
				typeof entry.id === "string" && hiddenSeparatorIds.has(entry.id),
			),
	);

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui" || isSilentSubagentWakeTurn(sessionEntries(ctx))) return;
		if (pending) clearTimeout(pending);
		pending = setTimeout(() => {
			pending = undefined;
			if (ctx.isIdle()) pi.appendEntry(CONVERSATION_SEPARATOR_ENTRY_TYPE);
		}, 0);
	});

	pi.on("session_start", (_event, ctx) => {
		hiddenSeparatorIds = hiddenSilentSeparatorIds(sessionEntries(ctx));
	});

	pi.on("session_shutdown", () => {
		if (pending) clearTimeout(pending);
		pending = undefined;
		hiddenSeparatorIds.clear();
	});
}

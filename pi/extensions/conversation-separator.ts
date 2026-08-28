import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { isNoopSubagentWakeAssistant, sessionEntries } from "./subagent/wake-turn.ts";

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

function latestTurnIsNoopSubagentWake(entries: unknown[]): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const candidate = entries[index];
		if (!isRecord(candidate) || candidate.type === "custom") continue;
		if (candidate.type !== "message") return false;
		return isNoopSubagentWakeAssistant(entries, index);
	}
	return false;
}

function hiddenNoopSeparatorIds(entries: unknown[]): Set<string> {
	const hidden = new Set<string>();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (
			!isRecord(entry) ||
			entry.type !== "custom" ||
			entry.customType !== CONVERSATION_SEPARATOR_ENTRY_TYPE ||
			typeof entry.id !== "string"
		)
			continue;
		for (let before = index - 1; before >= 0; before--) {
			const candidate = entries[before];
			if (!isRecord(candidate) || candidate.type === "custom") continue;
			if (isNoopSubagentWakeAssistant(entries, before)) hidden.add(entry.id);
			break;
		}
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
		if (ctx.mode !== "tui" || latestTurnIsNoopSubagentWake(sessionEntries(ctx))) return;
		if (pending) clearTimeout(pending);
		pending = setTimeout(() => {
			pending = undefined;
			if (ctx.isIdle()) pi.appendEntry(CONVERSATION_SEPARATOR_ENTRY_TYPE);
		}, 0);
	});

	pi.on("session_start", (_event, ctx) => {
		hiddenSeparatorIds = hiddenNoopSeparatorIds(sessionEntries(ctx));
	});

	pi.on("session_shutdown", () => {
		if (pending) clearTimeout(pending);
		pending = undefined;
		hiddenSeparatorIds.clear();
	});
}

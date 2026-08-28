import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { SUBAGENT_WAKE_MESSAGE_TYPE } from "./contracts.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

export function sessionEntries(ctx: ExtensionContext): unknown[] {
	const manager = ctx.sessionManager as unknown as
		{ getBranch?: () => unknown[]; getEntries?: () => unknown[] } | undefined;
	const entries = manager?.getBranch?.() ?? manager?.getEntries?.() ?? [];
	return Array.isArray(entries) ? entries : [];
}

export function isHiddenSubagentWakeEntry(entry: unknown): boolean {
	if (!isRecord(entry)) return false;
	if (entry.type === "custom_message") {
		return entry.customType === SUBAGENT_WAKE_MESSAGE_TYPE && entry.display === false;
	}
	if (entry.type === "message" && isRecord(entry.message)) {
		return (
			entry.message.role === "custom" &&
			entry.message.customType === SUBAGENT_WAKE_MESSAGE_TYPE &&
			entry.message.display === false
		);
	}
	return false;
}

export function isNoopAssistantEntry(entry: unknown): boolean {
	if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return false;
	if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return false;
	const text = entry.message.content
		.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text")
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("\n")
		.trim();
	return text === "" || text === "(blank)";
}

/** Whether the current parent turn was triggered by a hidden subagent wake. */
export function isHiddenSubagentWakeTurn(ctx: ExtensionContext): boolean {
	const entries = sessionEntries(ctx);
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isRecord(entry)) continue;
		if (isHiddenSubagentWakeEntry(entry)) return true;
		if (entry.type === "message" || entry.type === "custom_message") return false;
		if (entry.type === "compaction" || entry.type === "branch_summary") return false;
	}
	return false;
}

/** Whether an assistant entry directly answers a hidden wake without intervening context. */
export function isNoopSubagentWakeAssistant(entries: unknown[], assistantIndex: number): boolean {
	if (!isNoopAssistantEntry(entries[assistantIndex])) return false;
	for (let index = assistantIndex - 1; index >= 0; index--) {
		const candidate = entries[index];
		if (!isRecord(candidate) || candidate.type === "custom") continue;
		return isHiddenSubagentWakeEntry(candidate);
	}
	return false;
}

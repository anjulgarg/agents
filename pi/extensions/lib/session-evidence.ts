import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const ANNOUNCEMENT_UPDATE_ENTRY_TYPE = "announce-step-duration-update";
const DEFAULT_MAX_EVENT_CHARS = 4_000;
const OMISSION_RESERVE = 100;

export interface SessionEvidenceEvent {
	entryId: string;
	text: string;
}

interface AnnouncementData {
	completed?: unknown;
	step?: unknown;
	toolCount?: unknown;
	changedFiles?: unknown;
}

function positiveLimit(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

function compactText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateMiddle(value: string, limit: number): string {
	if (limit <= 0) return "";
	if (value.length <= limit) return value;
	if (limit <= 3) return value.slice(0, limit);
	const suffixLength = Math.max(1, Math.floor((limit - 3) / 4));
	const prefixLength = limit - suffixLength - 3;
	return `${value.slice(0, prefixLength)}...${value.slice(-suffixLength)}`;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return compactText(content);
	if (!Array.isArray(content)) return "";
	return compactText(
		content
			.filter(
				(part): part is { type: "text"; text: string } =>
					!!part &&
					typeof part === "object" &&
					(part as { type?: unknown }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			)
			.map((part) => part.text)
			.join("\n"),
	);
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function announcementText(data: AnnouncementData): string | undefined {
	if (data.completed !== true || typeof data.step !== "string" || !data.step.trim()) {
		return undefined;
	}
	const details: string[] = [];
	const toolCount = count(data.toolCount);
	const changedFiles = Array.isArray(data.changedFiles) ? data.changedFiles.length : 0;
	if (toolCount) details.push(`${toolCount} ${toolCount === 1 ? "tool" : "tools"}`);
	if (changedFiles) {
		details.push(`${changedFiles} ${changedFiles === 1 ? "file" : "files"} changed`);
	}
	return `WORK: ${compactText(data.step)}${details.length ? ` (${details.join(", ")})` : ""}`;
}

function toolSummary(counts: Map<string, number>): string | undefined {
	if (counts.size === 0) return undefined;
	return `TOOLS: ${[...counts].map(([name, total]) => `${name} x${total}`).join(", ")}`;
}

/**
 * Neutral high-signal session evidence: user text, completed/length-terminated
 * assistant text, aggregated tool-call counts, and completed announce-step
 * duration updates. Feature-specific custom entries (recap, btw, etc.) are ignored.
 */
export function extractSessionEvidence(
	entries: SessionEntry[],
	options?: { maxEventChars?: number },
): SessionEvidenceEvent[] {
	const maxEventChars = positiveLimit(options?.maxEventChars, DEFAULT_MAX_EVENT_CHARS);
	const events: SessionEvidenceEvent[] = [];
	const pendingTools = new Map<string, number>();
	let pendingToolEntryId: string | undefined;
	const pushEvent = (entryId: string, text: string): void => {
		events.push({ entryId, text: truncateMiddle(text, maxEventChars) });
	};

	const flushTools = (fallbackEntryId?: string): void => {
		const text = toolSummary(pendingTools);
		const entryId = pendingToolEntryId ?? fallbackEntryId;
		if (text && entryId) pushEvent(entryId, text);
		pendingTools.clear();
		pendingToolEntryId = undefined;
	};

	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "user") {
			flushTools(entry.id);
			const text = messageText(entry.message.content);
			if (text) pushEvent(entry.id, `USER: ${text}`);
			continue;
		}

		if (entry.type === "message" && entry.message.role === "assistant") {
			for (const part of entry.message.content) {
				if (part.type !== "toolCall") continue;
				pendingTools.set(part.name, (pendingTools.get(part.name) ?? 0) + 1);
				pendingToolEntryId = entry.id;
			}
			if (entry.message.stopReason === "stop" || entry.message.stopReason === "length") {
				flushTools(entry.id);
				const text = messageText(entry.message.content);
				if (text) pushEvent(entry.id, `AGENT: ${text}`);
			}
			continue;
		}

		if (entry.type === "custom" && entry.customType === ANNOUNCEMENT_UPDATE_ENTRY_TYPE) {
			const text = announcementText((entry.data ?? {}) as AnnouncementData);
			if (text) pushEvent(entry.id, text);
		}
	}

	flushTools(entries.at(-1)?.id);
	return events;
}

/**
 * Join evidence under an aggregate character bound, preserving the first and
 * newest events and inserting an omission marker for filtered middle events.
 * Non-positive maxChars yields an empty string.
 */
export function boundSessionEvidence(events: SessionEvidenceEvent[], maxChars: number): string {
	if (!(typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0)) {
		return "";
	}
	const limit = Math.floor(maxChars);
	const lines = events.map((event) => event.text);
	if (lines.length === 0) return "";

	const full = lines.join("\n");
	if (full.length <= limit) return full;

	const first = lines[0] ?? "";
	const kept: string[] = [];
	let used = first.length + OMISSION_RESERVE;
	for (let index = lines.length - 1; index > 0; index--) {
		const line = lines[index];
		if (used + line.length + 1 > limit) break;
		kept.unshift(line);
		used += line.length + 1;
	}
	const omitted = Math.max(0, lines.length - kept.length - 1);
	const bounded = [
		first,
		`[${omitted} middle filtered events omitted for input limit]`,
		...kept,
	].join("\n");
	return truncateMiddle(bounded, limit);
}

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	boundSessionEvidence,
	extractSessionEvidence,
	type SessionEvidenceEvent,
} from "../lib/session-evidence.ts";

export const RECAP_ENTRY_TYPE = "session-recap";
const MAX_EVENT_CHARS = 4_000;
const MAX_SOURCE_CHARS = 32_000;
const MAX_PREVIOUS_RECAP_CHARS = 6_000;

export interface RecapUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	model?: string;
	effort?: string;
}

export interface RecapState {
	v: 1;
	recap: string;
	cursorEntryId: string;
	generatedAt: number;
	usage?: RecapUsage;
}

/** Recap-facing alias for shared session evidence events. */
export type RecapEvent = SessionEvidenceEvent;

export interface RecapPreparation {
	previous?: RecapState;
	cursorEntryId?: string;
	events: RecapEvent[];
}

function truncateMiddle(value: string, limit = MAX_EVENT_CHARS): string {
	if (value.length <= limit) return value;
	const suffixLength = Math.floor(limit / 4);
	const prefixLength = limit - suffixLength - 3;
	return `${value.slice(0, prefixLength)}...${value.slice(-suffixLength)}`;
}

function isUsage(data: unknown): data is RecapUsage {
	const usage = data as Partial<RecapUsage> | undefined;
	return (
		!!usage &&
		[usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost].every(
			(value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
		) &&
		(usage.model === undefined || typeof usage.model === "string") &&
		(usage.effort === undefined || typeof usage.effort === "string")
	);
}

const RECAP_SECTIONS = [
	"Started With",
	"Evolution",
	"Current Focus",
	"Progress",
	"Remaining",
] as const;

function headingLabel(line: string): string | undefined {
	const match = line.trim().match(/^#{1,6}\s+(.+?)\s*#*$/);
	return match?.[1]?.trim();
}

/** Reject provider echoes and malformed generations before they can become recap state. */
export function isValidRecapMarkdown(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const lines = value.trim().split(/\r?\n/);
	if (headingLabel(lines[0] ?? "") !== "Session Recap") return false;

	let previousIndex = 0;
	for (const section of RECAP_SECTIONS) {
		const index = lines.findIndex(
			(line, candidateIndex) => candidateIndex > previousIndex && headingLabel(line) === section,
		);
		if (index < 0) return false;
		const nextHeading = lines.findIndex(
			(line, candidateIndex) => candidateIndex > index && headingLabel(line) !== undefined,
		);
		const sectionEnd = nextHeading < 0 ? lines.length : nextHeading;
		if (!lines.slice(index + 1, sectionEnd).some((line) => line.trim().length > 0)) return false;
		previousIndex = index;
	}
	return true;
}

function isRecapState(data: unknown): data is RecapState {
	const state = data as Partial<RecapState> | undefined;
	return (
		state?.v === 1 &&
		isValidRecapMarkdown(state.recap) &&
		typeof state.cursorEntryId === "string" &&
		typeof state.generatedAt === "number" &&
		(state.usage === undefined || isUsage(state.usage))
	);
}

export function findLatestRecap(entries: SessionEntry[]): RecapState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (
			entry.type === "custom" &&
			entry.customType === RECAP_ENTRY_TYPE &&
			isRecapState(entry.data)
		) {
			return entry.data;
		}
	}
	return undefined;
}

/** @deprecated Prefer the neutral extractSessionEvidence helper for new consumers. */
export function extractRecapEvents(entries: SessionEntry[]): RecapEvent[] {
	return extractSessionEvidence(entries, { maxEventChars: MAX_EVENT_CHARS });
}

function evidenceFor(entries: SessionEntry[]): RecapEvent[] {
	return extractRecapEvents(entries);
}

export function prepareRecap(entries: SessionEntry[]): RecapPreparation {
	const cursorEntryId = entries.at(-1)?.id;
	const previous = findLatestRecap(entries);
	if (!previous) return { cursorEntryId, events: evidenceFor(entries) };
	const cursorIndex = entries.findIndex((entry) => entry.id === previous.cursorEntryId);
	if (cursorIndex < 0) return { cursorEntryId, events: evidenceFor(entries) };
	return {
		previous,
		cursorEntryId,
		events: evidenceFor(entries.slice(cursorIndex + 1)),
	};
}

export function buildRecapInput(preparation: RecapPreparation): string {
	const source = boundSessionEvidence(preparation.events, MAX_SOURCE_CHARS);
	if (!preparation.previous) return `SESSION EVENTS\n${source}`;
	return [
		"PREVIOUS RECAP",
		truncateMiddle(preparation.previous.recap, MAX_PREVIOUS_RECAP_CHARS),
		"NEW SESSION EVENTS",
		source,
	].join("\n");
}

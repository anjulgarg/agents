import type { RpcEvent } from "./rpc-client.ts";

export type SignalKind =
	"STUCK_IN_TOOL" | "SILENCE" | "ERROR_STREAK" | "REPETITION" | "BUDGET" | "NO_PROGRESS";

/** Severity order: most severe first. */
const SEVERITY: SignalKind[] = [
	"STUCK_IN_TOOL",
	"SILENCE",
	"ERROR_STREAK",
	"REPETITION",
	"BUDGET",
	"NO_PROGRESS",
];

const DEFAULT_SILENCE_MS = 120_000;
const DEFAULT_REPEAT_THRESHOLD = 3;
const DEFAULT_ERROR_STREAK_THRESHOLD = 3;
/** Alone, NO_PROGRESS is too noisy; only emit solo past this turn count. */
const NO_PROGRESS_SOLO_TURNS = 10;

export interface StuckDetectorOptions {
	budgetUsd?: number;
	silenceMs?: number;
	repeatThreshold?: number;
	errorStreakThreshold?: number;
}

export interface RecentToolActivity {
	toolCallId: string;
	name: string;
	args: string;
	status: "running" | "succeeded" | "failed";
}

export interface DiagnosisFacts {
	silentMs: number;
	turns: number;
	costUsd: number;
	lastToolName?: string;
	lastToolArgs?: unknown;
	openToolName?: string;
	openToolId?: string;
	openToolMs?: number;
	repeatCount?: number;
	repeatFingerprint?: string;
	errorStreak?: number;
	budgetUsd?: number;
	hasEditOrWrite: boolean;
	toolCalls: number;
	succeededTools: number;
	failedTools: number;
	changedFiles: string[];
	recentTools: RecentToolActivity[];
}

export interface Diagnosis {
	/** Signal kinds that tripped, most severe first. */
	kind: SignalKind[];
	/**
	 * False when the child is blocked inside a tool call: a steer will never be
	 * delivered (per pi RPC: steer arrives after the current turn's tools finish).
	 * Only abort works in that case.
	 */
	steerable: boolean;
	/** One terse line for the parent; never a transcript. */
	summary: string;
	facts: DiagnosisFacts;
}

interface OpenTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	startedAt: number;
	activity: RecentToolActivity;
}

interface ActiveSignal {
	kind: SignalKind;
	/** Metric used for latch / 2x-worse comparison. */
	metric: number;
}

/**
 * Pure stuck detector: events in, diagnoses out. Caller supplies `now`.
 * Zero tokens -- mechanical watchdog over the child's RPC event stream.
 */
export class StuckDetector {
	private readonly silenceMs: number;
	private readonly repeatThreshold: number;
	private readonly errorStreakThreshold: number;
	private budgetUsd: number | undefined;

	private lastEventAt = 0;
	private started = false;
	private turns = 0;
	private costUsd = 0;
	private errorStreak = 0;
	private hasEditOrWrite = false;
	private toolCalls = 0;
	private succeededTools = 0;
	private failedTools = 0;
	private lastToolName?: string;
	private lastToolArgs?: unknown;

	private readonly openTools = new Map<string, OpenTool>();
	private readonly fingerprints = new Map<string, number>();
	private readonly changedFiles = new Set<string>();
	private readonly recentTools: RecentToolActivity[] = [];

	/** Latched metric per signal kind from the last emitted diagnosis. */
	private readonly latched = new Map<SignalKind, number>();
	private snoozedUntil = 0;

	constructor(options: StuckDetectorOptions = {}) {
		this.silenceMs = options.silenceMs ?? DEFAULT_SILENCE_MS;
		this.repeatThreshold = options.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD;
		this.errorStreakThreshold = options.errorStreakThreshold ?? DEFAULT_ERROR_STREAK_THRESHOLD;
		this.budgetUsd = options.budgetUsd;
	}

	observe(event: RpcEvent, now: number): void {
		this.started = true;
		this.lastEventAt = now;

		switch (event.type) {
			case "tool_execution_start": {
				const toolCallId = String(event.toolCallId ?? "");
				const toolName = String(event.toolName ?? "");
				const args = event.args;
				this.toolCalls++;
				this.lastToolName = toolName;
				this.lastToolArgs = args;
				if (toolName === "edit" || toolName === "write") {
					this.hasEditOrWrite = true;
					const changedPath = filePathFromArgs(args);
					if (changedPath) this.changedFiles.add(changedPath);
				}
				const activity: RecentToolActivity = {
					toolCallId,
					name: toolName,
					args: formatArgsBrief(args),
					status: "running",
				};
				this.recentTools.push(activity);
				if (this.recentTools.length > 6) this.recentTools.shift();
				if (toolCallId) {
					this.openTools.set(toolCallId, { toolCallId, toolName, args, startedAt: now, activity });
				}
				const fp = fingerprint(toolName, args);
				this.fingerprints.set(fp, (this.fingerprints.get(fp) ?? 0) + 1);
				break;
			}
			case "tool_execution_end": {
				const toolCallId = String(event.toolCallId ?? "");
				const openTool = toolCallId ? this.openTools.get(toolCallId) : undefined;
				if (toolCallId) this.openTools.delete(toolCallId);
				const toolName = String(event.toolName ?? openTool?.toolName ?? this.lastToolName ?? "");
				this.lastToolName = toolName;
				if (event.isError === true) {
					this.errorStreak++;
					this.failedTools++;
					if (openTool) openTool.activity.status = "failed";
				} else {
					this.errorStreak = 0;
					this.succeededTools++;
					if (openTool) openTool.activity.status = "succeeded";
				}
				break;
			}
			case "message_end": {
				const message = event.message as
					{ role?: string; usage?: { cost?: { total?: number } } } | undefined;
				if (!message || message.role !== "assistant") break;
				this.turns++;
				const total = message.usage?.cost?.total;
				if (typeof total === "number" && Number.isFinite(total)) {
					this.costUsd += total;
				}
				break;
			}
			default:
				break;
		}
	}

	/** Objective activity facts for status displays; never classifies a task as idle. */
	activity(now: number): DiagnosisFacts | undefined {
		return this.started ? this.buildFacts(now) : undefined;
	}

	/** Currently active watchdog evidence without changing diagnosis latches. */
	activeSignals(now: number): SignalKind[] {
		return this.started ? sortBySeverity(this.collectActive(now).map((signal) => signal.kind)) : [];
	}

	evaluate(now: number): Diagnosis | undefined {
		if (!this.started) return undefined;
		if (now < this.snoozedUntil) return undefined;

		const active = this.collectActive(now);
		if (active.length === 0) return undefined;

		const emit = active.filter((s) => {
			const prev = this.latched.get(s.kind);
			if (prev === undefined) return true;
			return s.metric >= prev * 2;
		});
		if (emit.length === 0) return undefined;

		const kinds = sortBySeverity(emit.map((s) => s.kind));
		for (const s of emit) this.latched.set(s.kind, s.metric);
		// Also latch any co-reported kinds that didn't independently worsen,
		// so we don't drip-feed them alone next tick.
		for (const s of active) {
			if (!this.latched.has(s.kind)) this.latched.set(s.kind, s.metric);
		}

		const facts = this.buildFacts(now);
		return {
			kind: kinds,
			steerable: !kinds.includes("STUCK_IN_TOOL"),
			summary: buildSummary(facts, kinds),
			facts,
		};
	}

	/**
	 * Acknowledge current diagnosis: snooze signals and optionally raise the
	 * budget ceiling. After snooze lapses, signals re-arm at base thresholds.
	 */
	ack(now: number, options?: { extendBudgetUsd?: number; snoozeMs?: number }): void {
		this.latched.clear();
		this.snoozedUntil = now + (options?.snoozeMs ?? 0);
		if (options?.extendBudgetUsd !== undefined) {
			const base = this.budgetUsd ?? 0;
			this.budgetUsd = base + options.extendBudgetUsd;
		}
	}

	private collectActive(now: number): ActiveSignal[] {
		const silentMs = now - this.lastEventAt;
		const signals: ActiveSignal[] = [];

		let worstOpen: OpenTool | undefined;
		let worstOpenMs = 0;
		for (const tool of this.openTools.values()) {
			const openMs = now - tool.startedAt;
			if (openMs >= this.silenceMs && openMs >= worstOpenMs) {
				worstOpen = tool;
				worstOpenMs = openMs;
			}
		}
		if (worstOpen) {
			signals.push({ kind: "STUCK_IN_TOOL", metric: worstOpenMs });
		}

		if (silentMs >= this.silenceMs) {
			signals.push({ kind: "SILENCE", metric: silentMs });
		}

		if (this.errorStreak >= this.errorStreakThreshold) {
			signals.push({ kind: "ERROR_STREAK", metric: this.errorStreak });
		}

		let bestRepeat = 0;
		for (const count of this.fingerprints.values()) {
			if (count > bestRepeat) bestRepeat = count;
		}
		if (bestRepeat >= this.repeatThreshold) {
			signals.push({ kind: "REPETITION", metric: bestRepeat });
		}

		if (this.budgetUsd !== undefined && this.costUsd > this.budgetUsd) {
			signals.push({ kind: "BUDGET", metric: this.costUsd });
		}

		const noProgress = !this.hasEditOrWrite && this.turns > 0;
		if (noProgress) {
			const hasOther = signals.length > 0;
			if (hasOther || this.turns >= NO_PROGRESS_SOLO_TURNS) {
				signals.push({ kind: "NO_PROGRESS", metric: this.turns });
			}
		}

		return signals;
	}

	private buildFacts(now: number): DiagnosisFacts {
		const silentMs = now - this.lastEventAt;
		let openTool: OpenTool | undefined;
		let openToolMs: number | undefined;
		for (const tool of this.openTools.values()) {
			const ms = now - tool.startedAt;
			if (openToolMs === undefined || ms > openToolMs) {
				openTool = tool;
				openToolMs = ms;
			}
		}

		let repeatCount: number | undefined;
		let repeatFingerprint: string | undefined;
		for (const [fp, count] of this.fingerprints) {
			if (count >= this.repeatThreshold && (repeatCount === undefined || count > repeatCount)) {
				repeatCount = count;
				repeatFingerprint = fp;
			}
		}

		return {
			silentMs,
			turns: this.turns,
			costUsd: this.costUsd,
			lastToolName: this.lastToolName,
			lastToolArgs: this.lastToolArgs,
			openToolName: openTool?.toolName,
			openToolId: openTool?.toolCallId,
			openToolMs,
			repeatCount,
			repeatFingerprint,
			errorStreak: this.errorStreak > 0 ? this.errorStreak : undefined,
			budgetUsd: this.budgetUsd,
			hasEditOrWrite: this.hasEditOrWrite,
			toolCalls: this.toolCalls,
			succeededTools: this.succeededTools,
			failedTools: this.failedTools,
			changedFiles: [...this.changedFiles],
			recentTools: this.recentTools.map((tool) => ({ ...tool })),
		};
	}
}

export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function fingerprint(toolName: string, args: unknown): string {
	return `${toolName}:${stableStringify(args)}`;
}

function sortBySeverity(kinds: SignalKind[]): SignalKind[] {
	return [...kinds].sort((a, b) => SEVERITY.indexOf(a) - SEVERITY.indexOf(b));
}

function formatDuration(ms: number): string {
	if (ms >= 60_000) {
		const m = Math.floor(ms / 60_000);
		const s = Math.floor((ms % 60_000) / 1000);
		return s > 0 ? `${m}m${s}s` : `${m}m`;
	}
	if (ms >= 1000) return `${Math.floor(ms / 1000)}s`;
	return `${ms}ms`;
}

function filePathFromArgs(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const object = args as Record<string, unknown>;
	for (const key of ["path", "file_path"]) {
		if (typeof object[key] === "string" && object[key]) return object[key];
	}
	return undefined;
}

function formatArgsBrief(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "object" && !Array.isArray(args)) {
		const obj = args as Record<string, unknown>;
		if (typeof obj.command === "string") return obj.command;
		if (typeof obj.path === "string") return obj.path;
		if (typeof obj.file_path === "string") return obj.file_path;
	}
	const raw = typeof args === "string" ? args : stableStringify(args);
	return raw.length > 40 ? `${raw.slice(0, 37)}...` : raw;
}

function buildSummary(facts: DiagnosisFacts, kinds: SignalKind[]): string {
	const parts: string[] = [];

	if (kinds.includes("STUCK_IN_TOOL") && facts.openToolName) {
		const dur = formatDuration(facts.openToolMs ?? facts.silentMs);
		parts.push(`stuck in \`${facts.openToolName}\` ${dur}`);
	} else if (kinds.includes("SILENCE")) {
		parts.push(`silent ${formatDuration(facts.silentMs)}`);
	}

	if (kinds.includes("REPETITION") && facts.repeatCount !== undefined) {
		parts.push(`repeated ×${facts.repeatCount}`);
	}
	if (kinds.includes("ERROR_STREAK") && facts.errorStreak !== undefined) {
		parts.push(`errors ×${facts.errorStreak}`);
	}
	if (kinds.includes("BUDGET")) {
		parts.push(`budget $${facts.costUsd.toFixed(2)}`);
	}
	if (kinds.includes("NO_PROGRESS")) {
		parts.push("no file mutation calls (may be read-only)");
	}

	if (facts.lastToolName) {
		const brief = formatArgsBrief(facts.lastToolArgs);
		parts.push(
			brief
				? `last call \`${facts.lastToolName}: ${brief}\``
				: `last call \`${facts.lastToolName}\``,
		);
	}

	parts.push(`${facts.turns} turns`);
	parts.push(`$${facts.costUsd.toFixed(2)}`);

	return parts.join(", ");
}

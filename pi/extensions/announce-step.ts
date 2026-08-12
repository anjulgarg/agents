import {
	estimateTokens,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

export const WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const WORKING_FRAME_INTERVAL_MS = 120;

export const ACTIVITY_ENTRY_TYPE = "announce-step-activity";
export const WORKING_PHASE = "Working";

export type ActivityStatus = "completed" | "failed" | "aborted";

const LEGACY_ANNOUNCEMENT_ENTRY_TYPE = "announce-step-duration";
const LEGACY_ANNOUNCEMENT_UPDATE_ENTRY_TYPE = "announce-step-duration-update";
const ACTIVITY_STATUS_KEY = "working";
const CHAT_PADDING = 1;
const ACTIVITY_TIMER_INTERVAL_MS = 1000;
const MAX_CHANGED_FILES = 64;
const MAX_PATH_LENGTH = 240;
const MAX_TOOL_COUNT = 100_000;
const EDITING_TOOLS = new Set(["edit", "write"]);

interface TokenCounters {
	receivedTokens: number;
	currentReceivedEstimate: number;
}

interface SliceActivity {
	toolCount?: number;
	changedFiles?: string[];
}

interface AnnouncementEntry {
	runId: string;
	step: string;
	durationMs: number;
	completed?: boolean;
	receivedTokens?: number;
	toolCount?: number;
	changedFiles?: string[];
}

export interface ActivityEntry {
	phase: typeof WORKING_PHASE;
	durationMs: number;
	status: ActivityStatus;
	receivedTokens: number;
	toolCount: number;
	changedFiles: string[];
}

interface ActiveRun extends TokenCounters {
	startedAt: number;
	toolCount: number;
	changedFiles: Set<string>;
	seenToolIds: Set<string>;
	receiptAppended: boolean;
}

function displayStep(step: string): string {
	return `${step.trim().replace(/[.!?…]+$/, "")}...`;
}

function formatDuration(durationMs: number): string {
	const safeDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
	const totalSeconds = Math.floor(safeDuration / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds}s`;
}

function formatTokenCount(tokens: number): string {
	const rounded = Math.max(0, Math.round(Number.isFinite(tokens) ? tokens : 0));
	if (rounded < 1000) return String(rounded);
	if (rounded < 10_000) return `${(rounded / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${Math.round(rounded / 1000)}k`;
}

function countLabel(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function formatLiveSlice(
	step: string,
	durationMs: number,
	receivedTokens?: number,
	activity?: SliceActivity,
): string {
	const details = [formatDuration(durationMs)];
	if (activity?.toolCount !== undefined) {
		details.push(countLabel(Math.max(0, activity.toolCount), "tool", "tools"));
	}
	if (activity?.changedFiles !== undefined) {
		details.push(countLabel(activity.changedFiles.length, "file", "files"));
	}
	if (receivedTokens !== undefined && receivedTokens > 0) {
		details.push(`↓ ${formatTokenCount(receivedTokens)} tokens`);
	}
	return `${displayStep(step)} (${details.join(" · ")})`;
}

/** Format a compact activity line, retaining the legacy rendering shape. */
export function formatSlice(
	step: string,
	durationMs: number,
	receivedTokens?: number,
	activity?: SliceActivity,
): string {
	return formatLiveSlice(step, durationMs, receivedTokens, activity);
}

function createTokenCounters(): TokenCounters {
	return { receivedTokens: 0, currentReceivedEstimate: 0 };
}

function createActiveRun(startedAt: number): ActiveRun {
	return {
		startedAt,
		toolCount: 0,
		changedFiles: new Set(),
		seenToolIds: new Set(),
		receiptAppended: false,
		...createTokenCounters(),
	};
}

function tokenTotal(counters: TokenCounters): number {
	return counters.receivedTokens + counters.currentReceivedEstimate;
}

function safeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function messageOutputTokens(message: unknown): number | undefined {
	if (!message || typeof message !== "object") return undefined;
	const usage = (message as { usage?: { output?: unknown } }).usage;
	return safeNumber(usage?.output);
}

function estimateMessageTokens(message: unknown): number {
	try {
		const estimated = estimateTokens(message as never);
		return safeNumber(estimated) ?? 0;
	} catch {
		return 0;
	}
}

function boundedPath(path: unknown): string | undefined {
	if (typeof path !== "string") return undefined;
	const normalized = path.trim();
	if (!normalized) return undefined;
	return normalized.slice(0, MAX_PATH_LENGTH);
}

function pathFromToolEvent(toolName: unknown, args: unknown): string | undefined {
	if (!EDITING_TOOLS.has(typeof toolName === "string" ? toolName : "")) return undefined;
	if (!args || typeof args !== "object") return undefined;
	return boundedPath((args as { path?: unknown }).path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function safeWorkingMessage(context: ExtensionContext | undefined, message: string): void {
	if (!context || (context.mode !== "tui" && context.mode !== "rpc")) return;
	try {
		const themed = context.ui.theme?.fg("toolTitle", message) ?? message;
		if (context.mode === "tui") context.ui.setWorkingMessage(themed);
		else context.ui.setStatus(ACTIVITY_STATUS_KEY, themed);
	} catch {
		// Activity visibility must never interrupt the agent lifecycle.
	}
}

function clearWorkingMessage(context: ExtensionContext | undefined): void {
	if (!context || (context.mode !== "tui" && context.mode !== "rpc")) return;
	try {
		if (context.mode === "tui") context.ui.setWorkingMessage();
		else context.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
	} catch {
		// Stale or limited UI contexts are safe no-ops for passive activity.
	}
}

function legacyEntryData(entry: unknown): AnnouncementEntry | undefined {
	if (!isRecord(entry) || !isRecord(entry.data)) return undefined;
	return entry.data as unknown as AnnouncementEntry;
}

function activityEntryData(entry: unknown): ActivityEntry | undefined {
	if (!isRecord(entry) || !isRecord(entry.data)) return undefined;
	const data = entry.data as Record<string, unknown>;
	if (
		typeof data.durationMs !== "number" ||
		typeof data.status !== "string" ||
		!(["completed", "failed", "aborted"] as string[]).includes(data.status) ||
		typeof data.toolCount !== "number" ||
		!Array.isArray(data.changedFiles)
	)
		return undefined;
	return {
		phase: WORKING_PHASE,
		durationMs: Math.max(0, data.durationMs),
		status: data.status as ActivityStatus,
		receivedTokens: safeNumber(data.receivedTokens) ?? 0,
		toolCount: Math.max(0, data.toolCount),
		changedFiles: data.changedFiles.filter((path): path is string => typeof path === "string"),
	};
}

function isTerminalAssistantMessage(message: unknown): boolean {
	if (!isRecord(message)) return false;
	return message.stopReason === "stop" || message.stopReason === "length";
}

function sessionEntries(ctx: ExtensionContext): unknown[] {
	const manager = ctx.sessionManager as unknown as {
		getBranch?: () => unknown[];
		getEntries?: () => unknown[];
	};
	const entries = manager.getBranch?.() ?? manager.getEntries?.() ?? [];
	return Array.isArray(entries) ? entries : [];
}

function reconcileLegacyEntries(ctx: ExtensionContext): void {
	const entries = sessionEntries(ctx);
	const updates = new Map<string, AnnouncementEntry>();
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom") continue;
		if (entry.customType !== LEGACY_ANNOUNCEMENT_UPDATE_ENTRY_TYPE) continue;
		const data = legacyEntryData(entry);
		if (data?.runId) updates.set(data.runId, data);
	}
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom") continue;
		if (entry.customType !== LEGACY_ANNOUNCEMENT_ENTRY_TYPE) continue;
		const data = legacyEntryData(entry);
		const update = data?.runId ? updates.get(data.runId) : undefined;
		if (!data || !update) continue;
		try {
			Object.assign(data, update);
		} catch {
			// A malformed or frozen historical entry should remain renderable as-is.
		}
	}
}

export default function announceStepExtension(pi: ExtensionAPI): void {
	let activeRun: ActiveRun | undefined;
	let sliceTimer: ReturnType<typeof setInterval> | undefined;
	let workingContext: ExtensionContext | undefined;

	const stopSliceTimer = (): void => {
		if (sliceTimer !== undefined) clearInterval(sliceTimer);
		sliceTimer = undefined;
	};

	const updateWorkingLine = (now = Date.now()): void => {
		if (!activeRun) return;
		safeWorkingMessage(
			workingContext,
			formatLiveSlice(
				WORKING_PHASE,
				Math.max(0, now - activeRun.startedAt),
				tokenTotal(activeRun),
				{
					toolCount: activeRun.toolCount,
					changedFiles: [...activeRun.changedFiles],
				},
			),
		);
	};

	const startSliceTimer = (): void => {
		if (
			sliceTimer !== undefined ||
			!activeRun ||
			!workingContext ||
			(workingContext.mode !== "tui" && workingContext.mode !== "rpc")
		)
			return;
		sliceTimer = setInterval(() => {
			try {
				updateWorkingLine();
			} catch {
				// Timer updates are best-effort and must not surface as agent errors.
			}
		}, ACTIVITY_TIMER_INTERVAL_MS);
	};

	const ensureRun = (now: number): ActiveRun => {
		if (!activeRun) activeRun = createActiveRun(now);
		return activeRun;
	};

	const appendActivity = (run: ActiveRun, completedAt = Date.now()): void => {
		if (run.receiptAppended) return;
		run.receiptAppended = true;
		try {
			pi.appendEntry<ActivityEntry>(ACTIVITY_ENTRY_TYPE, {
				phase: WORKING_PHASE,
				durationMs: Math.max(0, completedAt - run.startedAt),
				status: "completed",
				receivedTokens: tokenTotal(run),
				toolCount: run.toolCount,
				changedFiles: [...run.changedFiles],
			});
		} catch {
			// A persistence failure must not turn passive tracking into a run failure.
		}
	};

	const finishActiveRun = (): void => {
		if (!activeRun) return;
		activeRun.seenToolIds.clear();
		activeRun = undefined;
	};

	const clearRuntime = (): void => {
		const context = workingContext;
		finishActiveRun();
		stopSliceTimer();
		clearWorkingMessage(context);
		workingContext = undefined;
	};

	pi.registerEntryRenderer<AnnouncementEntry>(
		LEGACY_ANNOUNCEMENT_ENTRY_TYPE,
		(entry, _options, theme) => {
			const data = entry.data;
			if (!data || typeof data.step !== "string" || typeof data.durationMs !== "number")
				return undefined;
			return {
				render(width: number): string[] {
					if (data.completed === false) return [];
					const receivedTokens =
						typeof data.receivedTokens === "number" ? data.receivedTokens : undefined;
					return new Text(
						theme.fg("muted", formatSlice(data.step, data.durationMs, receivedTokens, data)),
						CHAT_PADDING,
						0,
					).render(width);
				},
				invalidate() {},
			};
		},
	);
	pi.registerEntryRenderer<AnnouncementEntry>(
		LEGACY_ANNOUNCEMENT_UPDATE_ENTRY_TYPE,
		() => new Container(),
	);
	pi.registerEntryRenderer<ActivityEntry>(ACTIVITY_ENTRY_TYPE, (entry, _options, theme) => {
		const data = activityEntryData(entry);
		if (!data) return undefined;
		return {
			render(width: number): string[] {
				return new Text(
					theme.fg("muted", formatSlice(data.phase, data.durationMs, data.receivedTokens, data)),
					CHAT_PADDING,
					0,
				).render(width);
			},
			invalidate() {},
		};
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx) workingContext = ctx;
		const run = ensureRun(Date.now());
		const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
		if (toolCallId && run.seenToolIds.has(toolCallId)) return;
		if (toolCallId) run.seenToolIds.add(toolCallId);
		run.toolCount = Math.min(MAX_TOOL_COUNT, run.toolCount + 1);
		const path = pathFromToolEvent(event.toolName, event.args);
		if (path && run.changedFiles.size < MAX_CHANGED_FILES) run.changedFiles.add(path);
		updateWorkingLine();
		startSliceTimer();
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		if (!activeRun) return;
		if (ctx) workingContext = ctx;
		updateWorkingLine();
	});

	pi.on("before_provider_request", (_event, ctx) => {
		if (!activeRun) return;
		if (ctx) workingContext = ctx;
		activeRun.currentReceivedEstimate = 0;
		updateWorkingLine();
	});

	pi.on("agent_start", (_event, ctx) => {
		workingContext = ctx;
		ensureRun(Date.now());
		updateWorkingLine();
		startSliceTimer();
	});

	pi.on("message_update", (event, ctx) => {
		if (!activeRun || event.message.role !== "assistant") return;
		if (ctx) workingContext = ctx;
		const estimate = Math.max(
			activeRun.currentReceivedEstimate,
			messageOutputTokens(event.message) ?? estimateMessageTokens(event.message),
		);
		activeRun.currentReceivedEstimate = estimate;
		updateWorkingLine();
	});

	pi.on("message_end", (event, ctx) => {
		if (!activeRun || event.message.role !== "assistant") return;
		if (ctx) workingContext = ctx;
		const output = messageOutputTokens(event.message);
		activeRun.receivedTokens +=
			output ?? Math.max(activeRun.currentReceivedEstimate, estimateMessageTokens(event.message));
		activeRun.currentReceivedEstimate = 0;
		// Pi inserts custom entries emitted during message_end immediately before
		// the still-mounted streaming assistant component.
		if (isTerminalAssistantMessage(event.message)) appendActivity(activeRun);
		updateWorkingLine();
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!activeRun) return;
		if (ctx) workingContext = ctx;
		updateWorkingLine();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx) workingContext = ctx;
		clearRuntime();
	});

	pi.on("session_start", (_event, ctx) => {
		// Normally session_shutdown has already run. This guard also makes a
		// direct replacement event safe and prevents a stale timer from surviving.
		if (activeRun || sliceTimer !== undefined || workingContext) clearRuntime();
		reconcileLegacyEntries(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx) workingContext = ctx;
		clearRuntime();
	});
}

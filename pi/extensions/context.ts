/**
 * Context Extension - TUI inspector for active model context usage.
 *
 * `/context` opens a keyboard-accessible breakdown of system prompt, tool
 * definitions, conversation, and tool results against the model context window.
 * Inspects only compaction-aware active context (not the full historical branch).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	estimateTokens,
	sessionEntryToContextMessages,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

import {
	fullscreenOverlayOptions,
	getContentWidth,
	renderFullscreenScreen,
	ScrollViewportState,
} from "./lib/tui/index.ts";

/** Maximum capacity bar width to prevent it from stretching across ultra-wide terminals. */
const MAX_BAR_WIDTH = 76;

export type CategoryId = "system" | "tools" | "conversation" | "toolResults";

export const CATEGORY_PASTEL_COLORS: Record<CategoryId, number> = {
	system: 67, // muted blue
	tools: 137, // muted ochre
	conversation: 72, // muted sage
	toolResults: 132, // muted mauve
};

const RESET_FOREGROUND = "\x1b[39m";

export function colorCategory(theme: Theme, id: CategoryId | "remaining", text: string): string {
	if (id === "remaining") return theme.fg("dim", text);
	return `\x1b[38;5;${CATEGORY_PASTEL_COLORS[id]}m${text}${RESET_FOREGROUND}`;
}

export const CATEGORY_LABELS: Record<CategoryId | "remaining", string> = {
	system: "System",
	tools: "Tools",
	conversation: "Conversation",
	toolResults: "Tool results",
	remaining: "Free",
};

export interface LabeledTokens {
	label: string;
	tokens: number;
	detail?: string;
}

export interface ContextBreakdown {
	modelId: string | undefined;
	contextWindow: number | undefined;
	/** Provider/overall used tokens when known; null if unknown. */
	usedTokens: number | null;
	/** True when usedTokens came from getContextUsage (may still be estimated by Pi). */
	usedFromUsage: boolean;
	percent: number | null;
	system: { total: number; rows: LabeledTokens[] };
	tools: {
		total: number;
		activeCount: number;
		rows: LabeledTokens[];
		remainderCount: number;
		remainderTokens: number;
	};
	conversation: { total: number; turnCount: number };
	toolResults: {
		total: number;
		callCount: number;
		rows: LabeledTokens[];
		remainderCount: number;
		remainderTokens: number;
	};
}

const TOP_N = 5;
const BAR_FILL = "█";

/** chars/4 heuristic matching Pi's estimateTokens. */
export function estimateTextTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

export function formatTokenCount(tokens: number, approx = true): string {
	const n = Math.max(0, Math.round(tokens));
	const prefix = approx ? "≈" : "";
	if (n < 1000) return `${prefix}${n}`;
	if (n < 100_000) {
		const k = n / 1000;
		const body = k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, "")}k`;
		return `${prefix}${body}`;
	}
	if (n < 1_000_000) return `${prefix}${Math.round(n / 1000)}k`;
	const m = n / 1_000_000;
	const body = m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
	return `${prefix}${body}`;
}

export function formatPercent(percent: number | null): string {
	if (percent === null || !Number.isFinite(percent)) return "—";
	return `${Math.round(Math.min(100, Math.max(0, percent)))}%`;
}

/** Active tools only: intersect getAllTools metadata with getActiveTools names. */
export function filterActiveTools(allTools: ToolInfo[], activeNames: string[]): ToolInfo[] {
	const active = new Set(activeNames);
	return allTools.filter((t) => t && typeof t.name === "string" && active.has(t.name));
}

export function estimateToolDefinitionTokens(tool: ToolInfo): number {
	const parts: string[] = [tool.name ?? ""];
	if (typeof tool.description === "string") parts.push(tool.description);
	try {
		if (tool.parameters !== undefined) parts.push(JSON.stringify(tool.parameters));
	} catch {
		parts.push(String(tool.parameters));
	}
	// promptGuidelines are rendered into the system prompt, not the provider's
	// tool definition. estimateSystemBreakdown() already accounts for them.
	return estimateTextTokens(parts.join("\n"));
}

export function topNWithRemainder<T extends { tokens: number }>(
	items: T[],
	n = TOP_N,
): { top: T[]; remainderCount: number; remainderTokens: number } {
	const sorted = [...items].sort((a, b) => b.tokens - a.tokens);
	const top = sorted.slice(0, Math.max(0, n));
	const rest = sorted.slice(Math.max(0, n));
	return {
		top,
		remainderCount: rest.length,
		remainderTokens: rest.reduce((sum, item) => sum + item.tokens, 0),
	};
}

/**
 * Scale estimated section tokens so their relative mix is preserved but their
 * sum matches overallUsed when a finite nonnegative usage total is known.
 */
export function scaleCategoryTokensToUsed(
	categoryTokens: Record<CategoryId, number>,
	overallUsed: number | null | undefined,
): Record<CategoryId, number> {
	const raw = {
		system: Math.max(0, categoryTokens.system),
		tools: Math.max(0, categoryTokens.tools),
		conversation: Math.max(0, categoryTokens.conversation),
		toolResults: Math.max(0, categoryTokens.toolResults),
	};
	const estimatedSum = raw.system + raw.tools + raw.conversation + raw.toolResults;
	if (overallUsed == null || !Number.isFinite(overallUsed) || overallUsed < 0) {
		return raw;
	}
	const target = overallUsed;
	if (estimatedSum <= 0) {
		return { system: 0, tools: 0, conversation: target, toolResults: 0 };
	}
	const scale = target / estimatedSum;
	return {
		system: raw.system * scale,
		tools: raw.tools * scale,
		conversation: raw.conversation * scale,
		toolResults: raw.toolResults * scale,
	};
}

/**
 * Allocate bar segment widths proportional to the full context window.
 * When overallUsed is known, colored segments keep estimated relative mix but
 * their combined width tracks overallUsed / contextWindow.
 * Non-zero used categories get at least one column when width permits.
 */
export function allocateBarWidths(
	categoryTokens: Record<CategoryId, number>,
	contextWindow: number,
	width: number,
	overallUsed?: number | null,
): Record<CategoryId | "remaining", number> {
	const empty: Record<CategoryId | "remaining", number> = {
		system: 0,
		tools: 0,
		conversation: 0,
		toolResults: 0,
		remaining: 0,
	};
	if (width <= 0) return empty;

	const scaled = scaleCategoryTokensToUsed(categoryTokens, overallUsed);
	const usedSum = scaled.system + scaled.tools + scaled.conversation + scaled.toolResults;
	const capacity = Math.max(1, contextWindow > 0 ? contextWindow : usedSum || 1);
	const remainingTokens = Math.max(0, capacity - usedSum);

	const parts: Array<{ id: CategoryId | "remaining"; tokens: number; preferMin: boolean }> = [
		{ id: "system", tokens: scaled.system, preferMin: true },
		{ id: "tools", tokens: scaled.tools, preferMin: true },
		{ id: "conversation", tokens: scaled.conversation, preferMin: true },
		{ id: "toolResults", tokens: scaled.toolResults, preferMin: true },
		{ id: "remaining", tokens: remainingTokens, preferMin: false },
	];

	const raw = parts.map((p) => (p.tokens / capacity) * width);
	const floors = raw.map((v) => Math.floor(v));
	let spare = width - floors.reduce((a, b) => a + b, 0);

	// Guarantee tiny non-zero used categories are visible when width permits,
	// stealing from remaining (then spare) so we never overflow.
	const remainingIndex = parts.length - 1;
	for (let i = 0; i < remainingIndex; i++) {
		if (!(parts[i].preferMin && parts[i].tokens > 0 && floors[i] === 0)) continue;
		if (spare > 0) {
			floors[i] = 1;
			spare--;
			continue;
		}
		if (floors[remainingIndex] > 0) {
			floors[remainingIndex]--;
			floors[i] = 1;
		}
	}

	const byFrac = raw
		.map((v, i) => ({ i, frac: v - Math.floor(v) }))
		.sort((a, b) => b.frac - a.frac);
	for (const { i } of byFrac) {
		if (spare <= 0) break;
		floors[i]++;
		spare--;
	}

	let allocated = floors.reduce((a, b) => a + b, 0);
	while (allocated > width) {
		let shrunk = false;
		for (let i = floors.length - 1; i >= 0; i--) {
			if (floors[i] > 0) {
				// Prefer not to erase the last visible column of a used category
				const isUsedMin = i < remainingIndex && parts[i].tokens > 0 && floors[i] <= 1;
				if (isUsedMin) continue;
				floors[i]--;
				allocated--;
				shrunk = true;
				if (allocated <= width) break;
			}
		}
		if (!shrunk) {
			for (let i = floors.length - 1; i >= 0 && allocated > width; i--) {
				if (floors[i] > 0) {
					floors[i]--;
					allocated--;
				}
			}
			break;
		}
	}
	if (allocated < width) {
		floors[remainingIndex] += width - allocated;
	}

	return {
		system: floors[0],
		tools: floors[1],
		conversation: floors[2],
		toolResults: floors[3],
		remaining: floors[4],
	};
}

export function renderCapacityBar(
	theme: Theme,
	categoryTokens: Record<CategoryId, number>,
	contextWindow: number,
	width: number,
	overallUsed?: number | null,
): string {
	const barWidth = Math.max(0, width);
	const widths = allocateBarWidths(categoryTokens, contextWindow, barWidth, overallUsed);
	let bar = "";
	for (const id of ["system", "tools", "conversation", "toolResults", "remaining"] as const) {
		const w = widths[id];
		if (w <= 0) continue;
		bar += colorCategory(theme, id, BAR_FILL.repeat(w));
	}
	if (barWidth > 0 && !bar) {
		bar = theme.fg("dim", BAR_FILL.repeat(barWidth));
	}
	return truncateToWidth(bar, barWidth);
}

/** Prefer meaningful argument fields; fall back to tool name. */
export function labelFromToolArgs(toolName: string, args: unknown): string {
	const name = toolName || "tool";
	if (!args || typeof args !== "object" || Array.isArray(args)) return name;
	const record = args as Record<string, unknown>;
	const preferred = [
		"command",
		"path",
		"file_path",
		"filePath",
		"pattern",
		"query",
		"url",
		"uri",
		"name",
		"id",
		"text",
		"prompt",
		"message",
	];
	const compact = (value: string): string => value.trim().replace(/\s+/g, " ");
	for (const key of preferred) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return `${name} ${compact(value)}`;
	}
	for (const value of Object.values(record)) {
		if (typeof value === "string" && value.trim()) return `${name} ${compact(value)}`;
		if (typeof value === "number" || typeof value === "boolean") return `${name} ${String(value)}`;
	}
	return name;
}

function visibleSuffix(text: string, width: number): string {
	let suffix = "";
	let used = 0;
	for (const character of Array.from(text).reverse()) {
		const characterWidth = visibleWidth(character);
		if (used + characterWidth > width) break;
		suffix = character + suffix;
		used += characterWidth;
	}
	return suffix;
}

/** Preserve filenames and nearest path segments when a path label must shrink. */
export function truncateContextLabel(label: string, width: number): string {
	const targetWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (visibleWidth(label) <= targetWidth) return label;
	if (targetWidth <= 3) return ".".repeat(targetWidth);

	const separator = label.indexOf(" ");
	const prefix = separator >= 0 ? label.slice(0, separator + 1) : "";
	const value = separator >= 0 ? label.slice(separator + 1) : label;
	if (!/[\\/]/.test(value)) return truncateToWidth(label, targetWidth, "...");

	const retainedPrefix = visibleWidth(prefix) + 3 < targetWidth ? prefix : "";
	const suffixWidth = targetWidth - visibleWidth(retainedPrefix) - 3;
	return `${retainedPrefix}...${visibleSuffix(value, suffixWidth)}`;
}

export function buildToolCallLabelMap(messages: AgentMessage[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const message of messages) {
		if (!message || message.role !== "assistant") continue;
		const content = Array.isArray(message.content) ? message.content : [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const call = block as { type?: string; id?: string; name?: string; arguments?: unknown };
			if (call.type !== "toolCall" || typeof call.id !== "string") continue;
			map.set(
				call.id,
				labelFromToolArgs(typeof call.name === "string" ? call.name : "tool", call.arguments),
			);
		}
	}
	return map;
}

export function isTurnStartRole(role: string): boolean {
	return (
		role === "user" ||
		role === "bashExecution" ||
		role === "custom" ||
		role === "branchSummary" ||
		role === "compactionSummary"
	);
}

/** Compaction-aware active messages from the session manager. */
export function getActiveContextMessages(
	sessionManager: Pick<ExtensionContext["sessionManager"], "buildContextEntries">,
): AgentMessage[] {
	const entries = sessionManager.buildContextEntries() ?? [];
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		try {
			messages.push(...sessionEntryToContextMessages(entry));
		} catch {
			// Skip malformed entries
		}
	}
	return messages;
}

export function estimateSystemBreakdown(
	systemPrompt: string | undefined,
	options: BuildSystemPromptOptions | undefined,
): { total: number; rows: LabeledTokens[] } {
	const total = systemPrompt ? estimateTextTokens(systemPrompt) : 0;
	const rows: LabeledTokens[] = [];
	if (!options) {
		if (total > 0) rows.push({ label: "System prompt", tokens: total });
		return { total, rows };
	}

	const files = Array.isArray(options.contextFiles) ? options.contextFiles : [];
	if (files.length > 0) {
		let tokens = estimateTextTokens(
			"<project_context>\n\nProject-specific instructions and guidelines:\n\n",
		);
		for (const file of files) {
			const path = typeof file?.path === "string" ? file.path : "?";
			const content = typeof file?.content === "string" ? file.content : "";
			tokens += estimateTextTokens(
				`<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`,
			);
		}
		tokens += estimateTextTokens("</project_context>\n");
		rows.push({ label: "Context files", tokens, detail: String(files.length) });
	}

	const skills = Array.isArray(options.skills)
		? options.skills.filter((s) => s && !s.disableModelInvocation)
		: [];
	if (skills.length > 0) {
		const text = skills.map((s) => `${s.name ?? ""}\n${s.description ?? ""}`).join("\n");
		rows.push({ label: "Skills", tokens: estimateTextTokens(text), detail: String(skills.length) });
	}

	if (typeof options.appendSystemPrompt === "string" && options.appendSystemPrompt.trim()) {
		rows.push({ label: "Appended", tokens: estimateTextTokens(options.appendSystemPrompt) });
	}

	const guidelines = Array.isArray(options.promptGuidelines)
		? options.promptGuidelines.filter(
				(g): g is string => typeof g === "string" && g.trim().length > 0,
			)
		: [];
	if (guidelines.length > 0) {
		rows.push({
			label: "Guidelines",
			tokens: estimateTextTokens(guidelines.map((g) => `- ${g}`).join("\n")),
			detail: String(guidelines.length),
		});
	}

	const attributed = rows.reduce((sum, row) => sum + row.tokens, 0);
	const baseTokens = Math.max(0, total - attributed);
	const baseLabel =
		typeof options.customPrompt === "string" && options.customPrompt.trim()
			? "Custom prompt"
			: "Base prompt";
	if (baseTokens > 0 || rows.length === 0) {
		if (baseTokens > 0 || total > 0) {
			rows.unshift({ label: baseLabel, tokens: baseTokens > 0 ? baseTokens : total });
		}
	}

	const rowSum = rows.reduce((sum, row) => sum + row.tokens, 0);
	return { total: total > 0 ? total : rowSum, rows: rows.filter((r) => r.tokens > 0) };
}

export function classifyMessages(messages: AgentMessage[]): {
	conversationTokens: number;
	turnCount: number;
	toolResults: LabeledTokens[];
} {
	const callLabels = buildToolCallLabelMap(messages);
	let conversationTokens = 0;
	let turnCount = 0;
	const toolResults: LabeledTokens[] = [];

	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const role = (message as { role?: string }).role ?? "";
		let tokens = 0;
		try {
			tokens = estimateTokens(message);
		} catch {
			tokens = 0;
		}

		if (role === "toolResult") {
			const tr = message as { toolCallId?: string; toolName?: string };
			const label =
				(typeof tr.toolCallId === "string" && callLabels.get(tr.toolCallId)) ||
				(typeof tr.toolName === "string" ? tr.toolName : "tool result");
			toolResults.push({ label, tokens });
			continue;
		}

		conversationTokens += tokens;
		if (isTurnStartRole(role)) turnCount++;
	}

	return { conversationTokens, turnCount, toolResults };
}

export function buildContextBreakdown(input: {
	modelId?: string;
	contextWindow?: number;
	usage?: { tokens: number | null; percent: number | null; contextWindow?: number } | undefined;
	systemPrompt?: string;
	systemPromptOptions?: BuildSystemPromptOptions;
	allTools: ToolInfo[];
	activeToolNames: string[];
	messages: AgentMessage[];
}): ContextBreakdown {
	const activeTools = filterActiveTools(input.allTools, input.activeToolNames);
	const toolItems = activeTools.map((tool) => ({
		label: tool.name,
		tokens: estimateToolDefinitionTokens(tool),
	}));
	const toolsTop = topNWithRemainder(toolItems, TOP_N);

	const system = estimateSystemBreakdown(input.systemPrompt, input.systemPromptOptions);
	const classified = classifyMessages(input.messages);
	const resultsTop = topNWithRemainder(classified.toolResults, TOP_N);

	const toolsTotal = toolItems.reduce((sum, t) => sum + t.tokens, 0);
	const toolResultsTotal = classified.toolResults.reduce((sum, t) => sum + t.tokens, 0);

	const contextWindow = input.contextWindow ?? input.usage?.contextWindow;
	const usedFromUsage =
		input.usage != null && input.usage.tokens != null && Number.isFinite(input.usage.tokens);
	const sectionSum = system.total + toolsTotal + classified.conversationTokens + toolResultsTotal;
	const usedTokens = usedFromUsage
		? (input.usage!.tokens as number)
		: sectionSum > 0
			? sectionSum
			: null;

	let percent = input.usage?.percent ?? null;
	if (percent === null && usedTokens != null && contextWindow && contextWindow > 0) {
		percent = (usedTokens / contextWindow) * 100;
	}

	return {
		modelId: input.modelId,
		contextWindow,
		usedTokens,
		usedFromUsage,
		percent,
		system,
		tools: {
			total: toolsTotal,
			activeCount: activeTools.length,
			rows: toolsTop.top,
			remainderCount: toolsTop.remainderCount,
			remainderTokens: toolsTop.remainderTokens,
		},
		conversation: {
			total: classified.conversationTokens,
			turnCount: classified.turnCount,
		},
		toolResults: {
			total: toolResultsTotal,
			callCount: classified.toolResults.length,
			rows: resultsTop.top,
			remainderCount: resultsTop.remainderCount,
			remainderTokens: resultsTop.remainderTokens,
		},
	};
}

function collectBreakdown(pi: ExtensionAPI, ctx: ExtensionCommandContext): ContextBreakdown {
	const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
	let systemPrompt: string | undefined;
	try {
		systemPrompt = ctx.getSystemPrompt();
	} catch {
		systemPrompt = undefined;
	}
	let systemPromptOptions: BuildSystemPromptOptions | undefined;
	try {
		systemPromptOptions = ctx.getSystemPromptOptions();
	} catch {
		systemPromptOptions = undefined;
	}

	let messages: AgentMessage[] = [];
	try {
		messages = getActiveContextMessages(ctx.sessionManager);
	} catch {
		messages = [];
	}

	let allTools: ToolInfo[] = [];
	let activeToolNames: string[] = [];
	try {
		allTools = pi.getAllTools() ?? [];
	} catch {
		allTools = [];
	}
	try {
		activeToolNames = pi.getActiveTools() ?? [];
	} catch {
		activeToolNames = [];
	}

	return buildContextBreakdown({
		modelId: ctx.model?.id,
		contextWindow: ctx.model?.contextWindow,
		usage: usage ?? undefined,
		systemPrompt,
		systemPromptOptions,
		allTools,
		activeToolNames,
		messages,
	});
}

function padLabel(label: string, width: number): string {
	if (label.length >= width) return label.slice(0, width);
	return label + " ".repeat(width - label.length);
}

/** UI component for the /context command. */
export class ContextViewComponent {
	private readonly viewport = new ScrollViewportState();
	private cachedWidth?: number;
	private cachedHeight?: number;
	private cachedLines?: string[];

	constructor(
		private readonly breakdown: ContextBreakdown,
		private readonly theme: Theme,
		private readonly onClose: () => void,
		private readonly tui?: TUI,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
			return;
		}
		const previous = this.viewport.offset;
		if (matchesKey(data, "up")) this.viewport.scrollBy(-1);
		else if (matchesKey(data, "down")) this.viewport.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.viewport.pageBy(-1);
		else if (matchesKey(data, "pageDown")) this.viewport.pageBy(1);
		else if (matchesKey(data, "home")) this.viewport.home();
		else if (matchesKey(data, "end")) this.viewport.end(false);
		else return;
		if (this.viewport.offset !== previous) {
			this.invalidate();
			this.tui?.requestRender();
		}
	}

	private renderBody(width: number): string[] {
		const th = this.theme;
		const w = Math.max(0, width);
		const lines: string[] = [];
		const b = this.breakdown;
		const push = (line: string) => lines.push(truncateToWidth(line, w));

		if (!b.modelId && !b.contextWindow) {
			push(th.fg("warning", "No model selected"));
			push(th.fg("dim", "Select a model to inspect active context."));
			return lines;
		}

		const categoryTokens: Record<CategoryId, number> = {
			system: b.system.total,
			tools: b.tools.total,
			conversation: b.conversation.total,
			toolResults: b.toolResults.total,
		};
		const capacity =
			b.contextWindow ??
			Math.max(
				1,
				Object.values(categoryTokens).reduce((a, c) => a + c, 0),
			);
		push("");

		// Capacity bar with percentage label at the right end
		const pctStr = formatPercent(b.percent);
		const pctLabel = th.fg("muted", pctStr);
		const pctWidth = visibleWidth(pctStr);
		const barWidth = Math.max(0, Math.min(MAX_BAR_WIDTH - 1 - pctWidth, w - 1 - pctWidth));
		const bar = renderCapacityBar(th, categoryTokens, capacity, barWidth, b.usedTokens);
		push(truncateToWidth(`${bar} ${pctLabel}`, w));

		const legend = (["system", "tools", "conversation", "toolResults", "remaining"] as const)
			.map((id) => colorCategory(th, id, CATEGORY_LABELS[id]))
			.join(th.fg("dim", " · "));
		push(legend);
		push("");

		const sectionHead = (id: CategoryId, titleText: string, subtotal: number, suffix?: string) => {
			const meta = colorCategory(th, id, formatTokenCount(subtotal, true));
			const extra = suffix ? `  ${th.fg("dim", suffix)}` : "";
			push(`${colorCategory(th, id, th.bold(titleText))}  ${meta}${extra}`);
		};
		const rowLine = (label: string, tokens: number, detail?: string) => {
			const detailPart = detail ? th.fg("dim", ` (${detail})`) : "";
			const detailWidth = visibleWidth(detailPart);
			const tokenText = formatTokenCount(tokens, true);
			const tokenStr = th.fg("muted", tokenText);
			const tokenWidth = visibleWidth(tokenText);
			const labelWidth = Math.max(1, w - detailWidth - 2 - tokenWidth);
			const truncated = truncateContextLabel(label, labelWidth);
			const left = `${th.fg("text", truncated)}${detailPart}`;
			const leftWidth = visibleWidth(truncated) + detailWidth;
			const gap = Math.max(2, w - leftWidth - tokenWidth);
			push(truncateToWidth(`${left}${" ".repeat(gap)}${tokenStr}`, w));
		};

		sectionHead("system", "SYSTEM", b.system.total);
		if (b.system.rows.length === 0) push(th.fg("dim", "No system prompt"));
		else for (const row of b.system.rows) rowLine(row.label, row.tokens, row.detail);
		push("");

		sectionHead("tools", "TOOLS", b.tools.total, `· ${b.tools.activeCount} active`);
		if (b.tools.rows.length === 0) push(th.fg("dim", "No active tools"));
		else {
			for (const row of b.tools.rows) rowLine(row.label, row.tokens);
			if (b.tools.remainderCount > 0)
				rowLine(`+${b.tools.remainderCount} more`, b.tools.remainderTokens);
		}
		push("");

		sectionHead(
			"conversation",
			"CONVERSATION",
			b.conversation.total,
			`· ${b.conversation.turnCount} turn${b.conversation.turnCount === 1 ? "" : "s"}`,
		);
		if (b.conversation.total === 0) push(th.fg("dim", "No conversation in context"));
		push("");

		sectionHead(
			"toolResults",
			"TOOL RESULTS",
			b.toolResults.total,
			`· ${b.toolResults.callCount} call${b.toolResults.callCount === 1 ? "" : "s"}`,
		);
		if (b.toolResults.callCount === 0) push(th.fg("dim", "No tool results in context"));
		else {
			for (const row of b.toolResults.rows) rowLine(row.label, row.tokens);
			if (b.toolResults.remainderCount > 0)
				rowLine(`+${b.toolResults.remainderCount} more`, b.toolResults.remainderTokens);
		}
		return lines;
	}

	render(width: number): string[] {
		const body = this.renderBody(getContentWidth(width));
		const height = this.tui ? Math.max(0, Math.floor(this.tui.terminal.rows)) : body.length + 5;
		if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === height)
			return this.cachedLines;

		const bodyHeight = Math.max(0, height - 2 - 3);
		this.viewport.update(body.length, bodyHeight);
		const visibleBody = body.slice(this.viewport.range.start, this.viewport.range.end);
		const b = this.breakdown;
		const used = b.usedTokens == null ? "—" : formatTokenCount(b.usedTokens, true);
		const window = b.contextWindow == null ? "—" : formatTokenCount(b.contextWindow, false);
		const subtitle =
			!b.modelId && !b.contextWindow
				? "No model selected"
				: `${b.modelId ?? "unknown"} · ${formatPercent(b.percent)} · ${used}/${window}`;
		const rendered = renderFullscreenScreen({
			width,
			height,
			title: "Context",
			subtitle,
			body: visibleBody,
			keyHints: [
				{ key: "Esc", label: "close" },
				{ key: "Ctrl+C", label: "close" },
			],
			theme: this.theme,
			footerPadding: 1,
		});
		this.cachedWidth = width;
		this.cachedHeight = height;
		this.cachedLines = rendered;
		return rendered;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
		this.cachedLines = undefined;
	}
}

export default function contextExtension(pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Inspect active model context usage",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/context requires interactive mode", "error");
				return;
			}
			const breakdown = collectBreakdown(pi, ctx);
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new ContextViewComponent(breakdown, theme, () => done(), tui),
				fullscreenOverlayOptions(),
			);
		},
	});
}

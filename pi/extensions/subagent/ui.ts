import type { Message } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	getContentWidth,
	renderFooter,
	renderFullscreenScreen,
	renderHeader,
	renderSplitPane,
	ScrollViewportController,
	seedSessionTopology,
	SelectableViewportController,
	TOOL_CHAT_PADDING,
} from "../lib/tui/index.ts";
import {
	createMinimalToolPresentations,
	MINIMAL_TOOL_NAMES,
	type MinimalToolName,
	type MinimalToolPresentations,
	type ToolRenderContext,
} from "../lib/minimal-tool-presentation.ts";
import { WORKING_FRAMES, WORKING_FRAME_INTERVAL_MS } from "../announce-step.ts";
import { STATUS_KEY as TOKEN_SPEED_STATUS_KEY } from "../token-speed.ts";
import type {
	ContextUsageSnapshot,
	SubagentDetails,
	SubagentResultView,
	UsageStats,
} from "./contracts.ts";

const THREAD_STATUS_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const WORKTREE_METADATA_ICON = "󰙅";
const CHAT_PADDING = TOOL_CHAT_PADDING;

/** Tools whose consecutive calls may soft-group, mirroring the parent minimal mode. */
const GROUPED_TOOL_NAMES = ["read", "find", "grep", "ls", "edit"];
const TITLE_SEPARATOR = " · ";

/**
 * Display-only model label: the provider prefix is removed and dashes before a
 * non-digit become spaces, so `openai-codex/gpt-5.6-luna` reads as
 * `gpt-5.6 luna`. Thinking effort is appended. Stored identity is untouched.
 */
export function formatReadableModel(model: string, thinking?: string): string {
	const id = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
	const readable = id.replace(/-([^\d])/g, " $1").trim();
	const base = readable || model || "unknown model";
	return thinking ? `${base} ${thinking}` : base;
}

/**
 * Compact truthful context label from the F1 RPC snapshot. Cumulative billed
 * traffic is never used as the numerator.
 */
export function formatContextLabel(context?: ContextUsageSnapshot): string {
	if (!context) return "context unavailable";
	const { tokens, contextWindow } = context;
	if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
		return "context unavailable";
	}
	const total = Math.round(contextWindow / 1000);
	if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) {
		return `unknown/${total}k`;
	}
	return `${Math.round(tokens / 1000)}k/${total}k`;
}

/** One candidate segment of the responsive thread title. */
export interface TitleSegment {
	text: string;
	/** Kept on the title line even when the full sequence does not fit. */
	fixed?: boolean;
	/** Readable model: preserved at narrow widths alongside position and icon. */
	essential?: boolean;
}

/**
 * Responsive title composition. When the full semantic sequence fits it is
 * used verbatim; otherwise lower-priority context and mode move to secondary
 * metadata and only the status-prefixed position and readable model remain.
 */
export function selectTitleSegments(
	width: number,
	segments: readonly TitleSegment[],
): { selected: readonly string[]; dropped: readonly TitleSegment[] } {
	const joined = (candidates: readonly TitleSegment[]): string =>
		candidates.map((segment) => segment.text).join(TITLE_SEPARATOR);
	const full = segments.filter((segment) => segment.text.length > 0);
	if (visibleWidth(joined(full)) <= Math.max(0, width)) {
		return { selected: full.map((segment) => segment.text), dropped: [] };
	}
	const essentials = full.filter((segment) => segment.fixed || segment.essential);
	if (visibleWidth(joined(essentials)) <= Math.max(0, width)) {
		return {
			selected: essentials.map((segment) => segment.text),
			dropped: full.filter((segment) => !segment.fixed && !segment.essential),
		};
	}
	const fixed = full.filter((segment) => segment.fixed);
	const model = full.find((segment) => segment.essential && !segment.fixed);
	const target = Math.max(0, Math.floor(width));
	const fixedWidth = visibleWidth(joined(fixed));
	const separatorWidth = visibleWidth(TITLE_SEPARATOR);
	const separators = Math.max(0, fixed.length + (model ? 1 : 0) - 1);
	const modelRoom = model ? Math.max(0, target - fixedWidth - separators * separatorWidth) : 0;
	// Last resort: a truncated readable model still names the agent whenever
	// there is room for at least one character plus the ellipsis, kept between
	// position and icon in original semantic order. Otherwise only position and
	// icon survive and the model moves to the wrapped secondary metadata.
	if (model && modelRoom >= 2) {
		const truncated = truncateToWidth(model.text, modelRoom, "…");
		const selected: TitleSegment[] = [];
		for (const segment of full) {
			if (segment.fixed) selected.push(segment);
			else if (segment === model) selected.push({ ...segment, text: truncated });
		}
		return {
			selected: selected.map((segment) => segment.text),
			dropped: full.filter((segment) => !segment.fixed && segment !== model),
		};
	}
	return {
		selected: fixed.map((segment) => segment.text),
		dropped: full.filter((segment) => !segment.fixed),
	};
}

/** Ordered content identity of one message, so in-place live growth reseeds topology. */
function messageContentIdentity(content: unknown): string {
	if (typeof content === "string") return `text:${content.length}`;
	if (!Array.isArray(content)) return "none";
	const parts = content.map((part) => {
		if (!part || typeof part !== "object") return "?";
		const record = part as Record<string, unknown>;
		if (record.type === "toolCall") {
			return `tool:${String(record.id ?? "")}:${String(record.name ?? "")}`;
		}
		return `part:${String(record.type ?? "")}`;
	});
	return `parts:${content.length}:${parts.join(",")}`;
}

/**
 * Wrap a shared minimal presentation as a render-only ToolDefinition so
 * ToolExecutionComponent renders the exact parent compact rows. Tools outside
 * MINIMAL_TOOL_NAMES return undefined and keep Pi's generic renderer.
 */
function renderOnlyToolDefinition(
	toolName: string,
	presentations: MinimalToolPresentations,
): ToolDefinition | undefined {
	if (!MINIMAL_TOOL_NAMES.includes(toolName as MinimalToolName)) return undefined;
	const presentation = presentations[toolName as MinimalToolName];
	return {
		name: toolName,
		label: toolName,
		renderShell: "self",
		parameters: {},
		execute: () => {
			throw new Error("read-only subagent transcript");
		},
		renderCall: (args: unknown, theme: Theme, context: unknown) =>
			presentation.renderCall(
				(args ?? {}) as Record<string, unknown>,
				theme,
				context as ToolRenderContext,
			),
		renderResult: (result: unknown, options: unknown, theme: Theme, context: unknown) =>
			presentation.renderResult(
				result as Parameters<MinimalToolPresentations[MinimalToolName]["renderResult"]>[0],
				options as Parameters<MinimalToolPresentations[MinimalToolName]["renderResult"]>[1],
				theme,
				context as ToolRenderContext,
			),
	} as unknown as ToolDefinition;
}

export class CompactSubagentLine implements Component {
	constructor(private readonly text: string) {}

	render(width: number): string[] {
		const available = Math.max(1, width - CHAT_PADDING);
		return [` ${truncateToWidth(this.text, available, "")}`];
	}

	invalidate(): void {}
}

export class EmptySubagentRender implements Component {
	render(_width: number): string[] {
		return [];
	}

	invalidate(): void {}
}

export function formatUsage(usage: UsageStats): string {
	const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return `${usage.turns} turns, ${tokens} tokens, $${usage.cost.toFixed(4)}`;
}

interface DashboardItem {
	key: string;
	runId: string;
	taskId: string;
	startedAt: number;
	result: SubagentResultView;
}

export class SubagentDashboard implements Component {
	private readonly selection = new SelectableViewportController();
	private readonly transcript = new ScrollViewportController();
	private transcriptFocused = false;
	private followTail = true;
	private killArmed = false;
	private unsubscribe: () => void;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private getRuns: () => SubagentDetails[],
		subscribe: (listener: () => void) => () => void,
		private done: () => void,
		private killTask: (runId: string, taskId: string) => void,
	) {
		this.unsubscribe = subscribe(() => {
			if (this.followTail) this.transcript.end(true);
			this.tui.requestRender();
		});
	}

	private items(): DashboardItem[] {
		return this.getRuns()
			.flatMap((run) =>
				run.results.map((result) => ({
					key: `${run.runId}:${result.taskId}`,
					runId: run.runId,
					taskId: result.taskId,
					startedAt: run.startedAt,
					result,
				})),
			)
			.sort((a, b) => b.startedAt - a.startedAt || a.result.index - b.result.index);
	}

	private listLines(items: DashboardItem[], width: number, height: number): string[] {
		const lines = [this.theme.fg("muted", this.theme.bold("Agents"))];
		const visibleItems = Math.max(1, Math.floor(Math.max(0, height - 1) / 2));
		const range = this.selection.update(items.length, visibleItems);
		if (items.length === 0) {
			lines.push(this.theme.fg("muted", "No subagent runs in this session."));
			return lines;
		}
		for (let index = range.start; index < range.end; index++) {
			const item = items[index];
			const icon = !item.result.done ? "◌" : item.result.error ? "✗" : "✓";
			const prefix = index === this.selection.selected ? "› " : "  ";
			const statusColor = !item.result.done ? "warning" : item.result.error ? "error" : "success";
			const title = `${prefix}${this.theme.fg(statusColor, icon)} #${item.result.index + 1} ${item.result.task}`;
			lines.push(truncateToWidth(title, width, "…"));
			lines.push(
				truncateToWidth(
					this.theme.fg(
						"dim",
						`    ${item.result.model}:${item.result.thinking} · ${item.result.workspace} · ${item.result.mode ?? "ephemeral"}${item.result.sessionId ? ` · ${item.result.sessionId}` : ""}`,
					),
					width,
					"…",
				),
			);
		}
		return lines;
	}

	private detailLines(item: DashboardItem | undefined, width: number, height: number): string[] {
		if (!item) {
			this.transcript.update(0, height);
			return [this.theme.fg("muted", "Select a subagent")];
		}
		const lines: string[] = [
			this.theme.fg("muted", this.theme.bold("Transcript")),
			this.theme.fg(
				"muted",
				`status=${item.result.status} · mode=${item.result.mode ?? "ephemeral"}${item.result.sessionId ? ` · sessionId=${item.result.sessionId}` : ""} · taskId=${item.result.taskId}`,
			),
			this.theme.fg("dim", item.result.task),
		];
		if (item.result.worktree) {
			lines.push(this.theme.fg("muted", item.result.worktree.branch));
			lines.push(this.theme.fg("muted", item.result.worktree.path));
		}
		if (item.result.error) lines.push(this.theme.fg("error", item.result.error));
		else if (!item.result.done) lines.push(this.theme.fg("warning", "◌ Running..."));
		else if (item.result.output) lines.push(...item.result.output.split("\n"));
		else lines.push(this.theme.fg("muted", "(no output yet; use subagent_result after wake)"));
		if (item.result.done) lines.push(this.theme.fg("dim", formatUsage(item.result.usage)));

		this.transcript.update(lines.length, Math.max(0, height));
		if (this.followTail) this.transcript.end(true);
		const visible = this.transcript.range;
		return lines.slice(visible.start, visible.end);
	}

	private footerHints(): Array<{ key: string; label: string }> {
		if (this.killArmed)
			return [
				{ key: "k", label: "again to KILL selected" },
				{ key: "Esc", label: "cancel" },
			];
		if (this.transcriptFocused)
			return [
				{ key: "↑↓", label: "scroll" },
				{ key: "PgUp/PgDn", label: "page" },
				{ key: "Home/End", label: "jump" },
				{ key: "Tab/Esc", label: "list" },
				{ key: "k", label: "kill running" },
			];
		return [
			{ key: "↑↓", label: "select" },
			{ key: "Enter/Tab", label: "details" },
			{ key: "k", label: "kill running" },
			{ key: "Esc", label: "close" },
		];
	}

	render(width: number): string[] {
		const items = this.items();
		const contentWidth = getContentWidth(width);
		const height = Math.max(1, this.tui.terminal.rows);
		const renderedHeader = renderHeader({
			width,
			title: "Subagents",
			subtitle: `${items.length} agent${items.length === 1 ? "" : "s"}`,
			theme: this.theme,
		});
		const renderedFooter = renderFooter({
			width,
			hints: this.footerHints(),
			padding: 1,
			theme: this.theme,
		});
		const bodyHeight = Math.max(0, height - renderedHeader.length - renderedFooter.length);
		const body = renderSplitPane({
			width: contentWidth,
			height: bodyHeight,
			left: (paneWidth, paneHeight) => this.listLines(items, paneWidth, paneHeight),
			right: (paneWidth, paneHeight) =>
				this.detailLines(items[this.selection.selected], paneWidth, paneHeight),
			narrowPane: this.transcriptFocused ? "right" : "left",
			breakpoint: 100,
			leftRatio: 0.36,
			minLeftWidth: 32,
			maxLeftWidth: 46,
			minRightWidth: 1,
			divider: this.theme.fg(this.transcriptFocused ? "accent" : "borderMuted", " │ "),
		});
		return renderFullscreenScreen({
			width,
			height,
			title: "Subagents",
			subtitle: `${items.length} agent${items.length === 1 ? "" : "s"}`,
			body,
			keyHints: this.footerHints(),
			footerPadding: 1,
			theme: this.theme,
		});
	}

	handleInput(data: string): void {
		const items = this.items();
		if (matchesKey(data, "escape")) {
			if (this.killArmed) {
				this.killArmed = false;
				this.tui.requestRender();
				return;
			}
			if (this.transcriptFocused) {
				this.transcriptFocused = false;
				this.tui.requestRender();
			} else this.done();
			return;
		}
		if (data === "k" || data === "K") {
			const item = items[this.selection.selected];
			if (!item || item.result.done) {
				this.killArmed = false;
				this.tui.requestRender();
				return;
			}
			if (!this.killArmed) {
				this.killArmed = true;
				this.tui.requestRender();
				return;
			}
			this.killTask(item.runId, item.taskId);
			this.killArmed = false;
			this.tui.requestRender();
			return;
		}
		this.killArmed = false;
		if (matchesKey(data, "tab") || matchesKey(data, "enter")) {
			if (items.length > 0) {
				this.transcriptFocused = !this.transcriptFocused;
				if (this.transcriptFocused) {
					this.followTail = !items[this.selection.selected].result.done;
					if (this.followTail) this.transcript.end(true);
					else this.transcript.home();
				}
			}
			this.tui.requestRender();
			return;
		}
		if (this.transcriptFocused) {
			if (matchesKey(data, "up")) this.transcript.scrollBy(-1);
			else if (matchesKey(data, "down")) this.transcript.scrollBy(1);
			else if (matchesKey(data, "pageUp")) this.transcript.pageBy(-1);
			else if (matchesKey(data, "pageDown")) this.transcript.pageBy(1);
			else if (matchesKey(data, "home")) this.transcript.home();
			else if (matchesKey(data, "end")) this.transcript.end(true);
			this.followTail = this.transcript.followEnd;
		} else if (matchesKey(data, "up")) {
			this.selection.moveBy(-1, items.length);
			this.transcript.end(true);
			this.followTail = true;
		} else if (matchesKey(data, "down")) {
			this.selection.moveBy(1, items.length);
			this.transcript.end(true);
			this.followTail = true;
		}
		this.tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
	}
}

interface SubagentThreadItem {
	runId: string;
	startedAt: number;
	result: SubagentResultView;
}

export interface SubagentThreadGroup {
	key: string;
	teamRunId?: string;
	startedAt: number;
	items: SubagentThreadItem[];
}

export function buildThreadGroups(runs: SubagentDetails[]): SubagentThreadGroup[] {
	const groups = new Map<string, SubagentThreadGroup>();
	for (const run of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
		for (const result of run.results) {
			const persistentSessionId =
				result.mode === "persistent" && result.sessionId ? result.sessionId : undefined;
			const key = result.teamRunId
				? `team:${result.teamRunId}`
				: persistentSessionId
					? `session:${persistentSessionId}`
					: `run:${run.runId}`;
			let group = groups.get(key);
			if (!group) {
				group = { key, teamRunId: result.teamRunId, startedAt: run.startedAt, items: [] };
				groups.set(key, group);
			}
			const item = { runId: run.runId, startedAt: run.startedAt, result };
			const existing = persistentSessionId
				? group.items.findIndex((candidate) => candidate.result.sessionId === persistentSessionId)
				: -1;
			if (existing >= 0) group.items[existing] = item;
			else group.items.push(item);
		}
	}
	return [...groups.values()]
		.map((group) => ({
			...group,
			items: group.items.sort(
				(a, b) => a.startedAt - b.startedAt || a.result.index - b.result.index,
			),
		}))
		.sort((a, b) => a.startedAt - b.startedAt);
}

function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/** Full-screen, read-only child conversation opened by F6. */
export class SubagentThreadView implements Component {
	private readonly selection = new SelectableViewportController();
	private readonly transcript = new ScrollViewportController();
	/** Render-only parent-parity presentation for the selected thread. */
	private readonly presentation = createMinimalToolPresentations();
	/** Sequence identity the presentation topology was last seeded from. */
	private seededSequenceKey = "";
	private followTail = true;
	private expanded = false;
	private killArmed?: "task" | "all";
	private selectedGroupKey?: string;
	private readonly selectedByGroup = new Map<string, number>();
	private spinnerFrame = 0;
	private animationTimer: ReturnType<typeof setInterval>;
	private unsubscribe: () => void;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private getRuns: () => SubagentDetails[],
		subscribe: (listener: () => void) => () => void,
		private done: () => void,
		initialTaskId?: string,
		private onSelect?: (taskId: string, groupKey: string) => void,
		initialGroupKey?: string,
		private getTeamName: (teamRunId: string) => string | undefined = () => undefined,
		private onGroupSelect?: (groupKey: string) => void,
		private killTask: (runId: string, taskId: string) => void = () => {},
		private killAll: () => void = () => {},
	) {
		const groups = this.groups();
		const initialGroup =
			groups.find((group) => group.key === initialGroupKey) ??
			groups.find((group) => group.items.some((item) => item.result.taskId === initialTaskId)) ??
			groups[0];
		if (initialGroup) {
			this.selectedGroupKey = initialGroup.key;
			const initial = initialGroup.items.findIndex((item) => item.result.taskId === initialTaskId);
			this.selection.selected = initial >= 0 ? initial : 0;
			this.selectedByGroup.set(initialGroup.key, this.selection.selected);
		}
		this.unsubscribe = subscribe(() => this.tui.requestRender());
		this.animationTimer = setInterval(() => {
			if (!this.groups().some((group) => group.items.some((item) => !item.result.done))) return;
			this.spinnerFrame = (this.spinnerFrame + 1) % WORKING_FRAMES.length;
			this.tui.requestRender();
		}, WORKING_FRAME_INTERVAL_MS);
		this.animationTimer.unref?.();
	}

	private groups(): SubagentThreadGroup[] {
		return buildThreadGroups(this.getRuns());
	}

	private currentGroup(
		groups: SubagentThreadGroup[],
	): { group: SubagentThreadGroup; index: number } | undefined {
		if (groups.length === 0) return undefined;
		let index = groups.findIndex((group) => group.key === this.selectedGroupKey);
		if (index < 0) index = groups.length - 1;
		const group = groups[index];
		this.selectedGroupKey = group.key;
		this.selection.selected = Math.min(
			this.selectedByGroup.get(group.key) ?? 0,
			Math.max(0, group.items.length - 1),
		);
		this.selection.update(group.items.length, Math.max(1, group.items.length));
		return { group, index };
	}

	private sequenceIdentity(item: SubagentThreadItem): string {
		const messages = item.result.messages ?? [];
		const last = messages.at(-1);
		let lastIdentity = "none";
		if (last && typeof last === "object") {
			const record = last as unknown as Record<string, unknown>;
			lastIdentity = JSON.stringify({
				role: record.role,
				ts: record.timestamp,
				id: record.toolCallId ?? record.id,
				// A live partial assistant message grows in place: without its
				// ordered content identity a newly streamed tool call would not
				// reseed grouping before message_end.
				content: messageContentIdentity(record.content),
			});
		}
		return `${item.runId}:${item.result.taskId}:${messages.length}:${lastIdentity}`;
	}

	private contentLines(item: SubagentThreadItem, width: number): string[] {
		const messages = item.result.messages ?? [];
		const sequenceKey = this.sequenceIdentity(item);
		if (this.seededSequenceKey !== sequenceKey) {
			this.seededSequenceKey = sequenceKey;
			this.presentation.tracker.reset();
			this.presentation.reset();
			seedSessionTopology(messages, this.presentation.tracker, GROUPED_TOOL_NAMES, {
				nonBreakingToolNames: ["announce_step"],
			});
		}
		const components: Component[] = [];
		const pendingTools = new Map<string, ToolExecutionComponent>();

		for (const message of messages) {
			if (message.role === "user") {
				components.push(new UserMessageComponent(messageText(message), getMarkdownTheme(), 1));
				continue;
			}
			if (message.role === "assistant") {
				components.push(
					new AssistantMessageComponent(message, false, getMarkdownTheme(), "Thinking...", 1),
				);
				for (const part of message.content) {
					if (part.type !== "toolCall" || part.name === "announce_step") continue;
					const tool = new ToolExecutionComponent(
						part.name,
						part.id,
						part.arguments,
						{ showImages: false },
						renderOnlyToolDefinition(part.name, this.presentation.presentations),
						this.tui,
						item.result.cwd,
					);
					tool.setExpanded(this.expanded);
					components.push(tool);
					pendingTools.set(part.id, tool);
				}
				continue;
			}
			const tool = pendingTools.get(message.toolCallId);
			if (tool) {
				tool.updateResult(message);
				pendingTools.delete(message.toolCallId);
			}
		}

		if (messages.length === 0) {
			components.push(new UserMessageComponent(item.result.task, getMarkdownTheme(), 1));
			if (item.result.output)
				components.push(new Markdown(item.result.output, 1, 0, getMarkdownTheme()));
		}

		const uiState = item.result.uiState;
		const aboveWidgets = Object.values(uiState?.widgets ?? {})
			.filter((widget) => widget.placement === "aboveEditor")
			.flatMap((widget) => widget.lines);
		const belowWidgets = Object.values(uiState?.widgets ?? {})
			.filter((widget) => widget.placement === "belowEditor")
			.flatMap((widget) => widget.lines);
		const lines = [
			...(aboveWidgets.length
				? [...new Text(aboveWidgets.join("\n"), 1, 0).render(width), ""]
				: []),
			...components.flatMap((component) => component.render(width)),
		];
		for (const notification of uiState?.notifications ?? []) {
			const color =
				notification.type === "error"
					? "error"
					: notification.type === "warning"
						? "warning"
						: "muted";
			lines.push("", ...new Text(this.theme.fg(color, notification.message), 1, 0).render(width));
		}
		const statuses = Object.entries(uiState?.statuses ?? {}).filter(
			([key]) => key !== "working" && key !== TOKEN_SPEED_STATUS_KEY,
		);
		if (statuses.length) {
			lines.push(
				"",
				...new Text(statuses.map(([key, value]) => `${key}: ${value}`).join("\n"), 1, 0).render(
					width,
				),
			);
		}
		if (belowWidgets.length)
			lines.push("", ...new Text(belowWidgets.join("\n"), 1, 0).render(width));
		if (item.result.error)
			lines.push("", ...new Text(this.theme.fg("error", item.result.error), 1, 0).render(width));
		if (!item.result.done) {
			const frame = WORKING_FRAMES[this.spinnerFrame] ?? WORKING_FRAMES[0];
			const fallback =
				item.result.status === "queued"
					? "Queued..."
					: item.result.status === "stopping"
						? "Stopping and cleaning up..."
						: "Working...";
			const working = uiState?.statuses.working ?? fallback;
			lines.push("", ` ${this.theme.fg("warning", frame)} ${working}`);
		} else lines.push("", this.theme.fg("dim", ` ${formatUsage(item.result.usage)}`));
		return lines;
	}

	private footerHints(): Array<{ key: string; label: string }> {
		if (this.killArmed === "all")
			return [
				{ key: "Shift+K", label: "again to KILL ALL agents" },
				{ key: "Esc", label: "cancel" },
			];
		if (this.killArmed === "task")
			return [
				{ key: "k", label: "again to KILL this agent" },
				{ key: "Esc", label: "cancel" },
			];
		return [
			{ key: "↑/Esc", label: "parent" },
			{ key: "←/→", label: "agent" },
			{ key: "Shift+←/→", label: "history" },
			{ key: "PgUp/PgDn", label: "scroll" },
			{ key: "Ctrl+O", label: "details" },
			{ key: "k", label: "kill" },
			{ key: "Shift+K", label: "kill all" },
			{ key: "F6", label: "close" },
		];
	}

	render(width: number): string[] {
		const groups = this.groups();
		const current = this.currentGroup(groups);
		const contentWidth = getContentWidth(width);
		const height = Math.max(1, this.tui.terminal.rows);
		if (!current) {
			return renderFullscreenScreen({
				width,
				height,
				title: "Subagents",
				body: [this.theme.fg("muted", "No subagents in this session.")],
				keyHints: [{ key: "Esc/F6", label: "return" }],
				footerPadding: 1,
				theme: this.theme,
			});
		}
		const { group } = current;
		const item = group.items[this.selection.selected];
		const statusIcon = !item.result.done
			? (THREAD_STATUS_FRAMES[this.spinnerFrame % THREAD_STATUS_FRAMES.length] ??
				THREAD_STATUS_FRAMES[0])
			: item.result.error
				? "✗"
				: "✓";
		const statusColor = !item.result.done ? "warning" : item.result.error ? "error" : "success";
		const position = `Subagent ${this.selection.selected + 1}/${group.items.length}`;
		const statusPosition = `${statusIcon} ${position}`;
		const modelLabel = formatReadableModel(item.result.model, item.result.thinking);
		const contextLabel = formatContextLabel(item.result.contextUsage);
		const mode = item.result.mode ?? "ephemeral";
		const titleSegments = selectTitleSegments(contentWidth, [
			{ text: statusPosition, fixed: true },
			{ text: modelLabel, essential: true },
			{ text: contextLabel },
			{ text: mode },
		]);
		const teamContext = group.teamRunId
			? [`${this.getTeamName(group.teamRunId) ?? "Team"} team`, item.result.role].filter(
					(value): value is string => Boolean(value),
				)
			: [];
		const tokenSpeed = item.result.uiState?.statuses[TOKEN_SPEED_STATUS_KEY];
		const sessionLabel = item.result.sessionId ? `session ${item.result.sessionId}` : undefined;
		const workspaceSession =
			item.result.workspace === "worktree"
				? `${WORKTREE_METADATA_ICON}${sessionLabel ? ` ${sessionLabel}` : ""}`
				: sessionLabel;
		const metadataSegments = [
			...teamContext,
			workspaceSession,
			...titleSegments.dropped.map((segment) => segment.text),
			tokenSpeed,
		].filter((value): value is string => Boolean(value));
		const metadataLines = metadataSegments.length
			? wrapTextWithAnsi(metadataSegments.join(TITLE_SEPARATOR), Math.max(1, contentWidth))
			: [];
		const wrappedTask = new Text(item.result.task, 0, 0).render(contentWidth);
		const taskTitle = this.expanded ? wrappedTask : wrappedTask.slice(0, 3);
		if (!this.expanded && wrappedTask.length > 3 && taskTitle[2] !== undefined) {
			taskTitle[2] = truncateToWidth(taskTitle[2], Math.max(1, contentWidth - 1), "") + "…";
		}
		const plainHeaderTitle = titleSegments.selected.join(TITLE_SEPARATOR);
		// A nested status color emits an ANSI reset. Explicitly restyle the suffix
		// so that reset cannot cancel the header's accent color after the icon.
		const headerTitle = plainHeaderTitle.startsWith(statusIcon)
			? `${this.theme.fg(statusColor, this.theme.bold(statusIcon))}${this.theme.fg(
					"accent",
					this.theme.bold(plainHeaderTitle.slice(statusIcon.length)),
				)}`
			: plainHeaderTitle;
		const headerLines = [...metadataLines, "", ...taskTitle, ""];
		const renderedHeader = renderHeader({
			width,
			title: headerTitle,
			lines: headerLines,
			theme: this.theme,
		});
		const renderedFooter = renderFooter({
			width,
			hints: this.footerHints(),
			padding: 1,
			theme: this.theme,
		});
		const bodyHeight = Math.max(0, height - renderedHeader.length - renderedFooter.length);
		const content = this.contentLines(item, width);
		this.transcript.update(content.length, bodyHeight);
		if (this.followTail) this.transcript.end(true);
		const range = this.transcript.range;
		const body = content.slice(range.start, range.end);
		return renderFullscreenScreen({
			width,
			height,
			title: headerTitle,
			headerLines,
			body,
			bodyPaddingX: 0,
			keyHints: this.footerHints(),
			footerPadding: 1,
			theme: this.theme,
		});
	}

	handleInput(data: string): void {
		const groups = this.groups();
		const current = this.currentGroup(groups);
		if (matchesKey(data, "escape") && this.killArmed) {
			this.killArmed = undefined;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "up") || matchesKey(data, "f6")) {
			this.done();
			return;
		}
		if (!current) return;
		const { group, index: groupIndex } = current;
		const item = group.items[this.selection.selected];
		const killAllKey = matchesKey(data, "shift+k");
		const killTaskKey = matchesKey(data, "k");
		if (killTaskKey || killAllKey) {
			const target = killAllKey ? "all" : "task";
			const canKill =
				target === "all"
					? groups.some((candidate) =>
							candidate.items.some((candidateItem) => !candidateItem.result.done),
						)
					: !item.result.done;
			if (!canKill) {
				this.killArmed = undefined;
				this.tui.requestRender();
				return;
			}
			if (this.killArmed !== target) {
				this.killArmed = target;
				this.tui.requestRender();
				return;
			}
			if (target === "all") this.killAll();
			else this.killTask(item.runId, item.result.taskId);
			this.killArmed = undefined;
			this.tui.requestRender();
			return;
		}
		this.killArmed = undefined;
		if (matchesKey(data, "ctrl+o")) {
			this.expanded = !this.expanded;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "shift+left") || matchesKey(data, "shift+right")) {
			this.selectedByGroup.set(group.key, this.selection.selected);
			const delta = matchesKey(data, "shift+left") ? -1 : 1;
			const nextGroup = groups[(groupIndex + delta + groups.length) % groups.length];
			this.selectedGroupKey = nextGroup.key;
			this.selection.selected = this.selectedByGroup.get(nextGroup.key) ?? 0;
			this.transcript.home();
			this.followTail = true;
			this.onGroupSelect?.(nextGroup.key);
			this.onSelect?.(nextGroup.items[this.selection.selected]?.result.taskId, nextGroup.key);
		} else if (matchesKey(data, "left") || matchesKey(data, "right")) {
			const delta = matchesKey(data, "left") ? -1 : 1;
			this.selection.selected =
				(this.selection.selected + delta + group.items.length) % group.items.length;
			this.selectedByGroup.set(group.key, this.selection.selected);
			this.transcript.home();
			this.followTail = true;
			this.onSelect?.(group.items[this.selection.selected].result.taskId, group.key);
		} else if (matchesKey(data, "pageUp")) {
			this.transcript.pageBy(-1);
			this.followTail = false;
		} else if (matchesKey(data, "pageDown")) {
			this.transcript.pageBy(1);
			this.followTail = false;
		} else if (matchesKey(data, "home")) {
			this.transcript.home();
			this.followTail = false;
		} else if (matchesKey(data, "end")) {
			this.transcript.end(true);
			this.followTail = true;
		}
		this.tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.animationTimer);
		this.unsubscribe();
	}
}

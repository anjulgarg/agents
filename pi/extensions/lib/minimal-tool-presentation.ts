/**
 * Render-only compact presentation for the parent built-in tools.
 *
 * The parent minimal-mode extension registers executable tools and delegates
 * their `renderCall` / `renderResult` behavior here, so any read-only viewer
 * (for example the F6 subagent thread) can render the exact same compact rows
 * without gaining execution authority. Every presentation instance owns its
 * soft-group tracker, edit-failure isolation, and render-local activity state;
 * two views never share transcript topology or timing.
 *
 * Unsupported tools are outside this registry and keep Pi's generic renderer.
 */

import { renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { homedir } from "os";
import {
	SoftGroupTracker,
	SynchronizedShimmerRender,
	TOOL_CHAT_PADDING,
	emptyCollapsedToolRender,
	formatToolDuration,
	renderSoftGroupedCall,
	syncToolActivity,
	type ToolActivitySnapshot,
} from "./tui/index.ts";

/** Matches the compact chrome used by the parent minimal-mode extension. */
const CHAT_PADDING = TOOL_CHAT_PADDING;
const COMMAND_PREFIX = "$ ";

/**
 * Shorten a path by replacing home directory with ~
 */
function shortenPath(path: string): string {
	const home = homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((part) => part.type === "text")?.text ?? "";
}

function firstLine(text: string): string {
	return (text.split(/\r?\n/, 1)[0] ?? "").replace(/\s+/g, " ").trim();
}

type BashTimingDetails = {
	durationMs?: number;
};

function bashDurationMs(details: unknown, activity: ToolActivitySnapshot): number | undefined {
	if (details && typeof details === "object" && "durationMs" in details) {
		const durationMs = (details as BashTimingDetails).durationMs;
		if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
			return durationMs;
		}
	}
	return activity.elapsedMs;
}

function durationSuffix(durationMs: number | undefined): string {
	const duration = formatToolDuration(durationMs);
	return duration ? ` · ${duration}` : "";
}

function compactFailure(theme: Theme, message: string): Component {
	return new Text(
		`${theme.fg("error", "×")} ${theme.fg("muted", firstLine(message) || "Tool failed")}`,
		CHAT_PADDING,
		0,
	);
}

function shimmerTheme(theme: Theme) {
	return {
		fg: (name: string, text: string) => theme.fg(name as Parameters<Theme["fg"]>[0], text),
		bold: (text: string) => theme.bold(text),
	};
}

function bashFailureSuffix(text: string): string {
	const exit = text.match(/exited with code\s+(\d+)/i)?.[1];
	if (exit) return ` · exit ${exit}`;
	if (/timeout/i.test(text)) return " · timeout";
	if (/aborted|cancelled/i.test(text)) return " · cancelled";
	return " · failed";
}

function diffStats(diff: string | undefined): string | undefined {
	if (!diff) return undefined;
	let additions = 0;
	let removals = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		if (line.startsWith("-") && !line.startsWith("---")) removals++;
	}
	return `+${additions} −${removals}`;
}

function looksLikeTruncatedBashOutput(text: string): boolean {
	return (
		/\bShowing (?:last|lines)\b/i.test(text) ||
		/\(50(?:\.0)?KB limit\)/i.test(text) ||
		/\(whichever is hit first\)/i.test(text) ||
		/\boutput truncated\b/i.test(text) ||
		/\[Truncated:/i.test(text) ||
		text.length > 50 * 1024 ||
		text.split("\n").length > 2000
	);
}

export function compactCommandLines(command: string, width: number): string[] {
	const available = Math.max(1, width - visibleWidth(COMMAND_PREFIX));
	const normalized = command.replace(/\s+/g, " ").trim() || "(empty command)";
	const wrapped = wrapTextWithAnsi(normalized, available);
	return wrapped.slice(0, 2);
}

function pinSuffix(lines: string[], suffix: string, bodyWidth: number): string[] {
	if (!suffix) return lines;
	const room = Math.max(0, bodyWidth - visibleWidth(suffix));
	const pinned = [...lines];
	const lastIndex = Math.max(0, pinned.length - 1);
	const last = pinned[lastIndex] ?? "";
	pinned[lastIndex] = `${truncateToWidth(last, room, "")}${suffix}`;
	return pinned;
}

export class MinimalCommand implements Component {
	constructor(
		private readonly command: string,
		private readonly timeout: number | undefined,
		private readonly expanded: boolean,
		private readonly theme: Theme,
		private readonly prefix = COMMAND_PREFIX,
		/** Pre-styled suffix (exit status, duration). Appended after the muted body. */
		private readonly statusSuffix = "",
	) {}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const timeoutSuffix = this.timeout ? ` (timeout ${this.timeout}s)` : "";
		const commandText =
			`${this.command}${timeoutSuffix}`.replace(/\s+/g, " ").trim() || "(empty command)";
		const prefixWidth = visibleWidth(this.prefix);
		if (renderWidth <= prefixWidth) {
			return [truncateToWidth(`${this.prefix}${commandText}${this.statusSuffix}`, renderWidth, "")];
		}
		const bodyWidth = renderWidth - prefixWidth;
		const suffixWidth = this.expanded ? 0 : visibleWidth(this.statusSuffix);
		const lines = this.expanded
			? `${commandText}${this.statusSuffix}`
					.split("\n")
					.flatMap((line) => wrapTextWithAnsi(line || " ", bodyWidth))
			: // Collapsed rows keep only two lines; pin the pre-styled status onto
				// the last line after muting the command body so exit/duration colors
				// are not wiped by a second theme wrap.
				pinSuffix(
					wrapTextWithAnsi(commandText, Math.max(1, bodyWidth - suffixWidth)).slice(0, 2),
					"",
					bodyWidth,
				);
		return lines.map((line, index) => {
			const prefix =
				index === 0
					? this.theme.fg("toolTitle", this.theme.bold(this.prefix))
					: " ".repeat(prefixWidth);
			const isLast = index === lines.length - 1;
			const suffix = !this.expanded && isLast ? this.statusSuffix : "";
			const room = Math.max(0, bodyWidth - visibleWidth(suffix));
			const body = this.theme.fg("muted", suffix ? truncateToWidth(line, room, "") : line);
			return `${prefix}${body}${suffix}`;
		});
	}

	invalidate(): void {}
}

/** Render one stable inspection call through the shared consecutive grouper. */
function renderToolCallLine(
	tracker: SoftGroupTracker,
	theme: Theme,
	label: string,
	summary: string,
	context: ToolRenderContext,
	summaryTail?: string,
): Component {
	return renderSoftGroupedCall({
		tracker,
		groupId: label,
		label,
		summary,
		summaryTail,
		theme: {
			fg: (name, text) => theme.fg(name as Parameters<Theme["fg"]>[0], text),
			bold: (text) => theme.bold(text),
		},
		context,
	});
}

/**
 * Render-local context compatible with the Pi `ToolRenderContext` fields the
 * compact callbacks consume. Callers pass the host context through unchanged.
 */
export type ToolRenderContext = {
	args: Record<string, unknown>;
	toolCallId?: string;
	invalidate?: () => void;
	lastComponent?: unknown;
	state?: Record<string, unknown>;
	cwd?: string;
	executionStarted?: boolean;
	argsComplete?: boolean;
	isPartial?: boolean;
	expanded?: boolean;
	showImages?: boolean;
	isError?: boolean;
};

export type ToolRenderResultOptions = {
	expanded?: boolean;
	isPartial?: boolean;
};

export type ToolResult = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
};

/**
 * Render-only presentation for one supported tool: `renderCall` and
 * `renderResult` only. No executable function, no parameter schema, and no
 * result mutation live here.
 */
export type MinimalToolPresentation = {
	renderCall: (
		args: Record<string, unknown>,
		theme: Theme,
		context: ToolRenderContext,
	) => Component;
	renderResult: (
		result: ToolResult,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext,
	) => Component;
};

export const MINIMAL_TOOL_NAMES = ["read", "bash", "write", "edit", "find", "grep", "ls"] as const;

export type MinimalToolName = (typeof MINIMAL_TOOL_NAMES)[number];

export type MinimalToolPresentations = Record<MinimalToolName, MinimalToolPresentation>;

export type MinimalToolPresentationBundle = {
	/** One presentation per supported tool, sharing this view's tracker. */
	presentations: MinimalToolPresentations;
	/**
	 * Per-view soft-group tracker. Bind it to extension events with
	 * `bindSoftGroupTracker`, or seed it from ordered transcript messages with
	 * `seedSessionTopology`.
	 */
	tracker: SoftGroupTracker;
	/**
	 * Clear per-view render-local state (edit-failure isolation and activity
	 * carriers). Tracker reset and topology seeding stay with the view.
	 */
	reset: () => void;
};

/**
 * Create an isolated set of render-only presentations for exactly
 * read, bash, write, edit, find, grep, and ls.
 */
export function createMinimalToolPresentations(): MinimalToolPresentationBundle {
	const tracker = new SoftGroupTracker({ allowInterleavedGroups: true });
	const isolatedEditFailures = new Set<string>();
	const viewActivity = new Map<string, Record<string, unknown>>();

	// The host always owns per-call `context.state`; only when a caller omits it
	// do we supply an instance-scoped carrier so two views can never share
	// activity timing for identical tool-call IDs.
	function withCallState(context: ToolRenderContext): ToolRenderContext {
		if (context.state && typeof context.state === "object") return context;
		const toolCallId = context.toolCallId?.trim();
		if (!toolCallId) return context;
		let state = viewActivity.get(toolCallId);
		if (!state) {
			state = {};
			viewActivity.set(toolCallId, state);
		}
		return { ...context, state };
	}

	const presentations: MinimalToolPresentations = {
		read: {
			renderCall(args, theme, context) {
				const path = shortenPath(String(args.path || "")) || "...";
				let pathSummary = path;
				if (args.offset !== undefined || args.limit !== undefined) {
					const startLine = Number(args.offset ?? 1);
					const endLine = args.limit !== undefined ? startLine + Number(args.limit) - 1 : "";
					pathSummary += `:${startLine}${endLine ? `-${endLine}` : ""}`;
				}
				return renderToolCallLine(tracker, theme, "read", "", withCallState(context), pathSummary);
			},

			renderResult(result, { expanded, isPartial }, theme, context) {
				if (!expanded) {
					return context.isError && !isPartial
						? compactFailure(theme, firstText(result))
						: emptyCollapsedToolRender();
				}

				// Expanded mode: show full output
				const textContent = result.content.find((c) => c.type === "text");
				if (!textContent || textContent.type !== "text") {
					return new Text("", CHAT_PADDING, 0);
				}

				const lines = textContent.text.split("\n");
				const output = lines.map((line) => theme.fg("toolOutput", line)).join("\n");
				return new Text(`\n${output}`, CHAT_PADDING, 0);
			},
		},

		bash: {
			renderCall(args, theme, context) {
				const activity = syncToolActivity(withCallState(context));
				const container = new Box(CHAT_PADDING, 0);
				if (context.expanded) {
					container.addChild(
						new MinimalCommand(
							String(args.command || "..."),
							args.timeout as number | undefined,
							true,
							theme,
						),
					);
					return container;
				}
				if (!activity.active) return emptyCollapsedToolRender();
				container.addChild(
					new MinimalCommand(
						String(args.command || "..."),
						args.timeout as number | undefined,
						false,
						theme,
						COMMAND_PREFIX,
						theme.fg("muted", ` · running ${formatToolDuration(activity.elapsedMs) ?? "0.0s"}`),
					),
				);
				return new SynchronizedShimmerRender(container, shimmerTheme(theme), activity);
			},

			renderResult(result, { expanded, isPartial }, theme, context) {
				const activity = syncToolActivity(withCallState(context));
				const textContent = result.content.find((c) => c.type === "text");
				const raw = textContent?.type === "text" ? textContent.text : "";
				if (!expanded) {
					if (isPartial) return emptyCollapsedToolRender();
					const container = new Box(CHAT_PADDING, 0);
					const failure = context.isError ? theme.fg("error", bashFailureSuffix(raw)) : "";
					const duration = theme.fg(
						"muted",
						durationSuffix(bashDurationMs(result.details, activity)),
					);
					container.addChild(
						new MinimalCommand(
							String(context.args.command || "..."),
							context.args.timeout as number | undefined,
							false,
							theme,
							COMMAND_PREFIX,
							`${failure}${duration}`,
						),
					);
					return container;
				}

				const output = raw
					.trim()
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n");
				const truncated = looksLikeTruncatedBashOutput(raw);
				const truncationNotice = truncated ? `\n${theme.fg("dim", "... output truncated")}` : "";
				const timing = formatToolDuration(bashDurationMs(result.details, activity));
				const timingNotice = timing ? `\n${theme.fg("muted", `Took ${timing}`)}` : "";
				if (!output && !truncated && !timing) return new Text("", CHAT_PADDING, 0);
				return new Text(`\n${output}${truncationNotice}${timingNotice}`, CHAT_PADDING, 0);
			},
		},

		write: {
			renderCall(args, theme, context) {
				const activity = syncToolActivity(withCallState(context));
				const path = shortenPath(String(args.path || "")) || "...";
				const lineCount = typeof args.content === "string" ? args.content.split("\n").length : 0;
				const lineInfo = lineCount > 0 ? ` · ${lineCount} lines` : "";
				const running = activity.active
					? ` · running ${formatToolDuration(activity.elapsedMs) ?? "0.0s"}`
					: "";
				const content = new Text(
					`${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("muted", path)}` +
						theme.fg("muted", `${lineInfo}${running}`),
					CHAT_PADDING,
					0,
				);
				if (context.expanded) return content;
				return activity.active
					? new SynchronizedShimmerRender(content, shimmerTheme(theme), activity)
					: emptyCollapsedToolRender();
			},

			renderResult(result, { expanded, isPartial }, theme, context) {
				const activity = syncToolActivity(withCallState(context));
				if (!expanded) {
					if (isPartial) return emptyCollapsedToolRender();
					const path = shortenPath(String(context.args.path || "")) || "...";
					const lineCount =
						typeof context.args.content === "string" ? context.args.content.split("\n").length : 0;
					const details = [
						lineCount > 0 ? `${lineCount} lines` : undefined,
						formatToolDuration(activity.elapsedMs),
					]
						.filter(Boolean)
						.join(" · ");
					const prefix = context.isError ? `${theme.fg("error", "×")} ` : "";
					return new Text(
						`${prefix}${theme.fg("toolTitle", "write")} ${theme.fg("muted", path)}` +
							theme.fg("muted", details ? ` · ${details}` : ""),
						CHAT_PADDING,
						0,
					);
				}

				// Expanded mode: show error if any
				if (result.content.some((c) => c.type === "text" && c.text)) {
					const textContent = result.content.find((c) => c.type === "text");
					if (textContent?.type === "text" && textContent.text) {
						return new Text(
							`\n${theme.fg(context.isError ? "error" : "toolOutput", textContent.text)}`,
							CHAT_PADDING,
							0,
						);
					}
				}

				return new Text("", CHAT_PADDING, 0);
			},
		},

		edit: {
			renderCall(args, theme, context) {
				const activity = syncToolActivity(withCallState(context));
				const path = shortenPath(String(args.path || "")) || "...";
				const running = activity.active
					? ` · running ${formatToolDuration(activity.elapsedMs) ?? "0.0s"}`
					: "";
				const content = new Text(
					`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("muted", path)}` +
						theme.fg("muted", running),
					CHAT_PADDING,
					0,
				);
				if (context.expanded) return content;
				return activity.active
					? new SynchronizedShimmerRender(content, shimmerTheme(theme), activity)
					: emptyCollapsedToolRender();
			},

			renderResult(result, { expanded, isPartial }, theme, context) {
				const activity = syncToolActivity(withCallState(context));
				const diff = (result.details as { diff?: unknown } | undefined)?.diff;
				const path = shortenPath(String(context.args.path || "")) || "...";
				const stats = diffStats(typeof diff === "string" ? diff : undefined);
				const details = [stats, formatToolDuration(activity.elapsedMs)].filter(Boolean).join(" · ");
				let receipt: Component | undefined;
				if (!isPartial) {
					const toolCallId = context.toolCallId?.trim();
					if (context.isError && toolCallId && !isolatedEditFailures.has(toolCallId)) {
						isolatedEditFailures.add(toolCallId);
						if (!tracker.has(toolCallId)) {
							tracker.seedItem({ groupId: "edit", toolCallId, label: "edit" });
						}
					}
					receipt = renderToolCallLine(
						tracker,
						theme,
						"edit",
						`${path}${details ? ` · ${details}` : ""}`,
						{ ...withCallState(context), expanded },
					);
				}

				if (!expanded) {
					if (isPartial) return emptyCollapsedToolRender();
					if (!context.isError) return receipt ?? emptyCollapsedToolRender();
					return new Text(
						`${theme.fg("error", "×")} ${theme.fg("toolTitle", "edit")} ${theme.fg("muted", path)}` +
							theme.fg("muted", details ? ` · ${details}` : ""),
						CHAT_PADDING,
						0,
					);
				}

				if (typeof diff === "string" && diff) {
					return new Text(`\n${renderDiff(diff)}`, CHAT_PADDING, 0);
				}

				const textContent = result.content.find((c) => c.type === "text");
				if (!textContent || textContent.type !== "text") {
					return new Text("", CHAT_PADDING, 0);
				}
				const color = context.isError ? "error" : "toolOutput";
				return new Text(`\n${theme.fg(color, textContent.text)}`, CHAT_PADDING, 0);
			},
		},

		find: {
			renderCall(args, theme, context) {
				const pattern = String(args.pattern || "...");
				const path = shortenPath(String(args.path || "."));
				const limit = args.limit !== undefined ? ` · limit ${args.limit}` : "";
				return renderToolCallLine(
					tracker,
					theme,
					"find",
					`${pattern}${limit}`,
					withCallState(context),
					`in ${path}`,
				);
			},

			renderResult(result, { expanded, isPartial }, theme, context) {
				if (!expanded) {
					return context.isError && !isPartial
						? compactFailure(theme, firstText(result))
						: emptyCollapsedToolRender();
				}

				// Expanded: show full results
				const textContent = result.content.find((c) => c.type === "text");
				if (!textContent || textContent.type !== "text") {
					return new Text("", CHAT_PADDING, 0);
				}

				const output = textContent.text
					.trim()
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n");

				return new Text(`\n${output}`, CHAT_PADDING, 0);
			},
		},

		grep: {
			renderCall(args, theme, context) {
				const pattern = String(args.pattern || "...");
				const path = shortenPath(String(args.path || "."));
				const details = [
					typeof args.glob === "string" ? args.glob : undefined,
					args.outputMode && args.outputMode !== "content"
						? String(args.outputMode).replace(/_/g, " ")
						: undefined,
					args.limit !== undefined ? `limit ${args.limit}` : undefined,
				]
					.filter(Boolean)
					.join(" · ");
				const summary = `/${pattern}/${details ? ` · ${details}` : ""}`;
				return renderToolCallLine(
					tracker,
					theme,
					"grep",
					summary,
					withCallState(context),
					`in ${path}`,
				);
			},

			renderResult(result, { expanded, isPartial }, theme, context) {
				if (!expanded) {
					return context.isError && !isPartial
						? compactFailure(theme, firstText(result))
						: emptyCollapsedToolRender();
				}

				// Expanded: show full results
				const textContent = result.content.find((c) => c.type === "text");
				if (!textContent || textContent.type !== "text") {
					return new Text("", CHAT_PADDING, 0);
				}

				const output = textContent.text
					.trim()
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n");

				return new Text(`\n${output}`, CHAT_PADDING, 0);
			},
		},

		ls: {
			renderCall(args, theme, context) {
				const path = shortenPath(String(args.path || "."));
				const summary = `${path}${args.limit !== undefined ? ` · limit ${args.limit}` : ""}`;
				return renderToolCallLine(tracker, theme, "ls", "", withCallState(context), summary);
			},

			renderResult(result, { expanded, isPartial }, theme, context) {
				if (!expanded) {
					return context.isError && !isPartial
						? compactFailure(theme, firstText(result))
						: emptyCollapsedToolRender();
				}

				// Expanded: show full listing
				const textContent = result.content.find((c) => c.type === "text");
				if (!textContent || textContent.type !== "text") {
					return new Text("", CHAT_PADDING, 0);
				}

				const output = textContent.text
					.trim()
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n");

				return new Text(`\n${output}`, CHAT_PADDING, 0);
			},
		},
	};

	return {
		presentations,
		tracker,
		reset() {
			isolatedEditFailures.clear();
			viewActivity.clear();
		},
	};
}

/**
 * Compact built-in tool rendering for the default Pi transcript.
 *
 * Stable inspection calls and successful edit receipts soft-group by exact
 * tool name. Active rows shimmer, Bash/write receipts stay individually
 * visible, and full output remains behind Ctrl+O. Failures stay attributable.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	renderDiff,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "os";
import { Type } from "typebox";
import {
	DEFAULT_SUMMARY_LIMIT,
	GREP_OUTPUT_MODES,
	resolveRipgrepPath,
	runGrepSummary,
} from "./lib/grep-summary.ts";
import {
	SoftGroupTracker,
	SynchronizedShimmerRender,
	TOOL_CHAT_PADDING,
	bindSoftGroupTracker,
	emptyCollapsedToolRender,
	formatToolDuration,
	renderSoftGroupedCall,
	syncToolActivity,
	type SoftGroupRenderContext,
	type ToolActivitySnapshot,
} from "./lib/tui/index.ts";

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

const CHAT_PADDING = TOOL_CHAT_PADDING;
const COMMAND_PREFIX = "$ ";

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
	context: SoftGroupRenderContext,
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

// Cache for built-in tools by cwd
const toolCache = new Map<string, ReturnType<typeof createBuiltInTools>>();

function createBuiltInTools(cwd: string) {
	return {
		read: createReadTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		find: createFindTool(cwd),
		grep: createGrepTool(cwd),
		ls: createLsTool(cwd),
	};
}

function getBuiltInTools(cwd: string) {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
}

/**
 * Built-in grep parameters plus outputMode.
 *
 * Mirrors the upstream schema so content searches keep delegating unchanged;
 * the minimal-mode test guards against upstream adding parameters.
 */
export const GrepParams = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(
		Type.String({ description: "Directory or file to search (default: current directory)" }),
	),
	glob: Type.Optional(
		Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" }),
	),
	ignoreCase: Type.Optional(
		Type.Boolean({ description: "Case-insensitive search (default: false)" }),
	),
	literal: Type.Optional(
		Type.Boolean({
			description: "Treat pattern as literal string instead of regex (default: false)",
		}),
	),
	context: Type.Optional(
		Type.Number({
			description:
				"Number of lines to show before and after each match (default: 0). Content mode only",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum matches to return, or maximum files in summary modes (default: 100)",
		}),
	),
	outputMode: Type.Optional(
		StringEnum(GREP_OUTPUT_MODES, {
			description:
				"content returns matching lines (default), files_with_matches returns matching file paths, " +
				"count returns per-file match totals. Prefer the summary modes for broad patterns",
			default: "content",
		}),
	),
});

/**
 * Pi downloads ripgrep on demand from inside its built-in grep, and that
 * downloader is not exported, so a single warm-up search installs the binary
 * that summary modes then run directly.
 */
async function ensureRipgrep(warmUp: () => Promise<unknown>): Promise<string> {
	const existing = resolveRipgrepPath();
	if (existing) return existing;
	await warmUp();
	const installed = resolveRipgrepPath();
	if (!installed) {
		throw new Error("ripgrep (rg) is not available and could not be downloaded");
	}
	return installed;
}

export default function (pi: ExtensionAPI) {
	const bashDurations = new Map<string, number>();
	const isolatedEditFailures = new Set<string>();
	const toolGroupTracker = new SoftGroupTracker();
	bindSoftGroupTracker(pi as any, toolGroupTracker, ["read", "find", "grep", "ls", "edit"]);
	pi.on("session_start", () => isolatedEditFailures.clear());

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") return;
		const durationMs = bashDurations.get(event.toolCallId);
		if (durationMs === undefined) return;
		bashDurations.delete(event.toolCallId);
		const details = event.details && typeof event.details === "object" ? event.details : {};
		return { details: { ...details, durationMs } };
	});

	pi.on("session_shutdown", () => {
		bashDurations.clear();
	});

	// =========================================================================
	// Read Tool
	// =========================================================================
	pi.registerTool({
		name: "read",
		label: "read",
		renderShell: "self",
		description:
			"Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files.",
		parameters: getBuiltInTools(process.cwd()).read.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tools = getBuiltInTools(ctx.cwd);
			return tools.read.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			const path = shortenPath(args.path || "") || "...";
			let pathSummary = path;
			if (args.offset !== undefined || args.limit !== undefined) {
				const startLine = args.offset ?? 1;
				const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
				pathSummary += `:${startLine}${endLine ? `-${endLine}` : ""}`;
			}
			return renderToolCallLine(toolGroupTracker, theme, "read", "", context, pathSummary);
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
	});

	// =========================================================================
	// Bash Tool
	// =========================================================================
	pi.registerTool({
		name: "bash",
		label: "bash",
		renderShell: "self",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first).",
		parameters: getBuiltInTools(process.cwd()).bash.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tools = getBuiltInTools(ctx.cwd);
			const startedAt = performance.now();
			try {
				return await tools.bash.execute(toolCallId, params, signal, onUpdate);
			} finally {
				bashDurations.set(toolCallId, Math.max(0, performance.now() - startedAt));
			}
		},

		renderCall(args, theme, context) {
			const activity = syncToolActivity(context);
			const container = new Box(CHAT_PADDING, 0);
			if (context.expanded) {
				container.addChild(
					new MinimalCommand(
						args.command || "...",
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
					args.command || "...",
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
			const activity = syncToolActivity(context);
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
						context.args.command || "...",
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
	});

	// =========================================================================
	// Write Tool
	// =========================================================================
	pi.registerTool({
		name: "write",
		label: "write",
		renderShell: "self",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: getBuiltInTools(process.cwd()).write.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tools = getBuiltInTools(ctx.cwd);
			return tools.write.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			const activity = syncToolActivity(context);
			const path = shortenPath(args.path || "") || "...";
			const lineCount = args.content ? args.content.split("\n").length : 0;
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
			const activity = syncToolActivity(context);
			if (!expanded) {
				if (isPartial) return emptyCollapsedToolRender();
				const path = shortenPath(context.args.path || "") || "...";
				const lineCount = context.args.content ? context.args.content.split("\n").length : 0;
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
	});

	// =========================================================================
	// Edit Tool
	// =========================================================================
	pi.registerTool({
		name: "edit",
		label: "edit",
		renderShell: "self",
		description:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
		parameters: getBuiltInTools(process.cwd()).edit.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tools = getBuiltInTools(ctx.cwd);
			return tools.edit.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			const activity = syncToolActivity(context);
			const path = shortenPath(args.path || "") || "...";
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
			const activity = syncToolActivity(context);
			const diff = (result.details as { diff?: unknown } | undefined)?.diff;
			const path = shortenPath(context.args.path || "") || "...";
			const stats = diffStats(typeof diff === "string" ? diff : undefined);
			const details = [stats, formatToolDuration(activity.elapsedMs)].filter(Boolean).join(" · ");
			let receipt: Component | undefined;
			if (!isPartial) {
				const toolCallId = context.toolCallId?.trim();
				if (context.isError && toolCallId && !isolatedEditFailures.has(toolCallId)) {
					isolatedEditFailures.add(toolCallId);
					if (!toolGroupTracker.has(toolCallId)) {
						toolGroupTracker.seedItem({ groupId: "edit", toolCallId, label: "edit" });
					}
				}
				receipt = renderToolCallLine(
					toolGroupTracker,
					theme,
					"edit",
					`${path}${details ? ` · ${details}` : ""}`,
					{ ...context, expanded },
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
	});

	// =========================================================================
	// Find Tool
	// =========================================================================
	pi.registerTool({
		name: "find",
		label: "find",
		renderShell: "self",
		description:
			"Find files by name pattern (glob). Searches recursively from the specified path. Output limited to 200 results.",
		parameters: getBuiltInTools(process.cwd()).find.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tools = getBuiltInTools(ctx.cwd);
			return tools.find.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			const pattern = args.pattern || "...";
			const path = shortenPath(args.path || ".");
			const limit = args.limit !== undefined ? ` · limit ${args.limit}` : "";
			return renderToolCallLine(
				toolGroupTracker,
				theme,
				"find",
				`${pattern}${limit}`,
				context,
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
	});

	// =========================================================================
	// Grep Tool
	// =========================================================================
	pi.registerTool({
		name: "grep",
		label: "grep",
		renderShell: "self",
		description:
			"Search file contents by regex pattern. Uses ripgrep for fast searching. Output limited to 100 matches. " +
			"Use outputMode=files_with_matches or count to survey a broad pattern before reading lines.",
		parameters: GrepParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { outputMode = "content", ...builtInParams } = params;
			const tools = getBuiltInTools(ctx.cwd);
			if (outputMode === "content") {
				return tools.grep.execute(toolCallId, builtInParams, signal, onUpdate);
			}

			const searchPath = resolve(ctx.cwd, builtInParams.path || ".");
			let isDirectory: boolean;
			try {
				isDirectory = (await stat(searchPath)).isDirectory();
			} catch {
				throw new Error(`Path not found: ${searchPath}`);
			}
			const rgPath = await ensureRipgrep(() =>
				tools.grep.execute(toolCallId, { ...builtInParams, limit: 1 }, signal, onUpdate),
			);
			const summary = await runGrepSummary(
				rgPath,
				{
					mode: outputMode,
					pattern: builtInParams.pattern,
					searchPath,
					glob: builtInParams.glob,
					ignoreCase: builtInParams.ignoreCase,
					literal: builtInParams.literal,
				},
				{ isDirectory, limit: builtInParams.limit ?? DEFAULT_SUMMARY_LIMIT, signal },
			);
			return { ...summary, details: summary.details ?? {} };
		},

		renderCall(args, theme, context) {
			const pattern = args.pattern || "...";
			const path = shortenPath(args.path || ".");
			const details = [
				args.glob,
				args.outputMode && args.outputMode !== "content"
					? args.outputMode.replace(/_/g, " ")
					: undefined,
				args.limit !== undefined ? `limit ${args.limit}` : undefined,
			]
				.filter(Boolean)
				.join(" · ");
			const summary = `/${pattern}/${details ? ` · ${details}` : ""}`;
			return renderToolCallLine(toolGroupTracker, theme, "grep", summary, context, `in ${path}`);
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
	});

	// =========================================================================
	// Ls Tool
	// =========================================================================
	pi.registerTool({
		name: "ls",
		label: "ls",
		renderShell: "self",
		description:
			"List directory contents with file sizes. Shows files and directories with their sizes. Output limited to 500 entries.",
		parameters: getBuiltInTools(process.cwd()).ls.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tools = getBuiltInTools(ctx.cwd);
			return tools.ls.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			const path = shortenPath(args.path || ".");
			const summary = `${path}${args.limit !== undefined ? ` · limit ${args.limit}` : ""}`;
			return renderToolCallLine(toolGroupTracker, theme, "ls", "", context, summary);
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
	});
}

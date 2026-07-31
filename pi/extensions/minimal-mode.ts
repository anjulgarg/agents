/**
 * Compact built-in tool rendering for the default Pi transcript.
 *
 * Stable inspection calls and successful edit receipts soft-group by exact
 * tool name. Active rows shimmer, Bash/write receipts stay individually
 * visible, and full output remains behind Ctrl+O. Failures stay attributable.
 *
 * Tool execution, parameter schemas, grep behavior, output limits, event
 * binding, and result-detail mutation live here; the render callbacks delegate
 * to the shared render-only presentation registry so read-only viewers can
 * reuse identical compact chrome without gaining execution authority.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import {
	DEFAULT_SUMMARY_LIMIT,
	GREP_OUTPUT_MODES,
	resolveRipgrepPath,
	runGrepSummary,
} from "./lib/grep-summary.ts";
import {
	createMinimalToolPresentations,
	MinimalCommand,
	compactCommandLines,
	type MinimalToolPresentationBundle,
} from "./lib/minimal-tool-presentation.ts";
import { bindSoftGroupTracker } from "./lib/tui/index.ts";

export { MinimalCommand, compactCommandLines } from "./lib/minimal-tool-presentation.ts";

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
	const presentation: MinimalToolPresentationBundle = createMinimalToolPresentations();
	bindSoftGroupTracker(pi as any, presentation.tracker, ["read", "find", "grep", "ls", "edit"], {
		nonBreakingToolNames: ["announce_step"],
	});
	pi.on("session_start", () => presentation.reset());

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

		renderCall: (args, theme, context) =>
			presentation.presentations.read.renderCall(args, theme, context),

		renderResult: (result, options, theme, context) =>
			presentation.presentations.read.renderResult(result, options, theme, context),
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

		renderCall: (args, theme, context) =>
			presentation.presentations.bash.renderCall(args, theme, context),

		renderResult: (result, options, theme, context) =>
			presentation.presentations.bash.renderResult(result, options, theme, context),
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

		renderCall: (args, theme, context) =>
			presentation.presentations.write.renderCall(args, theme, context),

		renderResult: (result, options, theme, context) =>
			presentation.presentations.write.renderResult(result, options, theme, context),
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

		renderCall: (args, theme, context) =>
			presentation.presentations.edit.renderCall(args, theme, context),

		renderResult: (result, options, theme, context) =>
			presentation.presentations.edit.renderResult(result, options, theme, context),
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

		renderCall: (args, theme, context) =>
			presentation.presentations.find.renderCall(args, theme, context),

		renderResult: (result, options, theme, context) =>
			presentation.presentations.find.renderResult(result, options, theme, context),
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

		renderCall: (args, theme, context) =>
			presentation.presentations.grep.renderCall(args, theme, context),

		renderResult: (result, options, theme, context) =>
			presentation.presentations.grep.renderResult(result, options, theme, context),
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

		renderCall: (args, theme, context) =>
			presentation.presentations.ls.renderCall(args, theme, context),

		renderResult: (result, options, theme, context) =>
			presentation.presentations.ls.renderResult(result, options, theme, context),
	});
}

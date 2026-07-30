/**
 * TypeScript/JavaScript LSP navigation, diagnostics, and safe rename for Pi.
 *
 * Lazily starts typescript-language-server --stdio per workspace root.
 * Does not auto-install the server.
 */

import * as fs from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	Text,
	truncateToWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	SoftGroupTracker,
	bindSoftGroupTracker,
	emptyCollapsedToolRender,
	renderSoftGroupedCall,
} from "../lib/tui/index.ts";
import {
	diagnosticsToRows,
	formatDiagnostics,
	formatDocumentSymbols,
	formatHover,
	formatLocationList,
	formatWorkspaceSymbols,
	mapDocumentSymbols,
	mapWorkspaceSymbols,
	DEFAULT_MAX_RESULTS,
} from "./client.ts";
import { LspManager, type ActiveServerStatus } from "./manager.ts";
import { PathSecurityError, resolveWorkspacePath } from "./paths.ts";
import { resolveColumn } from "./position.ts";
import { isSupportedSourcePath } from "./servers.ts";
import { applyWorkspaceEdit, validateWorkspaceEdit, WorkspaceEditError } from "./workspace-edit.ts";
import { boundToolOutput, formatLocationTag, locationFromLsp, oneBasedToLsp } from "./format.ts";
import {
	fullscreenOverlayOptions,
	getContentWidth,
	renderFullscreenScreen,
	SelectableViewportState,
} from "../lib/tui/index.ts";

const ACTIONS = [
	"status",
	"definition",
	"references",
	"hover",
	"diagnostics",
	"document_symbols",
	"workspace_symbols",
	"rename",
] as const;

const LSP_GUIDANCE = [
	"Prefer the lsp tool over grep for definitions, references, types, and diagnostics in TypeScript/JavaScript/TSX/JSX files when the language server is available.",
	"After editing TS/JS sources, call lsp action=diagnostics on touched files before assuming the change type-checks.",
	"If lsp status reports a missing server or an action fails, fall back to grep, the project build, and tests.",
].join(" ");

const LspParams = Type.Object({
	action: StringEnum(ACTIONS, {
		description: "LSP action to perform",
	}),
	path: Type.Optional(
		Type.String({
			description:
				"Project-relative path (leading @ allowed). Required for file actions and optional as a project anchor for workspace_symbols.",
		}),
	),
	line: Type.Optional(Type.Integer({ description: "One-based line number", minimum: 1 })),
	column: Type.Optional(
		Type.Integer({
			description:
				"One-based column (code unit). Optional when symbol uniquely identifies the position on the line.",
			minimum: 1,
		}),
	),
	symbol: Type.Optional(
		Type.String({
			description: "Optional identifier used to resolve column when unambiguous on the given line",
		}),
	),
	query: Type.Optional(Type.String({ description: "Symbol query for workspace_symbols" })),
	kind: Type.Optional(
		Type.Integer({
			description: "Optional LSP SymbolKind filter for workspace_symbols (1-26)",
			minimum: 1,
			maximum: 26,
		}),
	),
	new_name: Type.Optional(Type.String({ description: "New identifier for rename" })),
	scope: Type.Optional(
		StringEnum(["file", "workspace"] as const, {
			description: "Diagnostics scope (workspace only when the server advertises it)",
		}),
	),
	offset: Type.Optional(
		Type.Integer({ description: "Pagination offset for list results", minimum: 0 }),
	),
	limit: Type.Optional(
		Type.Integer({ description: "Max results to return", minimum: 1, maximum: 200 }),
	),
});

type LspParamsType = {
	action: (typeof ACTIONS)[number];
	path?: string;
	line?: number;
	column?: number;
	symbol?: string;
	query?: string;
	kind?: number;
	new_name?: string;
	scope?: "file" | "workspace";
	offset?: number;
	limit?: number;
};

function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: boundToolOutput(text) }],
		details,
	};
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function formatStatus(status: ReturnType<LspManager["statusFor"]>): string {
	return [
		`language: ${status.language}`,
		`workspaceRoot: ${status.workspaceRoot}`,
		`server: ${status.serverCommand}`,
		`available: ${status.serverAvailable}`,
		status.serverPath ? `serverPath: ${status.serverPath}` : undefined,
		`initialized: ${status.initialized}`,
		`capabilities: ${status.capabilities.length ? status.capabilities.join(", ") : "(none yet)"}`,
		status.error ? `error: ${status.error}` : undefined,
		`install: ${status.installHint}`,
	]
		.filter(Boolean)
		.join("\n");
}

export class LspStatusView implements Component {
	private readonly selection = new SelectableViewportState();
	private armed: "selected" | "all" | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly getServers: () => ActiveServerStatus[],
		private readonly stopServer: (key: string) => Promise<boolean>,
		private readonly stopAllServers: () => Promise<void>,
		private readonly done: () => void,
	) {}

	render(width: number): string[] {
		const servers = this.getServers();
		const height = Math.max(0, Math.floor(this.tui.terminal.rows));
		const bodyHeight = Math.max(1, height - 5);
		const range = this.selection.update(servers.length, bodyHeight);
		const body =
			servers.length === 0
				? [this.theme.fg("dim", "No active language servers.")]
				: servers.slice(range.start, range.end).map((server, offset) => {
						const index = range.start + offset;
						const selected = index === this.selection.selected;
						const marker = selected ? this.theme.fg("accent", "› ") : "  ";
						const state = server.processAlive
							? server.initialized
								? "ready"
								: "starting"
							: "stopped";
						const capabilities = server.capabilities.length
							? server.capabilities.join(", ")
							: "no capabilities";
						const line = `${marker}${state} ${server.workspaceRoot} · ${capabilities}`;
						return truncateToWidth(line, Math.max(1, getContentWidth(width)));
					});
		const armed = this.armed ? ` · press ${this.armed === "all" ? "K" : "k"} again to confirm` : "";
		return renderFullscreenScreen({
			width,
			height,
			title: "LSP Servers",
			subtitle: `${servers.length} active server${servers.length === 1 ? "" : "s"}${armed}`,
			body,
			keyHints: [
				{ key: "↑↓", label: "select" },
				{ key: "k", label: "kill selected" },
				{ key: "K", label: "kill all" },
				{ key: "Esc", label: "close" },
			],
			theme: this.theme,
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.armed) {
				this.armed = undefined;
				this.tui.requestRender();
			} else {
				this.done();
			}
			return;
		}
		const servers = this.getServers();
		if (matchesKey(data, "up")) this.selection.moveBy(-1, servers.length);
		else if (matchesKey(data, "down")) this.selection.moveBy(1, servers.length);
		else if (matchesKey(data, "pageUp")) this.selection.pageBy(-1, servers.length);
		else if (matchesKey(data, "pageDown")) this.selection.pageBy(1, servers.length);
		else if (matchesKey(data, "home")) this.selection.home();
		else if (matchesKey(data, "end")) this.selection.end(servers.length);
		else if (matchesKey(data, "k")) {
			if (!servers.length) return;
			if (this.armed === "selected") void this.killSelected();
			else {
				this.armed = "selected";
				this.tui.requestRender();
			}
			return;
		} else if (matchesKey(data, "shift+k")) {
			if (!servers.length) return;
			if (this.armed === "all") void this.killAll();
			else {
				this.armed = "all";
				this.tui.requestRender();
			}
			return;
		} else return;
		this.armed = undefined;
		this.tui.requestRender();
	}

	invalidate(): void {}

	private async killSelected(): Promise<void> {
		const server = this.getServers()[this.selection.selected];
		this.armed = undefined;
		if (server) await this.stopServer(server.key);
		this.tui.requestRender();
	}

	private async killAll(): Promise<void> {
		this.armed = undefined;
		await this.stopAllServers();
		this.tui.requestRender();
	}
}

export default function lspExtension(pi: ExtensionAPI) {
	const manager = new LspManager();
	const groupTracker = new SoftGroupTracker();
	bindSoftGroupTracker(pi as any, groupTracker, ["lsp"]);
	pi.on("session_shutdown", async () => {
		await manager.disposeAll();
	});

	pi.registerCommand("lsp:status", {
		description: "Inspect and stop active TypeScript/JavaScript language servers",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				const anchor = args.trim() ? resolveAnchor(args.trim(), ctx.cwd) : ctx.cwd;
				ctx.ui.notify(formatStatus(manager.statusFor(ctx.cwd, anchor)), "info");
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new LspStatusView(
						tui,
						theme,
						() => manager.listActiveServers(),
						(key) => manager.stopServer(key),
						() => manager.stopAllServers(),
						done,
					),
				fullscreenOverlayOptions(),
			);
		},
	});

	pi.registerTool({
		name: "lsp",
		label: "LSP",
		description: [
			"TypeScript/JavaScript language-server navigation and diagnostics:",
			"status, definition, references, hover, diagnostics, document_symbols, workspace_symbols, rename.",
			"Uses typescript-language-server when installed; does not auto-install.",
			"Paths are project-relative; line/column are one-based.",
		].join(" "),
		promptSnippet:
			"Compiler-accurate TS/JS definitions, references, types, diagnostics, and rename",
		promptGuidelines: [
			LSP_GUIDANCE,
			"Use project-relative paths and one-based line/column. Leading @ is accepted.",
			"Do not open every project file to force workspace diagnostics; use per-file diagnostics or the build.",
		],
		parameters: LspParams,
		executionMode: "sequential",
		renderShell: "self",
		async execute(_toolCallId, params: LspParamsType, signal, _onUpdate, ctx) {
			try {
				return await runAction(manager, params, signal, ctx);
			} catch (error) {
				const message = boundToolOutput(errorText(error));
				const fallback =
					message.includes("Missing executable") || message.includes("typescript-language-server")
						? " Fall back to grep/build/test."
						: "";
				throw new Error(`${message}${fallback}`);
			}
		},
		renderCall(args, theme, context) {
			const action = args.action ?? "?";
			const path = args.path ?? "";
			const pos =
				args.line !== undefined
					? `:${args.line}${args.column !== undefined ? `:${args.column}` : ""}`
					: "";
			const query = args.query ? ` · ${args.query}` : "";
			const summary = `${action}${query}`;
			const summaryTail = path ? `${path}${pos}` : pos;
			const expandedLines = [`lsp ${action}`, `${path}${pos}${query}`.trim()].filter(Boolean);
			return renderSoftGroupedCall({
				tracker: groupTracker,
				groupId: "lsp",
				label: "lsp",
				summary,
				summaryTail,
				theme: {
					fg: (name, text) => theme.fg(name as Parameters<Theme["fg"]>[0], text),
					bold: (text) => theme.bold(text),
				},
				context,
				expandedLines,
			});
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const raw = result.content.find((part) => part.type === "text")?.text ?? "";
			if (!expanded) {
				if (!context.isError || isPartial) return emptyCollapsedToolRender();
				const message = (raw.split(/\r?\n/, 1)[0] ?? "LSP failed").trim();
				return new Text(`${theme.fg("error", "×")} ${theme.fg("muted", message)}`, 1, 0);
			}
			return new Text(context.isError ? theme.fg("error", raw) : theme.fg("muted", raw), 1, 0);
		},
	});
}

async function runAction(
	manager: LspManager,
	params: LspParamsType,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const cwd = ctx.cwd;

	if (params.action === "status") {
		const status = manager.statusFor(cwd, params.path ? resolveAnchor(params.path, cwd) : cwd);
		return textResult(formatStatus(status), { status });
	}

	if (params.action === "workspace_symbols") {
		const query = params.query?.trim() ?? "";
		if (!query) throw new Error("query is required for workspace_symbols");

		let session;
		if (params.path) {
			const anchor = resolveWorkspacePath(params.path, cwd);
			if (!isSupportedSourcePath(anchor.absolutePath)) {
				throw new Error(
					`Unsupported workspace_symbols anchor (TypeScript/JavaScript only): ${anchor.relativePath}`,
				);
			}
			session = await manager.getSession(cwd, anchor.absolutePath, signal);
			await session.client.ensureSynced(anchor.absolutePath, anchor.uri, signal);
		} else {
			session = await manager.getSession(cwd, cwd, signal);
		}

		let raw;
		try {
			raw = await session.client.workspaceSymbols(query, signal);
		} catch (error) {
			if (/No Project/i.test(errorText(error))) {
				throw new Error(
					"workspace_symbols could not find a TypeScript project. " +
						"Pass path to a TS/JS file inside the target package, for example " +
						"path=shared/src/handler.ts, or add a root tsconfig.json.",
				);
			}
			throw error;
		}
		const symbols = mapWorkspaceSymbols(raw, session.client.trustedRoot);
		const text = formatWorkspaceSymbols(symbols, {
			query,
			kind: params.kind,
			offset: params.offset,
			limit: params.limit ?? DEFAULT_MAX_RESULTS,
		});
		return textResult(text, { count: symbols.length });
	}

	const pathInput = params.path;
	if (!pathInput) throw new Error(`path is required for action ${params.action}`);

	// Trusted root for path checks is the session cwd; server root may be a nested package.
	const resolved = resolveWorkspacePath(pathInput, cwd);
	if (!isSupportedSourcePath(resolved.absolutePath)) {
		throw new Error(
			`Unsupported file type for lsp (TypeScript/JavaScript only): ${resolved.relativePath}`,
		);
	}

	const session = await manager.getSession(cwd, resolved.absolutePath, signal);
	await session.client.ensureSynced(resolved.absolutePath, resolved.uri, signal);

	if (params.action === "document_symbols") {
		const raw = await session.client.documentSymbols(resolved.uri, signal);
		const symbols = mapDocumentSymbols(raw, session.client.trustedRoot, resolved.relativePath);
		return textResult(
			formatDocumentSymbols(resolved.relativePath, symbols, {
				limit: params.limit ?? DEFAULT_MAX_RESULTS,
			}),
			{ count: symbols.length },
		);
	}

	if (params.action === "diagnostics") {
		const scope = params.scope ?? "file";
		if (scope === "workspace") {
			if (!session.client.supportsWorkspaceDiagnostics()) {
				return textResult(session.client.workspaceDiagnosticsUnsupportedMessage(), {
					freshness: "unsupported",
				});
			}
			return textResult(session.client.workspaceDiagnosticsUnsupportedMessage(), {
				freshness: "unsupported",
			});
		}

		const synced = await session.client.ensureSynced(resolved.absolutePath, resolved.uri, signal);
		const result = await session.client.fileDiagnostics(resolved.uri, synced.version, signal);
		const rows = diagnosticsToRows(resolved.uri, result.diagnostics, session.client.trustedRoot);
		return textResult(
			formatDiagnostics(resolved.relativePath, rows, {
				freshness: result.freshness,
				note: result.note,
				limit: params.limit,
			}),
			{ freshness: result.freshness, count: rows.length },
		);
	}

	const line = params.line;
	if (line === undefined || line < 1) {
		throw new Error("line (one-based) is required for this action");
	}

	const content = await fs.promises.readFile(resolved.absolutePath, "utf8");
	const resolvedPos = resolveColumn(content, line, params.column, params.symbol);
	const column = resolvedPos.column;

	if (params.action === "definition") {
		const locations = await session.client.definition(resolved.uri, line, column, signal);
		return textResult(
			formatLocationList("definition", locations, {
				offset: params.offset,
				limit: params.limit ?? DEFAULT_MAX_RESULTS,
			}),
			{ count: locations.length, column, note: resolvedPos.note },
		);
	}

	if (params.action === "references") {
		const locations = await session.client.references(resolved.uri, line, column, signal);
		return textResult(
			formatLocationList("references", locations, {
				offset: params.offset,
				limit: params.limit ?? DEFAULT_MAX_RESULTS,
			}),
			{ count: locations.length, column, note: resolvedPos.note },
		);
	}

	if (params.action === "hover") {
		const contents = await session.client.hover(resolved.uri, line, column, signal);
		const loc = locationFromLsp(
			resolved.uri,
			{ start: oneBasedToLsp(line, column) },
			session.client.trustedRoot,
			{ includeContext: true },
		);
		return textResult(formatHover(loc, contents || "(no hover)"), {
			column,
			note: resolvedPos.note,
		});
	}

	if (params.action === "rename") {
		const newName = params.new_name?.trim();
		if (!newName) throw new Error("new_name is required for rename");
		if (session.client.supportsPrepareRename()) {
			let prepared: unknown;
			try {
				prepared = await session.client.prepareRename(resolved.uri, line, column, signal);
			} catch (error) {
				throw new Error(`prepareRename failed: ${errorText(error)}`);
			}
			if (prepared == null || prepared === false) {
				throw new Error("prepareRename returned null; rename is not valid at this position");
			}
		}
		const edit = await session.client.rename(resolved.uri, line, column, newName, signal);
		let validated;
		try {
			validated = validateWorkspaceEdit(edit, cwd, session.client.documents);
		} catch (error) {
			if (error instanceof WorkspaceEditError || error instanceof PathSecurityError) throw error;
			throw new WorkspaceEditError(errorText(error));
		}
		const applied = await applyWorkspaceEdit(validated, session.client, cwd, signal);

		// Post-commit diagnostics: soft-fail so a successful rename is not flipped ambiguous.
		let diagText = "";
		try {
			const synced = await session.client.ensureSynced(resolved.absolutePath, resolved.uri);
			const diag = await session.client.fileDiagnostics(resolved.uri, synced.version);
			const rows = diagnosticsToRows(resolved.uri, diag.diagnostics, session.client.trustedRoot);
			diagText = formatDiagnostics(resolved.relativePath, rows, {
				freshness: diag.freshness,
				note: diag.note,
			});
		} catch (error) {
			diagText = `diagnostics unavailable after rename: ${errorText(error)}`;
		}
		const text = [
			applied.summary,
			`origin ${formatLocationTag({ path: resolved.relativePath, line, column })} -> ${newName}`,
			"Rely on the existing turn checkpoint; create an explicit checkpoint for unusually broad renames.",
			diagText,
		].join("\n");
		return textResult(text, {
			filesTouched: applied.filesTouched,
			editCount: applied.editCount,
			paths: applied.relativePaths,
		});
	}

	throw new Error(`Unknown action: ${params.action}`);
}

function resolveAnchor(inputPath: string, cwd: string): string {
	try {
		return resolveWorkspacePath(inputPath, cwd, { mustExist: false }).absolutePath;
	} catch {
		return cwd;
	}
}

export { LSP_GUIDANCE };

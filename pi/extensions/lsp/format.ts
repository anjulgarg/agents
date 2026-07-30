/**
 * Compact, deterministic LSP result formatting with Pi 50KB/2000-line bounds.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import { assertUriInWorkspace, PathSecurityError, toProjectRelative } from "./paths.ts";

export const DEFAULT_MAX_RESULTS = 40;
export const DEFAULT_CONTEXT_LINES = 2;
export const DEFAULT_HOVER_MAX_CHARS = 1_200;
export const DEFAULT_DIAGNOSTIC_MAX = 50;
export const MAX_CONTEXT_LINE_CHARS = 500;
export const MAX_SERVER_STRING_CHARS = 2_000;
export const MAX_SYMBOL_NAME_CHARS = 200;
export const MAX_SYMBOL_NODES = 500;
export const MAX_SYMBOL_DEPTH = 32;

export interface Position1Based {
	line: number;
	column: number;
}

export interface LocationResult {
	path: string;
	line: number;
	column: number;
	context?: string[];
}

export interface TruncationMeta {
	truncated: boolean;
	total: number;
	returned: number;
	offset: number;
	limit: number;
	hasMore: boolean;
}

export function formatLocationTag(loc: LocationResult): string {
	return `${loc.path}:${loc.line}:${loc.column}`;
}

export function lspPositionToOneBased(position: {
	line: number;
	character: number;
}): Position1Based {
	return { line: position.line + 1, column: position.character + 1 };
}

export function oneBasedToLsp(line: number, column: number): { line: number; character: number } {
	return { line: Math.max(0, line - 1), character: Math.max(0, column - 1) };
}

export function capServerString(text: string, maxChars = MAX_SERVER_STRING_CHARS): string {
	const { text: capped, wasTruncated } = truncateLine(text.replace(/\s+/g, " ").trim(), maxChars);
	return wasTruncated ? capped : text.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

export function locationFromLsp(
	uri: string,
	range: { start: { line: number; character: number } },
	workspaceRoot: string,
	options: { includeContext?: boolean; contextLines?: number } = {},
): LocationResult {
	if (typeof uri !== "string" || !uri.startsWith("file:")) {
		throw new PathSecurityError(`Non-file URI rejected: ${String(uri).slice(0, 64)}`);
	}
	const absolute = assertUriInWorkspace(uri, workspaceRoot);
	const relative = toProjectRelative(absolute, workspaceRoot);
	const pos = lspPositionToOneBased(range.start);
	const loc: LocationResult = {
		path: relative,
		line: pos.line,
		column: pos.column,
	};
	if (options.includeContext !== false) {
		loc.context = readContextLines(
			absolute,
			pos.line,
			options.contextLines ?? DEFAULT_CONTEXT_LINES,
		);
	}
	return loc;
}

export function readContextLines(
	absolutePath: string,
	oneBasedLine: number,
	radius: number,
): string[] {
	try {
		const text = fs.readFileSync(absolutePath, "utf8");
		const lines = text.split(/\r?\n/);
		const idx = oneBasedLine - 1;
		const start = Math.max(0, idx - radius);
		const end = Math.min(lines.length, idx + radius + 1);
		const out: string[] = [];
		for (let i = start; i < end; i++) {
			const marker = i === idx ? ">" : " ";
			const raw = lines[i] ?? "";
			const { text: capped } = truncateLine(raw, MAX_CONTEXT_LINE_CHARS);
			out.push(`${marker} ${i + 1}| ${capped}`);
		}
		return out;
	} catch {
		return [];
	}
}

export function compareLocations(a: LocationResult, b: LocationResult): number {
	const pathCmp = a.path.localeCompare(b.path);
	if (pathCmp !== 0) return pathCmp;
	if (a.line !== b.line) return a.line - b.line;
	return a.column - b.column;
}

export function dedupeLocations(locations: LocationResult[]): LocationResult[] {
	const seen = new Set<string>();
	const out: LocationResult[] = [];
	for (const loc of locations) {
		const key = formatLocationTag(loc);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(loc);
	}
	return out;
}

export function paginate<T>(
	items: T[],
	options: { offset?: number; limit?: number } = {},
): { items: T[]; meta: TruncationMeta } {
	const offset = Math.max(0, options.offset ?? 0);
	const limit = Math.max(1, options.limit ?? DEFAULT_MAX_RESULTS);
	const slice = items.slice(offset, offset + limit);
	const returned = slice.length;
	const total = items.length;
	const hasMore = offset + returned < total;
	return {
		items: slice,
		meta: {
			truncated: hasMore || offset > 0 || returned < total,
			total,
			returned,
			offset,
			limit,
			hasMore,
		},
	};
}

/** Bound final tool text to Pi's default 50KB / 2000-line limits. */
export function boundToolOutput(text: string): string {
	const result = truncateHead(text, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	if (!result.truncated) return text;
	const note =
		`\ntruncated: output capped at ${result.maxLines} lines / ${result.maxBytes} bytes ` +
		`(kept ${result.outputLines} lines, ${result.outputBytes} bytes of ${result.totalLines} lines / ${result.totalBytes} bytes)`;
	return `${result.content}${note}`;
}

export function formatLocationList(
	title: string,
	locations: LocationResult[],
	options: { offset?: number; limit?: number } = {},
): string {
	const sorted = dedupeLocations([...locations].sort(compareLocations));
	const { items, meta } = paginate(sorted, options);
	if (items.length === 0) {
		return boundToolOutput(`${title}: none`);
	}
	const lines: string[] = [`${title}: ${meta.returned}/${meta.total}`];
	for (const loc of items) {
		lines.push(formatLocationTag(loc));
		if (loc.context?.length) {
			for (const ctx of loc.context) lines.push(`  ${ctx}`);
		}
	}
	if (meta.hasMore) {
		lines.push(
			`truncated: showing ${meta.returned} of ${meta.total} (offset=${meta.offset}, limit=${meta.limit}); ` +
				`pass offset=${meta.offset + meta.returned} for more`,
		);
	} else if (meta.truncated && meta.offset > 0) {
		lines.push(`page: offset=${meta.offset}, returned=${meta.returned}, total=${meta.total}`);
	}
	return boundToolOutput(lines.join("\n"));
}

export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
	const normalized = text.replace(/\s+$/u, "").trim();
	if (normalized.length <= maxChars) return { text: normalized, truncated: false };
	return { text: `${normalized.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true };
}

export function formatHover(
	loc: LocationResult,
	contents: string,
	options: { maxChars?: number } = {},
): string {
	const { text, truncated } = truncateText(contents, options.maxChars ?? DEFAULT_HOVER_MAX_CHARS);
	const lines = [`hover ${formatLocationTag(loc)}`, text || "(empty)"];
	if (loc.context?.length) {
		for (const ctx of loc.context) lines.push(ctx);
	}
	if (truncated)
		lines.push(
			`truncated: hover text capped at ${options.maxChars ?? DEFAULT_HOVER_MAX_CHARS} chars`,
		);
	return boundToolOutput(lines.join("\n"));
}

export function symbolKindName(kind: number | undefined): string {
	const names: Record<number, string> = {
		1: "file",
		2: "module",
		3: "namespace",
		4: "package",
		5: "class",
		6: "method",
		7: "property",
		8: "field",
		9: "constructor",
		10: "enum",
		11: "interface",
		12: "function",
		13: "variable",
		14: "constant",
		15: "string",
		16: "number",
		17: "boolean",
		18: "array",
		19: "object",
		20: "key",
		21: "null",
		22: "enumMember",
		23: "struct",
		24: "event",
		25: "operator",
		26: "typeParameter",
	};
	return kind !== undefined ? (names[kind] ?? `kind:${kind}`) : "symbol";
}

export function formatDocumentSymbols(
	relativePath: string,
	symbols: Array<{
		name: string;
		kind?: number;
		line: number;
		column: number;
		children?: unknown[];
	}>,
	options: { limit?: number } = {},
): string {
	const flat = flattenSymbolsIterative(symbols);
	flat.sort((a, b) => a.line - b.line || a.column - b.column || a.name.localeCompare(b.name));
	const { items, meta } = paginate(flat, { limit: options.limit ?? DEFAULT_MAX_RESULTS });
	if (items.length === 0) return boundToolOutput(`document_symbols ${relativePath}: none`);
	const lines = [`document_symbols ${relativePath}: ${meta.returned}/${meta.total}`];
	for (const sym of items) {
		const indent = "  ".repeat(sym.depth);
		const name = truncateLine(sym.name, MAX_SYMBOL_NAME_CHARS).text;
		lines.push(
			`${indent}${symbolKindName(sym.kind)} ${name} ${relativePath}:${sym.line}:${sym.column}`,
		);
	}
	if (meta.hasMore || flat.length >= MAX_SYMBOL_NODES) {
		lines.push(
			`truncated: showing ${meta.returned} of ${meta.total} symbols (node cap ${MAX_SYMBOL_NODES})`,
		);
	}
	return boundToolOutput(lines.join("\n"));
}

/** Iterative flatten to avoid recursive stack exhaustion on hostile nesting. */
export function flattenSymbolsIterative(
	symbols: Array<{
		name: string;
		kind?: number;
		line: number;
		column: number;
		children?: unknown[];
	}>,
): Array<{ name: string; kind?: number; line: number; column: number; depth: number }> {
	const out: Array<{ name: string; kind?: number; line: number; column: number; depth: number }> =
		[];
	const stack: Array<{
		nodes: Array<{
			name: string;
			kind?: number;
			line: number;
			column: number;
			children?: unknown[];
		}>;
		depth: number;
		index: number;
	}> = [{ nodes: symbols, depth: 0, index: 0 }];

	while (stack.length > 0 && out.length < MAX_SYMBOL_NODES) {
		const frame = stack[stack.length - 1]!;
		if (frame.index >= frame.nodes.length) {
			stack.pop();
			continue;
		}
		const sym = frame.nodes[frame.index++]!;
		if (!sym?.name) continue;
		out.push({
			name: String(sym.name).slice(0, MAX_SYMBOL_NAME_CHARS * 2),
			kind: sym.kind,
			line: sym.line,
			column: sym.column,
			depth: frame.depth,
		});
		if (
			frame.depth < MAX_SYMBOL_DEPTH &&
			Array.isArray(sym.children) &&
			sym.children.length > 0 &&
			out.length < MAX_SYMBOL_NODES
		) {
			stack.push({
				nodes: sym.children as Array<{
					name: string;
					kind?: number;
					line: number;
					column: number;
					children?: unknown[];
				}>,
				depth: frame.depth + 1,
				index: 0,
			});
		}
	}
	return out;
}

export function formatWorkspaceSymbols(
	symbols: Array<{ name: string; kind?: number; path: string; line: number; column: number }>,
	options: { offset?: number; limit?: number; query?: string; kind?: number } = {},
): string {
	let filtered = symbols;
	if (options.kind !== undefined) {
		filtered = symbols.filter((s) => s.kind === options.kind);
	}
	const sorted = [...filtered].sort((a, b) => {
		const p = a.path.localeCompare(b.path);
		if (p !== 0) return p;
		if (a.line !== b.line) return a.line - b.line;
		if (a.column !== b.column) return a.column - b.column;
		return a.name.localeCompare(b.name);
	});
	const deduped: typeof sorted = [];
	const seen = new Set<string>();
	for (const sym of sorted) {
		const key = `${sym.path}:${sym.line}:${sym.column}:${sym.name}:${sym.kind ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(sym);
	}
	const { items, meta } = paginate(deduped, options);
	const q = options.query ? ` query=${JSON.stringify(options.query)}` : "";
	const k = options.kind !== undefined ? ` kind=${options.kind}` : "";
	if (items.length === 0) return boundToolOutput(`workspace_symbols${q}${k}: none`);
	const lines = [`workspace_symbols${q}${k}: ${meta.returned}/${meta.total}`];
	for (const sym of items) {
		const name = truncateLine(sym.name, MAX_SYMBOL_NAME_CHARS).text;
		lines.push(`${symbolKindName(sym.kind)} ${name} ${sym.path}:${sym.line}:${sym.column}`);
	}
	if (meta.hasMore) {
		lines.push(
			`truncated: showing ${meta.returned} of ${meta.total} (offset=${meta.offset}, limit=${meta.limit})`,
		);
	}
	return boundToolOutput(lines.join("\n"));
}

export function severityName(severity: number | undefined): string {
	switch (severity) {
		case 1:
			return "error";
		case 2:
			return "warning";
		case 3:
			return "info";
		case 4:
			return "hint";
		default:
			return "diagnostic";
	}
}

export function formatDiagnostics(
	relativePath: string | undefined,
	diagnostics: Array<{
		path: string;
		line: number;
		column: number;
		severity?: number;
		message: string;
		source?: string;
		code?: string | number;
	}>,
	options: {
		limit?: number;
		freshness: "fresh" | "stale" | "unavailable" | "unsupported";
		note?: string;
	},
): string {
	const sorted = [...diagnostics].sort((a, b) => {
		const p = a.path.localeCompare(b.path);
		if (p !== 0) return p;
		if (a.line !== b.line) return a.line - b.line;
		if (a.column !== b.column) return a.column - b.column;
		return a.message.localeCompare(b.message);
	});
	const { items, meta } = paginate(sorted, { limit: options.limit ?? DEFAULT_DIAGNOSTIC_MAX });
	const scope = relativePath ? relativePath : "workspace";
	const header = `diagnostics ${scope} [${options.freshness}]: ${meta.returned}/${meta.total}`;
	const lines = [header];
	if (options.note) lines.push(capServerString(options.note));
	for (const d of items) {
		const code = d.code !== undefined ? ` (${d.code})` : "";
		const source = d.source ? ` ${capServerString(String(d.source), 80)}` : "";
		lines.push(
			`${severityName(d.severity)} ${d.path}:${d.line}:${d.column}${source}${code}: ${capServerString(d.message)}`,
		);
	}
	if (meta.hasMore) {
		lines.push(`truncated: showing ${meta.returned} of ${meta.total} diagnostics`);
	}
	return boundToolOutput(lines.join("\n"));
}

export function basenamePath(relativePath: string): string {
	return path.posix.basename(relativePath);
}

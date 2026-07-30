/**
 * Summary output modes for the grep tool.
 *
 * Pi's built-in grep always returns matching lines, which is wasteful when the
 * agent only needs the list of matching files or per-file totals. These modes
 * call ripgrep directly with --files-with-matches / --count-matches and format
 * the much smaller result, reusing Pi's truncation limits and notice wording.
 */

import {
	DEFAULT_MAX_BYTES,
	formatSize,
	getAgentDir,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, join, relative } from "node:path";
import { platform } from "node:os";

export type GrepOutputMode = "content" | "files_with_matches" | "count";
export type GrepSummaryMode = Exclude<GrepOutputMode, "content">;

export const GREP_OUTPUT_MODES = ["content", "files_with_matches", "count"] as const;
export const DEFAULT_SUMMARY_LIMIT = 100;

export interface GrepSummaryRow {
	path: string;
	count: number;
}

export interface GrepSummaryQuery {
	mode: GrepSummaryMode;
	pattern: string;
	searchPath: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
}

export interface GrepSummaryResult {
	content: Array<{ type: "text"; text: string }>;
	details?: {
		matchLimitReached?: number;
		truncation?: ReturnType<typeof truncateHead>;
	};
}

/**
 * Locate the ripgrep binary Pi downloads on demand, falling back to PATH.
 *
 * Pi's downloader is internal, so summary modes reuse the binary it installs
 * rather than shipping their own.
 */
export function resolveRipgrepPath(): string | undefined {
	const binaryName = platform() === "win32" ? "rg.exe" : "rg";
	const managed = join(getAgentDir(), "bin", binaryName);
	if (existsSync(managed)) return managed;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, binaryName);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export function buildSummaryArgs(query: GrepSummaryQuery): string[] {
	const args = [
		query.mode === "count" ? "--count-matches" : "--files-with-matches",
		// Ripgrep drops the path prefix when searching a single file.
		"--with-filename",
		"--color=never",
		"--hidden",
	];
	if (query.ignoreCase) args.push("--ignore-case");
	if (query.literal) args.push("--fixed-strings");
	if (query.glob) args.push("--glob", query.glob);
	args.push("--", query.pattern, query.searchPath);
	return args;
}

/** Mirror the built-in grep path style: relative inside a searched directory, else basename. */
export function createPathFormatter(
	searchPath: string,
	isDirectory: boolean,
): (filePath: string) => string {
	return (filePath: string) => {
		if (isDirectory) {
			const relativePath = relative(searchPath, filePath);
			if (relativePath && !relativePath.startsWith("..")) {
				return relativePath.replace(/\\/g, "/");
			}
		}
		return basename(filePath);
	};
}

export function parseSummaryRows(
	mode: GrepSummaryMode,
	stdout: string,
	formatPath: (filePath: string) => string,
): GrepSummaryRow[] {
	const rows: GrepSummaryRow[] = [];
	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (!line) continue;
		if (mode === "files_with_matches") {
			rows.push({ path: formatPath(line), count: 0 });
			continue;
		}
		// --count-matches emits "path:count"; paths may contain colons.
		const separator = line.lastIndexOf(":");
		if (separator <= 0) continue;
		const count = Number.parseInt(line.slice(separator + 1), 10);
		if (!Number.isFinite(count)) continue;
		rows.push({ path: formatPath(line.slice(0, separator)), count });
	}
	return rows;
}

/** Ripgrep emits files in parallel completion order, so sort for stable output. */
export function sortSummaryRows(mode: GrepSummaryMode, rows: GrepSummaryRow[]): GrepSummaryRow[] {
	return [...rows].sort((left, right) => {
		if (mode === "count" && left.count !== right.count) return right.count - left.count;
		return left.path.localeCompare(right.path);
	});
}

function plural(count: number, word: string, pluralForm = `${word}s`): string {
	return `${count} ${count === 1 ? word : pluralForm}`;
}

export function formatSummaryOutput(
	mode: GrepSummaryMode,
	rows: GrepSummaryRow[],
	limit: number,
): GrepSummaryResult {
	if (rows.length === 0) {
		return { content: [{ type: "text", text: "No matches found" }] };
	}
	const effectiveLimit = Math.max(1, limit);
	const sorted = sortSummaryRows(mode, rows);
	const visible = sorted.slice(0, effectiveLimit);
	const files = plural(sorted.length, "file");
	const header =
		mode === "count"
			? `${files}, ${plural(
					sorted.reduce((total, row) => total + row.count, 0),
					"match",
					"matches",
				)}`
			: `${files} with matches`;
	const body =
		mode === "count"
			? visible.map((row) => `${row.path}: ${row.count}`)
			: visible.map((row) => row.path);

	const truncation = truncateHead([header, ...body].join("\n"), {
		maxLines: Number.MAX_SAFE_INTEGER,
	});
	let text = truncation.content;
	const notices: string[] = [];
	const details: GrepSummaryResult["details"] = {};
	if (sorted.length > visible.length) {
		notices.push(
			`${plural(effectiveLimit, "file")} limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
		);
		details.matchLimitReached = effectiveLimit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;

	return {
		content: [{ type: "text", text }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

export function runGrepSummary(
	rgPath: string,
	query: GrepSummaryQuery,
	options: { isDirectory: boolean; limit: number; signal?: AbortSignal },
): Promise<GrepSummaryResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}
		const child = spawn(rgPath, buildSummaryArgs(query), {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let aborted = false;
		const onAbort = () => {
			aborted = true;
			if (!child.killed) child.kill();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			options.signal?.removeEventListener("abort", onAbort);
			reject(new Error(`Failed to run ripgrep: ${error.message}`));
		});
		child.on("close", (code) => {
			options.signal?.removeEventListener("abort", onAbort);
			if (aborted) {
				reject(new Error("Operation aborted"));
				return;
			}
			// Ripgrep exits 1 when nothing matched; anything above that is a real failure.
			if (code !== 0 && code !== 1) {
				reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
				return;
			}
			const formatPath = createPathFormatter(query.searchPath, options.isDirectory);
			resolve(
				formatSummaryOutput(
					query.mode,
					parseSummaryRows(query.mode, stdout, formatPath),
					options.limit,
				),
			);
		});
	});
}

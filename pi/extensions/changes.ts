import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	sliceByColumn,
	truncateToWidth,
	wrapTextWithAnsi,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { subscribeProcessAnimation } from "./lib/animation-coordinator.ts";
import {
	fullscreenOverlayOptions,
	getContentWidth,
	renderFooter,
	renderFullscreenScreen,
	renderHeader,
	ScrollViewportState,
} from "./lib/tui/index.ts";

const GIT_TIMEOUT_MS = 10_000;
const DEFAULT_CONTEXT_LINES = 3;
const FULL_FILE_CONTEXT_LINES = 1_000_000_000;
const EDITOR_HANDOFF_REDRAW_KEY = "changes:editor-handoff";
const MAX_DIFF_OUTPUT_CHARS = 2_000_000;
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;

export type ChangeScope = "uncommitted" | "unpushed";

export type ChangeKind =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "copied"
	| "untracked"
	| "typechange"
	| "unmerged"
	| "submodule"
	| "unknown";

/** A single path record parsed from one Git porcelain or name-status stream. */
export interface GitChange {
	path: string;
	oldPath?: string;
	status: string;
	kind: ChangeKind;
	scope: ChangeScope;
	isSubmodule?: boolean;
}

/** The union row shown by the changes screen. */
export interface ChangedFile {
	path: string;
	oldPath?: string;
	status: string;
	kind: ChangeKind;
	scopes: ChangeScope[];
	workingStatus?: string;
	unpushedStatus?: string;
	isSubmodule: boolean;
}

export interface ChangesSnapshot {
	root: string;
	files: ChangedFile[];
	fingerprint: string;
	upstream?: string;
	unpushedAvailable: boolean;
}

export interface ChangesDisplay {
	snapshot: ChangesSnapshot;
	stale: boolean;
}

export type DiffMode = "collapsed" | "full";

export interface FileDiff {
	kind: "text" | "binary" | "submodule" | "empty" | "unavailable";
	/** Lines are already styled by Pi's standard edit-tool diff renderer. */
	lines: string[];
	note?: string;
}

export interface ChangesViewOptions {
	root: string;
	load: (signal: AbortSignal) => Promise<ChangesDisplay>;
	fetchDiff: (
		file: ChangedFile,
		mode: DiffMode,
		snapshot: ChangesSnapshot,
		signal: AbortSignal,
	) => Promise<FileDiff>;
	isSnapshotCurrent?: (snapshot: ChangesSnapshot, signal: AbortSignal) => Promise<boolean>;
	done: (result?: string) => void;
}

export interface GitExecOptions {
	cwd: string;
	timeout: number;
}

export interface GitExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type GitExec = (
	command: string,
	args: readonly string[],
	options: GitExecOptions,
) => Promise<GitExecResult>;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function cancellationError(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason;
	return Object.assign(new Error("Cancelled"), { name: "AbortError" });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw cancellationError(signal);
}

function boundedText(value: string, limit: number): string {
	if (value.length <= limit) return value;
	return `${value.slice(0, Math.max(0, limit - 28))}\n[output truncated]`;
}

function oneLine(value: string, limit = 2_000): string {
	return boundedText(value.replace(/[\r\n]+/g, " "), limit).trim();
}

function safeTerminalText(value: string, limit = 2_000): string {
	let result = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			if (code === 0x09) result += "\\t";
			else result += `\\x${code.toString(16).padStart(2, "0")}`;
		} else {
			result += character;
		}
		if (result.length >= limit) break;
	}
	return boundedText(result, limit);
}

function safePath(path: string): string {
	return safeTerminalText(path);
}

function statusKind(status: string, isSubmodule = false): ChangeKind {
	if (isSubmodule || /[m]/.test(status)) return "submodule";
	const pair = status.slice(0, 2).toUpperCase();
	if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(pair)) return "unmerged";
	const code = status.trim().charAt(0).toUpperCase();
	switch (code) {
		case "A":
			return "added";
		case "M":
			return "modified";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "C":
			return "copied";
		case "T":
			return "typechange";
		case "U":
			return "unmerged";
		case "?":
			return "untracked";
		default:
			return "unknown";
	}
}

function isRenameOrCopy(status: string): boolean {
	const code = status.trim().charAt(0).toUpperCase();
	return code === "R" || code === "C";
}

/** Parse Git status --porcelain=v1 -z without interpreting or shell-splitting paths. */
export function parsePorcelainStatusZ(input: string): GitChange[] {
	const records = input.split("\0");
	const changes: GitChange[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index] ?? "";
		if (record.length < 3) continue;
		const status = record.slice(0, 2);
		const path = record.slice(3);
		if (!path) continue;
		let oldPath: string | undefined;
		if (isRenameOrCopy(status)) {
			oldPath = records[index + 1] || undefined;
			if (oldPath) index++;
		}
		const isSubmodule = /m/.test(status);
		changes.push({
			path,
			...(oldPath ? { oldPath } : {}),
			status,
			kind: statusKind(status, isSubmodule),
			scope: "uncommitted",
			isSubmodule,
		});
	}
	return changes;
}

/** Parse Git diff --name-status -z, including the two paths of renames and copies. */
export function parseNameStatusZ(input: string): GitChange[] {
	const records = input.split("\0");
	const changes: GitChange[] = [];
	for (let index = 0; index < records.length; index++) {
		const status = records[index] ?? "";
		if (!status) continue;
		const pathA = records[index + 1];
		if (!pathA) break;
		index++;
		let path = pathA;
		let oldPath: string | undefined;
		if (isRenameOrCopy(status)) {
			const pathB = records[index + 1];
			if (!pathB) break;
			oldPath = pathA;
			path = pathB;
			index++;
		}
		changes.push({
			path,
			...(oldPath ? { oldPath } : {}),
			status,
			kind: statusKind(status),
			scope: "unpushed",
			isSubmodule: false,
		});
	}
	return changes;
}

/** Build the merge-base range used to isolate commits not present upstream. */
export function buildUnpushedRange(upstream: string): string {
	return `${upstream}...HEAD`;
}

function pathNames(
	change: Pick<GitChange, "path" | "oldPath"> | Pick<ChangedFile, "path" | "oldPath">,
): string[] {
	return [change.path, change.oldPath].filter((path): path is string => Boolean(path));
}

function mergeRenameLineage(current: ChangedFile, change: GitChange): void {
	if (current.path === change.oldPath && change.path !== current.path) current.path = change.path;
	if (!current.oldPath && change.oldPath && change.oldPath !== current.path) {
		current.oldPath = change.oldPath;
	}
	if (current.oldPath === change.path && change.oldPath && change.oldPath !== current.path) {
		current.oldPath = change.oldPath;
	}
}

/** Merge working-tree and unpushed records into one row per path or rename identity. */
export function mergeChangedFiles(
	uncommitted: readonly GitChange[],
	unpushed: readonly GitChange[] = [],
): ChangedFile[] {
	const merged: ChangedFile[] = [];

	const add = (change: GitChange, defaultScope: ChangeScope): void => {
		const scope = change.scope ?? defaultScope;
		const names = pathNames(change);
		const target = merged.findIndex((file) => names.some((name) => pathNames(file).includes(name)));
		const kind = change.kind ?? statusKind(change.status, change.isSubmodule);
		if (target < 0) {
			merged.push({
				path: change.path,
				...(change.oldPath ? { oldPath: change.oldPath } : {}),
				status: change.status,
				kind,
				scopes: [scope],
				...(scope === "uncommitted" ? { workingStatus: change.status } : {}),
				...(scope === "unpushed" ? { unpushedStatus: change.status } : {}),
				isSubmodule: Boolean(change.isSubmodule) || kind === "submodule",
			});
			return;
		}

		const current = merged[target]!;
		mergeRenameLineage(current, change);
		if (!current.scopes.includes(scope)) current.scopes.push(scope);
		current.scopes.sort((left, right) =>
			left === "uncommitted" ? -1 : right === "uncommitted" ? 1 : 0,
		);
		if (scope === "uncommitted") current.workingStatus = change.status;
		else current.unpushedStatus = change.status;
		current.status = current.workingStatus ?? current.unpushedStatus ?? current.status;
		if (current.kind !== "submodule") {
			current.kind =
				current.workingStatus !== undefined
					? statusKind(current.workingStatus, current.isSubmodule)
					: kind;
		}
		current.isSubmodule =
			current.isSubmodule || Boolean(change.isSubmodule) || kind === "submodule";
		if (current.isSubmodule) current.kind = "submodule";
	};

	// Working-tree records come first so later unpushed records can preserve a full rename chain.
	for (const change of uncommitted) add(change, "uncommitted");
	for (const change of unpushed) add(change, "unpushed");
	return merged.sort((left, right) => left.path.localeCompare(right.path));
}

interface GitState {
	status: string;
	submodules: string;
	upstream?: string;
	unpushedAvailable: boolean;
	unpushed: string;
	fingerprint: string;
}

function hashFingerprint(parts: readonly string[]): string {
	let hash = 2_166_136_261;
	for (const part of parts) {
		for (let index = 0; index < part.length; index++) {
			hash ^= part.charCodeAt(index);
			hash = Math.imul(hash, 16_777_619) >>> 0;
		}
		hash ^= 0;
		hash = Math.imul(hash, 16_777_619) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

async function fingerprintGitCommand(
	exec: GitExec,
	args: readonly string[],
	options: GitExecOptions,
	signal?: AbortSignal,
): Promise<string> {
	const result = await exec("git", args, options);
	throwIfAborted(signal);
	return result.code === 0 ? result.stdout : `failed:${result.code}:${oneLine(result.stderr)}`;
}

/** Upper bound for the combined argument bytes passed to one Git invocation. */
const MAX_COMMAND_ARGUMENT_BYTES = 64_000;

export async function fingerprintPathBatch(
	exec: GitExec,
	paths: readonly string[],
	options: GitExecOptions,
	signal?: AbortSignal,
): Promise<string[]> {
	const hashes: string[] = [];
	let batch: string[] = [];
	let batchBytes = 0;
	const flushBatch = async (): Promise<void> => {
		if (batch.length === 0) return;
		hashes.push(
			await fingerprintGitCommand(
				exec,
				["hash-object", "--no-filters", "--", ...batch],
				options,
				signal,
			),
		);
		batch = [];
		batchBytes = 0;
	};
	for (const path of paths) {
		const pathBytes = path.length + 1;
		if (batchBytes + pathBytes > MAX_COMMAND_ARGUMENT_BYTES) await flushBatch();
		batch.push(path);
		batchBytes += pathBytes;
	}
	await flushBatch();
	return hashes;
}

async function readGitState(exec: GitExec, root: string, signal?: AbortSignal): Promise<GitState> {
	throwIfAborted(signal);
	const options = { cwd: root, timeout: GIT_TIMEOUT_MS };
	const statusResult = await exec(
		"git",
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		options,
	);
	throwIfAborted(signal);
	if (statusResult.code !== 0) {
		throw new Error(oneLine(statusResult.stderr) || "Could not inspect the current Git checkout.");
	}

	const workingChanges = parsePorcelainStatusZ(statusResult.stdout);
	const contentParts: string[] = [
		await fingerprintGitCommand(
			exec,
			["--literal-pathspecs", "diff", "--raw", "--no-ext-diff", "--no-textconv", "--cached", "-z"],
			options,
			signal,
		),
		await fingerprintGitCommand(
			exec,
			["--literal-pathspecs", "diff", "--raw", "--no-ext-diff", "--no-textconv", "-z"],
			options,
			signal,
		),
	];
	const workingPaths = workingChanges
		.filter((change) => change.kind !== "deleted" && !change.isSubmodule)
		.map((change) => change.path);
	if (workingPaths.length > 0) {
		contentParts.push(workingPaths.join("\0"));
		contentParts.push(...(await fingerprintPathBatch(exec, workingPaths, options, signal)));
	}

	const submoduleResult = await exec("git", ["ls-files", "--stage", "-z"], options);
	throwIfAborted(signal);
	const submodules =
		submoduleResult.code === 0
			? submoduleResult.stdout
			: `unavailable:${submoduleResult.code}:${oneLine(submoduleResult.stderr)}`;

	const upstreamResult = await exec(
		"git",
		["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
		options,
	);
	throwIfAborted(signal);
	const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : undefined;
	let unpushed = "";
	let unpushedAvailable = false;
	let unpushedMarker = "no-upstream";
	if (upstream) {
		const diffResult = await exec(
			"git",
			[
				"--literal-pathspecs",
				"diff",
				"--name-status",
				"-z",
				"--find-renames",
				"--find-copies",
				buildUnpushedRange(upstream),
			],
			options,
		);
		throwIfAborted(signal);
		if (diffResult.code === 0) {
			unpushed = diffResult.stdout;
			unpushedAvailable = true;
			unpushedMarker = "available";
			contentParts.push(
				await fingerprintGitCommand(
					exec,
					[
						"--literal-pathspecs",
						"diff",
						"--raw",
						"--no-color",
						"--no-ext-diff",
						"--no-textconv",
						"--find-renames",
						"--find-copies",
						buildUnpushedRange(upstream),
						"-z",
					],
					options,
					signal,
				),
			);
		} else {
			unpushedMarker = `failed:${diffResult.code}`;
		}
	}

	return {
		status: statusResult.stdout,
		submodules,
		...(upstream ? { upstream } : {}),
		unpushedAvailable,
		unpushed,
		fingerprint: hashFingerprint([
			statusResult.stdout,
			submodules,
			upstream ?? "",
			unpushedMarker,
			unpushed,
			...contentParts,
		]),
	};
}

function parseSubmodulePaths(stageOutput: string): Set<string> {
	const paths = new Set<string>();
	for (const record of stageOutput.split("\0")) {
		const separator = record.indexOf("\t");
		if (separator < 0 || !record.slice(0, separator).startsWith("160000 ")) continue;
		const path = record.slice(separator + 1);
		if (path) paths.add(path);
	}
	return paths;
}

function enrichSubmodules(
	files: readonly ChangedFile[],
	submodulePaths: Set<string>,
): ChangedFile[] {
	return files.map((file) => {
		const isSubmodule =
			file.isSubmodule || pathNames(file).some((path) => submodulePaths.has(path));
		return isSubmodule ? { ...file, kind: "submodule", isSubmodule: true } : file;
	});
}

/** Collect only the Git file inventory. Diff text is loaded separately by the view. */
export async function collectChangesSnapshot(
	exec: GitExec,
	root: string,
	signal?: AbortSignal,
): Promise<ChangesSnapshot> {
	const state = await readGitState(exec, root, signal);
	const working = parsePorcelainStatusZ(state.status);
	const unpushed = state.unpushedAvailable ? parseNameStatusZ(state.unpushed) : [];
	const files = enrichSubmodules(
		mergeChangedFiles(working, unpushed),
		parseSubmodulePaths(state.submodules),
	);
	return {
		root,
		files,
		fingerprint: state.fingerprint,
		...(state.upstream ? { upstream: state.upstream } : {}),
		unpushedAvailable: state.unpushedAvailable,
	};
}

export interface FileDiffRequest {
	args: readonly string[];
	expectedExitCodes: readonly number[];
}

/** Build the safe, pathspec-delimited Git command for one file and view mode. */
export function buildFileDiffArgs(
	file: ChangedFile,
	base: string | undefined,
	contextLines: number,
): FileDiffRequest {
	const context = Number.isFinite(contextLines) ? Math.max(0, Math.floor(contextLines)) : 0;
	const common = [
		"--literal-pathspecs",
		"diff",
		"--no-color",
		"--no-ext-diff",
		"--no-textconv",
		`-U${context}`,
	];
	const isUntracked = file.kind === "untracked" || file.workingStatus?.trim() === "??";
	if (isUntracked) {
		return {
			args: [...common, "--no-index", "--", "/dev/null", file.path],
			expectedExitCodes: [0, 1],
		};
	}
	const baseArgs = [base ?? "HEAD"];
	const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
	return {
		args: [...common, "--find-renames", "--find-copies", ...baseArgs, "--", ...paths],
		expectedExitCodes: [0, 1],
	};
}

function sanitizeDiffContent(value: string): string {
	let result = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			if (code === 0x09) result += "\t";
			else result += `\\x${code.toString(16).padStart(2, "0")}`;
		} else {
			result += character;
		}
	}
	return result;
}

export interface ParsedUnifiedDiff {
	lines: string[];
	binary: boolean;
	empty: boolean;
	notes: string[];
}

function parseHunkHeader(line: string): { oldLine: number; newLine: number } | undefined {
	const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
	if (!match) return undefined;
	return { oldLine: Number(match[1]), newLine: Number(match[2]) };
}

/** Convert Git unified hunks to the line-number format used by the pastel renderer. */
export function parseUnifiedDiff(raw: string): ParsedUnifiedDiff {
	const normalized = raw.replace(/\r\n?/g, "\n");
	const rawLines = normalized.split("\n");
	if (rawLines.at(-1) === "") rawLines.pop();
	const binary = /(?:^|\n)(?:Binary files .* differ|GIT binary patch|literal \d+)/.test(normalized);
	const notes: string[] = [];
	const lines: string[] = [];
	let hunk: { oldLine: number; newLine: number } | undefined;
	let hunks = 0;

	for (const line of rawLines) {
		const nextHunk = parseHunkHeader(line);
		if (nextHunk) {
			if (hunks > 0) lines.push("⋯");
			hunk = nextHunk;
			hunks++;
			continue;
		}
		if (!hunk) {
			if (/^(?:\\ No newline at end of file)$/.test(line)) {
				notes.push("No newline at end of file.");
			} else if (
				/^(?:new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|copy from|copy to)\b/.test(
					line,
				)
			) {
				notes.push(sanitizeDiffContent(line));
			}
			continue;
		}
		if (line === "\\ No newline at end of file") {
			notes.push("No newline at end of file.");
			continue;
		}
		const prefix = line.charAt(0);
		const content = sanitizeDiffContent(line.slice(1));
		if (prefix === " ") {
			lines.push(` ${hunk.newLine} ${content}`);
			hunk.oldLine++;
			hunk.newLine++;
		} else if (prefix === "-") {
			lines.push(`-${hunk.oldLine} ${content}`);
			hunk.oldLine++;
		} else if (prefix === "+") {
			lines.push(`+${hunk.newLine} ${content}`);
			hunk.newLine++;
		}
	}

	return { lines, binary, empty: lines.length === 0 && !binary, notes: [...new Set(notes)] };
}

export interface FormatFileDiffOptions {
	isSubmodule?: boolean;
}

/** Pastel diff palette. Softer than the default edit-tool red/green. */
const DIFF_CONTEXT_COLOR = "\x1b[38;2;128;128;128m";
const DIFF_REMOVED_COLOR = "\x1b[38;2;242;139;130m";
const DIFF_ADDED_COLOR = "\x1b[38;2;129;201;149m";
const DIFF_COLOR_RESET = "\x1b[39m";
const DIFF_INVERSE_ON = "\x1b[7m";
const DIFF_INVERSE_OFF = "\x1b[27m";

function parseDiffLine(
	line: string,
): { prefix: string; lineNum: string; content: string } | undefined {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return undefined;
	return { prefix: match[1]!, lineNum: match[2]!, content: match[3]! };
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/** Highlight the changed middle of a single removed/added pair without a diff library. */
function intraLineHighlight(
	oldContent: string,
	newContent: string,
): { removed: string; added: string } {
	const minLen = Math.min(oldContent.length, newContent.length);
	let prefix = 0;
	while (prefix < minLen && oldContent[prefix] === newContent[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < minLen - prefix &&
		oldContent[oldContent.length - 1 - suffix] === newContent[newContent.length - 1 - suffix]
	) {
		suffix++;
	}
	const removedMiddle = oldContent.slice(prefix, oldContent.length - suffix);
	const addedMiddle = newContent.slice(prefix, newContent.length - suffix);
	return {
		removed:
			oldContent.slice(0, prefix) +
			`${DIFF_INVERSE_ON}${removedMiddle}${DIFF_INVERSE_OFF}` +
			oldContent.slice(oldContent.length - suffix),
		added:
			newContent.slice(0, prefix) +
			`${DIFF_INVERSE_ON}${addedMiddle}${DIFF_INVERSE_OFF}` +
			newContent.slice(newContent.length - suffix),
	};
}

/** Color line-numbered diff lines with the pastel palette. */
function renderPastelDiff(lines: readonly string[]): string[] {
	const result: string[] = [];
	let index = 0;
	while (index < lines.length) {
		const parsed = parseDiffLine(lines[index]!);
		if (!parsed) {
			result.push(`${DIFF_CONTEXT_COLOR}${lines[index]}${DIFF_COLOR_RESET}`);
			index++;
			continue;
		}
		if (parsed.prefix === "-") {
			const removedLines: Array<{ lineNum: string; content: string }> = [];
			while (index < lines.length) {
				const candidate = parseDiffLine(lines[index]!);
				if (!candidate || candidate.prefix !== "-") break;
				removedLines.push({ lineNum: candidate.lineNum, content: candidate.content });
				index++;
			}
			const addedLines: Array<{ lineNum: string; content: string }> = [];
			while (index < lines.length) {
				const candidate = parseDiffLine(lines[index]!);
				if (!candidate || candidate.prefix !== "+") break;
				addedLines.push({ lineNum: candidate.lineNum, content: candidate.content });
				index++;
			}
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0]!;
				const added = addedLines[0]!;
				const highlight = intraLineHighlight(
					replaceTabs(removed.content),
					replaceTabs(added.content),
				);
				result.push(
					`${DIFF_REMOVED_COLOR}-${removed.lineNum} ${highlight.removed}${DIFF_COLOR_RESET}`,
				);
				result.push(`${DIFF_ADDED_COLOR}+${added.lineNum} ${highlight.added}${DIFF_COLOR_RESET}`);
			} else {
				for (const removed of removedLines) {
					result.push(
						`${DIFF_REMOVED_COLOR}-${removed.lineNum} ${replaceTabs(removed.content)}${DIFF_COLOR_RESET}`,
					);
				}
				for (const added of addedLines) {
					result.push(
						`${DIFF_ADDED_COLOR}+${added.lineNum} ${replaceTabs(added.content)}${DIFF_COLOR_RESET}`,
					);
				}
			}
		} else if (parsed.prefix === "+") {
			result.push(
				`${DIFF_ADDED_COLOR}+${parsed.lineNum} ${replaceTabs(parsed.content)}${DIFF_COLOR_RESET}`,
			);
			index++;
		} else {
			result.push(
				`${DIFF_CONTEXT_COLOR} ${parsed.lineNum} ${replaceTabs(parsed.content)}${DIFF_COLOR_RESET}`,
			);
			index++;
		}
	}
	return result;
}

/** Parse and color one Git diff using the changes view's pastel palette. */
export function formatFileDiff(raw: string, options: FormatFileDiffOptions = {}): FileDiff {
	if (options.isSubmodule) {
		return { kind: "submodule", lines: [], note: "Submodule pointer changed." };
	}
	const parsed = parseUnifiedDiff(raw);
	if (parsed.binary) {
		return { kind: "binary", lines: [], note: "Binary file changed." };
	}
	if (parsed.empty) {
		return {
			kind: "empty",
			lines: [],
			note: parsed.notes.join("\n") || "No textual diff available.",
		};
	}
	return {
		kind: "text",
		lines: renderPastelDiff(parsed.lines),
		note: parsed.notes.length > 0 ? parsed.notes.join("\n") : undefined,
	};
}

interface BoundedOutput {
	text: string;
	truncated: boolean;
}

async function readBoundedOutput(filePath: string, fallback: string): Promise<BoundedOutput> {
	try {
		const handle = await open(filePath, "r");
		try {
			const buffer = Buffer.alloc(MAX_DIFF_OUTPUT_CHARS + 1);
			const result = await handle.read(buffer, 0, buffer.length, 0);
			return {
				text: buffer
					.subarray(0, Math.min(result.bytesRead, MAX_DIFF_OUTPUT_CHARS))
					.toString("utf8"),
				truncated: result.bytesRead > MAX_DIFF_OUTPUT_CHARS,
			};
		} finally {
			await handle.close();
		}
	} catch {
		return {
			text: boundedText(fallback, MAX_DIFF_OUTPUT_CHARS),
			truncated: fallback.length > MAX_DIFF_OUTPUT_CHARS,
		};
	}
}

function addOutputPath(args: readonly string[], outputPath: string): string[] {
	const result = [...args];
	const delimiter = result.indexOf("--");
	result.splice(delimiter < 0 ? result.length : delimiter, 0, `--output=${outputPath}`);
	return result;
}

async function resolveDiffBase(
	exec: GitExec,
	root: string,
	file: ChangedFile,
	snapshot: Pick<ChangesSnapshot, "upstream">,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (file.kind === "untracked" || file.workingStatus?.trim() === "??") return undefined;
	if (file.scopes.includes("unpushed") && snapshot.upstream) {
		const mergeBase = await exec("git", ["merge-base", snapshot.upstream, "HEAD"], {
			cwd: root,
			timeout: GIT_TIMEOUT_MS,
		});
		throwIfAborted(signal);
		if (mergeBase.code !== 0 || !mergeBase.stdout.trim()) {
			throw new Error(oneLine(mergeBase.stderr) || "Could not resolve the Git merge base.");
		}
		return mergeBase.stdout.trim();
	}
	const head = await exec("git", ["rev-parse", "--verify", "HEAD"], {
		cwd: root,
		timeout: GIT_TIMEOUT_MS,
	});
	throwIfAborted(signal);
	if (head.code === 0 && head.stdout.trim()) return "HEAD";
	const emptyTree = await exec("git", ["hash-object", "-t", "tree", "/dev/null"], {
		cwd: root,
		timeout: GIT_TIMEOUT_MS,
	});
	throwIfAborted(signal);
	if (emptyTree.code !== 0 || !emptyTree.stdout.trim()) {
		throw new Error(oneLine(emptyTree.stderr) || "Could not resolve the empty Git tree.");
	}
	return emptyTree.stdout.trim();
}

export async function fetchFileDiff(
	exec: GitExec,
	root: string,
	file: ChangedFile,
	mode: DiffMode,
	snapshot: Pick<ChangesSnapshot, "upstream">,
	signal?: AbortSignal,
): Promise<FileDiff> {
	throwIfAborted(signal);
	if (file.isSubmodule) return formatFileDiff("", { isSubmodule: true });
	let temporaryDirectory: string | undefined;
	try {
		const base = await resolveDiffBase(exec, root, file, snapshot, signal);
		const request = buildFileDiffArgs(
			file,
			base,
			mode === "full" ? FULL_FILE_CONTEXT_LINES : DEFAULT_CONTEXT_LINES,
		);
		temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-changes-diff-"));
		const outputPath = join(temporaryDirectory, "diff");
		const result = await exec("git", addOutputPath(request.args, outputPath), {
			cwd: root,
			timeout: GIT_TIMEOUT_MS,
		});
		throwIfAborted(signal);
		if (!request.expectedExitCodes.includes(result.code)) {
			throw new Error(oneLine(result.stderr) || `Git command exited with code ${result.code}.`);
		}
		const output = await readBoundedOutput(outputPath, result.stdout);
		const diff = formatFileDiff(output.text);
		return output.truncated
			? { ...diff, note: `${diff.note ? `${diff.note}\n` : ""}Diff output truncated.` }
			: diff;
	} catch (error) {
		if (signal?.aborted || isAbortError(error))
			throw cancellationError(signal ?? new AbortController().signal);
		return { kind: "unavailable", lines: [], note: safeTerminalText(errorText(error)) };
	} finally {
		if (temporaryDirectory)
			await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function findRepositoryRoot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	try {
		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		});
		if (result.code !== 0) return undefined;
		const root = result.stdout.trim();
		return root || undefined;
	} catch {
		return undefined;
	}
}

function piGitExec(pi: ExtensionAPI): GitExec {
	return async (command, args, options) => {
		const result = await pi.exec(command, [...args], options);
		return { code: result.code, stdout: result.stdout, stderr: result.stderr };
	};
}

async function isSnapshotCurrent(
	pi: ExtensionAPI,
	root: string,
	snapshot: ChangesSnapshot,
	signal: AbortSignal,
): Promise<boolean> {
	const current = await readGitState(piGitExec(pi), root, signal);
	return current.fingerprint === snapshot.fingerprint;
}

async function loadChanges(
	pi: ExtensionAPI,
	root: string,
	signal: AbortSignal,
): Promise<ChangesDisplay> {
	const exec = piGitExec(pi);
	const snapshot = await collectChangesSnapshot(exec, root, signal);
	let stale = false;
	try {
		const current = await readGitState(exec, root, signal);
		stale = current.fingerprint !== snapshot.fingerprint;
	} catch (error) {
		if (signal.aborted) throw cancellationError(signal);
		throw error;
	}
	return { snapshot, stale };
}

const VIEW_HINTS = [
	{ key: "←→/Tab", label: "switch" },
	{ key: "↑↓", label: "scroll" },
	{ key: "PgUp/PgDn", label: "page" },
	{ key: "Home/End", label: "jump" },
	{ key: "Ctrl+O", label: "full file" },
	{ key: "E", label: "edit" },
	{ key: "R", label: "refresh" },
	{ key: "Esc", label: "close" },
] as const;

interface DiffCacheEntry {
	collapsed?: FileDiff;
	full?: FileDiff;
}

function cacheValue(entry: DiffCacheEntry | undefined, mode: DiffMode): FileDiff | undefined {
	return mode === "full" ? entry?.full : entry?.collapsed;
}

function setCacheValue(entry: DiffCacheEntry, mode: DiffMode, value: FileDiff): void {
	if (mode === "full") entry.full = value;
	else entry.collapsed = value;
}

function tabStatus(file: ChangedFile): { value: string; color: ThemeColor } {
	const status = (file.workingStatus ?? file.unpushedStatus ?? file.status).trim();
	if (file.kind === "untracked" || status === "??") return { value: "?", color: "success" };
	if (file.kind === "added") return { value: "A", color: "success" };
	if (file.kind === "deleted") return { value: "D", color: "error" };
	if (file.kind === "renamed") return { value: "R", color: "accent" };
	if (file.kind === "copied") return { value: "C", color: "accent" };
	return { value: status.charAt(0).toUpperCase() || "M", color: "text" };
}

function changeIcon(file: ChangedFile): { value: string; color: ThemeColor } {
	switch (file.kind) {
		case "added":
			return { value: "+", color: "success" };
		case "modified":
			return { value: "~", color: "warning" };
		case "deleted":
			return { value: "−", color: "error" };
		case "renamed":
			return { value: "→", color: "accent" };
		case "copied":
			return { value: "⧉", color: "accent" };
		case "untracked":
			return { value: "?", color: "success" };
		case "typechange":
			return { value: "↕", color: "warning" };
		case "unmerged":
			return { value: "!", color: "error" };
		case "submodule":
			return { value: "◆", color: "accent" };
		default:
			return { value: "•", color: "muted" };
	}
}

function pathBasename(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function tabLabel(file: ChangedFile, files: readonly ChangedFile[]): string {
	const basename = pathBasename(file.path);
	const duplicate = files.some(
		(candidate) => candidate !== file && pathBasename(candidate.path) === basename,
	);
	return safePath(duplicate ? file.path : basename);
}

function renderAlignedRow(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	const boundedRight = truncateToWidth(right, width);
	const rightWidth = visibleWidth(boundedRight);
	const gap = 2;
	if (rightWidth + gap >= width) return boundedRight;
	const boundedLeft = truncateToWidth(left, width - rightWidth - gap);
	const spacing = Math.max(gap, width - visibleWidth(boundedLeft) - rightWidth);
	return `${boundedLeft}${" ".repeat(spacing)}${boundedRight}`;
}

function wrapDiffDisplayLine(line: string, width: number): string[] {
	if (visibleWidth(line) <= width) return [line];
	const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
	const gutter = plain.match(/^[ +\-]\s*\d+\s/)?.[0];
	const gutterWidth = gutter ? visibleWidth(gutter) : 0;
	if (gutterWidth === 0 || gutterWidth >= width) return wrapTextWithAnsi(line, width);
	const contentVisibleWidth = visibleWidth(line) - gutterWidth;
	const prefix = sliceByColumn(line, 0, gutterWidth);
	const content = sliceByColumn(line, gutterWidth, contentVisibleWidth);
	const wrapped = wrapTextWithAnsi(content, width - gutterWidth);
	return wrapped.map((segment, index) => {
		const hangingIndent = index === 0 ? prefix : " ".repeat(gutterWidth);
		return `${hangingIndent}${segment}\x1b[0m`;
	});
}

function renderTabRow(segments: readonly string[], selected: number, width: number): string {
	if (segments.length === 0 || width <= 0) return "";
	const separatorWidth = 1;
	const widths = segments.map((segment) => visibleWidth(segment));
	const total =
		widths.reduce((sum, value) => sum + value, 0) + separatorWidth * (segments.length - 1);
	if (total <= width) return segments.join(" ");

	let left = Math.min(Math.max(0, selected), segments.length - 1);
	let right = left;
	let used = widths[left] ?? 0;
	while (true) {
		const hasLeft = left > 0;
		const hasRight = right < segments.length - 1;
		const indicatorWidth = (hasLeft ? 2 : 0) + (hasRight ? 2 : 0);
		let expanded = false;
		if (hasLeft && used + separatorWidth + (widths[left - 1] ?? 0) + indicatorWidth <= width) {
			left--;
			used += separatorWidth + (widths[left] ?? 0);
			expanded = true;
		}
		if (hasRight && used + separatorWidth + (widths[right + 1] ?? 0) + indicatorWidth <= width) {
			right++;
			used += separatorWidth + (widths[right] ?? 0);
			expanded = true;
		}
		if (!expanded) break;
	}
	const prefix = left > 0 ? "… " : "";
	const suffix = right < segments.length - 1 ? " …" : "";
	const available = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
	const body = truncateToWidth(segments.slice(left, right + 1).join(" "), available);
	return `${prefix}${body}${suffix}`;
}

/** Full-screen diff browser for the current Git changes. */
export class ChangesView implements Component {
	private readonly viewport = new ScrollViewportState();
	private readonly unsubscribeAnimation: () => void;
	private controller?: AbortController;
	private requestId = 0;
	private spinnerFrame = 0;
	private disposed = false;
	private loading = false;
	private error?: string;
	private display?: ChangesDisplay;
	private selected = 0;
	private fullFile = false;
	private readonly diffCache = new Map<string, DiffCacheEntry>();
	private readonly pendingDiffs = new Map<string, Promise<void>>();

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly options: ChangesViewOptions,
	) {
		this.unsubscribeAnimation = subscribeProcessAnimation(() => {
			if (!this.loading || this.disposed) return;
			this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
			this.tui.requestRender();
		});
		void this.refresh();
	}

	private contentWidth(width: number): number {
		return Math.max(1, getContentWidth(Math.max(1, width)));
	}

	private subtitle(width: number): string {
		let summary: string;
		if (!this.display) {
			summary = this.loading ? "Loading" : "Unavailable";
		} else {
			const files = this.display.snapshot.files;
			const working = files.filter((file) => file.scopes.includes("uncommitted")).length;
			const ahead = files.filter((file) => file.scopes.includes("unpushed")).length;
			const fileWord = files.length === 1 ? "file" : "files";
			const parts = [`${files.length} ${fileWord}`];
			if (working > 0) parts.push(`Working ${working}`);
			if (ahead > 0) parts.push(`Ahead ${ahead}`);
			else if (!this.display.snapshot.unpushedAvailable) parts.push("No upstream");
			if (this.display.stale) parts.push("Snapshot changed");
			summary = parts.join(" · ");
		}
		const contentWidth = this.contentWidth(width);
		const padding = Math.max(0, contentWidth - visibleWidth("Changes") - visibleWidth(summary) - 1);
		return `${" ".repeat(padding)}${summary}`;
	}

	private selectedFile(): ChangedFile | undefined {
		return this.display?.snapshot.files[this.selected];
	}

	private headerLines(width: number): string[] {
		const file = this.selectedFile();
		if (!file) {
			return this.loading
				? [this.theme.fg("warning", `${SPINNER_FRAMES[this.spinnerFrame]} Loading changes...`)]
				: [];
		}
		const files = this.display?.snapshot.files ?? [];
		const tabs = files.map((candidate, index) => {
			const label = tabLabel(candidate, files);
			const icon = changeIcon(candidate);
			const iconText = this.theme.fg(icon.color, icon.value);
			if (index !== this.selected) {
				return ` ${iconText} ${this.theme.fg("muted", label)} `;
			}
			const highlighted = ` ${iconText} ${this.theme.fg("accent", this.theme.bold(label))} `;
			const themeWithBackground = this.theme as Theme & {
				bg?: (color: "selectedBg", text: string) => string;
			};
			return themeWithBackground.bg
				? themeWithBackground.bg("selectedBg", highlighted)
				: highlighted;
		});
		const state = tabStatus(file);
		const mode = this.fullFile ? "Full file" : `Context ${DEFAULT_CONTEXT_LINES}`;
		const details = `${this.theme.fg(state.color, state.value)} · ${this.theme.fg("muted", mode)}`;
		const contentWidth = this.contentWidth(width);
		const meta = renderAlignedRow(safePath(file.path), details, contentWidth);
		return ["", renderTabRow(tabs, this.selected, contentWidth), "", meta];
	}

	private cachedDiff(file: ChangedFile, mode: DiffMode): FileDiff | undefined {
		return cacheValue(this.diffCache.get(file.path), mode);
	}

	private ensureDiff(file: ChangedFile, mode: DiffMode, signal: AbortSignal): Promise<void> {
		const snapshot = this.display?.snapshot;
		if (!snapshot) return Promise.resolve();
		const cached = this.cachedDiff(file, mode);
		if (cached) return Promise.resolve();
		const key = `${file.path}\0${mode}`;
		const existing = this.pendingDiffs.get(key);
		if (existing) return existing;
		const promise = this.options
			.fetchDiff(file, mode, snapshot, signal)
			.catch((error: unknown): FileDiff => {
				if (signal.aborted || isAbortError(error)) throw cancellationError(signal);
				return { kind: "unavailable", lines: [], note: safeTerminalText(errorText(error)) };
			})
			.then(async (diff) => {
				if (this.disposed || signal.aborted) return;
				if (this.options.isSnapshotCurrent) {
					let current = false;
					try {
						current = await this.options.isSnapshotCurrent(snapshot, signal);
					} catch (error) {
						if (signal.aborted || isAbortError(error)) throw cancellationError(signal);
					}
					if (!current) {
						if (this.display?.snapshot === snapshot)
							this.display = { ...this.display, stale: true };
						this.viewport.home();
						this.tui.requestRender();
						return;
					}
				}
				const entry = this.diffCache.get(file.path) ?? {};
				setCacheValue(entry, mode, diff);
				this.diffCache.set(file.path, entry);
				this.tui.requestRender();
			})
			.finally(() => {
				if (this.pendingDiffs.get(key) === promise) this.pendingDiffs.delete(key);
			});
		this.pendingDiffs.set(key, promise);
		return promise;
	}

	private startInitialDiffLoad(display: ChangesDisplay, signal: AbortSignal): void {
		if (display.stale) return;
		const first = display.snapshot.files[0];
		if (first) void this.ensureDiff(first, "collapsed", signal).catch(() => undefined);
	}

	private bodyLines(width: number): string[] {
		const contentWidth = this.contentWidth(width);
		if (this.error) {
			return [
				this.theme.fg("error", "Could not inspect Git changes."),
				this.theme.fg("muted", safeTerminalText(this.error)),
			];
		}
		if (this.loading) {
			const frame = SPINNER_FRAMES[this.spinnerFrame] ?? SPINNER_FRAMES[0];
			return [
				this.theme.fg("warning", `${frame} Loading changes...`),
				this.theme.fg("muted", "Collecting the current Git file inventory."),
			];
		}
		const file = this.selectedFile();
		if (!this.display) return [this.theme.fg("dim", "No changes view available.")];
		if (!file) return [this.theme.fg("text", "No current Git changes.")];
		if (this.display.stale) {
			return [this.theme.fg("warning", "Snapshot changed while loading. Press R to refresh.")];
		}
		const mode: DiffMode = this.fullFile ? "full" : "collapsed";
		const diff = this.cachedDiff(file, mode);
		if (!diff) {
			const frame = SPINNER_FRAMES[this.spinnerFrame] ?? SPINNER_FRAMES[0];
			return [this.theme.fg("warning", `${frame} Loading diff for ${safePath(file.path)}...`)];
		}
		const lines = [...diff.lines];
		if (diff.note)
			lines.push(
				...diff.note.split("\n").map((line) => this.theme.fg("muted", safeTerminalText(line))),
			);
		if (lines.length === 0) lines.push(this.theme.fg("muted", "No textual diff available."));
		return lines.flatMap((line) => wrapDiffDisplayLine(line, contentWidth));
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const height = Math.max(0, Math.floor(this.tui.terminal.rows));
		let headerLines = this.headerLines(renderWidth);
		let hints: readonly (typeof VIEW_HINTS)[number][] = VIEW_HINTS;
		let divider = true;
		const chromeFits = (): boolean => {
			const header = renderHeader({
				width: renderWidth,
				title: "Changes",
				subtitle: this.subtitle(renderWidth),
				lines: headerLines,
				divider,
				theme: this.theme,
			});
			const footer = renderFooter({ width: renderWidth, hints, divider, theme: this.theme });
			return height - header.length - footer.length >= 1;
		};
		while (!chromeFits()) {
			if (hints.length > 0) {
				hints = hints.slice(0, -1);
				continue;
			}
			if (headerLines.length > 0) {
				if (headerLines.length === 4 && headerLines[0] === "" && headerLines[2] === "") {
					headerLines = headerLines.slice(0, 2);
				} else if (headerLines.length === 2 && headerLines[0] === "") {
					headerLines = [];
				} else {
					headerLines = headerLines.slice(0, -1);
				}
				continue;
			}
			if (divider) {
				divider = false;
				continue;
			}
			break;
		}
		const footer = renderFooter({ width: renderWidth, hints, divider, theme: this.theme });
		const header = renderHeader({
			width: renderWidth,
			title: "Changes",
			subtitle: this.subtitle(renderWidth),
			lines: headerLines,
			divider,
			theme: this.theme,
		});
		const body = this.bodyLines(renderWidth);
		const bodyHeight = Math.max(0, height - header.length - footer.length);
		const range = this.viewport.update(body.length, bodyHeight);
		return renderFullscreenScreen({
			width: renderWidth,
			height,
			title: "Changes",
			subtitle: this.subtitle(renderWidth),
			headerLines,
			body: body.slice(range.start, range.end),
			keyHints: hints,
			divider,
			theme: this.theme,
		});
	}

	private async runRefresh(): Promise<void> {
		if (this.disposed) return;
		this.controller?.abort();
		this.loading = true;
		this.error = undefined;
		this.display = undefined;
		this.selected = 0;
		this.fullFile = false;
		this.diffCache.clear();
		this.pendingDiffs.clear();
		this.viewport.home();
		this.spinnerFrame = 0;
		const requestId = ++this.requestId;
		const controller = new AbortController();
		this.controller = controller;
		this.tui.requestRender();
		try {
			const display = await this.options.load(controller.signal);
			if (this.disposed || requestId !== this.requestId || controller.signal.aborted) return;
			this.display = display;
			this.loading = false;
			this.selected = 0;
			this.viewport.home();
			this.startInitialDiffLoad(display, controller.signal);
		} catch (error) {
			if (this.disposed || requestId !== this.requestId || controller.signal.aborted) return;
			this.error = isAbortError(error) ? "Refresh cancelled." : errorText(error);
		} finally {
			if (requestId === this.requestId) {
				this.loading = false;
				this.tui.requestRender();
			}
		}
	}

	async refresh(): Promise<void> {
		await this.runRefresh();
	}

	private switchFile(delta: number): void {
		const count = this.display?.snapshot.files.length ?? 0;
		if (count === 0) return;
		this.selected = (this.selected + delta + count) % count;
		this.viewport.home();
		const file = this.selectedFile();
		if (file && this.controller)
			void this.ensureDiff(
				file,
				this.fullFile ? "full" : "collapsed",
				this.controller.signal,
			).catch(() => undefined);
		this.tui.requestRender();
	}

	private close(result?: string): void {
		if (this.disposed) return;
		this.disposed = true;
		this.controller?.abort();
		this.options.done(result);
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.close();
			return;
		}
		const file = this.selectedFile();
		if ((data === "e" || data === "E") && file) {
			this.close(file.path);
			return;
		}
		if (data === "r" || data === "R") {
			void this.refresh();
			return;
		}
		if (matchesKey(data, "left") || data === "\x1b[Z" || matchesKey(data, "shift+tab")) {
			this.switchFile(-1);
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "tab")) {
			this.switchFile(1);
			return;
		}
		if (matchesKey(data, "ctrl+o")) {
			if (!file) return;
			this.fullFile = !this.fullFile;
			this.viewport.home();
			if (this.controller)
				void this.ensureDiff(
					file,
					this.fullFile ? "full" : "collapsed",
					this.controller.signal,
				).catch(() => undefined);
			this.tui.requestRender();
			return;
		}
		const previous = this.viewport.offset;
		if (matchesKey(data, "up")) this.viewport.scrollBy(-1);
		else if (matchesKey(data, "down")) this.viewport.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.viewport.pageBy(-1);
		else if (matchesKey(data, "pageDown")) this.viewport.pageBy(1);
		else if (matchesKey(data, "home")) this.viewport.home();
		else if (matchesKey(data, "end")) this.viewport.end();
		else return;
		if (this.viewport.offset !== previous) this.tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		if (this.disposed) {
			this.unsubscribeAnimation();
			this.controller?.abort();
			return;
		}
		this.disposed = true;
		this.controller?.abort();
		this.unsubscribeAnimation();
	}
}

export default function changesExtension(pi: ExtensionAPI): void {
	let activeView = false;
	pi.registerCommand("changes", {
		description: "Browse current uncommitted and unpushed Git diffs",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/changes requires interactive mode", "error");
				return;
			}
			if (activeView) {
				ctx.ui.notify("A changes view is already open", "info");
				return;
			}
			activeView = true;
			try {
				const root = await findRepositoryRoot(pi, ctx.cwd);
				if (!root) {
					ctx.ui.notify("Current directory is not inside a Git repository.", "error");
					return;
				}
				const result = await ctx.ui.custom<string | undefined>(
					(tui, theme, _keybindings, done) =>
						new ChangesView(tui, theme, {
							root,
							load: (signal) => loadChanges(pi, root, signal),
							fetchDiff: (file, mode, snapshot, signal) =>
								fetchFileDiff(piGitExec(pi), root, file, mode, snapshot, signal),
							isSnapshotCurrent: (snapshot, signal) =>
								isSnapshotCurrent(pi, root, snapshot, signal),
							done,
						}),
					fullscreenOverlayOptions(),
				);
				if (result) {
					const editorText = ctx.ui.getEditorText();
					if (!editorText.trim() && editorText.length > 0) ctx.ui.setEditorText("");
					ctx.ui.pasteToEditor(result);
					// Overlay close redraws before this handler resumes; request one more frame
					// after the synchronous editor update so the inserted path is immediately visible.
					ctx.ui.setStatus(EDITOR_HANDOFF_REDRAW_KEY, undefined);
				}
			} finally {
				activeView = false;
			}
		},
	});
}

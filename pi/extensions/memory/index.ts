import {
	completeSimple,
	type Api,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import {
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	copyFile,
	lstat,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	buildMemoryPrompt,
	contentRevision,
	containsSensitiveData,
	extractText,
	formatMemoryContext,
	MAX_MEMORY_CHARS,
	MEMORY_CONTEXT_TYPE,
	normalizeCandidate,
	parseMergedMemory,
	stableRepoId,
	type MemoryBundle,
	type MemoryScope,
} from "./core.ts";
import {
	ExpandableToolRender,
	emptyCollapsedToolRender,
	fullscreenOverlayOptions,
	getContentWidth,
	renderFullscreenScreen,
	ScrollViewportState,
	shouldRevealToolDetails,
} from "../lib/tui/index.ts";

const MAX_SNAPSHOT_COUNT = 3;
const MAX_EXPORT_CHARS = MAX_MEMORY_CHARS * 2 + 300;
const MAX_QUEUE_ITEMS = 32;
const MAX_QUEUE_CHARS = 8_000;
const MAX_MEMORY_TOKENS = 8_000;
const MERGE_ATTEMPTS = 2;
const COMMIT_LOCK_STALE_MS = 10_000;
const COMMIT_LOCK_ATTEMPTS = 40;
const COMMIT_LOCK_WAIT_MS = 25;
const MEMORY_SYSTEM_PROMPT = [
	"You are maintaining a small durable Markdown memory file.",
	"Output only the complete merged Markdown aggregate. Never output a preamble, analysis, code fence, credentials, or private data.",
].join(" ");

type ModelType = Model<Api>;
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type CompleteMemory = typeof completeSimple;

type ModelRegistry = ExtensionContext["modelRegistry"];

export interface MemoryExtensionOptions {
	complete?: CompleteMemory;
}

export interface MemoryPaths {
	globalPath: string;
	localPath: string;
	mirrorPath: string;
	repoId: string;
}

interface AggregateRead {
	content: string;
	revision: string;
}

interface CommitResult {
	committed: boolean;
}

interface QueueItem {
	scope: MemoryScope;
	candidate: string;
	cwd: string;
	model: ModelType;
	thinking: ThinkingLevel;
	modelRegistry: ModelRegistry;
}

interface MemoryToolDetails {
	scope?: MemoryScope;
	queued: boolean;
	rejected?: boolean;
}

type MemoryBranchEntry = {
	type?: unknown;
	customType?: unknown;
	content?: unknown;
	id?: unknown;
};

interface MemoryContextCache {
	sessionManager: object;
	sessionId?: string;
	branchKey: string;
	content: string;
}

const MemoryParams = Type.Object({
	scope: Type.Union([Type.Literal("global"), Type.Literal("local")], {
		description:
			"Use global for durable preferences or facts that apply across repositories; use local for project-specific decisions, conventions, or facts.",
	}),
	content: Type.String({
		minLength: 1,
		maxLength: 4_000,
		description:
			"Durable guidance or a stable fact only. Do not save temporary task state, guesses, secrets, credentials, raw conversation, or information already captured by project instructions.",
	}),
});

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function memoryMessageContent(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	const text = extractText(value as Array<{ type?: string; text?: unknown }>);
	return text || undefined;
}

function memoryBranchKey(entries: MemoryBranchEntry[]): string {
	return entries
		.map((entry, index) => {
			const id = typeof entry.id === "string" ? entry.id : `${index}:${String(entry.type)}`;
			return `${id}:${String(entry.customType ?? "")}`;
		})
		.join("\u0000");
}

function latestMemorySnapshot(entries: MemoryBranchEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom_message" || entry.customType !== MEMORY_CONTEXT_TYPE) continue;
		return memoryMessageContent(entry.content);
	}
	return undefined;
}

function sessionId(ctx: ExtensionContext): string | undefined {
	const manager = ctx.sessionManager as unknown as { getSessionId?: () => unknown };
	const value = manager.getSessionId?.();
	return typeof value === "string" ? value : undefined;
}

function toolResult(
	text: string,
	details: MemoryToolDetails,
): { content: [{ type: "text"; text: string }]; details: MemoryToolDetails } {
	return { content: [{ type: "text", text }], details };
}

function gitCommonDir(cwd: string): string | undefined {
	try {
		const result = execFileSync("git", ["rev-parse", "--git-common-dir"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (!result) return undefined;
		return resolve(cwd, result);
	} catch {
		return undefined;
	}
}

export function resolveMemoryPaths(cwd: string): MemoryPaths {
	const globalPath = join(homedir(), ".pi", "agent", "state", "memory", "global.md");
	const commonDir = gitCommonDir(cwd);
	const localPath = join(commonDir ?? resolve(cwd, ".pi"), commonDir ? "pi" : "", "memory.md");
	const repositoryPath = commonDir ?? resolve(cwd);
	const repoId = stableRepoId(repositoryPath);
	return {
		globalPath,
		localPath,
		repoId,
		mirrorPath: join(homedir(), ".pi", "agent", "state", "memory", "projects", repoId, "memory.md"),
	};
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: string }).code === "ENOENT"
	);
}

function emptyAggregate(): AggregateRead {
	return { content: "", revision: contentRevision("") };
}

async function readAggregate(path: string): Promise<AggregateRead> {
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		if (isMissing(error)) return emptyAggregate();
		throw error;
	}
	if (info.isSymbolicLink()) throw new Error(`memory source is a symlink: ${path}`);
	if (!info.isFile()) throw new Error(`memory source is not a regular file: ${path}`);
	const raw = (await readFile(path, "utf8")).replace(/\r\n?/g, "\n").trim();
	if (containsSensitiveData(raw)) throw new Error(`sensitive data in memory source: ${path}`);
	const revision = contentRevision(raw);
	const content =
		raw.length > MAX_MEMORY_CHARS
			? `${raw.slice(0, MAX_MEMORY_CHARS - 40)}\n...[memory truncated]...`
			: raw;
	return { content, revision };
}

async function readAggregateForInjection(path: string): Promise<AggregateRead> {
	try {
		return await readAggregate(path);
	} catch {
		return emptyAggregate();
	}
}

export async function readMemoryBundle(cwd: string): Promise<MemoryBundle> {
	const paths = resolveMemoryPaths(cwd);
	const [global, local] = await Promise.all([
		readAggregateForInjection(paths.globalPath),
		readAggregateForInjection(paths.localPath),
	]);
	return { global: global.content, local: local.content };
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

async function snapshotBeforeOverwrite(path: string): Promise<void> {
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		if (isMissing(error)) return;
		throw error;
	}
	if (info.isSymbolicLink()) throw new Error(`refusing to overwrite symlink: ${path}`);
	if (!info.isFile()) throw new Error(`refusing to overwrite non-file: ${path}`);
	const oldest = `${path}.${MAX_SNAPSHOT_COUNT + 1}`;
	if (await pathExists(oldest)) await unlink(oldest);
	for (let index = MAX_SNAPSHOT_COUNT - 1; index >= 1; index--) {
		const source = `${path}.${index}`;
		const target = `${path}.${index + 1}`;
		if (await pathExists(source)) await rename(source, target);
	}
	await copyFile(path, `${path}.1`);
}

export async function atomicWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	try {
		const existing = await lstat(path);
		if (existing.isSymbolicLink()) throw new Error(`refusing to overwrite symlink: ${path}`);
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${content.trim()}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
	} finally {
		if (await pathExists(temporary)) {
			try {
				await unlink(temporary);
			} catch {
				/* best effort cleanup */
			}
		}
	}
}

async function overwriteAggregate(path: string, content: string): Promise<void> {
	await snapshotBeforeOverwrite(path);
	await atomicWrite(path, content);
}

function formatExport(bundle: MemoryBundle): string {
	return [
		"# Pi Memory Export",
		"",
		"## Global",
		"",
		bundle.global || "(empty)",
		"",
		"## Local Project",
		"",
		bundle.local || "(empty)",
		"",
	].join("\n");
}

export function formatMemoryText(bundle: MemoryBundle): string {
	const text = formatExport(bundle);
	return text.length <= MAX_EXPORT_CHARS
		? text
		: `${text.slice(0, MAX_EXPORT_CHARS - 40)}\n...[export truncated]...`;
}

function outputText(message: { content: unknown }): string {
	return Array.isArray(message.content)
		? extractText(message.content as Array<{ type?: string; text?: unknown }>)
		: "";
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function acquireCommitLock(path: string, signal: AbortSignal): Promise<() => Promise<void>> {
	const lockPath = `${path}.lock`;
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < COMMIT_LOCK_ATTEMPTS; attempt++) {
		if (signal.aborted) throw new Error("memory merge cancelled");
		try {
			await mkdir(lockPath, { mode: 0o700 });
			return async () => {
				await rm(lockPath, { recursive: true, force: true });
			};
		} catch (error) {
			if (
				!isMissing(error) &&
				!(
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					(error as { code?: string }).code === "EEXIST"
				)
			) {
				throw error;
			}
			try {
				const age = Date.now() - (await stat(lockPath)).mtimeMs;
				if (age > COMMIT_LOCK_STALE_MS) await rm(lockPath, { recursive: true, force: true });
			} catch {
				// A concurrently released lock can disappear between stat and recovery.
			}
		}
		await wait(COMMIT_LOCK_WAIT_MS);
	}
	throw new Error("memory commit lock is busy");
}

async function commitAggregate(
	target: string,
	before: AggregateRead,
	merged: string,
	mirrorPath: string | undefined,
	signal: AbortSignal,
): Promise<CommitResult> {
	const release = await acquireCommitLock(target, signal);
	try {
		if (signal.aborted) throw new Error("memory merge cancelled");
		const current = await readAggregate(target);
		if (current.revision !== before.revision) return { committed: false };
		if (signal.aborted) throw new Error("memory merge cancelled");
		await overwriteAggregate(target, merged);
		if (mirrorPath && !signal.aborted) {
			try {
				await overwriteAggregate(mirrorPath, merged);
			} catch {
				/* mirror failure must not disrupt the primary file */
			}
		}
		return { committed: true };
	} finally {
		await release();
	}
}

async function mergeOne(
	item: QueueItem,
	paths: MemoryPaths,
	signal: AbortSignal,
	completeMemory: CompleteMemory,
): Promise<void> {
	for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt++) {
		if (signal.aborted) return;
		const target = item.scope === "global" ? paths.globalPath : paths.localPath;
		const before = await readAggregate(target);
		if (signal.aborted) return;
		const auth = await item.modelRegistry.getApiKeyAndHeaders(item.model);
		if (!auth.ok) throw new Error(auth.error);
		const message: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: buildMemoryPrompt(item.scope, before.content, item.candidate) },
			],
			timestamp: Date.now(),
		};
		const response = await completeMemory(
			item.model,
			{ systemPrompt: MEMORY_SYSTEM_PROMPT, messages: [message], tools: [] },
			{
				...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
				headers: auth.headers,
				env: auth.env,
				reasoningEffort: item.thinking,
				toolChoice: "none",
				maxTokens: MAX_MEMORY_TOKENS,
				signal,
			},
		);
		if (response.stopReason === "error")
			throw new Error(response.errorMessage ?? "memory merge failed");
		if (response.stopReason !== "stop") throw new Error("memory merge was incomplete");
		const merged = parseMergedMemory(outputText(response));
		if (!merged || containsSensitiveData(merged)) throw new Error("memory merge was rejected");
		if (signal.aborted) return;

		const result = await commitAggregate(
			target,
			before,
			merged,
			item.scope === "local" ? paths.mirrorPath : undefined,
			signal,
		);
		if (result.committed) return;
	}
	throw new Error("memory changed while it was being merged");
}

export class MemoryView implements Component {
	private readonly scroll = new ScrollViewportState();
	private readonly markdown: Markdown;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		bundle: MemoryBundle,
		private readonly done: () => void,
	) {
		this.markdown = new Markdown(formatMemoryText(bundle), 0, 0, getMarkdownTheme());
	}

	render(width: number): string[] {
		const height = Math.max(0, Math.floor(this.tui.terminal.rows));
		const body = this.markdown.render(Math.max(1, getContentWidth(width)));
		const range = this.scroll.update(body.length, Math.max(0, height - 5));
		return renderScreen(width, height, body.slice(range.start, range.end), this.theme);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.done();
			return;
		}
		const previous = this.scroll.offset;
		if (matchesKey(data, "up")) this.scroll.scrollBy(-1);
		else if (matchesKey(data, "down")) this.scroll.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.scroll.pageBy(-1);
		else if (matchesKey(data, "pageDown")) this.scroll.pageBy(1);
		else if (matchesKey(data, "home")) this.scroll.home();
		else if (matchesKey(data, "end")) this.scroll.end();
		else return;
		if (this.scroll.offset !== previous) this.tui.requestRender();
	}

	invalidate(): void {
		this.markdown.invalidate();
	}
}

async function canonicalPath(path: string): Promise<string> {
	const absolute = resolve(path);
	try {
		return await realpath(absolute);
	} catch (error) {
		if (!isMissing(error) || dirname(absolute) === absolute) throw error;
		return join(await canonicalPath(dirname(absolute)), basename(absolute));
	}
}

async function sameFile(first: string, second: string): Promise<boolean> {
	try {
		const [left, right] = await Promise.all([lstat(first), lstat(second)]);
		return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;
	} catch {
		return false;
	}
}

function renderScreen(width: number, height: number, body: string[], theme: Theme): string[] {
	return renderFullscreenScreen({
		width,
		height,
		title: "Memories",
		subtitle: "global and local project memory",
		body,
		keyHints: [
			{ key: "↑↓", label: "scroll" },
			{ key: "PgUp/PgDn", label: "page" },
			{ key: "Esc/Q", label: "close" },
		],
		theme,
	});
}

export function registerMemoryExtension(
	pi: ExtensionAPI,
	options: MemoryExtensionOptions = {},
): void {
	const completeMemory = options.complete ?? completeSimple;
	let lastMemoryContext: MemoryContextCache | undefined;
	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			const bundle = await readMemoryBundle(ctx.cwd);
			const content = formatMemoryContext(bundle);
			const branch = Array.from(ctx.sessionManager.getBranch()) as MemoryBranchEntry[];
			const branchKey = memoryBranchKey(branch);
			const currentSessionId = sessionId(ctx);
			const alreadyInBranch = latestMemorySnapshot(branch) === content;
			const alreadyEmitted =
				lastMemoryContext?.sessionManager === ctx.sessionManager &&
				lastMemoryContext.sessionId === currentSessionId &&
				lastMemoryContext.branchKey === branchKey &&
				lastMemoryContext.content === content;
			if (alreadyInBranch || alreadyEmitted) return undefined;
			lastMemoryContext = {
				sessionManager: ctx.sessionManager,
				sessionId: currentSessionId,
				branchKey,
				content,
			};
			return {
				message: {
					customType: MEMORY_CONTEXT_TYPE,
					content,
					display: false,
				},
			};
		} catch {
			return undefined;
		}
	});

	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	const queue: QueueItem[] = [];
	const shutdownController = new AbortController();
	let shuttingDown = false;
	let workerActive = false;
	const queuedCharacters = (): number =>
		queue.reduce((total, item) => total + item.candidate.length, 0);
	const drain = async (): Promise<void> => {
		if (workerActive) return;
		workerActive = true;
		try {
			while (queue.length && !shuttingDown) {
				const item = queue.shift();
				if (!item) continue;
				try {
					await mergeOne(
						item,
						resolveMemoryPaths(item.cwd),
						shutdownController.signal,
						completeMemory,
					);
				} catch {
					// Durable memory is best effort and must never interrupt primary work.
				}
			}
		} finally {
			workerActive = false;
		}
	};

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		queue.length = 0;
		shutdownController.abort();
	});

	pi.registerTool({
		name: "memory",
		label: "Memory",
		renderShell: "self",
		description:
			"Queue durable guidance or stable facts in global or local project memory; global applies across repositories, while local is for project-specific decisions, conventions, or facts. Merging happens in the background. Do not save temporary task state, guesses, secrets, credentials, raw conversation, or information already captured by project instructions; sensitive-looking content is rejected before queueing.",
		parameters: MemoryParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const candidate = normalizeCandidate(params.content);
			if (!candidate)
				return toolResult("Memory rejected: content is empty or too large.", {
					queued: false,
					rejected: true,
				});
			if (containsSensitiveData(candidate)) {
				return toolResult("Memory rejected: sensitive-looking data is not stored.", {
					scope: params.scope,
					queued: false,
					rejected: true,
				});
			}
			if (shuttingDown)
				return toolResult("Memory not queued: the session is shutting down.", {
					scope: params.scope,
					queued: false,
				});
			if (!ctx.model)
				return toolResult("Memory not queued: no model is selected.", {
					scope: params.scope,
					queued: false,
				});
			const model = ctx.model;
			const thinking = pi.getThinkingLevel();
			const existing = queue.find(
				(item) =>
					item.scope === params.scope &&
					item.cwd === ctx.cwd &&
					item.model.provider === model.provider &&
					item.model.id === model.id &&
					item.thinking === thinking,
			);
			if (existing) {
				const combined = normalizeCandidate(`${existing.candidate}\n\n${candidate}`);
				if (
					combined &&
					queuedCharacters() - existing.candidate.length + combined.length <= MAX_QUEUE_CHARS
				)
					existing.candidate = combined;
				else if (
					queue.length >= MAX_QUEUE_ITEMS ||
					queuedCharacters() + candidate.length > MAX_QUEUE_CHARS
				) {
					return toolResult("Memory not queued: the bounded memory queue is full.", {
						scope: params.scope,
						queued: false,
						rejected: true,
					});
				} else {
					queue.push({
						scope: params.scope,
						candidate,
						cwd: ctx.cwd,
						model,
						thinking,
						modelRegistry: ctx.modelRegistry,
					});
				}
			} else {
				if (
					queue.length >= MAX_QUEUE_ITEMS ||
					queuedCharacters() + candidate.length > MAX_QUEUE_CHARS
				) {
					return toolResult("Memory not queued: the bounded memory queue is full.", {
						scope: params.scope,
						queued: false,
						rejected: true,
					});
				}
				queue.push({
					scope: params.scope,
					candidate,
					cwd: ctx.cwd,
					model,
					thinking,
					modelRegistry: ctx.modelRegistry,
				});
			}
			void drain();
			return toolResult(`Memory queued for ${params.scope} scope; merge runs in the background.`, {
				scope: params.scope,
				queued: true,
			});
		},
		renderCall(args, theme, context) {
			const scope = typeof args.scope === "string" ? args.scope : "?";
			return new ExpandableToolRender(
				context,
				new Text(
					`${theme.fg("toolTitle", theme.bold("memory "))}${theme.fg("accent", scope)}`,
					1,
					0,
				),
			);
		},
		renderResult(result, { expanded }, theme, context) {
			if (!shouldRevealToolDetails({ expanded, isError: context.isError })) {
				return emptyCollapsedToolRender();
			}
			const text = result.content.find((part) => part.type === "text");
			const message = text?.type === "text" ? text.text : "Memory tool completed";
			return new Text(theme.fg(context.isError ? "error" : "muted", message), 1, 0);
		},
	});

	pi.registerCommand("memories", {
		description: "View global and local project memory",
		handler: async (_args, ctx) => {
			const bundle = await readMemoryBundle(ctx.cwd);
			if (ctx.mode !== "tui") {
				ctx.ui.notify(formatMemoryText(bundle), "info");
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => new MemoryView(tui, theme, bundle, done),
				fullscreenOverlayOptions(),
			);
		},
	});

	pi.registerCommand("memory-export", {
		description: "Export global and local project memory to a Markdown file",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const bundle = await readMemoryBundle(ctx.cwd);
			const paths = resolveMemoryPaths(ctx.cwd);
			const requested = args.trim();
			const requestedDestination = requested.startsWith("~/")
				? join(homedir(), requested.slice(2))
				: resolve(ctx.cwd, requested || "pi-memory-export.md");
			try {
				const destination = await canonicalPath(requestedDestination);
				const sourcePaths = [paths.globalPath, paths.localPath];
				const canonicalSources = await Promise.all(
					sourcePaths.map((source) => canonicalPath(source)),
				);
				const aliasesSource =
					canonicalSources.includes(destination) ||
					(await Promise.all(sourcePaths.map((source) => sameFile(source, destination)))).some(
						Boolean,
					);
				if (aliasesSource) {
					ctx.ui.notify(
						"Memory export refused: destination aliases a source memory file.",
						"error",
					);
					return;
				}
				await atomicWrite(destination, formatExport(bundle));
				ctx.ui.notify(`Memory exported to ${destination}`, "info");
			} catch (error) {
				ctx.ui.notify(`Memory export failed: ${errorText(error)}`, "error");
			}
		},
	});
}

export default function memoryExtension(pi: ExtensionAPI): void {
	registerMemoryExtension(pi);
}

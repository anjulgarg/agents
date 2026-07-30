/**
 * Git Checkpoint Extension
 *
 * Automatic, non-destructive working-tree snapshots with safe rewind.
 *
 * How it works:
 * - Snapshots copy the real index to a temp file, run `git add -A` + `write-tree`
 *   against it, and store the tree as a commit under refs/pi/checkpoints/<id>.
 *   The real index, working tree, and user refs are never touched by snapshots.
 * - One snapshot per user prompt (before_agent_start), deduped by tree hash.
 * - Metadata is persisted in session entries, so /checkpoints and /rewind survive
 *   restarts, and /fork can offer to restore the matching code state.
 * - Rewind creates a safety checkpoint first, previews `git diff --stat`, requires
 *   confirmation, applies a binary patch via `git apply --check` + `git apply`
 *   (working tree only; the staging area is preserved), and verifies the result.
 * - Retention: newest 50 checkpoints, max age 30 days; pruned objects are
 *   reclaimed by `git gc --auto`.
 *
 * Known limits: POSIX only (the temp index needs the `env` command); patches that
 * move submodule pointers fail the apply check and rewind aborts unchanged;
 * ignored files are never captured or restored.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	ExpandableToolRender,
	emptyCollapsedToolRender,
	fullscreenOverlayOptions,
	renderFullscreenScreen,
	renderFooter,
	renderHeader,
	SelectableViewportState,
	shouldRevealToolDetails,
} from "./lib/tui/index.ts";

const CUSTOM_TYPE = "pi-checkpoint";
const REF_PREFIX = "refs/pi/checkpoints";
const MAX_CHECKPOINTS = 50;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 60_000;
const DIFF_TIMEOUT_MS = 120_000;

export interface RepoInfo {
	toplevel: string;
	gitDir: string;
}

export interface GitResult {
	stdout: string;
	stderr: string;
	code: number;
}

export type GitRunner = (
	args: string[],
	options?: { env?: Record<string, string>; timeout?: number },
) => Promise<GitResult>;

export interface SnapshotResult {
	created: boolean;
	id: string;
	ref: string;
	commit: string;
	tree: string;
}

export interface RestorePlan {
	safety: SnapshotResult;
	patchPath: string;
	patchEmpty: boolean;
	stat: string;
}

export interface CheckpointEntry {
	v: 1;
	id: string;
	ref: string;
	commit: string;
	tree: string;
	worktree: string;
	createdAt: number;
	reason: "auto" | "manual" | "safety";
	note?: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function must(
	git: GitRunner,
	args: string[],
	options?: { env?: Record<string, string>; timeout?: number },
): Promise<string> {
	const result = await git(args, options);
	if (result.code !== 0) {
		throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
	}
	return result.stdout.trim();
}

/** Resolve the enclosing work tree, or null outside one. */
export async function resolveRepo(git: GitRunner): Promise<RepoInfo | null> {
	const inside = await git(["rev-parse", "--is-inside-work-tree"]);
	if (inside.code !== 0 || inside.stdout.trim() !== "true") return null;
	const toplevel = await must(git, ["rev-parse", "--show-toplevel"]);
	const gitDir = await must(git, ["rev-parse", "--absolute-git-dir"]);
	try {
		return { toplevel: fs.realpathSync(toplevel), gitDir };
	} catch {
		return { toplevel, gitDir };
	}
}

/** Hash the whole work tree (tracked + untracked, honoring .gitignore) via a temp index. */
export async function captureTree(git: GitRunner, repo: RepoInfo): Promise<string> {
	const tempIndex = path.join(os.tmpdir(), `pi-checkpoint-index-${process.pid}-${randomUUID()}`);
	try {
		const realIndex = path.join(repo.gitDir, "index");
		if (fs.existsSync(realIndex)) {
			// Copying preserves the stat cache, so unchanged files are not re-hashed.
			fs.copyFileSync(realIndex, tempIndex);
		} else {
			await must(git, ["read-tree", "--empty"], { env: { GIT_INDEX_FILE: tempIndex } });
		}
		await must(git, ["add", "-A"], {
			env: { GIT_INDEX_FILE: tempIndex },
			timeout: DIFF_TIMEOUT_MS,
		});
		return await must(git, ["write-tree"], { env: { GIT_INDEX_FILE: tempIndex } });
	} finally {
		fs.rmSync(tempIndex, { force: true });
	}
}

export interface CheckpointRef {
	ref: string;
	id: string;
	commit: string;
	committedAt: number;
}

/** All checkpoint refs, newest first. */
export async function listCheckpointRefs(git: GitRunner): Promise<CheckpointRef[]> {
	const result = await git([
		"for-each-ref",
		"--sort=-committerdate",
		"--format=%(refname)%00%(objectname)%00%(committerdate:unix)",
		REF_PREFIX,
	]);
	if (result.code !== 0 || !result.stdout.trim()) return [];
	const refs: CheckpointRef[] = [];
	for (const line of result.stdout.trim().split("\n")) {
		const [ref, commit, seconds] = line.split("\0");
		if (!ref || !commit) continue;
		refs.push({
			ref,
			id: ref.slice(REF_PREFIX.length + 1),
			commit,
			committedAt: Number(seconds) * 1000,
		});
	}
	return refs;
}

async function headCommit(git: GitRunner): Promise<string | null> {
	const result = await git(["rev-parse", "--verify", "HEAD"]);
	return result.code === 0 ? result.stdout.trim() : null;
}

async function commitTree(
	git: GitRunner,
	tree: string,
	parent: string | null,
	message: string,
): Promise<string> {
	const args = ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message];
	let result = await git(args);
	if (result.code !== 0 && /ident|who you are|email/i.test(result.stderr)) {
		// Repositories without a configured identity still get checkpoints.
		result = await git(args, {
			env: {
				GIT_AUTHOR_NAME: "Pi Checkpoint",
				GIT_AUTHOR_EMAIL: "pi-checkpoint@localhost",
				GIT_COMMITTER_NAME: "Pi Checkpoint",
				GIT_COMMITTER_EMAIL: "pi-checkpoint@localhost",
			},
		});
	}
	if (result.code !== 0) throw new Error(`git commit-tree failed: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

/**
 * Create a checkpoint commit of the current work-tree state. Returns the previous
 * checkpoint unchanged when the tree hash matches it (or the newest ref).
 */
export async function snapshotOnce(
	git: GitRunner,
	repo: RepoInfo,
	options?: { last?: { id: string; ref: string; commit: string; tree: string } | null },
): Promise<SnapshotResult> {
	const tree = await captureTree(git, repo);
	const last = options?.last;
	if (last?.tree === tree)
		return { created: false, id: last.id, ref: last.ref, commit: last.commit, tree };

	const [newest] = await listCheckpointRefs(git);
	if (newest) {
		const newestTree = await git(["rev-parse", `${newest.commit}^{tree}`]);
		if (newestTree.code === 0 && newestTree.stdout.trim() === tree) {
			return { created: false, id: newest.id, ref: newest.ref, commit: newest.commit, tree };
		}
	}

	const id = randomUUID().replace(/-/g, "").slice(0, 12);
	const ref = `${REF_PREFIX}/${id}`;
	const commit = await commitTree(git, tree, await headCommit(git), `pi checkpoint ${id}`);
	await must(git, ["update-ref", ref, commit]);
	return { created: true, id, ref, commit, tree };
}

/** Delete refs beyond the count/age budget. Returns the deleted ref names. */
export async function pruneCheckpoints(
	git: GitRunner,
	options: { maxCount: number; maxAgeMs: number; now?: number },
): Promise<string[]> {
	const now = options.now ?? Date.now();
	const doomed = (await listCheckpointRefs(git)).filter(
		(ref, index) => index >= options.maxCount || now - ref.committedAt > options.maxAgeMs,
	);
	for (const ref of doomed) {
		// A concurrent prune may have deleted it already; either way the ref is gone.
		await git(["update-ref", "-d", ref.ref]);
	}
	return doomed.map((ref) => ref.ref);
}

/** Snapshot the current state and build a patch that rewinds it to targetCommit. */
export async function planRestore(
	git: GitRunner,
	repo: RepoInfo,
	targetCommit: string,
): Promise<RestorePlan> {
	const safety = await snapshotOnce(git, repo);
	// Patches must keep exact bytes (including the trailing newline), so no trim here.
	const diff = await git(["diff", "--binary", "--full-index", safety.commit, targetCommit], {
		timeout: DIFF_TIMEOUT_MS,
	});
	if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
	const patch = diff.stdout;
	const patchPath = path.join(
		os.tmpdir(),
		`pi-checkpoint-patch-${process.pid}-${randomUUID()}.patch`,
	);
	fs.writeFileSync(patchPath, patch, { mode: 0o600 });
	const stat = await git(["diff", "--stat", safety.commit, targetCommit]);
	return { safety, patchPath, patchEmpty: patch.trim().length === 0, stat: stat.stdout.trim() };
}

/**
 * Apply a restore plan to the working tree only. Fails closed via `git apply
 * --check`, then verifies the resulting tree hash. Returns a warning or null.
 */
export async function applyRestore(
	git: GitRunner,
	repo: RepoInfo,
	plan: RestorePlan,
	targetTree: string,
): Promise<string | null> {
	const check = await git(["apply", "--check", plan.patchPath]);
	if (check.code !== 0) {
		throw new Error(
			`restore conflicts: ${(check.stderr || check.stdout).trim() || "working tree changed since preview"}`,
		);
	}
	await must(git, ["apply", plan.patchPath]);
	const tree = await captureTree(git, repo);
	if (tree !== targetTree) {
		return "Restore applied but the result differs from the checkpoint (possible EOL or filter differences).";
	}
	return null;
}

export function cleanupPlan(plan: RestorePlan): void {
	fs.rmSync(plan.patchPath, { force: true });
}

function createPiGitRunner(pi: ExtensionAPI, cwd: string): GitRunner {
	return async (args, options = {}) => {
		const timeout = options.timeout ?? GIT_TIMEOUT_MS;
		if (options.env && Object.keys(options.env).length > 0) {
			if (process.platform === "win32") {
				throw new Error("Git checkpoints are not supported on Windows");
			}
			const pairs = Object.entries(options.env).map(([key, value]) => `${key}=${value}`);
			return pi.exec("env", [...pairs, "git", ...args], { cwd, timeout });
		}
		return pi.exec("git", args, { cwd, timeout });
	};
}

function formatAge(timestamp: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function truncateForDisplay(text: string, maxWords = 12): string {
	const normalized = text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const words = normalized.split(/\s+/);
	if (words.length <= maxWords) return normalized;
	return `${words.slice(0, maxWords).join(" ")}\u2026`;
}

function checkpointLabel(entry: CheckpointEntry): string {
	const age = formatAge(entry.createdAt);
	if (entry.note) return `"${truncateForDisplay(entry.note)}" (${age}, ${entry.reason})`;
	return `#${entry.id} (${age}, ${entry.reason})`;
}

function isCheckpointEntry(data: unknown): data is CheckpointEntry {
	const entry = data as CheckpointEntry | undefined;
	return (
		!!entry &&
		entry.v === 1 &&
		typeof entry.id === "string" &&
		typeof entry.ref === "string" &&
		typeof entry.commit === "string" &&
		typeof entry.tree === "string" &&
		typeof entry.worktree === "string" &&
		typeof entry.createdAt === "number"
	);
}

function textResult(text: string): AgentToolResult {
	return { content: [{ type: "text", text }] };
}

function shortenPath(p: string): string {
	const home = os.homedir();
	if (p.startsWith(home)) return `~${p.slice(home.length)}`;
	return p;
}

/**
 * Full-screen overlay for browsing and selecting git checkpoints.
 * Mirrors the subagent thread view pattern: overlay covers the entire TUI,
 * with a scrollable list, header, and footer keybinding hints.
 */
export class CheckpointsView implements Component {
	private readonly selection = new SelectableViewportState();

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly checkpoints: CheckpointEntry[],
		private readonly worktree: string,
		private readonly done: (result: CheckpointEntry | undefined) => void,
	) {}

	private itemLines(entry: CheckpointEntry, selected: boolean): string[] {
		const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
		const normalizedNote = entry.note ? truncateForDisplay(entry.note, 20) : "";
		const title = normalizedNote || `Checkpoint ${entry.id}`;
		const reasonColor =
			entry.reason === "safety" ? "warning" : entry.reason === "manual" ? "accent" : "muted";
		const dot = this.theme.fg("dim", "·");
		return [
			`${prefix}${this.theme.fg("text", title)}`,
			`  ${this.theme.fg("muted", `#${entry.id}`)} ${dot} ${this.theme.fg("dim", formatAge(entry.createdAt))} ${dot} ${this.theme.fg(reasonColor, entry.reason)}`,
			"",
		];
	}

	render(width: number): string[] {
		const height = Math.max(0, Math.floor(this.tui.terminal.rows));
		const renderWidth = Math.max(1, width);
		const count = this.checkpoints.length;
		const subtitle = `${count} snapshot${count === 1 ? "" : "s"}`;
		const headerLines = [`${shortenPath(this.worktree)} · newest first`];
		const keyHints = [
			{ key: "↑↓", label: "select" },
			{ key: "PgUp/PgDn", label: "page" },
			{ key: "Home/End", label: "jump" },
			{ key: "Enter", label: "rewind" },
			{ key: "Esc/F6", label: "close" },
		];
		const header = renderHeader({
			width: renderWidth,
			title: "Checkpoints",
			subtitle,
			lines: headerLines,
			theme: this.theme,
		});
		const footer = renderFooter({ width: renderWidth, hints: keyHints, theme: this.theme });
		const bodyHeight = Math.max(0, height - header.length - footer.length);

		let body: string[];
		if (count === 0) {
			body = [
				this.theme.fg("dim", "No checkpoints in this session."),
				this.theme.fg("muted", "A checkpoint is created automatically before each agent turn."),
			];
		} else {
			const itemHeight = 3;
			const pageSize = Math.max(1, Math.floor(bodyHeight / itemHeight));
			const range = this.selection.update(count, pageSize);
			body = [];
			for (let index = range.start; index < range.end; index++) {
				body.push(...this.itemLines(this.checkpoints[index]!, index === this.selection.selected));
			}
		}

		return renderFullscreenScreen({
			width: renderWidth,
			height,
			title: "Checkpoints",
			subtitle,
			headerLines,
			body,
			keyHints,
			theme: this.theme,
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "f6")) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "enter") && this.checkpoints.length > 0) {
			this.done(this.checkpoints[this.selection.selected]);
			return;
		}
		if (this.checkpoints.length === 0) return;

		const previous = this.selection.selected;
		if (matchesKey(data, "up")) {
			this.selection.moveBy(-1, this.checkpoints.length);
		} else if (matchesKey(data, "down")) {
			this.selection.moveBy(1, this.checkpoints.length);
		} else if (matchesKey(data, "pageUp")) {
			this.selection.pageBy(-1, this.checkpoints.length);
		} else if (matchesKey(data, "pageDown")) {
			this.selection.pageBy(1, this.checkpoints.length);
		} else if (matchesKey(data, "home")) {
			this.selection.home();
		} else if (matchesKey(data, "end")) {
			this.selection.end(this.checkpoints.length);
		} else {
			return;
		}
		if (this.selection.selected !== previous) this.tui.requestRender();
	}

	invalidate(): void {}
}

export default function gitCheckpoint(pi: ExtensionAPI): void {
	const repoCache = new Map<string, RepoInfo | null>();
	const lastByWorktree = new Map<
		string,
		{ id: string; ref: string; commit: string; tree: string }
	>();
	let chain: Promise<unknown> = Promise.resolve();

	function enqueue<T>(job: () => Promise<T>): Promise<T> {
		const result = chain.then(job);
		chain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async function repoFor(cwd: string): Promise<RepoInfo | null> {
		const cached = repoCache.get(cwd);
		if (cached) return cached;
		const repo = await resolveRepo(createPiGitRunner(pi, cwd));
		if (repo) repoCache.set(cwd, repo); // Only positives are cached; `git init` mid-session still works.
		return repo;
	}

	function appendEntry(
		repo: RepoInfo,
		snapshot: SnapshotResult,
		reason: CheckpointEntry["reason"],
		note?: string,
	): CheckpointEntry {
		const entry: CheckpointEntry = {
			v: 1,
			id: snapshot.id,
			ref: snapshot.ref,
			commit: snapshot.commit,
			tree: snapshot.tree,
			worktree: repo.toplevel,
			createdAt: Date.now(),
			reason,
			...(note ? { note } : {}),
		};
		pi.appendEntry(CUSTOM_TYPE, entry);
		lastByWorktree.set(repo.toplevel, {
			id: snapshot.id,
			ref: snapshot.ref,
			commit: snapshot.commit,
			tree: snapshot.tree,
		});
		return entry;
	}

	/** Snapshot + persist + prune. Returns null outside a work tree. */
	async function snapshotFor(
		cwd: string,
		reason: CheckpointEntry["reason"],
		note?: string,
	): Promise<SnapshotResult | null> {
		return enqueue(async () => {
			const repo = await repoFor(cwd);
			if (!repo) return null;
			const git = createPiGitRunner(pi, repo.toplevel);
			const snapshot = await snapshotOnce(git, repo, { last: lastByWorktree.get(repo.toplevel) });
			appendEntry(repo, snapshot, reason, note);
			if (snapshot.created) {
				const deleted = await pruneCheckpoints(git, {
					maxCount: MAX_CHECKPOINTS,
					maxAgeMs: MAX_AGE_MS,
				});
				if (deleted.length > 0) {
					try {
						await git(["gc", "--auto"], { timeout: 30_000 });
					} catch {
						// Best effort; Git will retry housekeeping later.
					}
				}
			}
			return snapshot;
		});
	}

	function sessionCheckpoints(ctx: ExtensionContext, worktree: string): CheckpointEntry[] {
		const entries: CheckpointEntry[] = [];
		for (const entry of ctx.sessionManager.getEntries()) {
			if (
				entry.type === "custom" &&
				entry.customType === CUSTOM_TYPE &&
				isCheckpointEntry(entry.data)
			) {
				if (entry.data.worktree === worktree) entries.push(entry.data);
			}
		}
		return entries.reverse(); // Newest first.
	}

	/** Session checkpoints whose refs still exist in the repository. */
	async function validCheckpoints(
		ctx: ExtensionContext,
		repo: RepoInfo,
	): Promise<CheckpointEntry[]> {
		const git = createPiGitRunner(pi, repo.toplevel);
		const live = new Set((await listCheckpointRefs(git)).map((ref) => ref.ref));
		return sessionCheckpoints(ctx, repo.toplevel).filter((entry) => live.has(entry.ref));
	}

	function latestCheckpointBefore(
		ctx: ExtensionContext,
		worktree: string,
		entryId: string,
	): CheckpointEntry | undefined {
		const entries = ctx.sessionManager.getEntries();
		const index = entries.findIndex((entry) => entry.id === entryId);
		const stop = index === -1 ? entries.length : index + 1;
		for (let i = stop - 1; i >= 0; i--) {
			const entry = entries[i];
			if (
				entry.type === "custom" &&
				entry.customType === CUSTOM_TYPE &&
				isCheckpointEntry(entry.data)
			) {
				if (entry.data.worktree === worktree) return entry.data;
			}
		}
		return undefined;
	}

	async function rewindTo(
		ctx: ExtensionContext,
		target: CheckpointEntry,
		options: { confirmed: boolean },
	): Promise<void> {
		const repo = await repoFor(ctx.cwd);
		if (!repo) {
			ctx.ui.notify("Not inside a git work tree", "warning");
			return;
		}
		const git = createPiGitRunner(pi, repo.toplevel);

		let plan: RestorePlan;
		try {
			plan = await enqueue(() => planRestore(git, repo, target.commit));
		} catch (error) {
			ctx.ui.notify(`Rewind failed: ${errorMessage(error)}`, "error");
			return;
		}
		appendEntry(repo, plan.safety, "safety", `before rewind to ${target.id}`);

		try {
			if (plan.patchEmpty) {
				ctx.ui.notify(`Code already matches checkpoint ${target.id}`, "info");
				return;
			}
			if (!options.confirmed) {
				const promptLine = target.note ? `Prompt: "${target.note}"\n\n` : "";
				const message = `${promptLine}${plan.stat}\n\nA safety checkpoint (${plan.safety.id}) was created first. Only the working tree changes; staging is preserved.`;
				if (!(await ctx.ui.confirm(`Rewind to ${target.id}?`, message))) return;
			}
			const warning = await enqueue(() => applyRestore(git, repo, plan, target.tree));
			if (warning) {
				ctx.ui.notify(`${warning} Undo with: /rewind ${plan.safety.id}`, "warning");
			} else {
				ctx.ui.notify(`Rewound to ${target.id}. Undo with: /rewind ${plan.safety.id}`, "info");
			}
		} catch (error) {
			ctx.ui.notify(`Rewind failed, nothing was applied: ${errorMessage(error)}`, "error");
		} finally {
			cleanupPlan(plan);
		}
	}

	async function pickCheckpoint(
		ctx: ExtensionContext,
		repo: RepoInfo,
		title: string,
	): Promise<CheckpointEntry | undefined> {
		const checkpoints = await validCheckpoints(ctx, repo);
		if (checkpoints.length === 0) {
			ctx.ui.notify("No checkpoints for this work tree", "info");
			return undefined;
		}
		const labels = checkpoints.map(checkpointLabel);
		const choice = await ctx.ui.select(title, labels);
		if (!choice) return undefined;
		return checkpoints[labels.indexOf(choice)];
	}

	async function pickCheckpointOverlay(
		ctx: ExtensionContext,
		checkpoints: CheckpointEntry[],
		worktree: string,
	): Promise<CheckpointEntry | undefined> {
		return ctx.ui.custom<CheckpointEntry | undefined>(
			(tui, theme, _keybindings, done) =>
				new CheckpointsView(tui, theme, checkpoints, worktree, done),
			fullscreenOverlayOptions(),
		);
	}

	pi.registerCommand("checkpoint", {
		description: "Create a restorable git checkpoint of the working tree",
		handler: async (args, ctx) => {
			try {
				const snapshot = await snapshotFor(ctx.cwd, "manual", args?.trim() || undefined);
				if (!snapshot) {
					ctx.ui.notify("Not inside a git work tree", "warning");
				} else if (snapshot.created) {
					ctx.ui.notify(
						`Checkpoint ${snapshot.id} created. Restore with: /rewind ${snapshot.id}`,
						"info",
					);
				} else {
					ctx.ui.notify(`No changes since checkpoint ${snapshot.id}`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`Checkpoint failed: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("checkpoints", {
		description: "List git checkpoints for this work tree",
		handler: async (_args, ctx) => {
			const repo = await repoFor(ctx.cwd);
			if (!repo) {
				ctx.ui.notify("Not inside a git work tree", "warning");
				return;
			}
			const checkpoints = await validCheckpoints(ctx, repo);
			if (ctx.mode !== "tui") {
				const lines = checkpoints.map(checkpointLabel);
				ctx.ui.notify(
					lines.length > 0
						? `Recent checkpoints (newest first):\n${lines.join("\n")}`
						: "No checkpoints yet",
					"info",
				);
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("The checkpoints list requires interactive mode", "warning");
				return;
			}
			const target = await pickCheckpointOverlay(ctx, checkpoints, repo.toplevel);
			if (target) await rewindTo(ctx, target, { confirmed: false });
		},
	});

	pi.registerCommand("rewind", {
		description: "Restore the working tree to a checkpoint, with preview and confirmation",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Rewind requires interactive mode", "warning");
				return;
			}
			const repo = await repoFor(ctx.cwd);
			if (!repo) {
				ctx.ui.notify("Not inside a git work tree", "warning");
				return;
			}
			const query = args?.trim();
			let target: CheckpointEntry | undefined;
			if (query) {
				const checkpoints = await validCheckpoints(ctx, repo);
				target = checkpoints.find((entry) => entry.id.startsWith(query) || entry.ref === query);
				if (!target) {
					ctx.ui.notify(`No checkpoint matching "${query}"`, "warning");
					return;
				}
			} else {
				target = await pickCheckpoint(ctx, repo, "Rewind to checkpoint");
			}
			if (target) await rewindTo(ctx, target, { confirmed: false });
		},
	});

	pi.registerTool({
		name: "checkpoint",
		label: "Checkpoint",
		description: [
			"Create or list git checkpoints: restorable snapshots of the working tree (tracked and",
			"untracked files) stored under refs/pi/checkpoints without touching the index, working",
			"tree, or user commits. Users restore checkpoints with /rewind; this tool cannot rewind.",
		].join(" "),
		promptSnippet: "Snapshot the working tree as a restorable git checkpoint",
		promptGuidelines: [
			"Create a checkpoint before risky multi-file edits the user may want to undo.",
			"Checkpoints are read-only for the repository: they never modify code, staging, or commits.",
			"Only the user can restore a checkpoint, via /rewind.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("create"), Type.Literal("list")], {
				description: "create a new checkpoint or list recent checkpoints",
			}),
			note: Type.Optional(
				Type.String({ description: "Short note stored with a created checkpoint" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult> {
			if (params.action === "create") {
				const snapshot = await snapshotFor(ctx.cwd, "manual", params.note?.trim() || undefined);
				if (!snapshot) throw new Error("Not inside a git work tree");
				const text = snapshot.created
					? `Checkpoint ${snapshot.id} created (commit ${snapshot.commit.slice(0, 12)}). The user can restore it with /rewind ${snapshot.id}.`
					: `Working tree unchanged; checkpoint ${snapshot.id} is still current.`;
				return { ...textResult(text), details: snapshot };
			}

			const repo = await repoFor(ctx.cwd);
			if (!repo) throw new Error("Not inside a git work tree");
			const checkpoints = (await validCheckpoints(ctx, repo)).slice(0, 20);
			if (checkpoints.length === 0) {
				return textResult("No checkpoints recorded in this session for the current work tree.");
			}
			const lines = checkpoints.map(checkpointLabel);
			return textResult(
				`Recent checkpoints (newest first):\n${lines.join("\n")}\n\nThe user can restore one with /rewind <id>.`,
			);
		},
		renderShell: "self",
		renderCall(args, theme, context) {
			const note = args.note?.trim()
				? theme.fg("muted", ` · ${truncateForDisplay(args.note, 12)}`)
				: "";
			return new ExpandableToolRender(
				context,
				new Text(
					`${theme.fg("toolTitle", theme.bold("checkpoint "))}${theme.fg("accent", args.action)}${note}`,
					1,
					0,
				),
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (context.isError && !isPartial) {
				const message =
					result.content.find((part) => part.type === "text")?.text ?? "Checkpoint failed";
				return new Text(theme.fg("error", `× checkpoint · ${message.split(/\r?\n/, 1)[0]}`), 1, 0);
			}
			const snapshot = result.details as SnapshotResult | undefined;
			if (!expanded) {
				if (isPartial || context.args?.action !== "create" || !snapshot?.created) {
					return emptyCollapsedToolRender();
				}
				return new Text(
					`${theme.fg("toolTitle", "checkpoint")} ${theme.fg("accent", snapshot.id)}`,
					1,
					0,
				);
			}
			if (!shouldRevealToolDetails({ expanded, isError: context.isError })) {
				return emptyCollapsedToolRender();
			}
			if (context.isError) {
				const message =
					result.content.find((part) => part.type === "text")?.text ?? "Checkpoint failed";
				return new Text(theme.fg("error", message), 1, 0);
			}
			if (snapshot?.created) {
				return new Text(
					`${theme.fg("toolTitle", theme.bold("checkpoint "))}${theme.fg("success", snapshot.id)} ${theme.fg("muted", `created (commit ${snapshot.commit.slice(0, 12)})`)}`,
					1,
					0,
				);
			}
			if (snapshot && !snapshot.created) {
				const text = result.content.find((part) => part.type === "text");
				const message = text?.type === "text" ? text.text : "Working tree unchanged";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("checkpoint "))}${theme.fg("muted", message)}`,
					1,
					0,
				);
			}
			const text = result.content.find((c) => c.type === "text");
			const textContent = text?.type === "text" ? text.text : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("checkpoint "))}${theme.fg("muted", textContent)}`,
				1,
				0,
			);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const prompt = (event as { prompt?: string }).prompt;
			await snapshotFor(ctx.cwd, "auto", prompt?.trim() || undefined);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Auto-checkpoint failed: ${errorMessage(error)}`, "warning");
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		repoCache.clear();
		lastByWorktree.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (
				entry.type === "custom" &&
				entry.customType === CUSTOM_TYPE &&
				isCheckpointEntry(entry.data)
			) {
				const { worktree, id, ref, commit, tree } = entry.data;
				lastByWorktree.set(worktree, { id, ref, commit, tree });
			}
		}
	});

	pi.on("session_before_fork", async (event, ctx) => {
		if (!ctx.hasUI) return;
		try {
			const repo = await repoFor(ctx.cwd);
			if (!repo) return;
			const target = latestCheckpointBefore(ctx, repo.toplevel, event.entryId);
			if (!target) return;
			const git = createPiGitRunner(pi, repo.toplevel);
			if ((await git(["rev-parse", "--verify", target.ref])).code !== 0) return;
			const detail = target.note ? `"${truncateForDisplay(target.note)}" - ` : "";
			const choice = await ctx.ui.select(
				`Restore code to checkpoint?\n${detail}${formatAge(target.createdAt)}`,
				["Yes, restore code to that point", "No, keep current code"],
			);
			if (choice?.startsWith("Yes")) {
				await rewindTo(ctx, target, { confirmed: true });
			}
		} catch (error) {
			ctx.ui.notify(`Checkpoint restore failed: ${errorMessage(error)}`, "error");
		}
	});
}

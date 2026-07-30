import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	fuzzyFilter,
	matchesKey,
	Text,
	truncateToWidth,
	type AutocompleteItem,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

import {
	ExpandableToolRender,
	emptyCollapsedToolRender,
	fullscreenOverlayOptions,
	getContentWidth,
	renderFooter,
	renderFullscreenScreen,
	renderHeader,
	SelectableViewportState,
	shouldRevealToolDetails,
} from "./lib/tui/index.ts";
import {
	canonicalPath,
	findWorktree,
	isLinkedWorktree,
	parseWorktreePorcelain,
	type GitWorktree,
} from "./lib/worktree-core.ts";

export {
	findWorktree,
	isLinkedWorktree,
	parseWorktreePorcelain,
	type GitWorktree,
} from "./lib/worktree-core.ts";

const execFileAsync = promisify(execFile);
const WORKTREE_ICON = "󰙅";
const FAMILY_ENTRY = "worktree-session-family";
const STATE_PATH = join(getAgentDir(), "state", "worktree-sessions.json");

interface WorkspaceSession {
	sessionFile: string;
	updatedAt: number;
}

interface WorktreeFamily {
	workspaces: Record<string, WorkspaceSession>;
}

interface ManagedWorktree {
	repository: string;
	branch: string;
	createdAt: number;
}

interface WorktreeSessionState {
	version: 1;
	families: Record<string, WorktreeFamily>;
	managedWorktrees: Record<string, ManagedWorktree>;
}

function emptyState(): WorktreeSessionState {
	return { version: 1, families: {}, managedWorktrees: {} };
}

function loadState(): WorktreeSessionState {
	try {
		const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as WorktreeSessionState;
		if (state.version === 1 && state.families && typeof state.families === "object") {
			state.managedWorktrees ??= {};
			return state;
		}
	} catch {}
	return emptyState();
}

function saveState(state: WorktreeSessionState): void {
	mkdirSync(dirname(STATE_PATH), { recursive: true });
	const temporary = `${STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(temporary, STATE_PATH);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function getFamilyId(pi: ExtensionAPI, ctx: ExtensionCommandContext): string {
	let familyId: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== FAMILY_ENTRY) continue;
		const candidate = (entry.data as { familyId?: unknown } | undefined)?.familyId;
		if (typeof candidate === "string") familyId = candidate;
	}
	if (familyId) return familyId;
	familyId = randomUUID();
	pi.appendEntry(FAMILY_ENTRY, { familyId });
	return familyId;
}

function rememberSession(
	state: WorktreeSessionState,
	familyId: string,
	cwd: string,
	sessionFile: string,
): void {
	const family = state.families[familyId] ?? { workspaces: {} };
	family.workspaces[canonicalPath(cwd)] = { sessionFile, updatedAt: Date.now() };
	state.families[familyId] = family;
}

function forkSessionInto(
	ctx: ExtensionCommandContext,
	sourceSession: string,
	targetCwd: string,
): string | undefined {
	let forkSource = sourceSession;
	if (!existsSync(forkSource)) {
		const header = ctx.sessionManager.getHeader();
		if (!header) throw new Error("Current session has no header");
		const snapshotDir = join(getAgentDir(), "state", "worktree-session-snapshots");
		mkdirSync(snapshotDir, { recursive: true });
		forkSource = join(snapshotDir, `${header.id}-${Date.now()}.jsonl`);
		const records = [header, ...ctx.sessionManager.getEntries()];
		writeFileSync(forkSource, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
	}
	return SessionManager.forkFrom(forkSource, targetCwd).getSessionFile();
}

function hasRunningSubagents(ctx: ExtensionCommandContext): boolean {
	const latestRuns = new Map<string, { tasks?: Array<{ status?: string }> }>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== "subagent-state") continue;
		const run = (
			entry.data as { run?: { runId?: string; tasks?: Array<{ status?: string }> } } | undefined
		)?.run;
		if (run?.runId) latestRuns.set(run.runId, run);
	}
	return [...latestRuns.values()].some((run) =>
		run.tasks?.some((task) => task.status === "running"),
	);
}

const MAX_COMPLETIONS = 50;

function worktreeTitle(worktree: GitWorktree): string {
	return worktree.branch ?? (worktree.detached ? "detached HEAD" : "unknown branch");
}

function worktreeValue(worktree: GitWorktree): string {
	return worktree.branch ?? worktree.path;
}

function worktreeLabel(worktree: GitWorktree, currentPath: string): string {
	const current = canonicalPath(worktree.path) === currentPath ? " · current" : "";
	const state = worktree.prunable ? " · prunable" : worktree.locked ? " · locked" : "";
	return `${WORKTREE_ICON} ${worktreeTitle(worktree)} · ${worktree.path}${state}${current}`;
}

function shortenPath(path: string): string {
	const home = process.env.HOME;
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** Model-style argument completions for `/git:worktree `. */
export function worktreeCompletions(
	worktrees: GitWorktree[],
	prefix: string,
	cwd: string,
): AutocompleteItem[] | null {
	if (worktrees.length === 0) return null;
	const currentPath = canonicalPath(cwd);
	const filtered = prefix.trim()
		? fuzzyFilter(
				worktrees,
				prefix,
				(worktree) => `${worktreeTitle(worktree)} ${worktree.path} ${shortenPath(worktree.path)}`,
			)
		: worktrees;
	if (filtered.length === 0) return null;
	return filtered.slice(0, MAX_COMPLETIONS).map((worktree) => ({
		value: worktreeValue(worktree),
		label: worktreeTitle(worktree),
		description:
			[
				canonicalPath(worktree.path) === currentPath ? "current" : undefined,
				worktree.prunable ? "prunable" : undefined,
				worktree.locked ? "locked" : undefined,
				shortenPath(worktree.path),
			]
				.filter(Boolean)
				.join(" · ") || undefined,
	}));
}

/** Full-screen, responsive worktree picker using the shared Pi TUI chrome. */
export class WorktreesView implements Component {
	private readonly selection: SelectableViewportState;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly worktrees: GitWorktree[],
		private readonly currentPath: string,
		private readonly done: (result: GitWorktree | undefined) => void,
	) {
		const currentIndex = worktrees.findIndex(
			(worktree) => canonicalPath(worktree.path) === canonicalPath(currentPath),
		);
		this.selection = new SelectableViewportState(Math.max(0, currentIndex));
	}

	private itemLines(worktree: GitWorktree, selected: boolean, width: number): string[] {
		const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
		const branch = worktree.branch ?? (worktree.detached ? "detached HEAD" : "unknown branch");
		const dot = this.theme.fg("dim", "·");
		const statuses = [
			canonicalPath(worktree.path) === canonicalPath(this.currentPath)
				? this.theme.fg("success", "current")
				: undefined,
			worktree.prunable ? this.theme.fg("error", "prunable") : undefined,
			worktree.locked ? this.theme.fg("warning", "locked") : undefined,
		].filter((status): status is string => Boolean(status));
		const metadata = [...statuses, this.theme.fg("muted", shortenPath(worktree.path))].join(
			` ${dot} `,
		);
		return [
			truncateToWidth(`${prefix}${this.theme.fg("text", `${WORKTREE_ICON} ${branch}`)}`, width),
			truncateToWidth(`  ${metadata}`, width),
			"",
		];
	}

	render(width: number): string[] {
		const height = Math.max(0, Math.floor(this.tui.terminal.rows));
		const renderWidth = Math.max(1, width);
		const contentWidth = getContentWidth(renderWidth);
		const count = this.worktrees.length;
		const subtitle = `${count} worktree${count === 1 ? "" : "s"}`;
		const headerLines = [`${shortenPath(this.currentPath)} · select a checkout`];
		const keyHints = [
			{ key: "↑↓", label: "select" },
			{ key: "PgUp/PgDn", label: "page" },
			{ key: "Home/End", label: "jump" },
			{ key: "Enter", label: "switch" },
			{ key: "Esc/F6", label: "close" },
		];
		const header = renderHeader({
			width: renderWidth,
			title: "Worktrees",
			subtitle,
			lines: headerLines,
			theme: this.theme,
		});
		const footer = renderFooter({ width: renderWidth, hints: keyHints, theme: this.theme });
		const bodyHeight = Math.max(0, height - header.length - footer.length);

		let body: string[];
		if (count === 0) {
			body = [
				this.theme.fg("dim", "No Git worktrees found."),
				this.theme.fg("muted", "Create one with /git:worktree:new <branch>."),
			];
		} else {
			const itemHeight = 3;
			const pageSize = Math.max(1, Math.floor(bodyHeight / itemHeight));
			const range = this.selection.update(count, pageSize);
			body = [];
			for (let index = range.start; index < range.end; index++) {
				body.push(
					...this.itemLines(
						this.worktrees[index]!,
						index === this.selection.selected,
						contentWidth,
					),
				);
			}
		}

		return renderFullscreenScreen({
			width: renderWidth,
			height,
			title: "Worktrees",
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
		if (matchesKey(data, "enter") && this.worktrees.length > 0) {
			this.done(this.worktrees[this.selection.selected]);
			return;
		}
		if (this.worktrees.length === 0) return;

		const previous = this.selection.selected;
		if (matchesKey(data, "up")) {
			this.selection.moveBy(-1, this.worktrees.length);
		} else if (matchesKey(data, "down")) {
			this.selection.moveBy(1, this.worktrees.length);
		} else if (matchesKey(data, "pageUp")) {
			this.selection.pageBy(-1, this.worktrees.length);
		} else if (matchesKey(data, "pageDown")) {
			this.selection.pageBy(1, this.worktrees.length);
		} else if (matchesKey(data, "home")) {
			this.selection.home();
		} else if (matchesKey(data, "end")) {
			this.selection.end(this.worktrees.length);
		} else {
			return;
		}
		if (this.selection.selected !== previous) this.tui.requestRender();
	}

	invalidate(): void {}
}

async function pickWorktreeOverlay(
	ctx: ExtensionCommandContext,
	worktrees: GitWorktree[],
): Promise<GitWorktree | undefined> {
	return ctx.ui.custom<GitWorktree | undefined>(
		(tui, theme, _keybindings, done) => new WorktreesView(tui, theme, worktrees, ctx.cwd, done),
		fullscreenOverlayOptions(),
	);
}

async function loadWorktreesAt(pi: ExtensionAPI, cwd: string): Promise<GitWorktree[]> {
	const result = await pi.exec("git", ["worktree", "list", "--porcelain"], {
		cwd,
		timeout: 5000,
	});
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || "Current directory is not inside a Git repository");
	}
	return parseWorktreePorcelain(result.stdout);
}

async function loadWorktrees(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<GitWorktree[]> {
	return loadWorktreesAt(pi, ctx.cwd);
}

async function switchWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	target: GitWorktree,
): Promise<void> {
	if (target.prunable) {
		ctx.ui.notify(`Worktree is prunable and unavailable: ${target.path}`, "error");
		return;
	}
	if (canonicalPath(target.path) === canonicalPath(ctx.cwd)) {
		ctx.ui.notify("Already using that worktree.", "info");
		return;
	}

	const sourceSession = ctx.sessionManager.getSessionFile();
	if (!sourceSession) {
		ctx.ui.notify("Worktree switching requires a persisted session.", "error");
		return;
	}

	await ctx.waitForIdle();
	if (hasRunningSubagents(ctx)) {
		ctx.ui.notify(
			"Wait for running subagents to finish or stop them before switching worktrees.",
			"error",
		);
		return;
	}

	const familyId = getFamilyId(pi, ctx);
	const state = loadState();
	rememberSession(state, familyId, ctx.cwd, sourceSession);
	const targetPath = canonicalPath(target.path);
	let targetSession: string | undefined =
		state.families[familyId]?.workspaces[targetPath]?.sessionFile;
	if (!targetSession || !existsSync(targetSession)) {
		try {
			targetSession = forkSessionInto(ctx, sourceSession, target.path);
		} catch (error) {
			ctx.ui.notify(
				`Could not prepare worktree session: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
	}
	if (!targetSession) {
		ctx.ui.notify("Could not persist the worktree session.", "error");
		return;
	}
	rememberSession(state, familyId, target.path, targetSession);
	try {
		saveState(state);
	} catch (error) {
		ctx.ui.notify(
			`Could not save worktree session affinity: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}

	const branch = target.branch ?? "detached HEAD";
	try {
		await ctx.switchSession(targetSession, {
			withSession: async (next) => {
				next.ui.notify(`Switched to ${branch} at ${target.path}`, "info");
			},
		});
	} catch (error) {
		ctx.ui.notify(
			`Could not switch worktrees: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}
}

async function createManagedWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	requestedBranch: string,
): Promise<void> {
	let branch = requestedBranch.trim();
	if (!branch) {
		if (!ctx.hasUI) {
			ctx.ui.notify("Usage: /git:worktree:new <branch>", "error");
			return;
		}
		branch = (await ctx.ui.input("New worktree branch", "feature/name"))?.trim() ?? "";
		if (!branch) return;
	}

	const valid = await pi.exec("git", ["check-ref-format", "--branch", branch], {
		cwd: ctx.cwd,
		timeout: 5000,
	});
	if (valid.code !== 0) {
		ctx.ui.notify(`Invalid branch name: ${branch}`, "error");
		return;
	}
	let worktrees: GitWorktree[];
	try {
		worktrees = await loadWorktrees(pi, ctx);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}
	const existing = worktrees.find((worktree) => worktree.branch === branch);
	if (existing) {
		await switchWorktree(pi, ctx, existing);
		return;
	}

	const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
		cwd: ctx.cwd,
		timeout: 5000,
	});
	if (rootResult.code !== 0) {
		ctx.ui.notify(
			rootResult.stderr.trim() || "Current directory is not inside a Git repository.",
			"error",
		);
		return;
	}
	const repository = canonicalPath(rootResult.stdout.trim());
	const dirty = await pi.exec("git", ["status", "--porcelain", "--untracked-files=all"], {
		cwd: ctx.cwd,
		timeout: 5000,
	});
	if (dirty.code !== 0) {
		ctx.ui.notify(dirty.stderr.trim() || "Could not inspect the current checkout.", "error");
		return;
	}
	if (dirty.stdout.trim()) {
		if (
			!ctx.hasUI ||
			!(await ctx.ui.confirm(
				"Create from clean HEAD?",
				"Uncommitted changes will stay in the current checkout and will not be copied.",
			))
		)
			return;
	}

	const repositoryName = repository.split(/[\\/]/).filter(Boolean).at(-1) ?? "repository";
	const safeRepository = repositoryName.replace(/[^A-Za-z0-9._-]+/g, "-");
	const safeBranch = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
	const worktreePath = join(
		getAgentDir(),
		"worktrees",
		safeRepository,
		`${safeBranch}-${randomUUID().slice(0, 8)}`,
	);
	mkdirSync(dirname(worktreePath), { recursive: true });

	const branchExists =
		(
			await pi.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
				cwd: repository,
				timeout: 5000,
			})
		).code === 0;
	const args = branchExists
		? ["worktree", "add", worktreePath, branch]
		: ["worktree", "add", "-b", branch, worktreePath, "HEAD"];
	const added = await pi.exec("git", args, { cwd: repository, timeout: 30_000 });
	if (added.code !== 0) {
		ctx.ui.notify(added.stderr.trim() || `Could not create worktree for ${branch}.`, "error");
		return;
	}

	const state = loadState();
	state.managedWorktrees[canonicalPath(worktreePath)] = {
		repository,
		branch,
		createdAt: Date.now(),
	};
	try {
		saveState(state);
	} catch (error) {
		await pi.exec("git", ["worktree", "remove", worktreePath], {
			cwd: repository,
			timeout: 15_000,
		});
		if (!branchExists)
			await pi.exec("git", ["branch", "-D", branch], { cwd: repository, timeout: 5000 });
		ctx.ui.notify(
			`Could not record managed worktree: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}

	await switchWorktree(pi, ctx, {
		path: worktreePath,
		branch,
		detached: false,
		locked: false,
		prunable: false,
	});
}

async function cleanupCurrentWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Worktree cleanup requires interactive confirmation.", "error");
		return;
	}
	let worktrees: GitWorktree[];
	try {
		worktrees = await loadWorktrees(pi, ctx);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}
	const currentPath = canonicalPath(ctx.cwd);
	const current = worktrees.find((worktree) => canonicalPath(worktree.path) === currentPath);
	const primary = worktrees[0];
	if (!current || !primary || currentPath === canonicalPath(primary.path)) {
		ctx.ui.notify("The primary checkout cannot be cleaned up as a linked worktree.", "error");
		return;
	}
	if (current.locked) {
		ctx.ui.notify("Unlock this worktree before cleanup.", "error");
		return;
	}
	const managed = loadState().managedWorktrees[currentPath];
	if (!managed) {
		ctx.ui.notify(
			"Cleanup refused: this worktree was not created by Pi. Remove it manually if intended.",
			"error",
		);
		return;
	}
	if (current.detached || !current.branch) {
		ctx.ui.notify(
			"Cleanup refused: create a branch first so detached HEAD commits cannot be lost.",
			"error",
		);
		return;
	}

	const status = await pi.exec("git", ["status", "--porcelain", "--untracked-files=all"], {
		cwd: current.path,
		timeout: 5000,
	});
	if (status.code !== 0) {
		ctx.ui.notify(status.stderr.trim() || "Could not inspect worktree changes.", "error");
		return;
	}
	if (status.stdout.trim()) {
		ctx.ui.notify(
			"Cleanup refused: commit, stash, or discard the worktree's uncommitted changes first.",
			"error",
		);
		return;
	}

	const branch = current.branch ?? "detached HEAD";
	const confirmed = await ctx.ui.confirm(
		"Clean up worktree?",
		`Remove ${current.path}? The ${branch} branch and its commits will be preserved.`,
	);
	if (!confirmed) return;

	const currentSession = ctx.sessionManager.getSessionFile();
	if (!currentSession) {
		ctx.ui.notify("Worktree cleanup requires a persisted session.", "error");
		return;
	}
	await ctx.waitForIdle();
	if (hasRunningSubagents(ctx)) {
		ctx.ui.notify("Wait for running subagents to finish or stop them before cleanup.", "error");
		return;
	}

	const familyId = getFamilyId(pi, ctx);
	const state = loadState();
	rememberSession(state, familyId, current.path, currentSession);
	const primaryPath = canonicalPath(primary.path);
	let destinationSession: string | undefined =
		state.families[familyId]?.workspaces[primaryPath]?.sessionFile;
	if (!destinationSession || !existsSync(destinationSession)) {
		try {
			destinationSession = forkSessionInto(ctx, currentSession, primary.path);
		} catch (error) {
			ctx.ui.notify(
				`Could not prepare the primary-checkout session: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
	}
	if (!destinationSession) {
		ctx.ui.notify("Could not prepare the primary-checkout session.", "error");
		return;
	}
	rememberSession(state, familyId, primary.path, destinationSession);
	try {
		saveState(state);
	} catch (error) {
		ctx.ui.notify(
			`Could not save worktree session affinity: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}

	const removePath = current.path;
	const removeFrom = primary.path;
	try {
		await ctx.switchSession(destinationSession, {
			withSession: async (next) => {
				try {
					await execFileAsync("git", ["worktree", "remove", removePath], {
						cwd: removeFrom,
						timeout: 15_000,
					});
					const nextState = loadState();
					delete nextState.families[familyId]?.workspaces[canonicalPath(removePath)];
					delete nextState.managedWorktrees[canonicalPath(removePath)];
					saveState(nextState);
					next.ui.notify(`Removed worktree ${removePath}. Branch ${branch} was preserved.`, "info");
				} catch (error) {
					next.ui.notify(
						`Could not remove worktree: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			},
		});
	} catch (error) {
		ctx.ui.notify(
			`Could not leave the worktree: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}
}

export default function (pi: ExtensionAPI) {
	let cwd = process.cwd();

	pi.registerCommand("git:worktree", {
		description: "Switch this conversation to an existing Git worktree",
		getArgumentCompletions: async (prefix) => {
			try {
				const worktrees = await loadWorktreesAt(pi, cwd);
				return worktreeCompletions(worktrees, prefix, cwd);
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			cwd = ctx.cwd;
			let worktrees: GitWorktree[];
			try {
				worktrees = await loadWorktrees(pi, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			if (worktrees.length === 0) {
				ctx.ui.notify("No Git worktrees found.", "error");
				return;
			}

			const query = args.trim();
			let target: GitWorktree | undefined;
			if (query) {
				target = findWorktree(worktrees, query, ctx.cwd);
				if (!target) {
					ctx.ui.notify(`No worktree matches branch or path: ${query}`, "error");
					return;
				}
			} else {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /git:worktree <branch-or-path>", "error");
					return;
				}
				if (ctx.mode === "tui") {
					target = await pickWorktreeOverlay(ctx, worktrees);
				} else {
					const currentPath = canonicalPath(ctx.cwd);
					const labels = worktrees.map((worktree) => worktreeLabel(worktree, currentPath));
					const selected = await ctx.ui.select("Switch worktree", labels);
					if (!selected) return;
					target = worktrees[labels.indexOf(selected)];
				}
			}
			if (target) await switchWorktree(pi, ctx, target);
		},
	});

	pi.registerCommand("git:worktree:new", {
		description: "Create a clean Pi-managed worktree and continue this conversation there",
		handler: async (args, ctx) => createManagedWorktree(pi, ctx, args),
	});

	pi.registerCommand("git:worktree:cleanup", {
		description: "Leave and safely remove the current clean linked worktree",
		handler: async (_args, ctx) => cleanupCurrentWorktree(pi, ctx),
	});

	pi.registerTool({
		name: "worktree_cleanup",
		label: "Worktree Cleanup",
		description:
			"Offer interactive cleanup of the current linked worktree after its task is complete. Queues the confirmed cleanup command; never removes a worktree silently.",
		promptSnippet: "Offer safe cleanup of a completed worktree task",
		promptGuidelines: [
			"When work in a linked worktree is complete, offer /git:worktree:cleanup as a follow-up step. Use worktree_cleanup only when the user asks to clean up; never remove a worktree silently.",
		],
		parameters: Type.Object({}),
		renderShell: "self",
		renderCall(_args, theme, context) {
			return new ExpandableToolRender(
				context,
				new Text(theme.fg("toolTitle", theme.bold("worktree cleanup")), 1, 0),
			);
		},
		renderResult(result, { expanded }, theme, context) {
			if (!shouldRevealToolDetails({ expanded, isError: context.isError })) {
				return emptyCollapsedToolRender();
			}
			const message =
				result.content.find((part) => part.type === "text")?.text ?? "Worktree cleanup queued";
			return new Text(theme.fg(context.isError ? "error" : "muted", message), 1, 0);
		},
		async execute() {
			pi.sendUserMessage("/git:worktree:cleanup", { deliverAs: "followUp" });
			return {
				content: [{ type: "text", text: "Queued interactive worktree cleanup as a follow-up." }],
				details: {},
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		let linked = false;
		try {
			linked = isLinkedWorktree(await loadWorktrees(pi, ctx as ExtensionCommandContext), ctx.cwd);
		} catch {
			// Outside Git repositories there is no cleanup tool to expose.
		}
		const active = pi.getActiveTools().filter((name) => name !== "worktree_cleanup");
		pi.setActiveTools(linked ? [...active, "worktree_cleanup"] : active);
	});
}

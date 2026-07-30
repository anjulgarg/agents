/**
 * `/git:branch [name]` — switch the current Git checkout's local branch.
 *
 * Bare `/git:branch` lists local branches newest-to-oldest (pick to switch when
 * UI is available). `/git:branch ` argument completions mirror `/model`.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";

export interface LocalBranch {
	name: string;
	current: boolean;
	relativeDate: string;
}

const MAX_COMPLETIONS = 50;

type ExecLike = ExtensionAPI["exec"];

export async function listLocalBranches(exec: ExecLike, cwd: string): Promise<LocalBranch[]> {
	const result = await exec(
		"git",
		[
			"for-each-ref",
			"--sort=-committerdate",
			"--format=%(refname:short)%00%(HEAD)%00%(committerdate:relative)",
			"refs/heads/",
		],
		{ cwd, timeout: 10_000 },
	);
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
		throw new Error(
			detail.includes("not a git repository")
				? "Not inside a Git repository."
				: `Could not list branches: ${detail}`,
		);
	}

	const branches: LocalBranch[] = [];
	for (const line of result.stdout.split("\n")) {
		if (!line) continue;
		const [name, head, relativeDate = ""] = line.split("\0");
		if (!name) continue;
		branches.push({
			name,
			current: head === "*",
			relativeDate: relativeDate.trim(),
		});
	}
	return branches;
}

export function formatBranchLabel(branch: LocalBranch): string {
	const age = branch.relativeDate ? ` · ${branch.relativeDate}` : "";
	const current = branch.current ? " · current" : "";
	return `${branch.name}${age}${current}`;
}

export function branchCompletions(
	branches: LocalBranch[],
	prefix: string,
): AutocompleteItem[] | null {
	if (branches.length === 0) return null;
	const filtered = prefix.trim()
		? fuzzyFilter(branches, prefix, (branch) => branch.name)
		: branches;
	if (filtered.length === 0) return null;
	return filtered.slice(0, MAX_COMPLETIONS).map((branch) => ({
		value: branch.name,
		label: branch.name,
		description:
			[branch.current ? "current" : undefined, branch.relativeDate || undefined]
				.filter(Boolean)
				.join(" · ") || undefined,
	}));
}

export function resolveBranch(branches: LocalBranch[], query: string): LocalBranch | undefined {
	const needle = query.trim();
	if (!needle) return undefined;
	const exact = branches.find((branch) => branch.name === needle);
	if (exact) return exact;
	const lower = needle.toLowerCase();
	const caseInsensitive = branches.filter((branch) => branch.name.toLowerCase() === lower);
	if (caseInsensitive.length === 1) return caseInsensitive[0];
	const prefixed = branches.filter((branch) => branch.name.toLowerCase().startsWith(lower));
	if (prefixed.length === 1) return prefixed[0];
	return undefined;
}

async function switchToBranch(
	exec: ExecLike,
	cwd: string,
	branch: LocalBranch,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (branch.current) {
		ctx.ui.notify(`Already on ${branch.name}.`, "info");
		return;
	}
	const result = await exec("git", ["switch", branch.name], {
		cwd,
		timeout: 30_000,
	});
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
		ctx.ui.notify(`Could not switch to ${branch.name}: ${detail}`, "error");
		return;
	}
	ctx.ui.notify(`Switched to ${branch.name}.`, "info");
}

export default function (pi: ExtensionAPI) {
	let cwd = process.cwd();

	pi.on("session_start", (_event, ctx) => {
		cwd = ctx.cwd;
	});

	pi.registerCommand("git:branch", {
		description: "Switch Git branch (lists local branches newest first)",
		getArgumentCompletions: async (prefix) => {
			try {
				const branches = await listLocalBranches(pi.exec, cwd);
				return branchCompletions(branches, prefix);
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			cwd = ctx.cwd;
			let branches: LocalBranch[];
			try {
				branches = await listLocalBranches(pi.exec, ctx.cwd);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			if (branches.length === 0) {
				ctx.ui.notify("No local branches found.", "error");
				return;
			}

			const query = args.trim();
			if (query) {
				const target = resolveBranch(branches, query);
				if (!target) {
					ctx.ui.notify(`No local branch matches: ${query}`, "error");
					return;
				}
				await switchToBranch(pi.exec, ctx.cwd, target, ctx);
				return;
			}

			const labels = branches.map(formatBranchLabel);
			if (!ctx.hasUI) {
				ctx.ui.notify(labels.join("\n"), "info");
				return;
			}

			const selected = await ctx.ui.select("Local branches", labels);
			if (!selected) return;
			const index = labels.indexOf(selected);
			const target = index >= 0 ? branches[index] : undefined;
			if (target) await switchToBranch(pi.exec, ctx.cwd, target, ctx);
		},
	});
}

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface GitWorktree {
	path: string;
	branch?: string;
	detached: boolean;
	locked: boolean;
	prunable: boolean;
}

export function parseWorktreePorcelain(output: string): GitWorktree[] {
	return output
		.trim()
		.split(/\r?\n\r?\n/)
		.flatMap((record) => {
			if (!record.trim()) return [];
			const worktree: GitWorktree = {
				path: "",
				detached: false,
				locked: false,
				prunable: false,
			};
			for (const line of record.split(/\r?\n/)) {
				if (line.startsWith("worktree ")) worktree.path = line.slice("worktree ".length);
				else if (line.startsWith("branch refs/heads/"))
					worktree.branch = line.slice("branch refs/heads/".length);
				else if (line === "detached") worktree.detached = true;
				else if (line === "locked" || line.startsWith("locked ")) worktree.locked = true;
				else if (line === "prunable" || line.startsWith("prunable ")) worktree.prunable = true;
			}
			return worktree.path ? [worktree] : [];
		});
}

export function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

export function findWorktree(
	worktrees: GitWorktree[],
	query: string,
	cwd: string,
): GitWorktree | undefined {
	const normalizedQuery = query.replace(/^refs\/heads\//, "");
	const queryPath = canonicalPath(resolve(cwd, query));
	return worktrees.find(
		(worktree) => worktree.branch === normalizedQuery || canonicalPath(worktree.path) === queryPath,
	);
}

export function isLinkedWorktree(worktrees: GitWorktree[], cwd: string): boolean {
	const currentPath = canonicalPath(cwd);
	const current = worktrees.find((worktree) => canonicalPath(worktree.path) === currentPath);
	const primary = worktrees[0];
	return Boolean(current && primary && currentPath !== canonicalPath(primary.path));
}

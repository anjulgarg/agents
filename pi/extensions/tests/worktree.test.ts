import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { worktreeCompletions } from "../worktree.ts";
import { findWorktree, isLinkedWorktree, parseWorktreePorcelain } from "../lib/worktree-core.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

const parsed = parseWorktreePorcelain(
	[
		"worktree /repo/main",
		"HEAD aaaaa",
		"branch refs/heads/main",
		"",
		"worktree /tmp/feature tree",
		"HEAD bbbbb",
		"branch refs/heads/feature/footer",
		"locked in use",
		"",
		"worktree /tmp/stale",
		"HEAD ccccc",
		"detached",
		"prunable gitdir file points to non-existent location",
		"",
	].join("\n"),
);

assert(
	"parses branch, path, locked, detached, and prunable worktree fields",
	parsed.length === 3 &&
		parsed[0]?.branch === "main" &&
		parsed[1]?.path === "/tmp/feature tree" &&
		parsed[1]?.locked === true &&
		parsed[2]?.detached === true &&
		parsed[2]?.prunable === true,
	JSON.stringify(parsed),
);

const root = mkdtempSync(join(tmpdir(), "pi-worktree-select-"));
const main = join(root, "main");
const feature = join(root, "feature");
try {
	mkdirSync(main);
	mkdirSync(feature);
	const worktrees = [
		{ path: main, branch: "main", detached: false, locked: false, prunable: false },
		{ path: feature, branch: "feature/footer", detached: false, locked: false, prunable: false },
	];
	assert(
		"finds an existing worktree by branch name",
		findWorktree(worktrees, "feature/footer", main)?.path === feature,
		JSON.stringify(worktrees),
	);
	assert(
		"finds an existing worktree by absolute path",
		findWorktree(worktrees, feature, main)?.branch === "feature/footer",
		JSON.stringify(worktrees),
	);
	assert(
		"rejects unknown worktree selectors",
		findWorktree(worktrees, "missing", main) === undefined,
		JSON.stringify(worktrees),
	);
	assert(
		"distinguishes linked worktrees from the primary checkout",
		!isLinkedWorktree(worktrees, main) && isLinkedWorktree(worktrees, feature),
		JSON.stringify(worktrees),
	);

	const emptyPrefix = worktreeCompletions(worktrees, "", main);
	const filtered = worktreeCompletions(worktrees, "footer", main);
	assert(
		"space after /git:worktree offers worktree completions like /model",
		Array.isArray(emptyPrefix) &&
			emptyPrefix.length === 2 &&
			emptyPrefix[0]?.value === "main" &&
			emptyPrefix[0]?.label === "main" &&
			emptyPrefix[0]?.description?.includes("current") &&
			emptyPrefix[0]?.description?.includes(main) &&
			Array.isArray(filtered) &&
			filtered.length === 1 &&
			filtered[0]?.value === "feature/footer" &&
			filtered[0]?.description?.includes(feature),
		JSON.stringify({ emptyPrefix, filtered }),
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}

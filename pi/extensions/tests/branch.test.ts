/**
 * Run: npm run test:extensions
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import branchExtension, {
	branchCompletions,
	formatBranchLabel,
	listLocalBranches,
	resolveBranch,
	type LocalBranch,
} from "../branch.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function execForRepo(
	cwd: string,
	command: string,
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const stdout = execFileSync(command, args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, stdout, stderr: "" };
	} catch (error) {
		const failed = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
		return {
			code: typeof failed.status === "number" ? failed.status : 1,
			stdout: String(failed.stdout ?? ""),
			stderr: String(failed.stderr ?? ""),
		};
	}
}

const repo = mkdtempSync(join(tmpdir(), "pi-branch-cmd-"));
const commands = new Map<
	string,
	{
		description?: string;
		getArgumentCompletions?: (prefix: string) => Promise<unknown> | unknown;
		handler: (args: string, ctx: any) => Promise<void>;
	}
>();
let sessionCwd = repo;

try {
	git(repo, ["init"]);
	git(repo, ["config", "user.email", "pi@example.com"]);
	git(repo, ["config", "user.name", "Pi"]);
	const commit = (message: string, date: Date, extraArgs: string[] = []): void => {
		execFileSync("git", ["commit", ...extraArgs, "-m", message], {
			cwd: repo,
			env: {
				...process.env,
				GIT_AUTHOR_DATE: date.toISOString(),
				GIT_COMMITTER_DATE: date.toISOString(),
			},
			stdio: "pipe",
		});
	};
	const now = Date.now();
	writeFileSync(join(repo, "a.txt"), "a\n");
	git(repo, ["add", "a.txt"]);
	commit("first", new Date(now - 2 * 24 * 60 * 60 * 1_000));
	// Distinct relative committer dates keep newest-first order stable over time.
	git(repo, ["branch", "older"]);
	commit("on main later", new Date(now - 24 * 60 * 60 * 1_000), ["--allow-empty"]);
	git(repo, ["checkout", "-b", "feature/newest"]);
	commit("newest branch tip", new Date(now), ["--allow-empty"]);

	const exec = (command: string, args: string[], options?: { cwd?: string }) =>
		execForRepo(options?.cwd ?? repo, command, args);

	const branches = await listLocalBranches(exec as any, repo);
	assert(
		"lists local branches newest committer-date first",
		branches.length === 3 &&
			branches[0]?.name === "feature/newest" &&
			branches.some((branch) => branch.name === "main" || branch.name === "master") &&
			branches.some((branch) => branch.name === "older") &&
			branches[0]?.current === true,
		JSON.stringify(branches),
	);

	const sample: LocalBranch[] = [
		{ name: "feature/newest", current: true, relativeDate: "2 hours ago" },
		{ name: "main", current: false, relativeDate: "1 day ago" },
		{ name: "older", current: false, relativeDate: "3 days ago" },
	];
	assert(
		"formats labels with age and current marker",
		formatBranchLabel(sample[0]!) === "feature/newest · 2 hours ago · current" &&
			formatBranchLabel(sample[1]!) === "main · 1 day ago",
		JSON.stringify(sample.map(formatBranchLabel)),
	);

	const emptyPrefix = branchCompletions(sample, "");
	const filtered = branchCompletions(sample, "feat");
	assert(
		"empty prefix completions keep newest-first order without a streak count",
		Array.isArray(emptyPrefix) &&
			emptyPrefix[0]?.value === "feature/newest" &&
			emptyPrefix[0]?.description === "current · 2 hours ago" &&
			Array.isArray(filtered) &&
			filtered.length === 1 &&
			filtered[0]?.value === "feature/newest",
		JSON.stringify({ emptyPrefix, filtered }),
	);

	assert(
		"resolves exact, case-insensitive, and unique prefix matches",
		resolveBranch(sample, "main")?.name === "main" &&
			resolveBranch(sample, "MAIN")?.name === "main" &&
			resolveBranch(sample, "feature/")?.name === "feature/newest" &&
			resolveBranch(sample, "missing") === undefined &&
			resolveBranch(sample, "") === undefined,
		"resolveBranch mismatch",
	);

	branchExtension({
		exec,
		on: (event: string, handler: (event: unknown, ctx: { cwd: string }) => void) => {
			if (event === "session_start") handler({}, { cwd: sessionCwd });
		},
		registerCommand: (name: string, command: any) => {
			commands.set(name, command);
		},
	} as any);

	const command = commands.get("git:branch");
	assert("registers /git:branch", !!command, JSON.stringify([...commands.keys()]));

	const completions = (await command!.getArgumentCompletions?.("")) as Array<{
		value: string;
		description?: string;
	}> | null;
	assert(
		"space after /git:branch offers local branches newest first",
		Array.isArray(completions) &&
			completions[0]?.value === "feature/newest" &&
			completions.some((item) => item.value === "older"),
		JSON.stringify(completions),
	);

	const notices: Array<{ message: string; level: string }> = [];
	await command!.handler("older", {
		cwd: repo,
		hasUI: false,
		ui: {
			notify: (message: string, level: string) => {
				notices.push({ message, level });
			},
			select: async () => undefined,
		},
	});
	const afterSwitch = await listLocalBranches(exec as any, repo);
	assert(
		"/git:branch name switches the checkout",
		afterSwitch.find((branch) => branch.name === "older")?.current === true &&
			notices.some((notice) => notice.message.includes("Switched to older")),
		JSON.stringify({ afterSwitch, notices }),
	);

	const listNotices: string[] = [];
	await command!.handler("", {
		cwd: repo,
		hasUI: false,
		ui: {
			notify: (message: string) => {
				listNotices.push(message);
			},
			select: async () => undefined,
		},
	});
	assert(
		"bare /git:branch lists branches newest first without UI",
		listNotices.length === 1 &&
			listNotices[0]!.includes("older") &&
			listNotices[0]!.includes("feature/newest") &&
			listNotices[0]!.indexOf("feature/newest") < listNotices[0]!.indexOf("older") &&
			listNotices[0]!.includes("current"),
		JSON.stringify(listNotices),
	);

	let selectedTitle = "";
	let selectedLabels: string[] = [];
	await command!.handler("", {
		cwd: repo,
		hasUI: true,
		ui: {
			notify: () => undefined,
			select: async (title: string, labels: string[]) => {
				selectedTitle = title;
				selectedLabels = labels;
				return undefined;
			},
		},
	});
	assert(
		"bare /git:branch opens a select list newest first when UI is available",
		selectedTitle === "Local branches" &&
			selectedLabels[0]?.startsWith("feature/newest") &&
			selectedLabels.some((label) => label.startsWith("older") && label.includes("current")),
		JSON.stringify({ selectedTitle, selectedLabels }),
	);

	console.log("All branch command tests passed.");
} finally {
	rmSync(repo, { recursive: true, force: true });
}

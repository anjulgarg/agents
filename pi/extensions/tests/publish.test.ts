import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import publishExtension, { isDefaultBranch, pullRequestArgs } from "../publish.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

assert(
	"recognizes the remote default branch",
	isDefaultBranch("main", "main") && !isDefaultBranch("feature/publish", "main"),
	"Expected only main to match the explicit default branch",
);

assert(
	"falls back to common default branch names",
	isDefaultBranch("main") && isDefaultBranch("master") && !isDefaultBranch("HEAD"),
	"Expected main and master, but not detached HEAD, to be default branches",
);

const args = pullRequestArgs("main", "feat/publish-choice");
assert(
	"creates a filled pull request targeting main",
	args.join(" ") === "pr create --base main --head feat/publish-choice --fill",
	args.join(" "),
);

const commands = new Map<string, unknown>();
publishExtension({
	registerCommand: (name: string, command: unknown) => commands.set(name, command),
} as any);
assert(
	"registers /git:publish instead of /publish",
	commands.has("git:publish") && !commands.has("publish"),
	JSON.stringify([...commands.keys()]),
);
const publishCommand = commands.get("git:publish") as {
	handler: (args: string, ctx: any) => Promise<void>;
};

function runGit(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initializeRepository(root: string, branch: string): void {
	runGit(root, ["init", "-q", "-b", branch]);
	runGit(root, ["config", "user.email", "test@example.com"]);
	runGit(root, ["config", "user.name", "Publish Test"]);
	writeFileSync(join(root, "tracked.txt"), "initial\n");
	runGit(root, ["add", "tracked.txt"]);
	runGit(root, ["commit", "-q", "-m", "chore: initialize test repository"]);
}

function publishContext(
	root: string,
	notifications: string[],
	select: (prompt: string, options: string[]) => Promise<string | undefined> = async () =>
		undefined,
): any {
	return {
		cwd: root,
		signal: undefined,
		ui: {
			notify: (message: string) => notifications.push(message),
			select,
		},
		model: undefined,
		modelRegistry: { find: () => undefined },
		thinkingLevel: "off",
	};
}

{
	const root = mkdtempSync(join(tmpdir(), "publish-stale-context-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: root });
		let stale = false;
		let notification = "";
		const guarded = <T>(value: T): T => {
			if (stale) throw new Error("stale command context accessed");
			return value;
		};
		const context = {
			get cwd() {
				return guarded(root);
			},
			get signal() {
				return guarded(undefined);
			},
			get ui() {
				return guarded({
					notify: (message: string) => {
						notification = message;
					},
				});
			},
			get model() {
				return guarded(undefined);
			},
			get modelRegistry() {
				return guarded({ find: () => undefined });
			},
			get thinkingLevel() {
				return guarded("off");
			},
		} as any;
		queueMicrotask(() => {
			stale = true;
		});
		await publishCommand.handler("", context);
		assert(
			"publish does not dereference a command context after async work begins",
			notification === "Nothing to publish - working tree is clean.",
			notification,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

{
	const sandbox = mkdtempSync(join(tmpdir(), "publish-clean-ahead-"));
	const root = join(sandbox, "repo");
	const remote = join(sandbox, "origin.git");
	try {
		mkdirSync(root);
		initializeRepository(root, "main");
		runGit(sandbox, ["init", "-q", "--bare", remote]);
		runGit(root, ["remote", "add", "origin", remote]);
		runGit(root, ["push", "-q", "-u", "origin", "main"]);
		writeFileSync(join(root, "tracked.txt"), "published\n");
		runGit(root, ["commit", "-q", "-am", "fix: publish committed work"]);

		const notifications: string[] = [];
		await publishCommand.handler(
			"",
			publishContext(root, notifications, async (_prompt, options) =>
				options.find((option) => option === "Push directly to main"),
			),
		);
		assert(
			"publishes a clean branch with commits ahead of origin",
			runGit(root, ["rev-parse", "HEAD"]) === runGit(remote, ["rev-parse", "refs/heads/main"]) &&
				notifications.at(-1)?.startsWith("Published ") === true,
			JSON.stringify(notifications),
		);

		notifications.length = 0;
		await publishCommand.handler("", publishContext(root, notifications));
		assert(
			"reports a clean branch with no unpushed commits as synchronized",
			notifications.at(-1) === "Nothing to publish - working tree is clean.",
			JSON.stringify(notifications),
		);
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
}

{
	const sandbox = mkdtempSync(join(tmpdir(), "publish-no-upstream-"));
	const root = join(sandbox, "repo");
	const remote = join(sandbox, "origin.git");
	try {
		mkdirSync(root);
		initializeRepository(root, "feature/no-upstream");
		runGit(sandbox, ["init", "-q", "--bare", remote]);
		runGit(root, ["remote", "add", "origin", remote]);
		const notifications: string[] = [];
		await publishCommand.handler("", publishContext(root, notifications));
		assert(
			"publishes a clean branch without an upstream and configures tracking",
			runGit(root, ["rev-parse", "HEAD"]) ===
				runGit(remote, ["rev-parse", "refs/heads/feature/no-upstream"]) &&
				runGit(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]) === "origin/feature/no-upstream",
			JSON.stringify(notifications),
		);
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
}

{
	const root = mkdtempSync(join(tmpdir(), "publish-dirty-tree-"));
	try {
		initializeRepository(root, "feature/dirty");
		writeFileSync(join(root, "tracked.txt"), "dirty\n");
		const notifications: string[] = [];
		await publishCommand.handler("", publishContext(root, notifications));
		assert(
			"preserves the existing commit-drafting path for dirty trees",
			notifications.includes("Drafting commit message...") &&
				notifications.at(-1) === "No model selected; aborting.",
			JSON.stringify(notifications),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

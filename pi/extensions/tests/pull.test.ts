import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pullExtension from "../pull.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitMaybe(cwd: string, args: string[]): string {
	try {
		return git(cwd, args);
	} catch {
		return "";
	}
}

const root = mkdtempSync(join(tmpdir(), "pi-git-pull-cmd-"));
const remote = join(root, "remote.git");
const repo = join(root, "repo");
const peer = join(root, "peer");
const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
const notices: Array<{ message: string; level: string }> = [];

function context(cwd: string) {
	return {
		cwd,
		hasUI: false,
		signal: undefined,
		ui: {
			notify: (message: string, level: string) => notices.push({ message, level }),
		},
	};
}

try {
	execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
	execFileSync("git", ["clone", remote, repo], { stdio: "pipe" });
	git(repo, ["config", "user.email", "pi@example.com"]);
	git(repo, ["config", "user.name", "Pi"]);
	git(repo, ["branch", "-M", "main"]);
	writeFileSync(join(repo, "tracked.txt"), "initial\n");
	git(repo, ["add", "tracked.txt"]);
	git(repo, ["commit", "-m", "initial"]);
	git(repo, ["push", "-u", "origin", "main"]);
	execFileSync("git", ["clone", remote, peer], { stdio: "pipe" });
	git(peer, ["config", "user.email", "peer@example.com"]);
	git(peer, ["config", "user.name", "Peer"]);

	pullExtension({
		exec: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) =>
			Promise.resolve(
				(() => {
					try {
						const stdout = execFileSync(command, args, {
							cwd: options?.cwd,
							encoding: "utf8",
							stdio: ["ignore", "pipe", "pipe"],
						});
						return { code: 0, stdout, stderr: "" };
					} catch (error) {
						const failed = error as { status?: number; stdout?: unknown; stderr?: unknown };
						return {
							code: typeof failed.status === "number" ? failed.status : 1,
							stdout: String(failed.stdout ?? ""),
							stderr: String(failed.stderr ?? ""),
						};
					}
				})(),
			),
		registerCommand: (
			name: string,
			command: { handler: (args: string, ctx: any) => Promise<void> },
		) => {
			commands.set(name, command);
		},
	} as any);

	const command = commands.get("git:pull");
	assert("registers /git:pull", !!command, JSON.stringify([...commands.keys()]));

	writeFileSync(join(peer, "remote.txt"), "from peer\n");
	git(peer, ["add", "remote.txt"]);
	git(peer, ["commit", "-m", "peer update"]);
	git(peer, ["push"]);

	writeFileSync(join(repo, "local.txt"), "uncommitted\n");
	await command!.handler("", context(repo));
	assert(
		"refuses to pull with uncommitted changes",
		notices.at(-1)?.level === "error" &&
			notices.at(-1)?.message.includes("uncommitted changes") === true,
		JSON.stringify(notices),
	);
	assert(
		"dirty pull does not update files",
		!readFileSync(join(repo, "tracked.txt"), "utf8").includes("from peer"),
		"Unexpected update",
	);

	rmSync(join(repo, "local.txt"));
	await command!.handler("", context(repo));
	const successfulPull = notices.at(-1);
	assert(
		"fast-forwards from the configured upstream",
		readFileSync(join(repo, "remote.txt"), "utf8") === "from peer\n" &&
			successfulPull !== undefined &&
			successfulPull.level === "info" &&
			successfulPull.message.includes("Pulled origin/main into main"),
		JSON.stringify(notices),
	);

	writeFileSync(join(repo, "local-commit.txt"), "local\n");
	git(repo, ["add", "local-commit.txt"]);
	git(repo, ["commit", "-m", "local update"]);
	writeFileSync(join(peer, "peer-commit.txt"), "peer\n");
	git(peer, ["add", "peer-commit.txt"]);
	git(peer, ["commit", "-m", "divergent peer update"]);
	git(peer, ["push"]);
	const localHead = git(repo, ["rev-parse", "HEAD"]).trim();
	await command!.handler("", context(repo));
	const failedPull = notices.at(-1);
	assert(
		"refuses to merge divergent history",
		failedPull !== undefined &&
			failedPull.level === "error" &&
			failedPull.message.includes("Pull failed") &&
			git(repo, ["rev-parse", "HEAD"]).trim() === localHead &&
			gitMaybe(repo, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).trim() === "",
		JSON.stringify(notices),
	);

	console.log("All Git pull command tests passed.");
} finally {
	rmSync(root, { recursive: true, force: true });
}

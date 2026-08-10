import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
		const command = commands.get("git:publish") as {
			handler: (args: string, ctx: any) => Promise<void>;
		};
		await command.handler("", context);
		assert(
			"publish does not dereference a command context after async work begins",
			notification === "Nothing to publish - working tree is clean.",
			notification,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

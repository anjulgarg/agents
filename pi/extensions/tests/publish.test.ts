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

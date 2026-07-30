import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamSimple } from "@earendil-works/pi-ai/compat";

// /git:publish - stage every change, draft a Conventional Commits message with the
// codex backend, commit, and push to origin. On the default branch, ask whether
// to push directly or create a topic branch and pull request.

const DIFF_CHAR_BUDGET = 24_000;

const DRAFT_INSTRUCTIONS = [
	"You write a single git commit message from a staged diff.",
	"Follow the Conventional Commits style and match the conventions visible in the recent commit subjects (type, and scope in parentheses when used).",
	"Output ONLY the raw commit message, with no code fences, quotes, or preamble.",
	"First line: a subject under 72 characters. Then a blank line and a short body (a few lines max) explaining what changed and why, only if it adds information.",
	"Do not invent changes that are not in the diff. Do not use the em dash character.",
].join(" ");

interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

type PublishStrategy = "current" | "direct" | "pull-request";

const DEFAULT_BRANCH_CHOICES = {
	pullRequest: "Create branch and pull request (Recommended)",
	cancel: "Cancel",
} as const;

function run(
	command: string,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const onAbort = () => child.kill("SIGTERM");
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (c) => (stdout += c.toString()));
		child.stderr.on("data", (c) => (stderr += c.toString()));
		child.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});
		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			resolve({ code, stdout, stderr });
		});
	});
}

function git(args: string[], cwd: string, signal?: AbortSignal): Promise<CommandResult> {
	return run("git", args, cwd, signal);
}

async function gitOk(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
	const result = await git(args, cwd, signal);
	if (result.code !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
		);
	}
	return result.stdout.trim();
}

async function defaultBranch(cwd: string): Promise<string | undefined> {
	const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
	if (head.code === 0 && head.stdout.trim()) {
		return head.stdout.trim().replace(/^origin\//, "");
	}
	return undefined;
}

function stripFences(text: string): string {
	let out = text.trim();
	const fence = out.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
	if (fence) out = fence[1].trim();
	return out;
}

function slugify(subject: string): string {
	const match = subject.match(/^(\w+)(?:\([^)]*\))?:\s*(.*)$/);
	const type = match ? match[1] : "chore";
	const rest = (match ? match[2] : subject)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	return `${type}/${rest || "update"}`;
}

async function uniqueBranch(base: string, cwd: string): Promise<string> {
	let name = base;
	let n = 2;
	while ((await git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], cwd)).code === 0) {
		name = `${base}-${n++}`;
	}
	return name;
}

export function isDefaultBranch(current: string, base?: string): boolean {
	return base ? current === base : current === "main" || current === "master";
}

export function pullRequestArgs(base: string, head: string): string[] {
	return ["pr", "create", "--base", base, "--head", head, "--fill"];
}

async function chooseDefaultBranchStrategy(
	ctx: ExtensionCommandContext,
	branch: string,
): Promise<PublishStrategy | undefined> {
	const directChoice = `Push directly to ${branch}`;
	const choice = await ctx.ui.select(`Publish directly from ${branch}? Choose how to continue.`, [
		DEFAULT_BRANCH_CHOICES.pullRequest,
		directChoice,
		DEFAULT_BRANCH_CHOICES.cancel,
	]);
	if (choice === DEFAULT_BRANCH_CHOICES.pullRequest) return "pull-request";
	if (choice === directChoice) return "direct";
	return undefined;
}

async function publish(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const cwd = ctx.cwd;
	const signal = ctx.signal;

	if ((await git(["rev-parse", "--is-inside-work-tree"], cwd)).code !== 0) {
		ctx.ui.notify("Not a git repository.", "error");
		return;
	}

	const status = await gitOk(["status", "--porcelain"], cwd, signal);
	if (!status) {
		ctx.ui.notify("Nothing to publish - working tree is clean.", "info");
		return;
	}

	const current = (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).stdout.trim();
	const base = await defaultBranch(cwd);
	let strategy: PublishStrategy = "current";
	if (isDefaultBranch(current, base)) {
		const selected = await chooseDefaultBranchStrategy(ctx, current);
		if (!selected) {
			ctx.ui.notify("Publish cancelled.", "info");
			return;
		}
		strategy = selected;
	}

	await gitOk(["add", "-A"], cwd, signal);

	const diff = await gitOk(["diff", "--cached"], cwd, signal);
	if (!diff) {
		ctx.ui.notify("Nothing staged to publish.", "info");
		return;
	}
	const nameStatus = await gitOk(["diff", "--cached", "--name-status"], cwd, signal);
	const recent = (await git(["log", "-8", "--pretty=format:%s"], cwd)).stdout.trim();

	const clippedDiff =
		diff.length > DIFF_CHAR_BUDGET
			? `${diff.slice(0, DIFF_CHAR_BUDGET)}\n...[diff truncated]...`
			: diff;
	const promptParts = [
		recent ? `Recent commit subjects (match this style):\n${recent}` : "",
		args.trim() ? `Author hint: ${args.trim()}` : "",
		`Changed files:\n${nameStatus}`,
		`Staged diff:\n${clippedDiff}`,
	].filter(Boolean);

	ctx.ui.notify("Drafting commit message...", "info");
	if (!ctx.model) {
		ctx.ui.notify("No active model; aborting.", "error");
		return;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) {
		ctx.ui.notify(`Could not resolve auth: ${auth.error}`, "error");
		return;
	}
	const stream = streamSimple(
		ctx.model,
		{
			systemPrompt: DRAFT_INSTRUCTIONS,
			messages: [{ role: "user", content: promptParts.join("\n\n"), timestamp: Date.now() }],
		},
		{
			reasoning: "low",
			signal,
			...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
			...(auth.headers ? { headers: auth.headers } : {}),
			...(auth.env ? { env: auth.env } : {}),
		},
	);
	let drafted = "";
	let streamError: string | undefined;
	for await (const event of stream) {
		if (event.type === "text_delta") drafted += event.delta ?? "";
		else if (event.type === "error") streamError = event.error?.errorMessage ?? "stream error";
	}
	if (streamError) {
		ctx.ui.notify(`Drafting failed: ${streamError}`, "error");
		return;
	}
	drafted = stripFences(drafted.trim());
	if (!drafted) {
		ctx.ui.notify("Could not draft a commit message; aborting.", "error");
		return;
	}
	const subject = drafted.split("\n", 1)[0].trim();

	let targetBranch = current;
	if (strategy === "pull-request" || current === "HEAD") {
		targetBranch = await uniqueBranch(slugify(subject), cwd);
		await gitOk(["switch", "-c", targetBranch], cwd, signal);
	}

	const dir = await mkdtemp(join(tmpdir(), "pi-publish-"));
	const msgFile = join(dir, "COMMIT_MSG");
	try {
		await writeFile(msgFile, `${drafted}\n`);
		await gitOk(["commit", "-F", msgFile], cwd, signal);
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
	const shortHash = (await git(["rev-parse", "--short", "HEAD"], cwd)).stdout.trim();

	const hasOrigin = (await git(["remote", "get-url", "origin"], cwd)).code === 0;
	if (!hasOrigin) {
		ctx.ui.notify(
			`Committed ${shortHash} on ${targetBranch}. No 'origin' remote, so nothing was pushed.`,
			"warning",
		);
		return;
	}

	const push = await git(["push", "-u", "origin", targetBranch], cwd, signal);
	if (push.code !== 0) {
		ctx.ui.notify(
			`Committed ${shortHash} on ${targetBranch}, but push failed: ${push.stderr.trim() || push.stdout.trim()}`,
			"error",
		);
		return;
	}

	if (strategy === "pull-request") {
		let pullRequest: CommandResult;
		try {
			pullRequest = await run("gh", pullRequestArgs(base ?? current, targetBranch), cwd, signal);
		} catch (error) {
			ctx.ui.notify(
				`Published ${shortHash} to origin/${targetBranch}, but PR creation failed: ${(error as Error).message}`,
				"error",
			);
			return;
		}
		if (pullRequest.code !== 0) {
			ctx.ui.notify(
				`Published ${shortHash} to origin/${targetBranch}, but PR creation failed: ${pullRequest.stderr.trim() || pullRequest.stdout.trim()}`,
				"error",
			);
			return;
		}
		const url = pullRequest.stdout.trim();
		ctx.ui.notify(`Published ${shortHash} and created PR${url ? `: ${url}` : "."}`, "info");
		return;
	}

	ctx.ui.notify(`Published ${shortHash} to origin/${targetBranch}: ${subject}`, "info");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("git:publish", {
		description: "Stage all changes, draft an AI commit message, commit, and push to origin",
		handler: async (args, ctx) => {
			try {
				await publish(args, ctx);
			} catch (error) {
				ctx.ui.notify(`Publish failed: ${(error as Error).message}`, "error");
			}
		},
	});
}

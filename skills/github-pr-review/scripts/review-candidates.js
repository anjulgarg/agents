#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
	const args = { limit: "50" };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--repo") args.repo = argv[++i];
		else if (arg === "--limit") args.limit = argv[++i];
		else if (arg === "--help" || arg === "-h") args.help = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return args;
}

function gh(args) {
	return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

function ghJson(args) {
	const out = gh(args);
	return out ? JSON.parse(out) : null;
}

function runActivity(repo, number) {
	const scriptDir = path.dirname(fileURLToPath(import.meta.url));
	const script = path.join(scriptDir, "review-activity.js");
	const out = execFileSync(process.execPath, [script, "--repo", repo, "--pr", String(number)], {
		encoding: "utf8",
	});
	return JSON.parse(out);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(`Usage: node review-candidates.js --repo owner/name [--limit 50]

Required:
  --repo owner/name  GitHub repository to inspect.

Optional:
  --limit 50         Maximum open PRs to list.`);
		process.exit(0);
	}
	if (!args.repo) {
		console.error("Missing required argument: --repo owner/name");
		console.error("Run with --help for usage.");
		process.exit(args.help ? 0 : 1);
	}
	const [owner, repoName] = args.repo.split("/");
	if (!owner || !repoName) throw new Error("--repo must use owner/name format");

	const ghLogin = gh(["api", "user", "--jq", ".login"]);
	const prs = ghJson([
		"pr",
		"list",
		"--repo",
		args.repo,
		"--state",
		"open",
		"--limit",
		args.limit,
		"--json",
		"number,title,state,isDraft,mergeStateStatus,headRefName,baseRefName,headRefOid,updatedAt,author,url",
	]);

	const results = prs.map((pr) => {
		const activity = runActivity(args.repo, pr.number);
		const base = {
			number: pr.number,
			title: pr.title,
			url: pr.url,
			author: pr.author && pr.author.login,
			decision: activity.decision,
		};
		if (activity.decision.action === "review") {
			return {
				...base,
				isDraft: pr.isDraft,
				mergeStateStatus: pr.mergeStateStatus,
				updatedAt: pr.updatedAt,
				activity: activity.metadata,
			};
		}
		if (activity.decision.action === "blocked") {
			return { ...base, isDraft: pr.isDraft, mergeStateStatus: pr.mergeStateStatus };
		}
		return base;
	});

	const byAction = {
		review: results.filter((item) => item.decision.action === "review"),
		skip: results.filter((item) => item.decision.action === "skip"),
		blocked: results.filter((item) => item.decision.action === "blocked"),
	};

	console.log(
		JSON.stringify(
			{
				repo: args.repo,
				ghLogin,
				generatedAt: new Date().toISOString(),
				counts: {
					totalOpen: results.length,
					review: byAction.review.length,
					skip: byAction.skip.length,
					blocked: byAction.blocked.length,
				},
				review: byAction.review,
				blocked: byAction.blocked,
				skip: byAction.skip,
				fallbackCommands: {
					listOpenPrs: `gh pr list --repo ${args.repo} --state open --limit ${args.limit} --json number,title,state,isDraft,mergeStateStatus,headRefName,baseRefName,headRefOid,updatedAt,author,url`,
					ghLogin: "gh api user --jq .login",
					apiBase: `repos/${owner}/${repoName}`,
				},
			},
			null,
			2,
		),
	);
}

try {
	main();
} catch (error) {
	console.error(JSON.stringify({ error: error.message }, null, 2));
	process.exit(1);
}

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { decideReviewActivity } from "./lib/review-activity-core.js";

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--pr") args.pr = argv[++i];
		else if (arg === "--repo") args.repo = argv[++i];
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

function paged(endpoint) {
	const pages = ghJson(["api", endpoint, "--paginate", "--slurp"]);
	return Array.isArray(pages) ? pages.flat() : [];
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(`Usage: node review-activity.js --repo owner/name --pr <number>

Required:
  --repo owner/name  GitHub repository containing the PR.
  --pr <number>      Pull request number to inspect.`);
		process.exit(0);
	}
	const missing = [];
	if (!args.repo) missing.push("--repo owner/name");
	if (!args.pr) missing.push("--pr <number>");
	if (missing.length) {
		console.error(
			`Missing required argument${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
		);
		console.error("Run with --help for usage.");
		process.exit(1);
	}

	const ghLogin = gh(["api", "user", "--jq", ".login"]);
	const pr = ghJson([
		"pr",
		"view",
		args.pr,
		"--repo",
		args.repo,
		"--json",
		"number,title,state,isDraft,mergeStateStatus,headRefName,baseRefName,headRefOid,updatedAt,author,url",
	]);

	const [owner, repoName] = args.repo.split("/");
	if (!owner || !repoName) throw new Error("--repo must use owner/name format");
	const base = `repos/${owner}/${repoName}`;
	const reviewComments = paged(`${base}/pulls/${args.pr}/comments`);
	const issueComments = paged(`${base}/issues/${args.pr}/comments`);
	const reviews = paged(`${base}/pulls/${args.pr}/reviews`);
	const commits = paged(`${base}/pulls/${args.pr}/commits`);

	const output = decideReviewActivity({
		repo: args.repo,
		prNumber: Number(args.pr),
		ghLogin,
		pr,
		reviewComments,
		conversationComments: issueComments,
		reviews,
		commits,
	});

	console.log(JSON.stringify(output, null, 2));
}

try {
	main();
} catch (error) {
	console.error(JSON.stringify({ error: error.message }, null, 2));
	process.exit(1);
}

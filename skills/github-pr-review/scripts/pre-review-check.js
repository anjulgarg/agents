#!/usr/bin/env node

import { execFileSync } from "node:child_process";

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--pr") args.pr = argv[++i];
		else if (arg === "--repo") args.repo = argv[++i];
		else if (arg === "--clone") args.clone = argv[++i];
		else if (arg === "--raw") args.raw = true;
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

function compactFile(file) {
	return {
		filename: file.filename,
		status: file.status,
		additions: file.additions,
		deletions: file.deletions,
		changes: file.changes,
		patchPreview: (file.patch || "").slice(0, 160),
	};
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(`Usage: node pre-review-check.js --repo owner/name --pr <number> [--clone /path/to/local/repo] [--raw]

Required:
  --repo owner/name           GitHub repository containing the PR.
  --pr <number>               Pull request number to inspect.

Optional:
  --clone /path/to/local/repo Local checkout path for fallback checkout commands.
  --raw                       Include full GitHub file metadata (normally omitted).`);
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
	const files = paged(`repos/${owner}/${repoName}/pulls/${args.pr}/files`);
	const totals = files.reduce(
		(sum, file) => {
			sum.additions += file.additions || 0;
			sum.deletions += file.deletions || 0;
			sum.changes += file.changes || 0;
			return sum;
		},
		{ additions: 0, deletions: 0, changes: 0 },
	);

	const hardSkips = [];
	const warnings = [];
	if (pr.isDraft) hardSkips.push("draft");
	if (pr.state !== "OPEN") hardSkips.push("not_open");
	if (pr.mergeStateStatus === "BEHIND") warnings.push("behind_base");
	if (pr.mergeStateStatus === "DIRTY") hardSkips.push("merge_conflicts");

	const sensitiveChange = files.some((file) => {
		const target = `${file.filename}\n${file.patch || ""}`;
		const sensitive =
			/auth|permission|security|crypto|secret|token|session|migration|schema|transaction|concurr|lock|public api|\.github\/workflows|terraform|kubernetes/i;
		return sensitive.test(target);
	});
	const suggestedDepth =
		files.length <= 2 && totals.changes <= 80 && !sensitiveChange ? "quick" : "deep";

	console.log(
		JSON.stringify(
			{
				repo: args.repo,
				prNumber: Number(args.pr),
				ghLogin,
				decision: {
					canReview: hardSkips.length === 0,
					hardSkips,
					warnings,
					suggestedDepth,
					depthReason: sensitiveChange
						? "Sensitive behavior requires deep review"
						: suggestedDepth === "quick"
							? "Two or fewer files and no more than 80 changed lines"
							: "More than two files or more than 80 changed lines",
				},
				metadata: {
					pr,
					clonePath: args.clone || null,
					totals,
					fileCount: files.length,
					files: files.map(compactFile),
					...(args.raw ? { raw: { files } } : {}),
				},
				fallbackCommands: {
					cloneTemplate: `gh repo clone ${args.repo} <local-dir>`,
					pr: `gh pr view ${args.pr} --repo ${args.repo} --json number,title,state,isDraft,mergeStateStatus,headRefName,baseRefName,headRefOid,updatedAt,author,url`,
					files: `gh api repos/${owner}/${repoName}/pulls/${args.pr}/files --paginate`,
					checkoutTemplate: `cd <local-dir> && gh pr checkout ${args.pr}`,
					...(args.clone
						? {
								ensureClone: `[[ -d ${args.clone}/.git ]] || gh repo clone ${args.repo} ${args.clone}`,
								checkout: `cd ${args.clone} && gh pr checkout ${args.pr}`,
							}
						: {}),
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

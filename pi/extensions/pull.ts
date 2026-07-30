/**
 * `/git:pull` - fast-forward the current branch from its configured upstream.
 *
 * The command refuses dirty worktrees and detached HEADs, and never creates a
 * merge commit or performs an implicit rebase.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type ExecLike = ExtensionAPI["exec"];

async function pull(args: string, ctx: ExtensionCommandContext, exec: ExecLike): Promise<void> {
	if (args.trim()) {
		ctx.ui.notify("Usage: /git:pull", "error");
		return;
	}

	const repository = await exec("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd: ctx.cwd,
		timeout: 5000,
	});
	if (repository.code !== 0) {
		ctx.ui.notify("Not inside a Git repository.", "error");
		return;
	}

	const status = await exec("git", ["status", "--porcelain", "--untracked-files=all"], {
		cwd: ctx.cwd,
		timeout: 5000,
	});
	if (status.code !== 0) {
		ctx.ui.notify(status.stderr.trim() || "Could not inspect the current checkout.", "error");
		return;
	}
	if (status.stdout.trim()) {
		ctx.ui.notify("Pull refused: commit, stash, or discard uncommitted changes first.", "error");
		return;
	}

	const branch = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd: ctx.cwd,
		timeout: 5000,
	});
	if (branch.code !== 0 || !branch.stdout.trim()) {
		ctx.ui.notify("Pull refused: the checkout is in detached HEAD state.", "error");
		return;
	}

	const upstream = await exec(
		"git",
		["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
		{
			cwd: ctx.cwd,
			timeout: 5000,
		},
	);
	if (upstream.code !== 0 || !upstream.stdout.trim()) {
		ctx.ui.notify(`Pull refused: ${branch.stdout.trim()} has no configured upstream.`, "error");
		return;
	}

	const result = await exec("git", ["pull", "--ff-only"], {
		cwd: ctx.cwd,
		timeout: 120_000,
	});
	const detail = result.stderr.trim() || result.stdout.trim();
	if (result.code !== 0) {
		ctx.ui.notify(
			`Pull failed on ${branch.stdout.trim()}: ${detail || `exit ${result.code}`}`,
			"error",
		);
		return;
	}

	ctx.ui.notify(
		`Pulled ${upstream.stdout.trim()} into ${branch.stdout.trim()}${detail ? `: ${detail}` : "."}`,
		"info",
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("git:pull", {
		description: "Fast-forward the current Git branch from its configured upstream",
		handler: async (args, ctx) => {
			try {
				await pull(args, ctx, pi.exec);
			} catch (error) {
				ctx.ui.notify(
					`Pull failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}

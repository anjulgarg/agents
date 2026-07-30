/**
 * Git checkpoint extension tests (real git in temp repos, fake pi for wiring).
 *
 * Run: npm run test:extensions
 */
import { execFile, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Resolve typebox the same way the global `pi` install does, then re-exec if needed. */
function ensurePiModulePath(): void {
	if (process.env.PI_CHECKPOINT_TEST_READY === "1") return;

	const candidates: string[] = [];
	const which = spawnSync("which", ["pi"], { encoding: "utf8" });
	const piBin = which.stdout?.trim();
	if (piBin) {
		try {
			const real = fs.realpathSync(piBin);
			candidates.push(path.resolve(path.dirname(real), ".."));
		} catch {
			// continue
		}
	}

	const require = createRequire(import.meta.url);
	try {
		candidates.push(path.dirname(require.resolve("@earendil-works/pi-coding-agent/package.json")));
	} catch {
		// continue
	}

	try {
		const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout?.trim();
		if (npmRoot) candidates.push(path.join(npmRoot, "@earendil-works/pi-coding-agent"));
	} catch {
		// continue
	}

	const piRoot = candidates.find(
		(candidate) =>
			fs.existsSync(path.join(candidate, "package.json")) &&
			fs.existsSync(path.join(candidate, "node_modules", "typebox")),
	);
	if (!piRoot) {
		console.error(
			"FAIL: cannot locate @earendil-works/pi-coding-agent with typebox for test module resolution",
		);
		process.exit(1);
	}
	const nodePath = [
		path.join(piRoot, "node_modules"),
		path.dirname(path.dirname(piRoot)),
		process.env.NODE_PATH,
	]
		.filter(Boolean)
		.join(path.delimiter);
	const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
		stdio: "inherit",
		env: { ...process.env, NODE_PATH: nodePath, PI_CHECKPOINT_TEST_READY: "1" },
	});
	process.exit(result.status ?? 1);
}

ensurePiModulePath();

const {
	applyRestore,
	CheckpointsView,
	cleanupPlan,
	default: gitCheckpoint,
	listCheckpointRefs,
	planRestore,
	pruneCheckpoints,
	resolveRepo,
	snapshotOnce,
} = await import("../git-checkpoint.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");
type CheckpointEntry = import("../git-checkpoint.ts").CheckpointEntry;
type GitRunner = import("../git-checkpoint.ts").GitRunner;

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

function checkpointEntry(index: number): CheckpointEntry {
	const id = String(index).padStart(12, "0");
	return {
		v: 1,
		id,
		ref: `refs/pi/checkpoints/${id}`,
		commit: id.repeat(4).slice(0, 40),
		tree: id.repeat(4).slice(0, 40),
		worktree: "/tmp/checkpoint-ui",
		createdAt: Date.now() - (index + 1) * 60_000,
		reason: index % 3 === 0 ? "manual" : index % 3 === 1 ? "auto" : "safety",
		note: `Checkpoint note ${index}`,
	};
}

function makeCheckpointsView(
	entries: CheckpointEntry[],
	rows = 20,
): {
	view: InstanceType<typeof CheckpointsView>;
	getRenderRequests: () => number;
} {
	let renderRequests = 0;
	const tui = {
		terminal: { rows },
		requestRender: () => {
			renderRequests++;
		},
	};
	const theme = {
		fg: (_color: string, text: string) => `\x1b[38;5;180m${text}\x1b[39m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	};
	return {
		view: new CheckpointsView(
			tui as never,
			theme as never,
			entries,
			"/tmp/checkpoint-ui",
			() => {},
		),
		getRenderRequests: () => renderRequests,
	};
}

function testCheckpointViewStableNavigation(): void {
	const width = 64;
	const entries = Array.from({ length: 12 }, (_, index) => checkpointEntry(index));
	entries[0]!.note = "Checkpoint note 0\nwith ANSI \x1b[31mred\x1b[0m text";
	const { view, getRenderRequests } = makeCheckpointsView(entries);
	const initial = view.render(width);
	view.handleInput("\x1b[B");
	const next = view.render(width);
	const changedRows = initial
		.map((line, index) => (line === next[index] ? -1 : index))
		.filter((index) => index >= 0);

	assert(
		"checkpoint TUI navigation only repaints the old and new selection rows",
		changedRows.join(",") === "3,6" &&
			getRenderRequests() === 1 &&
			initial[3]?.includes("› ") &&
			next[6]?.includes("› ") &&
			initial.every((line) => !line.includes("\n") && !line.includes("[31m")) &&
			initial.some((line) => line.includes("Checkpoint note 0 with ANSI red text")),
		`changedRows=${JSON.stringify(changedRows)} requests=${getRenderRequests()} initial=${JSON.stringify(initial)}`,
	);
	assert(
		"checkpoint TUI uses shared full-screen chrome and exact bounds",
		initial.length === 20 &&
			initial.every((line) => visibleWidth(line) === width) &&
			initial[0]?.includes("Checkpoints") &&
			initial[2]?.includes("─") &&
			visibleWidth(initial.at(-1)!.trim()) === 0 &&
			initial.some((line) => line.includes("PgUp/PgDn")),
		`length=${initial.length} widths=${JSON.stringify(initial.map((line) => visibleWidth(line)))}`,
	);
}

function testCheckpointViewScrollBounds(): void {
	const width = 52;
	const entries = Array.from({ length: 12 }, (_, index) => checkpointEntry(index));
	const { view } = makeCheckpointsView(entries);
	const initial = view.render(width);
	for (let index = 0; index < entries.length - 1; index++) view.handleInput("\x1b[B");
	const last = view.render(width);

	assert(
		"checkpoint TUI selection viewport scrolls inside a pinned screen",
		last.length === 20 &&
			last.every((line) => visibleWidth(line) === width) &&
			initial.slice(0, 3).join("\n") === last.slice(0, 3).join("\n") &&
			initial.slice(-3).join("\n") === last.slice(-3).join("\n") &&
			last.some((line) => line.includes("Checkpoint note 11")) &&
			last[0]?.includes("Checkpoints") &&
			visibleWidth(last.at(-1)!.trim()) === 0,
		JSON.stringify({ header: initial.slice(0, 3), footer: initial.slice(-3), last }),
	);
}

function testCheckpointViewEmptyAndNarrow(): void {
	const empty = makeCheckpointsView([]).view.render(24);
	const compact = makeCheckpointsView([checkpointEntry(0)], 8).view.render(30);
	const tiny = makeCheckpointsView([checkpointEntry(0)], 6).view.render(18);
	assert(
		"checkpoint TUI preserves bounds for empty, narrow, and short screens",
		empty.length === 20 &&
			empty.every((line) => visibleWidth(line) === 24) &&
			empty.some((line) => line.includes("No checkpoints")) &&
			compact.length === 8 &&
			compact.every((line) => visibleWidth(line) === 30) &&
			compact.some((line) => line.includes("Checkpoints")) &&
			compact.at(-1)?.trim() === "" &&
			tiny.length === 6 &&
			tiny.every((line) => visibleWidth(line) === 18) &&
			tiny[0]?.includes("Checkpoints") &&
			tiny.at(-1)?.trim() === "",
		`empty=${JSON.stringify(empty)} compact=${JSON.stringify(compact)} tiny=${JSON.stringify(tiny)}`,
	);
}

function git(cwd: string, args: string[], env?: Record<string, string>): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

const execFileAsync = promisify(execFile);

function makeRunner(cwd: string): GitRunner {
	return async (args, options = {}) => {
		try {
			const { stdout, stderr } = await execFileAsync("git", args, {
				cwd,
				encoding: "utf8",
				timeout: options.timeout ?? 60_000,
				maxBuffer: 256 * 1024 * 1024,
				env: { ...process.env, ...options.env },
			});
			return { stdout, stderr, code: 0 };
		} catch (error: unknown) {
			const failure = error as { code?: unknown; stdout?: string; stderr?: string };
			if (typeof failure?.code === "number") {
				return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code };
			}
			throw error;
		}
	};
}

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-checkpoint-test-"));
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "test@example.invalid"]);
	git(dir, ["config", "user.name", "Test"]);
	return dir;
}

const cleanup: string[] = [];
function track(dir: string): string {
	cleanup.push(dir);
	return dir;
}

async function testSnapshotCapturesEverything(): Promise<void> {
	const repo = track(makeRepo());
	fs.writeFileSync(join(repo, "tracked.txt"), "v1\n");
	git(repo, ["add", "tracked.txt"]);
	git(repo, ["commit", "-qm", "baseline"]);

	fs.writeFileSync(join(repo, "tracked.txt"), "v2 unstaged\n");
	fs.writeFileSync(join(repo, "staged.txt"), "staged\n");
	git(repo, ["add", "staged.txt"]);
	fs.writeFileSync(join(repo, "untracked.txt"), "untracked\n");

	const runner = makeRunner(repo);
	const repoInfo = (await resolveRepo(runner))!;
	const snapshot = await snapshotOnce(runner, repoInfo);
	const names = git(repo, ["ls-tree", "-r", "--name-only", snapshot.commit]);
	const stagedContent = git(repo, ["show", `${snapshot.commit}:staged.txt`]);
	const untrackedContent = git(repo, ["show", `${snapshot.commit}:untracked.txt`]);
	const trackedContent = git(repo, ["show", `${snapshot.commit}:tracked.txt`]);
	const parent = git(repo, ["rev-list", "--parents", "-n", "1", snapshot.commit]).split(" ");
	assert(
		"snapshot captures staged, unstaged, and untracked files with HEAD parent",
		snapshot.created &&
			names.includes("staged.txt") &&
			names.includes("untracked.txt") &&
			stagedContent === "staged" &&
			untrackedContent === "untracked" &&
			trackedContent === "v2 unstaged" &&
			parent[1] === git(repo, ["rev-parse", "HEAD"]),
		`names=${names} snapshot=${JSON.stringify(snapshot)}`,
	);
}

async function testSnapshotLeavesRepoUntouched(): Promise<void> {
	const repo = track(makeRepo());
	fs.writeFileSync(join(repo, "a.txt"), "one\n");
	git(repo, ["add", "a.txt"]);
	git(repo, ["commit", "-qm", "baseline"]);
	fs.writeFileSync(join(repo, "b.txt"), "staged\n");
	git(repo, ["add", "b.txt"]);
	fs.writeFileSync(join(repo, "c.txt"), "untracked\n");

	const indexBefore = git(repo, ["ls-files", "--stage"]);
	const statusBefore = git(repo, ["status", "--porcelain"]);
	const runner = makeRunner(repo);
	await snapshotOnce(runner, (await resolveRepo(runner))!);
	assert(
		"snapshot leaves the real index and working tree untouched",
		git(repo, ["ls-files", "--stage"]) === indexBefore &&
			git(repo, ["status", "--porcelain"]) === statusBefore,
		`before=${JSON.stringify(statusBefore)} after=${JSON.stringify(git(repo, ["status", "--porcelain"]))}`,
	);
}

async function testDedupe(): Promise<void> {
	const repo = track(makeRepo());
	fs.writeFileSync(join(repo, "a.txt"), "one\n");
	const runner = makeRunner(repo);
	const repoInfo = (await resolveRepo(runner))!;
	const first = await snapshotOnce(runner, repoInfo);
	const second = await snapshotOnce(runner, repoInfo); // No `last` hint: dedupe via newest ref.
	const refs = await listCheckpointRefs(runner);
	assert(
		"unchanged trees dedupe to one checkpoint ref",
		first.created && !second.created && second.commit === first.commit && refs.length === 1,
		`first=${JSON.stringify(first)} second=${JSON.stringify(second)} refs=${refs.length}`,
	);
}

async function testEmptyRepository(): Promise<void> {
	const repo = track(makeRepo());
	fs.writeFileSync(join(repo, "a.txt"), "one\n");
	const runner = makeRunner(repo);
	const snapshot = await snapshotOnce(runner, (await resolveRepo(runner))!);
	const body = git(repo, ["cat-file", "-p", snapshot.commit]);
	assert(
		"snapshot works in a repository without commits",
		snapshot.created && body.startsWith("tree ") && !body.includes("\nparent"),
		`body=${body}`,
	);
}

async function testPrune(): Promise<void> {
	const repo = track(makeRepo());
	const runner = makeRunner(repo);
	const repoInfo = (await resolveRepo(runner))!;
	for (let i = 0; i < 5; i++) {
		// Distinct committer dates: for-each-ref date sorting has one-second resolution.
		fs.writeFileSync(join(repo, "a.txt"), `version ${i}\n`);
		git(repo, ["add", "a.txt"]);
		const tree = git(repo, ["write-tree"]);
		const commit = git(repo, ["commit-tree", tree, "-m", `c${i}`], {
			GIT_AUTHOR_DATE: `2030-01-0${i + 1}T00:00:00Z`,
			GIT_COMMITTER_DATE: `2030-01-0${i + 1}T00:00:00Z`,
		});
		git(repo, ["update-ref", `refs/pi/checkpoints/c${i}`, commit]);
	}
	void repoInfo;
	let refs = await listCheckpointRefs(runner);
	const prunedCount = await pruneCheckpoints(runner, {
		maxCount: 3,
		maxAgeMs: 365 * 24 * 60 * 60 * 1000,
	});
	refs = await listCheckpointRefs(runner);
	assert(
		"prune keeps only the newest maxCount checkpoints",
		prunedCount.length === 2 &&
			refs.length === 3 &&
			git(repo, ["show", `${refs[0].commit}:a.txt`]) === "version 4",
		`pruned=${prunedCount.length} remaining=${refs.length}`,
	);

	const tree = git(repo, ["write-tree"]);
	const oldCommit = git(repo, ["commit-tree", tree, "-m", "old"], {
		GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
		GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
	});
	git(repo, ["update-ref", "refs/pi/checkpoints/ancient", oldCommit]);
	const prunedAge = await pruneCheckpoints(runner, { maxCount: 50, maxAgeMs: 24 * 60 * 60 * 1000 });
	refs = await listCheckpointRefs(runner);
	assert(
		"prune removes checkpoints older than maxAge",
		prunedAge.includes("refs/pi/checkpoints/ancient") && refs.every((ref) => ref.id !== "ancient"),
		`pruned=${JSON.stringify(prunedAge)} remaining=${JSON.stringify(refs.map((ref) => ref.id))}`,
	);
}

async function setupRestoreRepo(): Promise<{
	repo: string;
	runner: GitRunner;
	first: { commit: string; tree: string };
	second: { commit: string };
}> {
	const repo = track(makeRepo());
	fs.writeFileSync(join(repo, "a.txt"), "v1\n");
	fs.writeFileSync(join(repo, "del.txt"), "delete me\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "baseline"]);
	const runner = makeRunner(repo);
	const repoInfo = (await resolveRepo(runner))!;
	const first = await snapshotOnce(runner, repoInfo);

	fs.writeFileSync(join(repo, "a.txt"), "v2\n");
	fs.rmSync(join(repo, "del.txt"));
	fs.writeFileSync(join(repo, "new.txt"), "new\n");
	const second = await snapshotOnce(runner, repoInfo);
	return { repo, runner, first, second };
}

async function testRestore(): Promise<void> {
	const { repo, runner, first } = await setupRestoreRepo();
	const repoInfo = (await resolveRepo(runner))!;
	const plan = await planRestore(runner, repoInfo, first.commit);
	try {
		const warning = await applyRestore(runner, repoInfo, plan, first.tree);
		const a = fs.readFileSync(join(repo, "a.txt"), "utf8");
		assert(
			"restore rewinds modifications, additions, and deletions",
			warning === null &&
				a === "v1\n" &&
				fs.existsSync(join(repo, "del.txt")) &&
				!fs.existsSync(join(repo, "new.txt")),
			`warning=${warning} a=${JSON.stringify(a)} del=${fs.existsSync(join(repo, "del.txt"))} new=${fs.existsSync(join(repo, "new.txt"))}`,
		);
	} finally {
		cleanupPlan(plan);
	}
}

async function testRestorePreservesStaging(): Promise<void> {
	const { repo, runner, first } = await setupRestoreRepo();
	fs.writeFileSync(join(repo, "staged.txt"), "staged\n");
	git(repo, ["add", "staged.txt"]);
	const stagedBefore = git(repo, ["diff", "--cached", "--name-only"]);

	const repoInfo = (await resolveRepo(runner))!;
	const plan = await planRestore(runner, repoInfo, first.commit);
	try {
		await applyRestore(runner, repoInfo, plan, first.tree);
		assert(
			"restore preserves the staging area",
			git(repo, ["diff", "--cached", "--name-only"]) === stagedBefore &&
				!fs.existsSync(join(repo, "staged.txt")),
			`before=${JSON.stringify(stagedBefore)} after=${JSON.stringify(git(repo, ["diff", "--cached", "--name-only"]))}`,
		);
	} finally {
		cleanupPlan(plan);
	}
}

async function testRestoreFailsClosed(): Promise<void> {
	const { repo, runner, first } = await setupRestoreRepo();
	const repoInfo = (await resolveRepo(runner))!;
	const plan = await planRestore(runner, repoInfo, first.commit);
	try {
		fs.appendFileSync(join(repo, "a.txt"), "concurrent edit\n");
		let threw = false;
		try {
			await applyRestore(runner, repoInfo, plan, first.tree);
		} catch {
			threw = true;
		}
		const content = fs.readFileSync(join(repo, "a.txt"), "utf8");
		assert(
			"restore fails closed when the working tree changed after preview",
			threw && content.includes("concurrent edit") && content.includes("v2"),
			`threw=${threw} content=${JSON.stringify(content)}`,
		);
	} finally {
		cleanupPlan(plan);
	}
}

async function testBinaryRoundTrip(): Promise<void> {
	const repo = track(makeRepo());
	const runner = makeRunner(repo);
	const repoInfo = (await resolveRepo(runner))!;
	const original = Buffer.from([0, 1, 2, 3, 255, 254, 10, 13, 0, 77, 0, 0]);
	fs.writeFileSync(join(repo, "bin.dat"), original);
	const first = await snapshotOnce(runner, repoInfo);
	fs.writeFileSync(join(repo, "bin.dat"), Buffer.from([9, 9, 9]));
	const plan = await planRestore(runner, repoInfo, first.commit);
	try {
		await applyRestore(runner, repoInfo, plan, first.tree);
		assert(
			"binary files round-trip through restore",
			fs.readFileSync(join(repo, "bin.dat")).equals(original),
			`content=${JSON.stringify([...fs.readFileSync(join(repo, "bin.dat"))])}`,
		);
	} finally {
		cleanupPlan(plan);
	}
}

async function testIgnoredFilesUntouched(): Promise<void> {
	const repo = track(makeRepo());
	fs.writeFileSync(join(repo, ".gitignore"), "*.log\n");
	fs.writeFileSync(join(repo, "app.log"), "ignored\n");
	const runner = makeRunner(repo);
	const repoInfo = (await resolveRepo(runner))!;
	const first = await snapshotOnce(runner, repoInfo);
	const names = git(repo, ["ls-tree", "-r", "--name-only", first.commit]);
	fs.rmSync(join(repo, "app.log"));
	const plan = await planRestore(runner, repoInfo, first.commit);
	try {
		assert(
			"ignored files are never captured or restored",
			!names.includes("app.log") && plan.patchEmpty && !fs.existsSync(join(repo, "app.log")),
			`names=${names} patchEmpty=${plan.patchEmpty} exists=${fs.existsSync(join(repo, "app.log"))}`,
		);
	} finally {
		cleanupPlan(plan);
	}
}

async function testLinkedWorktree(): Promise<void> {
	const repo = track(makeRepo());
	fs.writeFileSync(join(repo, "a.txt"), "one\n");
	git(repo, ["add", "a.txt"]);
	git(repo, ["commit", "-qm", "baseline"]);
	const worktreePath = join(tmpdir(), `pi-checkpoint-wt-${process.pid}`);
	track(worktreePath);
	git(repo, ["worktree", "add", "-q", "-b", "pi-checkpoint-test", worktreePath]);

	const wtRunner = makeRunner(worktreePath);
	const wtInfo = (await resolveRepo(wtRunner))!;
	fs.writeFileSync(join(worktreePath, "wt-only.txt"), "worktree\n");
	const snapshot = await snapshotOnce(wtRunner, wtInfo);
	const names = git(worktreePath, ["ls-tree", "-r", "--name-only", snapshot.commit]);
	const fromMain = await listCheckpointRefs(makeRunner(repo));
	assert(
		"linked worktrees snapshot via their own index into the shared refs",
		wtInfo.toplevel === fs.realpathSync(worktreePath) &&
			wtInfo.gitDir.includes("worktrees") &&
			names.includes("wt-only.txt") &&
			fromMain.some((ref) => ref.ref === snapshot.ref),
		`info=${JSON.stringify(wtInfo)} names=${names} mainRefs=${JSON.stringify(fromMain.map((ref) => ref.ref))}`,
	);
	git(repo, ["worktree", "remove", "--force", worktreePath]);
}

async function testEmptyPatchDetection(): Promise<void> {
	const repo = track(makeRepo());
	fs.writeFileSync(join(repo, "a.txt"), "one\n");
	const runner = makeRunner(repo);
	const repoInfo = (await resolveRepo(runner))!;
	const first = await snapshotOnce(runner, repoInfo);
	const plan = await planRestore(runner, repoInfo, first.commit);
	try {
		assert(
			"restore to the current state detects the empty patch",
			plan.patchEmpty && plan.safety.commit === first.commit,
			`plan=${JSON.stringify({ ...plan, patchPath: "..." })}`,
		);
	} finally {
		cleanupPlan(plan);
	}
}

class FakePi {
	commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	appended: Array<{ customType: string; data: unknown }> = [];
	notifications: string[] = [];

	registerCommand(
		name: string,
		spec: { handler: (args: string, ctx: unknown) => Promise<void> },
	): void {
		this.commands.set(name, spec);
	}
	registerTool(spec: { name: string; execute: (...args: unknown[]) => Promise<unknown> }): void {
		this.tools.set(spec.name, spec);
	}
	on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>): void {
		this.hooks.set(event, handler);
	}
	appendEntry(customType: string, data: unknown): void {
		this.appended.push({ customType, data });
	}
	async exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }) {
		try {
			const { stdout, stderr } = await execFileAsync(command, args, {
				cwd: options?.cwd,
				encoding: "utf8",
				timeout: options?.timeout ?? 60_000,
				maxBuffer: 256 * 1024 * 1024,
				env: { ...process.env },
			});
			return { stdout, stderr, code: 0, killed: false };
		} catch (error: unknown) {
			const failure = error as { code?: unknown; stdout?: string; stderr?: string };
			if (typeof failure?.code === "number") {
				return {
					stdout: failure.stdout ?? "",
					stderr: failure.stderr ?? "",
					code: failure.code,
					killed: false,
				};
			}
			throw error;
		}
	}
}

async function testExtensionWiring(): Promise<void> {
	const repo = track(makeRepo());
	fs.writeFileSync(join(repo, "a.txt"), "one\n");
	const pi = new FakePi();
	gitCheckpoint(pi as never);
	const ctx = {
		cwd: repo,
		hasUI: false,
		ui: { notify: (message: string) => pi.notifications.push(message) },
		sessionManager: {
			getEntries: () =>
				pi.appended.map((entry, index) => ({
					type: "custom",
					id: `e${index}`,
					customType: entry.customType,
					data: entry.data,
				})),
		},
	};

	await pi.hooks.get("before_agent_start")!({ prompt: "fix the login bug" }, ctx);
	const autoEntry = pi.appended[0]?.data as
		{ reason?: string; ref?: string; note?: string } | undefined;
	const autoRefExists = autoEntry?.ref
		? spawnSync("git", ["rev-parse", "--verify", autoEntry.ref], { cwd: repo }).status === 0
		: false;

	await pi.commands.get("checkpoint")!.handler("manual note", ctx);
	const manualEntry = pi.appended[1]?.data as { reason?: string; note?: string } | undefined;

	const listResult = (await pi.tools
		.get("checkpoint")!
		.execute("t1", { action: "list" }, undefined, undefined, ctx)) as {
		content: Array<{ text: string }>;
	};
	const checkpointTool = pi.tools.get("checkpoint") as any;
	const createResult = (await checkpointTool.execute(
		"t2",
		{ action: "create", note: "from tool" },
		undefined,
		undefined,
		ctx,
	)) as {
		content: Array<{ text: string }>;
		details: { created: boolean };
	};
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const collapsedCall = checkpointTool
		.renderCall({ action: "create", note: "from tool" }, theme, { expanded: false, isError: false })
		.render(80)
		.join("\n");
	const collapsedResult = checkpointTool
		.renderResult(createResult, { expanded: false, isPartial: false }, theme, {
			expanded: false,
			isError: false,
		})
		.render(80)
		.join("\n");
	const expandedCall = checkpointTool
		.renderCall({ action: "create", note: "from tool" }, theme, { expanded: true, isError: false })
		.render(80)
		.join("\n");
	const expandedResult = checkpointTool
		.renderResult(createResult, { expanded: true, isPartial: false }, theme, {
			expanded: true,
			isError: false,
		})
		.render(80)
		.join("\n");
	const errorResult = checkpointTool
		.renderResult(
			{ content: [{ type: "text", text: "Checkpoint failed" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ expanded: false, isError: true },
		)
		.render(80)
		.join("\n");

	await pi.hooks.get("session_start")!({}, ctx);

	assert(
		"extension wiring: auto snapshot, /checkpoint, and tool share one pipeline",
		pi.appended.length === 3 &&
			autoEntry?.reason === "auto" &&
			autoRefExists &&
			autoEntry?.note === "fix the login bug" &&
			manualEntry?.reason === "manual" &&
			manualEntry?.note === "manual note" &&
			listResult.content[0].text.includes("manual note") &&
			!createResult.details.created && // No changes since the manual checkpoint: dedupe.
			collapsedCall === "" &&
			collapsedResult === "" &&
			expandedCall.includes("create") &&
			expandedResult.includes("unchanged") &&
			errorResult.includes("Checkpoint failed"),
		`appended=${JSON.stringify(pi.appended)} list=${JSON.stringify(listResult)} create=${JSON.stringify(createResult)} collapsedCall=${collapsedCall} collapsedResult=${collapsedResult} expandedCall=${expandedCall} expandedResult=${expandedResult} error=${errorResult}`,
	);
}

try {
	testCheckpointViewStableNavigation();
	testCheckpointViewScrollBounds();
	testCheckpointViewEmptyAndNarrow();
	await testSnapshotCapturesEverything();
	await testSnapshotLeavesRepoUntouched();
	await testDedupe();
	await testEmptyRepository();
	await testPrune();
	await testRestore();
	await testRestorePreservesStaging();
	await testRestoreFailsClosed();
	await testBinaryRoundTrip();
	await testIgnoredFilesUntouched();
	await testLinkedWorktree();
	await testEmptyPatchDetection();
	await testExtensionWiring();
	console.log("All git-checkpoint tests passed");
} finally {
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
}

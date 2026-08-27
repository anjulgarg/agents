/** Focused tests for the /changes diff browser extension. */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function ensurePiModulePath(): void {
	if (process.env.PI_CHANGES_TEST_READY === "1") return;
	const candidates: string[] = [];
	const piBin = spawnSync("which", ["pi"], { encoding: "utf8" }).stdout?.trim();
	if (piBin) {
		try {
			candidates.push(path.resolve(path.dirname(fs.realpathSync(piBin)), ".."));
		} catch {
			// Continue with package-resolution candidates.
		}
	}
	try {
		const require = createRequire(import.meta.url);
		candidates.push(path.dirname(require.resolve("@earendil-works/pi-coding-agent/package.json")));
	} catch {
		// Continue with the global npm candidate.
	}
	const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout?.trim();
	if (npmRoot) candidates.push(path.join(npmRoot, "@earendil-works/pi-coding-agent"));
	const piRoot = candidates.find((candidate) =>
		fs.existsSync(path.join(candidate, "node_modules", "@earendil-works/pi-tui")),
	);
	if (!piRoot) throw new Error("Cannot locate @earendil-works/pi-tui");
	const nodePath = [
		path.join(piRoot, "node_modules"),
		path.dirname(path.dirname(piRoot)),
		process.env.NODE_PATH,
	]
		.filter(Boolean)
		.join(path.delimiter);
	const tsxLoader = path.resolve(process.cwd(), "node_modules/tsx/dist/loader.mjs");
	const nodeOptions = [
		process.env.NODE_OPTIONS,
		fs.existsSync(tsxLoader) ? `--import=${pathToFileURL(tsxLoader).href}` : undefined,
	]
		.filter(Boolean)
		.join(" ");
	const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
		stdio: "inherit",
		env: {
			...process.env,
			NODE_PATH: nodePath,
			...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
			PI_CHANGES_TEST_READY: "1",
		},
	});
	process.exit(result.status ?? 1);
}

ensurePiModulePath();

const { visibleWidth } = await import("@earendil-works/pi-tui");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();

const {
	ChangesView,
	buildFileDiffArgs,
	collectChangesSnapshot,
	fingerprintPathBatch,
	formatFileDiff,
	mergeChangedFiles,
	parseNameStatusZ,
	parsePorcelainStatusZ,
	parseUnifiedDiff,
	fetchFileDiff,
	default: changesExtension,
} = await import("../changes.ts");

type ChangeScope = import("../changes.ts").ChangeScope;
type ChangeKind = import("../changes.ts").ChangeKind;
type GitChange = import("../changes.ts").GitChange;
type ChangedFile = import("../changes.ts").ChangedFile;
type ChangesDisplay = import("../changes.ts").ChangesDisplay;
type GitExec = import("../changes.ts").GitExec;
type FileDiff = import("../changes.ts").FileDiff;
type AnyRecord = Record<string, any>;

function inspect(value: unknown): string {
	try {
		return JSON.stringify(value, (_key, nested) =>
			nested instanceof Set ? [...nested] : nested instanceof Map ? [...nested.entries()] : nested,
		);
	} catch {
		return String(value);
	}
}

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function changedFile(
	pathName: string,
	kind: ChangeKind,
	scopes: readonly ChangeScope[] = ["uncommitted"],
	overrides: Partial<ChangedFile> = {},
): ChangedFile {
	return {
		path: pathName,
		status: kind === "untracked" ? "??" : kind,
		kind,
		scopes: [...scopes],
		isSubmodule: false,
		...overrides,
	};
}

function fileByPath<T extends { path: string }>(
	files: readonly T[],
	pathName: string,
): T | undefined {
	return files.find((file) => file.path === pathName);
}

function testPorcelainStatusParsing(): void {
	const input = [
		"M  staged/modified.ts",
		" M work/modified.ts",
		"A  added/with spaces.txt",
		" D deleted/old name.txt",
		"UU conflict/unmerged.ts",
		"R  renamed/new [v2].md",
		"renamed/old [v1].md",
		"?? scratch/untracked [x].txt",
		"",
	].join("\0");
	const parsed = parsePorcelainStatusZ(input);
	const renamed = fileByPath(parsed, "renamed/new [v2].md");
	assert(
		"porcelain -z parses all supported status records",
		parsed.length === 7 &&
			fileByPath(parsed, "staged/modified.ts")?.kind === "modified" &&
			fileByPath(parsed, "work/modified.ts")?.status === " M" &&
			fileByPath(parsed, "added/with spaces.txt")?.kind === "added" &&
			fileByPath(parsed, "deleted/old name.txt")?.kind === "deleted" &&
			fileByPath(parsed, "conflict/unmerged.ts")?.kind === "unmerged" &&
			fileByPath(parsed, "scratch/untracked [x].txt")?.kind === "untracked",
		inspect(parsed),
	);
	assert(
		"porcelain -z preserves unusual rename paths",
		renamed?.path === "renamed/new [v2].md" && renamed.oldPath === "renamed/old [v1].md",
		inspect(renamed),
	);
	let malformed: GitChange[] = [];
	let threw = false;
	try {
		malformed = parsePorcelainStatusZ(
			"M\0R  rename-without-old-path\0\0Z  unknown-status\0M  valid-after-malformed.ts\0",
		);
	} catch {
		threw = true;
	}
	assert(
		"malformed porcelain records are tolerated",
		!threw && fileByPath(malformed, "valid-after-malformed.ts") !== undefined,
		inspect({ threw, malformed }),
	);
}

function testNameStatusAndMerge(): void {
	const parsed = parseNameStatusZ(
		["M", "outgoing/modified.ts", "A", "outgoing/new file.ts", "R100", "old.ts", "new.ts", ""].join(
			"\0",
		),
	);
	const renamed = fileByPath(parsed, "new.ts");
	assert(
		"name-status -z parses modified, added, and scored rename records",
		parsed.length === 3 &&
			fileByPath(parsed, "outgoing/modified.ts")?.kind === "modified" &&
			fileByPath(parsed, "outgoing/new file.ts")?.kind === "added" &&
			renamed?.kind === "renamed" &&
			renamed.oldPath === "old.ts" &&
			renamed.scope === "unpushed",
		inspect(parsed),
	);
	const merged = mergeChangedFiles(
		parsePorcelainStatusZ("M  shared.ts\0R  new-name.ts\0old-name.ts\0\0"),
		parseNameStatusZ("M\0shared.ts\0R100\0old-name.ts\0new-name.ts\0\0"),
	);
	const shared = fileByPath(merged, "shared.ts");
	const rename = fileByPath(merged, "new-name.ts");
	assert(
		"mergeChangedFiles combines scopes and rename identity",
		shared?.scopes.join(",") === "uncommitted,unpushed" &&
			rename?.oldPath === "old-name.ts" &&
			rename.scopes.join(",") === "uncommitted,unpushed",
		inspect(merged),
	);
	const renameChain = mergeChangedFiles(
		parsePorcelainStatusZ("R  C.ts\0B.ts\0\0"),
		parseNameStatusZ("R100\0A.ts\0B.ts\0\0"),
	);
	const chained = fileByPath(renameChain, "C.ts");
	assert(
		"mergeChangedFiles preserves the earliest source in a rename chain",
		chained?.oldPath === "A.ts" && chained.scopes.join(",") === "uncommitted,unpushed",
		inspect(renameChain),
	);
}

const unifiedFixture = [
	"diff --git a/src/example.ts b/src/example.ts",
	"index 1111111..2222222 100644",
	"--- a/src/example.ts",
	"+++ b/src/example.ts",
	"@@ -2,4 +2,4 @@ export function example() {",
	"   const before = true;",
	"-  return before;",
	"+  return !before;",
	" }",
	"@@ -20,2 +20,3 @@ export function example() {",
	"   end();",
	'+  log("done");',
	" }",
].join("\n");

function testDiffParsing(): void {
	const parsed = parseUnifiedDiff(unifiedFixture);
	assert(
		"unified diff parser emits line-numbered context, removed, and added lines",
		parsed.binary === false &&
			parsed.empty === false &&
			parsed.lines.includes(" 2   const before = true;") &&
			parsed.lines.includes("-3   return before;") &&
			parsed.lines.includes("+3   return !before;") &&
			parsed.lines.includes('+21   log("done");') &&
			parsed.lines.includes("⋯"),
		inspect(parsed),
	);
	const formatted = formatFileDiff(unifiedFixture);
	assert(
		"formatted text diff uses pastel red and green while preserving visible content",
		formatted.kind === "text" &&
			formatted.lines.length >= 6 &&
			formatted.lines.some((line) => line.includes("\x1b[38;2;242;139;130m")) &&
			formatted.lines.some((line) => line.includes("\x1b[38;2;129;201;149m")) &&
			formatted.lines.some((line) => stripAnsi(line).includes("return !before")),
		inspect(formatted),
	);
	const binary = formatFileDiff(
		"diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n",
	);
	const noNewline = formatFileDiff(
		"@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
	);
	assert(
		"binary and no-newline diffs produce safe notes",
		binary.kind === "binary" &&
			binary.note === "Binary file changed." &&
			noNewline.kind === "text" &&
			noNewline.note?.includes("No newline at end of file.") === true,
		inspect({ binary, noNewline }),
	);
	const submodule = formatFileDiff("", { isSubmodule: true });
	assert(
		"submodule diffs use a readable placeholder",
		submodule.kind === "submodule" && Boolean(submodule.note),
		inspect(submodule),
	);
}

function testDiffArgs(): void {
	const untracked = buildFileDiffArgs(changedFile("scratch/new.txt", "untracked"), undefined, 3);
	const unpushed = buildFileDiffArgs(
		changedFile("src/mixed.ts", "modified", ["uncommitted", "unpushed"]),
		"origin/main",
		3,
	);
	const local = buildFileDiffArgs(changedFile("src/local.ts", "modified"), undefined, 100000);
	assert(
		"diff args use no-index for untracked files",
		untracked.args.includes("--no-index") &&
			untracked.args.includes("/dev/null") &&
			untracked.args.at(-1) === "scratch/new.txt" &&
			untracked.expectedExitCodes.join(",") === "0,1",
		inspect(untracked),
	);
	assert(
		"diff args use upstream for mixed unpushed and working changes",
		unpushed.args.includes("origin/main") &&
			!unpushed.args.includes("origin/main...HEAD") &&
			unpushed.args.includes("-U3") &&
			unpushed.args.at(-1) === "src/mixed.ts",
		inspect(unpushed),
	);
	assert(
		"diff args use HEAD and full-file context for local changes",
		local.args.includes("HEAD") && local.args.includes("-U100000"),
		inspect(local),
	);
}

async function testFetchFileDiff(): Promise<void> {
	const calls: Array<{ command: string; args: string[] }> = [];
	const executor: GitExec = async (command, args) => {
		calls.push({ command, args: [...args] });
		if (args.includes("merge-base")) return { code: 0, stdout: "base-sha\n", stderr: "" };
		if (args.includes("--verify")) return { code: 0, stdout: "head-sha\n", stderr: "" };
		if (args.includes("hash-object")) return { code: 0, stdout: "empty-tree\n", stderr: "" };
		if (args.includes("binary.bin")) {
			return {
				code: 1,
				stdout: "Binary files a/binary.bin and b/binary.bin differ\\n",
				stderr: "",
			};
		}
		if (args.includes("error.ts")) return { code: 128, stdout: "", stderr: "fatal: unavailable" };
		if (args.includes("large.ts")) return { code: 0, stdout: "x".repeat(2_000_001), stderr: "" };
		return { code: 1, stdout: unifiedFixture, stderr: "" };
	};
	const normal = await fetchFileDiff(
		executor,
		"/offline/repository",
		changedFile("src/example.ts", "modified"),
		"collapsed",
		{ upstream: undefined },
	);
	const mixed = await fetchFileDiff(
		executor,
		"/offline/repository",
		changedFile("src/mixed.ts", "modified", ["unpushed"]),
		"collapsed",
		{ upstream: "origin/main" },
	);
	const unbornCalls: string[][] = [];
	const unborn = await fetchFileDiff(
		async (_command, args) => {
			unbornCalls.push([...args]);
			if (args.includes("--verify")) return { code: 1, stdout: "", stderr: "" };
			if (args.includes("hash-object")) return { code: 0, stdout: "empty-tree\n", stderr: "" };
			return { code: 1, stdout: unifiedFixture, stderr: "" };
		},
		"/offline/repository",
		changedFile("first.ts", "added"),
		"collapsed",
		{ upstream: undefined },
	);
	const binary = await fetchFileDiff(
		executor,
		"/offline/repository",
		changedFile("binary.bin", "modified"),
		"collapsed",
		{ upstream: undefined },
	);
	const error = await fetchFileDiff(
		executor,
		"/offline/repository",
		changedFile("error.ts", "modified"),
		"collapsed",
		{ upstream: undefined },
	);
	const large = await fetchFileDiff(
		executor,
		"/offline/repository",
		changedFile("large.ts", "modified"),
		"full",
		{ upstream: undefined },
	);
	const submodule = await fetchFileDiff(
		executor,
		"/offline/repository",
		changedFile("submodule", "submodule", [], { isSubmodule: true }),
		"collapsed",
		{ upstream: undefined },
	);
	assert(
		"fetchFileDiff handles normal, binary, error, oversized, and submodule files",
		normal.kind === "text" &&
			mixed.kind === "text" &&
			calls.some((call) => call.args.includes("base-sha")) &&
			unborn.kind === "text" &&
			unbornCalls.some((args) => args.includes("hash-object")) &&
			binary.kind === "binary" &&
			error.kind === "unavailable" &&
			error.note?.includes("unavailable") === true &&
			large.note?.includes("Diff output truncated.") === true &&
			submodule.kind === "submodule" &&
			calls.filter((call) => call.args.includes("submodule")).length === 0,
		inspect({ normal, mixed, unborn, binary, error, large, submodule, calls: calls.length }),
	);
}

async function testSnapshot(): Promise<void> {
	const calls: Array<{ command: string; args: string[] }> = [];
	let contentHash = "blob-a";
	const executor: GitExec = async (command, args) => {
		const copied = [...args];
		calls.push({ command, args: copied });
		if (copied.includes("status")) return { code: 0, stdout: "M  tracked.ts\0", stderr: "" };
		if (copied.includes("ls-files")) return { code: 0, stdout: "", stderr: "" };
		if (copied.includes("hash-object")) return { code: 0, stdout: contentHash, stderr: "" };
		if (copied.includes("@{upstream}")) return { code: 0, stdout: "origin/main\n", stderr: "" };
		if (copied.includes("--name-status")) {
			return copied.includes("origin/main...HEAD")
				? { code: 0, stdout: "M\0outgoing.ts\0", stderr: "" }
				: { code: 0, stdout: "", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const snapshot = await collectChangesSnapshot(executor, "/offline/repository");
	assert(
		"snapshot remains Git-only and uses the three-dot unpushed inventory",
		snapshot.files.length === 2 &&
			snapshot.files.every((file) => file.path !== "") &&
			snapshot.upstream === "origin/main" &&
			!Object.prototype.hasOwnProperty.call(snapshot, "evidence") &&
			calls.some((call) => call.args.includes("origin/main...HEAD")),
		inspect({ snapshot, calls }),
	);
	contentHash = "blob-b";
	const changedContent = await collectChangesSnapshot(executor, "/offline/repository");
	assert(
		"snapshot fingerprint changes when working content changes under the same status",
		changedContent.fingerprint !== snapshot.fingerprint,
		inspect({ before: snapshot.fingerprint, after: changedContent.fingerprint }),
	);
}

function displayFor(files: readonly ChangedFile[], unpushedAvailable = true): ChangesDisplay {
	return {
		snapshot: {
			root: "/offline/repository",
			files: [...files],
			fingerprint: "test-fingerprint",
			...(unpushedAvailable ? { upstream: "origin/main" } : {}),
			unpushedAvailable,
		},
		stale: false,
	};
}

async function testFingerprintBatching(): Promise<void> {
	const calls: string[][] = [];
	const executor: GitExec = async (_command, args) => {
		calls.push([...args]);
		return { code: 0, stdout: `${args.filter((a) => a.startsWith("src/")).length}\n`, stderr: "" };
	};
	const paths = Array.from({ length: 4000 }, (_, index) => `src/generated-file-number-${index}.ts`);
	const hashes = await fingerprintPathBatch(executor, paths, { cwd: "/offline", timeout: 1000 });
	assert(
		"large path sets are hashed in bounded batches across multiple Git calls",
		calls.length > 1 &&
			hashes.length === calls.length &&
			calls.every((args) => args.includes("hash-object")) &&
			calls.reduce((sum, args) => sum + args.filter((a) => a.startsWith("src/")).length, 0) ===
				paths.length,
		inspect({ calls: calls.length, hashes: hashes.length }),
	);
	assert(
		"a tiny path set uses exactly one hash call",
		(await fingerprintPathBatch(executor, ["one.ts"], { cwd: "/offline", timeout: 1000 }))
			.length === 1,
		inspect(calls.at(-1)),
	);
}

async function testStaleView(): Promise<void> {
	const loader = controlledLoader();
	let fetchCalls = 0;
	const view = new ChangesView(
		{ terminal: { rows: 12 }, requestRender: () => undefined } as any,
		{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as any,
		{
			root: "/offline/repository",
			load: loader.load,
			fetchDiff: async () => {
				fetchCalls++;
				return { kind: "empty", lines: [] };
			},
			done: () => undefined,
		},
	);
	loader.pending[0]!.resolve({ ...displayFor([changedFile("stale.ts", "modified")]), stale: true });
	await flush();
	const rendered = view.render(60).join("\\n");
	assert(
		"stale snapshots do not fetch mixed-version diffs",
		fetchCalls === 0 && rendered.includes("Snapshot changed while loading"),
		rendered,
	);
	view.dispose();

	const verifiedLoader = controlledLoader();
	const verifiedView = new ChangesView(
		{ terminal: { rows: 12 }, requestRender: () => undefined } as any,
		{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as any,
		{
			root: "/offline/repository",
			load: verifiedLoader.load,
			fetchDiff: async () => ({ kind: "empty", lines: [] }),
			isSnapshotCurrent: async () => false,
			done: () => undefined,
		},
	);
	verifiedLoader.pending[0]!.resolve(displayFor([changedFile("changed.ts", "modified")]));
	for (let index = 0; index < 3; index++) await flush();
	const verifiedRendered = verifiedView.render(60).join("\\n");
	assert(
		"late diff validation marks a view stale before caching it",
		verifiedRendered.includes("Snapshot changed while loading"),
		verifiedRendered,
	);
	verifiedView.dispose();
}

function diffFor(pathName: string): FileDiff {
	const marker = pathName.replace(/[^a-z0-9]/gi, "_");
	const body = Array.from({ length: 30 }, (_, index) => {
		if (index === 2) return "-old value";
		if (index === 3) return `+new value for ${marker}`;
		return ` line ${index + 1}`;
	});
	return formatFileDiff(
		[
			`diff --git a/${pathName} b/${pathName}`,
			"--- a/file",
			"+++ b/file",
			"@@ -1,29 +1,29 @@",
			...body,
		].join("\n"),
	);
}

function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

interface PendingLoad {
	resolve: (display: ChangesDisplay) => void;
	reject: (error: unknown) => void;
}

function controlledLoader(): {
	load: (signal: AbortSignal) => Promise<ChangesDisplay>;
	pending: PendingLoad[];
} {
	const pending: PendingLoad[] = [];
	return {
		load: async (_signal) =>
			new Promise<ChangesDisplay>((resolve, reject) => pending.push({ resolve, reject })),
		pending,
	};
}

async function testChangesView(): Promise<void> {
	const files = Array.from({ length: 18 }, (_, index) =>
		changedFile(`src/file-${index}.ts`, index % 3 === 1 ? "added" : "modified"),
	);
	const display = displayFor(files);
	const loader = controlledLoader();
	const fetchCalls: Array<{ path: string; mode: string }> = [];
	const renderRequests: number[] = [];
	let doneResult: string | undefined;
	const view = new ChangesView(
		{ terminal: { rows: 20 }, requestRender: () => renderRequests.push(1) } as any,
		{
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			bg: (_color: string, text: string) => `\x1b[7m${text}\x1b[27m`,
		} as any,
		{
			root: "/offline/repository",
			load: loader.load,
			fetchDiff: async (file, mode) => {
				fetchCalls.push({ path: file.path, mode });
				return diffFor(file.path);
			},
			done: (result) => {
				doneResult = result;
			},
		},
	);
	const width = 60;
	const loading = view.render(width);
	assert(
		"ChangesView renders exact-size loading chrome",
		loading.length === 20 && loading.every((line) => visibleWidth(line) === width),
		inspect(loading),
	);
	assert(
		"ChangesView starts one inventory load",
		loader.pending.length === 1,
		inspect(loader.pending),
	);
	loader.pending[0]!.resolve(display);
	await flush();
	await flush();
	const initial = view.render(width);
	const initialText = initial.join("\n");
	assert(
		"ChangesView auto-selects the first file and renders its diff",
		initial.length === 20 &&
			initial.every((line) => visibleWidth(line) === width) &&
			initialText.includes("src/file-0.ts") &&
			initialText.includes("new value for src_file_0_ts") &&
			fetchCalls.some((call) => call.path === "src/file-0.ts" && call.mode === "collapsed"),
		inspect({ initial, fetchCalls }),
	);
	const plainInitial = initial.map(stripAnsi);
	assert(
		"changes header uses balanced tab spacing, concise counts, and aligned metadata",
		plainInitial[0]!.trimStart().startsWith("Changes") &&
			plainInitial[0]!.trimEnd().endsWith("18 files · Working 18") &&
			plainInitial[0]!.indexOf("18 files") > 20 &&
			plainInitial[1]!.trim() === "" &&
			plainInitial[2]!.includes("~ file-0.ts") &&
			plainInitial[2]!.includes("+ file-1.ts") &&
			!plainInitial[2]!.includes("src/") &&
			plainInitial[3]!.trim() === "" &&
			plainInitial[4]!.trimStart().startsWith("src/file-0.ts") &&
			plainInitial[4]!.trimEnd().endsWith("M · Context 3") &&
			!plainInitial.slice(0, 5).join("\n").includes("Ahead 0") &&
			!plainInitial.slice(0, 5).join("\n").includes("uncommitted"),
		inspect(plainInitial.slice(0, 6)),
	);
	assert(
		"selected basename tab and its change icon are visibly distinguished",
		initialText.includes("\x1b[7m ~ file-0.ts \x1b[27m"),
		initialText,
	);

	view.handleInput("\x1b[C");
	await flush();
	const second = view.render(width).join("\n");
	assert(
		"Right switches to the next file and resets the diff viewport",
		second.includes("src/file-1.ts") && second.includes("new value for src_file_1_ts"),
		second,
	);
	view.handleInput("\t");
	await flush();
	assert(
		"Tab switches files",
		view.render(width).join("\n").includes("src/file-2.ts"),
		view.render(width).join("\n"),
	);
	view.handleInput("\x1b[Z");
	await flush();
	assert(
		"Shift+Tab switches backward",
		view.render(width).join("\n").includes("src/file-1.ts"),
		view.render(width).join("\n"),
	);
	view.handleInput("\x1b[D");
	await flush();
	assert(
		"Left wraps from the first file to the last",
		view.render(width).join("\n").includes("src/file-0.ts"),
		view.render(width).join("\n"),
	);
	view.handleInput("\x1b[D");
	await flush();
	assert(
		"tab overflow keeps the selected file visible",
		view.render(width).join("\n").includes("src/file-17.ts"),
		view.render(width).join("\n"),
	);

	view.handleInput("\x1b[6~");
	const pageDown = view.render(width).join("\n");
	view.handleInput("\x1b[F");
	const end = view.render(width).join("\n");
	view.handleInput("\x1b[H");
	const home = view.render(width).join("\n");
	view.handleInput("\x1b[B");
	const down = view.render(width).join("\n");
	view.handleInput("\x1b[A");
	const up = view.render(width).join("\n");
	assert(
		"diff body supports arrows, page keys, Home, and End",
		pageDown !== home && end !== home && down !== home && up === home,
		inspect({ pageDown, end, home, down, up }),
	);

	view.handleInput("\x0f");
	await flush();
	const fullCall = fetchCalls.find(
		(call) => call.path === "src/file-17.ts" && call.mode === "full",
	);
	assert("Ctrl+O fetches the selected file in full mode", Boolean(fullCall), inspect(fetchCalls));
	view.handleInput("\x0f");
	await flush();
	assert(
		"Ctrl+O toggles back without a second collapsed fetch",
		fetchCalls.filter((call) => call.path === "src/file-17.ts" && call.mode === "collapsed")
			.length === 1,
		inspect(fetchCalls),
	);
	view.handleInput("\x0f");
	await flush();
	assert(
		"full-file mode reuses its cached fetch",
		fetchCalls.filter((call) => call.path === "src/file-17.ts" && call.mode === "full").length ===
			1,
		inspect(fetchCalls),
	);
	view.handleInput("E");
	assert(
		"E closes with the selected file path",
		doneResult === "src/file-17.ts",
		String(doneResult),
	);
	view.handleInput("\x1b");
	assert("closing twice is inert", doneResult === "src/file-17.ts", String(doneResult));
	view.dispose();

	const shortLoader = controlledLoader();
	const shortView = new ChangesView(
		{ terminal: { rows: 3 }, requestRender: () => undefined } as any,
		{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as any,
		{
			root: "/offline/repository",
			load: shortLoader.load,
			fetchDiff: async (file) => diffFor(file.path),
			done: () => undefined,
		},
	);
	shortLoader.pending[0]!.resolve(displayFor([files[0]!]));
	for (let index = 0; index < 3; index++) await flush();
	const short = shortView.render(width).join("\\n");
	assert(
		"short terminals retain a visible diff row",
		shortView.render(width).length === 3 && short.includes("line 1"),
		short,
	);
	shortView.dispose();

	const wrappedMarker = "WRAPMARKERABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	const wrapLoader = controlledLoader();
	const wrapView = new ChangesView(
		{ terminal: { rows: 20 }, requestRender: () => undefined } as any,
		{
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			bg: (_color: string, text: string) => `\x1b[7m${text}\x1b[27m`,
		} as any,
		{
			root: "/offline/repository",
			load: wrapLoader.load,
			fetchDiff: async () => formatFileDiff(`@@ -0,0 +1 @@\n+${wrappedMarker}\n`),
			done: () => undefined,
		},
	);
	wrapLoader.pending[0]!.resolve(displayFor([changedFile("wrapped.ts", "modified")]));
	for (let index = 0; index < 3; index++) await flush();
	const wrapped = wrapView.render(24);
	const joinedWrappedText = stripAnsi(wrapped.join("\n")).replace(/\s/g, "");
	const wrappedDiffRows = wrapped.filter((line) => line.includes("\x1b[38;2;129;201;149m"));
	const continuationRows = wrappedDiffRows.slice(1).map(stripAnsi);
	assert(
		"overlong diff lines use a hanging indent without losing content",
		wrapped.length === 20 &&
			wrapped.every((line) => visibleWidth(line) === 24) &&
			joinedWrappedText.includes(wrappedMarker) &&
			wrappedDiffRows.length > 1 &&
			continuationRows.every((line) => /^ {4}\S/.test(line)),
		inspect({ wrapped, continuationRows }),
	);
	wrapView.dispose();

	const iconFiles = [
		changedFile("modified.ts", "modified"),
		changedFile("added.ts", "added"),
		changedFile("deleted.ts", "deleted"),
		changedFile("renamed.ts", "renamed"),
		changedFile("copied.ts", "copied"),
		changedFile("untracked.ts", "untracked"),
		changedFile("typechange.ts", "typechange"),
		changedFile("unmerged.ts", "unmerged"),
		changedFile("module", "submodule", ["uncommitted"], { isSubmodule: true }),
	];
	const iconLoader = controlledLoader();
	const iconView = new ChangesView(
		{ terminal: { rows: 14 }, requestRender: () => undefined } as any,
		{
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			bg: (_color: string, text: string) => `\x1b[7m${text}\x1b[27m`,
		} as any,
		{
			root: "/offline/repository",
			load: iconLoader.load,
			fetchDiff: async () => ({ kind: "text", lines: [" 1 content"] }),
			done: () => undefined,
		},
	);
	iconLoader.pending[0]!.resolve(displayFor(iconFiles));
	for (let index = 0; index < 3; index++) await flush();
	const iconTabs = stripAnsi(iconView.render(140)[2] ?? "");
	assert(
		"every file tab shows a consistently spaced semantic change icon",
		[
			"~ modified.ts",
			"+ added.ts",
			"− deleted.ts",
			"→ renamed.ts",
			"⧉ copied.ts",
			"? untracked.ts",
			"↕ typechange.ts",
			"! unmerged.ts",
			"◆ module",
		].every((label) => iconTabs.includes(label)),
		iconTabs,
	);
	iconView.dispose();

	const emptyLoader = controlledLoader();
	let emptyDone = 0;
	const emptyView = new ChangesView(
		{ terminal: { rows: 10 }, requestRender: () => undefined } as any,
		{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as any,
		{
			root: "/offline/repository",
			load: emptyLoader.load,
			fetchDiff: async () => ({ kind: "empty", lines: [], note: "No diff" }),
			done: () => emptyDone++,
		},
	);
	emptyLoader.pending[0]!.resolve(displayFor([], false));
	await flush();
	const empty = emptyView.render(width).join("\n");
	assert(
		"empty ChangesView retains the concise empty state",
		(empty.match(/No current Git changes\./g) ?? []).length === 1 && /No upstream/.test(empty),
		empty,
	);
	emptyView.handleInput("\x1b");
	assert("empty ChangesView Escape closes", emptyDone === 1, String(emptyDone));
	emptyView.dispose();
}

async function testCommandHarness(): Promise<void> {
	const commands = new Map<string, AnyRecord>();
	const shortcuts = new Map<string, AnyRecord>();
	const notifications: Array<{ message: string; type?: string }> = [];
	let execCalls = 0;
	const pi: AnyRecord = {
		registerCommand: (name: string, command: AnyRecord) => commands.set(name, command),
		registerShortcut: (shortcut: string, options: AnyRecord) => shortcuts.set(shortcut, options),
		exec: async (_command: string, _args: readonly string[]) => {
			execCalls++;
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	changesExtension(pi);
	const command = commands.get("changes");
	assert(
		"registers /changes",
		Boolean(command) && typeof command.handler === "function",
		inspect([...commands.keys()]),
	);
	if (!command) return;
	const f5 = shortcuts.get("f5");
	assert(
		"registers F5 to open the changes view",
		f5?.description === "Open the changes view" && typeof f5.handler === "function",
		inspect(f5),
	);
	await command.handler("", {
		mode: "rpc",
		cwd: "/offline/not-a-real-repository",
		ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
	});
	assert(
		"non-TUI invocation is rejected before Git",
		notifications.some(({ message, type }) => type === "error" && message.includes("/changes")) &&
			execCalls === 0,
		inspect({ notifications, execCalls }),
	);

	let customCalls = 0;
	let closed = 0;
	let editorText = "";
	let pasted = "";
	let set = "";
	const tuiPi: AnyRecord = {
		...pi,
		exec: async (_command: string, args: readonly string[]) => {
			execCalls++;
			const copied = [...args];
			if (copied.includes("--show-toplevel"))
				return { code: 0, stdout: "/offline/repository\n", stderr: "" };
			if (copied.includes("status")) return { code: 0, stdout: "", stderr: "" };
			if (copied.includes("ls-files")) return { code: 0, stdout: "", stderr: "" };
			if (copied.includes("@{upstream}")) return { code: 0, stdout: "", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	tuiPi.registerCommand = pi.registerCommand;
	changesExtension(tuiPi);
	const tuiCommand = [...commands.values()].at(-1)!;
	await tuiCommand.handler("", {
		mode: "tui",
		cwd: "/offline/current",
		waitForIdle: async () => undefined,
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				set = text;
				editorText = text;
			},
			pasteToEditor: (text: string) => {
				pasted = text;
				editorText += text;
			},
			custom: async (factory: AnyRecord, _options: AnyRecord) => {
				customCalls++;
				const component = factory(
					{ terminal: { rows: 8 }, requestRender: () => undefined },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					undefined,
					(result: string | undefined) => {
						closed++;
						if (result) editorText = result;
					},
				);
				const lines = component.render(40);
				assert(
					"command creates an exact-bounds loading view",
					lines.length === 8 && lines.every((line: string) => visibleWidth(line) === 40),
					inspect(lines),
				);
				component.handleInput("\x1b");
				component.dispose?.();
			},
		},
	});
	assert(
		"/changes opens fullscreen custom UI and Escape closes it",
		customCalls === 1 && closed === 1 && execCalls > 0,
		inspect({ customCalls, closed, execCalls }),
	);
	assert(
		"command exposes editor population hooks",
		typeof set === "string" && typeof pasted === "string",
		inspect({ set, pasted }),
	);
}

async function testCommandEditHandoff(): Promise<void> {
	const commands = new Map<string, AnyRecord>();
	const pi: AnyRecord = {
		registerCommand: (name: string, command: AnyRecord) => commands.set(name, command),
		registerShortcut: () => undefined,
		exec: async (_command: string, args: readonly string[]) => {
			const copied = [...args];
			if (copied.includes("--show-toplevel"))
				return { code: 0, stdout: "/offline/repository\n", stderr: "" };
			if (copied.includes("status")) return { code: 0, stdout: "M  src/edit.ts\0", stderr: "" };
			if (copied.includes("ls-files")) return { code: 0, stdout: "", stderr: "" };
			if (copied.includes("@{upstream}")) return { code: 1, stdout: "", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	changesExtension(pi);
	const command = commands.get("changes");
	if (!command) throw new Error("changes command was not registered");
	let editorText = "";
	const pastedTexts: string[] = [];
	const redrawRequests: Array<{ key: string; text: string | undefined }> = [];
	let customResult: string | undefined;
	const run = async (): Promise<void> => {
		customResult = undefined;
		await command.handler("", {
			mode: "tui",
			cwd: "/offline/current",
			waitForIdle: async () => undefined,
			ui: {
				getEditorText: () => editorText,
				setEditorText: (text: string) => {
					editorText = text;
				},
				pasteToEditor: (text: string) => {
					pastedTexts.push(text);
					editorText += text;
				},
				setStatus: (key: string, text: string | undefined) => {
					redrawRequests.push({ key, text });
				},
				custom: async (factory: AnyRecord) => {
					const component = factory(
						{ terminal: { rows: 12 }, requestRender: () => undefined },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						undefined,
						(result: string | undefined) => {
							customResult = result;
						},
					);
					for (let index = 0; index < 8; index++) await flush();
					component.handleInput("E");
					component.dispose?.();
					return customResult;
				},
			},
		});
	};
	await run();
	const first = editorText;
	editorText = "Please fix ";
	await run();
	assert(
		"E redraws the exact selected path immediately and preserves a draft",
		first === "src/edit.ts" &&
			pastedTexts.length === 2 &&
			pastedTexts.every((text) => text === "src/edit.ts") &&
			redrawRequests.length === 2 &&
			redrawRequests.every(
				(request) => request.key === "changes:editor-handoff" && request.text === undefined,
			) &&
			editorText === "Please fix src/edit.ts",
		inspect({ first, pastedTexts, redrawRequests, editorText }),
	);
}

testPorcelainStatusParsing();
testNameStatusAndMerge();
testDiffParsing();
testDiffArgs();
await testFetchFileDiff();
await testSnapshot();
await testFingerprintBatching();
await testStaleView();
await testChangesView();
await testCommandHarness();
await testCommandEditHandoff();
console.log("All changes extension tests passed.");

/**
 * Focused tests for the /changes extension.
 *
 * Run: npm run test:extensions
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Match the bootstrap used by the existing Pi/TUI extension tests. */
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
const {
	ChangesView,
	buildDeterministicSummary,
	collectChangesSnapshot,
	mergeChangedFiles,
	parseGeneratedSummary,
	parseNameStatusZ,
	parsePorcelainStatusZ,
	resolvePreferredUtilityModel,
	default: changesExtension,
} = await import("../changes.ts");

type ChangeScope = import("../changes.ts").ChangeScope;
type ChangeKind = import("../changes.ts").ChangeKind;
type GitChange = import("../changes.ts").GitChange;
type ChangedFile = import("../changes.ts").ChangedFile;
type ChangesDisplay = import("../changes.ts").ChangesDisplay;
type GitExec = import("../changes.ts").GitExec;

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

function changedFile(
	pathName: string,
	kind: ChangeKind,
	scopes: readonly ChangeScope[] = ["uncommitted"],
	overrides: Partial<ChangedFile> = {},
): ChangedFile {
	return {
		path: pathName,
		status: kind,
		kind,
		scopes: [...scopes],
		isSubmodule: false,
		isBinary: false,
		isGenerated: false,
		isLockfile: false,
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
	const staged = fileByPath(parsed, "staged/modified.ts");
	const unstaged = fileByPath(parsed, "work/modified.ts");
	const added = fileByPath(parsed, "added/with spaces.txt");
	const deleted = fileByPath(parsed, "deleted/old name.txt");
	const unmerged = fileByPath(parsed, "conflict/unmerged.ts");
	const renamed = fileByPath(parsed, "renamed/new [v2].md");
	const untracked = fileByPath(parsed, "scratch/untracked [x].txt");
	assert(
		"porcelain -z parses staged, unstaged, added, deleted, unmerged, renamed, and untracked records",
		parsed.length === 7 &&
			staged?.status === "M " &&
			staged.kind === "modified" &&
			staged.scope === "uncommitted" &&
			unstaged?.status === " M" &&
			unstaged.kind === "modified" &&
			added?.kind === "added" &&
			deleted?.kind === "deleted" &&
			unmerged?.kind === "unmerged" &&
			renamed?.kind === "renamed" &&
			untracked?.kind === "untracked",
		inspect(parsed),
	);
	assert(
		"porcelain -z preserves spaced and unusual rename paths exactly",
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
		"malformed porcelain records are tolerated without losing later valid records",
		!threw &&
			fileByPath(malformed, "valid-after-malformed.ts") !== undefined &&
			malformed.every((file) => file.path.length > 0),
		inspect({ threw, malformed }),
	);
}

function testNameStatusParsing(): void {
	const input = [
		"M",
		"outgoing/modified.ts",
		"A",
		"outgoing/new file.ts",
		"D",
		"outgoing/deleted.bin",
		"R100",
		"outgoing/renamed [old].ts",
		"outgoing/renamed [new].ts",
		"M",
		"outgoing/binary.bin",
		"",
	].join("\0");
	const parsed = parseNameStatusZ(input);
	const renamed = fileByPath(parsed, "outgoing/renamed [new].ts");
	const binary = fileByPath(parsed, "outgoing/binary.bin");
	assert(
		"name-status -z parses modified, added, deleted, and scored rename records",
		parsed.length === 5 &&
			fileByPath(parsed, "outgoing/modified.ts")?.kind === "modified" &&
			fileByPath(parsed, "outgoing/new file.ts")?.kind === "added" &&
			fileByPath(parsed, "outgoing/deleted.bin")?.kind === "deleted" &&
			renamed?.kind === "renamed" &&
			renamed.scope === "unpushed",
		inspect(parsed),
	);
	assert(
		"name-status -z maps rename old and new paths without path sanitization",
		renamed?.path === "outgoing/renamed [new].ts" &&
			renamed.oldPath === "outgoing/renamed [old].ts",
		inspect(renamed),
	);
	assert(
		"name-status preserves modified status metadata for binary-relevant paths",
		binary?.status === "M" && binary.kind === "modified" && binary.scope === "unpushed",
		inspect(binary),
	);
}

function testMergeChangedFiles(): void {
	const uncommitted = parsePorcelainStatusZ(
		[
			"M  shared/both-scopes.ts",
			"?? only/local.txt",
			"R  renamed/new.ts",
			"renamed/old.ts",
			"",
		].join("\0"),
	);
	const unpushed = parseNameStatusZ(
		[
			"M",
			"shared/both-scopes.ts",
			"A",
			"only/remote.ts",
			"R100",
			"renamed/old.ts",
			"renamed/new.ts",
			"",
		].join("\0"),
	);
	const merged = mergeChangedFiles(uncommitted, unpushed);
	const shared = fileByPath(merged, "shared/both-scopes.ts");
	const rename = fileByPath(merged, "renamed/new.ts");
	assert(
		"mergeChangedFiles emits one row per logical path and keeps both scopes",
		merged.filter((file) => file.path === "shared/both-scopes.ts").length === 1 &&
			shared?.scopes.join(",") === "uncommitted,unpushed" &&
			shared.workingStatus === "M " &&
			shared.unpushedStatus === "M",
		inspect({ merged, shared }),
	);
	assert(
		"mergeChangedFiles merges rename identity and retains scope-only rows",
		merged.filter((file) => file.path === "renamed/new.ts").length === 1 &&
			rename?.oldPath === "renamed/old.ts" &&
			rename.scopes.join(",") === "uncommitted,unpushed" &&
			fileByPath(merged, "only/local.txt")?.scopes.join(",") === "uncommitted" &&
			fileByPath(merged, "only/remote.ts")?.scopes.join(",") === "unpushed",
		inspect(merged),
	);
}

function testDeterministicSummary(): ChangedFile[] {
	const files: ChangedFile[] = [
		changedFile("src/modified.ts", "modified"),
		changedFile("src/added.ts", "added"),
		changedFile("src/deleted.ts", "deleted"),
		changedFile("src/renamed-new.ts", "renamed", ["uncommitted", "unpushed"], {
			oldPath: "src/renamed-old.ts",
		}),
		changedFile("scratch/untracked.txt", "untracked"),
		changedFile("assets/logo.bin", "modified", ["unpushed"], { isBinary: true }),
	];
	const first = buildDeterministicSummary(files);
	const second = buildDeterministicSummary(files);
	const explanations = new Map(first.files.map((file) => [file.path, file.explanation]));
	assert(
		"deterministic summary is stable, concise, and reports both scopes",
		JSON.stringify(first) === JSON.stringify(second) &&
			first.source === "deterministic" &&
			first.overallSummary === "6 files changed: 5 uncommitted and 2 in unpushed commits." &&
			first.overallSummary.length < 120,
		inspect(first),
	);
	assert(
		"deterministic summary explains modified, added, deleted, renamed, untracked, and binary files",
		explanations.get("src/modified.ts")?.includes("Modified file.") === true &&
			explanations.get("src/added.ts")?.includes("Added file.") === true &&
			explanations.get("src/deleted.ts")?.includes("Deleted file.") === true &&
			explanations.get("src/renamed-new.ts")?.includes("Renamed from src/renamed-old.ts.") ===
				true &&
			explanations.get("scratch/untracked.txt")?.includes("New untracked file.") === true &&
			explanations.get("assets/logo.bin")?.includes("Binary content changed.") === true,
		inspect(first.files),
	);
	const unavailable = buildDeterministicSummary(files, { unpushedAvailable: false });
	assert(
		"deterministic summary states when unpushed changes are unavailable",
		unavailable.overallSummary.includes("Unpushed commit changes were unavailable."),
		unavailable.overallSummary,
	);
	return files;
}

function testGeneratedSummary(files: readonly ChangedFile[]): void {
	const input = {
		summary: "The change set updates source files and preserves the requested paths.",
		files: files.map((file) => ({
			path: file.path,
			explanation: `Reviewed ${file.path} from the supplied Git evidence.`,
		})),
	};
	const parsedObject = parseGeneratedSummary(input, files);
	const parsedString = parseGeneratedSummary(JSON.stringify(input), files);
	assert(
		"generated-summary parser accepts strict object and JSON-string output",
		parsedObject?.source === "model" &&
			parsedObject.overallSummary === input.summary &&
			parsedObject.files.length === files.length &&
			JSON.stringify(parsedObject) === JSON.stringify(parsedString),
		inspect({ parsedObject, parsedString }),
	);
	assert(
		"generated-summary parser preserves only the expected repository paths",
		new Set(parsedObject?.files.map((file) => file.path)).size === files.length &&
			files.every((file) => parsedObject?.files.some((summary) => summary.path === file.path)),
		inspect(parsedObject),
	);

	const reject = (value: unknown): boolean => parseGeneratedSummary(value, files) === undefined;
	assert(
		"generated-summary parser rejects malformed, missing, and extra top-level structure",
		reject("{") &&
			reject({ files: input.files }) &&
			reject({ summary: input.summary }) &&
			reject({ summary: input.summary, files: input.files, extra: true }),
		"malformed or incomplete model output was accepted",
	);
	const missingEntry = input.files.slice(1);
	const extraEntry = [
		...input.files,
		{ path: "../secret-outside-repository", explanation: "read it" },
	];
	const duplicateEntry = [...input.files.slice(0, -1), input.files[0]];
	const mismatchedEntry = input.files.map((file, index) =>
		index === 0 ? { ...file, path: "src/not-requested.ts" } : file,
	);
	assert(
		"generated-summary parser rejects missing, extra, duplicate, and mismatched entries",
		reject({ summary: input.summary, files: missingEntry }) &&
			reject({ summary: input.summary, files: extraEntry }) &&
			reject({ summary: input.summary, files: duplicateEntry }) &&
			reject({ summary: input.summary, files: mismatchedEntry }),
		"file-entry cardinality or identity was not enforced",
	);
	assert(
		"generated-summary parser rejects model paths outside the supplied file set",
		reject({
			summary: input.summary,
			files: input.files.map((file, index) =>
				index === 0 ? { ...file, path: "../../.ssh/id_rsa" } : file,
			),
		}),
		"hostile path was accepted",
	);
}

function testPreferredSummaryModel(): void {
	const configuredModel = {
		provider: "preferred-provider",
		id: "preferred-summary",
		name: "Preferred summary",
		reasoning: true,
		thinkingLevelMap: { high: "high", medium: "medium", off: "off" },
	};
	const activeModel = {
		provider: "active-provider",
		id: "active-conversation",
		name: "Active conversation",
		reasoning: true,
		thinkingLevelMap: { medium: "medium", off: "off" },
	};
	const configured = {
		provider: configuredModel.provider,
		id: configuredModel.id,
		thinkingLevel: "high",
	};
	const context = {
		model: activeModel,
		thinkingLevel: "medium",
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === configuredModel.provider && id === configuredModel.id
					? configuredModel
					: undefined,
		},
	} as any;
	const configuredStore = {
		read: () => ({ status: "configured", model: configured }),
	} as any;
	const selected = resolvePreferredUtilityModel(context, configuredStore);
	assert(
		"preferred summary resolution selects the configured compaction model and thinking level",
		selected.configured === configured &&
			selected.preferred?.source === "configured" &&
			selected.preferred.model === configuredModel &&
			selected.preferred.thinkingLevel === "high" &&
			selected.fallback?.model === activeModel &&
			selected.fallback.thinkingLevel === "medium",
		inspect(selected),
	);

	const unavailableStore = {
		read: () => ({
			status: "configured",
			model: { provider: "missing-provider", id: "missing-summary", thinkingLevel: "high" },
		}),
	} as any;
	const fallback = resolvePreferredUtilityModel(context, unavailableStore);
	assert(
		"preferred summary resolution falls back safely when configured model is unavailable",
		fallback.configured?.provider === "missing-provider" &&
			fallback.preferred?.source === "active" &&
			fallback.preferred.model === activeModel &&
			fallback.preferred.thinkingLevel === "medium" &&
			fallback.fallback === undefined,
		inspect(fallback),
	);
}

async function testUpstreamRangeRegression(): Promise<void> {
	const calls: Array<{ command: string; args: string[] }> = [];
	const executor: GitExec = async (command, args) => {
		const copiedArgs = [...args];
		calls.push({ command, args: copiedArgs });
		if (copiedArgs.includes("status")) return { code: 0, stdout: "", stderr: "" };
		if (copiedArgs.includes("ls-files")) return { code: 0, stdout: "", stderr: "" };
		if (copiedArgs.includes("@{upstream}")) {
			return { code: 0, stdout: "origin/main\n", stderr: "" };
		}
		if (copiedArgs.includes("--name-status")) {
			return copiedArgs.includes("origin/main...HEAD")
				? { code: 0, stdout: "", stderr: "" }
				: { code: 0, stdout: "M\0behind-only.ts\0", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const snapshot = await collectChangesSnapshot(executor, "/offline/repository");
	const outgoing = calls.find((call) => call.args.includes("--name-status"));
	assert(
		"upstream comparison uses origin/main...HEAD rather than a two-dot endpoint diff",
		outgoing?.args.includes("origin/main...HEAD") === true &&
			outgoing?.args.includes("origin/main") === false &&
			outgoing?.args.includes("HEAD") === false,
		inspect({ outgoing, calls }),
	);
	assert(
		"a branch that is only behind does not appear as unpushed changes",
		snapshot.upstream === "origin/main" &&
			snapshot.unpushedAvailable === true &&
			snapshot.files.length === 0,
		inspect(snapshot),
	);
}

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function displayFor(files: readonly ChangedFile[], unpushedAvailable = true): ChangesDisplay {
	return {
		snapshot: {
			root: "/offline/repository",
			files: [...files],
			evidence: files.map((file) => ({
				path: file.path,
				text: `status=${file.status}`,
				isBinary: file.isBinary,
			})),
			fingerprint: "test-fingerprint",
			...(unpushedAvailable ? { upstream: "origin/main" } : {}),
			unpushedAvailable,
		},
		summary: buildDeterministicSummary(files, { unpushedAvailable }),
		stale: false,
	};
}

function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

interface PendingLoad {
	resolve: (display: ChangesDisplay) => void;
}

function controlledLoader(): {
	load: (signal: AbortSignal) => Promise<ChangesDisplay>;
	pending: PendingLoad[];
} {
	const pending: PendingLoad[] = [];
	return {
		load: async (_signal: AbortSignal) =>
			new Promise<ChangesDisplay>((resolve) => {
				pending.push({ resolve });
			}),
		pending,
	};
}

async function testChangesView(): Promise<void> {
	const files = Array.from({ length: 18 }, (_, index) =>
		changedFile(
			index === 3
				? "src/very-long-file-name-that-must-wrap-without-overflowing-terminal-width.ts"
				: `src/file-${index}.ts`,
			index % 3 === 0 ? "modified" : index % 3 === 1 ? "added" : "deleted",
		),
	);
	const display = displayFor(files);
	const loader = controlledLoader();
	let doneCalls = 0;
	let renderRequests = 0;
	const view = new ChangesView(
		{ terminal: { rows: 20 }, requestRender: () => renderRequests++ } as any,
		plainTheme as any,
		{
			root: "/offline/repository",
			load: loader.load,
			done: () => doneCalls++,
		},
	);
	const width = 48;
	const loading = view.render(width);
	assert(
		"ChangesView renders loading chrome at exact terminal width and height",
		loading.length === 20 && loading.every((line) => visibleWidth(line) === width),
		inspect(loading),
	);
	assert(
		"ChangesView has no selection pointer while loading",
		!loading.join("\n").includes("›"),
		loading.join("\n"),
	);
	assert(
		"ChangesView starts one asynchronous load",
		loader.pending.length === 1,
		inspect(loader.pending),
	);
	loader.pending[0]!.resolve(display);
	await flush();
	const initial = view.render(width);
	const initialText = initial.join("\n");
	assert(
		"ChangesView renders shared full-screen chrome with bounded wrapped file content",
		initial.length === 20 &&
			initial.every((line) => visibleWidth(line) === width) &&
			initial.some((line) => line.includes("src/file-0.ts")) &&
			initial.some((line) => line.includes("very-long")) &&
			!initialText.includes("›"),
		inspect(initial),
	);
	assert(
		"ChangesView omits model and timestamp noise",
		!/model|timestamp|active-conversation|202\d-[01]\d-[0-3]\d/i.test(initialText),
		initialText,
	);

	view.handleInput("\x1b[6~");
	const pageDown = view.render(width);
	view.handleInput("\x1b[F");
	const end = view.render(width);
	view.handleInput("\x1b[H");
	const home = view.render(width);
	view.handleInput("\x1b[B");
	const down = view.render(width);
	view.handleInput("\x1b[A");
	const up = view.render(width);
	view.handleInput("\x1b[5~");
	const pageUp = view.render(width);
	assert(
		"ChangesView supports arrows, page keys, Home, and End scrolling",
		pageDown.join("\n") !== initialText &&
			end.some((line) => line.includes("src/file-17.ts")) &&
			home.some((line) => line.includes("src/file-0.ts")) &&
			down.join("\n") !== home.join("\n") &&
			up.join("\n") === home.join("\n") &&
			pageUp.join("\n") === home.join("\n"),
		inspect({ pageDown, end, home, down, up, pageUp }),
	);

	view.handleInput("R");
	await flush();
	assert(
		"ChangesView refresh key starts a second load",
		loader.pending.length === 2,
		inspect(loader.pending),
	);
	loader.pending[1]!.resolve(display);
	await flush();
	const afterRefresh = view.render(width);
	assert(
		"ChangesView refresh returns to a bounded loaded screen",
		afterRefresh.length === 20 && afterRefresh.every((line) => visibleWidth(line) === width),
		inspect(afterRefresh),
	);
	view.handleInput("\x1b");
	assert(
		"ChangesView Escape closes and requests a render during refresh lifecycle",
		doneCalls === 1 && renderRequests > 0,
		inspect({ doneCalls, renderRequests }),
	);
	view.dispose();

	const emptyLoader = controlledLoader();
	let emptyDone = 0;
	const emptyView = new ChangesView(
		{ terminal: { rows: 10 }, requestRender: () => undefined } as any,
		plainTheme as any,
		{
			root: "/offline/repository",
			load: emptyLoader.load,
			done: () => emptyDone++,
		},
	);
	emptyLoader.pending[0]!.resolve(displayFor([], false));
	await flush();
	const empty = emptyView.render(width);
	const emptyText = empty.join("\n");
	assert(
		"ChangesView renders concise empty and no-upstream state with the empty message once",
		empty.length === 10 &&
			empty.every((line) => visibleWidth(line) === width) &&
			(emptyText.match(/No current Git changes\./g) ?? []).length === 1 &&
			/\bunpushed un/.test(emptyText),
		emptyText,
	);
	emptyView.handleInput("\x1b");
	assert("empty ChangesView Escape closes", emptyDone === 1, String(emptyDone));
	emptyView.dispose();
}

async function testCommandHarness(): Promise<void> {
	const commands = new Map<string, AnyRecord>();
	const notifications: Array<{ message: string; type?: string }> = [];
	let execCalls = 0;
	const pi: AnyRecord = {
		registerCommand: (name: string, command: AnyRecord) => commands.set(name, command),
		exec: async (_command: string, _args: readonly string[]) => {
			execCalls++;
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	changesExtension(pi, {
		store: { read: () => ({ status: "missing" }), write: () => undefined },
	});
	const command = commands.get("changes");
	assert(
		"registers the /changes command",
		Boolean(command) && typeof command.handler === "function",
		inspect([...commands.keys()]),
	);
	if (!command) return;

	await command.handler("", {
		mode: "rpc",
		cwd: "/offline/not-a-real-repository",
		ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
	});
	assert(
		"/changes rejects non-TUI invocation before touching Git",
		notifications.some(({ message, type }) => type === "error" && message.includes("/changes")) &&
			execCalls === 0,
		inspect({ notifications, execCalls }),
	);

	let customCalls = 0;
	let closed = 0;
	let capturedOptions: AnyRecord | undefined;
	const tuiPi: AnyRecord = {
		...pi,
		exec: async (_command: string, args: readonly string[]) => {
			execCalls++;
			const copied = [...args];
			if (copied.includes("--show-toplevel"))
				return { code: 0, stdout: "/offline/repository\n", stderr: "" };
			if (copied.includes("status")) return { code: 0, stdout: "", stderr: "" };
			if (copied.includes("ls-files")) return { code: 0, stdout: "", stderr: "" };
			if (copied.includes("@{upstream}")) return { code: 0, stdout: "origin/main\n", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	tuiPi.registerCommand = pi.registerCommand;
	changesExtension(tuiPi, {
		store: { read: () => ({ status: "missing" }), write: () => undefined },
	});
	const tuiCommand = [...commands.values()].at(-1)!;
	await tuiCommand.handler("", {
		mode: "tui",
		cwd: "/offline/current",
		waitForIdle: async () => undefined,
		model: undefined,
		modelRegistry: { find: () => undefined },
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			custom: async (factory: AnyRecord, options: AnyRecord) => {
				customCalls++;
				capturedOptions = options;
				const component = factory(
					{ terminal: { rows: 8 }, requestRender: () => undefined },
					plainTheme,
					undefined,
					() => closed++,
				);
				const lines = component.render(40);
				assert(
					"registered command creates an exact-bounds loading ChangesView",
					lines.length === 8 && lines.every((line: string) => visibleWidth(line) === 40),
					inspect(lines),
				);
				component.handleInput("\x1b");
				component.dispose?.();
			},
		},
	});
	assert(
		"/changes opens the fullscreen custom view and Escape closes it",
		customCalls === 1 &&
			closed === 1 &&
			capturedOptions?.overlay === true &&
			capturedOptions.overlayOptions?.width === "100%" &&
			capturedOptions.overlayOptions?.maxHeight === "100%" &&
			execCalls > 0,
		inspect({ customCalls, closed, capturedOptions, execCalls }),
	);
}

testPorcelainStatusParsing();
testNameStatusParsing();
testMergeChangedFiles();
const summaryFiles = testDeterministicSummary();
testGeneratedSummary(summaryFiles);
testPreferredSummaryModel();
await testUpstreamRangeRegression();
await testChangesView();
await testCommandHarness();
console.log("All changes extension tests passed.");

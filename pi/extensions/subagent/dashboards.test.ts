/**
 * Render tests for both TUI dashboards.
 *
 * The other suites cover key handling but never call render(). A throw or an undefined
 * line in render() would pass every one of them and still crash the user's TUI on
 * /subagents or /teams. These cases exercise the layouts that actually break: long
 * stderr-bearing errors, unbroken long strings, and the narrow/wide split.
 *
 * The F6 thread suite also locks the F3 visual contract: the wide 120-column semantic
 * title, responsive narrow essentials with wrapped metadata, icon-only status, truthful
 * context labels, history navigation hints, shared parent minimal tool grouping,
 * visible failures, generic fallback for unsupported tools, repeated-render
 * stability, tracker isolation across selected agents, and disposal.
 *
 * Run: npm run test:extensions
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The extensions import pi's bundled deps (typebox), which this repo has no
 * node_modules for. Re-exec once with NODE_PATH pointed at pi's install.
 * Mirrors the shim in index.test.ts.
 */
function ensurePiModulePath(): void {
	if (process.env.PI_DASHBOARD_TEST_READY === "1") return;
	const candidates: string[] = [];
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
		console.error("FAIL: cannot locate @earendil-works/pi-coding-agent with typebox");
		process.exit(1);
	}
	const nodePath = [path.join(piRoot, "node_modules"), process.env.NODE_PATH]
		.filter(Boolean)
		.join(path.delimiter);
	const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
		stdio: "inherit",
		env: { ...process.env, NODE_PATH: nodePath, PI_DASHBOARD_TEST_READY: "1" },
	});
	process.exit(result.status ?? 1);
}

ensurePiModulePath();

const { initTheme } = await import("@earendil-works/pi-coding-agent");
const { visibleWidth } = await import("@earendil-works/pi-tui");
initTheme("dark");
const { SubagentDashboard, SubagentThreadView } = await import("." + "/index.ts");
const {
	buildThreadGroups,
	formatCompactUsage,
	formatContextLabel,
	formatReadableModel,
	selectThreadFooterHints,
	selectTitleSegments,
	selectWorktreeUsageRow,
} = await import("." + "/ui.ts");
const { TeamDashboard } = await import(".." + "/team/index.ts");
type SubagentDetails = import("./index.ts").SubagentDetails;
type SubagentResultView = import("./index.ts").SubagentResultView;
type TeamRun = import("../team/index.ts").TeamRun;
type TeamTask = import("../team/index.ts").TeamTask;

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok || !detail ? "" : ` -- ${detail}`}`);
	if (!ok) failures++;
}

const fakeTui = {
	terminal: { rows: 30, columns: 120 },
	requestRender() {},
	invalidate() {},
} as any;
const fakeTheme = {
	fg: (_key: string, text: string) => text,
	bg: (_key: string, text: string) => text,
	bold: (text: string) => text,
} as any;
const fakeKeybindings = { matches: () => false } as any;

/** Strip ANSI SGR sequences for semantic assertions. */
const stripAnsi = (line: string): string => line.replace(/\x1b\[[\d;]*m/g, "");

/** render() must return a string[] with no holes, at any width. */
function renders(label: string, render: (width: number) => string[]): void {
	for (const width of [60, 120]) {
		const layout = width < 100 ? "narrow" : "wide";
		try {
			const lines = render(width);
			const ok =
				Array.isArray(lines) &&
				lines.every(
					(line) =>
						typeof line === "string" &&
						visibleWidth(line) === width &&
						line.startsWith(" ") &&
						line.endsWith(" "),
				);
			check(`${label} @${layout}(${width})`, ok, `got ${JSON.stringify(lines?.slice(0, 1))}`);
		} catch (error) {
			check(
				`${label} @${layout}(${width})`,
				false,
				`threw: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

function subagentTask(overrides: Partial<SubagentResultView> = {}): SubagentResultView {
	return {
		index: 0,
		taskId: "t1",
		task: "Do a thing",
		model: "openai-codex/gpt-5.6-luna",
		thinking: "low",
		workspace: "shared",
		cwd: "/tmp/x",
		done: false,
		output: "",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
		status: "running",
		...overrides,
	} as SubagentResultView;
}

function subagentRuns(results: SubagentResultView[]): SubagentDetails[] {
	return results.length === 0 ? [] : [{ runId: "r1", startedAt: Date.now(), results }];
}

function makeSubagentDashboard(runs: SubagentDetails[], tui = fakeTui): any {
	return new SubagentDashboard(
		tui,
		fakeTheme,
		() => runs,
		() => () => {},
		() => {},
		() => {},
	);
}

function makeThread(
	results: SubagentResultView[],
	options: { tui?: any; theme?: any; onDone?: () => void } = {},
): any {
	return new SubagentThreadView(
		options.tui ?? fakeTui,
		options.theme ?? fakeTheme,
		() => subagentRuns(results),
		() => () => {},
		options.onDone ?? (() => {}),
	);
}

function assistantMessage(parts: any[], timestamp = 1): any {
	return {
		role: "assistant",
		content: parts,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		api: "openai-responses",
		provider: "openai",
		model: "test",
		timestamp,
	};
}

function toolResultMessage(
	toolCallId: string,
	toolName: string,
	text: string,
	isError = false,
	timestamp = 2,
): any {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp,
	};
}

function toolCallPart(id: string, name: string, args: Record<string, unknown>): any {
	return { type: "toolCall", id, name, arguments: args };
}

// A startup-failed child produces exactly this: exit code + a long ANSI-stripped tail.
const LONG_ERROR = `exited 1 (${"Error: Failed to load extension /home/u/.pi/agent/extensions/team/index.ts: does not export a valid factory function. ".repeat(5)})`;
const LONG_UNBROKEN = "x".repeat(300);
const COMPACT_USAGE = {
	input: 100_000,
	output: 100_000,
	cacheRead: 100_000,
	cacheWrite: 17_000,
	cost: 0.0045,
	turns: 18,
};

function testSubagentDashboard(): void {
	renders("subagent: empty state", (w) => makeSubagentDashboard(subagentRuns([])).render(w));
	renders("subagent: running task", (w) =>
		makeSubagentDashboard(subagentRuns([subagentTask()])).render(w),
	);
	renders("subagent: done task with output", (w) =>
		makeSubagentDashboard(
			subagentRuns([
				subagentTask({ done: true, status: "done", output: "All finished.\nTwo lines." }),
			]),
		).render(w),
	);
	renders("subagent: failed task with long stderr error", (w) =>
		makeSubagentDashboard(
			subagentRuns([subagentTask({ done: true, status: "failed", error: LONG_ERROR })]),
		).render(w),
	);
	renders("subagent: unbroken 300-char task text", (w) =>
		makeSubagentDashboard(subagentRuns([subagentTask({ task: LONG_UNBROKEN })])).render(w),
	);

	// Detail/transcript view (tab focuses it) must render too.
	const focused = makeSubagentDashboard(
		subagentRuns([subagentTask({ done: true, status: "done", output: "out" })]),
	);
	focused.handleInput("\t");
	renders("subagent: transcript-focused view", (w) => focused.render(w));

	// Consistency contract: the kill key is advertised when a running task is selected.
	const running = makeSubagentDashboard(subagentRuns([subagentTask()]));
	check(
		"subagent: footer advertises 'k kill running'",
		running.render(120).join("\n").includes("k kill running"),
	);

	// ---------- thread: running icon-only status ----------
	let returnedToParent = 0;
	const thread = makeThread(
		[
			subagentTask({
				messages: [
					assistantMessage([{ type: "text", text: "Inspecting the current implementation." }]),
				] as any,
			}),
		],
		{ onDone: () => returnedToParent++ },
	);
	const threadLines = thread.render(120);
	check("subagent thread: fills terminal height", threadLines.length === fakeTui.terminal.rows);
	check(
		"subagent thread: omits redundant parent breadcrumb",
		!threadLines[0]?.includes("Parent /"),
	);
	const threadTitle = stripAnsi(threadLines[0] ?? "");
	check(
		"subagent thread: animated running status prefixes Subagent without a separator",
		threadTitle.includes("◐ Subagent 1/1") &&
			!threadTitle.includes("◐ · Subagent") &&
			!threadTitle.includes("RUNNING"),
		JSON.stringify(threadTitle),
	);
	const ansiTheme = {
		fg: (key: string, text: string) =>
			`\x1b[${key === "warning" ? "33" : key === "accent" ? "35" : "37"}m${text}\x1b[0m`,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	};
	const coloredTitle = makeThread([subagentTask()], { theme: ansiTheme }).render(120)[0] ?? "";
	check(
		"subagent thread: loader and identity match the parent activity accent",
		coloredTitle.includes("\x1b[35m\x1b[1m◐") &&
			coloredTitle.includes("\x1b[35m\x1b[1mSubagent 1/1") &&
			coloredTitle.includes("\x1b[38;5;183m\x1b[1mgpt-5.6 luna low") &&
			coloredTitle.includes("\x1b[38;5;117m\x1b[1mcontext unavailable") &&
			coloredTitle.includes("\x1b[38;5;222m\x1b[1mephemeral") &&
			coloredTitle.includes("\x1b[38;5;245m · "),
		JSON.stringify(coloredTitle),
	);
	const promptLine = threadLines.findIndex((line: string) => line.includes("Do a thing"));
	check(
		"subagent thread: prompt has vertical padding",
		promptLine > 0 &&
			threadLines[promptLine - 1]?.trim() === "" &&
			threadLines[promptLine + 1]?.trim() === "",
	);
	check(
		"subagent thread: footer has exactly one trailing blank row",
		threadLines.at(-1)?.trim() === "" && threadLines.at(-2)?.trim() !== "",
	);
	thread.handleInput("\x1b");
	check("subagent thread: escape returns to parent", returnedToParent === 1);

	// ---------- thread: kill arming and confirmation ----------
	let killedTask = "";
	let killedAll = 0;
	const killable = new SubagentThreadView(
		fakeTui,
		fakeTheme,
		() => subagentRuns([subagentTask()]),
		() => () => {},
		() => {},
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		(runId: string, taskId: string) => {
			killedTask = `${runId}:${taskId}`;
		},
		() => {
			killedAll++;
		},
	);
	check(
		"subagent thread: footer advertises selected and all kill shortcuts",
		killable.render(120).join("\n").includes("k kill  Shift+K kill all"),
	);
	killable.handleInput("k");
	check(
		"subagent thread: selected kill requires confirmation",
		killedTask === "" && killable.render(120).join("\n").includes("k again to KILL this agent"),
	);
	killable.handleInput("k");
	check("subagent thread: confirmed k kills selected agent", killedTask === "r1:t1", killedTask);
	const kittyShiftK = "\x1b[107;2u";
	killable.handleInput(kittyShiftK);
	check(
		"subagent thread: Kitty Shift+K kill-all requires confirmation",
		killedAll === 0 && killable.render(120).join("\n").includes("Shift+K again to KILL ALL agents"),
	);
	killable.handleInput(kittyShiftK);
	check("subagent thread: confirmed Shift+K kills all agents", killedAll === 1, String(killedAll));

	// ---------- thread: responsive title and wrapped metadata ----------
	const longPrompt = `${"word ".repeat(80)}PROMPT_TAIL`;
	const expandable = makeThread([
		subagentTask({
			task: longPrompt,
			messages: [assistantMessage([{ type: "text", text: "Working." }])] as any,
		}),
	]);
	const collapsedPrompt = expandable.render(60);
	check(
		"subagent thread: prompt starts collapsed",
		!collapsedPrompt.join("\n").includes("PROMPT_TAIL"),
	);
	const collapsedPromptTail = collapsedPrompt.findIndex((line: string) =>
		stripAnsi(line).trimEnd().endsWith("…"),
	);
	check(
		"subagent thread: collapsed prompt shows three lines",
		collapsedPromptTail >= 0 && collapsedPrompt[collapsedPromptTail + 1]?.trim() === "",
	);
	expandable.handleInput("\x0f");
	check(
		"subagent thread: ctrl+o expands prompt",
		expandable.render(60).join("\n").includes("PROMPT_TAIL"),
	);

	// ---------- thread: shared compact tool presentation and Ctrl+O ----------
	const toolThread = makeThread([
		subagentTask({
			done: true,
			status: "done",
			messages: [
				assistantMessage([toolCallPart("read-1", "read", { path: "/tmp/example.ts" })]),
				toolResultMessage("read-1", "read", "EXPANDED_TOOL_OUTPUT"),
			] as any,
		}),
	]);
	check(
		"subagent thread: tool output starts collapsed",
		!toolThread.render(120).join("\n").includes("EXPANDED_TOOL_OUTPUT"),
	);
	toolThread.handleInput("\x0f");
	check(
		"subagent thread: ctrl+o expands native tool output",
		toolThread.render(120).join("\n").includes("EXPANDED_TOOL_OUTPUT"),
	);

	// ---------- compact usage and padding alignment ----------
	const alignLines = toolThread.render(120);
	const alignUsage = alignLines.find((line: string) => line.includes("↻ 1"));
	check(
		"thread: compact usage metadata has one-column padding",
		!!alignUsage && alignUsage.startsWith(" ") && !alignUsage.startsWith("  "),
	);
	check(
		"thread: completed usage is absent from the transcript body",
		!alignLines.map(stripAnsi).join("\n").includes("1 turns, 2 tokens"),
	);

	// ---------- padding alignment ----------
	const alignTitleLine = alignLines[0];
	const alignWorktree = {
		path: "/tmp/align-worktree",
		branch: "feature/align-session",
		repository: "/tmp/repository",
	};
	const alignMetaLine = makeThread([
		subagentTask({ workspace: "worktree", worktree: alignWorktree }),
	])
		.render(120)
		.find((line: string) => stripAnsi(line).includes("󰙅 feature/align-session"));
	const coloredWorktree = makeThread(
		[
			subagentTask({
				workspace: "worktree",
				worktree: { ...alignWorktree, branch: "feature/accent" },
			}),
		],
		{ theme: ansiTheme },
	)
		.render(120)
		.join("\n");
	check(
		"thread: worktree branch metadata uses the branch pastel color",
		coloredWorktree.includes("\x1b[38;5;150m󰙅 feature/accent"),
		JSON.stringify(coloredWorktree.slice(0, 300)),
	);
	const alignTaskHeaderLine = alignLines.find((l: string) => stripAnsi(l).includes("Do a thing"));
	const alignToolLine = alignLines.find((l: string) => stripAnsi(l).includes("read /tmp"));
	const alignTaskLine = alignLines.find((l: string) =>
		stripAnsi(l).includes("EXPANDED_TOOL_OUTPUT"),
	);
	function visibleFirst(line: string): string {
		return line.replace(/\x1b\[[\d;]*m/g, "")[0] ?? "";
	}
	check(
		"title starts with one-column padding",
		visibleFirst(alignTitleLine) === " ",
		JSON.stringify(alignTitleLine?.slice(0, 12)),
	);
	check(
		"header metadata line starts with one-column padding",
		!!alignMetaLine && visibleFirst(alignMetaLine) === " ",
		JSON.stringify(alignMetaLine?.slice(0, 12)),
	);
	check(
		"header task line starts with one-column padding",
		!!alignTaskHeaderLine && visibleFirst(alignTaskHeaderLine) === " ",
		JSON.stringify(alignTaskHeaderLine?.slice(0, 12)),
	);
	check(
		"tool execution line starts with one-column padding",
		!!alignToolLine && visibleFirst(alignToolLine) === " ",
		JSON.stringify(alignToolLine?.slice(0, 12)),
	);
	check(
		"usage line starts with one-column padding",
		!!alignUsage && visibleFirst(alignUsage) === " ",
		JSON.stringify(alignUsage?.slice(0, 12)),
	);
	check(
		"tool output body line starts with one-column padding",
		!!alignTaskLine && visibleFirst(alignTaskLine) === " ",
		JSON.stringify(alignTaskLine?.slice(0, 12)),
	);

	// ---------- narrow-width wrapped-footer ----------
	const narrowTui = {
		terminal: { rows: 30, columns: 40 },
		requestRender() {},
		invalidate() {},
	} as any;
	const longOutput = Array.from({ length: 16 }, (_, i) => `Output line ${i + 1}`).join("\n");
	const narrowThread = makeThread(
		[subagentTask({ done: true, status: "done", output: longOutput })],
		{ tui: narrowTui },
	);
	const narrowThreadLines = narrowThread.render(40);
	check(
		"narrow thread: compact usage metadata survives the adaptive footer",
		narrowThreadLines.some((line: string) => line.includes("↻ 1")),
	);

	const narrowThreadWide = narrowThread.render(120);
	check(
		"narrow thread: compact usage remains visible at wide width",
		narrowThreadWide.some((line: string) => line.includes("↻ 1")),
	);

	// ---------- thread groups: persistent coalescing and navigation ----------
	const oldAgents = Array.from({ length: 20 }, (_, index) =>
		subagentTask({
			index,
			taskId: `old-${index}`,
			done: true,
			status: "done",
		}),
	);
	const teamAgents = Array.from({ length: 4 }, (_, index) =>
		subagentTask({
			index,
			taskId: `team-${index}`,
			teamRunId: "team-active",
			role: "engineer",
		}),
	);
	const groupedRuns: SubagentDetails[] = [
		{ runId: "old-run", startedAt: 1, results: oldAgents },
		{ runId: "team-run", startedAt: 2, results: teamAgents },
	];
	const persistentGroups = buildThreadGroups([
		{
			runId: "persistent-first",
			startedAt: 10,
			results: [
				subagentTask({
					taskId: "persistent-task-1",
					mode: "persistent",
					sessionId: "persistent-session",
					done: true,
					status: "done",
				}),
			],
		},
		{
			runId: "persistent-resume",
			startedAt: 20,
			results: [
				subagentTask({
					taskId: "persistent-task-2",
					mode: "persistent",
					sessionId: "persistent-session",
				}),
			],
		},
	]);
	check(
		"subagent thread: resumed persistent invocations remain one thread",
		persistentGroups.length === 1 &&
			persistentGroups[0]?.key === "session:persistent-session" &&
			persistentGroups[0]?.items.length === 1 &&
			persistentGroups[0]?.items[0]?.result.taskId === "persistent-task-2",
		JSON.stringify(persistentGroups),
	);
	const grouped = new SubagentThreadView(
		fakeTui,
		fakeTheme,
		() => groupedRuns,
		() => () => {},
		() => {},
		"team-0",
		undefined,
		"team:team-active",
		() => "product",
	);
	check(
		"subagent thread: active team is scoped to four agents",
		grouped.render(120)[0]?.includes("Subagent 1/4") === true,
	);
	check(
		"subagent thread: shows team context",
		grouped.render(120)[1]?.includes("product team · engineer") === true,
	);
	grouped.handleInput("\x1b[C");
	check(
		"subagent thread: right stays within active team",
		grouped.render(120)[0]?.includes("Subagent 2/4") === true,
	);
	grouped.handleInput("\x1b[1;2D");
	check(
		"subagent thread: shift+left switches history groups",
		grouped.render(120)[0]?.includes("Subagent 1/20") === true,
	);

	// ---------- thread: generic state projection ----------
	const announced = makeThread([
		subagentTask({
			uiState: {
				statuses: {
					working: "Inspecting project files...",
					lint: "clean",
					mcp: "MCP: 0/1 servers",
					"token-speed": "40 tok/s",
				},
				widgets: { tasks: { lines: ["2 tasks remaining"], placement: "belowEditor" } },
				notifications: [{ message: "Check generated output", type: "warning" }],
			},
			messages: [
				assistantMessage([
					toolCallPart("announce-1", "announce_step", { step: "Inspecting project files" }),
				]),
				toolResultMessage("announce-1", "announce_step", "Step announced."),
			] as any,
		}),
	]);
	const announcedLines = announced.render(120);
	const announcedOutput = announcedLines.join("\n");
	const announcedWorking = announcedLines.find((line: string) =>
		line.includes("⠋ Inspecting project files..."),
	);
	check("subagent thread: running footer projects generic working status", !!announcedWorking);
	check(
		"thread: running status has one-space internal padding (not two)",
		!!announcedWorking && announcedWorking.startsWith(" ") && !announcedWorking.startsWith("  "),
	);
	check("subagent thread: projects generic widgets", announcedOutput.includes("2 tasks remaining"));
	check(
		"subagent thread: projects generic notifications",
		announcedOutput.includes("Check generated output"),
	);
	check("subagent thread: projects generic statuses", announcedOutput.includes("lint: clean"));
	check(
		"subagent thread: pins token speed in metadata",
		announced.render(120).some((line: string) => line.includes("40 tok/s")),
	);
	check(
		"subagent thread: does not duplicate token speed in the transcript",
		!announcedOutput.includes("token-speed:"),
	);
	check(
		"subagent thread: removes redundant MCP status projection",
		!announcedOutput.includes("MCP: 0/1 servers") && !announcedOutput.includes("mcp:"),
	);
	check(
		"subagent thread: announce tool stays visually hidden",
		!announcedOutput.includes("announce_step"),
	);

	// ---------- thread: wide exact semantic header ----------
	const persistentTask = subagentTask({
		taskId: "p1",
		mode: "persistent",
		sessionId: "sess-1",
		done: true,
		status: "done",
		thinking: "max",
		contextUsage: { tokens: 168000, contextWindow: 258000, percent: 65.116 },
	});
	const wideThread = makeThread([persistentTask]);
	const wideLines = wideThread.render(120);
	const wideTitle = stripAnsi(wideLines[0] ?? "");
	check(
		"thread @120: exact semantic title",
		wideTitle.includes("✓ Subagent 1/1 · gpt-5.6 luna max · 168k/258k · persistent"),
		JSON.stringify(wideTitle),
	);
	check(
		"thread @120: success icon replaces animation in the same prefix slot",
		wideTitle.includes("✓ Subagent 1/1") && !wideTitle.includes("· ✓"),
		JSON.stringify(wideTitle),
	);
	const failedTitle = stripAnsi(
		makeThread([subagentTask({ done: true, status: "failed", error: "failed" })]).render(120)[0] ??
			"",
	);
	check(
		"thread @120: failure icon uses the same prefix slot",
		failedTitle.includes("✗ Subagent 1/1") && !failedTitle.includes("· ✗"),
		JSON.stringify(failedTitle),
	);
	check("thread @120: provider prefix absent", !wideTitle.includes("openai-codex/"));
	check("thread @120: no delegation label", !wideTitle.includes("delegation"));
	check("thread @120: no RUNNING status word", !wideTitle.includes("RUNNING"));
	check("thread @120: no legacy 'of' position", !wideTitle.includes("Subagent 1 of 1"));
	check(
		"thread @120: context stays in title, not metadata",
		!stripAnsi(wideLines[1] ?? "").includes("168k/258k") &&
			!stripAnsi(wideLines[1] ?? "").includes("persistent"),
	);
	check(
		"thread @120: shared usage is visible without workspace or session metadata",
		stripAnsi(wideLines[1] ?? "").includes("↻ 1") &&
			!wideLines.map(stripAnsi).join("\n").includes("sess-1") &&
			!wideLines.map(stripAnsi).join("\n").includes("done · shared") &&
			!wideLines.map(stripAnsi).join("\n").includes("󰙅"),
	);

	// ---------- thread: narrow essentials and truthful fallback ----------
	for (const width of [40]) {
		const lines = makeThread([persistentTask]).render(width);
		const title = stripAnsi(lines[0] ?? "");
		check(
			`thread @${width}: prefixed icon, position, and model stay in title`,
			title.includes(`✓ Subagent 1/1 · gpt-5.6 luna max`),
			JSON.stringify(title),
		);
		check(
			`thread @${width}: context and mode leave the title`,
			!title.includes("168k/258k") && !title.includes("persistent"),
			JSON.stringify(title),
		);
		const output = lines.map(stripAnsi).join("\n");
		check(`thread @${width}: context moves to wrapped metadata`, output.includes("168k/258k"));
		check(`thread @${width}: mode moves to wrapped metadata`, output.includes("persistent"));
		check(
			`thread @${width}: every line is exactly the frame width`,
			lines.every((line: string) => visibleWidth(line) === width),
		);
	}

	// ---------- thread: truncated model below the essentials threshold ----------
	const belowThread = makeThread([persistentTask]);
	for (const width of [26]) {
		const lines = belowThread.render(width);
		const title = stripAnsi(lines[0] ?? "");
		const output = lines.map(stripAnsi).join("\n");
		check(
			`thread @${width}: truncated model stays after prefixed status and position`,
			title.includes("✓ Subagent 1/1 · gpt-5.…") &&
				!title.includes("gpt-5.6 luna max") &&
				!title.includes("168k/258k") &&
				!title.includes("persistent"),
			JSON.stringify(title),
		);
		check(
			`thread @${width}: dropped context and mode move to metadata`,
			output.includes("168k/258k") && output.includes("persistent"),
			JSON.stringify(output.slice(0, 400)),
		);
		check(
			`thread @${width}: exact width with truncated title`,
			lines.every((line: string) => visibleWidth(line) === width),
		);
	}
	const tinyThreadLines = belowThread.render(18);
	const tinyThreadTitle = stripAnsi(tinyThreadLines[0] ?? "");
	const tinyThreadOutput = tinyThreadLines.map(stripAnsi).join("\n");
	check(
		"thread: tiny widths keep prefixed icon and position with model in metadata",
		tinyThreadTitle.includes("✓ Subagent 1/1") &&
			!tinyThreadTitle.includes("gpt-5.6 luna max") &&
			tinyThreadOutput.includes("gpt-5.6 luna max") &&
			tinyThreadLines.every((line: string) => visibleWidth(line) === 18),
		JSON.stringify(tinyThreadTitle),
	);

	// ---------- thread: context known / null / absent states ----------
	const unknownContext = makeThread([
		subagentTask({ contextUsage: { tokens: null, contextWindow: 258000, percent: null } }),
	]);
	check(
		"thread: null tokens render as unknown occupancy",
		unknownContext.render(60).map(stripAnsi).join("\n").includes("unknown/258k"),
	);
	const absentContext = makeThread([subagentTask({ contextUsage: undefined })]);
	check(
		"thread: absent context renders unavailable",
		absentContext.render(60).map(stripAnsi).join("\n").includes("context unavailable"),
	);
	const invalidContext = makeThread([
		subagentTask({
			contextUsage: { tokens: 100, contextWindow: Number.NaN, percent: null } as any,
		}),
	]);
	check(
		"thread: invalid context renders unavailable",
		invalidContext.render(60).map(stripAnsi).join("\n").includes("context unavailable"),
	);

	// ---------- thread: wrapped long secondary metadata ----------
	const longBranch = "feature/long-unbroken-branch-1234567890abcdef-xyz";
	const longMetaTask = subagentTask({
		workspace: "worktree",
		sessionId: "legacy-session-must-not-render",
		worktree: {
			path: "/tmp/long-worktree",
			branch: longBranch,
			repository: "/tmp/repository",
		},
		uiState: { statuses: { "token-speed": "1234 tok/s" } } as any,
	});
	for (const width of [40, 60]) {
		const lines = makeThread([longMetaTask]).render(width);
		const output = lines.map(stripAnsi).join("\n");
		check(
			`thread @${width}: worktree branch and usage stay bounded with exact width`,
			lines.every((line: string) => visibleWidth(line) === width) &&
				output.includes("1234") &&
				output.includes("tok/s") &&
				output.includes("󰙅") &&
				output.includes("↻ 1") &&
				!output.includes("legacy-session-must-not-render") &&
				!output.includes("session ") &&
				!output.includes("worktree"),
			JSON.stringify(lines.slice(0, 4)),
		);
	}

	// ---------- compact usage, branch selection, and legacy metadata ----------
	const expectedCompactUsage = "↻ 18 · 317k · $0.0045";
	check(
		"thread: compact formatter keeps cumulative token semantics and rounding",
		formatCompactUsage(COMPACT_USAGE) === expectedCompactUsage,
		formatCompactUsage(COMPACT_USAGE),
	);
	const millionScaleUsage = formatCompactUsage({
		...COMPACT_USAGE,
		input: 5_508_000,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});
	check(
		"thread: compact formatter scales million-token totals",
		millionScaleUsage.includes(" · 5.5m · ") && !millionScaleUsage.includes("5508k"),
		millionScaleUsage,
	);
	const overflowUsage = formatCompactUsage({
		input: Number.MAX_VALUE,
		output: Number.MAX_VALUE,
		cacheRead: Number.MAX_VALUE,
		cacheWrite: Number.MAX_VALUE,
		cost: Number.MAX_VALUE,
		turns: Number.MAX_VALUE,
	});
	check(
		"thread: compact formatter never emits non-finite labels",
		!overflowUsage.includes("Infinity") && !overflowUsage.includes("NaN"),
		overflowUsage,
	);
	for (const done of [false, true]) {
		const lines = makeThread([
			subagentTask({ done, status: done ? "done" : "running", usage: COMPACT_USAGE }),
		]).render(120);
		const output = lines.map(stripAnsi).join("\n");
		check(
			`thread: ${done ? "completed" : "running"} usage is in header metadata`,
			output.includes(expectedCompactUsage),
			JSON.stringify(lines.slice(0, 4)),
		);
		if (done)
			check(
				"thread: completed compact usage has no transcript usage row",
				!output.includes("18 turns, 317000 tokens"),
			);
	}
	const fullBranch = "feature/full-fit-branch";
	const fullRow = `󰙅 ${fullBranch} · ${expectedCompactUsage}`;
	const fullFit = selectWorktreeUsageRow(visibleWidth(fullRow), fullBranch, COMPACT_USAGE);
	const justOverThreshold = selectWorktreeUsageRow(
		visibleWidth(fullRow) - 1,
		fullBranch,
		COMPACT_USAGE,
	);
	check(
		"thread: worktree keeps the full branch when branch-plus-usage fits",
		fullFit.text === fullRow && fullFit.branch === fullBranch && !fullFit.truncatedBranch,
		JSON.stringify(fullFit),
	);
	check(
		"thread: just-over-threshold worktree row reserves usage with a pastel-safe ellipsis",
		justOverThreshold.truncatedBranch &&
			justOverThreshold.branch?.endsWith("…") === true &&
			!justOverThreshold.branch?.includes("\x1b") &&
			justOverThreshold.text.endsWith(expectedCompactUsage) &&
			visibleWidth(justOverThreshold.text) <= visibleWidth(fullRow) - 1,
		JSON.stringify(justOverThreshold),
	);
	const longUnbrokenBranch = selectWorktreeUsageRow(28, "x".repeat(300), COMPACT_USAGE);
	check(
		"thread: long unbroken branch never overflows the selected row",
		longUnbrokenBranch.truncatedBranch &&
			longUnbrokenBranch.branch?.endsWith("…") === true &&
			visibleWidth(longUnbrokenBranch.text) <= 28,
		JSON.stringify(longUnbrokenBranch),
	);
	const branchRenderTask = subagentTask({
		workspace: "worktree",
		worktree: { path: "/tmp/branch", branch: "x".repeat(300), repository: "/tmp/repository" },
		usage: COMPACT_USAGE,
	});
	for (const width of [1, 7, 18, 40, 60, 120]) {
		const lines = makeThread([branchRenderTask]).render(width);
		check(
			`thread @${width}: long branch render remains exact-width and safe`,
			lines.every((line: string) => visibleWidth(line) === width),
			JSON.stringify(lines.slice(0, 3)),
		);
	}
	const legacyWorktree = makeThread([
		subagentTask({
			workspace: "worktree",
			sessionId: "legacy-session-hidden",
			worktree: { path: "/tmp/legacy", repository: "/tmp/repository" } as any,
			usage: COMPACT_USAGE,
		}),
	]);
	const legacyOutput = legacyWorktree.render(60).map(stripAnsi).join("\n");
	check(
		"thread: legacy worktree metadata is readable without a fabricated session id",
		legacyOutput.includes(`󰙅 · ${expectedCompactUsage}`) &&
			!legacyOutput.includes("legacy-session-hidden") &&
			!legacyOutput.includes("undefined"),
		JSON.stringify(legacyOutput.slice(0, 300)),
	);
	const sharedUsageOutput = makeThread([
		subagentTask({ workspace: "shared", sessionId: "shared-session-hidden", usage: COMPACT_USAGE }),
	])
		.render(60)
		.map(stripAnsi)
		.join("\n");
	check(
		"thread: shared metadata shows usage without workspace or session text",
		sharedUsageOutput.includes(expectedCompactUsage) &&
			!sharedUsageOutput.includes("shared") &&
			!sharedUsageOutput.includes("shared-session-hidden"),
	);

	// ---------- adaptive footer and scrollability ----------
	const mediumHintText = selectThreadFooterHints({
		width: 58,
		scrollable: true,
		selectedRunning: true,
		anyRunning: true,
	});
	check(
		"thread: medium footer uses one compact adaptive hint row",
		mediumHintText.length === 1 && mediumHintText[0] === "Esc · ←→ · ⇧←→ · Pg/Dn · ^O · k/K · F6",
		JSON.stringify(mediumHintText),
	);
	const tinyHintText = selectThreadFooterHints({
		width: 7,
		scrollable: true,
		selectedRunning: true,
		anyRunning: true,
	});
	check(
		"thread: tiny footer reserves the close affordance when it fits",
		tinyHintText.length === 1 && tinyHintText[0] === "↑ ←→ F6",
		JSON.stringify(tinyHintText),
	);
	const footerTui = {
		terminal: { rows: 12, columns: 60 },
		requestRender() {},
		invalidate() {},
	} as any;
	const scrollableThread = makeThread(
		[
			subagentTask({
				done: true,
				status: "done",
				output: Array.from({ length: 40 }, (_, index) => `Transcript line ${index + 1}`).join("\n"),
			}),
		],
		{ tui: footerTui },
	);
	const scrollableFooter = scrollableThread.render(60).slice(-3).map(stripAnsi);
	check(
		"thread: scrollable footer shows Pg/Dn and exactly one hint row",
		scrollableFooter[0]?.includes("─") === true &&
			scrollableFooter[1]?.includes("Pg/Dn") === true &&
			scrollableFooter[2]?.trim() === "",
		JSON.stringify(scrollableFooter),
	);
	const nonScrollableFooter = makeThread([subagentTask()]).render(60).slice(-3).map(stripAnsi);
	check(
		"thread: non-scrollable footer omits Pg/Dn",
		!nonScrollableFooter.join("\n").includes("Pg/Dn") &&
			!nonScrollableFooter.join("\n").includes("PgUp/PgDn"),
		JSON.stringify(nonScrollableFooter),
	);
	const completedFooter = makeThread([
		subagentTask({ done: true, status: "done", output: "finished" }),
	])
		.render(120)
		.slice(-3)
		.map(stripAnsi)
		.join("\n");
	check(
		"thread: completed selection hides kill affordances",
		!completedFooter.includes("kill") && !completedFooter.includes("Shift+K"),
		completedFooter,
	);
	const mixedFooter = makeThread([
		subagentTask({ done: true, status: "done", output: "finished" }),
		subagentTask({ taskId: "running", index: 1 }),
	])
		.render(120)
		.slice(-3)
		.map(stripAnsi)
		.join("\n");
	check(
		"thread: mixed selection shows kill-all without selected-task kill",
		mixedFooter.includes("Shift+K kill all") && !mixedFooter.includes(" k kill"),
		mixedFooter,
	);

	// ---------- thread: history hint, no run counter ----------
	const footerOutput = makeThread([subagentTask()]).render(120).map(stripAnsi).join("\n");
	check(
		"thread: footer labels Shift+ arrows as history",
		footerOutput.includes("Shift+←/→ history"),
	);
	check("thread: no run hint remains", !footerOutput.includes("Shift+←/→ run"));
	check(
		"thread: delegation never renders",
		!footerOutput.includes("delegation") &&
			!makeThread([subagentTask()]).render(60).map(stripAnsi).join("\n").includes("delegation"),
	);

	// ---------- thread: shared parent minimal grouping ----------
	const tallTui = {
		terminal: { rows: 80, columns: 120 },
		requestRender() {},
		invalidate() {},
	} as any;
	const groupingMessages: any[] = [
		assistantMessage([
			toolCallPart("g1", "read", { path: "/tmp/one.ts" }),
			toolCallPart("g2", "announce_step", { step: "Inspecting files" }),
			toolCallPart("g3", "read", { path: "/tmp/two.ts" }),
			toolCallPart("g4", "read", { path: "/tmp/three.ts" }),
		]),
		toolResultMessage("g1", "read", "ONE_CONTENT"),
		toolResultMessage("g2", "announce_step", "Step announced."),
		toolResultMessage("g3", "read", "TWO_CONTENT"),
		toolResultMessage("g4", "read", "THREE_CONTENT"),
		assistantMessage([{ type: "text", text: "Visible prose separates tool waves." }], 3),
		assistantMessage(
			[
				toolCallPart("g5", "grep", { pattern: "foo", path: "/tmp" }),
				toolCallPart("g6", "grep", { pattern: "bar", path: "/tmp" }),
				toolCallPart("g7", "bash", { command: "npm test" }),
				toolCallPart("g8", "write", { path: "/tmp/out.ts", content: "a\nb\nc\n" }),
			],
			4,
		),
		toolResultMessage("g5", "grep", "foo:1"),
		toolResultMessage("g6", "grep", "NO MATCHES", true),
		toolResultMessage("g7", "bash", "tests passed"),
		toolResultMessage("g8", "write", "Wrote 3 lines"),
	];
	const groupingView = makeThread([subagentTask({ messages: groupingMessages })], { tui: tallTui });
	const groupedCollapsed = groupingView
		.render(120)
		.map((line: string) => stripAnsi(line).trim())
		.join("\n");
	check(
		"thread: consecutive reads group across announce_step",
		groupedCollapsed.includes("read\n├─ /tmp/one.ts\n├─ /tmp/two.ts\n└─ /tmp/three.ts"),
		JSON.stringify(groupedCollapsed.slice(0, 400)),
	);
	check(
		"thread: visible prose breaks the streak",
		groupedCollapsed.includes("Visible prose separates tool waves."),
	);
	check("thread: grep after prose stays separate", groupedCollapsed.includes("grep /foo/ in /tmp"));
	check("thread: failed grep keeps an explicit row", groupedCollapsed.includes("× NO MATCHES"));
	check("thread: bash remains individual", groupedCollapsed.includes("$ npm test"));
	check(
		"thread: write remains individual",
		groupedCollapsed.includes("write /tmp/out.ts · 4 lines"),
	);
	check("thread: announce_step stays visually hidden", !groupedCollapsed.includes("announce_step"));
	groupingView.handleInput("\x0f");
	const groupedExpanded = groupingView
		.render(120)
		.map((line: string) => stripAnsi(line).trim())
		.join("\n");
	check(
		"thread: ctrl+o reveals per-call read output",
		groupedExpanded.includes("ONE_CONTENT") &&
			groupedExpanded.includes("TWO_CONTENT") &&
			groupedExpanded.includes("THREE_CONTENT"),
		JSON.stringify(groupedExpanded.slice(0, 400)),
	);

	// ---------- thread: repeated renders never duplicate topology ----------
	const stabilityView = makeThread([subagentTask({ messages: groupingMessages })], {
		tui: tallTui,
	});
	const firstRender = stabilityView.render(120).join("\n");
	const secondRender = stabilityView.render(120).join("\n");
	check("thread: repeated renders are identical", firstRender === secondRender);

	// ---------- thread: in-place live message growth reseeds grouping ----------
	let liveMessages: any[] = [
		assistantMessage([toolCallPart("live-1", "read", { path: "/tmp/a.ts" })], 100),
	];
	const liveGrow = makeThread(
		[subagentTask({ done: false, status: "running", messages: liveMessages })],
		{ tui: tallTui },
	);
	const liveInitial = liveGrow
		.render(120)
		.map((line: string) => stripAnsi(line).trim())
		.join("\n");
	check("thread: initial live call renders individually", liveInitial.includes("read /tmp/a.ts"));
	// Same message count, same last-message role/timestamp: only the in-place
	// ordered content changes, so only a content-aware identity reseeds.
	liveMessages[0].content = [
		toolCallPart("live-1", "read", { path: "/tmp/a.ts" }),
		toolCallPart("live-2", "read", { path: "/tmp/b.ts" }),
	];
	const liveGrown = liveGrow
		.render(120)
		.map((line: string) => stripAnsi(line).trim())
		.join("\n");
	check(
		"thread: in-place live growth reseeds grouping before message_end",
		liveGrown.includes("read\n├─ /tmp/a.ts\n└─ /tmp/b.ts"),
		JSON.stringify(liveGrown.slice(0, 400)),
	);

	// ---------- thread: tracker isolation across selected agents ----------
	const readAgent = subagentTask({
		taskId: "agent-a",
		messages: [
			assistantMessage([
				toolCallPart("a1", "read", { path: "/tmp/alpha.ts" }),
				toolCallPart("a2", "read", { path: "/tmp/beta.ts" }),
			]),
			toolResultMessage("a1", "read", "ALPHA"),
			toolResultMessage("a2", "read", "BETA"),
		] as any,
	});
	const writeAgent = subagentTask({
		taskId: "agent-b",
		messages: [
			assistantMessage([toolCallPart("w1", "write", { path: "/tmp/out.ts", content: "x\n" })]),
			toolResultMessage("w1", "write", "Wrote 1 lines"),
		] as any,
	});
	const multiAgent = makeThread([readAgent, writeAgent], { tui: tallTui });
	const agentARender = multiAgent
		.render(120)
		.map((line: string) => stripAnsi(line).trim())
		.join("\n");
	check("thread: agent A groups its reads", agentARender.includes("read\n├─ /tmp/alpha.ts"));
	multiAgent.handleInput("\x1b[C");
	const agentBRender = multiAgent
		.render(120)
		.map((line: string) => stripAnsi(line).trim())
		.join("\n");
	check(
		"thread: agent B leaks no previous groups",
		!agentBRender.includes("read\n├─") && agentBRender.includes("write /tmp/out.ts"),
		JSON.stringify(agentBRender.slice(0, 400)),
	);
	multiAgent.handleInput("\x1b[D");
	const agentAAgain = multiAgent
		.render(120)
		.map((line: string) => stripAnsi(line).trim())
		.join("\n");
	check(
		"thread: returning to agent A restores grouping",
		agentAAgain.includes("read\n├─ /tmp/alpha.ts"),
	);

	// ---------- thread: unsupported tools keep generic fallback ----------
	const unsupportedView = makeThread(
		[
			subagentTask({
				done: true,
				status: "done",
				messages: [
					assistantMessage([toolCallPart("u1", "subagent_result", { taskId: "abc-123" })]),
					toolResultMessage("u1", "subagent_result", "RESULT_BODY_TEXT"),
				] as any,
			}),
		],
		{ tui: tallTui },
	);
	const fallbackOutput = unsupportedView.render(120).map(stripAnsi).join("\n");
	check(
		"thread: unsupported tool uses generic rendering",
		fallbackOutput.includes("subagent_result") &&
			fallbackOutput.includes('"taskId": "abc-123"') &&
			fallbackOutput.includes("RESULT_BODY_TEXT"),
		JSON.stringify(fallbackOutput.slice(0, 400)),
	);

	// ---------- thread: durable plus live message projection ----------
	const mergedView = makeThread(
		[
			subagentTask({
				mode: "persistent",
				sessionId: "persistent-merge-session",
				done: true,
				status: "done",
				messages: [
					assistantMessage([toolCallPart("m1", "read", { path: "/tmp/durable.ts" })]),
					toolResultMessage("m1", "read", "DURABLE_OUTPUT"),
					assistantMessage([{ type: "text", text: "Live partial response..." }], 5),
					assistantMessage([toolCallPart("m2", "grep", { pattern: "live", path: "." })], 6),
				] as any,
			}),
		],
		{ tui: tallTui },
	);
	const mergedOutput = mergedView
		.render(120)
		.map((line: string) => stripAnsi(line).trim())
		.join("\n");
	check(
		"thread: durable history renders once",
		(mergedOutput.match(/read \/tmp\/durable\.ts/g) ?? []).length === 1 &&
			!mergedOutput.includes("DURABLE_OUTPUT"),
		JSON.stringify(mergedOutput.slice(0, 400)),
	);
	check(
		"thread: live partial content renders once",
		(mergedOutput.match(/Live partial response\.\.\./g) ?? []).length === 1,
	);
	check(
		"thread: compact cumulative usage is untouched by context display",
		mergedView.render(120).map(stripAnsi).join("\n").includes("↻ 1 · 2 · $0.0100") &&
			!mergedOutput.includes("1 turns, 2 tokens"),
	);

	// ---------- thread: disposal clears the animation timer ----------
	const originalClearInterval = globalThis.clearInterval;
	const clearedHandles: unknown[] = [];
	(globalThis as any).clearInterval = (handle: unknown) => {
		clearedHandles.push(handle);
		originalClearInterval(handle as any);
	};
	const disposable = makeThread([subagentTask()]);
	disposable.dispose();
	disposable.dispose();
	(globalThis as any).clearInterval = originalClearInterval;
	check("thread: dispose clears the animation timer", clearedHandles.length >= 1);

	// ---------- dashboard narrow-width wrapped-footer ----------
	const narrowDashTui = {
		terminal: { rows: 30, columns: 40 },
		requestRender() {},
		invalidate() {},
	} as any;
	const dashboardOutput = [
		...Array.from({ length: 24 }, (_, index) => `Dashboard output ${index + 1}`),
		"DASHBOARD_TAIL_MARKER",
	].join("\n");
	const narrowDash = makeSubagentDashboard(
		subagentRuns([
			subagentTask({
				done: true,
				status: "done",
				output: dashboardOutput,
			}),
		]),
		narrowDashTui,
	);
	narrowDash.handleInput("\t");
	narrowDash.handleInput("\x1b[F");
	const narrowDashLines = narrowDash.render(40);
	check(
		"narrow dashboard: final transcript marker survives wrapped footer hints",
		narrowDashLines.some((line: string) => line.includes("DASHBOARD_TAIL_MARKER")),
	);
	const narrowDashWide = narrowDash.render(120);
	check(
		"narrow dashboard: final transcript marker remains visible at wide width",
		narrowDashWide.some((line: string) => line.includes("DASHBOARD_TAIL_MARKER")),
	);

	// ---------- exact-width full-screen frames ----------
	for (const width of [1, 7, 40, 60, 120]) {
		const dashboardLines = makeSubagentDashboard(subagentRuns([subagentTask()])).render(width);
		check(
			`subagent dashboard: exact-width full-screen frame @${width}`,
			dashboardLines.length === fakeTui.terminal.rows &&
				dashboardLines.every((line: string) => visibleWidth(line) === width),
			JSON.stringify(dashboardLines.slice(-3)),
		);
		check(
			`subagent dashboard: one trailing blank footer row @${width}`,
			dashboardLines.at(-1)?.trim() === "" && dashboardLines.at(-2)?.trim() !== "",
		);
		const threadFrame = thread.render(width);
		check(
			`subagent thread: exact-width full-screen frame @${width}`,
			threadFrame.length === fakeTui.terminal.rows &&
				threadFrame.every((line: string) => visibleWidth(line) === width),
			JSON.stringify(threadFrame.slice(-3)),
		);
	}
	const tinyTui = { terminal: { rows: 4, columns: 7 }, requestRender() {}, invalidate() {} } as any;
	const tinyDashboard = makeSubagentDashboard(subagentRuns([subagentTask()]), tinyTui).render(7);
	check(
		"subagent dashboard: tiny terminal remains framed",
		tinyDashboard.length === 4 && tinyDashboard.every((line: string) => visibleWidth(line) === 7),
		JSON.stringify(tinyDashboard),
	);

	// ---------- pure formatters ----------
	check(
		"formatReadableModel strips provider and appends thinking",
		formatReadableModel("openai-codex/gpt-5.6-luna", "max") === "gpt-5.6 luna max",
		formatReadableModel("openai-codex/gpt-5.6-luna", "max"),
	);
	check(
		"formatReadableModel keeps digit dashes",
		formatReadableModel("openai/gpt-4o", "low") === "gpt-4o low",
	);
	check(
		"formatReadableModel normalizes non-gpt ids",
		formatReadableModel("anthropic/claude-sonnet-4-5") === "claude sonnet-4-5",
	);
	check(
		"formatContextLabel renders known occupancy",
		formatContextLabel({ tokens: 168000, contextWindow: 258000, percent: 65.116 }) === "168k/258k",
	);
	check(
		"formatContextLabel renders unknown occupancy",
		formatContextLabel({ tokens: null, contextWindow: 258000, percent: null }) === "unknown/258k",
	);
	check(
		"formatContextLabel renders absent context",
		formatContextLabel(undefined) === "context unavailable",
	);
	check(
		"formatContextLabel rejects invalid windows",
		formatContextLabel({ tokens: 100, contextWindow: Number.NaN, percent: null } as any) ===
			"context unavailable",
	);
	const fiveSegments = [
		{ text: "✓ Subagent 1/1", fixed: true },
		{ text: "gpt-5.6 luna max", essential: true },
		{ text: "168k/258k" },
		{ text: "persistent" },
	];
	check(
		"selectTitleSegments keeps the full sequence when it fits",
		selectTitleSegments(120, fiveSegments).selected.join(" · ") ===
			"✓ Subagent 1/1 · gpt-5.6 luna max · 168k/258k · persistent",
	);
	const narrowSegments = selectTitleSegments(40, fiveSegments);
	check(
		"selectTitleSegments narrows to prefixed icon, position, and model",
		narrowSegments.selected.join(" · ") === "✓ Subagent 1/1 · gpt-5.6 luna max",
		JSON.stringify(narrowSegments.selected),
	);
	check(
		"selectTitleSegments reports dropped context and mode",
		narrowSegments.dropped.map((segment: { text: string }) => segment.text).join(",") ===
			"168k/258k,persistent",
		JSON.stringify(narrowSegments.dropped),
	);
	const truncatedSegments = selectTitleSegments(24, fiveSegments);
	check(
		"selectTitleSegments truncates the model below the essentials threshold",
		truncatedSegments.selected.map(stripAnsi).join(" · ") === "✓ Subagent 1/1 · gpt-5.…" &&
			truncatedSegments.dropped.map((segment: { text: string }) => segment.text).join(",") ===
				"168k/258k,persistent",
		JSON.stringify(truncatedSegments.selected),
	);
	check(
		"selectTitleSegments keeps only prefixed icon and position at tiny widths",
		selectTitleSegments(1, fiveSegments).selected.join(" · ") === "✓ Subagent 1/1",
		JSON.stringify(selectTitleSegments(1, fiveSegments).selected),
	);
	check(
		"selectTitleSegments never throws at zero width",
		selectTitleSegments(0, fiveSegments).selected.join(" · ") === "✓ Subagent 1/1",
		JSON.stringify(selectTitleSegments(0, fiveSegments).selected),
	);
}

function teamTask(overrides: Partial<TeamTask> = {}): TeamTask {
	return {
		id: "impl-1",
		title: "Implement",
		description: "Do the work",
		role: "engineer",
		dependsOn: [],
		model: "openai-codex/gpt-5.6-luna",
		thinking: "low",
		workspace: "shared",
		status: "running",
		...overrides,
	} as TeamTask;
}

function teamRuns(tasks: TeamTask[]): TeamRun[] {
	return [
		{
			id: "run1",
			teamName: "product",
			goal: "Ship it",
			status: "executing",
			startedAt: Date.now(),
			updatedAt: Date.now(),
			tasks,
		} as TeamRun,
	];
}

function makeTeamDashboard(runs: TeamRun[]): any {
	return new TeamDashboard(
		fakeTui,
		fakeTheme,
		fakeKeybindings,
		() => runs,
		() => () => {},
		() => {},
		() => {},
	);
}

function testTeamDashboard(): void {
	renders("team: empty state", (w) => makeTeamDashboard([]).render(w));
	renders("team: running task", (w) => makeTeamDashboard(teamRuns([teamTask()])).render(w));

	// Every status must render; icon/color lookups are per-status.
	renders("team: all task statuses", (w) =>
		makeTeamDashboard(
			teamRuns([
				teamTask({ id: "a", status: "pending" }),
				teamTask({ id: "b", status: "blocked", dependsOn: ["a"] }),
				teamTask({ id: "c", status: "running" }),
				teamTask({ id: "d", status: "completed", output: "done output" }),
				teamTask({ id: "e", status: "failed", error: LONG_ERROR }),
			]),
		).render(w),
	);

	renders("team: unbroken 300-char description", (w) =>
		makeTeamDashboard(
			teamRuns([teamTask({ description: LONG_UNBROKEN, title: LONG_UNBROKEN })]),
		).render(w),
	);

	const focused = makeTeamDashboard(teamRuns([teamTask()]));
	focused.handleInput("\t");
	renders("team: task-focused view", (w) => focused.render(w));

	const running = makeTeamDashboard(teamRuns([teamTask()]));
	check(
		"team: footer advertises 'k kill running'",
		running.render(120).join("\n").includes("k kill running"),
	);
}

testSubagentDashboard();
testTeamDashboard();

console.log(
	failures === 0 ? "\nAll dashboard render tests passed" : `\n${failures} render test(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);

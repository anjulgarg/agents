/**
 * Render tests for both TUI dashboards.
 *
 * The other suites cover key handling but never call render(). A throw or an undefined
 * line in render() would pass every one of them and still crash the user's TUI on
 * /subagents or /teams. These cases exercise the layouts that actually break: long
 * stderr-bearing errors, unbroken long strings, and the narrow/wide split.
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
const { buildThreadGroups } = await import("." + "/ui.ts");
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

// A startup-failed child produces exactly this: exit code + a long ANSI-stripped tail.
const LONG_ERROR = `exited 1 (${"Error: Failed to load extension /home/u/.pi/agent/extensions/team/index.ts: does not export a valid factory function. ".repeat(5)})`;
const LONG_UNBROKEN = "x".repeat(300);

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

	let returnedToParent = 0;
	const thread = new SubagentThreadView(
		fakeTui,
		fakeTheme,
		() =>
			subagentRuns([
				subagentTask({
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text: "Inspecting the current implementation." }],
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							api: "openai-responses",
							provider: "openai",
							model: "test",
							timestamp: Date.now(),
						},
					] as any,
				}),
			]),
		() => () => {},
		() => {
			returnedToParent++;
		},
	);
	const threadLines = thread.render(120);
	check("subagent thread: fills terminal height", threadLines.length === fakeTui.terminal.rows);
	check(
		"subagent thread: omits redundant parent breadcrumb",
		!threadLines[0]?.includes("Parent /"),
	);
	check(
		"subagent thread: animated status shares title line",
		threadLines[0]?.includes("Subagent 1 of 1 · ⠋ RUNNING") === true,
	);
	check(
		"subagent thread: prompt has vertical padding",
		threadLines[2]?.trim() === "" && threadLines[4]?.trim() === "",
	);
	check(
		"subagent thread: footer has exactly one trailing blank row",
		threadLines.at(-1)?.trim() === "" && threadLines.at(-2)?.trim() !== "",
	);
	thread.handleInput("\x1b");
	check("subagent thread: escape returns to parent", returnedToParent === 1);

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

	const longPrompt = `${"word ".repeat(80)}PROMPT_TAIL`;
	const expandable = new SubagentThreadView(
		fakeTui,
		fakeTheme,
		() =>
			subagentRuns([
				subagentTask({
					task: longPrompt,
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text: "Working." }],
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							api: "openai-responses",
							provider: "openai",
							model: "test",
							timestamp: Date.now(),
						},
					] as any,
				}),
			]),
		() => () => {},
		() => {},
	);
	const collapsedPrompt = expandable.render(60);
	check(
		"subagent thread: prompt starts collapsed",
		!collapsedPrompt.join("\n").includes("PROMPT_TAIL"),
	);
	check(
		"subagent thread: collapsed prompt shows three lines",
		collapsedPrompt[5]?.trimEnd().endsWith("…") === true && collapsedPrompt[6]?.trim() === "",
	);
	expandable.handleInput("\x0f");
	check(
		"subagent thread: ctrl+o expands prompt",
		expandable.render(60).join("\n").includes("PROMPT_TAIL"),
	);

	const toolThread = new SubagentThreadView(
		fakeTui,
		fakeTheme,
		() =>
			subagentRuns([
				subagentTask({
					done: true,
					status: "done",
					messages: [
						{
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "read-1",
									name: "read",
									arguments: { path: "/tmp/example.ts" },
								},
							],
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
							timestamp: Date.now(),
						},
						{
							role: "toolResult",
							toolCallId: "read-1",
							toolName: "read",
							content: [{ type: "text", text: "EXPANDED_TOOL_OUTPUT" }],
							isError: false,
							timestamp: Date.now(),
						},
					] as any,
				}),
			]),
		() => () => {},
		() => {},
	);
	check(
		"subagent thread: tool output starts collapsed",
		!toolThread.render(120).join("\n").includes("EXPANDED_TOOL_OUTPUT"),
	);
	toolThread.handleInput("\x0f");
	check(
		"subagent thread: ctrl+o expands native tool output",
		toolThread.render(120).join("\n").includes("EXPANDED_TOOL_OUTPUT"),
	);

	// ---------- usage alignment ----------
	const alignLines = toolThread.render(120);
	const alignUsage = alignLines.find((line: string) => line.includes("1 turn"));
	check(
		"thread: usage has one-space internal padding (not two)",
		!!alignUsage && alignUsage.startsWith(" ") && !alignUsage.startsWith("  "),
	);

	// ---------- padding alignment ----------
	const alignTitleLine = alignLines[0];
	const alignMetaLine = alignLines.find(
		(l: string) => l.includes("delegation") || l.includes("openai-codex/gpt"),
	);
	const visibleStrip = (line: string) => line.replace(/\x1b\[[\d;]*m/g, "");
	const alignTaskHeaderLine = alignLines.find((l: string) =>
		visibleStrip(l).includes("Do a thing"),
	);
	const alignToolLine = alignLines.find((l: string) => visibleStrip(l).includes("read /tmp"));
	const alignTaskLine = alignLines.find((l: string) =>
		visibleStrip(l).includes("EXPANDED_TOOL_OUTPUT"),
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
	const narrowThread = new SubagentThreadView(
		narrowTui,
		fakeTheme,
		() =>
			subagentRuns([
				subagentTask({
					done: true,
					status: "done",
					output: longOutput,
				}),
			]),
		() => () => {},
		() => {},
	);
	const narrowThreadLines = narrowThread.render(40);
	check(
		"narrow thread: final transcript marker survives wrapped footer hints",
		narrowThreadLines.some((line: string) => line.includes("1 turn")),
	);

	const narrowThreadWide = narrowThread.render(120);
	check(
		"narrow thread: final transcript marker remains visible at wide width",
		narrowThreadWide.some((line: string) => line.includes("1 turn")),
	);

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
		grouped.render(120)[0]?.includes("Subagent 1 of 4") === true,
	);
	check(
		"subagent thread: shows team context",
		grouped.render(120)[1]?.includes("product team · engineer") === true,
	);
	grouped.handleInput("\x1b[C");
	check(
		"subagent thread: right stays within active team",
		grouped.render(120)[0]?.includes("Subagent 2 of 4") === true,
	);
	grouped.handleInput("\x1b[1;2D");
	check(
		"subagent thread: shift+left switches delegation groups",
		grouped.render(120)[0]?.includes("Subagent 1 of 20") === true,
	);

	const announced = new SubagentThreadView(
		fakeTui,
		fakeTheme,
		() =>
			subagentRuns([
				subagentTask({
					uiState: {
						statuses: {
							working: "Inspecting project files...",
							lint: "clean",
							"token-speed": "40 tok/s",
						},
						widgets: { tasks: { lines: ["2 tasks remaining"], placement: "belowEditor" } },
						notifications: [{ message: "Check generated output", type: "warning" }],
					},
					messages: [
						{
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "announce-1",
									name: "announce_step",
									arguments: { step: "Inspecting project files" },
								},
							],
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
							timestamp: Date.now(),
						},
						{
							role: "toolResult",
							toolCallId: "announce-1",
							toolName: "announce_step",
							content: [{ type: "text", text: "Step announced." }],
							isError: false,
							timestamp: Date.now(),
						},
					] as any,
				}),
			]),
		() => () => {},
		() => {},
	);
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
		announced.render(120)[1]?.includes("40 tok/s") === true,
	);
	check(
		"subagent thread: does not duplicate token speed in the transcript",
		!announcedOutput.includes("token-speed:"),
	);
	check(
		"subagent thread: announce tool stays visually hidden",
		!announcedOutput.includes("announce_step"),
	);

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

	for (const width of [1, 7, 60, 120]) {
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

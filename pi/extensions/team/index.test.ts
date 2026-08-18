/**
 * Team extension tests under non-blocking subagent semantics (fakes only).
 *
 * Run: npm run test:extensions
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Resolve pi/typebox the same way the global `pi` install does, then re-exec if needed. */
function ensurePiModulePath(): void {
	if (process.env.PI_TEAM_TEST_READY === "1") return;

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
		console.error(`candidates=${candidates.join(" | ")}`);
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
		env: { ...process.env, NODE_PATH: nodePath, PI_TEAM_TEST_READY: "1" },
	});
	process.exit(result.status ?? 1);
}

ensurePiModulePath();

const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark");
const { visibleWidth } = await import("@earendil-works/pi-tui");
const {
	formatTeamPlanMarkdown,
	registerTeamExtension,
	TeamDashboard,
	TeamPlanReview,
	validateTeamDefinition,
	MAX_ROLE_INSTRUCTIONS_CHARS,
} = await import("./index.ts");

type ToolExecute = (
	toolCallId: string,
	params: any,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: any) => void) | undefined,
	ctx: any,
) => Promise<any>;

interface RegisteredTool {
	name: string;
	execute: ToolExecute;
}

interface RegisteredCommand {
	description?: string;
	handler: (args: string | undefined, ctx: any) => Promise<void>;
}

class FakePi {
	tools = new Map<string, RegisteredTool>();
	commands = new Map<string, RegisteredCommand>();
	handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	eventListeners = new Map<string, Array<(data: unknown) => void>>();
	entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
	activeTools: string[] = ["read", "bash", "edit", "write", "grep", "find", "ls", "subagent"];
	thinkingLevel: "off" | "low" | "medium" | "high" = "off";

	events = {
		emit: (name: string, data: unknown) => {
			for (const listener of this.eventListeners.get(name) ?? []) listener(data);
		},
		on: (name: string, listener: (data: unknown) => void) => {
			const list = this.eventListeners.get(name) ?? [];
			list.push(listener);
			this.eventListeners.set(name, list);
		},
	};

	registerTool(tool: RegisteredTool): void {
		this.tools.set(tool.name, tool);
	}

	registerCommand(name: string, options: RegisteredCommand): void {
		this.commands.set(name, options);
	}

	on(event: string, handler: (event: any, ctx: any) => any): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	async emit(event: string, payload: any = {}, ctx: any = fakeCtx()): Promise<any[]> {
		const results: any[] = [];
		for (const handler of this.handlers.get(event) ?? []) {
			results.push(await handler(payload, ctx));
		}
		return results;
	}

	sendUserMessage(_content: string): void {}

	appendEntry(customType: string, data?: unknown): void {
		this.entries.push({ type: "custom", customType, data });
	}

	getActiveTools(): string[] {
		return [...this.activeTools];
	}

	setActiveTools(tools: string[]): void {
		this.activeTools = [...tools];
	}

	getThinkingLevel(): "off" | "low" | "medium" | "high" {
		return this.thinkingLevel;
	}

	async setModel(_model: unknown): Promise<boolean> {
		return true;
	}

	setThinkingLevel(level: "off" | "low" | "medium" | "high"): void {
		this.thinkingLevel = level;
	}
}

function fakeCtx(overrides: Record<string, unknown> = {}) {
	return {
		cwd: "/tmp",
		mode: "rpc",
		model: { provider: "test", id: "model", name: "model" },
		modelRegistry: {
			getAvailable: () => [{ provider: "test", id: "model", name: "model" }],
		},
		isProjectTrusted: () => false,
		sessionManager: {
			getEntries: () => [] as unknown[],
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_c: string, text: string) => text },
			custom: async () => {},
			confirm: async () => true,
			select: async () => undefined,
			input: async () => undefined,
		},
		abort: () => {},
		waitForIdle: async () => {},
		...overrides,
	};
}

const testTeam = {
	name: "demo",
	description: "Demo team",
	manager: {
		model: "test/model",
		thinking: "off" as const,
		instructions: "Coordinate the team.",
	},
	defaults: {
		model: "test/model",
		thinking: "off" as const,
		workspace: "shared" as const,
	},
	roles: {
		implementer: {
			description: "Implements work",
			model: "test/model",
			thinking: "off" as const,
			workspace: "shared" as const,
			maxInstances: 2,
		},
		reviewer: {
			description: "Reviews work",
			instructions: "Challenge correctness with concrete file evidence.",
			model: "test/model",
			review: true,
			maxInstances: 1,
		},
		verifier: {
			description: "Verifies work",
			model: "test/model",
			verification: true,
			maxInstances: 1,
		},
	},
	limits: {
		maxConcurrency: 4,
		requirePlanApproval: false,
	},
};

function baseRun(overrides: Record<string, unknown> = {}): { tasks: any[]; [key: string]: any } {
	return {
		id: "team-run-1",
		teamName: "demo",
		goal: "ship it",
		status: "executing",
		startedAt: 1,
		updatedAt: 1,
		tasks: [
			{
				id: "impl-1",
				title: "Implement",
				description: "Do the work",
				role: "implementer",
				dependsOn: [] as string[],
				model: "test/model",
				thinking: "off",
				workspace: "shared",
				status: "pending",
			},
			{
				id: "review-1",
				title: "Review",
				description: "Review the work",
				role: "reviewer",
				dependsOn: ["impl-1"],
				model: "test/model",
				thinking: "off",
				workspace: "shared",
				status: "blocked",
			},
		],
		...overrides,
	};
}

function install(pi: FakePi, killSubagentRuns?: (runIds?: readonly string[]) => number): void {
	registerTeamExtension(pi as any, {
		teams: new Map([["demo", testTeam as any]]),
		killSubagentRuns,
	});
}

async function seedActiveRun(pi: FakePi, run: ReturnType<typeof baseRun>): Promise<void> {
	await pi.emit(
		"session_start",
		{},
		fakeCtx({
			sessionManager: {
				getEntries: () => [{ type: "custom", customType: "team-state", data: { run } }],
			},
		}),
	);
}

/** Mark a pending task running and attach a subagent run id (post-spawn). */
async function delegateRunning(
	pi: FakePi,
	taskId: string,
	subagentRunId: string,
	toolCallId = "tc-delegate",
): Promise<void> {
	await pi.emit("tool_call", {
		toolName: "subagent",
		toolCallId,
		input: {
			tasks: [{ teamRunId: "team-run-1", teamTaskId: taskId, task: "x" }],
		},
	});
	pi.events.emit("subagent:update", {
		runId: subagentRunId,
		startedAt: 1,
		results: [
			{
				taskId: `${subagentRunId}:0`,
				teamRunId: "team-run-1",
				teamTaskId: taskId,
				role: "implementer",
				done: false,
				output: "",
			},
		],
	});
}

let failed = 0;

function pass(name: string): void {
	console.log(`PASS: ${name}`);
}

function fail(name: string, detail: string): void {
	failed++;
	console.log(`FAIL: ${name}: ${detail}`);
}

function assert(name: string, condition: boolean, detail: string): void {
	if (condition) pass(name);
	else fail(name, detail);
}

async function testTeamToolsFollowActiveRun(): Promise<void> {
	const name = "0. team tools follow active run and remain loaded after cancellation";
	const pi = new FakePi();
	pi.activeTools.push("team_plan", "team_retry", "team_complete");
	install(pi);
	await pi.emit("session_start", {}, fakeCtx());
	if (["team_plan", "team_retry", "team_complete"].some((tool) => pi.activeTools.includes(tool))) {
		fail(name, `inactive startup kept team tools: ${pi.activeTools.join(",")}`);
		return;
	}
	await seedActiveRun(pi, baseRun());
	if (
		!["team_plan", "team_retry", "team_complete", "question"].every((tool) =>
			pi.activeTools.includes(tool),
		)
	) {
		fail(name, `active run did not enable required tools: ${pi.activeTools.join(",")}`);
		return;
	}
	await pi.commands.get("team-cancel")!.handler(undefined, fakeCtx());
	assert(
		name,
		["team_plan", "team_retry", "team_complete"].every((tool) => pi.activeTools.includes(tool)),
		`cancellation removed tools: ${pi.activeTools.join(",")}`,
	);
}

async function testManagerContextIsHiddenAndAuthoritative(): Promise<void> {
	const name = "0. manager context is hidden, tail-oriented, and never changes systemPrompt";
	const pi = new FakePi();
	install(pi);
	await seedActiveRun(pi, baseRun());
	const beforeStart = (
		await pi.emit("before_agent_start", { systemPrompt: "PARENT SYSTEM PROMPT" }, fakeCtx())
	)[0] as any;
	const message = beforeStart?.message;
	assert(
		name,
		beforeStart?.systemPrompt === undefined &&
			message?.customType === "team-manager-context" &&
			message?.display === false &&
			message?.content.includes("AUTHORITATIVE CURRENT SNAPSHOT") &&
			message?.content.includes("Team-specific manager instructions") &&
			message?.content.includes("Roster:") &&
			message?.content.includes("Run ID: team-run-1") &&
			message?.content.includes("Status: executing") &&
			message?.content.includes("Goal: ship it") &&
			message?.content.includes("supersedes every older team-manager-context snapshot") &&
			!pi.handlers.has("context"),
		`beforeStart=${JSON.stringify(beforeStart)} contextHandlers=${pi.handlers.get("context")?.length ?? 0}`,
	);
}

function testDynamicTeamToolsHaveNoPromptMetadata(): void {
	const name = "0. dynamic team tools carry formal descriptions without prompt metadata";
	const pi = new FakePi();
	install(pi);
	const failures = ["team_plan", "team_retry", "team_complete"].filter((toolName) => {
		const tool = pi.tools.get(toolName) as any;
		return (
			!tool ||
			"promptSnippet" in tool ||
			"promptGuidelines" in tool ||
			typeof tool.description !== "string" ||
			tool.description.length === 0
		);
	});
	assert(name, failures.length === 0, `metadata failures=${failures.join(",")}`);
}

async function testInactiveTeamToolsStillReject(): Promise<void> {
	const name = "0. loaded team tools still reject inactive calls through runtime checks";
	const pi = new FakePi();
	install(pi);
	await pi.emit("session_start", {}, fakeCtx());
	const calls: Array<[string, any]> = [
		["team_plan", { summary: "plan", tasks: [] }],
		["team_retry", { taskIds: ["task"], reason: "retry" }],
		["team_complete", { success: false, summary: "stop" }],
	];
	const failures: string[] = [];
	for (const [toolName, params] of calls) {
		try {
			await pi.tools.get(toolName)!.execute("inactive", params, undefined, undefined, fakeCtx());
			failures.push(`${toolName} unexpectedly succeeded`);
		} catch {}
	}
	assert(name, failures.length === 0, failures.join(","));
}

async function testTeamRestorePrefersActiveBranch(): Promise<void> {
	const name = "0. team restoration uses only branch-visible state";
	const pi = new FakePi();
	install(pi);
	const state = { type: "custom", customType: "team-state", data: { run: baseRun() } };
	const sessionManager = {
		getBranch: () => [] as any[],
		getEntries: () => [state],
	};
	await pi.emit("session_start", {}, fakeCtx({ sessionManager }));
	assert(
		`${name} (abandoned history ignored)`,
		!["team_plan", "team_retry", "team_complete"].some((tool) => pi.activeTools.includes(tool)),
		pi.activeTools.join(","),
	);
	sessionManager.getBranch = () => [state];
	await pi.emit("session_start", {}, fakeCtx({ sessionManager }));
	assert(
		name,
		["team_plan", "team_retry", "team_complete"].every((tool) => pi.activeTools.includes(tool)),
		pi.activeTools.join(","),
	);
}

async function testUpdateDoneUnblocksDependents(): Promise<void> {
	const name = "a. subagent:update done=true completes task and unblocks dependents";
	const pi = new FakePi();
	install(pi);
	await seedActiveRun(pi, baseRun());
	await delegateRunning(pi, "impl-1", "sub-run-1");

	pi.events.emit("subagent:update", {
		runId: "sub-run-1",
		startedAt: 1,
		results: [
			{
				teamRunId: "team-run-1",
				teamTaskId: "impl-1",
				role: "implementer",
				done: true,
				output: "implemented",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			},
		],
	});

	const persisted = pi.entries.filter((e) => e.customType === "team-state").at(-1)?.data as {
		run?: ReturnType<typeof baseRun>;
	};
	const impl = persisted?.run?.tasks.find((t) => t.id === "impl-1");
	const review = persisted?.run?.tasks.find((t) => t.id === "review-1");
	assert(
		name,
		impl?.status === "completed" && review?.status === "pending",
		`impl=${impl?.status} review=${review?.status}`,
	);
}

async function testDependencyOutputInjectedIntoPrompt(): Promise<void> {
	const name = "b. dependency references and legacy output bypass manager-side relay";
	const pi = new FakePi();
	install(pi);
	await seedActiveRun(
		pi,
		baseRun({
			tasks: [
				{
					id: "impl-1",
					title: "Implement",
					description: "Do the work",
					role: "implementer",
					dependsOn: [],
					model: "test/model",
					thinking: "off",
					workspace: "shared",
					status: "completed",
					subagentRunId: "sub-run-impl",
					subagentTaskId: "sub-run-impl:0",
					output: "implementation evidence",
				},
				{
					id: "legacy-1",
					title: "Legacy research",
					description: "Old completed work",
					role: "implementer",
					dependsOn: [],
					model: "test/model",
					thinking: "off",
					workspace: "shared",
					status: "completed",
					output: "legacy persisted evidence",
				},
				{
					id: "review-1",
					title: "Review",
					description: "Review the work",
					role: "reviewer",
					dependsOn: ["impl-1", "legacy-1"],
					model: "test/model",
					thinking: "off",
					workspace: "shared",
					status: "pending",
				},
			],
		}),
	);
	const input = {
		tasks: [{ teamRunId: "team-run-1", teamTaskId: "review-1", task: "placeholder" }],
	};
	await pi.emit("tool_call", { toolName: "subagent", toolCallId: "tc-handoff", input });
	const spec = input.tasks[0] as (typeof input.tasks)[0] & {
		inputFrom?: Array<{ runId: string; taskId: string }>;
		handoffs?: Array<{ source: string; output: string }>;
	};
	assert(
		name,
		spec.task === "Review the work" &&
			spec.inputFrom?.length === 1 &&
			spec.inputFrom[0].runId === "sub-run-impl" &&
			spec.inputFrom[0].taskId === "sub-run-impl:0" &&
			spec.handoffs?.length === 1 &&
			spec.handoffs[0].source === "team:team-run-1/legacy-1" &&
			spec.handoffs[0].output === "legacy persisted evidence",
		`spec=${JSON.stringify(spec)}`,
	);
}

async function testUpdateErrorMarksFailed(): Promise<void> {
	const name = "b. subagent:update with error marks the task failed";
	const pi = new FakePi();
	install(pi);
	await seedActiveRun(pi, baseRun());
	await delegateRunning(pi, "impl-1", "sub-run-1");

	pi.events.emit("subagent:update", {
		runId: "sub-run-1",
		startedAt: 1,
		results: [
			{
				teamRunId: "team-run-1",
				teamTaskId: "impl-1",
				role: "implementer",
				done: true,
				error: "boom",
				output: "",
			},
		],
	});

	const persisted = pi.entries.filter((e) => e.customType === "team-state").at(-1)?.data as {
		run?: ReturnType<typeof baseRun>;
	};
	const impl = persisted?.run?.tasks.find((t) => t.id === "impl-1");
	assert(name, impl?.status === "failed" && impl?.error === "boom", `impl=${JSON.stringify(impl)}`);
}

async function testManualKillRequiresApprovedRetry(): Promise<void> {
	const name = "c. manually killed team task requires explicit retry approval";
	const pi = new FakePi();
	install(pi);
	await seedActiveRun(pi, baseRun());
	await delegateRunning(pi, "impl-1", "sub-run-manual");
	pi.events.emit("subagent:update", {
		runId: "sub-run-manual",
		startedAt: 1,
		results: [
			{
				teamRunId: "team-run-1",
				teamTaskId: "impl-1",
				done: true,
				error: "Manually killed by the user",
				manualKill: true,
				output: "",
			},
		],
	});
	const retry = pi.tools.get("team_retry");
	if (!retry) {
		fail(name, "team_retry tool missing");
		return;
	}
	let blocked = false;
	try {
		await retry.execute(
			"retry-1",
			{ taskIds: ["impl-1"], reason: "try again" },
			undefined,
			undefined,
			fakeCtx(),
		);
	} catch (error) {
		blocked = String(error).includes("explicit approval");
	}
	await retry.execute(
		"retry-2",
		{ taskIds: ["impl-1"], reason: "user approved", userApprovedManualRetry: true },
		undefined,
		undefined,
		fakeCtx(),
	);
	const persisted = pi.entries.filter((entry) => entry.customType === "team-state").at(-1)
		?.data as {
		run?: ReturnType<typeof baseRun>;
	};
	const task = persisted.run?.tasks.find((item) => item.id === "impl-1");
	assert(name, blocked && task?.status === "pending" && !task.manualKill, JSON.stringify(task));
}

async function testSpawnEndSuccessDoesNotFail(): Promise<void> {
	const name = "c. tool_execution_end spawn success does not fail running tasks";
	const pi = new FakePi();
	install(pi);
	await seedActiveRun(pi, baseRun());
	await delegateRunning(pi, "impl-1", "sub-run-spawn", "tc-spawn");
	await pi.emit("tool_execution_end", {
		toolName: "subagent",
		toolCallId: "tc-spawn",
		isError: false,
	});

	const persisted = pi.entries.filter((e) => e.customType === "team-state").at(-1)?.data as {
		run?: ReturnType<typeof baseRun>;
	};
	const impl = persisted?.run?.tasks.find((t) => t.id === "impl-1");
	assert(
		name,
		impl?.status === "running" && impl?.subagentRunId === "sub-run-spawn",
		`impl=${JSON.stringify(impl)}`,
	);
}

async function testSpawnEndErrorFailsUnlinked(): Promise<void> {
	const name = "d. tool_execution_end spawn error fails tasks lacking subagentRunId";
	const pi = new FakePi();
	install(pi);
	await seedActiveRun(pi, baseRun());

	await pi.emit("tool_call", {
		toolName: "subagent",
		toolCallId: "tc-fail",
		input: {
			tasks: [{ teamRunId: "team-run-1", teamTaskId: "impl-1", task: "x" }],
		},
	});
	await pi.emit("tool_execution_end", {
		toolName: "subagent",
		toolCallId: "tc-fail",
		isError: true,
	});

	const persisted = pi.entries.filter((e) => e.customType === "team-state").at(-1)?.data as {
		run?: ReturnType<typeof baseRun>;
	};
	const impl = persisted?.run?.tasks.find((t) => t.id === "impl-1");
	assert(
		name,
		impl?.status === "failed" &&
			impl?.error === "Subagent delegation failed before execution" &&
			!impl?.subagentRunId,
		`impl=${JSON.stringify(impl)}`,
	);
}

async function testTeamCancelKillsChildren(): Promise<void> {
	const name = "e. /team-cancel kills children of the active run";
	const pi = new FakePi();
	const killCalls: Array<readonly string[] | undefined> = [];
	install(pi, (runIds) => {
		killCalls.push(runIds);
		return runIds?.length ?? 0;
	});
	await seedActiveRun(pi, baseRun());
	await delegateRunning(pi, "impl-1", "sub-run-1");

	const command = pi.commands.get("team-cancel");
	if (!command) {
		fail(name, "team-cancel command missing");
		return;
	}
	await command.handler(undefined, fakeCtx());

	const persisted = pi.entries.filter((e) => e.customType === "team-state").at(-1)?.data as {
		run?: ReturnType<typeof baseRun>;
	};
	assert(
		name,
		killCalls.length === 1 &&
			Array.isArray(killCalls[0]) &&
			killCalls[0]!.length === 1 &&
			killCalls[0]![0] === "sub-run-1" &&
			persisted?.run?.status === "cancelled",
		`kills=${JSON.stringify(killCalls)} status=${persisted?.run?.status}`,
	);
}

async function testTeamCompleteRefusesUnfinished(): Promise<void> {
	const name = "f. team_complete refuses success with unfinished tasks";
	const pi = new FakePi();
	install(pi);
	await seedActiveRun(pi, baseRun());

	const tool = pi.tools.get("team_complete");
	if (!tool) {
		fail(name, "team_complete tool missing");
		return;
	}
	let threw = false;
	let message = "";
	try {
		await tool.execute(
			"tc-complete",
			{ success: true, summary: "done" },
			undefined,
			undefined,
			fakeCtx(),
		);
	} catch (error) {
		threw = true;
		message = error instanceof Error ? error.message : String(error);
	}
	assert(
		name,
		threw && message.includes("Cannot report success with unfinished tasks"),
		`threw=${threw} message=${message}`,
	);
}

async function testTeamCompletionKeepsToolsAndEmitsMarker(): Promise<void> {
	const name = "f. completed team keeps tools and emits a deactivation marker";
	const pi = new FakePi();
	install(pi);
	await seedActiveRun(
		pi,
		baseRun({
			tasks: [
				{ ...baseRun().tasks[0], status: "completed" },
				{ ...baseRun().tasks[1], status: "completed" },
				{
					id: "verify-1",
					title: "Verify",
					description: "Verify the work",
					role: "verifier",
					dependsOn: ["impl-1"],
					model: "test/model",
					thinking: "off",
					workspace: "shared",
					status: "completed",
				},
			],
		}),
	);
	await pi.tools
		.get("team_complete")!
		.execute("tc-success", { success: true, summary: "verified" }, undefined, undefined, fakeCtx());
	await pi.emit("agent_settled", {}, fakeCtx());
	const beforeStart = (
		await pi.emit("before_agent_start", { systemPrompt: "PARENT SYSTEM PROMPT" }, fakeCtx())
	)[0] as any;
	const marker = beforeStart?.message;
	pi.activeTools = pi.activeTools.filter(
		(tool) => !["team_plan", "team_retry", "team_complete"].includes(tool),
	);
	await pi.emit("session_start", {}, fakeCtx({ sessionManager: { getEntries: () => pi.entries } }));
	assert(
		name,
		["team_plan", "team_retry", "team_complete"].every((tool) => pi.activeTools.includes(tool)) &&
			beforeStart?.systemPrompt === undefined &&
			marker?.customType === "team-manager-context" &&
			marker?.display === false &&
			marker?.content.includes("DEACTIVATED") &&
			marker?.content.includes("supersedes every older team-manager-context snapshot"),
		`tools=${pi.activeTools.join(",")} beforeStart=${JSON.stringify(beforeStart)}`,
	);
}

function fakeDashboardDeps(rows = 24) {
	const renders: number[] = [];
	const tui = {
		terminal: { rows },
		requestRender: () => {
			renders.push(1);
		},
		invalidate: () => {},
	};
	const theme = {
		fg: (_c: string, text: string) => text,
		bold: (text: string) => text,
		bg: (_c: string, text: string) => text,
	};
	const keybindings = {
		matches: (_data: string, _binding: string) => false,
	};
	return { tui, theme, keybindings, renders };
}

async function testDashboardKillRunningTask(): Promise<void> {
	const name = "g. /teams dashboard k kills selected running task via killSubagentRuns";
	const killCalls: Array<readonly string[] | undefined> = [];
	const pi = new FakePi();
	install(pi, (runIds) => {
		killCalls.push(runIds);
		return runIds?.length ?? 0;
	});
	await seedActiveRun(pi, baseRun());
	await delegateRunning(pi, "impl-1", "sub-run-dash");

	const { tui, theme, keybindings } = fakeDashboardDeps();
	let dashboard: InstanceType<typeof TeamDashboard> | undefined;
	let customOptions: any;
	const ctx = fakeCtx({
		mode: "tui",
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_c: string, text: string) => text },
			custom: async (factory: any, options: any) => {
				customOptions = options;
				dashboard = factory(tui, theme, keybindings, () => {});
			},
			confirm: async () => true,
			select: async () => undefined,
			input: async () => undefined,
		},
	});

	const command = pi.commands.get("teams");
	if (!command) {
		fail(name, "teams command missing");
		return;
	}
	await command.handler(undefined, ctx);
	if (!dashboard) {
		fail(name, "dashboard was not constructed");
		return;
	}
	assert(
		`${name} uses a true fullscreen overlay`,
		customOptions?.overlay === true &&
			customOptions?.overlayOptions?.width === "100%" &&
			customOptions?.overlayOptions?.maxHeight === "100%",
		JSON.stringify(customOptions),
	);

	dashboard.handleInput("k"); // arm
	assert(
		`${name} (armed, not yet killed)`,
		killCalls.length === 0,
		`premature kill=${JSON.stringify(killCalls)}`,
	);
	dashboard.handleInput("k"); // confirm

	const persisted = pi.entries.filter((e) => e.customType === "team-state").at(-1)?.data as {
		run?: ReturnType<typeof baseRun>;
	};
	const impl = persisted?.run?.tasks.find((t) => t.id === "impl-1");
	const review = persisted?.run?.tasks.find((t) => t.id === "review-1");
	assert(
		name,
		killCalls.length === 1 &&
			Array.isArray(killCalls[0]) &&
			killCalls[0]![0] === "sub-run-dash" &&
			impl?.status === "failed" &&
			impl?.manualKill === true &&
			impl?.error?.includes("Manually killed by the user") === true &&
			review?.status === "blocked",
		`kills=${JSON.stringify(killCalls)} impl=${JSON.stringify(impl)} review=${review?.status}`,
	);
}

async function testDashboardKillNoopOnCompleted(): Promise<void> {
	const name = "h. /teams dashboard k is a no-op on non-running tasks";
	const { tui, theme, keybindings } = fakeDashboardDeps();
	const killCalls: Array<[string, string]> = [];
	const run = baseRun({
		tasks: [
			{
				id: "impl-1",
				title: "Implement",
				description: "Do the work",
				role: "implementer",
				dependsOn: [],
				model: "test/model",
				thinking: "off",
				workspace: "shared",
				status: "completed",
				subagentRunId: "sub-done",
			},
			{
				id: "review-1",
				title: "Review",
				description: "Review the work",
				role: "reviewer",
				dependsOn: ["impl-1"],
				model: "test/model",
				thinking: "off",
				workspace: "shared",
				status: "pending",
			},
		],
	});

	const dashboard = new TeamDashboard(
		tui as any,
		theme as any,
		keybindings as any,
		() => [run as any],
		() => () => {},
		() => {},
		(runId, taskId) => {
			killCalls.push([runId, taskId]);
		},
	);

	dashboard.handleInput("k");
	dashboard.handleInput("k");
	dashboard.handleInput("k");

	assert(name, killCalls.length === 0, `unexpected kills=${JSON.stringify(killCalls)}`);
}

async function testDashboardFootersMatchSubagents(): Promise<void> {
	const name = "i. /teams dashboard footers include k kill running like /subagents";
	const { tui, theme, keybindings } = fakeDashboardDeps();
	const run = baseRun({
		tasks: [
			{
				id: "impl-1",
				title: "Implement",
				description: "Do the work",
				role: "implementer",
				dependsOn: [],
				model: "test/model",
				thinking: "off",
				workspace: "shared",
				status: "running",
				subagentRunId: "sub-1",
			},
		],
	});
	const dashboard = new TeamDashboard(
		tui as any,
		theme as any,
		keybindings as any,
		() => [run as any],
		() => () => {},
		() => {},
		() => {},
	);

	// Narrow mode: run list and task list footers without split truncation.
	const runView = dashboard.render(80).join("\n");
	dashboard.handleInput("\t"); // focus tasks
	const taskView = dashboard.render(80).join("\n");
	assert(
		name,
		runView.includes("↑↓ select  Enter/Tab tasks  k kill running  Esc close") &&
			taskView.includes("↑↓ select  Tab/Esc teams  k kill running  /subagents transcripts"),
		`runView=${runView}\ntaskView=${taskView}`,
	);
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function testPlanReviewRendersMarkdownCardAndSpacing(): void {
	const name = "j. team plan review renders a padded markdown card with separated controls";
	const { tui, keybindings } = fakeDashboardDeps();
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		bg: (color: string, text: string) =>
			`\x1b[48;5;${color === "toolPendingBg" ? "236" : "237"}m${text}\x1b[49m`,
	};
	const task = baseRun().tasks[0];
	const markdown = formatTeamPlanMarkdown("demo", "Ship **carefully**.", [task as any]);
	let choice: string | undefined;
	const review = new TeamPlanReview(
		tui as any,
		theme as any,
		keybindings as any,
		"demo",
		"Ship **carefully**.",
		[task as any],
		(value: string | undefined) => {
			choice = value;
		},
	);
	const lines = review.render(80);
	const plain = lines.map((line: string) => stripAnsi(line));
	const headingIndex = plain.findIndex((line: string) => line.includes("demo team plan"));
	const actionsIndex = plain.findIndex((line: string) => line.includes("Approve plan"));
	const helpIndex = plain.findIndex((line: string) => line.includes("PgUp/PgDn review"));

	review.handleInput("\t");
	review.handleInput("\r");
	assert(
		name,
		markdown.includes("# demo team plan") &&
			markdown.includes("## Tasks") &&
			markdown.includes("### 1. Implement") &&
			headingIndex > 0 &&
			lines[headingIndex].includes("\x1b[48;5;236m") &&
			actionsIndex > headingIndex &&
			plain[actionsIndex - 1].includes("─") &&
			plain[actionsIndex + 1].includes("↑↓/PgUp/PgDn review") &&
			helpIndex === actionsIndex + 1 &&
			plain[helpIndex + 1].trim() === "" &&
			choice === "revise",
		`markdown=${markdown}\nlines=${plain.join("\\n")} choice=${choice}`,
	);
}

function testTeamViewsKeepExactBoundsAcrossStates(): void {
	const name = "k. team screens use shared chrome and exact-width responsive rendering";
	const { tui, theme, keybindings } = fakeDashboardDeps(12);
	const runs = [
		baseRun({ status: "completed", completionSummary: "Verified" }),
		baseRun({
			id: "team-run-2",
			status: "failed",
			tasks: [{ ...baseRun().tasks[0], status: "failed", error: "Build failed" }],
		}),
	];
	const dashboard = new TeamDashboard(
		tui as any,
		theme as any,
		keybindings as any,
		() => runs as any,
		() => () => {},
		() => {},
		() => {},
	);
	const plan = new TeamPlanReview(
		tui as any,
		theme as any,
		keybindings as any,
		"demo",
		"Ship safely",
		[baseRun().tasks[0] as any],
		() => {},
	);
	const failures: string[] = [];
	for (const width of [1, 3, 80, 120]) {
		for (const [label, view] of [
			["dashboard", dashboard],
			["plan", plan],
		] as const) {
			const lines = view.render(width);
			if (lines.length !== 12 || lines.some((line) => visibleWidth(line) !== width)) {
				failures.push(
					`${label}@${width}: ${lines.length} lines, widths=${lines.map(visibleWidth).join(",")}`,
				);
			}
		}
	}
	const dashboardText = dashboard.render(120).join("\\n");
	assert(
		name,
		failures.length === 0 &&
			dashboardText.includes("completed") &&
			dashboardText.includes("failed") &&
			dashboardText.includes("✓") &&
			dashboardText.includes("✗"),
		`${failures.join("; ")}\\n${dashboardText}`,
	);
}

function testTeamToolRenderersStayMinimalAndExpandable(): void {
	const name = "l. team tools stay hidden until expanded and keep failures visible";
	const pi = new FakePi();
	install(pi);
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const run = {
		id: "team-run-1",
		teamName: "demo",
		status: "executing",
		tasks: [{ id: "task-1" }],
	};
	const cases = [
		{
			name: "team_plan",
			args: { summary: "Ship safely", tasks: [{ id: "task-1" }] },
			result: {
				content: [{ type: "text", text: "Plan approved with ready tasks" }],
				details: { run, approved: true },
			},
		},
		{
			name: "team_retry",
			args: { taskIds: ["task-1"], reason: "Failure corrected" },
			result: { content: [{ type: "text", text: "Reset task-1 for retry" }], details: { run } },
		},
		{
			name: "team_complete",
			args: { success: true, summary: "Verified" },
			result: {
				content: [{ type: "text", text: "demo team completed: Verified" }],
				details: { run: { ...run, status: "completed" } },
			},
		},
	];
	const failures: string[] = [];
	for (const item of cases) {
		const tool = pi.tools.get(item.name) as any;
		const collapsedCall = tool
			.renderCall(item.args, theme, { expanded: false, isError: false })
			.render(120)
			.join("\n");
		const collapsedResult = tool
			.renderResult(item.result, { expanded: false, isPartial: false }, theme, {
				expanded: false,
				isError: false,
			})
			.render(120)
			.join("\n");
		const expandedCall = tool
			.renderCall(item.args, theme, { expanded: true, isError: false })
			.render(120)
			.join("\n");
		const expandedResult = tool
			.renderResult(item.result, { expanded: true, isPartial: false }, theme, {
				expanded: true,
				isError: false,
			})
			.render(120)
			.join("\n");
		const errorResult = tool
			.renderResult(
				{ content: [{ type: "text", text: `${item.name} failed` }] },
				{ expanded: false, isPartial: false },
				theme,
				{ expanded: false, isError: true },
			)
			.render(120)
			.join("\n");
		if (
			tool.renderShell !== "self" ||
			collapsedCall !== "" ||
			collapsedResult !== "" ||
			!expandedCall.includes(item.name.replace("_", " ")) ||
			!expandedResult.includes(item.result.content[0].text) ||
			!errorResult.includes("failed")
		) {
			failures.push(
				`${item.name}: collapsedCall=${collapsedCall} collapsedResult=${collapsedResult} expandedCall=${expandedCall} expandedResult=${expandedResult} error=${errorResult}`,
			);
		}
	}
	assert(name, failures.length === 0, failures.join("\n"));
}

async function testRoleInstructionsStampedOnDelegation(): Promise<void> {
	const name = "d. team stamps trusted roleInstructions and strips manager-supplied values";
	const pi = new FakePi();
	install(pi);
	await seedActiveRun(
		pi,
		baseRun({
			tasks: [
				{
					id: "review-1",
					title: "Review",
					description: "Review the work",
					role: "reviewer",
					dependsOn: [],
					model: "test/model",
					thinking: "off",
					workspace: "shared",
					status: "pending",
				},
				{
					id: "impl-1",
					title: "Implement",
					description: "Do the work",
					role: "implementer",
					dependsOn: [],
					model: "test/model",
					thinking: "off",
					workspace: "shared",
					status: "pending",
				},
			],
		}),
	);
	const reviewInput = {
		tasks: [
			{
				teamRunId: "team-run-1",
				teamTaskId: "review-1",
				task: "placeholder",
				roleInstructions: "manager-forged persona",
			},
		],
	};
	await pi.emit("tool_call", {
		toolName: "subagent",
		toolCallId: "tc-role-review",
		input: reviewInput,
	});
	const reviewSpec = reviewInput.tasks[0] as (typeof reviewInput.tasks)[0] & {
		roleInstructions?: string;
		role?: string;
	};
	const implInput = {
		tasks: [
			{
				teamRunId: "team-run-1",
				teamTaskId: "impl-1",
				task: "placeholder",
				roleInstructions: "should be stripped",
			},
		],
	};
	await pi.emit("tool_call", {
		toolName: "subagent",
		toolCallId: "tc-role-impl",
		input: implInput,
	});
	const implSpec = implInput.tasks[0] as (typeof implInput.tasks)[0] & {
		roleInstructions?: string;
	};
	assert(
		name,
		reviewSpec.role === "reviewer" &&
			reviewSpec.roleInstructions === "Challenge correctness with concrete file evidence." &&
			implSpec.roleInstructions === undefined,
		`review=${JSON.stringify(reviewSpec)} impl=${JSON.stringify(implSpec)}`,
	);
}

function testRoleInstructionsValidation(): void {
	const name = "d. role instructions validation accepts omit and rejects empty or oversized";
	const base = {
		name: "validation",
		description: "Validation team",
		manager: {
			model: "test/model",
			thinking: "off" as const,
			instructions: "Coordinate.",
		},
		roles: {
			builder: {
				description: "Builds",
			},
			gate: {
				description: "Gates",
				review: true,
				verification: true,
			},
		},
	};
	const ok = validateTeamDefinition(
		{
			...base,
			roles: {
				...base.roles,
				builder: {
					description: "Builds",
					instructions: "  Stay focused.  ",
				},
			},
		},
		"test://ok",
	);
	let emptyError = "";
	try {
		validateTeamDefinition(
			{
				...base,
				roles: {
					...base.roles,
					builder: { description: "Builds", instructions: "   " },
				},
			},
			"test://empty",
		);
	} catch (error) {
		emptyError = error instanceof Error ? error.message : String(error);
	}
	let oversizedError = "";
	try {
		validateTeamDefinition(
			{
				...base,
				roles: {
					...base.roles,
					builder: {
						description: "Builds",
						instructions: "x".repeat(MAX_ROLE_INSTRUCTIONS_CHARS + 1),
					},
				},
			},
			"test://oversized",
		);
	} catch (error) {
		oversizedError = error instanceof Error ? error.message : String(error);
	}
	assert(
		name,
		ok.roles.builder.instructions === "Stay focused." &&
			emptyError.includes("empty instructions") &&
			oversizedError.includes(`${MAX_ROLE_INSTRUCTIONS_CHARS} characters`),
		`ok=${ok.roles.builder.instructions} empty=${emptyError} oversized=${oversizedError}`,
	);
}

async function main(): Promise<void> {
	await testTeamToolsFollowActiveRun();
	await testManagerContextIsHiddenAndAuthoritative();
	testDynamicTeamToolsHaveNoPromptMetadata();
	await testInactiveTeamToolsStillReject();
	await testTeamRestorePrefersActiveBranch();
	await testUpdateDoneUnblocksDependents();
	await testDependencyOutputInjectedIntoPrompt();
	await testUpdateErrorMarksFailed();
	await testManualKillRequiresApprovedRetry();
	await testSpawnEndSuccessDoesNotFail();
	await testSpawnEndErrorFailsUnlinked();
	await testTeamCancelKillsChildren();
	await testTeamCompleteRefusesUnfinished();
	await testTeamCompletionKeepsToolsAndEmitsMarker();
	await testDashboardKillRunningTask();
	await testDashboardKillNoopOnCompleted();
	await testDashboardFootersMatchSubagents();
	await testRoleInstructionsStampedOnDelegation();
	testRoleInstructionsValidation();
	testPlanReviewRendersMarkdownCardAndSpacing();
	testTeamViewsKeepExactBoundsAcrossStates();
	testTeamToolRenderersStayMinimalAndExpandable();

	if (failed > 0) {
		console.log(`\n${failed} failing`);
		process.exit(1);
	}
	console.log("\nAll cases passed");
}

await main();

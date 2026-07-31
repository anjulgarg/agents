/**
 * Deterministic supervisor tests with a fake RpcChild.
 *
 * Run: npm run test:extensions
 */
import { emptyUsage, type RpcChildOptions, type RpcEvent, type UsageStats } from "./rpc-client.ts";
import { Supervisor, type ChildHandle, type TaskSpawnSpec } from "./supervisor.ts";

interface Wake {
	content: string;
	deliverAs?: "steer" | "followUp";
}

class FakeChild implements ChildHandle {
	readonly usage: UsageStats = emptyUsage();
	killed = false;
	steered: string[] = [];
	aborted = 0;
	stderr = "";
	exitCode?: number;
	/** When set, prompt() rejects with this error (simulates child death). */
	promptError?: Error;
	private text = "";
	private readonly onEvent?: (event: RpcEvent) => void;
	private readonly onExit?: (code: number) => void;
	readonly ownerToken?: string;

	constructor(options: RpcChildOptions) {
		this.onEvent = options.onEvent;
		this.onExit = options.onExit;
		this.ownerToken = options.ownerToken;
	}

	prompt(_message: string): Promise<unknown> {
		if (this.promptError) return Promise.reject(this.promptError);
		return Promise.resolve({ type: "response", success: true });
	}

	steer(message: string): Promise<unknown> {
		this.steered.push(message);
		return Promise.resolve({ type: "response", success: true });
	}

	abort(): Promise<unknown> {
		this.aborted++;
		return Promise.resolve({ type: "response", success: true });
	}

	output(): string {
		return this.text;
	}

	kill(): void {
		this.killed = true;
	}

	/** Test helper: emit an arbitrary RPC event to the supervisor. */
	emit(event: RpcEvent): void {
		this.onEvent?.(event);
	}

	/** Test helper: emit an unexpected process exit. */
	exit(code: number): void {
		this.exitCode = code;
		this.onExit?.(code);
	}

	/** Test helper: emit agent_settled with captured output/usage. */
	settle(output: string, usage?: Partial<UsageStats>): void {
		this.text = output;
		if (usage) Object.assign(this.usage, usage);
		this.usage.turns = Math.max(this.usage.turns, 1);
		this.onEvent?.({ type: "agent_settled" });
	}
}

class DeferredTerminateChild extends FakeChild {
	private readonly termination = Promise.withResolvers<boolean>();

	terminate(): Promise<boolean> {
		this.killed = true;
		return this.termination.promise;
	}

	override kill(): void {
		void this.terminate();
	}

	finishTermination(): void {
		this.termination.resolve(true);
	}
}

function baseSpec(overrides: Partial<TaskSpawnSpec> = {}): TaskSpawnSpec {
	return {
		task: "do the thing",
		model: "test/model",
		thinking: "off",
		workspace: "shared",
		cwd: "/tmp",
		systemPromptFile: "/tmp/prompt.md",
		...overrides,
	};
}

async function testPersistentMetadata(): Promise<void> {
	const name = "a. persistent mode and session identity reach child and snapshot";
	const children: FakeChild[] = [];
	let received: RpcChildOptions | undefined;
	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		sendUserMessage: () => {},
		createChild: (options) => {
			received = options;
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});
	try {
		const session = { sessionId: "child-1", sessionDir: "/tmp/child-1" };
		const { runId, taskIds } = supervisor.spawn([
			baseSpec({ mode: "persistent", persistentSession: session }),
		]);
		const before = supervisor.status(runId);
		const task = Array.isArray(before) ? undefined : before.tasks[0];
		assert(name, task?.mode === "persistent" && task.sessionId === "child-1", JSON.stringify(task));
		assert(
			`${name} (child options)`,
			received?.persistentSession?.sessionId === "child-1" &&
				received.persistentSession.sessionDir === "/tmp/child-1",
			JSON.stringify(received),
		);
		children[0].settle("persistent result");
		const after = supervisor.status(runId);
		const completed = Array.isArray(after) ? undefined : after.tasks[0];
		assert(
			`${name} (terminal snapshot)`,
			completed?.mode === "persistent" && completed.sessionId === "child-1" && completed.reaped,
			JSON.stringify(completed),
		);
		void taskIds;
	} finally {
		supervisor.dispose();
	}
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

async function testSpawnReturnsBeforeCompletion(): Promise<void> {
	const name = "a. spawn() returns before any task completes";
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];
	let settled = false;

	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		sendUserMessage: (content, options) => {
			wakes.push({ content: String(content), deliverAs: options?.deliverAs });
		},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});

	try {
		const result = supervisor.spawn([baseSpec()]);
		assert(
			name,
			result.runId.length > 0 && result.taskIds.length === 1 && !settled,
			settled ? "spawn awaited completion" : `runId/taskIds missing: ${JSON.stringify(result)}`,
		);
		const task = supervisor.runs.get(result.runId)?.tasks[0];
		assert(
			`${name} (still running)`,
			task?.status === "running",
			`expected running, got ${task?.status}`,
		);
		settled = true;
		children[0].settle("done");
	} finally {
		supervisor.dispose();
	}
}

async function testSteerWhenParentRunning(): Promise<void> {
	const name = 'b. completion while parent RUNNING wakes with deliverAs "steer"';
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];

	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		sendUserMessage: (content, options) => {
			wakes.push({ content: String(content), deliverAs: options?.deliverAs });
		},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});

	try {
		supervisor.spawn([baseSpec({ task: "steer-me" })]);
		// Parent never settled → still running.
		children[0].settle("all good");
		assert(
			name,
			wakes.length === 1 && wakes[0].deliverAs === "steer",
			`wakes=${JSON.stringify(wakes)}`,
		);
		assert(
			`${name} (terse)`,
			!wakes[0].content.includes("all good".repeat(2)) && wakes[0].content.includes("done"),
			`wake payload: ${wakes[0].content}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testPlainWakeWhenParentWaiting(): Promise<void> {
	const name = "c. completion while parent WAITING wakes plainly";
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];

	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		sendUserMessage: (content, options) => {
			wakes.push({ content: String(content), deliverAs: options?.deliverAs });
		},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});

	try {
		supervisor.spawn([baseSpec({ task: "wait-me" })]);
		supervisor.onParentSettled();
		children[0].settle("finished waiting");
		assert(
			name,
			wakes.length === 1 && wakes[0].deliverAs === undefined,
			`wakes=${JSON.stringify(wakes)}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testRaceExactlyOneWake(): Promise<void> {
	const name = "d. race: completion between settle-check and flag → exactly one wake";
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];

	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		sendUserMessage: (content, options) => {
			wakes.push({ content: String(content), deliverAs: options?.deliverAs });
		},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
		betweenSettleCheckAndWait: () => {
			children[0].settle("raced");
		},
	});

	try {
		supervisor.spawn([baseSpec({ task: "race-me" })]);
		supervisor.onParentSettled();
		assert(
			name,
			wakes.length === 1,
			`expected 1 wake, got ${wakes.length}: ${JSON.stringify(wakes)}`,
		);
		assert(
			`${name} (plain, not steer)`,
			wakes[0]?.deliverAs === undefined,
			`expected plain wake from recheck, got ${JSON.stringify(wakes[0])}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testHardTimeout(): Promise<void> {
	const name = "e. hard timeout → task failed AND a wake fires";
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];

	const supervisor = new Supervisor({
		taskTimeoutMs: 30,
		watchdogTickMs: 0,
		sendUserMessage: (content, options) => {
			wakes.push({ content: String(content), deliverAs: options?.deliverAs });
		},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});

	try {
		const { runId } = supervisor.spawn([baseSpec({ task: "hang forever" })]);
		await new Promise((resolve) => setTimeout(resolve, 80));
		const task = supervisor.runs.get(runId)?.tasks[0];
		assert(
			name,
			task?.status === "failed" && !!task.error?.includes("timed out") && wakes.length >= 1,
			`status=${task?.status} error=${task?.error} wakes=${JSON.stringify(wakes)}`,
		);
		assert(`${name} (child killed)`, children[0].killed, "child was not killed on timeout");
	} finally {
		supervisor.dispose();
	}
}

async function testKillAll(): Promise<void> {
	const name = "f. silent killAll() kills every tracked child without waking the parent";
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];

	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		sendUserMessage: (content, options) => {
			wakes.push({ content: String(content), deliverAs: options?.deliverAs });
		},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});

	try {
		supervisor.spawn([baseSpec({ task: "a" }), baseSpec({ task: "b" }), baseSpec({ task: "c" })]);
		supervisor.killAll({ notifyParent: false });
		assert(
			name,
			children.length === 3 && children.every((child) => child.killed) && wakes.length === 0,
			`killed=${children.map((child) => child.killed).join(",")} wakes=${JSON.stringify(wakes)}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testSilentKillDuringFinalization(): Promise<void> {
	const name = "f. silent kill suppresses a completion wake already awaiting child cleanup";
	const wakes: Wake[] = [];
	let child: DeferredTerminateChild | undefined;
	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		sendUserMessage: (content, options) => {
			wakes.push({ content: String(content), deliverAs: options?.deliverAs });
		},
		createChild: (options) => {
			child = new DeferredTerminateChild(options);
			return child;
		},
	});

	try {
		supervisor.spawn([baseSpec({ task: "finishing" })]);
		child?.settle("finished just before Escape");
		supervisor.killAll({ notifyParent: false });
		child?.finishTermination();
		await Promise.resolve();
		await Promise.resolve();
		assert(
			name,
			child?.killed === true && wakes.length === 0,
			`killed=${child?.killed} wakes=${JSON.stringify(wakes)}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testSteerControlSurface(): Promise<void> {
	const name = "g. steer() on running reaches child; on done rejects";
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];

	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		sendUserMessage: (content, options) => {
			wakes.push({ content: String(content), deliverAs: options?.deliverAs });
		},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});

	try {
		const { runId, taskIds } = supervisor.spawn([baseSpec({ task: "steer-target" })]);
		await supervisor.steer(runId, taskIds[0], "nudge");
		assert(
			`${name} (running)`,
			children[0].steered.length === 1 && children[0].steered[0] === "nudge",
			`steered=${JSON.stringify(children[0].steered)}`,
		);

		children[0].settle("done after steer");
		let rejected = false;
		try {
			await supervisor.steer(runId, taskIds[0], "too late");
		} catch {
			rejected = true;
		}
		assert(`${name} (done rejects)`, rejected, "steer on done task did not reject");
		assert(
			`${name} (no extra steer)`,
			children[0].steered.length === 1,
			`steered after reject=${JSON.stringify(children[0].steered)}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testAbortTask(): Promise<void> {
	const name = "h. abortTask() reaches the child";
	const children: FakeChild[] = [];

	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		sendUserMessage: () => {},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});

	try {
		const { runId, taskIds } = supervisor.spawn([baseSpec({ task: "abort-me" })]);
		await supervisor.abortTask(runId, taskIds[0]);
		assert(name, children[0].aborted === 1, `aborted=${children[0].aborted}`);
	} finally {
		supervisor.dispose();
	}
}

async function testStatusTerse(): Promise<void> {
	const name = "i. status() returns terse snapshot with no transcript/messages";
	const children: FakeChild[] = [];

	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		sendUserMessage: () => {},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});

	try {
		const { runId } = supervisor.spawn([baseSpec({ task: "status-me" })]);
		children[0].settle("secret transcript body that must not appear");
		const snap = supervisor.status(runId);
		const json = JSON.stringify(snap);
		assert(
			name,
			typeof snap === "object" &&
				!Array.isArray(snap) &&
				snap.runId === runId &&
				snap.tasks.length === 1 &&
				snap.tasks[0].status === "done" &&
				!("messages" in snap) &&
				!("messages" in snap.tasks[0]) &&
				!("transcript" in snap) &&
				!("transcript" in snap.tasks[0]) &&
				!("output" in snap.tasks[0]) &&
				!json.includes("secret transcript"),
			`snapshot=${json}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testStatusReportsObjectiveActivity(): Promise<void> {
	const name = "i. status reports event age and tool activity without idle classification";
	const children: FakeChild[] = [];
	let clock = 10_000;
	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		now: () => clock,
		sendUserMessage: () => {},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});

	try {
		const { runId } = supervisor.spawn([baseSpec({ task: "activity" })]);
		children[0].emit({
			type: "tool_execution_start",
			toolCallId: "write-1",
			toolName: "write",
			args: { path: "/tmp/result" },
		});
		clock += 2_500;
		const snapshot = supervisor.status(runId);
		const task = Array.isArray(snapshot) ? undefined : snapshot.tasks[0];
		assert(
			name,
			task?.activity?.eventAgeMs === 2_500 &&
				task.activity.token.endsWith(":1") &&
				task.activity.lastToolName === "write" &&
				task.activity.openToolName === "write" &&
				task.activity.hasEditOrWrite === true &&
				task.activity.changedFiles[0] === "/tmp/result" &&
				task.activity.recentTools[0]?.status === "running" &&
				!("idle" in task.activity),
			`activity=${JSON.stringify(task?.activity)}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testResultDetail(): Promise<void> {
	const name = "j. result() returns output+usage for a completed task";
	const children: FakeChild[] = [];

	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		sendUserMessage: () => {},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});

	try {
		const { runId, taskIds } = supervisor.spawn([baseSpec({ task: "result-me" })]);
		children[0].settle("final answer", { input: 10, output: 20, cost: 0.05, turns: 2 });
		const result = supervisor.result(runId, taskIds[0]);
		assert(
			name,
			result.output === "final answer" &&
				result.usage.input === 10 &&
				result.usage.output === 20 &&
				result.usage.cost === 0.05 &&
				result.usage.turns === 2 &&
				result.error === undefined,
			`result=${JSON.stringify(result)}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testManualKillMetadata(): Promise<void> {
	const name = "k. manual kill records retry-blocking metadata and wakes parent";
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];
	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		sendUserMessage: (content, options) => {
			wakes.push({ content: String(content), deliverAs: options?.deliverAs });
		},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});
	try {
		const { runId, taskIds } = supervisor.spawn([baseSpec({ task: "manual-kill" })]);
		supervisor.killTask(runId, taskIds[0], true);
		const result = supervisor.result(runId, taskIds[0]);
		assert(
			name,
			children[0].killed &&
				result.manualKill === true &&
				wakes[0]?.content.includes("Do not retry"),
			`result=${JSON.stringify(result)} wakes=${JSON.stringify(wakes)}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testSoftSignalStuckInTool(): Promise<void> {
	const name = "k. soft STUCK_IN_TOOL wakes once, steerable=false, does not kill";
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];
	let clock = 100_000;

	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		stuckDetectorOptions: { silenceMs: 5_000 },
		now: () => clock,
		sendUserMessage: (content, options) => {
			wakes.push({ content: String(content), deliverAs: options?.deliverAs });
		},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});

	try {
		const { runId, taskIds } = supervisor.spawn([baseSpec({ task: "tool-wedge" })]);
		children[0].emit({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "bash",
			args: { command: "sleep 999" },
		});
		clock = 105_000;
		supervisor.tickWatchdog(clock);

		const task = supervisor.runs.get(runId)?.tasks[0];
		assert(
			name,
			wakes.length === 1 &&
				wakes[0].content.includes("steerable=false") &&
				wakes[0].deliverAs === "steer" &&
				task?.status === "running" &&
				!children[0].killed,
			`wakes=${JSON.stringify(wakes)} status=${task?.status} killed=${children[0].killed}`,
		);

		// Case l: second tick on same latched signal must not re-wake.
		clock = 106_000;
		supervisor.tickWatchdog(clock);
		assert(
			"l. detector latch: second tick does not re-wake",
			wakes.length === 1,
			`expected 1 wake after second tick, got ${wakes.length}: ${JSON.stringify(wakes)}`,
		);
		assert(
			`${name} (still running after latch)`,
			supervisor.runs.get(runId)?.tasks[0]?.status === "running" && !children[0].killed,
			"task was killed or completed after soft signal",
		);
		void taskIds;
	} finally {
		supervisor.dispose();
	}
}

async function testExitPropagatesStderr(): Promise<void> {
	const name =
		"m. child exit failure carries exitCode + ANSI-stripped stderr in result, terse wake";
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];
	const ansiStderr =
		'\u001b[31mError: Failed to load extension "/tmp/team/index.ts": Extension does not export a valid factory function\u001b[0m\n' +
		"\u001b[90m    at loadExtension (ext.ts:1:1)\u001b[0m\n";

	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		sendUserMessage: (content, options) => {
			wakes.push({ content: String(content), deliverAs: options?.deliverAs });
		},
		createChild: (options) => {
			const child = new FakeChild(options);
			child.exitCode = 1;
			child.stderr = ansiStderr;
			child.promptError = new Error("Subagent process exited");
			children.push(child);
			return child;
		},
	});

	try {
		const { runId, taskIds } = supervisor.spawn([baseSpec({ task: "die at startup" })]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const task = supervisor.runs.get(runId)?.tasks[0];
		const result = supervisor.result(runId, taskIds[0]);
		const wake = wakes[0]?.content ?? "";

		assert(
			name,
			task?.status === "failed" &&
				typeof result.error === "string" &&
				result.error.includes("exited 1") &&
				result.error.includes("Failed to load extension") &&
				!result.error.includes("\u001b[") &&
				!result.error.includes("Subagent process exited") &&
				wakes.length === 1 &&
				wake.includes("failed") &&
				wake.includes("exited 1") &&
				wake.length <= 160 &&
				!wake.includes("\u001b["),
			`status=${task?.status} error=${result.error} wake=${JSON.stringify(wake)} wakeLen=${wake.length}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testExitDoesNotLeakStderrOnSuccess(): Promise<void> {
	const name = "n. success path does not leak stderr into result/wake";
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];

	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		sendUserMessage: (content, options) => {
			wakes.push({ content: String(content), deliverAs: options?.deliverAs });
		},
		createChild: (options) => {
			const child = new FakeChild(options);
			child.stderr = "\u001b[33mwarning noise that must not appear\u001b[0m";
			children.push(child);
			return child;
		},
	});

	try {
		const { runId, taskIds } = supervisor.spawn([baseSpec({ task: "healthy" })]);
		children[0].settle("all clear");
		const result = supervisor.result(runId, taskIds[0]);
		const wake = wakes[0]?.content ?? "";
		assert(
			name,
			result.error === undefined &&
				result.output === "all clear" &&
				!JSON.stringify(result).includes("warning noise") &&
				!wake.includes("warning noise") &&
				!wake.includes("exited"),
			`result=${JSON.stringify(result)} wake=${JSON.stringify(wake)}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testBoundedConcurrency(): Promise<void> {
	const name = "o. maxConcurrency queues tasks and advances one slot at a time";
	const children: FakeChild[] = [];
	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		sendUserMessage: () => {},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});
	try {
		const { runId } = supervisor.spawn(
			[baseSpec({ task: "one" }), baseSpec({ task: "two" }), baseSpec({ task: "three" })],
			1,
		);
		let statuses = supervisor.runs.get(runId)?.tasks.map((task) => task.status);
		assert(
			name,
			children.length === 1 && statuses?.join(",") === "running,queued,queued",
			`children=${children.length} statuses=${statuses}`,
		);
		children[0].settle("one done");
		await new Promise((resolve) => setTimeout(resolve, 0));
		statuses = supervisor.runs.get(runId)?.tasks.map((task) => task.status);
		assert(
			`${name} (advance)`,
			children.length === 2 && statuses?.join(",") === "done,running,queued",
			`children=${children.length} statuses=${statuses}`,
		);
		children[1].settle("two done");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert(`${name} (final slot)`, children.length === 3, `children=${children.length}`);
	} finally {
		supervisor.dispose();
	}
}

async function testGlobalConcurrencyCap(): Promise<void> {
	const name = "p. global child cap applies across independent runs";
	const children: FakeChild[] = [];
	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		maxActiveChildren: 2,
		sendUserMessage: () => {},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});
	try {
		const first = supervisor.spawn([baseSpec({ task: "a" }), baseSpec({ task: "b" })]);
		const second = supervisor.spawn([baseSpec({ task: "c" }), baseSpec({ task: "d" })]);
		assert(
			name,
			children.length === 2 &&
				supervisor.runs.get(second.runId)?.tasks.every((task) => task.status === "queued") === true,
			`children=${children.length} second=${supervisor.runs.get(second.runId)?.tasks.map((task) => task.status)}`,
		);
		children[0].settle("a done");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert(`${name} (releases slot)`, children.length === 3, `children=${children.length}`);
		void first;
	} finally {
		supervisor.dispose();
	}
}

async function testCompletionReapsChild(): Promise<void> {
	const name = "p. successful completion captures output and reaps the child";
	const children: FakeChild[] = [];
	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		sendUserMessage: () => {},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});
	try {
		const { runId, taskIds } = supervisor.spawn([baseSpec()]);
		children[0].settle("captured");
		const task = supervisor.runs.get(runId)?.tasks[0];
		const result = supervisor.result(runId, taskIds[0]);
		assert(
			name,
			children[0].killed &&
				task?.reaped === true &&
				task.status === "done" &&
				result.output === "captured",
			`killed=${children[0].killed} task=${JSON.stringify(task)} result=${JSON.stringify(result)}`,
		);
		assert(
			`${name} (owner identity)`,
			Boolean(children[0].ownerToken?.startsWith(`${runId}:0:`)),
			`ownerToken=${children[0].ownerToken}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testUnconfirmedCleanupPausesQueue(): Promise<void> {
	const name = "r. unconfirmed cleanup pauses queue and retries before spawning more";
	const children: FakeChild[] = [];
	let terminateCalls = 0;
	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		maxActiveChildren: 1,
		sendUserMessage: () => {},
		createChild: (options) => {
			const child = new FakeChild(options) as FakeChild & { terminate?: () => Promise<boolean> };
			if (children.length === 0) {
				child.terminate = async () => ++terminateCalls >= 2;
			}
			children.push(child);
			return child;
		},
	});
	try {
		const { runId } = supervisor.spawn([baseSpec({ task: "one" }), baseSpec({ task: "two" })], 1);
		children[0].settle("done but stubborn");
		await new Promise((resolve) => setTimeout(resolve, 0));
		let tasks = supervisor.runs.get(runId)?.tasks;
		const other = supervisor.spawn([baseSpec({ task: "other run" })]);
		assert(
			name,
			children.length === 1 &&
				tasks?.[0].reaped === false &&
				tasks?.[1].status === "queued" &&
				supervisor.runs.get(other.runId)?.tasks[0].status === "queued",
			`children=${children.length} statuses=${tasks?.map((task) => `${task.status}:${task.reaped}`)} other=${supervisor.runs.get(other.runId)?.tasks[0].status}`,
		);
		supervisor.tickWatchdog();
		await new Promise((resolve) => setTimeout(resolve, 0));
		tasks = supervisor.runs.get(runId)?.tasks;
		assert(
			`${name} (retry succeeds)`,
			terminateCalls === 2 && children.length === 2 && tasks?.[0].reaped === true,
			`calls=${terminateCalls} children=${children.length} statuses=${tasks?.map((task) => `${task.status}:${task.reaped}`)}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testAbortCannotSucceed(): Promise<void> {
	const name = "q. aborted task settles as failed, never successful";
	const children: FakeChild[] = [];
	const supervisor = new Supervisor({
		watchdogTickMs: 0,
		sendUserMessage: () => {},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});
	try {
		const { runId, taskIds } = supervisor.spawn([baseSpec()]);
		await supervisor.abortTask(runId, taskIds[0], "looping without useful progress");
		assert(
			`${name} (stopping)`,
			supervisor.runs.get(runId)?.tasks[0]?.status === "stopping",
			`status=${supervisor.runs.get(runId)?.tasks[0]?.status}`,
		);
		children[0].settle("partial output");
		const task = supervisor.runs.get(runId)?.tasks[0];
		assert(
			name,
			task?.status === "failed" &&
				task.error === "aborted by parent: looping without useful progress" &&
				children[0].killed,
			`status=${task?.status} error=${task?.error} killed=${children[0].killed}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testUnexpectedExitFailsImmediately(): Promise<void> {
	const name = "r. unexpected child exit fails immediately without waiting for timeout";
	const children: FakeChild[] = [];
	const supervisor = new Supervisor({
		taskTimeoutMs: 60_000,
		watchdogTickMs: 0,
		sendUserMessage: () => {},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});
	try {
		const { runId } = supervisor.spawn([baseSpec()]);
		children[0].stderr = "crashed";
		children[0].exit(23);
		const task = supervisor.runs.get(runId)?.tasks[0];
		assert(
			name,
			task?.status === "failed" && task.error?.includes("exited 23") === true,
			`status=${task?.status} error=${task?.error}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function main(): Promise<void> {
	await testPersistentMetadata();
	await testSpawnReturnsBeforeCompletion();
	await testSteerWhenParentRunning();
	await testPlainWakeWhenParentWaiting();
	await testRaceExactlyOneWake();
	await testHardTimeout();
	await testKillAll();
	await testSilentKillDuringFinalization();
	await testSteerControlSurface();
	await testAbortTask();
	await testStatusTerse();
	await testStatusReportsObjectiveActivity();
	await testResultDetail();
	await testManualKillMetadata();
	await testSoftSignalStuckInTool();
	await testExitPropagatesStderr();
	await testExitDoesNotLeakStderrOnSuccess();
	await testBoundedConcurrency();
	await testGlobalConcurrencyCap();
	await testCompletionReapsChild();
	await testUnconfirmedCleanupPausesQueue();
	await testAbortCannotSucceed();
	await testUnexpectedExitFailsImmediately();

	if (failed > 0) {
		console.log(`\n${failed} failure(s)`);
		process.exit(1);
	}
	console.log("\nAll tests passed.");
}

void main();

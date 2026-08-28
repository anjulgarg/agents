/**
 * Deterministic supervisor tests with a fake RpcChild.
 *
 * Run: npm run test:extensions
 */
import {
	emptyUsage,
	type ContextUsageSnapshot,
	type RpcChildOptions,
	type RpcEvent,
	type UsageStats,
} from "./rpc-client.ts";
import {
	DEFAULT_READ_ONLY_TIMEOUT_MS,
	DEFAULT_WRITE_TIMEOUT_MS,
	resolveTaskTimeoutMs,
	Supervisor,
	type ChildHandle,
	type TaskSpawnSpec,
} from "./supervisor.ts";

interface Wake {
	content: string;
	deliverAs?: "steer" | "followUp";
}

class FakeChild implements ChildHandle {
	readonly usage: UsageStats = emptyUsage();
	readonly messages: any[] = [];
	killed = false;
	steered: string[] = [];
	promptMessages: string[] = [];
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

	prompt(message: string): Promise<unknown> {
		this.promptMessages.push(message);
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

	transcript(): readonly any[] {
		return this.messages;
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

	/** Test helper: complete one assistant turn without settling the child. */
	completeTurn(usage: Partial<UsageStats>): void {
		Object.assign(this.usage, usage);
		this.onEvent?.({ type: "message_end", message: { role: "assistant" } });
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

/** Fake child that supports the optional context telemetry contract. */
class TelemetryFakeChild extends DeferredTerminateChild {
	/** Per-call outcomes; unset entries hang forever like a non-responsive stats command. */
	refreshResults: Array<ContextUsageSnapshot | undefined | "hang" | "reject"> = [];
	refreshCalls = 0;

	refreshSessionStats(): Promise<ContextUsageSnapshot | undefined> {
		const outcome = this.refreshResults[this.refreshCalls] ?? "hang";
		this.refreshCalls++;
		if (outcome === "hang") return new Promise<ContextUsageSnapshot | undefined>(() => {});
		if (outcome === "reject") return Promise.reject(new Error("stats unavailable"));
		return Promise.resolve(outcome === undefined ? undefined : { ...outcome });
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

function testTaskTimeoutContract(): void {
	const name = "a0. task timeout defaults follow access and cap at sixty minutes";
	assert(
		name,
		resolveTaskTimeoutMs(true) === DEFAULT_READ_ONLY_TIMEOUT_MS &&
			resolveTaskTimeoutMs(false) === DEFAULT_WRITE_TIMEOUT_MS &&
			resolveTaskTimeoutMs(false, 90 * 60_000) === 60 * 60_000,
		"unexpected task timeout resolution",
	);
}

async function testPersistentMetadata(): Promise<void> {
	const name = "a. persistent mode and session identity reach child and snapshot";
	const children: FakeChild[] = [];
	let received: RpcChildOptions | undefined;
	const supervisor = new Supervisor({
		cleanupTickMs: 0,
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
				received.persistentSession.sessionDir === "/tmp/child-1" &&
				received.disableMcp === true,
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

		received = undefined;
		supervisor.spawn([baseSpec({ tools: ["mcp"] })]);
		assert(
			`${name} (explicit MCP remains available)`,
			received?.disableMcp === false,
			JSON.stringify(received),
		);
		children[1].settle("explicit MCP result");
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
		cleanupTickMs: 0,
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
		cleanupTickMs: 0,
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
		cleanupTickMs: 0,
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

async function testSuccessfulRunCompletionsBatchUntilTerminal(): Promise<void> {
	const name = "c1. successful task completions batch until the run is terminal";
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];
	const supervisor = new Supervisor({
		cleanupTickMs: 0,
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
		supervisor.spawn([
			baseSpec({ task: "first" }),
			baseSpec({ task: "second" }),
			baseSpec({ task: "third" }),
		]);
		supervisor.onParentSettled();
		children[0].settle("first done");
		children[1].settle("second done");
		assert(`${name} (intermediate)`, wakes.length === 0, JSON.stringify(wakes));
		children[2].settle("third done");
		assert(
			name,
			wakes.length === 1 &&
				wakes[0]?.deliverAs === undefined &&
				(wakes[0]?.content.match(/Subagent task/g) ?? []).length === 3,
			JSON.stringify(wakes),
		);
	} finally {
		supervisor.dispose();
	}
}

async function testFailureWakesBeforeRunCompletes(): Promise<void> {
	const name = "c2. task failure wakes immediately before the rest of its run completes";
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];
	const supervisor = new Supervisor({
		cleanupTickMs: 0,
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
		const { runId, taskIds } = supervisor.spawn([
			baseSpec({ task: "fails" }),
			baseSpec({ task: "continues" }),
		]);
		supervisor.onParentSettled();
		supervisor.killTask(runId, taskIds[0]!);
		assert(
			name,
			wakes.length === 1 &&
				wakes[0]?.content.includes("failed") === true &&
				supervisor.runs.get(runId)?.tasks[1]?.status === "running",
			JSON.stringify(wakes),
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
		cleanupTickMs: 0,
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
		cleanupTickMs: 0,
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
		children[0].messages.push({
			role: "assistant",
			content: [{ type: "text", text: "partial work before timeout" }],
		});
		await new Promise((resolve) => setTimeout(resolve, 80));
		const task = supervisor.runs.get(runId)?.tasks[0];
		assert(
			name,
			task?.status === "failed" &&
				task.timedOut === true &&
				!!task.error?.includes("timed out") &&
				wakes.length >= 1,
			`status=${task?.status} error=${task?.error} wakes=${JSON.stringify(wakes)}`,
		);
		assert(`${name} (child killed)`, children[0].killed, "child was not killed on timeout");
		assert(
			`${name} (transcript frozen)`,
			task?.messages?.[0]?.content?.[0]?.text === "partial work before timeout",
			`messages=${JSON.stringify(task?.messages)}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testKillAll(): Promise<void> {
	const name = "f. silent killAll() kills every tracked child without waking the parent";
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];

	const supervisor = new Supervisor({
		cleanupTickMs: 0,
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
		cleanupTickMs: 0,
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
		cleanupTickMs: 0,
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
		cleanupTickMs: 0,
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
		cleanupTickMs: 0,
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
		cleanupTickMs: 0,
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

async function testLiveUsageProjection(): Promise<void> {
	const name = "j. running task projects usage after each assistant turn";
	const children: FakeChild[] = [];
	const supervisor = new Supervisor({
		cleanupTickMs: 0,
		sendUserMessage: () => {},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});
	try {
		const { runId, taskIds } = supervisor.spawn([baseSpec()]);
		children[0].completeTurn({ input: 5000, output: 508, cost: 0.0045, turns: 1 });
		const status = supervisor.status(runId);
		const task = Array.isArray(status) ? undefined : status.tasks[0];
		const liveResult = supervisor.result(runId, taskIds[0]);
		assert(
			name,
			task?.status === "running" &&
				liveResult.usage.turns === 1 &&
				liveResult.usage.input === 5000 &&
				liveResult.usage.output === 508 &&
				liveResult.usage.cost === 0.0045,
			JSON.stringify({ task, liveResult }),
		);
		children[0].settle("done");
	} finally {
		supervisor.dispose();
	}
}

async function testResultDetail(): Promise<void> {
	const name = "j. result() returns output+usage for a completed task";
	const children: FakeChild[] = [];

	const supervisor = new Supervisor({
		cleanupTickMs: 0,
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
		cleanupTickMs: 0,
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

async function testProgressCheckpoint(): Promise<void> {
	const name = "l. progress checkpoints are bounded, deduplicated, and completion-cancelled";
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];
	const supervisor = new Supervisor({
		cleanupTickMs: 0,
		checkpointIntervalMs: 10,
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
		const { runId } = supervisor.spawn([baseSpec({ task: "checkpoint", readOnly: true })]);
		for (let index = 0; index < 8; index++) {
			children[0].emit({
				type: "tool_execution_start",
				toolCallId: `c${index}`,
				toolName: index % 2 === 0 ? "read" : "grep",
				args: { path: `src/file-${index}.ts`, pattern: `query-${index}` },
			});
			children[0].emit({
				type: "tool_execution_end",
				toolCallId: `c${index}`,
				toolName: index % 2 === 0 ? "read" : "grep",
				result: index >= 6 ? { isError: true, content: "failed lookup" } : { content: "ok" },
				isError: index >= 6,
			});
		}
		children[0].completeTurn({ turns: 1, output: 120, cost: 0.25 });
		await new Promise((resolve) => setTimeout(resolve, 30));
		const checkpointWake = wakes.find((wake) => wake.content.includes("Progress checkpoint:"));
		const encoded = checkpointWake?.content.match(/Progress checkpoint: (\{.*\})\n/)?.[1];
		const checkpoint = encoded ? JSON.parse(encoded) : undefined;
		assert(
			name,
			wakes.length === 1 &&
				checkpointWake?.content.includes("Do not poll between checkpoints") === true &&
				JSON.stringify(checkpoint).length <= 1024 &&
				checkpoint?.recentTools?.length <= 6 &&
				checkpoint?.recentErrors?.every(
					(error: Record<string, unknown>) => error.toolName && error.target && error.message,
				) &&
				checkpoint?.consecutiveToolFailures === 2,
			`wakes=${JSON.stringify(wakes)} checkpoint=${JSON.stringify(checkpoint)}`,
		);
		supervisor.onParentSettled();
		children[0].completeTurn({ turns: 2, output: 180, cost: 0.4 });
		await new Promise((resolve) => setTimeout(resolve, 30));
		const secondEncoded = wakes[1]?.content.match(/Progress checkpoint: (\{.*\})\n/)?.[1];
		const secondCheckpoint = secondEncoded ? JSON.parse(secondEncoded) : undefined;
		assert(
			`${name} (deltas advance after parent settles)`,
			wakes.length === 2 &&
				secondCheckpoint?.outputTokensDelta === 60 &&
				Math.abs(secondCheckpoint?.costUsdDelta - 0.15) < 0.000001,
			`wakes=${JSON.stringify(wakes)} checkpoint=${JSON.stringify(secondCheckpoint)}`,
		);
		children[0].settle("done");
		await new Promise((resolve) => setTimeout(resolve, 20));
		supervisor.onParentSettled();
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert(
			`${name} (completion cancels later checkpoints without losing its wake)`,
			wakes.length === 3 && wakes[2].content.includes("Subagent task 1 done: done"),
			`unexpected wakes=${JSON.stringify(wakes)}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testTransientProviderRecovery(): Promise<void> {
	const name = "m. transient provider failures retry the child without false success";
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];
	const supervisor = new Supervisor({
		cleanupTickMs: 0,
		maxTransientRetries: 2,
		transientRetryBaseDelayMs: 1,
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
		const { runId, taskIds } = supervisor.spawn([baseSpec({ task: "recover provider" })]);
		children[0].emit({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "Unknown error (no error details in response)",
			},
		});
		children[0].emit({ type: "agent_settled" });
		await new Promise((resolve) => setTimeout(resolve, 15));
		let task = supervisor.runs.get(runId)?.tasks[0];
		assert(
			name,
			task?.status === "running" &&
				children[0].promptMessages.length === 2 &&
				children[0].promptMessages[1]?.includes("INTERNAL PROVIDER RECOVERY") === true &&
				wakes.length === 0,
			`status=${task?.status} prompts=${JSON.stringify(children[0].promptMessages)} wakes=${JSON.stringify(wakes)}`,
		);

		children[0].settle("recovered result");
		task = supervisor.runs.get(runId)?.tasks[0];
		const result = supervisor.result(runId, taskIds[0]);
		assert(
			`${name} (successful recovery)`,
			task?.status === "done" && result.output === "recovered result" && result.error === undefined,
			`task=${JSON.stringify(task)} result=${JSON.stringify(result)}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testTransientProviderFailureExhaustion(): Promise<void> {
	const name = "n. exhausted transient recovery fails with the provider diagnostic";
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];
	const supervisor = new Supervisor({
		cleanupTickMs: 0,
		maxTransientRetries: 1,
		transientRetryBaseDelayMs: 1,
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
		const { runId, taskIds } = supervisor.spawn([baseSpec({ task: "exhaust provider" })]);
		const failTurn = (): void => {
			children[0].emit({
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage:
						"Azure OpenAI API error (503): upstream connect error or disconnect/reset before headers",
				},
			});
			children[0].emit({ type: "agent_settled" });
		};
		failTurn();
		await new Promise((resolve) => setTimeout(resolve, 15));
		failTurn();
		const task = supervisor.runs.get(runId)?.tasks[0];
		const result = supervisor.result(runId, taskIds[0]);
		assert(
			name,
			task?.status === "failed" &&
				children[0].promptMessages.length === 2 &&
				result.error?.includes("automatic recovery attempt") === true &&
				result.error?.includes("503") === true &&
				wakes.length === 1,
			`task=${JSON.stringify(task)} result=${JSON.stringify(result)} wakes=${JSON.stringify(wakes)}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testTransientProviderRecoveryWindow(): Promise<void> {
	const name = "o. transient provider recovery uses a resettable one-minute window";
	const children: FakeChild[] = [];
	const wakes: Wake[] = [];
	let now = 0;
	const supervisor = new Supervisor({
		cleanupTickMs: 0,
		transientRetryBaseDelayMs: 1,
		transientRetryWindowMs: 100,
		now: () => now,
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
		const { runId, taskIds } = supervisor.spawn([baseSpec({ task: "windowed recovery" })]);
		const child = children[0]!;
		const failTurn = (): void => {
			child.emit({
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: "Azure OpenAI API error (503): service unavailable",
				},
			});
			child.emit({ type: "agent_settled" });
		};

		failTurn();
		await new Promise((resolve) => setTimeout(resolve, 10));
		now = 20;
		failTurn();
		await new Promise((resolve) => setTimeout(resolve, 10));
		child.emit({
			type: "message_end",
			message: { role: "assistant", stopReason: "stop" },
		});
		now = 90;
		failTurn();
		await new Promise((resolve) => setTimeout(resolve, 10));
		now = 110;
		failTurn();
		await new Promise((resolve) => setTimeout(resolve, 10));
		now = 191;
		failTurn();
		const task = supervisor.runs.get(runId)?.tasks[0];
		const result = supervisor.result(runId, taskIds[0]);
		assert(
			name,
			task?.status === "failed" &&
				child.promptMessages.length === 5 &&
				result.error?.includes("automatic recovery") === true &&
				wakes.length === 1,
			`task=${JSON.stringify(task)} prompts=${child.promptMessages.length} result=${JSON.stringify(result)} wakes=${JSON.stringify(wakes)}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testNonTransientProviderFailureDoesNotRetry(): Promise<void> {
	const name = "o. deterministic provider failures fail fast without retry";
	const children: FakeChild[] = [];
	const supervisor = new Supervisor({
		cleanupTickMs: 0,
		sendUserMessage: () => {},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});

	try {
		const { runId, taskIds } = supervisor.spawn([baseSpec({ task: "invalid provider request" })]);
		children[0].emit({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "401 authentication failed",
			},
		});
		children[0].emit({ type: "agent_settled" });
		const task = supervisor.runs.get(runId)?.tasks[0];
		const result = supervisor.result(runId, taskIds[0]);
		assert(
			name,
			task?.status === "failed" &&
				children[0].promptMessages.length === 1 &&
				result.error === "401 authentication failed",
			`task=${JSON.stringify(task)} result=${JSON.stringify(result)}`,
		);
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
		'\u001b[31mError: Failed to load extension "/tmp/broken/index.ts": Extension does not export a valid factory function\u001b[0m\n' +
		"\u001b[90m    at loadExtension (ext.ts:1:1)\u001b[0m\n";

	const supervisor = new Supervisor({
		cleanupTickMs: 0,
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
		cleanupTickMs: 0,
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
		cleanupTickMs: 0,
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
		cleanupTickMs: 0,
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

async function testDefaultGlobalConcurrencyCap(): Promise<void> {
	const name = "p. default global child cap allows 10 active children across runs";
	const children: FakeChild[] = [];
	const supervisor = new Supervisor({
		cleanupTickMs: 0,
		sendUserMessage: () => {},
		createChild: (options) => {
			const child = new FakeChild(options);
			children.push(child);
			return child;
		},
	});
	try {
		supervisor.spawn(Array.from({ length: 6 }, (_, index) => baseSpec({ task: `a${index}` })));
		const second = supervisor.spawn(
			Array.from({ length: 6 }, (_, index) => baseSpec({ task: `b${index}` })),
		);
		const secondStatuses = supervisor.runs.get(second.runId)?.tasks.map((task) => task.status);
		assert(
			name,
			children.length === 10 &&
				secondStatuses?.filter((status) => status === "running").length === 4 &&
				secondStatuses.filter((status) => status === "queued").length === 2,
			`children=${children.length} second=${secondStatuses}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testCompletionReapsChild(): Promise<void> {
	const name = "p. successful completion captures output and reaps the child";
	const children: FakeChild[] = [];
	const supervisor = new Supervisor({
		cleanupTickMs: 0,
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
		cleanupTickMs: 0,
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
		supervisor.tickCleanup();
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
		cleanupTickMs: 0,
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
		cleanupTickMs: 0,
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

async function testLiveContextRefreshOnAssistantTurn(): Promise<void> {
	const name = "s. completed assistant turns and compaction events refresh context";
	const children: TelemetryFakeChild[] = [];
	const supervisor = new Supervisor({
		cleanupTickMs: 0,
		sendUserMessage: () => {},
		createChild: (options) => {
			const child = new TelemetryFakeChild(options);
			children.push(child);
			return child;
		},
	});
	try {
		const { runId } = supervisor.spawn([baseSpec({ task: "context live" })]);
		const child = children[0]!;
		child.refreshResults = [
			{ tokens: 168000, contextWindow: 258000, percent: 65.1 },
			{ tokens: null, contextWindow: 258000, percent: null },
		];
		child.emit({ type: "message_end", message: { role: "assistant", content: [] } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		let task = supervisor.runs.get(runId)?.tasks[0];
		assert(
			name,
			child.refreshCalls === 1 &&
				task?.contextUsage?.tokens === 168000 &&
				task.contextUsage.contextWindow === 258000,
			`calls=${child.refreshCalls} context=${JSON.stringify(task?.contextUsage)}`,
		);
		// Non-assistant message_end is not a context-changing event.
		child.emit({ type: "message_end", message: { role: "user", content: [] } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert(
			`${name} (user turns do not refresh)`,
			child.refreshCalls === 1,
			`calls=${child.refreshCalls}`,
		);
		// Compaction refresh retains unknown occupancy instead of stale known tokens.
		child.emit({ type: "compaction_end" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		task = supervisor.runs.get(runId)?.tasks[0];
		assert(
			`${name} (compaction retains unknown occupancy)`,
			child.refreshCalls === 2 &&
				task?.contextUsage?.tokens === null &&
				task.contextUsage.contextWindow === 258000 &&
				task.contextUsage.percent === null,
			`calls=${child.refreshCalls} context=${JSON.stringify(task?.contextUsage)}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testFinalRefreshAppliesBeforeCleanup(): Promise<void> {
	const name = "t. one final refresh settles context before confirmed cleanup";
	const children: TelemetryFakeChild[] = [];
	const supervisor = new Supervisor({
		cleanupTickMs: 0,
		sendUserMessage: () => {},
		createChild: (options) => {
			const child = new TelemetryFakeChild(options);
			children.push(child);
			return child;
		},
	});
	try {
		const { runId, taskIds } = supervisor.spawn([baseSpec({ task: "final context" })]);
		const child = children[0]!;
		child.refreshResults = [{ tokens: 168000, contextWindow: 258000, percent: 65.1 }];
		child.settle("final result");
		child.finishTermination();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const task = supervisor.runs.get(runId)?.tasks[0];
		const result = supervisor.result(runId, taskIds[0]);
		assert(
			name,
			child.refreshCalls === 1 &&
				task?.status === "done" &&
				task.reaped === true &&
				task.contextUsage?.tokens === 168000 &&
				result.output === "final result" &&
				result.error === undefined,
			`calls=${child.refreshCalls} task=${JSON.stringify(task)} result=${JSON.stringify(result)}`,
		);
	} finally {
		supervisor.dispose();
	}
}

async function testFinalRefreshFailureNeverBlocksCleanup(): Promise<void> {
	for (const variant of ["hang", "reject", "unavailable"] as const) {
		const name = `u. ${variant} final refresh: bounded cleanup, result unchanged, context unavailable`;
		const children: TelemetryFakeChild[] = [];
		const supervisor = new Supervisor({
			cleanupTickMs: 0,
			sendUserMessage: () => {},
			createChild: (options) => {
				const child = new TelemetryFakeChild(options);
				children.push(child);
				return child;
			},
		});
		try {
			const { runId, taskIds } = supervisor.spawn([baseSpec({ task: `final ${variant}` })]);
			const child = children[0]!;
			child.refreshResults = [variant === "unavailable" ? undefined : variant];
			const startedAt = Date.now();
			child.settle("original completion");
			child.finishTermination();
			let reaped = false;
			for (let attempt = 0; attempt < 200 && !reaped; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 25));
				reaped = supervisor.runs.get(runId)?.tasks[0]?.reaped === true;
			}
			const elapsed = Date.now() - startedAt;
			const task = supervisor.runs.get(runId)?.tasks[0];
			const result = supervisor.result(runId, taskIds[0]);
			assert(
				name,
				reaped &&
					task?.status === "done" &&
					task.contextUsage === undefined &&
					result.output === "original completion" &&
					result.error === undefined,
				`reaped=${reaped} task=${JSON.stringify(task)} result=${JSON.stringify(result)}`,
			);
			if (variant === "hang") {
				assert(`${name} (bounded wait)`, elapsed >= 900 && elapsed < 2500, `elapsed=${elapsed}ms`);
			}
		} finally {
			supervisor.dispose();
		}
	}
}

async function main(): Promise<void> {
	testTaskTimeoutContract();
	await testPersistentMetadata();
	await testSpawnReturnsBeforeCompletion();
	await testSteerWhenParentRunning();
	await testPlainWakeWhenParentWaiting();
	await testSuccessfulRunCompletionsBatchUntilTerminal();
	await testFailureWakesBeforeRunCompletes();
	await testRaceExactlyOneWake();
	await testHardTimeout();
	await testKillAll();
	await testSilentKillDuringFinalization();
	await testSteerControlSurface();
	await testAbortTask();
	await testStatusTerse();
	await testStatusReportsObjectiveActivity();
	await testLiveUsageProjection();
	await testResultDetail();
	await testManualKillMetadata();
	await testProgressCheckpoint();
	await testTransientProviderRecovery();
	await testTransientProviderFailureExhaustion();
	await testTransientProviderRecoveryWindow();
	await testNonTransientProviderFailureDoesNotRetry();
	await testExitPropagatesStderr();
	await testExitDoesNotLeakStderrOnSuccess();
	await testBoundedConcurrency();
	await testGlobalConcurrencyCap();
	await testDefaultGlobalConcurrencyCap();
	await testCompletionReapsChild();
	await testUnconfirmedCleanupPausesQueue();
	await testAbortCannotSucceed();
	await testUnexpectedExitFailsImmediately();
	await testLiveContextRefreshOnAssistantTurn();
	await testFinalRefreshAppliesBeforeCleanup();
	await testFinalRefreshFailureNeverBlocksCleanup();

	if (failed > 0) {
		console.log(`\n${failed} failure(s)`);
		process.exit(1);
	}
	console.log("\nAll tests passed.");
}

void main();

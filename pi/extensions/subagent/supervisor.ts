import { randomUUID } from "node:crypto";

import type { Message } from "@earendil-works/pi-ai";

import {
	RpcChild,
	emptyUsage,
	type ChildUiSnapshot,
	type RpcChildOptions,
	type RpcEvent,
} from "./rpc-client.ts";
import type {
	ContextUsageSnapshot,
	PersistentChildSession,
	SubagentMode,
	ThinkingLevel,
	UsageStats,
	WorkspaceMode,
} from "./contracts.ts";
export {
	SUBAGENT_MODES,
	WORKSPACE_MODES,
	type PersistentChildSession,
	type SubagentMode,
	type WorkspaceMode,
} from "./contracts.ts";
import {
	StuckDetector,
	type RecentToolActivity,
	type SignalKind,
	type StuckDetectorOptions,
} from "./watchdog.ts";

export type TaskStatus = "queued" | "starting" | "running" | "stopping" | "done" | "failed";

export function isTerminalStatus(status: TaskStatus): boolean {
	return status === "done" || status === "failed";
}

export function isActiveStatus(status: TaskStatus): boolean {
	return status === "starting" || status === "running" || status === "stopping";
}
export const MANUAL_KILL_ERROR =
	"Manually killed by the user. Do not retry or redelegate this task until the user explicitly approves a retry.";

export interface TaskSpawnSpec {
	/** Stable assignment shown in dashboards and persisted state. */
	task: string;
	/** Full child prompt, including direct dependency handoffs. Defaults to task. */
	prompt?: string;
	model: string;
	thinking: ThinkingLevel;
	workspace: WorkspaceMode;
	cwd: string;
	tools?: string[];
	systemPromptFile: string;
	projectTrusted?: boolean;
	piBin?: string;
	mode?: SubagentMode;
	/** Exact child session identity for persistent invocations. */
	persistentSession?: PersistentChildSession;
}

export interface TaskState {
	index: number;
	taskId: string;
	task: string;
	model: string;
	thinking: ThinkingLevel;
	workspace: WorkspaceMode;
	cwd: string;
	mode: SubagentMode;
	sessionId?: string;
	status: TaskStatus;
	output: string;
	error?: string;
	manualKill?: boolean;
	usage: UsageStats;
	/** Latest validated context occupancy; cleared when a newer refresh fails. */
	contextUsage?: ContextUsageSnapshot;
	child?: ChildHandle;
	/** Spawn inputs retained while queued; never persisted. */
	spawnSpec?: TaskSpawnSpec;
	ownerToken: string;
	reaped: boolean;
	abortRequested?: boolean;
	abortReason?: string;
	finalizing?: boolean;
	/** Prevent child cleanup from restarting a parent turn that the user aborted. */
	suppressWake?: boolean;
	cleanupRetrying?: boolean;
	lastEventAt: number;
	activityVersion: number;
	startedAt: number;
	finishedAt?: number;
	/** Completion or soft signal recorded but not yet delivered via a wake. */
	unreaped: boolean;
	/** Soft-signal payload waiting to be delivered via wake. */
	pendingSoft?: { summary: string; steerable: boolean };
}

export interface RunState {
	runId: string;
	tasks: TaskState[];
	startedAt: number;
	maxConcurrency: number;
}

interface FinalizationResult {
	status: "done" | "failed";
	error?: string;
	manualKill?: boolean;
	notifyParent?: boolean;
}

export interface ChildHandle {
	readonly usage: UsageStats;
	/** Present on RpcChild; used to diagnose startup/exit failures. */
	readonly stderr?: string;
	/** Present on RpcChild after the process exits. */
	readonly exitCode?: number;
	readonly exited?: boolean;
	readonly pid?: number;
	output(): string;
	/** Available on real RPC children; optional for injected test children. */
	transcript?(): readonly Message[];
	uiSnapshot?(): ChildUiSnapshot;
	/** Present on RpcChild; optional for injected test children. */
	refreshSessionStats?(): Promise<ContextUsageSnapshot | undefined>;
	contextSnapshot?(): ContextUsageSnapshot | undefined;
	/** Graceful then forced process-group termination; true only after confirmed exit. */
	terminate?(): Promise<boolean>;
	forceKill?(): void;
	kill(): void;
	prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<unknown>;
	steer(message: string): Promise<unknown>;
	abort(): Promise<unknown>;
}

export type SendUserMessage = (
	content: string,
	options?: { deliverAs?: "steer" | "followUp" },
) => void | Promise<void>;

export type ChildFactory = (options: RpcChildOptions) => ChildHandle;

export interface TaskActivitySnapshot {
	/** Changes on tool starts/ends, completed assistant turns, and settlement. */
	token: string;
	/** Time since the latest RPC event when status() captured this snapshot. */
	eventAgeMs: number;
	turns: number;
	costUsd: number;
	lastToolName?: string;
	openToolName?: string;
	hasEditOrWrite: boolean;
	toolCalls: number;
	succeededTools: number;
	failedTools: number;
	changedFiles: string[];
	/** Current git working-tree changes, populated opportunistically by subagent_status. */
	workspaceChanges?: string[];
	recentTools: RecentToolActivity[];
	signals: SignalKind[];
}

export interface AbortAssessment {
	status: TaskStatus;
	activityToken: string;
	eventAgeMs: number;
	signals: SignalKind[];
}

export interface TaskSnapshot {
	taskId: string;
	index: number;
	status: TaskStatus;
	model: string;
	thinking: ThinkingLevel;
	workspace: WorkspaceMode;
	cwd: string;
	mode?: SubagentMode;
	sessionId?: string;
	error?: string;
	manualKill?: boolean;
	reaped: boolean;
	lastEventAt: number;
	startedAt: number;
	finishedAt?: number;
	/** Objective event metadata only. Absence or age must not be interpreted as idleness. */
	activity?: TaskActivitySnapshot;
}

export interface RunSnapshot {
	runId: string;
	startedAt: number;
	maxConcurrency: number;
	tasks: TaskSnapshot[];
}

export interface TaskResult {
	output: string;
	usage: UsageStats;
	mode?: SubagentMode;
	sessionId?: string;
	error?: string;
	manualKill?: boolean;
}

export interface SupervisorOptions {
	sendUserMessage: SendUserMessage;
	/** Defaults to constructing a real RpcChild. Inject a fake in tests. */
	createChild?: ChildFactory;
	/** Hard wall-clock timeout per task. Default 15 minutes. */
	taskTimeoutMs?: number;
	/**
	 * Soft watchdog evaluation interval. Default 30s.
	 * Set to 0 to disable the auto-timer (tests drive tickWatchdog manually).
	 */
	watchdogTickMs?: number;
	/** Options forwarded to each task's StuckDetector. */
	stuckDetectorOptions?: StuckDetectorOptions;
	/** Clock injection for deterministic tests. Defaults to Date.now. */
	now?: () => number;
	defaultTools?: string[];
	/** Hard cap across all runs owned by this supervisor. Default 8. */
	maxActiveChildren?: number;
	/**
	 * Called after the outstanding-work check and before parentWaiting is set.
	 * Tests use this to inject the settle/flag race; production leaves it unset.
	 */
	betweenSettleCheckAndWait?: () => void;
}

const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_WATCHDOG_TICK_MS = 30_000;
const DEFAULT_MAX_ACTIVE_CHILDREN = 8;
const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
/** Bound on the final context refresh before normal process termination begins. */
const FINAL_CONTEXT_REFRESH_TIMEOUT_MS = 1000;
const STDERR_TAIL_MAX = 500;
const ANSI_ESCAPE_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function oneLine(text: string): string {
	const line = text.trim().split(/\r?\n/)[0] ?? "";
	return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/** Strip CSI/ANSI color sequences so wake/result text stays readable. */
function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE_RE, "");
}

/**
 * Build a failure message from a child's real exit cause.
 * Full detail (exit code + ~500-char stderr tail) goes into task.error / result();
 * wakeMessage() keeps the delivered wake terse via oneLine().
 * Returns `fallback` when the child has no exit diagnostics (non-exit failures).
 */
function formatChildExitError(child: ChildHandle, fallback: string): string {
	const code = child.exitCode;
	const raw = typeof child.stderr === "string" ? child.stderr : "";
	const cleaned = stripAnsi(raw).replace(/\r/g, "").trim();
	const tail =
		cleaned.length > STDERR_TAIL_MAX ? cleaned.slice(cleaned.length - STDERR_TAIL_MAX) : cleaned;
	if (code === undefined && !tail) return fallback;
	const exitLabel = code !== undefined ? `exited ${code}` : "exited";
	if (!tail) return exitLabel;
	return `${exitLabel} (${tail.replace(/\s+/g, " ")})`;
}

function wakeMessage(task: TaskState): string {
	const label = `task ${task.index + 1}`;
	if (task.pendingSoft) {
		const { summary, steerable } = task.pendingSoft;
		return `Subagent ${label} stuck: ${oneLine(summary)} (steerable=${steerable})`;
	}
	if (task.status === "done") {
		const summary = oneLine(task.output) || "(no output)";
		return `Subagent ${label} done: ${summary}`;
	}
	const reason = oneLine(task.error ?? "failed") || "failed";
	return `Subagent ${label} failed: ${reason}`;
}

/**
 * Extension-scoped supervisor for long-lived `pi --mode rpc` subagent children.
 *
 * Completion is agent_settled (or timeout/failure), not process exit. The parent
 * never polls and never idles while work is outstanding: onParentSettled +
 * onTaskComplete form a condition variable around sendUserMessage wakes.
 *
 * Soft stuck signals reuse the same wake path; hard timeout still kills.
 */
export class Supervisor {
	readonly runs = new Map<string, RunState>();

	private readonly sendUserMessage: SendUserMessage;
	private readonly createChild: ChildFactory;
	private readonly taskTimeoutMs: number;
	private readonly watchdogTickMs: number;
	private readonly stuckDetectorOptions: StuckDetectorOptions;
	private readonly now: () => number;
	private readonly defaultTools: string[];
	private readonly maxActiveChildren: number;
	private readonly betweenSettleCheckAndWait?: () => void;
	private readonly timeouts = new Map<string, NodeJS.Timeout>();
	private readonly abortFallbacks = new Map<string, NodeJS.Timeout>();
	private readonly detectors = new Map<string, StuckDetector>();
	private readonly exitHandlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];
	private readonly listeners = new Set<() => void>();
	private watchdogTimer?: NodeJS.Timeout;
	private deferredKillTimer?: NodeJS.Timeout;
	private disposed = false;
	private scheduling = false;
	private scheduleRequested = false;

	/** Parent has settled and is waiting for the next task completion. */
	private parentWaiting = false;
	/** True only during the outstanding-check → parentWaiting=true window. */
	private inSettleCheck = false;

	constructor(options: SupervisorOptions) {
		this.sendUserMessage = options.sendUserMessage;
		this.createChild = options.createChild ?? ((opts) => new RpcChild(opts));
		this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
		this.watchdogTickMs = options.watchdogTickMs ?? DEFAULT_WATCHDOG_TICK_MS;
		this.stuckDetectorOptions = options.stuckDetectorOptions ?? {};
		this.now = options.now ?? (() => Date.now());
		this.defaultTools = options.defaultTools ?? DEFAULT_TOOLS;
		this.maxActiveChildren = Math.max(1, options.maxActiveChildren ?? DEFAULT_MAX_ACTIVE_CHILDREN);
		this.betweenSettleCheckAndWait = options.betweenSettleCheckAndWait;
		this.installProcessHandlers();
		this.installWatchdogTimer();
	}

	/** Snapshot of the run registry for persistence/reconciliation. */
	get registry(): ReadonlyMap<string, RunState> {
		return this.runs;
	}

	/** Subscribe to child transcript and lifecycle changes. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Queue tasks and start at most maxConcurrency children. Returns immediately. */
	spawn(
		specs: TaskSpawnSpec[],
		maxConcurrency = specs.length,
	): { runId: string; taskIds: string[] } {
		if (this.disposed) throw new Error("supervisor is disposed");
		if (specs.length === 0) throw new Error("spawn requires at least one task");
		if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > specs.length) {
			throw new Error(`maxConcurrency must be between 1 and ${specs.length}`);
		}

		const runId = randomUUID();
		const startedAt = this.now();
		const tasks = specs.map((spec, index): TaskState => {
			const mode = spec.mode ?? (spec.persistentSession ? "persistent" : "ephemeral");
			if (mode === "ephemeral" && spec.persistentSession) {
				throw new Error("ephemeral tasks cannot include a persistent child session");
			}
			if (mode === "persistent" && !spec.persistentSession) {
				throw new Error("persistent tasks require a child session descriptor");
			}
			return {
				index,
				taskId: `${runId}:${index}`,
				task: spec.task,
				model: spec.model,
				thinking: spec.thinking,
				workspace: spec.workspace,
				cwd: spec.cwd,
				mode,
				sessionId: spec.persistentSession?.sessionId,
				status: "queued",
				output: "",
				usage: emptyUsage(),
				spawnSpec: spec,
				ownerToken: `${runId}:${index}:${randomUUID()}`,
				reaped: true,
				lastEventAt: startedAt,
				activityVersion: 0,
				startedAt,
				unreaped: false,
			};
		});
		const run: RunState = { runId, tasks, startedAt, maxConcurrency };
		this.runs.set(runId, run);
		this.startQueuedTasks(run);
		this.notifyListeners();
		return { runId, taskIds: tasks.map((task) => task.taskId) };
	}

	/**
	 * Parent agent has settled. If subagent work is still outstanding, wait for a
	 * wake instead of going idle. Handles the check/flag race via unreaped recheck.
	 */
	onParentSettled(): void {
		this.inSettleCheck = true;
		try {
			if (!this.hasRunningTasks()) {
				this.parentWaiting = false;
				return;
			}
			this.betweenSettleCheckAndWait?.();
			this.parentWaiting = true;
		} finally {
			this.inSettleCheck = false;
		}

		// Recheck: a completion may have landed between the check and the flag.
		const unreaped = this.unreapedTasks();
		if (unreaped.length > 0) {
			this.parentWaiting = false;
			this.wake(unreaped, /* steer */ false);
			return;
		}
		if (!this.hasRunningTasks()) {
			// Last task finished (and already steered) during the race window.
			this.parentWaiting = false;
		}
	}

	/** Steer a running child. Rejects for queued, stopping, or terminal tasks. */
	async steer(runId: string, taskId: string, message: string): Promise<void> {
		const task = this.requireTask(runId, taskId);
		if (task.status !== "running" || !task.child) {
			throw new Error(`task ${taskId} is not running (status=${task.status})`);
		}
		await task.child.steer(message);
	}

	/** Current evidence used by the parent before an autonomous abort decision. */
	abortAssessment(runId: string, taskId: string): AbortAssessment {
		const task = this.requireTask(runId, taskId);
		const now = this.now();
		return {
			status: task.status,
			activityToken: `${task.taskId}:${task.activityVersion}`,
			eventAgeMs: Math.max(0, now - task.lastEventAt),
			signals: this.detectors.get(taskId)?.activeSignals(now) ?? [],
		};
	}

	/** Abort queued work immediately or abort a running turn and record the parent's reason. */
	async abortTask(runId: string, taskId: string, reason = "unspecified reason"): Promise<void> {
		const task = this.requireTask(runId, taskId);
		if (task.status === "queued") {
			this.beginFinalization(runId, taskId, {
				status: "failed",
				error: `aborted by parent: ${reason}`,
			});
			return;
		}
		if (task.status !== "running" || !task.child) {
			throw new Error(`task ${taskId} cannot be aborted (status=${task.status})`);
		}
		task.abortRequested = true;
		task.abortReason = reason;
		task.status = "stopping";
		this.notifyListeners();
		try {
			await task.child.abort();
			if (task.status === "stopping" && !task.finalizing) {
				this.scheduleAbortFallback(runId, taskId, reason);
			}
		} catch (error) {
			this.beginFinalization(runId, taskId, {
				status: "failed",
				error: formatChildExitError(
					task.child,
					error instanceof Error ? error.message : String(error),
				),
			});
		}
	}

	/** Hard-kill queued or active work and mark it failed after confirmed cleanup. */
	killTask(runId: string, taskId: string, manualKill = false, notifyParent = true): void {
		const task = this.findTask(runId, taskId);
		if (!task || isTerminalStatus(task.status) || task.finalizing) return;
		this.beginFinalization(runId, taskId, {
			status: "failed",
			error: manualKill ? MANUAL_KILL_ERROR : "killed",
			manualKill,
			notifyParent,
		});
	}

	/** Defer hard cleanup by one event-loop turn so compaction can take ownership. */
	deferKillAll(options: { notifyParent?: boolean } = {}): void {
		this.killAll({ ...options, defer: true });
	}

	/** Acknowledge a soft diagnosis for a task's StuckDetector. */
	ack(
		runId: string,
		taskId: string,
		options?: { extendBudgetUsd?: number; snoozeMs?: number },
	): void {
		this.requireTask(runId, taskId);
		this.detectors.get(taskId)?.ack(this.now(), options);
	}

	/**
	 * Terse serializable snapshot for opportunistic parent polls.
	 * No transcripts, messages, or output bodies.
	 */
	status(runId?: string): RunSnapshot | RunSnapshot[] {
		if (runId !== undefined) {
			const run = this.runs.get(runId);
			if (!run) throw new Error(`unknown run ${runId}`);
			return this.snapshotRun(run);
		}
		return [...this.runs.values()].map((run) => this.snapshotRun(run));
	}

	/** Full-detail pull after a wake: output, usage, and optional error. */
	result(runId: string, taskId: string): TaskResult {
		const task = this.requireTask(runId, taskId);
		return {
			output: task.output,
			usage: { ...task.usage },
			mode: task.mode,
			sessionId: task.sessionId,
			error: task.error,
			manualKill: task.manualKill,
		};
	}

	/**
	 * Evaluate stuck detectors for all running tasks.
	 * Production calls this on the watchdog interval; tests drive it manually.
	 */
	tickWatchdog(now = this.now()): void {
		for (const run of this.runs.values()) {
			for (const task of run.tasks) {
				if (isTerminalStatus(task.status) && !task.reaped) {
					this.retryCleanup(run, task);
					continue;
				}
				if (task.status !== "running") continue;
				const detector = this.detectors.get(task.taskId);
				if (!detector) continue;
				const diagnosis = detector.evaluate(now);
				if (!diagnosis) continue;
				this.onSoftSignal(task, diagnosis);
			}
		}
	}

	killAll(options: { notifyParent?: boolean; defer?: boolean } = {}): void {
		const notifyParent = options.notifyParent ?? true;
		if (options.defer) {
			if (this.deferredKillTimer) clearTimeout(this.deferredKillTimer);
			this.deferredKillTimer = setTimeout(() => {
				this.deferredKillTimer = undefined;
				this.killAll({ notifyParent });
			}, 0);
			this.deferredKillTimer.unref?.();
			return;
		}
		for (const run of this.runs.values()) {
			for (const task of run.tasks) {
				if (!notifyParent) task.suppressWake = true;
				if (!isTerminalStatus(task.status) && !task.finalizing) {
					this.killTask(run.runId, task.taskId, false, notifyParent);
				} else if (task.child && !task.reaped) {
					if (!notifyParent) task.unreaped = false;
					try {
						task.child.kill();
					} catch {
						/* best-effort */
					}
				}
			}
		}
	}

	/** Cancel a deferred parent-abort cleanup, such as when compaction takes over. */
	cancelDeferredKill(): void {
		if (!this.deferredKillTimer) return;
		clearTimeout(this.deferredKillTimer);
		this.deferredKillTimer = undefined;
	}

	/** Remove handlers and terminate every owned child, including completed ones. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const { event, handler } of this.exitHandlers) {
			process.off(event as any, handler);
		}
		this.exitHandlers.length = 0;
		for (const timer of this.timeouts.values()) clearTimeout(timer);
		this.timeouts.clear();
		for (const timer of this.abortFallbacks.values()) clearTimeout(timer);
		this.abortFallbacks.clear();
		if (this.watchdogTimer) {
			clearInterval(this.watchdogTimer);
			this.watchdogTimer = undefined;
		}
		this.cancelDeferredKill();
		for (const run of this.runs.values()) {
			for (const task of run.tasks) {
				if (!task.child || task.reaped) continue;
				try {
					task.child.kill();
				} catch {
					/* best-effort */
				}
			}
		}
		this.listeners.clear();
	}

	private installProcessHandlers(): void {
		const onExit = () => {
			for (const run of this.runs.values()) {
				for (const task of run.tasks) {
					if (!task.child || task.reaped) continue;
					try {
						if (task.child.forceKill) task.child.forceKill();
						else task.child.kill();
					} catch {
						/* best-effort */
					}
				}
			}
		};
		const onSignal = () => {
			this.killAll();
		};
		process.on("exit", onExit);
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);
		this.exitHandlers.push(
			{ event: "exit", handler: onExit },
			{ event: "SIGINT", handler: onSignal },
			{ event: "SIGTERM", handler: onSignal },
		);
	}

	private installWatchdogTimer(): void {
		if (this.watchdogTickMs <= 0) return;
		const timer = setInterval(() => this.tickWatchdog(), this.watchdogTickMs);
		timer.unref?.();
		this.watchdogTimer = timer;
	}

	private startQueuedTasks(_triggerRun?: RunState): void {
		if (this.disposed) return;
		if (this.scheduling) {
			this.scheduleRequested = true;
			return;
		}
		this.scheduling = true;
		try {
			do {
				this.scheduleRequested = false;
				let globalActive = [...this.runs.values()]
					.flatMap((run) => run.tasks)
					.filter(
						(task) => isActiveStatus(task.status) || (!task.reaped && Boolean(task.child)),
					).length;
				while (globalActive < this.maxActiveChildren) {
					let started = false;
					for (const run of this.runs.values()) {
						if (run.tasks.some((task) => !task.reaped && isTerminalStatus(task.status))) continue;
						const runActive = run.tasks.filter((task) => isActiveStatus(task.status)).length;
						if (runActive >= run.maxConcurrency) continue;
						const task = run.tasks.find((candidate) => candidate.status === "queued");
						if (!task) continue;
						this.startTask(run, task);
						globalActive++;
						started = true;
						if (globalActive >= this.maxActiveChildren) break;
					}
					if (!started) break;
				}
			} while (this.scheduleRequested);
		} finally {
			this.scheduling = false;
		}
	}

	private startTask(run: RunState, task: TaskState): void {
		const spec = task.spawnSpec;
		if (!spec || task.status !== "queued") return;
		task.status = "starting";
		task.startedAt = this.now();
		task.lastEventAt = task.startedAt;
		task.reaped = false;
		try {
			const childTools = spec.tools ?? this.defaultTools;
			const child = this.createChild({
				cwd: spec.cwd,
				model: spec.model,
				thinking: spec.thinking,
				tools: childTools,
				disableMcp: !childTools.includes("mcp"),
				systemPromptFile: spec.systemPromptFile,
				projectTrusted: spec.projectTrusted ?? false,
				persistentSession: spec.persistentSession,
				ownerToken: task.ownerToken,
				piBin: spec.piBin,
				onEvent: (event) => this.onChildEvent(run.runId, task.taskId, event),
				onExit: (code) => this.onChildExit(run.runId, task.taskId, code),
			});
			task.child = child;
			task.status = "running";
			task.spawnSpec = undefined;
			this.detectors.set(task.taskId, new StuckDetector(this.stuckDetectorOptions));
			const timer = setTimeout(
				() => this.onTaskTimeout(run.runId, task.taskId),
				this.taskTimeoutMs,
			);
			timer.unref?.();
			this.timeouts.set(task.taskId, timer);
			void child.prompt(spec.prompt ?? spec.task).catch((error) => {
				const fallback = error instanceof Error ? error.message : String(error);
				this.beginFinalization(run.runId, task.taskId, {
					status: "failed",
					error: formatChildExitError(child, fallback),
				});
			});
		} catch (error) {
			task.reaped = true;
			this.beginFinalization(run.runId, task.taskId, {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private hasRunningTasks(): boolean {
		for (const run of this.runs.values()) {
			for (const task of run.tasks) {
				if (!isTerminalStatus(task.status)) return true;
			}
		}
		return false;
	}

	private unreapedTasks(): TaskState[] {
		const out: TaskState[] = [];
		for (const run of this.runs.values()) {
			for (const task of run.tasks) {
				if (task.unreaped) out.push(task);
			}
		}
		return out;
	}

	private findTask(runId: string, taskId: string): TaskState | undefined {
		return this.runs.get(runId)?.tasks.find((task) => task.taskId === taskId);
	}

	private requireTask(runId: string, taskId: string): TaskState {
		const task = this.findTask(runId, taskId);
		if (!task) throw new Error(`unknown task ${taskId} in run ${runId}`);
		return task;
	}

	private snapshotRun(run: RunState): RunSnapshot {
		const now = this.now();
		return {
			runId: run.runId,
			startedAt: run.startedAt,
			maxConcurrency: run.maxConcurrency,
			tasks: run.tasks.map((task) => {
				const detector = this.detectors.get(task.taskId);
				const facts = detector?.activity(now);
				const active = isActiveStatus(task.status);
				return {
					taskId: task.taskId,
					index: task.index,
					status: task.status,
					model: task.model,
					thinking: task.thinking,
					workspace: task.workspace,
					cwd: task.cwd,
					mode: task.mode,
					sessionId: task.sessionId,
					error: task.error,
					manualKill: task.manualKill,
					reaped: task.reaped,
					lastEventAt: task.lastEventAt,
					startedAt: task.startedAt,
					finishedAt: task.finishedAt,
					activity: active
						? {
								token: `${task.taskId}:${task.activityVersion}`,
								eventAgeMs: Math.max(0, now - task.lastEventAt),
								turns: facts?.turns ?? 0,
								costUsd: facts?.costUsd ?? 0,
								lastToolName: facts?.lastToolName,
								openToolName: facts?.openToolName,
								hasEditOrWrite: facts?.hasEditOrWrite ?? false,
								toolCalls: facts?.toolCalls ?? 0,
								succeededTools: facts?.succeededTools ?? 0,
								failedTools: facts?.failedTools ?? 0,
								changedFiles: facts?.changedFiles ?? [],
								recentTools: facts?.recentTools ?? [],
								signals: detector?.activeSignals(now) ?? [],
							}
						: undefined,
				};
			}),
		};
	}

	private retryCleanup(run: RunState, task: TaskState): void {
		if (task.cleanupRetrying || !task.child?.terminate || this.disposed) return;
		task.cleanupRetrying = true;
		void task.child
			.terminate()
			.then((reaped) => {
				task.cleanupRetrying = false;
				if (!reaped) return;
				task.reaped = true;
				this.startQueuedTasks(run);
				task.pendingSoft = {
					summary: "process cleanup recovered; queued work resumed",
					steerable: true,
				};
				task.unreaped = true;
				this.notifyListeners();
				this.notifyParent(task);
			})
			.catch(() => {
				task.cleanupRetrying = false;
			});
	}

	private onChildEvent(runId: string, taskId: string, event: RpcEvent): void {
		const task = this.findTask(runId, taskId);
		if (!task || isTerminalStatus(task.status) || task.finalizing) return;
		const now = this.now();
		task.lastEventAt = now;
		if (
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_end" ||
			event.type === "message_end" ||
			event.type === "agent_settled"
		)
			task.activityVersion++;
		if (this.isContextChangingEvent(event)) {
			if (task.child) task.usage = { ...task.child.usage };
			this.refreshContext(runId, taskId);
		}
		if (task.status === "running") this.detectors.get(taskId)?.observe(event, now);
		if (event.type === "agent_settled") {
			this.beginFinalization(
				runId,
				taskId,
				task.abortRequested
					? {
							status: "failed",
							error: `aborted by parent: ${task.abortReason ?? "unspecified reason"}`,
						}
					: { status: "done" },
			);
			return;
		}
		this.notifyListeners();
	}

	private refreshContext(runId: string, taskId: string): void {
		const task = this.findTask(runId, taskId);
		if (
			!task ||
			isTerminalStatus(task.status) ||
			task.finalizing ||
			!task.child?.refreshSessionStats
		)
			return;
		void task.child
			.refreshSessionStats()
			.then((snapshot) => {
				const current = this.findTask(runId, taskId);
				if (!current || current !== task || isTerminalStatus(current.status) || current.finalizing)
					return;
				current.contextUsage = snapshot;
				this.notifyListeners();
			})
			.catch(() => {
				const current = this.findTask(runId, taskId);
				if (!current || current !== task || isTerminalStatus(current.status) || current.finalizing)
					return;
				current.contextUsage = undefined;
				this.notifyListeners();
			});
	}

	/** A completed assistant turn or a session compaction changes context occupancy. */
	private isContextChangingEvent(event: RpcEvent): boolean {
		if (event.type === "message_end") {
			const message = event.message as { role?: string } | undefined;
			return message?.role === "assistant";
		}
		return event.type === "compaction_end";
	}

	private onChildExit(runId: string, taskId: string, code: number): void {
		const task = this.findTask(runId, taskId);
		if (!task || isTerminalStatus(task.status) || task.finalizing) return;
		this.beginFinalization(runId, taskId, {
			status: "failed",
			error: formatChildExitError(task.child!, `subagent process exited ${code} before completion`),
		});
	}

	private onTaskTimeout(runId: string, taskId: string): void {
		const task = this.findTask(runId, taskId);
		if (!task || isTerminalStatus(task.status) || task.finalizing) return;
		this.beginFinalization(runId, taskId, {
			status: "failed",
			error: `timed out after ${this.taskTimeoutMs}ms`,
		});
	}

	private onSoftSignal(task: TaskState, diagnosis: { summary: string; steerable: boolean }): void {
		task.pendingSoft = {
			summary: diagnosis.summary,
			steerable: diagnosis.steerable,
		};
		task.unreaped = true;
		this.notifyParent(task);
	}

	private scheduleAbortFallback(runId: string, taskId: string, reason: string): void {
		if (this.disposed) return;
		const previous = this.abortFallbacks.get(taskId);
		if (previous) clearTimeout(previous);
		const timer = setTimeout(() => {
			this.abortFallbacks.delete(taskId);
			const task = this.findTask(runId, taskId);
			if (!task || task.status !== "stopping" || task.finalizing) return;
			this.beginFinalization(runId, taskId, {
				status: "failed",
				error: `aborted by parent: ${reason}`,
			});
		}, 0);
		timer.unref?.();
		this.abortFallbacks.set(taskId, timer);
	}

	private beginFinalization(runId: string, taskId: string, result: FinalizationResult): void {
		const abortFallback = this.abortFallbacks.get(taskId);
		if (abortFallback) {
			clearTimeout(abortFallback);
			this.abortFallbacks.delete(taskId);
		}
		const task = this.findTask(runId, taskId);
		if (!task || isTerminalStatus(task.status) || task.finalizing) return;
		task.finalizing = true;
		task.status = "stopping";
		const timer = this.timeouts.get(taskId);
		if (timer) {
			clearTimeout(timer);
			this.timeouts.delete(taskId);
		}
		this.detectors.delete(taskId);
		task.pendingSoft = undefined;
		task.manualKill = result.manualKill;
		if (task.child) {
			try {
				task.output = task.child.output();
				task.usage = { ...task.child.usage };
			} catch {
				// Preserve any previously captured state.
			}
		}
		this.notifyListeners();

		if (!task.child) {
			this.finishFinalization(runId, taskId, result, true);
			return;
		}
		if (!task.child.terminate) {
			try {
				task.child.kill();
			} catch {
				/* best-effort */
			}
			this.finishFinalization(runId, taskId, result, true);
			return;
		}
		if (!task.child.refreshSessionStats) {
			this.terminateTask(runId, taskId, result);
			return;
		}
		void this.finalContextRefresh(task).then(() => {
			const current = this.findTask(runId, taskId);
			if (current === task && current.finalizing) this.terminateTask(runId, taskId, result);
		});
	}

	/**
	 * One bounded final context refresh before termination. Timeout, child exit,
	 * unsupported command, malformed payload, or rejection clears current context
	 * availability but never blocks confirmed process cleanup or changes task
	 * success solely because telemetry failed.
	 */
	private finalContextRefresh(task: TaskState): Promise<void> {
		const child = task.child;
		if (!child?.refreshSessionStats) return Promise.resolve();
		let timedOut = false;
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(() => {
				timedOut = true;
				resolve();
			}, FINAL_CONTEXT_REFRESH_TIMEOUT_MS);
			timer.unref?.();
		});
		const refresh = child
			.refreshSessionStats()
			.then((snapshot) => {
				if (!timedOut) task.contextUsage = snapshot;
			})
			.catch(() => {
				if (!timedOut) task.contextUsage = undefined;
			});
		return Promise.race([timeout, refresh]).then(() => {
			if (timer) clearTimeout(timer);
			if (timedOut) task.contextUsage = undefined;
		});
	}

	private terminateTask(runId: string, taskId: string, result: FinalizationResult): void {
		const task = this.findTask(runId, taskId);
		if (!task || !task.finalizing || !task.child) return;
		void task.child
			.terminate()
			.then((reaped) => this.finishFinalization(runId, taskId, result, reaped))
			.catch((error) =>
				this.finishFinalization(
					runId,
					taskId,
					{
						status: "failed",
						error: `${result.error ?? "completed"}; cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
						manualKill: result.manualKill,
						notifyParent: result.notifyParent,
					},
					false,
				),
			);
	}

	private finishFinalization(
		runId: string,
		taskId: string,
		result: FinalizationResult,
		reaped: boolean,
	): void {
		const task = this.findTask(runId, taskId);
		if (!task || !task.finalizing) return;
		task.finalizing = false;
		task.reaped = reaped;
		task.status = reaped ? result.status : "failed";
		task.error =
			task.status === "done"
				? undefined
				: reaped
					? (result.error ?? "failed")
					: `${result.error ?? "failed"}; child process cleanup could not be confirmed`;
		task.finishedAt = this.now();
		task.lastEventAt = task.finishedAt;
		const notifyParent = result.notifyParent !== false && !task.suppressWake;
		task.unreaped = notifyParent;
		task.spawnSpec = undefined;
		const run = this.runs.get(runId);
		if (run && reaped) this.startQueuedTasks(run);
		this.notifyListeners();
		if (notifyParent) this.notifyParent(task);
	}

	private notifyListeners(): void {
		if (this.disposed) return;
		for (const listener of this.listeners) listener();
	}

	private notifyParent(task: TaskState): void {
		if (this.disposed) {
			task.unreaped = false;
			return;
		}
		if (this.inSettleCheck) {
			// Leave unreaped; onParentSettled recheck will wake exactly once.
			return;
		}
		if (this.parentWaiting) {
			this.parentWaiting = false;
			this.wake([task], /* steer */ false);
			return;
		}
		this.wake([task], /* steer */ true);
	}

	private wake(tasks: TaskState[], steer: boolean): void {
		const pending = tasks.filter((task) => task.unreaped);
		if (pending.length === 0) return;
		const content = pending.map(wakeMessage).join("\n");
		for (const task of pending) {
			task.unreaped = false;
			task.pendingSoft = undefined;
		}
		void this.sendUserMessage(content, steer ? { deliverAs: "steer" } : undefined);
	}
}

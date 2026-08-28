import { randomUUID } from "node:crypto";

import type { Message } from "@earendil-works/pi-ai";

import {
	RpcChild,
	emptyUsage,
	type ChildUiSnapshot,
	type RpcChildOptions,
	type RpcEvent,
} from "./rpc-client.ts";
import {
	MAX_PARALLEL_SUBAGENTS,
	MAX_SUBAGENT_TIMEOUT_MS,
	type ContextUsageSnapshot,
	type PersistentChildSession,
	type SubagentMode,
	type ThinkingLevel,
	type UsageStats,
	type WorkspaceMode,
} from "./contracts.ts";
export {
	SUBAGENT_MODES,
	WORKSPACE_MODES,
	type PersistentChildSession,
	type SubagentMode,
	type WorkspaceMode,
} from "./contracts.ts";
import { isTransientProviderFailure, providerErrorText } from "../lib/provider-retry.ts";
import {
	MAX_CHANGED_FILES,
	MAX_RECENT_TOOL_ERRORS,
	ActivityTracker,
	type RecentToolActivity,
	type RecentToolError,
} from "./activity.ts";

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
	/** Explicitly read-only work uses the shorter default timeout. */
	readOnly?: boolean;
	/** Optional per-invocation wall-clock timeout, capped at 60 minutes. */
	timeoutMs?: number;
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
	readOnly: boolean;
	timeoutMs: number;
	sessionId?: string;
	status: TaskStatus;
	output: string;
	error?: string;
	manualKill?: boolean;
	usage: UsageStats;
	/** Latest validated context occupancy; cleared when a newer refresh fails. */
	contextUsage?: ContextUsageSnapshot;
	/** Frozen child transcript retained after terminal cleanup. */
	messages?: Message[];
	/** Frozen child UI projection retained after terminal cleanup. */
	uiState?: ChildUiSnapshot;
	child?: ChildHandle;
	/** Spawn inputs retained while queued; never persisted. */
	spawnSpec?: TaskSpawnSpec;
	/** Last assistant provider failure observed before agent_settled. */
	providerFailure?: { error: string; retryable: boolean };
	/** Start of the current continuous transient-failure recovery window. */
	providerRetryWindowStartedAt?: number;
	providerRetryCount: number;
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
	/** Completion recorded but not yet delivered via a wake. */
	unreaped: boolean;
	timedOut?: boolean;
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
	timedOut?: boolean;
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

export type ParentWakeKind = "completion" | "checkpoint";

export interface ProgressCheckpoint {
	runId: string;
	taskId: string;
	status: TaskStatus;
	elapsedMs: number;
	lastEventAgeMs: number;
	turns: number;
	outputTokens: number;
	outputTokensDelta: number;
	costUsd: number;
	costUsdDelta: number;
	toolCalls: number;
	succeededTools: number;
	failedTools: number;
	runningTools: number;
	recentTools: RecentToolActivity[];
	changedFiles: string[];
	recentErrors: RecentToolError[];
	consecutiveToolFailures: number;
}

export interface ParentWakeOptions {
	deliverAs?: "steer" | "followUp";
	kind?: ParentWakeKind;
	checkpoint?: ProgressCheckpoint | ProgressCheckpoint[];
}

export type SendUserMessage = (
	content: string,
	options?: ParentWakeOptions,
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
	runningTools: number;
	changedFiles: string[];
	/** Current git working-tree changes, populated opportunistically by subagent_status. */
	workspaceChanges?: string[];
	recentTools: RecentToolActivity[];
	recentErrors: RecentToolError[];
	consecutiveToolFailures: number;
	outputTokens: number;
}

export interface AbortAssessment {
	status: TaskStatus;
	activityToken: string;
	eventAgeMs: number;
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
	readOnly: boolean;
	timeoutMs: number;
	timedOut?: boolean;
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
	timedOut?: boolean;
}

export interface SupervisorOptions {
	sendUserMessage: SendUserMessage;
	/** Defaults to constructing a real RpcChild. Inject a fake in tests. */
	createChild?: ChildFactory;
	/** Legacy global hard timeout override; per-task timeoutMs takes precedence. */
	taskTimeoutMs?: number;
	/** Scheduled parent progress checkpoint interval. Default 2 minutes. */
	checkpointIntervalMs?: number;
	/** Deterministic process-cleanup retry interval. Default 30 seconds. */
	cleanupTickMs?: number;
	/** Clock injection for deterministic tests. Defaults to Date.now. */
	now?: () => number;
	/** Persist terminal/reaping transitions independently from wake delivery. */
	onTerminalStateChange?: () => void;
	defaultTools?: string[];
	/** Hard cap across all runs owned by this supervisor. Defaults to MAX_PARALLEL_SUBAGENTS. */
	maxActiveChildren?: number;
	/** Optional safety cap after the child Pi retry policy is exhausted. */
	maxTransientRetries?: number;
	/** Initial delay between child recovery attempts. Defaults to 2 seconds. */
	transientRetryBaseDelayMs?: number;
	/** Continuous transient-failure recovery window. Defaults to one minute. */
	transientRetryWindowMs?: number;
	/**
	 * Called after the outstanding-work check and before parentWaiting is set.
	 * Tests use this to inject the settle/flag race; production leaves it unset.
	 */
	betweenSettleCheckAndWait?: () => void;
}

export const DEFAULT_READ_ONLY_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_WRITE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_CHECKPOINT_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_CLEANUP_TICK_MS = 30_000;
const DEFAULT_MAX_ACTIVE_CHILDREN = MAX_PARALLEL_SUBAGENTS;
const DEFAULT_TRANSIENT_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_TRANSIENT_RETRY_WINDOW_MS = 60_000;
const MAX_TRANSIENT_RETRY_DELAY_MS = 30_000;
const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
/** Bound on the final context refresh before normal process termination begins. */
const FINAL_CONTEXT_REFRESH_TIMEOUT_MS = 1000;
const STDERR_TAIL_MAX = 500;
const CHECKPOINT_EVENT_MAX_CHARS = 1024;
const CHECKPOINT_STRING_MAX = 80;
const ANSI_ESCAPE_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function resolveTaskTimeoutMs(
	readOnly: boolean,
	requested?: number,
	legacyOverride?: number,
): number {
	const fallback = readOnly ? DEFAULT_READ_ONLY_TIMEOUT_MS : DEFAULT_WRITE_TIMEOUT_MS;
	const value = requested ?? legacyOverride;
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(MAX_SUBAGENT_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

function oneLine(text: string): string {
	const line = text.trim().split(/\r?\n/)[0] ?? "";
	return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

function finiteMetric(value: number | undefined): number {
	return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function boundedCheckpointText(value: string): string {
	const oneLineValue = value.replace(/\s+/g, " ").trim();
	return oneLineValue.length <= CHECKPOINT_STRING_MAX
		? oneLineValue
		: `${oneLineValue.slice(0, CHECKPOINT_STRING_MAX - 3)}...`;
}

function boundCheckpoint(checkpoint: ProgressCheckpoint): ProgressCheckpoint {
	const bounded: ProgressCheckpoint = {
		...checkpoint,
		recentTools: checkpoint.recentTools.slice(-6).map((tool) => ({
			...tool,
			args: boundedCheckpointText(tool.args),
		})),
		changedFiles: checkpoint.changedFiles.slice(-MAX_CHANGED_FILES).map(boundedCheckpointText),
		recentErrors: checkpoint.recentErrors.slice(-MAX_RECENT_TOOL_ERRORS).map((error) => ({
			...error,
			toolName: boundedCheckpointText(error.toolName),
			target: boundedCheckpointText(error.target),
			message: boundedCheckpointText(error.message),
		})),
	};
	while (JSON.stringify(bounded).length > CHECKPOINT_EVENT_MAX_CHARS) {
		if (bounded.changedFiles.length > 2) bounded.changedFiles.shift();
		else if (bounded.recentErrors.length > 2) bounded.recentErrors.shift();
		else if (bounded.recentTools.length > 3) bounded.recentTools.shift();
		else break;
	}
	return bounded;
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
 */
export class Supervisor {
	readonly runs = new Map<string, RunState>();

	private readonly sendUserMessage: SendUserMessage;
	private readonly createChild: ChildFactory;
	private readonly taskTimeoutMs: number | undefined;
	private readonly checkpointIntervalMs: number;
	private readonly cleanupTickMs: number;
	private readonly now: () => number;
	private readonly onTerminalStateChange?: () => void;
	private readonly defaultTools: string[];
	private readonly maxActiveChildren: number;
	private readonly maxTransientRetries: number | undefined;
	private readonly transientRetryBaseDelayMs: number;
	private readonly transientRetryWindowMs: number;
	private readonly betweenSettleCheckAndWait?: () => void;
	private readonly timeouts = new Map<string, NodeJS.Timeout>();
	private readonly checkpointTimers = new Map<string, NodeJS.Timeout>();
	private readonly checkpointBaselines = new Map<
		string,
		{ outputTokens: number; costUsd: number }
	>();
	private readonly pendingCheckpoints = new Set<string>();
	private readonly checkpointWakeTasks = new Set<string>();
	private readonly providerRetryTimers = new Map<string, NodeJS.Timeout>();
	private readonly abortFallbacks = new Map<string, NodeJS.Timeout>();
	private readonly activityTrackers = new Map<string, ActivityTracker>();
	private readonly exitHandlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];
	private readonly listeners = new Set<() => void>();
	private cleanupTimer?: NodeJS.Timeout;
	private deferredKillTimer?: NodeJS.Timeout;
	private disposed = false;
	private scheduling = false;
	private scheduleRequested = false;
	private checkpointWakeOutstanding = false;
	private wakeInFlight = false;
	private wakeDispatchScheduled = false;

	/** Parent has settled and is waiting for the next task completion or checkpoint. */
	private parentWaiting = false;
	/** True only during the outstanding-check → parentWaiting=true window. */
	private inSettleCheck = false;

	constructor(options: SupervisorOptions) {
		this.sendUserMessage = options.sendUserMessage;
		this.createChild = options.createChild ?? ((opts) => new RpcChild(opts));
		this.taskTimeoutMs =
			options.taskTimeoutMs === undefined
				? undefined
				: resolveTaskTimeoutMs(false, options.taskTimeoutMs);
		this.checkpointIntervalMs = nonNegativeInteger(
			options.checkpointIntervalMs,
			DEFAULT_CHECKPOINT_INTERVAL_MS,
		);
		this.cleanupTickMs = options.cleanupTickMs ?? DEFAULT_CLEANUP_TICK_MS;
		this.now = options.now ?? (() => Date.now());
		this.onTerminalStateChange = options.onTerminalStateChange;
		this.defaultTools = options.defaultTools ?? DEFAULT_TOOLS;
		this.maxActiveChildren = Math.max(1, options.maxActiveChildren ?? DEFAULT_MAX_ACTIVE_CHILDREN);
		this.maxTransientRetries =
			options.maxTransientRetries === undefined
				? undefined
				: nonNegativeInteger(options.maxTransientRetries, 0);
		this.transientRetryBaseDelayMs = nonNegativeInteger(
			options.transientRetryBaseDelayMs,
			DEFAULT_TRANSIENT_RETRY_BASE_DELAY_MS,
		);
		this.transientRetryWindowMs = nonNegativeInteger(
			options.transientRetryWindowMs,
			DEFAULT_TRANSIENT_RETRY_WINDOW_MS,
		);
		this.betweenSettleCheckAndWait = options.betweenSettleCheckAndWait;
		this.installProcessHandlers();
		this.installCleanupTimer();
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
			const readOnly = spec.readOnly === true;
			const timeoutMs = resolveTaskTimeoutMs(readOnly, spec.timeoutMs, this.taskTimeoutMs);
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
				readOnly,
				timeoutMs,
				sessionId: spec.persistentSession?.sessionId,
				status: "queued",
				output: "",
				usage: emptyUsage(),
				spawnSpec: spec,
				providerRetryCount: 0,
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
	 * completion or checkpoint wake instead of going idle. The outstanding check,
	 * waiting flag, and recheck form a condition variable around parent wakes.
	 */
	onParentSettled(): void {
		// A previously delivered wake has now had its one parent turn. Release its
		// deduplication slot and begin the next checkpoint interval only now.
		this.wakeInFlight = false;
		this.finishCheckpointWake();

		let hadRunningTasks = false;
		this.inSettleCheck = true;
		try {
			hadRunningTasks = this.hasRunningTasks();
			if (hadRunningTasks) {
				this.betweenSettleCheckAndWait?.();
				this.parentWaiting = true;
			} else {
				this.parentWaiting = false;
			}
		} finally {
			this.inSettleCheck = false;
		}

		// Recheck: terminal-run completion batches or checkpoints can race the check above.
		if (this.wakeableCompletions().length > 0 || this.pendingCheckpointTasks().length > 0) {
			this.parentWaiting = true;
			this.dispatchWake();
			return;
		}
		if (!this.hasRunningTasks()) this.parentWaiting = false;
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
			timedOut: task.timedOut,
		};
	}

	/** Retry only deterministic process cleanup work. */
	tickCleanup(): void {
		for (const run of this.runs.values()) {
			for (const task of run.tasks) {
				if (isTerminalStatus(task.status) && !task.reaped) this.retryCleanup(run, task);
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
		for (const timer of this.checkpointTimers.values()) clearTimeout(timer);
		this.checkpointTimers.clear();
		this.pendingCheckpoints.clear();
		this.checkpointWakeTasks.clear();
		this.checkpointBaselines.clear();
		for (const timer of this.abortFallbacks.values()) clearTimeout(timer);
		this.abortFallbacks.clear();
		for (const timer of this.providerRetryTimers.values()) clearTimeout(timer);
		this.providerRetryTimers.clear();
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = undefined;
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

	private installCleanupTimer(): void {
		if (this.cleanupTickMs <= 0) return;
		const timer = setInterval(() => this.tickCleanup(), this.cleanupTickMs);
		timer.unref?.();
		this.cleanupTimer = timer;
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
			this.activityTrackers.set(task.taskId, new ActivityTracker());
			const timer = setTimeout(() => this.onTaskTimeout(run.runId, task.taskId), task.timeoutMs);
			timer.unref?.();
			this.timeouts.set(task.taskId, timer);
			this.checkpointBaselines.set(task.taskId, { outputTokens: 0, costUsd: 0 });
			this.scheduleCheckpoint(run.runId, task.taskId);
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

	/** Batch successful completions until their run settles; surface failures immediately. */
	private wakeableCompletions(): TaskState[] {
		const out: TaskState[] = [];
		for (const run of this.runs.values()) {
			const pending = run.tasks.filter((task) => task.unreaped);
			if (pending.length === 0) continue;
			const runSettled = run.tasks.every((task) => isTerminalStatus(task.status));
			const hasFailure = pending.some((task) => task.status === "failed");
			if (runSettled || hasFailure) out.push(...pending);
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
				const tracker = this.activityTrackers.get(task.taskId);
				const facts = tracker?.activity(now);
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
					readOnly: task.readOnly,
					timeoutMs: task.timeoutMs,
					timedOut: task.timedOut,
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
								runningTools: facts?.runningTools ?? 0,
								changedFiles: facts?.changedFiles ?? [],
								recentTools: facts?.recentTools ?? [],
								recentErrors: facts?.recentErrors ?? [],
								consecutiveToolFailures: facts?.consecutiveToolFailures ?? 0,
								outputTokens: facts?.outputTokens ?? 0,
							}
						: undefined,
				};
			}),
		};
	}

	private scheduleCheckpoint(runId: string, taskId: string): void {
		if (this.checkpointIntervalMs <= 0 || this.disposed) return;
		const previous = this.checkpointTimers.get(taskId);
		if (previous) clearTimeout(previous);
		const timer = setTimeout(() => {
			this.checkpointTimers.delete(taskId);
			const task = this.findTask(runId, taskId);
			if (!task || !isActiveStatus(task.status) || task.finalizing) return;
			this.pendingCheckpoints.add(taskId);
			if (!this.wakeInFlight && !this.checkpointWakeOutstanding && !this.inSettleCheck)
				this.scheduleWakeDispatch();
		}, this.checkpointIntervalMs);
		timer.unref?.();
		this.checkpointTimers.set(taskId, timer);
	}

	private scheduleWakeDispatch(): void {
		if (this.wakeDispatchScheduled || this.disposed) return;
		this.wakeDispatchScheduled = true;
		queueMicrotask(() => {
			this.wakeDispatchScheduled = false;
			this.dispatchWake();
		});
	}

	private pendingCheckpointTasks(): TaskState[] {
		const tasks: TaskState[] = [];
		for (const taskId of this.pendingCheckpoints) {
			const task = this.findTaskAnywhere(taskId);
			if (task && isActiveStatus(task.status) && !task.finalizing) tasks.push(task);
		}
		return tasks;
	}

	private findTaskAnywhere(taskId: string): TaskState | undefined {
		for (const run of this.runs.values()) {
			const task = run.tasks.find((candidate) => candidate.taskId === taskId);
			if (task) return task;
		}
		return undefined;
	}

	private cancelCheckpoint(taskId: string): void {
		const timer = this.checkpointTimers.get(taskId);
		if (timer) clearTimeout(timer);
		this.checkpointTimers.delete(taskId);
		this.pendingCheckpoints.delete(taskId);
	}

	private finishCheckpointWake(): void {
		if (!this.checkpointWakeOutstanding) return;
		const delivered = [...this.checkpointWakeTasks];
		this.checkpointWakeTasks.clear();
		this.checkpointWakeOutstanding = false;
		for (const taskId of delivered) {
			const task = this.findTaskAnywhere(taskId);
			if (!task || !isActiveStatus(task.status) || task.finalizing) continue;
			if (!this.pendingCheckpoints.has(taskId)) {
				const run = [...this.runs.values()].find((candidate) =>
					candidate.tasks.some((item) => item.taskId === taskId),
				);
				if (run) this.scheduleCheckpoint(run.runId, taskId);
			}
		}
	}

	private buildCheckpoint(run: RunState, task: TaskState, now: number): ProgressCheckpoint {
		const facts = this.activityTrackers.get(task.taskId)?.activity(now);
		const usage = task.child?.usage ?? task.usage;
		const outputTokens = Math.max(finiteMetric(usage.output), finiteMetric(facts?.outputTokens));
		const costUsd = Math.max(finiteMetric(usage.cost), finiteMetric(facts?.costUsd));
		const turns = Math.max(
			Math.floor(finiteMetric(usage.turns)),
			Math.floor(finiteMetric(facts?.turns)),
		);
		const previous = this.checkpointBaselines.get(task.taskId) ?? {
			outputTokens: 0,
			costUsd: 0,
		};
		return boundCheckpoint({
			runId: run.runId,
			taskId: task.taskId,
			status: task.status,
			elapsedMs: Math.max(0, now - task.startedAt),
			lastEventAgeMs: Math.max(0, now - task.lastEventAt),
			turns,
			outputTokens,
			outputTokensDelta: Math.max(0, outputTokens - previous.outputTokens),
			costUsd,
			costUsdDelta: Math.max(0, costUsd - previous.costUsd),
			toolCalls: facts?.toolCalls ?? 0,
			succeededTools: facts?.succeededTools ?? 0,
			failedTools: facts?.failedTools ?? 0,
			runningTools: facts?.runningTools ?? 0,
			recentTools: facts?.recentTools ?? [],
			changedFiles: facts?.changedFiles ?? [],
			recentErrors: facts?.recentErrors ?? [],
			consecutiveToolFailures: facts?.consecutiveToolFailures ?? 0,
		});
	}

	private dispatchWake(deliverAsOverride?: "steer" | "followUp"): void {
		if (this.disposed || this.wakeInFlight) return;
		const completions = this.wakeableCompletions();
		for (const task of completions) this.cancelCheckpoint(task.taskId);
		const completionIds = new Set(completions.map((task) => task.taskId));
		const checkpointTasks = this.pendingCheckpointTasks().filter(
			(task) => !completionIds.has(task.taskId),
		);
		if (completions.length === 0 && checkpointTasks.length === 0) return;

		const checkpoints = checkpointTasks.map((task) => {
			const run = [...this.runs.values()].find((candidate) =>
				candidate.tasks.some((item) => item.taskId === task.taskId),
			);
			if (!run) return undefined;
			const checkpoint = this.buildCheckpoint(run, task, this.now());
			const bounded = boundCheckpoint(checkpoint);
			this.checkpointBaselines.set(task.taskId, {
				outputTokens: checkpoint.outputTokens,
				costUsd: checkpoint.costUsd,
			});
			return bounded;
		});
		const deliveredCheckpoints = checkpoints.filter(
			(checkpoint): checkpoint is ProgressCheckpoint => checkpoint !== undefined,
		);
		const parts = completions.map(wakeMessage);
		if (deliveredCheckpoints.length > 0) {
			const payload =
				deliveredCheckpoints.length === 1 ? deliveredCheckpoints[0] : deliveredCheckpoints;
			parts.push(
				`Progress checkpoint: ${JSON.stringify(payload)}\n` +
					"Inspect this supplied snapshot. If activity is healthy, settle without calling subagent_status. " +
					"Do not poll between checkpoints. Use one fresh subagent_status only when steering or aborting requires current race-safe evidence.",
			);
		}
		const wasWaiting = this.parentWaiting;
		this.parentWaiting = false;
		this.wakeInFlight = true;
		for (const task of completions) task.unreaped = false;
		for (const task of checkpointTasks) this.pendingCheckpoints.delete(task.taskId);
		if (deliveredCheckpoints.length > 0) {
			this.checkpointWakeOutstanding = true;
			for (const checkpoint of deliveredCheckpoints)
				this.checkpointWakeTasks.add(checkpoint.taskId);
		}
		const options: ParentWakeOptions = {
			kind: deliveredCheckpoints.length > 0 ? "checkpoint" : "completion",
		};
		const deliverAs = deliverAsOverride ?? (wasWaiting ? undefined : "steer");
		if (deliverAs) options.deliverAs = deliverAs;
		if (deliveredCheckpoints.length > 0)
			options.checkpoint =
				deliveredCheckpoints.length === 1 ? deliveredCheckpoints[0] : deliveredCheckpoints;
		void this.sendUserMessage(parts.join("\n"), options);
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
				this.notifyListeners();
				this.onTerminalStateChange?.();
			})
			.catch(() => {
				task.cleanupRetrying = false;
			});
	}

	private formatProviderFailure(task: TaskState, error: string): string {
		const attempts = task.providerRetryCount;
		if (attempts === 0) return error;
		const label = attempts === 1 ? "attempt" : "attempts";
		return `provider error after ${attempts} automatic recovery ${label}: ${error}`;
	}

	/**
	 * Retry a failed child turn after native Pi retries are exhausted. The child
	 * session remains alive, so the next prompt can continue without losing the
	 * task context or persistent-session identity.
	 */
	private scheduleProviderRetry(runId: string, taskId: string): void {
		const task = this.findTask(runId, taskId);
		const failure = task?.providerFailure;
		if (
			!task ||
			!failure ||
			!failure.retryable ||
			!task.child ||
			this.disposed ||
			this.providerRetryTimers.has(taskId)
		)
			return;
		const failureObservedAt = this.now();
		task.providerRetryWindowStartedAt ??= failureObservedAt;
		const elapsedMs = Math.max(0, failureObservedAt - task.providerRetryWindowStartedAt);
		if (
			(this.maxTransientRetries !== undefined &&
				task.providerRetryCount >= this.maxTransientRetries) ||
			elapsedMs >= this.transientRetryWindowMs
		) {
			this.beginFinalization(runId, taskId, {
				status: "failed",
				error: this.formatProviderFailure(task, failure.error),
			});
			return;
		}

		const attempt = ++task.providerRetryCount;
		const backoffMs = Math.min(
			MAX_TRANSIENT_RETRY_DELAY_MS,
			this.transientRetryBaseDelayMs * 2 ** (attempt - 1),
		);
		const remainingMs = Math.max(0, this.transientRetryWindowMs - elapsedMs);
		if (backoffMs >= remainingMs) {
			this.beginFinalization(runId, taskId, {
				status: "failed",
				error: this.formatProviderFailure(task, failure.error),
			});
			return;
		}

		task.providerFailure = undefined;
		task.lastEventAt = this.now();
		this.notifyListeners();
		const timer = setTimeout(() => {
			this.providerRetryTimers.delete(taskId);
			const current = this.findTask(runId, taskId);
			if (!current || current.status !== "running" || current.finalizing || !current.child) return;
			void current.child
				.prompt(
					"[INTERNAL PROVIDER RECOVERY]\n" +
						"The previous model response failed due to a transient provider or network error. " +
						"Continue the original task from the current session state. Inspect current state " +
						"before repeating any side effects.",
				)
				.catch((error) => {
					const latest = this.findTask(runId, taskId);
					if (!latest || latest.finalizing || isTerminalStatus(latest.status)) return;
					const message = error instanceof Error ? error.message : String(error);
					this.beginFinalization(runId, taskId, {
						status: "failed",
						error: formatChildExitError(current.child!, message),
					});
				});
		}, backoffMs);
		timer.unref?.();
		this.providerRetryTimers.set(taskId, timer);
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
		if (task.status === "running") this.activityTrackers.get(taskId)?.observe(event, now);
		if (event.type === "message_end") {
			const message = event.message as {
				role?: unknown;
				stopReason?: unknown;
				errorMessage?: unknown;
			};
			if (message.role === "assistant") {
				if (message.stopReason === "error") {
					const error = providerErrorText(message) || "provider returned an unstructured error";
					const retryable = isTransientProviderFailure(message);
					task.providerFailure = { error, retryable };
					if (retryable) task.providerRetryWindowStartedAt ??= now;
				} else if (message.stopReason !== "aborted") {
					task.providerFailure = undefined;
					task.providerRetryCount = 0;
					task.providerRetryWindowStartedAt = undefined;
				}
			}
		}
		if (event.type === "agent_settled") {
			if (task.abortRequested) {
				this.beginFinalization(runId, taskId, {
					status: "failed",
					error: `aborted by parent: ${task.abortReason ?? "unspecified reason"}`,
				});
			} else if (task.providerFailure) {
				if (task.providerFailure.retryable) this.scheduleProviderRetry(runId, taskId);
				else
					this.beginFinalization(runId, taskId, {
						status: "failed",
						error: task.providerFailure.error,
					});
			} else {
				this.beginFinalization(runId, taskId, { status: "done" });
			}
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
			error: `timed out after ${task.timeoutMs}ms`,
			timedOut: true,
		});
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

	private snapshotChildPresentation(task: TaskState): void {
		const child = task.child;
		if (!child) return;
		try {
			const messages = child.transcript?.();
			if (messages) task.messages = structuredClone([...messages]);
		} catch {
			// Preserve the most recent valid snapshot when child projection fails.
		}
		try {
			const uiState = child.uiSnapshot?.();
			if (uiState) task.uiState = structuredClone(uiState);
		} catch {
			// UI projection is best-effort and must not block child cleanup.
		}
	}

	private beginFinalization(runId: string, taskId: string, result: FinalizationResult): void {
		const abortFallback = this.abortFallbacks.get(taskId);
		if (abortFallback) {
			clearTimeout(abortFallback);
			this.abortFallbacks.delete(taskId);
		}
		const providerRetry = this.providerRetryTimers.get(taskId);
		if (providerRetry) {
			clearTimeout(providerRetry);
			this.providerRetryTimers.delete(taskId);
		}
		const task = this.findTask(runId, taskId);
		if (!task || isTerminalStatus(task.status) || task.finalizing) return;
		this.cancelCheckpoint(taskId);
		task.finalizing = true;
		task.status = "stopping";
		const timer = this.timeouts.get(taskId);
		if (timer) {
			clearTimeout(timer);
			this.timeouts.delete(taskId);
		}
		this.activityTrackers.delete(taskId);
		task.manualKill = result.manualKill;
		if (task.child) {
			try {
				task.output = task.child.output();
				task.usage = { ...task.child.usage };
			} catch {
				// Preserve any previously captured state.
			}
			this.snapshotChildPresentation(task);
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
		const child = task?.child;
		if (!task || !task.finalizing || !child?.terminate) return;
		void child
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
						timedOut: result.timedOut,
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
		// Capture events flushed while termination was in progress, including the
		// latest streaming assistant snapshot on hard timeout.
		this.snapshotChildPresentation(task);
		task.finalizing = false;
		task.reaped = reaped;
		task.status = reaped ? result.status : "failed";
		task.error =
			task.status === "done"
				? undefined
				: reaped
					? (result.error ?? "failed")
					: `${result.error ?? "failed"}; child process cleanup could not be confirmed`;
		task.timedOut = result.timedOut;
		task.finishedAt = this.now();
		task.lastEventAt = task.finishedAt;
		const notifyParent = result.notifyParent !== false && !task.suppressWake;
		task.unreaped = notifyParent;
		task.spawnSpec = undefined;
		const run = this.runs.get(runId);
		if (run && reaped) this.startQueuedTasks(run);
		this.notifyListeners();
		this.onTerminalStateChange?.();
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
		this.dispatchWake(this.parentWaiting ? undefined : "steer");
	}
}

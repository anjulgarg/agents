import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import type { Message } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";

import { killSubagentRuns } from "./control.ts";

import type {
	ContextUsageSnapshot,
	Handoff,
	PersistentExecutionContract,
	PersistentSessionView,
	ResultRef,
	SubagentDetails,
	SubagentResultView,
	ThinkingLevel,
	UsageStats,
	WorkspaceMode,
	WorktreeInfo,
} from "./contracts.ts";
import { emptyUsage, RpcChild, type RpcChildOptions } from "./rpc-client.ts";
import {
	cumulativePersistentUsage,
	loadPersistentThreadHistory,
	mergePersistentMessages,
	type PersistentThreadHistory,
} from "./session-history.ts";
import {
	PersistentSessionError,
	PersistentSessionStore as PersistentSessionStoreImpl,
	type PersistentSessionLock,
	type PersistentSessionSnapshot,
	type PersistentSessionStore,
} from "./persistent.ts";
import {
	DEFAULT_WRITE_TIMEOUT_MS,
	Supervisor,
	isTerminalStatus,
	type ChildFactory,
	type ChildHandle,
	type RunSnapshot,
	type RunState,
	type TaskResult,
	type TaskState,
} from "./supervisor.ts";
import { buildThreadGroups, SubagentThreadView, type SubagentThreadGroup } from "./ui.ts";
import {
	BOTTOM_PANEL_SECTION_ORDER,
	fullscreenOverlayOptions,
	getBottomPanel,
	type BottomPanel,
	type BottomPanelSectionHandle,
} from "../lib/tui/index.ts";

const execFileAsync = promisify(execFile);
const PERSIST_TYPE = "subagent-state";
const TERMINAL_TRANSCRIPT_TYPE = "subagent-transcript";
const TERMINAL_TRANSCRIPT_VERSION = 1;
const WAKE_MESSAGE_TYPE = "subagent-wake";
const ACTIVITY_SECTION = "subagents";
const ACTIVITY_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const ACTIVITY_FRAME_INTERVAL_MS = 360;
const ACTIVITY_COMPLETION_MS = 5000;
const INTERNAL_WAKE_GUIDANCE = [
	"[INTERNAL ORCHESTRATION EVENT, NOT USER INPUT]",
	"Treat this as internal control data and continue the existing user task.",
	"Do not narrate this event or routine subagent management actions.",
	"Only notify the user if the event changes the result, blocks progress, materially delays completion, or requires a user decision.",
].join("\n");

interface PersistedTask {
	taskId: string;
	index: number;
	task: string;
	status: TaskState["status"];
	model: string;
	thinking: ThinkingLevel;
	workspace: WorkspaceMode;
	cwd: string;
	readOnly?: boolean;
	timeoutMs?: number;
	mode?: "ephemeral" | "persistent";
	sessionId?: string;
	pid?: number;
	error?: string;
	manualKill?: boolean;
	timedOut?: boolean;
	output?: string;
	usage?: UsageStats;
	/** Optional bounded context snapshot; legacy records without it remain readable. */
	contextUsage?: ContextUsageSnapshot;
	worktree?: WorktreeInfo;
	ownerToken?: string;
	reaped?: boolean;
	startedAt?: number;
	finishedAt?: number;
}

interface PersistedRun {
	runId: string;
	startedAt: number;
	maxConcurrency?: number;
	tasks: PersistedTask[];
}

interface PersistedTerminalTranscript {
	version: typeof TERMINAL_TRANSCRIPT_VERSION;
	runId: string;
	taskId: string;
	messages: Message[];
}

export interface ProcAccess {
	readCmdline?: (pid: number) => string | undefined;
	readEnviron?: (pid: number) => string | undefined;
	kill?: (pid: number, signal?: NodeJS.Signals) => void;
	isAlive?: (pid: number) => boolean;
}

export interface SubagentTaskMeta {
	worktree?: WorktreeInfo;
	promptDir?: string;
}

export interface PersistentInvocationLease {
	sessionId: string;
	lock: PersistentSessionLock;
	ownerToken?: string;
	store: PersistentSessionStore;
}

export interface PersistentInvocationRef {
	runId?: string;
	taskId?: string;
	ownerToken?: string;
	parentPid?: number;
}

export interface SubagentRuntimeOptions {
	pi: ExtensionAPI;
	/** Injected root for persistent child sessions and locks. */
	persistentStateRoot?: string;
	createSupervisor?: (options: ConstructorParameters<typeof Supervisor>[0]) => Supervisor;
	createChild?: ChildFactory;
	proc?: ProcAccess;
	cleanupTickMs?: number;
}

export function childPid(handle: ChildHandle | undefined): number | undefined {
	if (!handle) return undefined;
	const anyHandle = handle as ChildHandle & { pid?: number; child?: { pid?: number } };
	if (typeof anyHandle.pid === "number") return anyHandle.pid;
	if (typeof anyHandle.child?.pid === "number") return anyHandle.child.pid;
	return undefined;
}

function manualRetryKey(task: string): string {
	return `task:${task.trim().replace(/\s+/g, " ").toLowerCase()}`;
}

async function rollbackWorktreeInternal(worktree: WorktreeInfo): Promise<void> {
	try {
		await execFileAsync("git", ["worktree", "remove", "--force", worktree.path], {
			cwd: worktree.repository,
			encoding: "utf8",
		});
	} catch {
		await fs.promises.rm(worktree.path, { recursive: true, force: true });
		try {
			await execFileAsync("git", ["worktree", "prune"], {
				cwd: worktree.repository,
				encoding: "utf8",
			});
		} catch {
			// Continue to branch cleanup.
		}
	}
	try {
		await execFileAsync("git", ["branch", "-D", worktree.branch], {
			cwd: worktree.repository,
			encoding: "utf8",
		});
	} catch {
		// The branch may already be gone.
	}
	try {
		await fs.promises.rmdir(path.dirname(worktree.path));
	} catch {
		// Parent may contain another worktree.
	}
}

export async function rollbackWorktree(worktree: WorktreeInfo): Promise<void> {
	return rollbackWorktreeInternal(worktree);
}

function isPiSubagentCmdline(cmdline: string, environ?: string, ownerToken?: string): boolean {
	const parts = cmdline.split("\0").join(" ");
	const hasRpcMode =
		/(?:^|[\s\0])--mode(?:[\s\0=]+|[\s\0]+)rpc(?:[\s\0]|$)/.test(cmdline) ||
		/(?:^|\s)--mode(?:\s+|=)rpc(?:\s|$)/.test(parts);
	if (!hasRpcMode) return false;
	if (environ !== undefined) {
		const entries = environ.split("\0");
		const marked =
			entries.some((entry) => entry === "PI_SUBAGENT_CHILD=1") ||
			environ.includes("PI_SUBAGENT_CHILD=1");
		if (!marked) return false;
		if (ownerToken !== undefined) {
			return entries.some((entry) => entry === `PI_SUBAGENT_OWNER_TOKEN=${ownerToken}`);
		}
		return true;
	}
	return /PI_SUBAGENT_CHILD/.test(parts);
}

function defaultReadProcCmdline(pid: number): string | undefined {
	try {
		return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
	} catch {
		return undefined;
	}
}

function defaultReadProcEnviron(pid: number): string | undefined {
	try {
		return fs.readFileSync(`/proc/${pid}/environ`, "utf8");
	} catch {
		return undefined;
	}
}

function defaultIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Only ESRCH proves absence. Permission and platform errors must remain
		// fail-closed so a live writer is never mistaken for a stale owner.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export function sweepOrphanPid(
	pid: number,
	proc: ProcAccess = {},
	ownerToken?: string,
): { killed: boolean; reason: string } {
	const readCmdline = proc.readCmdline ?? defaultReadProcCmdline;
	const readEnviron = proc.readEnviron ?? defaultReadProcEnviron;
	const isAlive = proc.isAlive ?? defaultIsAlive;
	const kill =
		proc.kill ??
		((target, signal = "SIGKILL") => {
			process.kill(target, signal);
		});

	if (!isAlive(pid)) return { killed: false, reason: "not-alive" };
	const cmdline = readCmdline(pid);
	if (cmdline === undefined) return { killed: false, reason: "no-cmdline" };
	const environ = readEnviron(pid);
	if (!isPiSubagentCmdline(cmdline, environ)) {
		return { killed: false, reason: "not-pi-subagent" };
	}
	if (!ownerToken) return { killed: false, reason: "missing-owner-token" };
	if (!isPiSubagentCmdline(cmdline, environ, ownerToken)) {
		return { killed: false, reason: "owner-mismatch" };
	}
	try {
		const target = process.platform === "win32" ? pid : -pid;
		try {
			kill(target, "SIGKILL");
		} catch {
			kill(pid, "SIGKILL");
		}
		return { killed: true, reason: "killed" };
	} catch (error) {
		return { killed: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

function loadPersistedRuns(
	ctx: ExtensionContext,
	activeBranchOnly = false,
): Map<string, PersistedRun> {
	const runs = new Map<string, PersistedRun>();
	const entries = activeBranchOnly
		? ctx.sessionManager.getBranch()
		: ctx.sessionManager.getEntries();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PERSIST_TYPE) continue;
		const run = (entry.data as { run?: PersistedRun } | undefined)?.run;
		if (run?.runId) runs.set(run.runId, run);
	}
	return runs;
}

function terminalTranscriptKey(runId: string, taskId: string): string {
	return `${runId}\0${taskId}`;
}

function loadPersistedTerminalTranscripts(
	ctx: ExtensionContext,
): Map<string, PersistedTerminalTranscript> {
	const transcripts = new Map<string, PersistedTerminalTranscript>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== TERMINAL_TRANSCRIPT_TYPE) continue;
		const transcript = (entry.data as { transcript?: PersistedTerminalTranscript } | undefined)
			?.transcript;
		if (
			transcript?.version !== TERMINAL_TRANSCRIPT_VERSION ||
			typeof transcript.runId !== "string" ||
			!transcript.runId ||
			typeof transcript.taskId !== "string" ||
			!transcript.taskId ||
			!Array.isArray(transcript.messages)
		)
			continue;
		transcripts.set(terminalTranscriptKey(transcript.runId, transcript.taskId), transcript);
	}
	return transcripts;
}

export class SubagentRuntime {
	readonly supervisor: Supervisor;

	private readonly pi: ExtensionAPI;
	private readonly proc: ProcAccess;
	private readonly persistentStateRoot: string;
	private persistentStore: PersistentSessionStore | undefined;
	private readonly persistentLeases = new Map<string, PersistentInvocationLease>();
	private readonly persistentFinalizedTasks = new Set<string>();
	private readonly persistedTerminalTranscripts = new Set<string>();
	private readonly taskMeta = new Map<string, SubagentTaskMeta>();
	private readonly historical = new Map<string, SubagentDetails>();
	private persistentThreadHistory = new Map<string, PersistentThreadHistory>();
	private readonly lastViewedTaskByGroup = new Map<string, string>();
	private readonly approvedManualRetries = new Set<string>();
	private activityContext: ExtensionContext | undefined;
	private activityPanel: BottomPanel | undefined;
	private activitySection: BottomPanelSectionHandle | undefined;
	private activityGroupKey: string | undefined;
	private activityGroup: SubagentThreadGroup | undefined;
	private activityRunning = 0;
	private previousActivityRunning = 0;
	private activityCompletionUntil = 0;
	private activityCompletionTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly dashboardListeners = new Set<() => void>();

	constructor(options: SubagentRuntimeOptions) {
		this.pi = options.pi;
		this.proc = options.proc ?? {};
		this.persistentStateRoot = options.persistentStateRoot ?? getAgentDir();
		const createChild: ChildFactory =
			options.createChild ?? ((childOptions: RpcChildOptions) => new RpcChild(childOptions));
		const sendWakeMessage = (
			content: string,
			msgOptions?: { deliverAs?: "steer" | "followUp" },
		) => {
			// Finalization is diagnostic state, not a reason to suppress the parent wake.
			// A malformed or already-released persistent lease must leave the task result
			// visible while preserving a blocked session diagnostic.
			try {
				this.syncFromSupervisor();
			} catch (error) {
				this.recordPersistentSyncFailure(String(content), error);
			}
			this.pi.sendMessage(
				{
					customType: WAKE_MESSAGE_TYPE,
					content: `${INTERNAL_WAKE_GUIDANCE}\n\nEvent:\n${content}`,
					display: false,
				},
				{ ...msgOptions, triggerTurn: true },
			);
		};

		this.supervisor =
			options.createSupervisor?.({
				sendUserMessage: sendWakeMessage,
				createChild,
				cleanupTickMs: options.cleanupTickMs,
			}) ??
			new Supervisor({
				sendUserMessage: sendWakeMessage,
				createChild,
				cleanupTickMs: options.cleanupTickMs,
				onTerminalStateChange: () => this.syncFromSupervisor(),
			});

		this.supervisor.subscribe(() => {
			this.notifyDashboards();
			this.updateActivityWidget();
		});
	}

	private parentIsPersisted(ctx: ExtensionContext): boolean {
		const manager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
			isPersisted?: () => boolean;
		};
		return manager.isPersisted?.() === true;
	}

	private requirePersistentStore(ctx: ExtensionContext): PersistentSessionStore {
		if (!this.parentIsPersisted(ctx)) {
			throw new PersistentSessionError(
				"INVALID",
				"persistent subagents require a persisted parent session; save or resume the parent session first",
			);
		}
		const ownerParentSessionId = ctx.sessionManager.getSessionId();
		if (!ownerParentSessionId) {
			throw new PersistentSessionError(
				"INVALID",
				"persistent subagents require the parent session ID",
			);
		}
		const store = new PersistentSessionStoreImpl({
			stateRoot: this.persistentStateRoot,
			ownerParentSessionId,
			entries: ctx.sessionManager.getBranch(),
			processHooks: {
				isProcessAlive: (pid) => this.proc.isAlive?.(pid) ?? defaultIsAlive(pid),
				confirmCleanup: (owner) => {
					if (owner.childPid === undefined) return false;
					return !(this.proc.isAlive?.(owner.childPid) ?? defaultIsAlive(owner.childPid));
				},
			},
			appendSnapshot: (snapshot) => this.pi.appendEntry("subagent-session-state", snapshot),
		});
		this.persistentStore = store;
		return store;
	}

	/** Rebuild visibility exclusively from the current parent branch. */
	refreshPersistentState(ctx: ExtensionContext): PersistentSessionView[] {
		if (!this.parentIsPersisted(ctx)) {
			this.persistentStore = undefined;
			return [];
		}
		return this.requirePersistentStore(ctx).list();
	}

	listPersistentSessions(ctx: ExtensionContext): PersistentSessionView[] {
		return this.refreshPersistentState(ctx);
	}

	hasActiveBranchRuns(ctx: ExtensionContext): boolean {
		return loadPersistedRuns(ctx, true).size > 0 || this.supervisor.runs.size > 0;
	}

	assertPersistentParent(ctx: ExtensionContext): void {
		this.requirePersistentStore(ctx);
	}

	getPersistentSession(ctx: ExtensionContext, sessionId: string): PersistentSessionView {
		return this.requirePersistentStore(ctx).get(sessionId);
	}

	getPersistentSnapshot(ctx: ExtensionContext, sessionId: string): PersistentSessionSnapshot {
		return this.requirePersistentStore(ctx).getSnapshot(sessionId);
	}

	createPersistentSession(
		ctx: ExtensionContext,
		execution: PersistentExecutionContract,
	): PersistentSessionSnapshot {
		const store = this.requirePersistentStore(ctx);
		const sessionId = randomUUID();
		const child = store.prepareChildDirectory(sessionId);
		const now = Date.now();
		return store.append({
			type: "subagent-session-state",
			version: 1,
			ownerParentSessionId: store.ownerParentSessionId,
			sessionId,
			state: "idle",
			mode: "persistent",
			child,
			execution: structuredClone(execution),
			createdAt: now,
			updatedAt: now,
		});
	}

	beginPersistentInvocation(
		ctx: ExtensionContext,
		sessionId: string,
		ref: PersistentInvocationRef = {},
	): PersistentInvocationLease {
		const store = this.requirePersistentStore(ctx);
		const lock = store.acquireLock(sessionId, {
			parentPid: ref.parentPid ?? process.pid,
			ownerToken: ref.ownerToken,
		});
		try {
			const current = store.getSnapshot(sessionId);
			store.append({
				...current,
				state: "running",
				latestRunId: ref.runId,
				latestTaskId: ref.taskId,
				updatedAt: Date.now(),
			});
		} catch (error) {
			store.releaseLock(lock);
			throw error;
		}
		const lease: PersistentInvocationLease = {
			sessionId,
			lock,
			ownerToken: ref.ownerToken,
			store,
		};
		if (ref.taskId) this.persistentLeases.set(ref.taskId, lease);
		return lease;
	}

	/** Record child ownership immediately after supervisor spawn returns a PID. */
	associatePersistentTask(
		taskId: string,
		lease: PersistentInvocationLease,
		metadata: { runId?: string; childPid?: number; ownerToken?: string; parentPid?: number } = {},
	): void {
		// Bind the lease before filesystem updates so a partial association failure
		// can still be finalized only after the spawned child is reaped.
		this.persistentLeases.set(taskId, lease);
		const ownerToken = metadata.ownerToken ?? lease.ownerToken;
		const current = lease.store.getSnapshot(lease.sessionId);
		const owner = lease.store.readLockOwner(lease.sessionId);
		const childPidChanged =
			metadata.childPid !== undefined && owner?.childPid !== metadata.childPid;
		const ownerTokenChanged = ownerToken !== undefined && owner?.ownerToken !== ownerToken;
		if (
			childPidChanged ||
			ownerTokenChanged ||
			owner?.parentPid !== (metadata.parentPid ?? process.pid)
		) {
			lease.store.updateLockOwner(lease.lock, {
				parentPid: metadata.parentPid ?? process.pid,
				...(metadata.childPid !== undefined ? { childPid: metadata.childPid } : {}),
				...(ownerToken !== undefined ? { ownerToken } : {}),
			});
		}
		try {
			if (
				current.latestRunId !== (metadata.runId ?? current.latestRunId) ||
				current.latestTaskId !== taskId
			) {
				lease.store.append({
					...current,
					latestRunId: metadata.runId ?? current.latestRunId,
					latestTaskId: taskId,
					updatedAt: Date.now(),
				});
			}
		} catch (error) {
			// The child is now owned by this lease. Keep the session fail-closed and
			// surface the original association failure to the caller.
			try {
				const current = lease.store.getSnapshot(lease.sessionId);
				lease.store.append({
					...current,
					state: "blocked",
					error: `persistent invocation association failed: ${error instanceof Error ? error.message : String(error)}`,
					updatedAt: Date.now(),
				});
			} catch {
				/* Preserve the association error for the caller. */
			}
			throw error;
		}
		lease.ownerToken = ownerToken;
		this.persistentLeases.set(taskId, lease);
	}

	/** Return a session to idle only after process cleanup has been confirmed. */
	finishPersistentInvocation(
		lease: PersistentInvocationLease,
		cleanupConfirmed: boolean,
		error?: string,
	): PersistentSessionSnapshot {
		const current = lease.store.getSnapshot(lease.sessionId);
		if (!cleanupConfirmed) {
			const blocked = lease.store.append({
				...current,
				state: "blocked",
				error: error ?? "persistent child cleanup was not confirmed",
				updatedAt: Date.now(),
			});
			return blocked;
		}
		if (!lease.store.releaseLock(lease.lock)) {
			return lease.store.append({
				...current,
				state: "blocked",
				error: error ?? "persistent invocation lease could not be released safely",
				updatedAt: Date.now(),
			});
		}
		const idle = lease.store.append({
			...current,
			state: "idle",
			error,
			updatedAt: Date.now(),
		});
		for (const [taskId, candidate] of this.persistentLeases) {
			if (candidate === lease) this.persistentLeases.delete(taskId);
		}
		return idle;
	}

	closePersistentSession(ctx: ExtensionContext, sessionId: string): PersistentSessionSnapshot {
		return this.requirePersistentStore(ctx).close(sessionId);
	}

	private reconcilePersistentSessions(ctx: ExtensionContext): void {
		const store = this.requirePersistentStore(ctx);
		for (const view of store.list()) {
			if (view.state !== "running") continue;
			let snapshot: PersistentSessionSnapshot;
			try {
				snapshot = store.getSnapshot(view.sessionId);
				const owner = store.readLockOwner(view.sessionId);
				if (!owner || owner.childPid === undefined || !owner.ownerToken) {
					throw new Error("running persistent session has no verifiable child owner");
				}
				const sweep = sweepOrphanPid(owner.childPid, this.proc, owner.ownerToken);
				const alive = this.proc.isAlive?.(owner.childPid) ?? defaultIsAlive(owner.childPid);
				if (alive || (sweep.reason !== "not-alive" && !sweep.killed)) {
					throw new Error(`persistent orphan cleanup is unconfirmed (${sweep.reason})`);
				}
				if (
					!store.releaseLock({
						sessionId: view.sessionId,
						nonce: owner.nonce,
						path: store.pathsFor(view.sessionId).lockDir,
					})
				) {
					throw new Error("persistent orphan lease could not be released safely");
				}
				this.failInterruptedPersistentRun(ctx, snapshot);
				store.append({
					...snapshot,
					state: "idle",
					error: "Interrupted invocation was reaped during session restore",
					updatedAt: Date.now(),
				});
			} catch (error) {
				try {
					const current = store.getSnapshot(view.sessionId);
					store.append({
						...current,
						state: "blocked",
						error: error instanceof Error ? error.message : String(error),
						updatedAt: Date.now(),
					});
				} catch {
					/* Keep the original diagnostic if even reconstruction is unsafe. */
				}
			}
		}
	}

	private failInterruptedPersistentRun(
		ctx: ExtensionContext,
		snapshot: PersistentSessionSnapshot,
	): void {
		if (!snapshot.latestRunId || !snapshot.latestTaskId) return;
		const run = loadPersistedRuns(ctx, true).get(snapshot.latestRunId);
		const task = run?.tasks.find((candidate) => candidate.taskId === snapshot.latestTaskId);
		// Runs created before persistent mode was introduced remain ephemeral.
		if (!run || !task || task.mode !== "persistent" || task.sessionId !== snapshot.sessionId)
			return;
		task.status = "failed";
		task.reaped = true;
		task.error =
			task.error ?? "Interrupted persistent invocation was reaped during session restore";
		this.pi.appendEntry(PERSIST_TYPE, { run });
	}

	setTaskMeta(taskId: string, meta: SubagentTaskMeta): void {
		this.taskMeta.set(taskId, meta);
	}

	detailsFromRun(run: RunState): SubagentDetails {
		return {
			runId: run.runId,
			startedAt: run.startedAt,
			results: run.tasks.map((task) => this.viewFromTask(run, task)),
		};
	}

	parentSafeDetails(details: SubagentDetails): SubagentDetails {
		return {
			...details,
			results: details.results.map(
				({ messages: _messages, uiState: _uiState, ...result }) => result,
			),
		};
	}

	private persistTerminalTranscript(runId: string, task: TaskState): void {
		if (!isTerminalStatus(task.status) || task.mode === "persistent" || !task.messages) return;
		const key = terminalTranscriptKey(runId, task.taskId);
		if (this.persistedTerminalTranscripts.has(key)) return;
		const transcript: PersistedTerminalTranscript = {
			version: TERMINAL_TRANSCRIPT_VERSION,
			runId,
			taskId: task.taskId,
			messages: structuredClone(task.messages),
		};
		this.pi.appendEntry(TERMINAL_TRANSCRIPT_TYPE, { transcript });
		this.persistedTerminalTranscripts.add(key);
	}

	persistRun(run: RunState): void {
		const persisted: PersistedRun = {
			runId: run.runId,
			startedAt: run.startedAt,
			maxConcurrency: run.maxConcurrency,
			tasks: run.tasks.map((task) => {
				const meta = this.taskMeta.get(task.taskId);
				return {
					taskId: task.taskId,
					index: task.index,
					task: task.task,
					status: task.status,
					model: task.model,
					thinking: task.thinking,
					workspace: task.workspace,
					cwd: task.cwd,
					readOnly: task.readOnly,
					timeoutMs: task.timeoutMs,
					mode: task.mode,
					sessionId: task.sessionId,
					pid: childPid(task.child),
					error: task.error,
					manualKill: task.manualKill,
					timedOut: task.timedOut,
					output: task.output,
					usage: { ...task.usage },
					contextUsage: task.contextUsage,
					worktree: meta?.worktree,
					ownerToken: task.ownerToken,
					reaped: task.reaped,
					startedAt: task.startedAt,
					finishedAt: task.finishedAt,
				};
			}),
		};
		this.pi.appendEntry(PERSIST_TYPE, { run: persisted });
	}

	syncFromSupervisor(): void {
		for (const run of this.supervisor.runs.values()) {
			const details = this.detailsFromRun(run);
			this.emitUpdate(details);
			this.persistRun(run);
			for (const task of run.tasks) {
				this.persistTerminalTranscript(run.runId, task);
				if (task.mode === "persistent") {
					const lease = this.persistentLeases.get(task.taskId);
					if (
						lease &&
						childPid(task.child) !== undefined &&
						!this.persistentFinalizedTasks.has(task.taskId)
					) {
						try {
							this.associatePersistentTask(task.taskId, lease, {
								runId: run.runId,
								childPid: childPid(task.child),
								ownerToken: task.ownerToken,
							});
						} catch (error) {
							task.error = task.error ?? (error instanceof Error ? error.message : String(error));
						}
					}
					if (
						isTerminalStatus(task.status) &&
						!this.persistentFinalizedTasks.has(task.taskId) &&
						lease
					) {
						try {
							this.finishPersistentInvocation(lease, task.reaped, task.error);
							// Unconfirmed cleanup retains the lease and must be retried when the
							// supervisor later proves the process group is gone.
							if (task.reaped) this.persistentFinalizedTasks.add(task.taskId);
						} catch (error) {
							task.error = task.error ?? (error instanceof Error ? error.message : String(error));
							try {
								const current = lease.store.getSnapshot(lease.sessionId);
								lease.store.append({
									...current,
									state: "blocked",
									error: `persistent finalization failed: ${task.error}`,
									updatedAt: Date.now(),
								});
							} catch {
								/* Keep the task error and parent wake even if persistence is unavailable. */
							}
						}
					}
				}
				if (isTerminalStatus(task.status)) {
					const meta = this.taskMeta.get(task.taskId);
					if (meta?.promptDir) {
						void fs.promises.rm(meta.promptDir, { recursive: true, force: true });
						meta.promptDir = undefined;
					}
					if (task.mode !== "persistent" && !task.child && meta?.worktree) {
						const unusedWorktree = meta.worktree;
						meta.worktree = undefined;
						void rollbackWorktreeInternal(unusedWorktree).then(() => this.persistRun(run));
					}
				}
			}
		}
	}

	allDashboardRuns(): SubagentDetails[] {
		const merged = new Map<string, SubagentDetails>(this.historical);
		for (const run of this.supervisor.runs.values()) {
			merged.set(run.runId, this.detailsFromRun(run));
		}
		return [...merged.values()].map((run) => ({
			...run,
			results: run.results.map((result) => {
				if (result.mode !== "persistent" || !result.sessionId) return result;
				const history = this.persistentThreadHistory.get(result.sessionId);
				if (!history) return result;
				const messages = mergePersistentMessages(history.messages, result.messages);
				return {
					...result,
					messages,
					usage: cumulativePersistentUsage(messages, history.nonMessageUsage),
				};
			}),
		}));
	}

	statusWithHistory(ctx: ExtensionContext, runId?: string): RunSnapshot | RunSnapshot[] {
		if (runId && this.supervisor.runs.has(runId)) return this.supervisor.status(runId);
		const snapshots = new Map<string, RunSnapshot>();
		for (const run of loadPersistedRuns(ctx, true).values())
			snapshots.set(run.runId, this.snapshotFromPersisted(run));
		for (const run of this.supervisor.runs.values())
			snapshots.set(run.runId, this.supervisor.status(run.runId) as RunSnapshot);
		if (runId) {
			const snapshot = snapshots.get(runId);
			if (!snapshot) throw new Error(`unknown run ${runId}`);
			return snapshot;
		}
		return [...snapshots.values()];
	}

	resultWithHistory(ctx: ExtensionContext, runId: string, taskId: string): TaskResult {
		if (this.supervisor.runs.has(runId)) return this.supervisor.result(runId, taskId);
		const task = loadPersistedRuns(ctx, true)
			.get(runId)
			?.tasks.find((candidate) => candidate.taskId === taskId);
		if (!task) throw new Error(`unknown task ${taskId} in run ${runId}`);
		return {
			output: task.output ?? "",
			usage: task.usage ?? emptyUsage(),
			mode: task.mode,
			sessionId: task.sessionId,
			error: task.error,
			manualKill: task.manualKill,
		};
	}

	resolveHandoffs(refs: ResultRef[] | undefined, ctx: ExtensionContext): Handoff[] {
		if (!refs?.length) return [];
		const activeRuns = new Map<string, SubagentDetails>();
		for (const run of loadPersistedRuns(ctx, true).values()) {
			activeRuns.set(run.runId, {
				runId: run.runId,
				startedAt: run.startedAt,
				results: run.tasks.map((task) => ({
					index: task.index,
					taskId: task.taskId,
					task: task.task,
					model: task.model,
					thinking: task.thinking,
					workspace: task.workspace,
					cwd: task.cwd,
					mode: task.mode,
					sessionId: task.sessionId,
					done: isTerminalStatus(task.status),
					error: task.error,
					output: task.output ?? "",
					usage: task.usage ?? emptyUsage(),
					status: task.status,
				})),
			});
		}
		for (const run of this.supervisor.runs.values())
			activeRuns.set(run.runId, this.detailsFromRun(run));
		return refs.map((ref) => {
			const result = activeRuns.get(ref.runId)?.results.find((item) => item.taskId === ref.taskId);
			if (!result)
				throw new Error(`Unknown prerequisite subagent task ${ref.taskId} in run ${ref.runId}`);
			if (!result.done) throw new Error(`Prerequisite subagent task ${ref.taskId} is not complete`);
			if (result.error)
				throw new Error(`Prerequisite subagent task ${ref.taskId} failed: ${result.error}`);
			return { source: `${ref.runId}/${ref.taskId}`, output: result.output };
		});
	}

	getBlockedManualRetryKeys(specs: ReadonlyArray<{ task: string }>): string[] {
		const killedKeys = new Set(
			this.allDashboardRuns().flatMap((run) =>
				run.results
					.filter((result) => result.manualKill)
					.map((result) => manualRetryKey(result.task)),
			),
		);
		return specs
			.map((spec) => manualRetryKey(spec.task))
			.filter((key) => killedKeys.has(key) && !this.approvedManualRetries.has(key));
	}

	approveManualRetries(keys: readonly string[]): void {
		for (const key of keys) this.approvedManualRetries.add(key);
	}

	subscribeDashboard(listener: () => void): () => void {
		this.dashboardListeners.add(listener);
		return () => this.dashboardListeners.delete(listener);
	}

	setActivityContext(ctx: ExtensionContext | undefined): void {
		const nextPanel = ctx?.mode === "tui" ? getBottomPanel(ctx) : undefined;
		if (nextPanel !== this.activityPanel) {
			this.activitySection?.remove();
			this.activitySection = undefined;
			this.activityPanel = nextPanel;
		}
		this.activityContext = ctx;
		if (this.activityGroup) this.updateActivitySection();
	}

	clearActivityWidget(): void {
		this.clearActivityCompletionTimer();
		this.activitySection?.remove();
		this.activitySection = undefined;
		this.activityPanel = undefined;
		this.activityContext = undefined;
		this.activityGroup = undefined;
		this.activityGroupKey = undefined;
		this.activityRunning = 0;
		this.previousActivityRunning = 0;
		this.activityCompletionUntil = 0;
	}

	private async hydratePersistentThreadHistory(ctx: ExtensionContext): Promise<void> {
		if (!this.parentIsPersisted(ctx)) {
			this.persistentThreadHistory.clear();
			return;
		}
		const store = this.requirePersistentStore(ctx);
		const loaded = await Promise.all(
			store.list().map(async ({ sessionId }) => {
				try {
					const snapshot = store.getSnapshot(sessionId);
					const history = await loadPersistentThreadHistory(snapshot.child);
					return history ? ([sessionId, history] as const) : undefined;
				} catch {
					// The live invocation projection remains usable if durable history is unavailable.
					return undefined;
				}
			}),
		);
		this.persistentThreadHistory = new Map(
			loaded.filter(
				(entry): entry is readonly [string, PersistentThreadHistory] => entry !== undefined,
			),
		);
	}

	openThreadView = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Subagent threads require interactive mode.", "warning");
			return;
		}
		this.hydrateHistorical(ctx);
		await this.hydratePersistentThreadHistory(ctx);
		const groups = buildThreadGroups(this.allDashboardRuns());
		if (groups.length === 0) {
			ctx.ui.notify("No subagents in this session.", "info");
			return;
		}
		const newestRunning = [...groups]
			.reverse()
			.find((group) => group.items.some((item) => !item.result.done));
		const preferredGroup = newestRunning ?? groups.at(-1)!;
		let initialTaskId = this.lastViewedTaskByGroup.get(preferredGroup.key);
		if (
			!initialTaskId ||
			!preferredGroup.items.some((item) => item.result.taskId === initialTaskId)
		) {
			initialTaskId =
				preferredGroup.items.find((item) => !item.result.done)?.result.taskId ??
				preferredGroup.items[0].result.taskId;
			this.lastViewedTaskByGroup.set(preferredGroup.key, initialTaskId);
		}
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) =>
				new SubagentThreadView(
					tui,
					theme,
					() => this.allDashboardRuns(),
					(listener) => this.subscribeDashboard(listener),
					done,
					initialTaskId,
					(taskId, groupKey) => {
						this.lastViewedTaskByGroup.set(groupKey, taskId);
					},
					preferredGroup.key,
					undefined,
					(runId, taskId) => {
						this.killTaskManually(runId, taskId);
					},
					() => {
						killSubagentRuns(undefined, true);
					},
				),
			fullscreenOverlayOptions(),
		);
	};

	killParentChildren(defer = false): void {
		// Escape already expresses the user's intent to stop. Child cleanup must
		// not wake the parent into a replacement turn after the abort settles.
		const hasDefaultKillAll = this.supervisor.killAll === Supervisor.prototype.killAll;
		if (defer && hasDefaultKillAll && this.supervisor.deferKillAll) {
			this.supervisor.deferKillAll({ notifyParent: false });
		} else {
			this.supervisor.killAll({ notifyParent: false });
		}
		if (!defer) this.syncFromSupervisor();
	}

	cancelParentAbort(): void {
		this.supervisor.cancelDeferredKill?.();
	}

	recordManualKill(runId: string, taskId: string): void {
		const task = this.supervisor.runs.get(runId)?.tasks.find((item) => item.taskId === taskId);
		if (!task) return;
		this.approvedManualRetries.delete(manualRetryKey(task.task));
	}

	killTaskManually(runId: string, taskId: string): void {
		this.recordManualKill(runId, taskId);
		this.supervisor.killTask(runId, taskId, true);
		this.syncFromSupervisor();
	}

	hydrateHistorical(ctx: ExtensionContext): void {
		const transcripts = loadPersistedTerminalTranscripts(ctx);
		for (const key of transcripts.keys()) this.persistedTerminalTranscripts.add(key);
		for (const run of loadPersistedRuns(ctx).values()) {
			if (this.historical.has(run.runId) || this.supervisor.runs.has(run.runId)) continue;
			this.historical.set(run.runId, this.historicalDetails(run, transcripts));
		}
	}

	restoreSession(ctx: ExtensionContext): boolean {
		this.clearActivityWidget();
		this.setActivityContext(ctx.mode === "tui" ? ctx : undefined);
		const persisted = loadPersistedRuns(ctx);
		const transcripts = loadPersistedTerminalTranscripts(ctx);
		for (const key of transcripts.keys()) this.persistedTerminalTranscripts.add(key);
		for (const run of persisted.values()) {
			let changed = false;
			for (const task of run.tasks) {
				if (
					typeof task.pid === "number" &&
					(!isTerminalStatus(task.status) || task.reaped === false)
				) {
					const sweep = sweepOrphanPid(task.pid, this.proc, task.ownerToken);
					let cleanupConfirmed = sweep.reason === "not-alive";
					if (sweep.killed) {
						try {
							cleanupConfirmed = !(this.proc.isAlive?.(task.pid) ?? defaultIsAlive(task.pid));
						} catch {
							cleanupConfirmed = false;
						}
					}
					task.reaped = cleanupConfirmed;
					if (!task.reaped)
						task.error = `${task.error ? `${task.error}; ` : ""}orphan cleanup pending (${sweep.reason})`;
					changed = true;
				}
				if (isTerminalStatus(task.status)) continue;
				task.status = "failed";
				task.error = task.error ?? "Interrupted by session reload or process exit";
				changed = true;
			}
			if (changed) this.pi.appendEntry(PERSIST_TYPE, { run });
			this.historical.set(run.runId, this.historicalDetails(run, transcripts));
		}
		if (this.parentIsPersisted(ctx)) this.reconcilePersistentSessions(ctx);
		this.updateActivityWidget();
		return persisted.size > 0 || (this.persistentStore?.list().length ?? 0) !== 0;
	}

	private viewFromTask(_run: RunState, task: TaskState): SubagentResultView {
		const meta = this.taskMeta.get(task.taskId);
		const messages = task.child?.transcript?.() ?? task.messages;
		const uiState = task.child?.uiSnapshot?.() ?? task.uiState;
		return {
			index: task.index,
			taskId: task.taskId,
			task: task.task,
			mode: task.mode,
			sessionId: task.sessionId,
			model: task.model,
			thinking: task.thinking,
			workspace: task.workspace,
			cwd: task.cwd,
			readOnly: task.readOnly,
			timeoutMs: task.timeoutMs,
			worktree: meta?.worktree,
			done: isTerminalStatus(task.status),
			error: task.error,
			manualKill: task.manualKill,
			timedOut: task.timedOut,
			output: task.output,
			usage: { ...task.usage },
			status: task.status,
			messages: messages ? [...messages] : undefined,
			uiState,
			pid: childPid(task.child),
			contextUsage: task.contextUsage,
		};
	}

	emitUpdate(details: SubagentDetails): void {
		this.historical.set(details.runId, details);
		this.notifyDashboards();
		this.updateActivityWidget();
		this.pi.events.emit("subagent:update", details);
	}

	private snapshotFromPersisted(run: PersistedRun): RunSnapshot {
		return {
			runId: run.runId,
			startedAt: run.startedAt,
			maxConcurrency: run.maxConcurrency ?? Math.max(1, run.tasks.length),
			tasks: run.tasks.map((task) => ({
				taskId: task.taskId,
				index: task.index,
				status: task.status,
				model: task.model,
				thinking: task.thinking,
				workspace: task.workspace,
				cwd: task.cwd,
				readOnly: task.readOnly ?? false,
				timeoutMs: task.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS,
				mode: task.mode,
				sessionId: task.sessionId,
				error: task.error,
				manualKill: task.manualKill,
				timedOut: task.timedOut,
				reaped: task.reaped ?? isTerminalStatus(task.status),
				lastEventAt: task.finishedAt ?? task.startedAt ?? run.startedAt,
				startedAt: task.startedAt ?? run.startedAt,
				finishedAt: isTerminalStatus(task.status) ? run.startedAt : undefined,
			})),
		};
	}

	private historicalDetails(
		run: PersistedRun,
		transcripts: ReadonlyMap<string, PersistedTerminalTranscript> = new Map(),
	): SubagentDetails {
		return {
			runId: run.runId,
			startedAt: run.startedAt,
			results: run.tasks.map((task) => ({
				index: task.index,
				taskId: task.taskId,
				task: task.task,
				model: task.model,
				thinking: task.thinking,
				workspace: task.workspace,
				cwd: task.cwd,
				readOnly: task.readOnly ?? false,
				timeoutMs: task.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS,
				mode: task.mode,
				sessionId: task.sessionId,
				worktree: task.worktree,
				done: isTerminalStatus(task.status),
				error: task.error,
				manualKill: task.manualKill,
				timedOut: task.timedOut,
				output: task.output ?? "",
				usage: task.usage ?? emptyUsage(),
				status: task.status,
				pid: task.pid,
				contextUsage: task.contextUsage,
				messages: transcripts.get(terminalTranscriptKey(run.runId, task.taskId))?.messages,
			})),
		};
	}

	private recordPersistentSyncFailure(content: string, error: unknown): void {
		for (const task of [...this.supervisor.runs.values()].flatMap((run: RunState) => run.tasks)) {
			if (task.mode !== "persistent" || !task.sessionId) continue;
			const lease = this.persistentLeases.get(task.taskId);
			if (!lease) continue;
			const message = `persistent synchronization failed: ${error instanceof Error ? error.message : String(error)}`;
			task.error = task.error ?? message;
			try {
				const current = lease.store.getSnapshot(task.sessionId);
				lease.store.append({ ...current, state: "blocked", error: message, updatedAt: Date.now() });
			} catch {
				/* The wake remains the durable parent-visible signal. */
			}
		}
		void content;
	}

	private notifyDashboards(): void {
		for (const listener of this.dashboardListeners) listener();
	}

	private clearActivityCompletionTimer(): void {
		if (!this.activityCompletionTimer) return;
		clearTimeout(this.activityCompletionTimer);
		this.activityCompletionTimer = undefined;
	}

	private removeActivitySection(): void {
		this.activitySection?.remove();
		this.activitySection = undefined;
		this.activityGroup = undefined;
		this.activityRunning = 0;
	}

	private renderActivityLine(_width: number, theme: Theme): string[] {
		const group = this.activityGroup;
		if (!group) return [];
		const completed = group.items.filter((item) => item.result.done && !item.result.error).length;
		const failed = group.items.filter((item) => item.result.done && item.result.error).length;
		const done = this.activityRunning === 0;
		const label = "Subagents";
		const frame =
			ACTIVITY_FRAMES[Math.floor(Date.now() / ACTIVITY_FRAME_INTERVAL_MS) % ACTIVITY_FRAMES.length];
		const spinner = done
			? theme.fg(failed > 0 ? "warning" : "success", "✓")
			: theme.fg("accent", frame);
		const title = theme.bold(theme.fg(done ? "muted" : "accent", label));
		const counts = [
			this.activityRunning > 0 ? theme.fg("warning", `${this.activityRunning} active`) : undefined,
			completed > 0 ? theme.fg("success", `${completed} done`) : undefined,
			failed > 0 ? theme.fg("error", `${failed} failed`) : undefined,
		].filter((part): part is string => Boolean(part));
		const separator = theme.fg("dim", " · ");
		const hint = theme.fg("dim", "F6") + theme.fg("muted", " view");
		return [` ${spinner}  ${title}   ${counts.join(separator)}   ${hint}`];
	}

	private updateActivitySection(): void {
		const panel = this.activityPanel;
		if (!panel || !this.activityGroup) return;
		if (!this.activitySection) {
			this.activitySection = panel.registerSection(ACTIVITY_SECTION, {
				order: BOTTOM_PANEL_SECTION_ORDER.subagents,
				maxLines: 1,
				refreshIntervalMs: this.activityRunning > 0 ? ACTIVITY_FRAME_INTERVAL_MS : undefined,
				render: (width, theme) => this.renderActivityLine(width, theme),
			});
			return;
		}
		this.activitySection.update({
			refreshIntervalMs: this.activityRunning > 0 ? ACTIVITY_FRAME_INTERVAL_MS : null,
		});
	}

	private renderActivityWidget(group: SubagentThreadGroup, running: number): void {
		this.activityGroup = group;
		this.activityRunning = running;
		this.updateActivitySection();
	}

	private updateActivityWidget(): void {
		const ctx = this.activityContext;
		if (!ctx || ctx.mode !== "tui" || !this.activityPanel) return;
		const groups = buildThreadGroups(this.allDashboardRuns());
		const newestRunning = [...groups]
			.reverse()
			.find((group) => group.items.some((item) => !item.result.done));
		const remembered = groups.find((group) => group.key === this.activityGroupKey);
		const group = newestRunning ?? remembered;
		const running = group?.items.filter((item) => !item.result.done).length ?? 0;

		if (group && running > 0) {
			this.activityGroupKey = group.key;
			this.activityCompletionUntil = 0;
			this.clearActivityCompletionTimer();
			this.renderActivityWidget(group, running);
			this.previousActivityRunning = running;
			return;
		}

		if (group && this.previousActivityRunning > 0) {
			this.activityCompletionUntil = Date.now() + ACTIVITY_COMPLETION_MS;
			this.clearActivityCompletionTimer();
			this.activityCompletionTimer = setTimeout(() => {
				this.activityCompletionTimer = undefined;
				this.activityCompletionUntil = 0;
				this.previousActivityRunning = 0;
				this.removeActivitySection();
			}, ACTIVITY_COMPLETION_MS);
			this.activityCompletionTimer.unref?.();
		}
		this.previousActivityRunning = 0;
		if (group && this.activityCompletionUntil > Date.now()) this.renderActivityWidget(group, 0);
		else this.removeActivitySection();
	}
}

export { isPiSubagentCmdline, defaultReadProcCmdline, defaultReadProcEnviron, defaultIsAlive };

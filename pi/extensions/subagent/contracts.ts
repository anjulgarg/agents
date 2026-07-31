import type { Message } from "@earendil-works/pi-ai";
import type { ChildUiSnapshot } from "./rpc-client.ts";
import type { TaskStatus } from "./supervisor.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const WORKSPACE_MODES = ["shared", "worktree"] as const;

export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

/** Explicit child execution mode. Omitted mode remains ephemeral for compatibility. */
export const SUBAGENT_MODES = ["ephemeral", "persistent"] as const;

export type SubagentMode = (typeof SUBAGENT_MODES)[number];

export const PERSISTENT_SESSION_STATES = ["idle", "running", "blocked", "closed"] as const;

export type PersistentSessionState = (typeof PERSISTENT_SESSION_STATES)[number];

/** Exact native Pi session identity used by a persistent child invocation. */
export interface PersistentChildSession {
	sessionId: string;
	sessionDir: string;
}

/** Descriptive alias used by callers that treat the child identity as a contract. */
export type PersistentSessionDescriptor = PersistentChildSession;
export type PersistentLifecycleState = PersistentSessionState;

/** Immutable execution inputs retained for a persistent conversation. */
export interface PersistentExecutionContract {
	model: string;
	thinking: ThinkingLevel;
	tools: string[];
	workspace: WorkspaceMode;
	cwd: string;
	projectTrusted: boolean;
	/** Exact generated prompt body, intentionally omitted from safe views. */
	systemPrompt: string;
	worktree?: WorktreeInfo;
}

/** Bounded parent-safe projection of a persistent child session. */
export interface PersistentSessionView {
	sessionId: string;
	ownerParentSessionId: string;
	state: PersistentSessionState;
	mode: "persistent";
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	workspace?: WorkspaceMode;
	cwd?: string;
	worktree?: WorktreeInfo;
	latestRunId?: string;
	latestTaskId?: string;
	createdAt: number;
	updatedAt: number;
	error?: string;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

/**
 * Bounded snapshot of a child's current context-window occupancy from Pi RPC
 * `get_session_stats`. Kept separate from cumulative billed UsageStats. `tokens`
 * and `percent` are null when occupancy is unknown (e.g. right after compaction).
 * Never carries sessionFile or the complete SessionStats response.
 */
export interface ContextUsageSnapshot {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface ResultRef {
	runId: string;
	taskId: string;
}

export interface Handoff {
	source: string;
	output: string;
}

/** Stable cross-extension subset of the subagent:update event payload. */
export interface SubagentUpdateResult {
	taskId?: string;
	mode?: SubagentMode;
	sessionId?: string;
	teamRunId?: string;
	teamTaskId?: string;
	role?: string;
	done: boolean;
	error?: string;
	manualKill?: boolean;
	output?: string;
	usage?: UsageStats;
}

export interface SubagentUpdate {
	runId: string;
	startedAt: number;
	results: SubagentUpdateResult[];
}

export interface WorktreeInfo {
	path: string;
	branch: string;
	repository: string;
}

export interface SubagentResultView {
	index: number;
	taskId: string;
	task: string;
	/** Absent in legacy records; omitted mode is the ephemeral default. */
	mode?: SubagentMode;
	sessionId?: string;
	teamRunId?: string;
	teamTaskId?: string;
	role?: string;
	model: string;
	thinking: ThinkingLevel;
	workspace: WorkspaceMode;
	cwd: string;
	worktree?: WorktreeInfo;
	done: boolean;
	error?: string;
	manualKill?: boolean;
	output: string;
	usage: UsageStats;
	status: TaskStatus;
	messages?: Message[];
	uiState?: ChildUiSnapshot;
	pid?: number;
	/** Latest validated context occupancy; absent in legacy records. */
	contextUsage?: ContextUsageSnapshot;
}

export interface SubagentDetails {
	runId: string;
	startedAt: number;
	results: SubagentResultView[];
}

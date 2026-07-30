import type { Message } from "@earendil-works/pi-ai";
import type { ChildUiSnapshot } from "./rpc-client.ts";
import type { TaskStatus } from "./supervisor.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const WORKSPACE_MODES = ["shared", "worktree"] as const;

export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
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
}

export interface SubagentDetails {
	runId: string;
	startedAt: number;
	results: SubagentResultView[];
}

import type { ThinkingLevel, UsageStats, WorkspaceMode } from "../subagent/contracts.ts";

export {
	THINKING_LEVELS,
	WORKSPACE_MODES,
	type ThinkingLevel,
	type UsageStats,
	type WorkspaceMode,
} from "../subagent/contracts.ts";
export type { SubagentUpdate } from "../subagent/contracts.ts";

export const MODEL_POLICIES = ["fixed", "manager", "ask"] as const;
export type ModelPolicy = (typeof MODEL_POLICIES)[number];

export type TeamRunStatus =
	"planning" | "awaiting_approval" | "executing" | "completed" | "failed" | "cancelled";
export type TeamTaskStatus = "pending" | "blocked" | "running" | "completed" | "failed";

/** Soft cap so one role cannot blow a child context window. */
export const MAX_ROLE_INSTRUCTIONS_CHARS = 4_000;

export interface TeamAgentConfig {
	description: string;
	/** Child system-prompt persona. Manager routing still uses description only. */
	instructions?: string;
	modelPolicy?: ModelPolicy;
	model?: string;
	allowedModels?: string[];
	thinking?: ThinkingLevel;
	workspace?: WorkspaceMode;
	maxInstances?: number;
	review?: boolean;
	verification?: boolean;
	tools?: string[];
}

export interface TeamDefinition {
	name: string;
	description: string;
	manager: {
		model: string;
		thinking: ThinkingLevel;
		instructions: string;
	};
	defaults?: {
		model?: string;
		thinking?: ThinkingLevel;
		workspace?: WorkspaceMode;
	};
	roles: Record<string, TeamAgentConfig>;
	limits?: {
		maxConcurrency?: number;
		requirePlanApproval?: boolean;
	};
}

export interface TeamTask {
	id: string;
	title: string;
	description: string;
	role: string;
	dependsOn: string[];
	model: string;
	thinking: ThinkingLevel;
	workspace: WorkspaceMode;
	tools?: string[];
	status: TeamTaskStatus;
	subagentRunId?: string;
	subagentTaskId?: string;
	startedAt?: number;
	finishedAt?: number;
	output?: string;
	error?: string;
	manualKill?: boolean;
	usage?: UsageStats;
}

export interface TeamRun {
	id: string;
	teamName: string;
	goal: string;
	status: TeamRunStatus;
	startedAt: number;
	updatedAt: number;
	tasks: TeamTask[];
	planSummary?: string;
	completionSummary?: string;
	originalModel?: string;
	originalThinking?: ThinkingLevel;
}

export interface TeamStateDetails {
	run: TeamRun;
	approved?: boolean;
	feedback?: string;
}

import type {
	TeamAgentConfig,
	TeamDefinition,
	TeamRun,
	TeamRunStatus,
	TeamTask,
	TeamTaskStatus,
	ThinkingLevel,
	UsageStats,
	WorkspaceMode,
} from "./contracts.ts";

export interface TeamRoleSummary {
	name: string;
	config: TeamAgentConfig;
	modelPolicy: NonNullable<TeamAgentConfig["modelPolicy"]>;
	modelFallback?: string;
	thinking: ThinkingLevel;
	workspace: WorkspaceMode;
	maxInstances: number;
	activeInstances: number;
	completedInstances: number;
	failedInstances: number;
	plannedInstances: number;
	totalInstances: number;
}

export interface TeamRoleInstance {
	runId: string;
	runStatus: TeamRunStatus;
	goal: string;
	taskId: string;
	title: string;
	description: string;
	status: TeamTaskStatus;
	model: string;
	thinking: ThinkingLevel;
	workspace: WorkspaceMode;
	subagentRunId?: string;
	subagentTaskId?: string;
	startedAt?: number;
	finishedAt?: number;
	output?: string;
	error?: string;
	usage?: UsageStats;
}

function teamTasks(teamName: string, runs: readonly TeamRun[]): TeamTask[] {
	return runs.filter((run) => run.teamName === teamName).flatMap((run) => run.tasks);
}

function activeTask(task: TeamTask): boolean {
	return task.status === "running";
}

export function buildTeamRoleSummaries(
	team: TeamDefinition,
	runs: readonly TeamRun[],
): TeamRoleSummary[] {
	const tasks = teamTasks(team.name, runs);
	return Object.entries(team.roles).map(([name, config]) => {
		const instances = tasks.filter((task) => task.role === name);
		return {
			name,
			config,
			modelPolicy: config.modelPolicy ?? "manager",
			modelFallback: config.model ?? team.defaults?.model,
			thinking: config.thinking ?? team.defaults?.thinking ?? "medium",
			workspace: config.workspace ?? team.defaults?.workspace ?? "shared",
			maxInstances: config.maxInstances ?? 1,
			activeInstances: instances.filter(activeTask).length,
			completedInstances: instances.filter((task) => task.status === "completed").length,
			failedInstances: instances.filter((task) => task.status === "failed").length,
			plannedInstances: instances.filter(
				(task) => task.status === "pending" || task.status === "blocked",
			).length,
			totalInstances: instances.length,
		};
	});
}

export function buildTeamRoleInstances(
	teamName: string,
	roleName: string,
	runs: readonly TeamRun[],
): TeamRoleInstance[] {
	return runs
		.filter((run) => run.teamName === teamName)
		.sort((left, right) => right.startedAt - left.startedAt)
		.flatMap((run) =>
			run.tasks
				.filter((task) => task.role === roleName)
				.map((task) => ({
					runId: run.id,
					runStatus: run.status,
					goal: run.goal,
					taskId: task.id,
					title: task.title,
					description: task.description,
					status: task.status,
					model: task.model,
					thinking: task.thinking,
					workspace: task.workspace,
					subagentRunId: task.subagentRunId,
					subagentTaskId: task.subagentTaskId,
					startedAt: task.startedAt,
					finishedAt: task.finishedAt,
					output: task.output,
					error: task.error,
					usage: task.usage,
				})),
		);
}

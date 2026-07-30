import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { killSubagentRuns } from "../subagent/control.ts";
import { loadTeams } from "./config.ts";
import { TeamRuntime, type TeamExtensionOptions } from "./runtime.ts";
import { registerTeamLifecycle } from "./lifecycle.ts";
import { registerTeamTools } from "./tools.ts";

export {
	MAX_ROLE_INSTRUCTIONS_CHARS,
	MODEL_POLICIES,
	THINKING_LEVELS,
	WORKSPACE_MODES,
	type SubagentUpdate,
	type TeamAgentConfig,
	type TeamDefinition,
	type TeamRun,
	type TeamRunStatus,
	type TeamStateDetails,
	type TeamTask,
	type TeamTaskStatus,
	type ThinkingLevel,
	type ModelPolicy,
	type WorkspaceMode,
} from "./contracts.ts";
export { loadTeams, validateTaskGraph, validateTeamDefinition } from "./config.ts";
export {
	TeamDashboard,
	TeamPlanReview,
	TeamRoleInspector,
	TeamRunDashboard,
	formatTeamPlanMarkdown,
} from "./ui.ts";
export {
	buildTeamRoleInstances,
	buildTeamRoleSummaries,
	type TeamRoleInstance,
	type TeamRoleSummary,
} from "./role-model.ts";
export { TeamRuntime } from "./runtime.ts";
export type { TeamExtensionOptions } from "./runtime.ts";

export function registerTeamExtension(pi: ExtensionAPI, options: TeamExtensionOptions = {}): void {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	let teams: NonNullable<TeamExtensionOptions["teams"]>;
	if (options.teams) {
		teams = options.teams;
	} else {
		try {
			teams = loadTeams();
		} catch (error) {
			console.error(
				`Failed to load teams: ${error instanceof Error ? error.message : String(error)}`,
			);
			teams = new Map();
		}
	}
	const killRuns = options.killSubagentRuns ?? killSubagentRuns;
	const runtime = new TeamRuntime({ pi, teams, killSubagentRuns: killRuns });

	registerTeamTools(pi, runtime);
	registerTeamLifecycle(pi, runtime);
}

export default function teamExtension(pi: ExtensionAPI) {
	registerTeamExtension(pi);
}

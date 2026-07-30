import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
	MAX_ROLE_INSTRUCTIONS_CHARS,
	MODEL_POLICIES,
	THINKING_LEVELS,
	WORKSPACE_MODES,
	type ModelPolicy,
	type TeamDefinition,
	type ThinkingLevel,
	type WorkspaceMode,
} from "./contracts.ts";

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function isWorkspaceMode(value: unknown): value is WorkspaceMode {
	return typeof value === "string" && WORKSPACE_MODES.includes(value as WorkspaceMode);
}

export function validateTeamDefinition(raw: unknown, source: string): TeamDefinition {
	if (!raw || typeof raw !== "object")
		throw new Error(`Team configuration must be an object: ${source}`);
	const team = raw as Partial<TeamDefinition>;
	if (!team.name || !/^[a-z0-9][a-z0-9-]*$/.test(team.name))
		throw new Error(`Invalid team name in ${source}`);
	if (!team.description || !team.manager || !team.roles || Object.keys(team.roles).length === 0) {
		throw new Error(`Team ${team.name} requires description, manager, and roles`);
	}
	if (
		!team.manager.model ||
		!isThinkingLevel(team.manager.thinking) ||
		!team.manager.instructions
	) {
		throw new Error(`Team ${team.name} has an invalid manager configuration`);
	}
	for (const [name, role] of Object.entries(team.roles)) {
		if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !role.description) {
			throw new Error(`Team ${team.name} has invalid role ${name}`);
		}
		if (role.instructions !== undefined) {
			if (typeof role.instructions !== "string") {
				throw new Error(`Team ${team.name} role ${name} has invalid instructions`);
			}
			const instructions = role.instructions.trim();
			if (!instructions) {
				throw new Error(`Team ${team.name} role ${name} has empty instructions`);
			}
			if (instructions.length > MAX_ROLE_INSTRUCTIONS_CHARS) {
				throw new Error(
					`Team ${team.name} role ${name} instructions exceed ${MAX_ROLE_INSTRUCTIONS_CHARS} characters`,
				);
			}
			role.instructions = instructions;
		}
		if (role.modelPolicy && !MODEL_POLICIES.includes(role.modelPolicy as ModelPolicy)) {
			throw new Error(`Team ${team.name} role ${name} has invalid modelPolicy`);
		}
		if (role.thinking && !isThinkingLevel(role.thinking))
			throw new Error(`Invalid thinking level for ${name}`);
		if (role.workspace && !isWorkspaceMode(role.workspace))
			throw new Error(`Invalid workspace for ${name}`);
		if (
			role.maxInstances !== undefined &&
			(!Number.isInteger(role.maxInstances) || role.maxInstances < 1 || role.maxInstances > 8)
		) {
			throw new Error(`Team ${team.name} role ${name} has invalid maxInstances`);
		}
	}
	return team as TeamDefinition;
}

export function loadTeams(): Map<string, TeamDefinition> {
	const directory = join(getAgentDir(), "teams");
	const teams = new Map<string, TeamDefinition>();
	if (!existsSync(directory)) return teams;
	for (const filename of readdirSync(directory)
		.filter((name: string) => name.endsWith(".json"))
		.sort()) {
		const source = join(directory, filename);
		const team = validateTeamDefinition(JSON.parse(readFileSync(source, "utf8")), source);
		if (teams.has(team.name)) throw new Error(`Duplicate team name: ${team.name}`);
		teams.set(team.name, team);
	}
	return teams;
}

export function validateTaskGraph(tasks: Array<{ id: string; dependsOn?: string[] }>): void {
	const ids = new Set<string>();
	for (const task of tasks) {
		if (!/^[a-z0-9][a-z0-9-]*$/.test(task.id)) throw new Error(`Invalid task ID: ${task.id}`);
		if (ids.has(task.id)) throw new Error(`Duplicate task ID: ${task.id}`);
		ids.add(task.id);
	}
	for (const task of tasks) {
		for (const dependency of task.dependsOn ?? []) {
			if (!ids.has(dependency))
				throw new Error(`Task ${task.id} depends on unknown task ${dependency}`);
			if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself`);
		}
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const visit = (id: string) => {
		if (visiting.has(id)) throw new Error(`Task dependency cycle includes ${id}`);
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const task of tasks) visit(task.id);
}

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	type Component,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";

import {
	createTuiStyles,
	getContentWidth,
	renderFooter,
	renderFullscreenScreen,
	renderHeader,
	renderSplitPane,
	SelectableViewportController,
	ScrollViewportController,
} from "../lib/tui/index.ts";
import { formatUsage } from "../subagent/ui.ts";
import type { TeamDefinition, TeamRun, TeamTaskStatus } from "./contracts.ts";
import { teamTaskCounts, teamTaskStatusColor, teamTaskStatusIcon } from "./display.ts";
import {
	buildTeamRoleInstances,
	buildTeamRoleSummaries,
	type TeamRoleInstance,
	type TeamRoleSummary,
} from "./role-model.ts";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
type RoleFocus = "teams" | "roles";

function statusLabel(status: TeamTaskStatus): string {
	return status === "running" ? "active" : status;
}

function latestTeamRun(teamName: string, runs: readonly TeamRun[]): TeamRun | undefined {
	return runs
		.filter((run) => run.teamName === teamName)
		.sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function activeTeamRun(teamName: string, runs: readonly TeamRun[]): TeamRun | undefined {
	return runs
		.filter((run) => run.teamName === teamName && !TERMINAL_RUN_STATUSES.has(run.status))
		.sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function renderWrapped(text: string, width: number, indent = 0): string[] {
	return new Text(text, indent, 0).render(Math.max(1, width));
}

function preview(value: string, maximum = 240): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length > maximum ? `${compact.slice(0, maximum - 1)}…` : compact;
}

function roleModelLabel(role: TeamRoleSummary): string {
	const fallback = role.modelFallback ?? "not configured";
	return role.modelPolicy === "fixed" ? `${fallback} (fixed)` : `${fallback} (manager selects)`;
}

function teamStateLabel(team: TeamDefinition, runs: readonly TeamRun[]): string {
	const run = activeTeamRun(team.name, runs) ?? latestTeamRun(team.name, runs);
	if (!run) return "idle";
	const counts = teamTaskCounts(run);
	return `${run.status} ${counts.completed}/${run.tasks.length}`;
}

function roleSummaryLabel(role: TeamRoleSummary): string {
	const state =
		role.activeInstances > 0
			? `${role.activeInstances}/${role.maxInstances} active`
			: role.failedInstances > 0
				? `${role.failedInstances} failed`
				: role.completedInstances > 0
					? `${role.completedInstances} completed`
					: role.plannedInstances > 0
						? `${role.plannedInstances} planned`
						: "idle";
	return `${state} · ${role.modelFallback ?? "auto"}:${role.thinking}`;
}

export class TeamRoleInspector implements Component {
	private readonly teamViewport = new SelectableViewportController();
	private readonly roleViewport = new SelectableViewportController();
	private readonly detailViewport = new ScrollViewportController();
	private focus: RoleFocus = "roles";
	private selectedTeamName: string | undefined;
	private unsubscribe: () => void;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private keybindings: KeybindingsManager,
		private getTeams: () => TeamDefinition[],
		private getRuns: () => TeamRun[],
		subscribe: (listener: () => void) => () => void,
		private done: () => void,
		initialTeamName?: string,
	) {
		this.selectedTeamName = initialTeamName ?? this.activeTeamName();
		this.selectInitialTeam();
		this.unsubscribe = subscribe(() => this.tui.requestRender());
	}

	private teams(): TeamDefinition[] {
		return [...this.getTeams()].sort((left, right) => left.name.localeCompare(right.name));
	}

	private runs(): TeamRun[] {
		return this.getRuns();
	}

	private activeTeamName(): string | undefined {
		return [...this.getRuns()]
			.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status))
			.sort((left, right) => right.updatedAt - left.updatedAt)
			.at(0)?.teamName;
	}

	private selectInitialTeam(): void {
		const teams = this.teams();
		const initialIndex = teams.findIndex((team) => team.name === this.selectedTeamName);
		this.teamViewport.selected = initialIndex >= 0 ? initialIndex : 0;
		this.selectedTeamName = teams[this.teamViewport.selected]?.name;
	}

	private selectedTeam(): TeamDefinition | undefined {
		const teams = this.teams();
		this.teamViewport.update(teams.length, Math.max(1, Math.min(5, teams.length)));
		const team = teams[this.teamViewport.selected];
		if (team && team.name !== this.selectedTeamName) {
			this.selectedTeamName = team.name;
			this.roleViewport.selected = 0;
			this.detailViewport.home();
		}
		return team;
	}

	private selectedRole(team: TeamDefinition | undefined): TeamRoleSummary | undefined {
		if (!team) return undefined;
		const roles = buildTeamRoleSummaries(team, this.runs());
		this.roleViewport.update(roles.length, Math.max(1, roles.length));
		return roles[this.roleViewport.selected];
	}

	private navigationLines(width: number, height: number): string[] {
		const teams = this.teams();
		const selectedTeam = this.selectedTeam();
		const roles = selectedTeam ? buildTeamRoleSummaries(selectedTeam, this.runs()) : [];
		const teamPageSize = Math.max(1, Math.min(5, Math.floor(Math.max(1, height - 5) / 3)));
		const rolePageSize = Math.max(1, height - teamPageSize - 5);
		this.teamViewport.update(teams.length, teamPageSize);
		this.roleViewport.update(roles.length, rolePageSize);
		const lines = [this.theme.fg("muted", this.theme.bold("Teams"))];
		const teamRange = this.teamViewport.viewport.range;
		for (let index = teamRange.start; index < teamRange.end; index++) {
			const team = teams[index];
			const selected = index === this.teamViewport.selected;
			const prefix = selected && this.focus === "teams" ? this.theme.fg("accent", "› ") : "  ";
			const marker = activeTeamRun(team.name, this.runs()) ? "◌" : "○";
			const color = activeTeamRun(team.name, this.runs())
				? "warning"
				: selected
					? "accent"
					: "muted";
			lines.push(
				truncateToWidth(`${prefix}${this.theme.fg(color, marker)} ${team.name}`, width, "…"),
			);
			lines.push(
				truncateToWidth(
					this.theme.fg("dim", `    ${teamStateLabel(team, this.runs())}`),
					width,
					"…",
				),
			);
		}
		lines.push(
			"",
			this.theme.fg("muted", this.theme.bold(`Roles · ${selectedTeam?.name ?? "none"}`)),
		);
		if (!selectedTeam || roles.length === 0) {
			lines.push(this.theme.fg("dim", "No roles configured."));
			return lines;
		}
		for (
			let index = this.roleViewport.viewport.range.start;
			index < this.roleViewport.viewport.range.end;
			index++
		) {
			const role = roles[index];
			const selected = index === this.roleViewport.selected;
			const prefix = selected && this.focus === "roles" ? this.theme.fg("accent", "› ") : "  ";
			const marker = role.activeInstances > 0 ? "◌" : role.totalInstances > 0 ? "✓" : "○";
			const color =
				role.activeInstances > 0
					? "warning"
					: selected
						? "accent"
						: role.totalInstances > 0
							? "success"
							: "muted";
			lines.push(
				truncateToWidth(`${prefix}${this.theme.fg(color, marker)} ${role.name}`, width, "…"),
			);
			lines.push(
				truncateToWidth(this.theme.fg("dim", `    ${roleSummaryLabel(role)}`), width, "…"),
			);
		}
		return lines;
	}

	private instanceLines(instances: TeamRoleInstance[], width: number): string[] {
		if (instances.length === 0)
			return [this.theme.fg("dim", "No task instances for this role yet.")];
		const lines: string[] = [];
		for (const instance of instances) {
			const icon = this.theme.fg(
				teamTaskStatusColor(instance.status),
				teamTaskStatusIcon(instance.status),
			);
			lines.push(
				truncateToWidth(`${icon} ${instance.title} · ${statusLabel(instance.status)}`, width, "…"),
			);
			const child =
				instance.subagentRunId && instance.subagentTaskId
					? `child ${instance.subagentRunId}/${instance.subagentTaskId}`
					: "child not delegated";
			lines.push(
				...renderWrapped(
					`${instance.model}:${instance.thinking} · ${instance.workspace} · task ${instance.taskId}`,
					width,
					2,
				),
			);
			lines.push(...renderWrapped(`${child} · run ${instance.runId}`, width, 2));
			lines.push(...renderWrapped(instance.goal, width, 2));
			if (instance.error)
				lines.push(
					...renderWrapped(
						`${this.theme.fg("error", "error: ")}${preview(instance.error)}`,
						width,
						2,
					),
				);
			else if (instance.output)
				lines.push(
					...renderWrapped(
						`${this.theme.fg("success", "output: ")}${preview(instance.output)}`,
						width,
						2,
					),
				);
			if (instance.usage) lines.push(this.theme.fg("dim", `  ${formatUsage(instance.usage)}`));
			lines.push("");
		}
		return lines;
	}

	private detailLines(
		team: TeamDefinition | undefined,
		role: TeamRoleSummary | undefined,
		width: number,
	): string[] {
		if (!team) return [this.theme.fg("muted", "No configured teams.")];
		if (!role) return [this.theme.fg("muted", "Select a role to inspect it.")];
		const instances = buildTeamRoleInstances(team.name, role.name, this.runs());
		const tools = role.config.tools?.length
			? role.config.tools.join(", ")
			: "Inherited from the active parent session";
		const allowedModels = role.config.allowedModels?.length
			? role.config.allowedModels.join(", ")
			: "Any enabled model permitted by policy";
		const lines = [
			this.theme.fg("accent", this.theme.bold(`${team.name} / ${role.name}`)),
			...renderWrapped(this.theme.fg("dim", team.description), width),
			"",
			...renderWrapped(role.config.description, width),
			"",
			...(role.config.instructions
				? [
						this.theme.fg("muted", this.theme.bold("Child instructions")),
						...renderWrapped(role.config.instructions, width),
						"",
					]
				: []),
			this.theme.fg("muted", this.theme.bold("Effective configuration")),
			`Model policy: ${role.modelPolicy}`,
			`Model: ${roleModelLabel(role)}`,
			`Thinking: ${role.thinking}`,
			`Workspace: ${role.workspace}`,
			`Capacity: ${role.activeInstances}/${role.maxInstances} active · ${role.totalInstances} total`,
			`Review role: ${role.config.review ? "yes" : "no"}`,
			`Verification role: ${role.config.verification ? "yes" : "no"}`,
			...renderWrapped(`Tools: ${tools}`, width),
			...renderWrapped(`Allowed models: ${allowedModels}`, width),
			"",
			this.theme.fg("muted", this.theme.bold(`Task instances (${instances.length})`)),
			...this.instanceLines(instances, width),
		];
		return lines;
	}

	render(width: number): string[] {
		const teams = this.teams();
		const selectedTeam = this.selectedTeam();
		const selectedRole = this.selectedRole(selectedTeam);
		const contentWidth = getContentWidth(width);
		const height = Math.max(1, this.tui.terminal.rows);
		const styles = createTuiStyles(this.theme);
		const subtitle = selectedTeam
			? `${selectedTeam.name} · ${teams.length} configured team${teams.length === 1 ? "" : "s"}`
			: "No configured teams";
		const headerOptions = { width, title: "Team roles", subtitle, styles };
		const keyHints =
			this.focus === "teams"
				? [
						{ key: "↑↓", label: "select team" },
						{ key: "Enter/Tab", label: "roles" },
						{ key: "Esc", label: "close" },
					]
				: [
						{ key: "↑↓", label: "select role" },
						{ key: "Tab/Esc", label: "teams" },
						{ key: "PgUp/PgDn", label: "details" },
					];
		const headerHeight = renderHeader(headerOptions).length;
		const footerHeight = renderFooter({ width, hints: keyHints, styles, padding: 1 }).length;
		const bodyHeight = Math.max(1, height - headerHeight - footerHeight);
		const body = renderSplitPane({
			width: contentWidth,
			height: bodyHeight,
			left: (paneWidth, paneHeight) => this.navigationLines(paneWidth, paneHeight),
			right: (paneWidth) => {
				const lines = this.detailLines(selectedTeam, selectedRole, paneWidth);
				this.detailViewport.update(lines.length, bodyHeight);
				return lines.slice(this.detailViewport.range.start, this.detailViewport.range.end);
			},
			narrowPane: this.focus === "teams" ? "left" : "right",
			breakpoint: 100,
			leftRatio: 0.36,
			minLeftWidth: 30,
			maxLeftWidth: 46,
			minRightWidth: 24,
			divider: this.theme.fg(this.focus === "roles" ? "accent" : "borderMuted", " │ "),
		});
		return renderFullscreenScreen({
			...headerOptions,
			height,
			body,
			keyHints,
			footerPadding: 1,
			styles,
		});
	}

	handleInput(data: string): void {
		const teams = this.teams();
		const selectedTeam = this.selectedTeam();
		const roles = selectedTeam ? buildTeamRoleSummaries(selectedTeam, this.runs()) : [];
		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
			if (this.focus === "roles") this.focus = "teams";
			else this.done();
			this.tui.requestRender();
			return;
		}
		if (
			matchesKey(data, Key.tab) ||
			this.keybindings.matches(data, "tui.select.confirm") ||
			matchesKey(data, Key.enter)
		) {
			this.focus = this.focus === "teams" ? "roles" : "teams";
			this.tui.requestRender();
			return;
		}
		if (this.focus === "teams") {
			if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up))
				this.teamViewport.moveBy(-1, teams.length);
			else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down))
				this.teamViewport.moveBy(1, teams.length);
			else return;
			this.selectedTeamName = teams[this.teamViewport.selected]?.name;
			this.roleViewport.selected = 0;
			this.detailViewport.home();
		} else if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
			this.roleViewport.moveBy(-1, roles.length);
			this.detailViewport.home();
		} else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down)) {
			this.roleViewport.moveBy(1, roles.length);
			this.detailViewport.home();
		} else if (
			this.keybindings.matches(data, "tui.select.pageUp") ||
			matchesKey(data, Key.pageUp)
		) {
			this.detailViewport.pageBy(-1);
		} else if (
			this.keybindings.matches(data, "tui.select.pageDown") ||
			matchesKey(data, Key.pageDown)
		) {
			this.detailViewport.pageBy(1);
		} else if (this.keybindings.matches(data, "tui.select.home") || matchesKey(data, Key.home)) {
			this.detailViewport.home();
		} else if (this.keybindings.matches(data, "tui.select.end") || matchesKey(data, Key.end)) {
			this.detailViewport.end();
		} else return;
		this.tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
	}
}

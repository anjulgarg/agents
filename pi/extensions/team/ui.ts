import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";

import type { TeamDefinition, TeamRun } from "./contracts.ts";
import { TeamRoleInspector } from "./role-ui.ts";
import { TeamRunDashboard } from "./run-ui.ts";

export { TeamPlanReview, formatTeamPlanMarkdown, reviewTeamPlan } from "./plan-ui.ts";
export { TeamRoleInspector } from "./role-ui.ts";
export { TeamRunDashboard } from "./run-ui.ts";

/**
 * Team inspection shell. Run monitoring remains in TeamRunDashboard while the
 * role catalog and effective role details live in TeamRoleInspector.
 */
export class TeamDashboard implements Component {
	private view: "runs" | "roles" = "runs";
	private readonly runView: TeamRunDashboard;
	private readonly roleView: TeamRoleInspector;

	constructor(
		private tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		getRuns: () => TeamRun[],
		subscribe: (listener: () => void) => () => void,
		done: () => void,
		killTask: (runId: string, taskId: string) => void,
		getTeams: () => TeamDefinition[] = () => [],
		initialTeamName?: string,
	) {
		this.runView = new TeamRunDashboard(
			tui,
			theme,
			keybindings,
			getRuns,
			subscribe,
			done,
			killTask,
		);
		this.roleView = new TeamRoleInspector(
			tui,
			theme,
			keybindings,
			getTeams,
			getRuns,
			subscribe,
			() => this.showRuns(),
			initialTeamName,
		);
	}

	private showRuns(): void {
		this.view = "runs";
		this.tui.requestRender();
	}

	private showRoles(): void {
		this.view = "roles";
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return this.view === "roles" ? this.roleView.render(width) : this.runView.render(width);
	}

	handleInput(data: string): void {
		if (this.view === "runs" && (data === "r" || data === "R")) {
			this.showRoles();
			return;
		}
		if (this.view === "roles") this.roleView.handleInput(data);
		else this.runView.handleInput(data);
	}

	invalidate(): void {
		this.runView.invalidate();
		this.roleView.invalidate();
	}

	dispose(): void {
		this.runView.dispose();
		this.roleView.dispose();
	}
}

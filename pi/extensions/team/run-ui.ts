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
	renderFullscreenScreen,
	renderFooter,
	renderHeader,
	renderSplitPane,
	SelectableViewportController,
} from "../lib/tui/index.ts";
import type { TeamRun, TeamRunStatus, TeamTask } from "./contracts.ts";
import {
	teamRunStatusColor,
	teamRunStatusIcon,
	teamTaskCounts,
	teamTaskStatusColor,
	teamTaskStatusIcon,
} from "./display.ts";

const TERMINAL_RUN_STATUSES = new Set<TeamRunStatus>(["completed", "failed", "cancelled"]);

export class TeamRunDashboard implements Component {
	private readonly runViewport = new SelectableViewportController();
	private readonly taskViewport = new SelectableViewportController();
	private taskFocused = false;
	private killArmed = false;
	private unsubscribe: () => void;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private keybindings: KeybindingsManager,
		private getRuns: () => TeamRun[],
		subscribe: (listener: () => void) => () => void,
		private done: () => void,
		private killTask: (runId: string, taskId: string) => void,
	) {
		this.unsubscribe = subscribe(() => this.tui.requestRender());
	}

	private sortedRuns(): TeamRun[] {
		return [...this.getRuns()].sort((a, b) => b.startedAt - a.startedAt);
	}

	private selectedRunningTask(runs: TeamRun[]): { run: TeamRun; task: TeamTask } | undefined {
		const run = runs[this.runViewport.selected];
		const task = run?.tasks[this.taskViewport.selected];
		if (!run || !task || task.status !== "running") return undefined;
		return { run, task };
	}

	private runHints(): Array<{ key: string; label: string }> {
		if (this.killArmed)
			return [
				{ key: "k", label: "again to KILL selected" },
				{ key: "Esc", label: "cancel" },
			];
		return this.taskFocused
			? [
					{ key: "↑↓", label: "select" },
					{ key: "Tab/Esc", label: "teams" },
					{ key: "k", label: "kill running" },
					{ key: "/subagents", label: "transcripts" },
					{ key: "r", label: "roles" },
				]
			: [
					{ key: "↑↓", label: "select" },
					{ key: "Enter/Tab", label: "tasks" },
					{ key: "k", label: "kill running" },
					{ key: "Esc", label: "close" },
					{ key: "r", label: "roles" },
				];
	}

	private runLines(runs: TeamRun[], width: number, height: number): string[] {
		const visible = Math.max(1, Math.floor(height / 2));
		this.runViewport.update(runs.length, visible);
		if (runs.length === 0) {
			return [
				this.theme.fg("muted", "No team runs in this session."),
				this.theme.fg("dim", "Start a team with /team:<name> <goal>."),
			];
		}
		const lines: string[] = [];
		const range = this.runViewport.viewport.range;
		for (let index = range.start; index < range.end; index++) {
			const run = runs[index];
			const counts = teamTaskCounts(run);
			const selected = index === this.runViewport.selected;
			const cue = teamRunStatusIcon(run.status);
			const color = teamRunStatusColor(run.status);
			const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
			lines.push(
				truncateToWidth(
					`${prefix}${this.theme.fg(color, cue)} ${this.theme.fg(selected ? "accent" : "text", run.teamName)} ${this.theme.fg("muted", run.status)}`,
					width,
					"…",
				),
			);
			lines.push(
				truncateToWidth(
					this.theme.fg(
						"dim",
						`    ${counts.completed}/${run.tasks.length} complete · ${counts.running} running · ${counts.failed} failed`,
					),
					width,
					"…",
				),
			);
		}
		return lines;
	}

	private taskLines(run: TeamRun | undefined, width: number, height: number): string[] {
		if (!run) return [this.theme.fg("muted", "Select a team run.")];
		const runCue = teamRunStatusIcon(run.status);
		const runColor = teamRunStatusColor(run.status);
		const lines = [
			`${this.theme.fg(runColor, runCue)} ${this.theme.fg("accent", this.theme.bold(`${run.teamName} team`))} ${this.theme.fg("muted", run.status)}`,
			...new Text(this.theme.fg("dim", run.goal), 0, 0).render(width),
			"",
		];
		if (run.tasks.length === 0) {
			lines.push(this.theme.fg("muted", "Waiting for the manager to submit a plan."));
			return lines;
		}
		const visibleTasks = Math.max(1, Math.min(10, height - 8));
		this.taskViewport.update(run.tasks.length, visibleTasks);
		const range = this.taskViewport.viewport.range;
		for (let index = range.start; index < range.end; index++) {
			const item = run.tasks[index];
			const prefix = index === this.taskViewport.selected ? "› " : "  ";
			lines.push(
				truncateToWidth(
					`${prefix}${this.theme.fg(teamTaskStatusColor(item.status), teamTaskStatusIcon(item.status))} ${item.title}`,
					width,
					"…",
				),
			);
		}
		const task = run.tasks[this.taskViewport.selected];
		if (!task) return lines;
		lines.push(
			"",
			truncateToWidth(this.theme.fg("accent", this.theme.bold(task.title)), width, "…"),
		);
		lines.push(
			truncateToWidth(
				this.theme.fg("muted", `${task.role} · ${task.model}:${task.thinking} · ${task.workspace}`),
				width,
				"…",
			),
		);
		if (task.dependsOn.length)
			lines.push(
				truncateToWidth(
					this.theme.fg("dim", `depends on: ${task.dependsOn.join(", ")}`),
					width,
					"…",
				),
			);
		lines.push(...new Text(task.description, 1, 0).render(Math.max(1, width)));
		if (task.error)
			lines.push(
				"",
				...new Text(`${this.theme.fg("error", "✗ error: ")}${task.error}`, 1, 0).render(
					Math.max(1, width),
				),
			);
		else if (task.output)
			lines.push(
				"",
				...new Text(
					`${this.theme.fg("success", "✓ output: ")}${this.theme.fg("dim", task.output)}`,
					1,
					0,
				).render(Math.max(1, width)),
			);
		if (run.status === "completed" && run.completionSummary)
			lines.push(
				"",
				...new Text(this.theme.fg("success", `✓ ${run.completionSummary}`), 1, 0).render(
					Math.max(1, width),
				),
			);
		return lines;
	}

	render(width: number): string[] {
		const runs = this.sortedRuns();
		const contentWidth = getContentWidth(width);
		const height = Math.max(1, this.tui.terminal.rows);
		const styles = createTuiStyles(this.theme);
		const subtitle =
			runs.length === 0
				? "No runs"
				: `${runs.length} run${runs.length === 1 ? "" : "s"} · ${runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status)).length} active`;
		const headerOptions = { width, title: "Teams", subtitle, styles };
		const keyHints = this.runHints();
		const footerOptions = { width, hints: keyHints, styles, padding: 1 };
		const headerHeight = renderHeader(headerOptions).length;
		const footerHeight = renderFooter(footerOptions).length;
		const bodyHeight = Math.max(1, height - headerHeight - footerHeight);
		const body = renderSplitPane({
			width: contentWidth,
			height: bodyHeight,
			left: (paneWidth, paneHeight) => this.runLines(runs, paneWidth, paneHeight),
			right: (paneWidth, paneHeight) =>
				this.taskLines(runs[this.runViewport.selected], paneWidth, paneHeight),
			narrowPane: this.taskFocused ? "right" : "left",
			breakpoint: 100,
			leftRatio: 0.34,
			minLeftWidth: 30,
			maxLeftWidth: 44,
			minRightWidth: 24,
			divider: this.theme.fg(this.taskFocused ? "accent" : "borderMuted", " │ "),
		});
		return renderFullscreenScreen({
			...headerOptions,
			height,
			body,
			keyHints,
			footerPadding: 1,
		});
	}

	handleInput(data: string): void {
		const runs = this.sortedRuns();
		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
			if (this.killArmed) {
				this.killArmed = false;
				this.tui.requestRender();
				return;
			}
			if (this.taskFocused) this.taskFocused = false;
			else this.done();
			this.tui.requestRender();
			return;
		}
		if (data === "k" || data === "K") {
			const selected = this.selectedRunningTask(runs);
			if (!selected) {
				this.killArmed = false;
				this.tui.requestRender();
				return;
			}
			if (!this.killArmed) {
				this.killArmed = true;
				this.tui.requestRender();
				return;
			}
			this.killTask(selected.run.id, selected.task.id);
			this.killArmed = false;
			this.tui.requestRender();
			return;
		}
		this.killArmed = false;
		if (
			matchesKey(data, Key.tab) ||
			this.keybindings.matches(data, "tui.select.confirm") ||
			matchesKey(data, Key.enter)
		) {
			if (runs.length) this.taskFocused = !this.taskFocused;
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
			if (this.taskFocused)
				this.taskViewport.moveBy(-1, runs[this.runViewport.selected]?.tasks.length ?? 0);
			else this.runViewport.moveBy(-1, runs.length);
		} else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down)) {
			if (this.taskFocused)
				this.taskViewport.moveBy(1, runs[this.runViewport.selected]?.tasks.length ?? 0);
			else this.runViewport.moveBy(1, runs.length);
		}
		this.tui.requestRender();
	}

	invalidate(): void {}
	dispose(): void {
		this.unsubscribe();
	}
}

import {
	getMarkdownTheme,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	Key,
	Markdown,
	matchesKey,
	type Component,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";

import {
	createTuiStyles,
	fullscreenOverlayOptions,
	getContentWidth,
	renderFullscreenScreen,
	renderFooter,
	renderHeader,
	SelectableViewportController,
	ScrollViewportController,
} from "../lib/tui/index.ts";
import type { TeamTask } from "./contracts.ts";

type TeamPlanAction = "approve" | "revise" | "cancel";

const TEAM_PLAN_ACTIONS = [
	{ value: "approve" as const, label: "Approve plan" },
	{ value: "revise" as const, label: "Request changes" },
	{ value: "cancel" as const, label: "Cancel team" },
];

export function formatTeamPlanMarkdown(
	teamName: string,
	summary: string,
	tasks: TeamTask[],
): string {
	const taskSections = tasks.map((task, index) => {
		const dependencies = task.dependsOn.length
			? task.dependsOn.map((dependency) => `\`${dependency}\``).join(", ")
			: "None";
		return [
			`### ${index + 1}. ${task.title}`,
			"",
			`\`${task.id}\` · **Role:** \`${task.role}\` · **Model:** \`${task.model}:${task.thinking}\` · **Workspace:** \`${task.workspace}\``,
			"",
			`**Depends on:** ${dependencies}`,
			"",
			task.description,
		].join("\n");
	});
	return [`# ${teamName} team plan`, summary, "## Tasks", ...taskSections].join("\n\n");
}

export class TeamPlanReview implements Component {
	private readonly actions = new SelectableViewportController();
	private readonly documentViewport = new ScrollViewportController();
	private readonly document: string;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private keybindings: KeybindingsManager,
		teamName: string,
		summary: string,
		tasks: TeamTask[],
		private done: (choice: TeamPlanAction | undefined) => void,
	) {
		this.document = formatTeamPlanMarkdown(teamName, summary, tasks);
	}

	private actionLine(): string {
		this.actions.update(TEAM_PLAN_ACTIONS.length, 1);
		return TEAM_PLAN_ACTIONS.map((action, index) => {
			const label = ` ${action.label} `;
			return index === this.actions.selected
				? this.theme.bg("selectedBg", this.theme.fg("accent", label))
				: this.theme.fg("muted", label);
		}).join(" ");
	}

	render(width: number): string[] {
		const height = Math.max(1, this.tui.terminal.rows);
		const contentWidth = getContentWidth(width);
		const styles = createTuiStyles(this.theme);
		const footerLines = [this.actionLine()];
		const keyHints = [
			{ key: "↑↓/PgUp/PgDn", label: "review" },
			{ key: "←→/Tab", label: "option" },
			{ key: "Enter", label: "select" },
			{ key: "Esc", label: "cancel" },
		];
		const headerOptions = {
			width,
			title: "Team plan review",
			subtitle: "Choose how to proceed",
			styles,
		};
		const footerOptions = { width, lines: footerLines, hints: keyHints, styles, padding: 1 };
		const headerHeight = renderHeader(headerOptions).length;
		const footerHeight = renderFooter(footerOptions).length;
		const bodyHeight = Math.max(1, height - headerHeight - footerHeight);
		const rendered = new Markdown(this.document, 0, 0, getMarkdownTheme()).render(
			Math.max(1, contentWidth - 2),
		);
		this.documentViewport.update(rendered.length, bodyHeight);
		const visible = rendered.slice(
			this.documentViewport.range.start,
			this.documentViewport.range.end,
		);
		const viewport: Component = {
			render: () => visible,
			invalidate: () => {},
		};
		const plan = new Box(1, 1, (text) => this.theme.bg("toolPendingBg", text));
		plan.addChild(viewport);
		const body = plan.render(Math.max(1, contentWidth));
		return renderFullscreenScreen({
			...headerOptions,
			height,
			body,
			footerLines,
			keyHints,
			footerPadding: 1,
			styles,
		});
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape))
			this.done(undefined);
		else if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter))
			this.done(TEAM_PLAN_ACTIONS[this.actions.selected].value);
		else if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up))
			this.documentViewport.scrollBy(-1);
		else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down))
			this.documentViewport.scrollBy(1);
		else if (this.keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp))
			this.documentViewport.pageBy(-1);
		else if (
			this.keybindings.matches(data, "tui.select.pageDown") ||
			matchesKey(data, Key.pageDown)
		)
			this.documentViewport.pageBy(1);
		else if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
			this.actions.selected =
				(this.actions.selected - 1 + TEAM_PLAN_ACTIONS.length) % TEAM_PLAN_ACTIONS.length;
		} else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			this.actions.selected = (this.actions.selected + 1) % TEAM_PLAN_ACTIONS.length;
		} else return;
		this.tui.requestRender();
	}

	invalidate(): void {}
}

export async function reviewTeamPlan(
	ctx: ExtensionContext,
	teamName: string,
	summary: string,
	tasks: TeamTask[],
): Promise<TeamPlanAction | undefined> {
	if (ctx.mode !== "tui") return undefined;
	return ctx.ui.custom<TeamPlanAction | undefined>(
		(tui, theme, keybindings, done) =>
			new TeamPlanReview(tui, theme, keybindings, teamName, summary, tasks, done),
		fullscreenOverlayOptions(),
	);
}

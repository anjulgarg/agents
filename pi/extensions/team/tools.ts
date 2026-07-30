import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { ExpandableToolRender } from "../lib/tui/index.ts";
import { THINKING_LEVELS, WORKSPACE_MODES, type TeamStateDetails } from "./contracts.ts";
import { reviewTeamPlan } from "./ui.ts";
import { TeamRuntime } from "./runtime.ts";

const CHAT_PADDING = 1;

const ProposedTaskSchema = Type.Object({
	id: Type.String({
		description: "Stable unique task ID using lowercase letters, numbers, and hyphens",
	}),
	title: Type.String({ description: "Short task title" }),
	description: Type.String({ description: "Complete bounded assignment and success criteria" }),
	role: Type.String({ description: "Team role assigned to this task" }),
	dependsOn: Type.Optional(
		Type.Array(Type.String(), { description: "Task IDs that must complete first" }),
	),
	model: Type.Optional(
		Type.String({ description: "Explicit available model override when team policy permits" }),
	),
	thinking: Type.Optional(
		StringEnum(THINKING_LEVELS, { description: "Explicit thinking-level override" }),
	),
	workspace: Type.Optional(StringEnum(WORKSPACE_MODES, { description: "Workspace override" })),
});

const TeamPlanParams = Type.Object({
	summary: Type.String({ description: "Concise implementation strategy and integration plan" }),
	tasks: Type.Array(ProposedTaskSchema, {
		description: "Complete task plan, including implementation, review, and verification tasks",
		minItems: 1,
		maxItems: 64,
	}),
});

const TeamRetryParams = Type.Object({
	taskIds: Type.Array(Type.String(), {
		description: "Failed team task IDs to reset for another delegation attempt",
		minItems: 1,
		maxItems: 8,
	}),
	reason: Type.String({
		description: "Why retrying is appropriate and what changes in the next attempt",
	}),
	userApprovedManualRetry: Type.Optional(
		Type.Boolean({
			description:
				"Set true only after the user explicitly approves retrying a manually killed team task",
		}),
	),
});

const TeamCompleteParams = Type.Object({
	success: Type.Boolean({
		description: "Whether the integrated outcome passed final verification",
	}),
	summary: Type.String({
		description: "Final outcome, evidence, remaining risks, and worktree integration notes",
	}),
});

export function registerTeamTools(pi: ExtensionAPI, runtime: TeamRuntime): void {
	pi.registerTool({
		name: "team_plan",
		label: "Team Plan",
		renderShell: "self",
		description:
			"Submit or revise the active team's complete task plan for validation and user approval before delegation.",
		promptSnippet: "Create and approve a structured team task plan before delegation",
		promptGuidelines: [
			"When managing an active team, call team_plan before calling subagent and include implementation, independent review, and final verification tasks.",
			"After team_plan approval, delegate only dependency-ready tasks and pass each task's teamRunId, teamTaskId, and role to subagent.",
		],
		parameters: TeamPlanParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return runtime.planTeam(params, ctx, (teamName, summary, tasks) =>
				reviewTeamPlan(ctx, teamName, summary, tasks),
			);
		},
		renderCall(args, theme, context) {
			return new ExpandableToolRender(
				context,
				new Text(
					theme.fg("toolTitle", theme.bold("team plan ")) +
						theme.fg("muted", `${args.tasks?.length ?? 0} tasks · ${args.summary ?? ""}`),
					CHAT_PADDING,
					0,
				),
			);
		},
		renderResult(result, _options, theme, context) {
			const details = result.details as TeamStateDetails | undefined;
			const raw = result.content.find((part) => part.type === "text")?.text ?? "No team plan";
			if (!details || context.isError) {
				return new ExpandableToolRender(
					context,
					new Text(theme.fg(context.isError ? "error" : "muted", raw), CHAT_PADDING, 0),
				);
			}
			const content = new Container();
			const icon = details.approved ? theme.fg("success", "✓") : theme.fg("warning", "○");
			content.addChild(
				new Text(
					`${icon} ${theme.fg("accent", details.run.teamName)} ${theme.fg("muted", `${details.run.tasks.length} tasks · ${details.run.status}`)}`,
					CHAT_PADDING,
					0,
				),
			);
			if (raw) content.addChild(new Text(theme.fg("muted", raw), CHAT_PADDING, 0));
			return new ExpandableToolRender(context, content);
		},
	});

	pi.registerTool({
		name: "team_retry",
		label: "Team Retry",
		renderShell: "self",
		description:
			"Reset failed team tasks for a deliberate retry after correcting the failure cause.",
		promptSnippet: "Retry failed team tasks without discarding successful work",
		promptGuidelines: [
			"Use team_retry when a team task fails and a bounded retry can address the failure; explain what changes before redelegating.",
			"Never retry a team task manually killed by the user until discussing it with them and receiving explicit approval. Only then set userApprovedManualRetry=true.",
		],
		parameters: TeamRetryParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return runtime.retryTeam(params, ctx);
		},
		renderCall(args, theme, context) {
			return new ExpandableToolRender(
				context,
				new Text(
					theme.fg("toolTitle", theme.bold("team retry ")) +
						theme.fg("muted", args.taskIds?.join(", ") ?? ""),
					CHAT_PADDING,
					0,
				),
			);
		},
		renderResult(result, _options, theme, context) {
			const run = (result.details as TeamStateDetails | undefined)?.run;
			const raw = result.content.find((part) => part.type === "text")?.text ?? "Team retry failed";
			const content =
				context.isError || !run
					? new Text(theme.fg(context.isError ? "error" : "muted", raw), CHAT_PADDING, 0)
					: new Text(
							`${theme.fg("success", "✓ retry ready")}\n${theme.fg("muted", raw)}`,
							CHAT_PADDING,
							0,
						);
			return new ExpandableToolRender(context, content);
		},
	});

	pi.registerTool({
		name: "team_complete",
		label: "Team Complete",
		renderShell: "self",
		description:
			"Finish the active team after integration, independent review, and final verification.",
		promptSnippet: "Record the verified final outcome of an active team",
		promptGuidelines: [
			"Call team_complete only after all required team tasks, reviews, and final verification have finished.",
		],
		parameters: TeamCompleteParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return runtime.completeTeam(params, ctx);
		},
		renderCall(args, theme, context) {
			return new ExpandableToolRender(
				context,
				new Text(
					theme.fg("toolTitle", theme.bold("team complete ")) +
						theme.fg(args.success ? "success" : "error", args.success ? "success" : "failed"),
					CHAT_PADDING,
					0,
				),
			);
		},
		renderResult(result, _options, theme, context) {
			const run = (result.details as TeamStateDetails | undefined)?.run;
			const raw =
				result.content.find((part) => part.type === "text")?.text ?? "Team completion failed";
			const content =
				context.isError || !run
					? new Text(theme.fg(context.isError ? "error" : "muted", raw), CHAT_PADDING, 0)
					: new Text(
							`${theme.fg(run.status === "completed" ? "success" : "error", `${run.teamName}: ${run.status}`)}\n${theme.fg("muted", raw)}`,
							CHAT_PADDING,
							0,
						);
			return new ExpandableToolRender(context, content);
		},
	});
}

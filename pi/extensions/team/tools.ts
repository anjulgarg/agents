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
		description:
			"Stable unique task ID using lowercase letters, numbers, and hyphens; reuse it when revising a plan",
	}),
	title: Type.String({ description: "Short task title that identifies the bounded unit of work" }),
	description: Type.String({
		description:
			"Complete bounded assignment, required evidence, and objective success criteria for the delegated child",
	}),
	role: Type.String({
		description:
			"Configured team role assigned to this task; review and verification roles are required in a successful plan",
	}),
	dependsOn: Type.Optional(
		Type.Array(Type.String(), {
			description: "Task IDs that must be completed before this task can be delegated",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Explicit available model override only when the assigned role policy permits it",
		}),
	),
	thinking: Type.Optional(
		StringEnum(THINKING_LEVELS, {
			description: "Explicit thinking-level override when the role policy permits it",
		}),
	),
	workspace: Type.Optional(
		StringEnum(WORKSPACE_MODES, {
			description: "Workspace override accepted by the assigned role",
		}),
	),
});

const TeamPlanParams = Type.Object({
	summary: Type.String({
		description:
			"Concise implementation, integration, independent review, and final verification strategy",
	}),
	tasks: Type.Array(ProposedTaskSchema, {
		description:
			"The complete dependency graph. Include implementation, integration, at least one independent review task, and at least one verification task before delegation",
		minItems: 1,
		maxItems: 64,
	}),
});

const TeamRetryParams = Type.Object({
	taskIds: Type.Array(Type.String(), {
		description: "One or more failed team task IDs to reset while preserving completed work",
		minItems: 1,
		maxItems: 8,
	}),
	reason: Type.String({
		description:
			"Concrete failure cause and bounded change that makes the next delegation attempt appropriate",
	}),
	userApprovedManualRetry: Type.Optional(
		Type.Boolean({
			description:
				"Set true only after discussing a manually killed task with the user and receiving explicit approval to retry it",
		}),
	),
});

const TeamCompleteParams = Type.Object({
	success: Type.Boolean({
		description:
			"Whether integration passed objective final verification; true is rejected while any task is unfinished or required review/verification is incomplete",
	}),
	summary: Type.String({
		description:
			"Final outcome, verification evidence, remaining risks, and worktree integration notes",
	}),
});

export function registerTeamTools(pi: ExtensionAPI, runtime: TeamRuntime): void {
	pi.registerTool({
		name: "team_plan",
		label: "Team Plan",
		renderShell: "self",
		description:
			"Submit or revise the active team's complete dependency graph before delegation. Include bounded implementation and integration work plus dependent independent review and final verification tasks. The team validates roles, dependency readiness, model policy, concurrency limits, and configured approval; after approval, delegate only ready tasks through subagent with the exact teamRunId, teamTaskId, and role metadata.",
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
			"Reset one or more failed team tasks for a deliberate bounded retry without discarding successful work. Provide the corrected failure cause and next-attempt change. A task manually killed by the user remains blocked until the user has discussed and explicitly approved the retry, then userApprovedManualRetry must be true.",
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
			"Finish the active team only after integration, every required task, independent review, and final verification have finished. A successful completion is rejected when any task is pending, blocked, or running, or when configured review and verification roles have not completed; a failed completion records the outcome and remaining risks.",
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

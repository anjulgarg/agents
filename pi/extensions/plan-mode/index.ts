/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, active tool definitions remain unchanged and unsafe calls are blocked.
 *
 * Features:
 * - /plan command or Shift+Tab to toggle plan / auto mode
 * - Edit, write, job, and unsafe bash calls are blocked while planning
 * - Safe read-only bash commands remain available
 * - Extracts numbered plan steps from "Plan:" sections
 * - On execute, sends the approved plan back to the parent agent
 * - Execution ends when the agent settles
 */

import { readFile } from "node:fs/promises";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractPlanItems, isSafeCommand } from "./utils.ts";

/** Emitted on the inter-extension bus so the footer can show the current mode. */
export const MODE_EVENT = "agent-mode:change";
export type AgentMode = "plan" | "auto";

const FOREMAN_PLAN_SKILL = "foreman-plan";

interface PlanningSkill {
	name: string;
	filePath: string;
	baseDir: string;
}

const PLAN_MODE_BLOCKED_TOOLS = new Set<string>(["edit", "write", "job"]);
const BUILD_MODE_GUIDANCE =
	"[BUILD MODE ACTIVE]\nPlan-mode restrictions are disabled. Full tool access is available; do not claim that a build-mode switch is still required.";

// Pi-specific delivery contract injected alongside the planning skill. The skill itself
// stays harness-neutral and never gates implementation; plan-mode behavior lives here.
const READ_ONLY_DELIVERY_CONTRACT = `Read-only delivery contract (overrides only the skill's artifact-location, file-writing, and plan-path return instructions):
- Keep every discovery, design approval, separate plan confirmation, fidelity, and validation requirement in the skill.
- Remain read-only. Do not create or modify the repository plan document while plan mode is active.
- After explicit plan confirmation, use the skill's plan template as the plan structure but present the completed, validated plan in chat.
- Conclude the chat response with a "Plan:" header and a numbered execution summary. Each item must identify one ordered feature or integration outcome so approval and execution controls can be offered.
- Do not implement the plan. Wait for the user to transition explicitly into execution.`;

interface PlanModeState {
	enabled: boolean;
	executing?: boolean;
	toolsBeforePlanMode?: string[];
}

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let toolsBeforePlanMode: string[] | undefined;
	let cachedPlanningSkill: { filePath: string; content: string } | undefined;
	let planningSkillWarningShown = false;
	let planningGuidanceInjected = false;
	let buildModeGuidancePending = false;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Publish the current mode for the footer (foreman-theme renders it far-left).
		// Kept as setStatus too so the indicator still shows without a custom footer.
		const mode: AgentMode = planModeEnabled ? "plan" : "auto";
		pi.events.emit(MODE_EVENT, { mode });
		ctx.ui.setStatus(
			"plan-mode",
			planModeEnabled ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined,
		);
	}

	function enablePlanModeTools(): void {
		// Keep the active tool names and ordering byte-stable across mode changes.
		// Safety is enforced by the tool_call hook below instead of tool removal.
		toolsBeforePlanMode ??= pi.getActiveTools() ?? [];
	}

	function restoreNormalModeTools(): void {
		// Active tools were never changed, so restoration only clears the legacy snapshot.
		toolsBeforePlanMode = undefined;
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			executing: executionMode,
			toolsBeforePlanMode,
		} satisfies PlanModeState);
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		const wasPlanModeEnabled = planModeEnabled;
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		planningGuidanceInjected = false;
		buildModeGuidancePending = wasPlanModeEnabled && !planModeEnabled;

		if (planModeEnabled) {
			enablePlanModeTools();
			ctx.ui.notify("Plan mode enabled. Edit, write, and job calls blocked.");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("Auto mode enabled. Full access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	pi.registerCommand("plan", {
		description: "Toggle plan / auto mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerShortcut("shift+tab", {
		description: "Toggle plan / auto mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Keep all tool definitions active so provider prefixes and tool schemas stay stable.
	// Enforce plan-mode safety at execution time, including stale calls from prior prompts.
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		if (PLAN_MODE_BLOCKED_TOOLS.has(event.toolName)) {
			return {
				block: true,
				terminate: true,
				reason: `Plan mode: ${event.toolName} tool calls are blocked. Use /plan to disable plan mode first.`,
			};
		}

		if (event.toolName !== "bash") return;

		const command = typeof event.input?.command === "string" ? event.input.command : "";
		if (!isSafeCommand(command)) {
			return {
				block: true,
				terminate: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	async function loadPlanningSkill(
		skills: readonly PlanningSkill[] | undefined,
	): Promise<{ skill: PlanningSkill; content: string } | undefined> {
		const skill = skills?.find(({ name }) => name === FOREMAN_PLAN_SKILL);
		if (!skill) return undefined;
		if (cachedPlanningSkill?.filePath === skill.filePath) {
			return { skill, content: cachedPlanningSkill.content };
		}

		try {
			const content = await readFile(skill.filePath, "utf8");
			cachedPlanningSkill = { filePath: skill.filePath, content };
			planningSkillWarningShown = false;
			return { skill, content };
		} catch {
			return undefined;
		}
	}

	// Inject plan/execution context before agent starts as hidden tail messages.
	pi.on("before_agent_start", async (event, ctx) => {
		if (planModeEnabled) {
			if (planningGuidanceInjected) return;
			const planningSkill = await loadPlanningSkill(event.systemPromptOptions?.skills);
			if (!planningSkill && !planningSkillWarningShown) {
				planningSkillWarningShown = true;
				if (ctx.hasUI) {
					ctx.ui.notify(
						"Foreman planning guidance is unavailable; using the safe fallback workflow.",
						"warning",
					);
				}
			}

			const workflow = planningSkill
				? `Follow the Foreman planning skill below, then apply the read-only delivery contract that follows it. Resolve the skill's relative references from ${planningSkill.skill.baseDir}.

<foreman_plan_skill path=${JSON.stringify(planningSkill.skill.filePath)}>
${planningSkill.content}
</foreman_plan_skill>

${READ_ONLY_DELIVERY_CONTRACT}`
				: `The foreman-plan skill could not be loaded. Use this safe fallback: inspect first, choose a proportional discovery depth, obtain explicit design approval, then separately ask whether to create the implementation plan. Only after both approvals, return a detailed numbered plan under a "Plan:" header. Never implement it.`;

			planningGuidanceInjected = true;
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Edit, write, and job tool calls are blocked
- Other currently active tools remain available
- Bash is restricted to an allowlist of read-only commands (also enforced for stale job calls)
- Do not implement changes while plan mode remains active

${workflow}`,
					display: false,
				},
			};
		}

		if (executionMode) {
			return {
				message: {
					customType: "plan-execution-context",
					content: `${BUILD_MODE_GUIDANCE}

[EXECUTING PLAN - Full tool access enabled]

Execute the approved plan in order. Track progress with the task-management
capabilities available to you, and record each step immediately after its work is
verified instead of batching progress updates at the end.`,
					display: false,
				},
			};
		}

		if (buildModeGuidancePending) {
			buildModeGuidancePending = false;
			return {
				message: {
					customType: "plan-build-context",
					content: BUILD_MODE_GUIDANCE,
					display: false,
				},
			};
		}
	});

	// Execution is scoped to the approved-plan follow-up turn.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!executionMode) return;
		executionMode = false;
		buildModeGuidancePending = true;
		updateStatus(ctx);
		persistState();
	});

	// Handle plan mode UI once a plan has been proposed.
	pi.on("agent_end", async (event, ctx) => {
		if (!planModeEnabled || !ctx.hasUI) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		const approvedPlan = lastAssistant ? getTextContent(lastAssistant) : "";
		const steps = extractPlanItems(approvedPlan).map((item) => item.text);
		if (steps.length === 0) return;

		const planStepText = steps.map((text, i) => `${i + 1}. ☐ ${text}`).join("\n");
		const planStepMessage = {
			customType: "plan-step-list",
			content: `**Plan Steps (${steps.length}):**\n\n${planStepText}`,
			display: true,
		};

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan (track progress)",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			planModeEnabled = false;
			executionMode = true;
			planningGuidanceInjected = false;
			buildModeGuidancePending = false;
			restoreNormalModeTools();
			updateStatus(ctx);
			persistState();

			const execMessage = `${BUILD_MODE_GUIDANCE}

Execute the user-approved plan below in order. Track progress with your available task-management capabilities and record each step immediately after verification instead of batching updates at the end.

Approved plan:
${approvedPlan}`;
			pi.sendMessage(
				{ content: execMessage, display: false } as Parameters<ExtensionAPI["sendMessage"]>[0],
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendMessage(planStepMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	pi.on("session_compact", () => {
		planningGuidanceInjected = false;
		buildModeGuidancePending = !planModeEnabled;
	});

	pi.on("session_tree", () => {
		planningGuidanceInjected = false;
		buildModeGuidancePending = !planModeEnabled;
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		planningGuidanceInjected = false;
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const planModeEntry = ctx.sessionManager
			.getBranch()
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "plan-mode",
			)
			.pop() as { data?: PlanModeState } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			executionMode = planModeEntry.data.executing ?? executionMode;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}

		buildModeGuidancePending = !planModeEnabled && !executionMode;
		if (planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
	});
}

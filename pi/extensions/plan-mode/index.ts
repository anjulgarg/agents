/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, built-in write tools and the async job tool are disabled.
 *
 * Features:
 * - /plan command or Shift+Tab to toggle plan / auto mode
 * - Bash (and stale job calls) restricted to allowlisted read-only commands
 * - Job tool removed from active tools while planning; restored if it was active
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

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "question"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write", "job"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

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

function isPlanModeContextMessage(message: AgentMessage & { customType?: string }): boolean {
	if (message.customType === "plan-mode-context") return true;
	if (message.role !== "user") return false;
	if (typeof message.content === "string") return message.content.includes("[PLAN MODE ACTIVE]");
	return message.content.some(
		(content) =>
			content.type === "text" && (content as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
	);
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let toolsBeforePlanMode: string[] | undefined;
	let cachedPlanningSkill: { filePath: string; content: string } | undefined;
	let planningSkillWarningShown = false;
	let planningGuidanceInjected = false;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Publish the current mode for the footer (claude-code-ui renders it far-left).
		// Kept as setStatus too so the indicator still shows without a custom footer.
		const mode: AgentMode = planModeEnabled ? "plan" : "auto";
		pi.events.emit(MODE_EVENT, { mode });
		ctx.ui.setStatus(
			"plan-mode",
			planModeEnabled ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined,
		);
	}

	function uniqueToolNames(toolNames: string[]): string[] {
		return [...new Set(toolNames)];
	}

	function getPlanModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		]);
	}

	function getNormalModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...NORMAL_MODE_TOOLS,
			...activeToolNames.filter((name) => !PLAN_MANAGED_TOOLS.has(name)),
		]);
	}

	function enablePlanModeTools(): void {
		const sourceTools = toolsBeforePlanMode ?? pi.getActiveTools() ?? [];
		toolsBeforePlanMode ??= sourceTools;
		pi.setActiveTools(getPlanModeTools(sourceTools));
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
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
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		planningGuidanceInjected = false;

		if (planModeEnabled) {
			enablePlanModeTools();
			ctx.ui.notify("Plan mode enabled. Write and job tools disabled.");
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

	// Block destructive bash/job commands in plan mode (job may still arrive stale/custom)
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || (event.toolName !== "bash" && event.toolName !== "job")) return;

		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Keep only the current activation's guidance while planning; remove it in auto mode.
	pi.on("context", async (event) => {
		const lastPlanContextIndex = event.messages.findLastIndex(
			(message) =>
				(message as AgentMessage & { customType?: string }).customType === "plan-mode-context",
		);
		return {
			messages: event.messages.filter((message, index) => {
				const planMessage = message as AgentMessage & { customType?: string };
				if (planModeEnabled) {
					return planMessage.customType !== "plan-mode-context" || index === lastPlanContextIndex;
				}
				return !isPlanModeContextMessage(planMessage);
			}),
		};
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

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async (event, ctx) => {
		if (planModeEnabled) {
			if (planningGuidanceInjected) return;
			const planningSkill = await loadPlanningSkill(event.systemPromptOptions.skills);
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
				? `Follow the Foreman planning skill below, including its Pi plan mode integration contract. Resolve its relative references from ${planningSkill.skill.baseDir}.

<foreman_plan_skill path=${JSON.stringify(planningSkill.skill.filePath)}>
${planningSkill.content}
</foreman_plan_skill>`
				: `The foreman-plan skill could not be loaded. Use this safe fallback: inspect first, choose a proportional discovery depth, obtain explicit design approval, then separately ask whether to create the implementation plan. Only after both approvals, return a detailed numbered plan under a "Plan:" header. Never implement it.`;

			planningGuidanceInjected = true;
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Built-in edit, write, and job tools are disabled
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
					content: `[EXECUTING PLAN - Full tool access enabled]

Execute the approved plan in order. Track progress with the task-management
capabilities available to you, and record each step immediately after its work is
verified instead of batching progress updates at the end.`,
					display: false,
				},
			};
		}
	});

	// Execution is scoped to the approved-plan follow-up turn.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!executionMode) return;
		executionMode = false;
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
			restoreNormalModeTools();
			updateStatus(ctx);
			persistState();

			const execMessage = `Execute the user-approved plan below in order. Track progress with your available task-management capabilities and record each step immediately after verification instead of batching updates at the end.

Approved plan:
${approvedPlan}`;
			pi.sendMessage(
				{ content: execMessage, display: false },
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
	});

	pi.on("session_tree", () => {
		planningGuidanceInjected = false;
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

		if (planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
	});
}

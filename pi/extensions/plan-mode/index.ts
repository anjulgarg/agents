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

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractPlanItems, isSafeCommand } from "./utils.ts";

/** Emitted on the inter-extension bus so the footer can show the current mode. */
export const MODE_EVENT = "agent-mode:change";
export type AgentMode = "plan" | "auto";

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

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let toolsBeforePlanMode: string[] | undefined;

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

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Built-in edit, write, and job tools are disabled
- Other currently active tools remain available
- Bash is restricted to an allowlist of read-only commands (also enforced for stale job calls)

Ask clarifying questions using the question tool.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
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
		const steps = lastAssistant
			? extractPlanItems(getTextContent(lastAssistant)).map((item) => item.text)
			: [];
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
			restoreNormalModeTools();
			updateStatus(ctx);
			persistState();

			const execMessage = `Execute the user-approved plan below in order. Track progress with your available task-management capabilities and record each step immediately after verification instead of batching updates at the end.

Plan steps:
${steps.map((text, i) => `${i + 1}. ${text}`).join("\n")}`;
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

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
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

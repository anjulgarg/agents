import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type TUI } from "@earendil-works/pi-tui";

import { fullscreenOverlayOptions } from "../lib/tui/index.ts";
import { TeamDashboard } from "./ui.ts";
import { TeamRuntime } from "./runtime.ts";

export function registerTeamLifecycle(pi: ExtensionAPI, runtime: TeamRuntime): void {
	const showDashboard = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("The teams dashboard requires interactive mode.", "warning");
			return;
		}
		let dashboardTui: TUI | undefined;
		await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
			dashboardTui = tui;
			return new TeamDashboard(
				tui,
				theme,
				keybindings,
				() => runtime.allRuns(),
				(listener) => runtime.subscribe(listener),
				done,
				(runId, taskId) => runtime.killDashboardTask(runId, taskId),
				() => [...runtime.teamEntries()].map(([, team]) => team),
				runtime.activeTeam()?.name,
			);
		}, fullscreenOverlayOptions());
		dashboardTui?.invalidate();
		dashboardTui?.requestRender(true);
	};

	for (const [name] of runtime.teamEntries()) {
		pi.registerCommand(`team:${name}`, {
			description: `Start or inspect the ${name} team`,
			handler: async (args, ctx) => {
				runtime.setActiveContext(ctx);
				const goal = args?.trim();
				if (!goal) {
					await showDashboard(ctx);
					return;
				}
				try {
					await runtime.startTeam(name, goal, ctx);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});
	}

	pi.registerCommand("team-cancel", {
		description: "Cancel the active team and all running subagents",
		handler: async (_args, ctx) => {
			await runtime.cancelActiveTeam(ctx);
		},
	});

	pi.registerCommand("teams", {
		description: "Inspect team runs and task progress",
		handler: async (_args, ctx) => {
			runtime.setActiveContext(ctx);
			await showDashboard(ctx);
		},
	});

	pi.on("tool_call", (event) => runtime.reserveDelegation(event));

	pi.on("tool_execution_end", (event) => {
		runtime.reconcileDelegationFailure(event);
	});

	pi.events.on("subagent:update", (data: unknown) => {
		runtime.syncSubagentUpdate(data);
	});

	pi.on("before_agent_start", (event, ctx) => runtime.managerPrompt(event.systemPrompt, ctx));

	pi.on("agent_settled", async (_event, ctx) => {
		await runtime.onAgentSettled(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		runtime.restoreSession(ctx);
	});
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TUI } from "@earendil-works/pi-tui";
import { fullscreenOverlayOptions } from "../lib/tui/index.ts";

import { unbindSubagentControl } from "./control.ts";
import { modelCatalog } from "./models.ts";
import { registerProviderRecovery } from "../lib/provider-recovery.ts";
import { SubagentDashboard } from "./ui.ts";
import { SUBAGENT_MANAGEMENT_TOOLS } from "./tools.ts";
import type { SubagentRuntime } from "./runtime.ts";

export function registerSubagentLifecycle(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	registerProviderRecovery(pi);
	const supervisor = runtime.supervisor;
	let compactionInProgress = false;
	const scheduleParentAbort = (): void => {
		if (compactionInProgress) return;
		// Defer only the real child cleanup. Calling killAll synchronously keeps
		// the abort contract observable while session_before_compact can cancel
		// cleanup when Pi is transitioning into compaction.
		runtime.killParentChildren(true);
	};

	pi.registerShortcut("f6", {
		description: "Open subagent child threads",
		handler: (ctx) => runtime.openThreadView(ctx),
	});

	pi.registerCommand("subagents", {
		description: "Inspect live and completed subagent status",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The subagent dashboard requires interactive mode.", "warning");
				return;
			}
			runtime.hydrateHistorical(ctx);
			let dashboardTui: TUI | undefined;
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				dashboardTui = tui;
				return new SubagentDashboard(
					tui,
					theme,
					() => runtime.allDashboardRuns(),
					(listener) => runtime.subscribeDashboard(listener),
					done,
					(runId, taskId) => {
						runtime.killTaskManually(runId, taskId);
					},
				);
			}, fullscreenOverlayOptions());
			dashboardTui?.invalidate();
			dashboardTui?.requestRender(true);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// A failed/manual compaction can leave no session_compact event. A new
		// parent turn is a safe boundary for clearing that transient guard.
		compactionInProgress = false;
		if (!pi.getActiveTools().includes("subagent")) return;
		let catalog: string;
		try {
			catalog = (await modelCatalog(ctx)) || "none";
		} catch (error) {
			catalog = `none (${error instanceof Error ? error.message : String(error)})`;
		}
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\nAvailable subagent models: ${catalog}. ` +
				"The subagent tool rejects models outside enabledModels.",
		};
	});

	pi.on("agent_settled", () => {
		supervisor.onParentSettled();
	});

	pi.on("agent_start", (_event, ctx) => {
		const signal = ctx.signal;
		if (!signal) return;
		const onAbort = () => scheduleParentAbort();
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; stopReason?: string };
		if (message?.role === "assistant" && message.stopReason === "aborted") {
			scheduleParentAbort();
		}
	});

	pi.on("session_before_compact", (event) => {
		compactionInProgress = true;
		runtime.cancelParentAbort();
		event.signal.addEventListener(
			"abort",
			() => {
				compactionInProgress = false;
			},
			{ once: true },
		);
	});

	pi.on("session_compact", () => {
		compactionInProgress = false;
	});

	pi.on("session_shutdown", () => {
		compactionInProgress = false;
		runtime.cancelParentAbort();
		runtime.clearActivityWidget();
		runtime.setActivityContext(undefined);
		runtime.killParentChildren();
		supervisor.dispose();
		unbindSubagentControl(supervisor);
	});

	pi.on("session_tree", (_event, ctx) => {
		// Branch navigation changes which parent snapshots are visible. Never
		// retain a registry reconstructed from another branch.
		const sessions = runtime.refreshPersistentState(ctx);
		const active = pi
			.getActiveTools()
			.filter(
				(name) =>
					!SUBAGENT_MANAGEMENT_TOOLS.includes(name as (typeof SUBAGENT_MANAGEMENT_TOOLS)[number]),
			);
		const hasManagementState = sessions.length > 0 || runtime.hasActiveBranchRuns(ctx);
		pi.setActiveTools([
			...new Set([...active, "subagent", ...(hasManagementState ? SUBAGENT_MANAGEMENT_TOOLS : [])]),
		]);
	});

	pi.on("session_start", (_event, ctx) => {
		compactionInProgress = false;
		runtime.cancelParentAbort();
		const hasPersistedRuns = runtime.restoreSession(ctx);
		const active = pi
			.getActiveTools()
			.filter(
				(name) =>
					!SUBAGENT_MANAGEMENT_TOOLS.includes(name as (typeof SUBAGENT_MANAGEMENT_TOOLS)[number]),
			);
		pi.setActiveTools([
			...new Set([...active, "subagent", ...(hasPersistedRuns ? SUBAGENT_MANAGEMENT_TOOLS : [])]),
		]);
	});
}

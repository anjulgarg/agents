import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { Model } from "@earendil-works/pi-ai";
import { bindSubagentControl } from "./control.ts";

import { SubagentRuntime, type ProcAccess } from "./runtime.ts";
import { Supervisor, type ChildFactory } from "./supervisor.ts";
import { CHAT_PADDING, registerSubagentTools } from "./tools.ts";
import { registerSubagentLifecycle } from "./lifecycle.ts";
export {
	THINKING_LEVELS,
	WORKSPACE_MODES,
	type Handoff,
	type ResultRef,
	type SubagentDetails,
	type SubagentResultView,
	type SubagentUpdate,
	type ThinkingLevel,
	type UsageStats,
	type WorkspaceMode,
} from "./contracts.ts";
export { getScopedSubagentModels } from "./models.ts";
export { killSubagentRuns } from "./control.ts";
export { SubagentDashboard, SubagentThreadView } from "./ui.ts";
export {
	SubagentRuntime,
	childPid,
	defaultIsAlive,
	defaultReadProcCmdline,
	defaultReadProcEnviron,
	isPiSubagentCmdline,
	sweepOrphanPid,
	type ProcAccess,
} from "./runtime.ts";
export { formatStatusReport, formatStatusSummary, formatTaskWithHandoffs } from "./tools.ts";

const WAKE_MESSAGE_TYPE = "subagent-wake";

export interface SubagentExtensionOptions {
	createSupervisor?: (options: ConstructorParameters<typeof Supervisor>[0]) => Supervisor;
	createChild?: ChildFactory;
	proc?: ProcAccess;
	/** Inject model resolution in tests (skips enabledModels / registry I/O). */
	getModels?: (ctx: ExtensionContext) => Promise<Model<any>[]>;
	/** Disable process-exit handlers in tests (Supervisor still installs its own). */
	watchdogTickMs?: number;
}

export function registerSubagentExtension(
	pi: ExtensionAPI,
	options: SubagentExtensionOptions = {},
): Supervisor {
	pi.registerMessageRenderer(WAKE_MESSAGE_TYPE, (message, _options, theme) => {
		const content =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		return new Text(theme.fg("customMessageText", content), CHAT_PADDING, 0);
	});

	const runtime = new SubagentRuntime({
		pi,
		createSupervisor: options.createSupervisor,
		createChild: options.createChild,
		proc: options.proc,
		watchdogTickMs: options.watchdogTickMs,
	});
	const supervisor = runtime.supervisor;
	bindSubagentControl({
		supervisor,
		sync: () => runtime.syncFromSupervisor(),
		recordManualKill: (runId, taskId) => runtime.recordManualKill(runId, taskId),
	});

	registerSubagentTools(pi, runtime, options);

	registerSubagentLifecycle(pi, runtime);

	return supervisor;
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
	registerSubagentExtension(pi);
}

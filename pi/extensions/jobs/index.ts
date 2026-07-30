import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
	JOB_MANAGEMENT_TOOLS,
	type JobManagerApi,
	type JobManagerOptions,
	type JobWakeDelivery,
	type PersistedJobRecord,
} from "./contracts.ts";
import { JobManager } from "./manager.ts";
import { createJobProcess } from "./process.ts";
import { CHAT_PADDING, registerJobTools, type JobToolOptions } from "./tools.ts";
import { registerJobCommand } from "./command.ts";

export {
	JOB_MANAGEMENT_TOOLS,
	JOB_TOOLS,
	JOB_PREFIX,
	registerJobTools,
	type JobStartDetails,
} from "./tools.ts";

export const JOB_STATE_ENTRY_TYPE = "job-state";
export const JOB_WAKE_MESSAGE_TYPE = "job-wake";

/** Prefix on every wake so the parent treats it as orchestration, not user input. */
export const INTERNAL_WAKE_GUIDANCE =
	"Internal orchestration event from the jobs extension. This is not user input and no user is waiting on a reply to it. " +
	"Do not narrate or acknowledge this event. Inspect job_status or job_result only when a decision needs that detail. " +
	"Do not poll: every further job completion arrives as its own wake.";

export interface JobsExtensionOptions extends JobToolOptions {
	/** Inject a manager in tests; defaults to the real JobManager. */
	createManager?: (options: JobManagerOptions) => JobManagerApi;
}

/** Latest persisted record per job on the active branch (fork-safe). */
export function latestJobRecords(ctx: ExtensionContext): PersistedJobRecord[] {
	const sessionManager = ctx.sessionManager as
		| {
				getEntries?: () => unknown[];
				getBranch?: () => unknown[];
		  }
		| undefined;
	// Prefer getBranch so abandoned fork history does not leak into restore.
	const entries = sessionManager?.getBranch?.() ?? sessionManager?.getEntries?.() ?? [];
	const latest = new Map<string, PersistedJobRecord>();
	for (const entry of entries as Array<{ type?: string; customType?: string; data?: unknown }>) {
		if (entry?.type !== "custom" || entry.customType !== JOB_STATE_ENTRY_TYPE) continue;
		const record = entry.data as PersistedJobRecord | undefined;
		const jobId = record?.snapshot?.jobId;
		if (jobId) latest.set(jobId, record as PersistedJobRecord);
	}
	return [...latest.values()];
}

export function registerJobsExtension(
	pi: ExtensionAPI,
	options: JobsExtensionOptions = {},
): JobManagerApi {
	pi.registerMessageRenderer(JOB_WAKE_MESSAGE_TYPE, (message, _options, theme) => {
		const content =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		return new Text(theme.fg("customMessageText", content), CHAT_PADDING, 0);
	});

	const sendWake = (content: string, deliverAs?: JobWakeDelivery): void => {
		pi.sendMessage(
			{
				customType: JOB_WAKE_MESSAGE_TYPE,
				content: `${INTERNAL_WAKE_GUIDANCE}\n\nEvent:\n${content}`,
				display: false,
			},
			deliverAs ? { triggerTurn: true, deliverAs } : { triggerTurn: true },
		);
	};

	const managerOptions: JobManagerOptions = {
		createProcess: createJobProcess,
		sendWake,
		persist: (record) => {
			pi.appendEntry(JOB_STATE_ENTRY_TYPE, record);
		},
	};
	const manager = options.createManager?.(managerOptions) ?? new JobManager(managerOptions);

	registerJobTools(pi, manager, { isDirectory: options.isDirectory });

	pi.on("session_start", (_event, ctx) => {
		const restored = manager.restore(latestJobRecords(ctx));
		const active = pi
			.getActiveTools()
			.filter(
				(name) => !JOB_MANAGEMENT_TOOLS.includes(name as (typeof JOB_MANAGEMENT_TOOLS)[number]),
			);
		pi.setActiveTools([...new Set([...active, "job", ...(restored ? JOB_MANAGEMENT_TOOLS : [])])]);
	});

	pi.on("before_agent_start", () => {
		manager.setParentSettled(false);
		manager.setWakeSuppressed(false);
	});

	pi.on("agent_settled", () => {
		manager.setParentSettled(true);
		// Failed compaction may skip session_compact and never abort its signal;
		// settling is a safe boundary to release held wakes.
		manager.setWakeSuppressed(false);
	});

	// Wakes delivered mid-compaction would land in a context that is being
	// replaced, so hold them until compaction finishes, aborts, or the agent
	// settles after a failed attempt.
	pi.on("session_before_compact", (event) => {
		manager.setWakeSuppressed(true);
		event.signal?.addEventListener(
			"abort",
			() => {
				manager.setWakeSuppressed(false);
			},
			{ once: true },
		);
	});

	pi.on("session_compact", () => {
		manager.setWakeSuppressed(false);
	});

	pi.on("session_shutdown", async () => {
		await manager.dispose();
	});

	return manager;
}

export default function (pi: ExtensionAPI): void {
	// Only the primary parent owns external jobs; children never start them.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
	const manager = registerJobsExtension(pi);
	registerJobCommand(pi, manager);
}

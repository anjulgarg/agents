import {
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
	BOTTOM_PANEL_SECTION_ORDER,
	getBottomPanel,
	renderSynchronizedShimmerLine,
	SHIMMER_TIMING,
	type BottomPanel,
	type BottomPanelSectionHandle,
} from "../lib/tui/index.ts";
import {
	JOB_MANAGEMENT_TOOLS,
	isTerminalJobStatus,
	type JobManagerApi,
	type JobManagerOptions,
	type JobSnapshot,
	type JobWakeDelivery,
	type PersistedJobRecord,
} from "./contracts.ts";
import { JobManager } from "./manager.ts";
import { createJobProcess } from "./process.ts";
import {
	CHAT_PADDING,
	JobReceiptLine,
	jobReceiptSegments,
	registerJobTools,
	type JobToolOptions,
} from "./tools.ts";
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

const ASYNC_ACTIVITY_SECTION = "async-commands";
const ASYNC_ACTIVITY_MAX_LINES = 3;
/** Derived from the shared contract so job and tool shimmer cannot drift. */
export const ASYNC_ACTIVITY_REFRESH_MS = SHIMMER_TIMING.frameIntervalMs;

function shimmerTheme(theme: Theme) {
	return {
		fg: (name: string, text: string) => theme.fg(name as Parameters<Theme["fg"]>[0], text),
		bold: (text: string) => theme.bold(text),
	};
}

function renderAsyncActivityLine(job: JobSnapshot, width: number, theme: Theme): string {
	const line =
		new JobReceiptLine(
			theme,
			jobReceiptSegments({ ...job, label: "" }, { includeStatus: job.status !== "running" }),
		).render(width)[0] ?? "";
	if (job.status !== "running") return line;
	const amplitude = Math.max(
		0,
		Math.min(1, (job.durationMs - SHIMMER_TIMING.delayMs) / SHIMMER_TIMING.fadeInMs),
	);
	return renderSynchronizedShimmerLine(line, width, shimmerTheme(theme), Date.now(), amplitude);
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
	let activityPanel: BottomPanel | undefined;
	let activitySection: BottomPanelSectionHandle | undefined;

	const clearActivityPanel = (): void => {
		activitySection?.remove();
		activitySection = undefined;
		activityPanel = undefined;
	};

	const activeJobs = (): JobSnapshot[] => {
		try {
			return manager.status().filter((job) => !isTerminalJobStatus(job.status));
		} catch {
			return [];
		}
	};

	const syncActivityPanel = (): void => {
		const panel = activityPanel;
		if (!panel) return;
		const jobs = activeJobs();
		if (jobs.length === 0) {
			activitySection?.remove();
			activitySection = undefined;
			return;
		}
		const refreshIntervalMs = jobs.some((job) => job.status === "running")
			? ASYNC_ACTIVITY_REFRESH_MS
			: undefined;
		if (!activitySection) {
			activitySection = panel.registerSection(ASYNC_ACTIVITY_SECTION, {
				order: BOTTOM_PANEL_SECTION_ORDER.asyncCommands,
				maxLines: ASYNC_ACTIVITY_MAX_LINES,
				refreshIntervalMs,
				render: (width, theme) =>
					activeJobs().map((job) => renderAsyncActivityLine(job, width, theme)),
				overflowLabel: (omitted, theme) => theme.fg("muted", `+ ${omitted} more async commands`),
			});
			return;
		}
		activitySection.update({ refreshIntervalMs: refreshIntervalMs ?? null });
	};

	const useActivityContext = (ctx: ExtensionContext): void => {
		const nextPanel = ctx.mode === "tui" ? getBottomPanel(ctx) : undefined;
		if (nextPanel !== activityPanel) {
			clearActivityPanel();
			activityPanel = nextPanel;
		}
		syncActivityPanel();
	};

	const toolCleanup = registerJobTools(pi, manager, {
		isDirectory: options.isDirectory,
		onJobStarted: (job) => {
			options.onJobStarted?.(job);
			syncActivityPanel();
		},
	});
	const unsubscribeManager = manager.subscribe?.(syncActivityPanel);

	pi.on("session_start", (_event, ctx) => {
		clearActivityPanel();
		useActivityContext(ctx);
		const restored = manager.restore(latestJobRecords(ctx));
		syncActivityPanel();
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

	pi.on("session_tree", (_event, ctx) => {
		clearActivityPanel();
		useActivityContext(ctx);
	});

	pi.on("session_shutdown", async () => {
		clearActivityPanel();
		toolCleanup();
		unsubscribeManager?.();
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

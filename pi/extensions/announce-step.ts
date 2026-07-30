import {
	estimateTokens,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const WORKING_FRAME_INTERVAL_MS = 120;
export const ANNOUNCEMENT_GUIDANCE =
	"Use announce_step before each meaningful work slice. Include a brief user-facing " +
	"message of one or two short sentences explaining what you are doing and what you " +
	"plan to do next. The message is rendered in the chat, so do not repeat it as " +
	"separate assistant text. Keep announce_step aligned with the current meaningful " +
	"activity. Update it whenever the immediate objective, approach, or planned task " +
	"materially changes. Group consecutive actions serving the same objective and " +
	"approach; do not repeat an unchanged announcement.";
const ANNOUNCEMENT_ENTRY_TYPE = "announce-step-duration";
const ANNOUNCEMENT_UPDATE_ENTRY_TYPE = "announce-step-duration-update";
const CHAT_PADDING = 1;

interface TokenCounters {
	receivedTokens: number;
	currentReceivedEstimate: number;
}

interface PhaseActivity {
	toolCount: number;
	changedFiles: Set<string>;
}

interface ActiveRun extends TokenCounters, PhaseActivity {
	summaryStep: string;
	currentStep: string;
	startedAt: number;
	entry: AnnouncementEntry;
}

interface AnnouncementEntry {
	runId: string;
	step: string;
	durationMs: number;
	completed?: boolean;
	receivedTokens?: number;
	toolCount?: number;
	changedFiles?: string[];
}

function normalizeStep(step: string): string {
	return step.trim();
}

function displayStep(step: string): string {
	return `${step.replace(/[.!?…]+$/, "")}...`;
}

function formatDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds}s`;
}

function formatTokenCount(tokens: number): string {
	const rounded = Math.max(0, Math.round(tokens));
	if (rounded < 1000) return String(rounded);
	if (rounded < 10_000) return `${(rounded / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${Math.round(rounded / 1000)}k`;
}

function formatLiveSlice(
	step: string,
	durationMs: number,
	receivedTokens?: number,
	activity?: Omit<AnnouncementEntry, "runId" | "step" | "durationMs" | "receivedTokens">,
): string {
	const details = [formatDuration(durationMs)];
	if (activity?.toolCount) {
		details.push(`${activity.toolCount} ${activity.toolCount === 1 ? "tool" : "tools"}`);
	}
	if (activity?.changedFiles?.length) {
		details.push(
			`${activity.changedFiles.length} ${activity.changedFiles.length === 1 ? "file" : "files"}`,
		);
	}
	if (receivedTokens !== undefined && receivedTokens > 0) {
		details.push(`↓ ${formatTokenCount(receivedTokens)} tokens`);
	}
	return `${displayStep(step)} (${details.join(" · ")})`;
}

export function formatSlice(
	step: string,
	durationMs: number,
	receivedTokens?: number,
	activity?: Omit<AnnouncementEntry, "runId" | "step" | "durationMs" | "receivedTokens">,
): string {
	return formatLiveSlice(step, durationMs, receivedTokens, activity);
}

function createTokenCounters(): TokenCounters {
	return {
		receivedTokens: 0,
		currentReceivedEstimate: 0,
	};
}

function createPhaseActivity(): PhaseActivity {
	return {
		toolCount: 0,
		changedFiles: new Set(),
	};
}

function tokenTotal(counters: TokenCounters): number {
	return counters.receivedTokens + counters.currentReceivedEstimate;
}

export default function announceStepExtension(pi: ExtensionAPI) {
	let activeRun: ActiveRun | undefined;
	let runStartedAt: number | undefined;
	let sliceTimer: ReturnType<typeof setInterval> | undefined;
	let workingContext: ExtensionContext | undefined;
	let fallbackCounters = createTokenCounters();

	const currentCounters = (): TokenCounters => activeRun ?? fallbackCounters;

	const updateWorkingLine = (now = Date.now()): void => {
		if (!workingContext) return;
		const step = activeRun?.currentStep ?? "Working";
		const startedAt = activeRun?.startedAt ?? runStartedAt ?? now;
		const receivedTokens = runStartedAt === undefined ? undefined : tokenTotal(currentCounters());
		const activity = activeRun ? { toolCount: activeRun.toolCount } : undefined;
		const liveMessage = formatLiveSlice(step, now - startedAt, receivedTokens, activity);
		const message = workingContext.ui.theme?.fg("toolTitle", liveMessage) ?? liveMessage;
		if (workingContext.mode === "tui") workingContext.ui.setWorkingMessage(message);
		else if (workingContext.mode === "rpc") workingContext.ui.setStatus("working", message);
	};

	const stopSliceTimer = (): void => {
		if (sliceTimer) clearInterval(sliceTimer);
		sliceTimer = undefined;
	};

	const startSliceTimer = (): void => {
		if ((workingContext?.mode === "tui" || workingContext?.mode === "rpc") && !sliceTimer) {
			sliceTimer = setInterval(() => updateWorkingLine(), 1000);
		}
	};

	const completeActiveRun = (completedAt = Date.now()): void => {
		if (!activeRun) return;
		const completed = activeRun;
		activeRun = undefined;
		Object.assign(completed.entry, {
			completed: true,
			durationMs: Math.max(0, completedAt - completed.startedAt),
			receivedTokens: tokenTotal(completed),
			toolCount: completed.toolCount,
			changedFiles: [...completed.changedFiles],
		});
		pi.appendEntry<AnnouncementEntry>(ANNOUNCEMENT_UPDATE_ENTRY_TYPE, { ...completed.entry });
	};

	pi.registerEntryRenderer<AnnouncementEntry>(ANNOUNCEMENT_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data || typeof data.step !== "string" || typeof data.durationMs !== "number")
			return undefined;
		return {
			render(width: number): string[] {
				if (data.completed === false) return [];
				const receivedTokens =
					typeof data.receivedTokens === "number" ? data.receivedTokens : undefined;
				return new Text(
					theme.fg("muted", formatSlice(data.step, data.durationMs, receivedTokens, data)),
					CHAT_PADDING,
					0,
				).render(width);
			},
			invalidate() {},
		};
	});
	pi.registerEntryRenderer<AnnouncementEntry>(
		ANNOUNCEMENT_UPDATE_ENTRY_TYPE,
		() => new Container(),
	);

	pi.on("tool_execution_start", (event) => {
		if (!activeRun || event.toolName === "announce_step") return;
		activeRun.toolCount++;
		if (
			(event.toolName === "edit" || event.toolName === "write") &&
			typeof event.args?.path === "string"
		) {
			activeRun.changedFiles.add(event.args.path);
		}
		updateWorkingLine();
	});

	pi.on("before_provider_request", () => {
		if (runStartedAt === undefined) return;
		currentCounters().currentReceivedEstimate = 0;
		updateWorkingLine();
	});

	pi.on("agent_start", (_event, ctx) => {
		workingContext = ctx;
		if (runStartedAt === undefined) {
			runStartedAt = Date.now();
			fallbackCounters = createTokenCounters();
		}
		updateWorkingLine();
		startSliceTimer();
	});

	pi.on("message_update", (event) => {
		if (runStartedAt === undefined || event.message.role !== "assistant") return;
		const counters = currentCounters();
		counters.currentReceivedEstimate = Math.max(
			counters.currentReceivedEstimate,
			event.message.usage.output || estimateTokens(event.message),
		);
	});

	pi.on("message_end", (event) => {
		if (runStartedAt === undefined || event.message.role !== "assistant") return;
		const counters = currentCounters();
		const usage = event.message.usage;
		counters.receivedTokens +=
			usage.output || Math.max(counters.currentReceivedEstimate, estimateTokens(event.message));
		counters.currentReceivedEstimate = 0;
		updateWorkingLine();
	});

	pi.on("agent_settled", () => {
		completeActiveRun();
		stopSliceTimer();
		runStartedAt = undefined;
		fallbackCounters = createTokenCounters();
		if (workingContext?.mode === "rpc") workingContext.ui.setStatus("working", undefined);
		if (workingContext?.mode === "tui") workingContext.ui.setWorkingMessage();
		workingContext = undefined;
	});

	pi.registerTool({
		name: "announce_step",
		label: "Announce Step",
		description: "Set the live announcement for the current meaningful activity.",
		promptGuidelines: [ANNOUNCEMENT_GUIDANCE],
		parameters: Type.Object({
			step: Type.String({ description: "Specific 3-5-word current activity title" }),
			message: Type.Optional(
				Type.String({
					description: "One or two short sentences explaining the current work and next action",
					minLength: 1,
				}),
			),
		}),
		renderShell: "self",
		async execute(toolCallId, { step }, _signal, _onUpdate, ctx) {
			const announcement = normalizeStep(step);
			if (!announcement) throw new Error("Step announcement cannot be empty");
			const now = Date.now();
			workingContext = ctx;
			runStartedAt ??= now;
			if (activeRun) {
				activeRun.currentStep = announcement;
			} else {
				const entry: AnnouncementEntry = {
					runId: toolCallId,
					step: announcement,
					durationMs: Math.max(0, now - runStartedAt),
					completed: false,
				};
				pi.appendEntry<AnnouncementEntry>(ANNOUNCEMENT_ENTRY_TYPE, entry);
				activeRun = {
					summaryStep: announcement,
					currentStep: announcement,
					startedAt: runStartedAt,
					entry,
					...createTokenCounters(),
					...createPhaseActivity(),
				};
			}
			updateWorkingLine(now);
			startSliceTimer();
			return {
				content: [{ type: "text", text: "Step announced." }],
				details: { step: announcement },
			};
		},
		renderCall(args, theme, context) {
			const message = args.message?.trim();
			if (message) return new Text(theme.fg("text", message), CHAT_PADDING, 0);
			if (!context.isError) return new Container();
			return new Text(
				theme.fg("toolTitle", theme.bold("announce step ")) + theme.fg("muted", args.step ?? ""),
				CHAT_PADDING,
				0,
			);
		},
		renderResult(result, _options, theme, context) {
			if (!context.isError) return new Container();
			const message =
				result.content.find((part) => part.type === "text")?.text ?? "Step announcement failed";
			return new Text(theme.fg("error", message), 1, 0);
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!pi.getActiveTools().includes("announce_step")) return;
		if (event.systemPrompt.includes(ANNOUNCEMENT_GUIDANCE)) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${ANNOUNCEMENT_GUIDANCE}`,
		};
	});

	pi.on("session_start", (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const updates = new Map<string, AnnouncementEntry>();
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== ANNOUNCEMENT_UPDATE_ENTRY_TYPE) continue;
			const data = entry.data as AnnouncementEntry | undefined;
			if (data?.runId) updates.set(data.runId, data);
		}
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== ANNOUNCEMENT_ENTRY_TYPE) continue;
			const data = entry.data as AnnouncementEntry | undefined;
			const update = data?.runId ? updates.get(data.runId) : undefined;
			if (data && update) Object.assign(data, update);
		}

		const activeTools = pi.getActiveTools();
		if (!activeTools.includes("announce_step")) {
			pi.setActiveTools([...activeTools, "announce_step"]);
		}
	});

	pi.on("session_shutdown", () => {
		stopSliceTimer();
		activeRun = undefined;
		runStartedAt = undefined;
		fallbackCounters = createTokenCounters();
		workingContext = undefined;
	});
}

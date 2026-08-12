import announceStep, {
	ACTIVITY_ENTRY_TYPE,
	WORKING_FRAME_ADVANCE,
	WORKING_FRAME_INTERVAL_MS,
	WORKING_PHASE,
	formatSlice,
} from "../announce-step.ts";
import { getProcessAnimationDiagnostics } from "../lib/animation-coordinator.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

type Handler = (event: any, context: any) => unknown;

interface Harness {
	handlers: Map<string, Handler>;
	renderers: Map<string, (entry: any, options: any, theme: any) => any>;
	appended: Array<{ type: string; data: any }>;
	registerToolCalls: number;
	activeToolReads: number;
	emit(event: string, payload?: any, context?: any): unknown;
}

function createContext(mode: "tui" | "rpc" | "print" | "json", entries: unknown[] = []) {
	const workingMessages: Array<string | undefined> = [];
	const workingIndicators: Array<{ frames?: string[]; intervalMs?: number } | undefined> = [];
	const statusCalls: Array<{ key: string; text: string | undefined }> = [];
	const context = {
		mode,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setWorkingMessage: (message?: string) => workingMessages.push(message),
			setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
			setWorkingVisible: () => undefined,
			setWorkingIndicator: (indicator?: { frames?: string[]; intervalMs?: number }) =>
				workingIndicators.push(indicator),
		},
		sessionManager: { getEntries: () => entries },
	};
	return { context, workingMessages, workingIndicators, statusCalls };
}

function createHarness(): Harness {
	const handlers = new Map<string, Handler>();
	const renderers = new Map<string, (entry: any, options: any, theme: any) => any>();
	const appended: Array<{ type: string; data: any }> = [];
	const state = { registerToolCalls: 0, activeToolReads: 0 };
	const pi = {
		registerEntryRenderer: (
			type: string,
			renderer: (entry: any, options: any, theme: any) => any,
		) => renderers.set(type, renderer),
		registerTool: () => {
			state.registerToolCalls++;
		},
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		appendEntry: (type: string, data: any) => appended.push({ type, data }),
		getActiveTools: () => {
			state.activeToolReads++;
			return [];
		},
		setActiveTools: () => undefined,
	};
	announceStep(pi as any);
	return {
		handlers,
		renderers,
		appended,
		get registerToolCalls() {
			return state.registerToolCalls;
		},
		get activeToolReads() {
			return state.activeToolReads;
		},
		emit(event, payload = {}, context = undefined) {
			return handlers.get(event)?.(payload, context);
		},
	};
}

const realDateNow = Date.now;
let now = 10_000;
Date.now = () => now;

const harness = createHarness();
const fixtureEntries = [
	{
		type: "custom",
		customType: "announce-step-duration",
		data: { runId: "legacy-run", step: "Legacy work", durationMs: 100, completed: false },
	},
	{
		type: "custom",
		customType: "announce-step-duration-update",
		data: {
			runId: "legacy-run",
			durationMs: 700,
			completed: true,
			receivedTokens: 42,
			toolCount: 2,
			changedFiles: ["src/legacy.ts"],
		},
	},
];
const tui = createContext("tui", fixtureEntries);

harness.emit("session_start", { type: "session_start", reason: "resume" }, tui.context);
assert(
	"passive registration has no model tool or prompt hook",
	harness.registerToolCalls === 0 &&
		harness.activeToolReads === 0 &&
		!harness.handlers.has("before_agent_start") &&
		WORKING_PHASE === "Working" &&
		!harness.handlers.has("promptGuidelines"),
	JSON.stringify({
		handlers: [...harness.handlers.keys()],
		registerToolCalls: harness.registerToolCalls,
	}),
);
assert(
	"legacy announcement entries reconstruct after resume",
	fixtureEntries[0].data.completed === true &&
		harness.renderers.has("announce-step-duration") &&
		harness.renderers.has("announce-step-duration-update"),
	JSON.stringify(fixtureEntries),
);

const theme = { fg: (_color: string, text: string) => text };
const legacyRendered = harness.renderers
	.get("announce-step-duration")?.({ data: fixtureEntries[0].data }, {}, theme)
	.render(80) as string[];
assert(
	"legacy announcement entries retain their chat rendering",
	legacyRendered.join("\n").includes("Legacy work") &&
		legacyRendered[0]?.startsWith(" Legacy work"),
	JSON.stringify(legacyRendered),
);

harness.emit("agent_start", { type: "agent_start" }, tui.context);
assert(
	"live status always uses Working",
	tui.workingMessages.at(-1)?.startsWith("Working...") === true,
	JSON.stringify(tui.workingMessages),
);
const workingAnimation = getProcessAnimationDiagnostics();
assert(
	"Working joins the coordinator with two-phase advancement and no private loader clock",
	WORKING_FRAME_INTERVAL_MS === 200 &&
		WORKING_FRAME_ADVANCE === 2 &&
		tui.workingIndicators.at(-1)?.frames?.length === 1 &&
		workingAnimation.subscriptionCount === 1 &&
		workingAnimation.timerIntervalMs === 200,
	JSON.stringify({ indicators: tui.workingIndicators, workingAnimation }),
);
now += 1_234;
harness.emit(
	"tool_execution_start",
	{
		type: "tool_execution_start",
		toolCallId: "read-1",
		toolName: "read",
		args: { path: "src/example.ts" },
	},
	tui.context,
);
harness.emit(
	"tool_execution_end",
	{
		type: "tool_execution_end",
		toolCallId: "read-1",
		toolName: "read",
		result: {},
		isError: false,
	},
	tui.context,
);
harness.emit(
	"message_end",
	{
		type: "message_end",
		message: { role: "assistant", stopReason: "toolUse", usage: { output: 0 } },
	},
	tui.context,
);
assert(
	"tool-use assistant messages do not append the final receipt early",
	harness.appended.length === 0,
	JSON.stringify(harness.appended),
);
harness.emit(
	"tool_execution_start",
	{
		type: "tool_execution_start",
		toolCallId: "grep-1",
		toolName: "grep",
		args: { pattern: "needle", path: "src" },
	},
	tui.context,
);
harness.emit(
	"tool_execution_start",
	{
		type: "tool_execution_start",
		toolCallId: "edit-1",
		toolName: "edit",
		args: { path: "src/example.ts" },
	},
	tui.context,
);
harness.emit(
	"tool_execution_start",
	{
		type: "tool_execution_start",
		toolCallId: "write-1",
		toolName: "write",
		args: { path: "src/other.ts" },
	},
	tui.context,
);
assert(
	"tool lifecycle keeps Working and tracks deduplicated counts",
	tui.workingMessages.every(
		(message) => message === undefined || message.startsWith("Working..."),
	) &&
		tui.workingMessages.at(-1)?.includes("4 tools") === true &&
		tui.workingMessages.at(-1)?.includes("2 files") === true,
	JSON.stringify(tui.workingMessages),
);

harness.emit(
	"message_update",
	{
		type: "message_update",
		message: { role: "assistant", usage: { output: 88 } },
	},
	tui.context,
);
now += 2_000;
harness.emit(
	"tool_execution_end",
	{
		type: "tool_execution_end",
		toolCallId: "grep-1",
		toolName: "grep",
		result: {},
		isError: false,
	},
	tui.context,
);
harness.emit(
	"tool_execution_end",
	{
		type: "tool_execution_end",
		toolCallId: "edit-1",
		toolName: "edit",
		result: {},
		isError: false,
	},
	tui.context,
);
harness.emit(
	"tool_execution_end",
	{
		type: "tool_execution_end",
		toolCallId: "write-1",
		toolName: "write",
		result: {},
		isError: false,
	},
	tui.context,
);
assert(
	"Working remains after the final tool completes",
	tui.workingMessages.at(-1)?.startsWith("Working...") === true,
	JSON.stringify(tui.workingMessages),
);
harness.emit(
	"message_end",
	{
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", usage: { output: 88 } },
	},
	tui.context,
);

const completedActivity = harness.appended.at(-1);
assert(
	"final assistant completion appends the ordered receipt before settlement",
	completedActivity?.type === ACTIVITY_ENTRY_TYPE &&
		completedActivity.data.phase === WORKING_PHASE &&
		completedActivity.data.durationMs === 3_234 &&
		completedActivity.data.receivedTokens === 88 &&
		completedActivity.data.toolCount === 4 &&
		completedActivity.data.changedFiles.length === 2 &&
		completedActivity.data.status === "completed",
	JSON.stringify({ completedActivity, workingMessages: tui.workingMessages }),
);
const activityColors: string[] = [];
const activityTheme = {
	fg: (color: string, text: string) => {
		activityColors.push(color);
		return text;
	},
};
const activityRendered = harness.renderers
	.get(ACTIVITY_ENTRY_TYPE)?.({ data: completedActivity?.data }, {}, activityTheme)
	.render(100) as string[];
assert(
	"completed activity receipt renders muted without failure details",
	activityRendered.join("\n").includes("Working") &&
		activityRendered.join("\n").includes("4 tools") &&
		!activityRendered.join("\n").includes("failed") &&
		activityColors.includes("muted") &&
		!activityColors.includes("error") &&
		!harness.handlers.has("context"),
	JSON.stringify({ activityRendered, activityColors, handlers: [...harness.handlers.keys()] }),
);
const historicalFailureRendered = harness.renderers
	.get(ACTIVITY_ENTRY_TYPE)?.(
		{ data: { ...completedActivity?.data, status: "failed" } },
		{},
		activityTheme,
	)
	.render(100) as string[];
assert(
	"historical failed receipts also omit failure text and error color",
	!historicalFailureRendered.join("\n").includes("failed") && !activityColors.includes("error"),
	JSON.stringify({ historicalFailureRendered, activityColors }),
);
const historicalPhaseRendered = harness.renderers
	.get(ACTIVITY_ENTRY_TYPE)?.(
		{ data: { ...completedActivity?.data, phase: "Editing" } },
		{},
		activityTheme,
	)
	.render(100) as string[];
assert(
	"historical phase labels normalize to Working",
	historicalPhaseRendered.join("\n").includes("Working...") &&
		!historicalPhaseRendered.join("\n").includes("Editing"),
	JSON.stringify(historicalPhaseRendered),
);
harness.emit("agent_settled", { type: "agent_settled" }, tui.context);
assert(
	"settlement clears live activity without appending a trailing duplicate",
	harness.appended.length === 1 &&
		tui.workingMessages.at(-1) === undefined &&
		getProcessAnimationDiagnostics().subscriptionCount === 0,
	JSON.stringify({
		appended: harness.appended,
		workingMessages: tui.workingMessages,
		animation: getProcessAnimationDiagnostics(),
	}),
);

const noToolHarness = createHarness();
const noToolContext = createContext("tui");
noToolHarness.emit("agent_start", { type: "agent_start" }, noToolContext.context);
noToolHarness.emit(
	"message_end",
	{
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", usage: { output: 429 } },
	},
	noToolContext.context,
);
const noToolActivity = noToolHarness.appended.at(-1);
const noToolRendered = noToolHarness.renderers
	.get(ACTIVITY_ENTRY_TYPE)?.({ data: noToolActivity?.data }, {}, theme)
	.render(100) as string[];
assert(
	"tool-free history receipts use Working",
	noToolActivity?.data.phase === WORKING_PHASE &&
		noToolActivity.data.toolCount === 0 &&
		noToolRendered.join("\n").includes("Working..."),
	JSON.stringify({ noToolActivity, noToolRendered }),
);
noToolHarness.emit("agent_settled", { type: "agent_settled" }, noToolContext.context);

assert(
	"formatSlice keeps compact tool counts",
	formatSlice(WORKING_PHASE, 1_500, 0, {
		toolCount: 1,
		changedFiles: [],
	}).includes("1 tool"),
	formatSlice(WORKING_PHASE, 1_500, 0, { toolCount: 1, changedFiles: [] }),
);

const failureHarness = createHarness();
const failureContext = createContext("tui");
failureHarness.emit("agent_start", { type: "agent_start" }, failureContext.context);
failureHarness.emit(
	"tool_execution_start",
	{
		type: "tool_execution_start",
		toolCallId: "failed-check",
		toolName: "bash",
		args: { command: "npm test" },
	},
	failureContext.context,
);
failureHarness.emit(
	"tool_execution_end",
	{
		type: "tool_execution_end",
		toolCallId: "failed-check",
		toolName: "bash",
		result: { content: [{ type: "text", text: "failed" }] },
		isError: true,
	},
	failureContext.context,
);
assert(
	"tool failures do not appear in the live status",
	failureContext.workingMessages.at(-1)?.startsWith("Working...") === true &&
		failureContext.workingMessages.at(-1)?.includes("failed") !== true,
	JSON.stringify(failureContext.workingMessages),
);
failureHarness.emit("agent_settled", { type: "agent_settled" }, failureContext.context);
assert(
	"failed activity settles without a trailing receipt",
	failureHarness.appended.length === 0 &&
		failureHarness.handlers.get("agent_settled") !== undefined,
	JSON.stringify(failureHarness.appended),
);

failureHarness.emit("agent_start", { type: "agent_start" }, failureContext.context);
failureHarness.emit(
	"tool_execution_start",
	{
		type: "tool_execution_start",
		toolCallId: "aborted-run",
		toolName: "read",
		args: { path: "src/abort.ts" },
	},
	failureContext.context,
);
failureHarness.emit(
	"agent_end",
	{
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				stopReason: "aborted",
				usage: { output: 0 },
			},
		],
	},
	failureContext.context,
);
assert(
	"abort state does not appear in the live status",
	failureContext.workingMessages.at(-1)?.includes("aborted") !== true,
	JSON.stringify(failureContext.workingMessages),
);
failureHarness.emit("agent_settled", { type: "agent_settled" }, failureContext.context);
assert(
	"abort settlement clears the coordinator-owned working message",
	failureHarness.appended.length === 0 && failureContext.workingMessages.at(-1) === undefined,
	JSON.stringify({ appended: failureHarness.appended, working: failureContext.workingMessages }),
);

const rpcHarness = createHarness();
const rpc = createContext("rpc");
rpcHarness.emit("agent_start", { type: "agent_start" }, rpc.context);
rpcHarness.emit(
	"tool_execution_start",
	{
		type: "tool_execution_start",
		toolCallId: "rpc-build",
		toolName: "bash",
		args: { command: "npm run build" },
	},
	rpc.context,
);
assert(
	"RPC mode uses status updates",
	rpc.statusCalls.some(({ key, text }) => key === "working" && text?.startsWith("Working...")),
	JSON.stringify(rpc.statusCalls),
);
rpcHarness.emit("agent_settled", { type: "agent_settled" }, rpc.context);
assert(
	"RPC settlement clears only the activity status",
	rpc.statusCalls.at(-1)?.key === "working" && rpc.statusCalls.at(-1)?.text === undefined,
	JSON.stringify(rpc.statusCalls),
);

const printHarness = createHarness();
const print = createContext("print");
printHarness.emit("agent_start", { type: "agent_start" }, print.context);
printHarness.emit(
	"tool_execution_start",
	{
		type: "tool_execution_start",
		toolCallId: "print-read",
		toolName: "read",
		args: { path: "src/print.ts" },
	},
	print.context,
);
printHarness.emit(
	"message_end",
	{
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", usage: { output: 12 } },
	},
	print.context,
);
printHarness.emit("agent_settled", { type: "agent_settled" }, print.context);
assert(
	"print mode avoids UI operations while retaining one ordered receipt",
	print.workingMessages.length === 0 &&
		print.statusCalls.length === 0 &&
		printHarness.appended.length === 1 &&
		printHarness.appended[0]?.type === ACTIVITY_ENTRY_TYPE &&
		printHarness.appended[0]?.data.phase === WORKING_PHASE,
	JSON.stringify({
		working: print.workingMessages,
		status: print.statusCalls,
		appended: printHarness.appended,
	}),
);

Date.now = realDateNow;
console.log("All announce-step passive activity tests passed.");

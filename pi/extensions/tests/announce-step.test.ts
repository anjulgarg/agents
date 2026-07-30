import announceStep, { ANNOUNCEMENT_GUIDANCE, formatSlice } from "../announce-step.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

assert(
	"completed announcement omits a prefix",
	formatSlice("Verify output", 22_000, 698).startsWith("Verify output..."),
	formatSlice("Verify output", 22_000, 698),
);

const entryRenderers = new Map<string, (entry: any, options: any, theme: any) => any>();
let registeredTool: any;
const handlers = new Map<string, (event: any, context?: any) => any>();
const appendedEntries: Array<{ type: string; data: any }> = [];
const pi = new Proxy(
	{
		registerEntryRenderer: (
			type: string,
			renderer: (entry: any, options: any, theme: any) => any,
		) => {
			entryRenderers.set(type, renderer);
		},
		registerTool: (tool: any) => {
			registeredTool = tool;
		},
		on: (event: string, handler: (event: any, context?: any) => void) => {
			handlers.set(event, handler);
		},
		appendEntry: (type: string, data: any) => appendedEntries.push({ type, data }),
		getActiveTools: () => ["announce_step"],
	},
	{
		get(target, property) {
			return property in target ? target[property as keyof typeof target] : () => undefined;
		},
	},
);
announceStep(pi as any);
const promptUpdate = handlers.get("before_agent_start")?.({ systemPrompt: "base" });
const duplicatePromptUpdate = handlers.get("before_agent_start")?.({
	systemPrompt: `base\n\n${ANNOUNCEMENT_GUIDANCE}`,
});
assert(
	"announcement guidance tracks meaningful activity without tool coupling",
	registeredTool.description === "Set the live announcement for the current meaningful activity." &&
		registeredTool.promptGuidelines.length === 1 &&
		registeredTool.promptGuidelines[0] === ANNOUNCEMENT_GUIDANCE &&
		promptUpdate?.systemPrompt === `base\n\n${ANNOUNCEMENT_GUIDANCE}` &&
		ANNOUNCEMENT_GUIDANCE.includes("before each meaningful work slice") &&
		ANNOUNCEMENT_GUIDANCE.includes("one or two short sentences") &&
		ANNOUNCEMENT_GUIDANCE.includes("objective, approach, or planned task") &&
		registeredTool.parameters.properties.message.minLength === 1 &&
		!registeredTool.parameters.required.includes("message") &&
		!ANNOUNCEMENT_GUIDANCE.includes("work phase") &&
		!ANNOUNCEMENT_GUIDANCE.includes("skip unchanged phases"),
	JSON.stringify({
		description: registeredTool.description,
		guidance: registeredTool.promptGuidelines,
		promptUpdate,
	}),
);
assert(
	"announcement guidance is not appended when already present",
	duplicatePromptUpdate === undefined,
	JSON.stringify({ duplicatePromptUpdate }),
);
const rendererTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};
const progressMessage = "I found the source. Next I’ll add coverage.";
const renderedMessage = registeredTool
	.renderCall({ step: "Add progress notes", message: progressMessage }, rendererTheme, {
		expanded: false,
		isError: false,
	})
	.render(80)
	.join("\n");
assert(
	"announcement messages render persistently at the tool call position",
	renderedMessage.includes(progressMessage),
	JSON.stringify({ renderedMessage }),
);
const compatibleCall = registeredTool
	.renderCall({ step: "Add progress notes" }, rendererTheme, { expanded: false, isError: false })
	.render(80)
	.join("\n");
assert(
	"legacy announcement calls remain valid without duplicate-message retries",
	compatibleCall === "" && !registeredTool.parameters.required.includes("message"),
	JSON.stringify({ compatibleCall, required: registeredTool.parameters.required }),
);
const hiddenSuccess = registeredTool
	.renderResult(
		{ content: [{ type: "text", text: "Step announced." }] },
		{ expanded: true, isPartial: false },
		rendererTheme,
		{ expanded: true, isError: false },
	)
	.render(80)
	.join("\n");
const visibleFailure = registeredTool
	.renderResult(
		{ content: [{ type: "text", text: "Step announcement failed" }] },
		{ expanded: false, isPartial: false },
		rendererTheme,
		{ expanded: false, isError: true },
	)
	.render(80)
	.join("\n");
assert(
	"announcement tool stays aggregated on success but exposes failures",
	hiddenSuccess === "" && visibleFailure.includes("Step announcement failed"),
	JSON.stringify({ hiddenSuccess, visibleFailure }),
);
const rendered = entryRenderers
	.get("announce-step-duration")?.(
		{ data: { step: "Verify output", durationMs: 22_000, receivedTokens: 698 } },
		{},
		{ fg: (_color: string, text: string) => text },
	)
	.render(80) as string[];
assert(
	"completed announcement uses chat padding",
	rendered[0].startsWith(" Verify output..."),
	JSON.stringify(rendered),
);

let workingMessage: string | undefined = "";
const workingVisibilityCalls: boolean[] = [];
const context = {
	mode: "tui",
	ui: {
		setStatus: () => undefined,
		setWorkingMessage: (message?: string) => {
			workingMessage = message;
		},
		setWorkingVisible: (visible: boolean) => {
			workingVisibilityCalls.push(visible);
		},
	},
};
void registeredTool.execute(
	"announce-1",
	{ step: "Implement summaries" },
	undefined,
	undefined,
	context,
);
handlers.get("tool_execution_start")?.({
	toolCallId: "edit-1",
	toolName: "edit",
	args: { path: "src/example.ts" },
});
assert(
	"live announcements show the current tool count",
	workingMessage.includes("1 tool"),
	JSON.stringify(workingMessage),
);
handlers.get("tool_execution_end")?.({ toolCallId: "edit-1", toolName: "edit", isError: false });
handlers.get("tool_execution_start")?.({
	toolCallId: "check-1",
	toolName: "bash",
	args: { command: "npm test" },
});
handlers.get("tool_execution_end")?.({ toolCallId: "check-1", toolName: "bash", isError: false });
handlers.get("tool_execution_start")?.({
	toolCallId: "read-1",
	toolName: "read",
	args: { path: "src/example.ts" },
});
handlers.get("tool_execution_end")?.({ toolCallId: "read-1", toolName: "read", isError: false });
void registeredTool.execute(
	"announce-2",
	{ step: "Install summaries" },
	undefined,
	undefined,
	context,
);
assert(
	"the aggregate announcement is inserted before phase work",
	appendedEntries.length === 1 && appendedEntries[0].type === "announce-step-duration",
	JSON.stringify(appendedEntries),
);
const activeAnnouncement = entryRenderers
	.get("announce-step-duration")?.(
		{ data: appendedEntries[0].data },
		{},
		{ fg: (_color: string, text: string) => text },
	)
	.render(80) as string[];
assert(
	"the transcript announcement stays hidden while the live indicator is active",
	activeAnnouncement.length === 0,
	JSON.stringify(activeAnnouncement),
);
handlers.get("tool_execution_start")?.({
	toolCallId: "write-1",
	toolName: "write",
	args: { path: "src/other.ts" },
});
handlers.get("tool_execution_end")?.({ toolCallId: "write-1", toolName: "write", isError: false });
handlers.get("tool_execution_start")?.({
	toolCallId: "read-2",
	toolName: "read",
	args: { path: "missing.ts" },
});
handlers.get("tool_execution_end")?.({ toolCallId: "read-2", toolName: "read", isError: true });
handlers.get("agent_settled")?.({}, context);

const summary = appendedEntries[0].data;
const persistedUpdate = appendedEntries[1];
assert(
	"settled turns update the earlier announcement and append only a hidden persistence entry",
	appendedEntries.length === 2 &&
		persistedUpdate.type === "announce-step-duration-update" &&
		summary.step === "Implement summaries" &&
		summary.toolCount === 5 &&
		summary.changedFiles.length === 2 &&
		summary.checkCount === undefined &&
		summary.recoveredFailures === undefined &&
		summary.completed === true,
	JSON.stringify(appendedEntries),
);
assert(
	"settling restores Pi's default message without controlling visibility",
	workingMessage === undefined && workingVisibilityCalls.length === 0,
	JSON.stringify({ workingMessage, workingVisibilityCalls }),
);
const completedAnnouncement = entryRenderers
	.get("announce-step-duration")?.(
		{ data: summary },
		{},
		{ fg: (_color: string, text: string) => text },
	)
	.render(80) as string[];
assert(
	"the transcript announcement appears after the live indicator stops",
	completedAnnouncement.join("").includes("Implement summaries"),
	JSON.stringify(completedAnnouncement),
);
const summaryText = formatSlice(summary.step, summary.durationMs, summary.receivedTokens, summary);
assert(
	"turn summaries report only aggregate tools and files",
	summaryText.includes("5 tools") &&
		summaryText.includes("2 files") &&
		!summaryText.includes("checks") &&
		!summaryText.includes("failure"),
	summaryText,
);
handlers.get("session_shutdown")?.({}, context);

type LifecycleHandler = (event: any, context: any) => unknown | Promise<unknown>;

function createLifecycleHarness() {
	const lifecycleHandlers = new Map<string, LifecycleHandler>();
	const workingMessages: Array<string | undefined> = [];
	const visibilityCalls: boolean[] = [];
	const indicatorCalls: unknown[] = [];
	let lifecycleTool: any;

	const lifecycleContext = {
		mode: "tui",
		sessionManager: { getEntries: () => [] },
		ui: {
			setStatus: () => undefined,
			setWorkingMessage: (message?: string) => workingMessages.push(message),
			setWorkingVisible: (visible: boolean) => visibilityCalls.push(visible),
			setWorkingIndicator: (options?: unknown) => indicatorCalls.push(options),
		},
	};
	const lifecyclePi = new Proxy(
		{
			registerEntryRenderer: () => undefined,
			registerTool: (tool: any) => {
				lifecycleTool = tool;
			},
			on: (event: string, handler: LifecycleHandler) => {
				lifecycleHandlers.set(event, handler);
			},
			appendEntry: () => undefined,
			getActiveTools: () => ["announce_step"],
		},
		{
			get(target, property) {
				return property in target ? target[property as keyof typeof target] : () => undefined;
			},
		},
	);
	announceStep(lifecyclePi as any);

	return {
		workingMessages,
		visibilityCalls,
		indicatorCalls,
		emit: async (event: string, payload: any = {}) => {
			await lifecycleHandlers.get(event)?.(payload, lifecycleContext);
		},
		start: async (step: string) => {
			await lifecycleHandlers.get("agent_start")?.({}, lifecycleContext);
			await lifecycleTool.execute(
				`announce-${step}`,
				{ step },
				undefined,
				undefined,
				lifecycleContext,
			);
		},
	};
}

const reloadLifecycle = createLifecycleHarness();
await reloadLifecycle.emit("session_start", { reason: "startup" });
await reloadLifecycle.emit("session_shutdown", { reason: "reload" });
await reloadLifecycle.emit("session_start", { reason: "reload" });
assert(
	"reloads leave Pi's working animation and default message untouched",
	reloadLifecycle.workingMessages.length === 0 &&
		reloadLifecycle.visibilityCalls.length === 0 &&
		reloadLifecycle.indicatorCalls.length === 0,
	JSON.stringify(reloadLifecycle),
);

async function assertContinuationLifecycle(
	name: string,
	intermediateEvents: Array<{ type: string; payload?: any }>,
): Promise<void> {
	const lifecycle = createLifecycleHarness();
	await lifecycle.emit("session_start", { reason: "startup" });
	await lifecycle.start(name);
	for (const event of intermediateEvents) await lifecycle.emit(event.type, event.payload);
	const resetsBeforeSettle = lifecycle.workingMessages.filter(
		(message) => message === undefined,
	).length;
	await lifecycle.emit("agent_settled");
	const resetCount = lifecycle.workingMessages.filter((message) => message === undefined).length;
	assert(
		name,
		resetsBeforeSettle === 0 &&
			resetCount === 1 &&
			lifecycle.workingMessages.at(-1) === undefined &&
			lifecycle.visibilityCalls.length === 0 &&
			lifecycle.indicatorCalls.length === 0,
		JSON.stringify({
			workingMessages: lifecycle.workingMessages,
			visibilityCalls: lifecycle.visibilityCalls,
			indicatorCalls: lifecycle.indicatorCalls,
		}),
	);
}

await assertContinuationLifecycle("queued continuations stay active until settlement", [
	{ type: "agent_end" },
	{ type: "agent_start" },
]);
await assertContinuationLifecycle("multiple turns preserve Pi-owned activity", [
	{ type: "turn_start", payload: { turnIndex: 0 } },
	{ type: "turn_end", payload: { turnIndex: 0 } },
	{ type: "turn_start", payload: { turnIndex: 1 } },
	{ type: "turn_end", payload: { turnIndex: 1 } },
	{ type: "agent_end" },
]);
await assertContinuationLifecycle("compaction preserves Pi-owned activity", [
	{ type: "agent_end" },
	{ type: "session_before_compact", payload: { reason: "overflow", willRetry: true } },
	{ type: "session_compact", payload: { reason: "overflow", willRetry: true } },
	{ type: "agent_start" },
	{ type: "agent_end" },
]);
await assertContinuationLifecycle("retries preserve Pi-owned activity", [
	{ type: "agent_end", payload: { error: new Error("retry") } },
	{ type: "agent_start" },
	{ type: "agent_end" },
]);

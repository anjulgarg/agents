import { resolve } from "node:path";

import planModeExtension from "../plan-mode/index.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

type EventHandler = (event: any, context: any) => Promise<any> | any;

const handlers = new Map<string, EventHandler>();
const busListeners: string[] = [];
const busEmissions: string[] = [];
const sent: Array<{ message: any; options: any }> = [];
const appended: Array<{ type: string; data: any }> = [];
const statusUpdates: Array<{ name: string; value: unknown }> = [];
let activeTools = ["read", "bash", "edit", "write"];
const activeToolSetChanges: string[][] = [];
let selection = "Execute the plan (track progress)";

const pi = {
	on: (event: string, handler: EventHandler) => {
		handlers.set(event, handler);
	},
	events: {
		on: (event: string) => busListeners.push(event),
		emit: (event: string) => busEmissions.push(event),
	},
	registerFlag: () => undefined,
	registerCommand: () => undefined,
	registerShortcut: () => undefined,
	getFlag: () => true,
	getActiveTools: () => [...activeTools],
	setActiveTools: (tools: string[]) => {
		activeToolSetChanges.push([...tools]);
		activeTools = tools;
	},
	appendEntry: (type: string, data: any) => appended.push({ type, data }),
	sendMessage: (message: any, options: any) => sent.push({ message, options }),
	sendUserMessage: () => undefined,
} as any;

planModeExtension(pi);
assert(
	"does not register or emit todo bus events",
	busListeners.length === 0 && busEmissions.every((event) => !event.startsWith("todo:")),
	JSON.stringify({ busListeners, busEmissions }),
);

const context = {
	hasUI: true,
	ui: {
		select: async () => selection,
		setStatus: (name: string, value: unknown) => statusUpdates.push({ name, value }),
		theme: { fg: (_color: string, text: string) => text },
		notify: () => undefined,
	},
	sessionManager: { getBranch: () => [] },
};
const planEvent = {
	messages: [
		{
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Validated implementation detail that must survive the execution handoff.\n\nPlan:\n1. Inspect the login flow\n2. Update the regression tests",
				},
			],
		},
	],
};

const initialActiveTools = [...activeTools];
await handlers.get("session_start")?.({}, context);
const foremanPlanRoot = resolve("skills/foreman-plan");
const planningContext = await handlers.get("before_agent_start")?.(
	{
		systemPromptOptions: {
			skills: [
				{
					name: "foreman-plan",
					filePath: resolve(foremanPlanRoot, "SKILL.md"),
					baseDir: foremanPlanRoot,
				},
			],
		},
	},
	context,
);
assert(
	"plan mode injects the discovered Foreman planning skill",
	planningContext?.systemPrompt === undefined &&
		planningContext?.message?.display === false &&
		String(planningContext?.message?.content).includes("[PLAN MODE ACTIVE]") &&
		String(planningContext?.message?.content).includes("## Adaptive discovery") &&
		String(planningContext?.message?.content).includes("## Plan confirmation gate") &&
		String(planningContext?.message?.content).includes("Read-only delivery contract") &&
		String(planningContext?.message?.content).includes(foremanPlanRoot),
	JSON.stringify(planningContext),
);
const repeatedPlanningContext = await handlers.get("before_agent_start")?.(
	{ systemPromptOptions: { skills: [] } },
	context,
);
assert(
	"plan mode injects the full planning skill only once per activation",
	repeatedPlanningContext === undefined,
	JSON.stringify(repeatedPlanningContext),
);
assert(
	"plan mode keeps the active tool set byte-stable",
	JSON.stringify(activeTools) === JSON.stringify(initialActiveTools) &&
		activeToolSetChanges.length === 0,
	JSON.stringify({ activeTools, initialActiveTools, activeToolSetChanges }),
);
assert(
	"provider context is not filtered, so prior plan guidance and quoted markers remain",
	!handlers.has("context"),
	JSON.stringify([...handlers.keys()]),
);
await handlers.get("agent_end")?.(planEvent, context);
const execution = sent[0];
const executionText = execution?.message.content ?? "";
assert(
	"execute sends one generic hidden follow-up with the approved plan",
	sent.length === 1 &&
		execution.message.customType === undefined &&
		execution.message.display === false &&
		execution.options.triggerTurn === true &&
		execution.options.deliverAs === "followUp" &&
		executionText.includes("[BUILD MODE ACTIVE]") &&
		executionText.includes("Validated implementation detail that must survive") &&
		executionText.includes("Inspect the login flow") &&
		executionText.includes("regression tests") &&
		executionText.includes("task-management") &&
		executionText.includes("immediately") &&
		!executionText.toLowerCase().includes("todo"),
	JSON.stringify(execution),
);

const executionContext = await handlers.get("before_agent_start")?.({}, context);
assert(
	"execution context remains hidden and independent from other task extensions",
	executionContext?.systemPrompt === undefined &&
		executionContext?.message?.display === false &&
		!String(executionContext?.message?.content).toLowerCase().includes("todo") &&
		String(executionContext?.message?.content).includes("[BUILD MODE ACTIVE]") &&
		String(executionContext?.message?.content).includes("task-management"),
	JSON.stringify(executionContext),
);

await handlers.get("agent_settled")?.({}, context);
const settledEntry = appended.at(-1);
const postSettlementContext = await handlers.get("before_agent_start")?.({}, context);
assert(
	"execution mode settles on the agent lifecycle without todo events",
	settledEntry?.type === "plan-mode" &&
		settledEntry.data.executing === false &&
		postSettlementContext?.systemPrompt === undefined &&
		postSettlementContext?.message?.customType === "plan-build-context" &&
		postSettlementContext?.message?.display === false &&
		String(postSettlementContext?.message?.content).includes("[BUILD MODE ACTIVE]") &&
		!String(postSettlementContext?.message?.content).includes("[PLAN MODE ACTIVE]") &&
		statusUpdates.at(-1)?.value === undefined &&
		busListeners.length === 0 &&
		busEmissions.every((event) => !event.startsWith("todo:")),
	JSON.stringify({
		settledEntry,
		postSettlementContext,
		statusUpdates,
		busListeners,
		busEmissions,
	}),
);

function createJobHarness(initialTools: string[]) {
	const harnessHandlers = new Map<string, (event: any, context: any) => Promise<any>>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
	let tools = [...initialTools];
	const toolSetChanges: string[][] = [];
	const harnessPi = {
		on: (event: string, handler: (event: any, context: any) => Promise<any>) => {
			harnessHandlers.set(event, handler);
		},
		events: {
			on: () => undefined,
			emit: () => undefined,
		},
		registerFlag: () => undefined,
		registerCommand: (
			name: string,
			command: { handler: (args: string, ctx: any) => Promise<void> | void },
		) => {
			commands.set(name, command.handler);
		},
		registerShortcut: () => undefined,
		getFlag: () => false,
		getActiveTools: () => [...tools],
		setActiveTools: (next: string[]) => {
			toolSetChanges.push([...next]);
			tools = [...next];
		},
		appendEntry: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
	} as any;

	planModeExtension(harnessPi);

	const harnessContext = {
		hasUI: true,
		ui: {
			select: async () => "Stay in plan mode",
			setStatus: () => undefined,
			theme: { fg: (_color: string, text: string) => text },
			notify: () => undefined,
		},
		sessionManager: { getBranch: () => [] },
	};

	return {
		tools: () => tools,
		toolSetChanges: () => toolSetChanges.map((change) => [...change]),
		handlers: harnessHandlers,
		togglePlan: async () => commands.get("plan")?.("", harnessContext),
		context: harnessContext,
	};
}

{
	const harness = createJobHarness(["read", "bash", "edit", "write", "job", "grep"]);
	const initialTools = harness.tools().join(",");
	await harness.togglePlan();
	const fallbackPlanningContext = await harness.handlers.get("before_agent_start")?.(
		{ systemPromptOptions: { skills: [] } },
		harness.context,
	);
	assert(
		"plan mode uses an approval-gated fallback when the Foreman skill is unavailable",
		fallbackPlanningContext?.systemPrompt === undefined &&
			String(fallbackPlanningContext?.message?.content).includes(
				"The foreman-plan skill could not be loaded",
			) &&
			String(fallbackPlanningContext?.message?.content).includes("explicit design approval"),
		JSON.stringify(fallbackPlanningContext),
	);
	assert(
		"plan mode keeps every active tool definition and ordering",
		harness.tools().join(",") === initialTools && harness.toolSetChanges().length === 0,
		JSON.stringify({
			tools: harness.tools(),
			initialTools,
			toolSetChanges: harness.toolSetChanges(),
		}),
	);

	await harness.togglePlan();
	assert(
		"disabling plan mode keeps the same active tool set",
		harness.tools().join(",") === initialTools && harness.toolSetChanges().length === 0,
		JSON.stringify({
			tools: harness.tools(),
			initialTools,
			toolSetChanges: harness.toolSetChanges(),
		}),
	);

	const buildContext = await harness.handlers.get("before_agent_start")?.(
		{ systemPrompt: "base", systemPromptOptions: { skills: [] } },
		harness.context,
	);
	assert(
		"disabling plan mode appends hidden authoritative build guidance",
		buildContext?.systemPrompt === undefined &&
			buildContext?.message?.customType === "plan-build-context" &&
			buildContext?.message?.display === false &&
			String(buildContext?.message?.content).includes("[BUILD MODE ACTIVE]") &&
			String(buildContext?.message?.content).includes("Full tool access is available") &&
			!String(buildContext?.message?.content).includes("[PLAN MODE ACTIVE]"),
		JSON.stringify(buildContext),
	);

	assert(
		"disabling plan mode does not register a context filter",
		!harness.handlers.has("context"),
		JSON.stringify([...harness.handlers.keys()]),
	);
	const repeatedBuildContext = await harness.handlers.get("before_agent_start")?.(
		{ systemPrompt: "base", systemPromptOptions: { skills: [] } },
		harness.context,
	);
	assert(
		"build guidance is sent once per mode transition",
		repeatedBuildContext === undefined,
		JSON.stringify(repeatedBuildContext),
	);
}

{
	const harness = createJobHarness(["read", "bash", "edit", "write"]);
	const initialTools = harness.tools().join(",");
	await harness.togglePlan();
	assert(
		"plan mode does not invent inactive tools",
		harness.tools().join(",") === initialTools && !harness.tools().includes("job"),
		JSON.stringify({ tools: harness.tools(), initialTools }),
	);
	await harness.togglePlan();
	assert(
		"restoring without a prior job preserves the inactive job state",
		harness.tools().join(",") === initialTools && harness.toolSetChanges().length === 0,
		JSON.stringify({
			tools: harness.tools(),
			initialTools,
			toolSetChanges: harness.toolSetChanges(),
		}),
	);
}

{
	const harness = createJobHarness(["read", "bash", "edit", "write", "job"]);
	await harness.togglePlan();
	const toolCall = harness.handlers.get("tool_call");
	if (!toolCall) throw new Error("missing tool_call handler");

	const blockedEdit = await toolCall(
		{ toolName: "edit", input: { path: "src/app.ts", oldText: "old", newText: "new" } },
		harness.context,
	);
	const blockedWrite = await toolCall(
		{ toolName: "write", input: { path: "src/app.ts", content: "new" } },
		harness.context,
	);
	const blockedJob = await toolCall(
		{ toolName: "job", input: { command: "ls -la" } },
		harness.context,
	);
	assert(
		"plan mode blocks edit, write, and job calls while keeping them active",
		blockedEdit?.block === true &&
			blockedEdit.terminate === true &&
			blockedWrite?.block === true &&
			blockedWrite.terminate === true &&
			blockedJob?.block === true &&
			blockedJob.terminate === true &&
			harness.tools().join(",") === "read,bash,edit,write,job",
		JSON.stringify({ blockedEdit, blockedWrite, blockedJob, tools: harness.tools() }),
	);

	const unsafeCommand = "rm -rf /tmp/plan-mode-job";
	const unsafeFirst = await toolCall(
		{ toolName: "bash", input: { command: unsafeCommand } },
		harness.context,
	);
	const unsafeSecond = await toolCall(
		{ toolName: "bash", input: { command: unsafeCommand } },
		harness.context,
	);
	assert(
		"unsafe bash commands are blocked deterministically",
		unsafeFirst?.block === true &&
			unsafeFirst.terminate === true &&
			unsafeSecond?.block === true &&
			unsafeSecond.terminate === true &&
			unsafeFirst.reason === unsafeSecond.reason &&
			String(unsafeFirst.reason).includes(unsafeCommand),
		JSON.stringify({ unsafeFirst, unsafeSecond }),
	);

	const safeCommand = "ls -la";
	const safeBash = await toolCall(
		{ toolName: "bash", input: { command: safeCommand } },
		harness.context,
	);
	assert(
		"safe read-only bash remains available",
		safeBash === undefined,
		JSON.stringify({ safeBash }),
	);

	const staleMissing = await toolCall({ toolName: "job", input: {} }, harness.context);
	assert(
		"stale job calls without a command string are blocked",
		staleMissing?.block === true &&
			staleMissing.terminate === true &&
			String(staleMissing.reason).includes("job"),
		JSON.stringify(staleMissing),
	);

	await harness.togglePlan();
	const editInAuto = await toolCall(
		{ toolName: "edit", input: { path: "src/app.ts", oldText: "old", newText: "new" } },
		harness.context,
	);
	const unsafeBashInAuto = await toolCall(
		{ toolName: "bash", input: { command: unsafeCommand } },
		harness.context,
	);
	assert(
		"plan-mode blocking ends in auto mode",
		editInAuto === undefined && unsafeBashInAuto === undefined,
		JSON.stringify({ editInAuto, unsafeBashInAuto }),
	);
}

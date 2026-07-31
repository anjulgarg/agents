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
	String(planningContext?.message?.content).includes("[PLAN MODE ACTIVE]") &&
		String(planningContext?.message?.content).includes("## Adaptive discovery") &&
		String(planningContext?.message?.content).includes("## Plan confirmation gate") &&
		String(planningContext?.message?.content).includes("## Pi plan mode integration") &&
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
const filteredPlanningContext = await handlers.get("context")?.(
	{
		messages: [
			{ role: "user", customType: "plan-mode-context", content: "old guidance" },
			planningContext?.message,
			{ role: "user", content: "plan this change" },
			{ role: "user", content: "explain the [PLAN MODE ACTIVE] marker" },
		],
	},
	context,
);
assert(
	"plan mode keeps only the latest guidance without dropping quoted markers",
	filteredPlanningContext?.messages?.length === 3 &&
		filteredPlanningContext.messages[0] === planningContext?.message &&
		String(filteredPlanningContext.messages[2]?.content).includes("[PLAN MODE ACTIVE]"),
	JSON.stringify(filteredPlanningContext),
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
	"execution context remains independent from other task extensions",
	!String(executionContext?.message?.content).toLowerCase().includes("todo") &&
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
		postSettlementContext === undefined &&
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
			tools = next;
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
		handlers: harnessHandlers,
		togglePlan: async () => commands.get("plan")?.("", harnessContext),
		context: harnessContext,
	};
}

{
	const harness = createJobHarness(["read", "bash", "edit", "write", "job", "grep"]);
	await harness.togglePlan();
	const fallbackPlanningContext = await harness.handlers.get("before_agent_start")?.(
		{ systemPromptOptions: { skills: [] } },
		harness.context,
	);
	assert(
		"plan mode uses an approval-gated fallback when the Foreman skill is unavailable",
		String(fallbackPlanningContext?.message?.content).includes(
			"The foreman-plan skill could not be loaded",
		) && String(fallbackPlanningContext?.message?.content).includes("explicit design approval"),
		JSON.stringify(fallbackPlanningContext),
	);
	assert(
		"plan mode removes job from active tools",
		!harness.tools().includes("job") &&
			!harness.tools().includes("edit") &&
			!harness.tools().includes("write") &&
			harness.tools().includes("bash") &&
			harness.tools().includes("grep"),
		harness.tools().join(","),
	);

	await harness.togglePlan();
	assert(
		"disabling plan mode restores previously active job",
		harness.tools().includes("job") &&
			harness.tools().includes("edit") &&
			harness.tools().includes("write") &&
			harness.tools().join(",") === "read,bash,edit,write,job,grep",
		harness.tools().join(","),
	);
}

{
	const harness = createJobHarness(["read", "bash", "edit", "write"]);
	await harness.togglePlan();
	assert(
		"plan mode does not invent job when it was inactive",
		!harness.tools().includes("job"),
		harness.tools().join(","),
	);
	await harness.togglePlan();
	assert(
		"restore without prior job leaves job inactive",
		!harness.tools().includes("job") && harness.tools().join(",") === "read,bash,edit,write",
		harness.tools().join(","),
	);
}

{
	const harness = createJobHarness(["read", "bash", "edit", "write", "job"]);
	await harness.togglePlan();
	const toolCall = harness.handlers.get("tool_call");
	if (!toolCall) throw new Error("missing tool_call handler");

	const unsafeCommand = "rm -rf /tmp/plan-mode-job";
	const unsafeFirst = await toolCall(
		{ toolName: "job", input: { command: unsafeCommand } },
		harness.context,
	);
	const unsafeSecond = await toolCall(
		{ toolName: "job", input: { command: unsafeCommand } },
		harness.context,
	);
	assert(
		"unsafe job commands are blocked deterministically",
		unsafeFirst?.block === true &&
			unsafeSecond?.block === true &&
			unsafeFirst.reason === unsafeSecond.reason &&
			String(unsafeFirst.reason).includes(unsafeCommand),
		JSON.stringify({ unsafeFirst, unsafeSecond }),
	);

	const safeCommand = "ls -la";
	const safeFirst = await toolCall(
		{ toolName: "job", input: { command: safeCommand } },
		harness.context,
	);
	const safeSecond = await toolCall(
		{ toolName: "job", input: { command: safeCommand } },
		harness.context,
	);
	assert(
		"safe job command handling is deterministic",
		safeFirst === undefined && safeSecond === undefined,
		JSON.stringify({ safeFirst, safeSecond }),
	);

	const staleMissing = await toolCall({ toolName: "job", input: {} }, harness.context);
	assert(
		"stale job calls without a command string are blocked",
		staleMissing?.block === true && String(staleMissing.reason).includes("Command:"),
		JSON.stringify(staleMissing),
	);

	const bashUnsafe = await toolCall(
		{ toolName: "bash", input: { command: unsafeCommand } },
		harness.context,
	);
	assert(
		"bash unsafe allowlist behavior is preserved",
		bashUnsafe?.block === true && String(bashUnsafe.reason).includes(unsafeCommand),
		JSON.stringify(bashUnsafe),
	);
}

import handoffExtension, {
	HANDOFF_COMMAND,
	HANDOFF_PROMPT_GUIDELINES,
	HANDOFF_REQUEST,
	MAX_HANDOFF_LENGTH,
} from "../handoff.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

function createHarness() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, (event?: any, ctx?: any) => any>();
	let tool: any;
	const queued: Array<{ content: string; options: any }> = [];
	const pi = {
		on(event: string, handler: (event?: any, ctx?: any) => any) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		registerTool(definition: any) {
			tool = definition;
		},
		sendUserMessage(content: string, options?: any) {
			queued.push({ content, options });
		},
	};
	handoffExtension(pi as never);
	return {
		commands,
		handlers,
		get tool() {
			return tool;
		},
		queued,
	};
}

const registration = createHarness();
const publicCommand = registration.commands.get(HANDOFF_COMMAND);
assert(
	"handoff extension registers one public command and a bounded guided tool",
	registration.commands.size === 1 &&
		publicCommand !== undefined &&
		registration.tool?.name === "handoff" &&
		registration.tool.parameters.properties.handoff.maxLength === MAX_HANDOFF_LENGTH &&
		registration.tool.promptGuidelines.length === HANDOFF_PROMPT_GUIDELINES.length,
	JSON.stringify({ commands: [...registration.commands.keys()], tool: registration.tool?.name }),
);

const handoff = [
	"# Session Handoff",
	"",
	"## Objective",
	"Finish the pending implementation.",
	"",
	"## Pending tasks",
	"1. Run the focused tests.",
].join("\n");

const flow = createHarness();
const notifications: Array<{ message: string; level: string }> = [];
let waitForIdleCalls = 0;
let newSessionCalls = 0;
let parentSession: string | undefined;
let submitted = "";
const commandContext = {
	mode: "tui",
	isIdle: () => true,
	waitForIdle: async () => {
		waitForIdleCalls++;
	},
	sessionManager: { getSessionFile: () => "/sessions/parent.jsonl" },
	ui: {
		notify(message: string, level: string) {
			notifications.push({ message, level });
		},
	},
	async newSession(options: any) {
		newSessionCalls++;
		parentSession = options.parentSession;
		await options.withSession({
			async sendUserMessage(message: string) {
				submitted = message;
			},
		});
		return { cancelled: false };
	},
};

const commandPromise = flow.commands
	.get(HANDOFF_COMMAND)
	.handler("prioritize verification", commandContext);
await Promise.resolve();
assert(
	"public handoff command asks the current agent to prepare the handoff",
	flow.queued.length === 1 &&
		flow.queued[0]?.content.startsWith(HANDOFF_REQUEST) &&
		flow.queued[0]?.content.includes("Inspect the active todo list") &&
		flow.queued[0]?.content.includes("prioritize verification") &&
		flow.queued[0]?.options === undefined,
	JSON.stringify(flow.queued),
);

const toolResult = await flow.tool.execute(
	"handoff-1",
	{ handoff: `  ${handoff}  ` },
	undefined,
	undefined,
	{ mode: "tui" },
);
await commandPromise;
assert(
	"tool returns the summary to the command for linked replacement and submission",
	toolResult.terminate === true &&
		waitForIdleCalls === 1 &&
		newSessionCalls === 1 &&
		parentSession === "/sessions/parent.jsonl" &&
		submitted === handoff,
	JSON.stringify({ toolResult, waitForIdleCalls, newSessionCalls, parentSession, submitted }),
);

let singleUseRejected = false;
try {
	await flow.tool.execute("handoff-2", { handoff }, undefined, undefined, { mode: "tui" });
} catch (error) {
	singleUseRejected = error instanceof Error && error.message.includes("No /handoff command");
}
assert(
	"handoff summaries require one active command flow",
	singleUseRejected,
	JSON.stringify({ singleUseRejected }),
);

const busy = createHarness();
const busyNotifications: Array<{ message: string; level: string }> = [];
const busyContext = {
	mode: "tui",
	isIdle: () => false,
	ui: {
		notify(message: string, level: string) {
			busyNotifications.push({ message, level });
		},
	},
};
const busyPromise = busy.commands.get(HANDOFF_COMMAND).handler("", busyContext);
await Promise.resolve();
assert(
	"public handoff command queues preparation after active work settles",
	busy.queued[0]?.options.deliverAs === "followUp",
	JSON.stringify(busy.queued),
);
await busy.commands.get(HANDOFF_COMMAND).handler("again", busyContext);
busy.handlers.get("agent_settled")?.();
await busyPromise;
assert(
	"concurrent handoffs are rejected and missing summaries fail visibly",
	busyNotifications.some(({ message }) => message.includes("already in progress")) &&
		busyNotifications.some(({ message }) => message.includes("settled without preparing")),
	JSON.stringify(busyNotifications),
);

let nonInteractiveRejected = false;
const nonInteractive = createHarness();
try {
	await nonInteractive.tool.execute("handoff-json", { handoff }, undefined, undefined, {
		mode: "json",
	});
} catch (error) {
	nonInteractiveRejected = error instanceof Error && error.message.includes("interactive mode");
}
assert(
	"handoff tool refuses non-interactive session replacement",
	nonInteractiveRejected && nonInteractive.queued.length === 0,
	JSON.stringify({ nonInteractiveRejected, queued: nonInteractive.queued }),
);

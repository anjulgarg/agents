import { estimateToolDefinitionTokens } from "../context.ts";
import toolLoaderExtension, {
	CAPABILITIES,
	LOAD_TOOLS_COMMAND,
	LOAD_TOOLS_NAME,
	loadCapability,
	resetOptionalTools,
} from "../tool-loader.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

const DEFAULT_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"lsp",
	"question",
	"job",
	"todo",
	"checkpoint",
	"codex_web_search",
] as const;

interface Harness {
	readonly pi: any;
	readonly tools: Map<string, any>;
	readonly commands: Map<string, any>;
	readonly handlers: Map<string, Array<(event: any, ctx: any) => any>>;
	readonly notifications: Array<{ message: string; level: string }>;
	get activeTools(): string[];
	set activeTools(value: string[]);
	get setCalls(): string[][];
}

function createHarness(
	registeredCapabilities: readonly string[] = CAPABILITIES,
	initialActive: readonly string[] = [
		...DEFAULT_TOOLS,
		"subagent_status",
		"job_status",
		...registeredCapabilities,
	],
): Harness {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const notifications: Array<{ message: string; level: string }> = [];
	let active = [...initialActive];
	const setCalls: string[][] = [];
	const pi = {
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
		on(event: string, handler: (event: any, ctx: any) => any) {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		getActiveTools() {
			return [...active];
		},
		setActiveTools(next: string[]) {
			active = [...next];
			setCalls.push([...next]);
		},
		getAllTools() {
			return [
				...DEFAULT_TOOLS.map((name) => ({ name, description: `${name} tool` })),
				...registeredCapabilities.map((name) => ({ name, description: `${name} capability` })),
			];
		},
	};
	toolLoaderExtension(pi as never);
	return {
		pi,
		tools,
		commands,
		handlers,
		notifications,
		get activeTools() {
			return [...active];
		},
		set activeTools(value: string[]) {
			active = [...value];
		},
		get setCalls() {
			return setCalls.map((call) => [...call]);
		},
	};
}

function emit(harness: Harness, event: string): void {
	for (const handler of harness.handlers.get(event) ?? []) handler({}, {});
}

const fresh = createHarness();
emit(fresh, "session_start");
assert(
	"fresh sessions keep defaults and conditional management tools while hiding optional roots",
	DEFAULT_TOOLS.every((name) => fresh.activeTools.includes(name)) &&
		fresh.activeTools.includes("subagent_status") &&
		fresh.activeTools.includes("job_status") &&
		!CAPABILITIES.some((name) => fresh.activeTools.includes(name)) &&
		fresh.activeTools.filter((name) => name === LOAD_TOOLS_NAME).length === 1,
	fresh.activeTools.join(","),
);

const latePackage = createHarness();
emit(latePackage, "session_start");
latePackage.activeTools = [...latePackage.activeTools, "mcp"];
emit(latePackage, "before_agent_start");
assert(
	"the first model boundary removes roots reactivated by later-loading packages",
	!CAPABILITIES.some((name) => latePackage.activeTools.includes(name)) &&
		latePackage.activeTools.includes(LOAD_TOOLS_NAME),
	latePackage.activeTools.join(","),
);

const asyncLatePackage = createHarness();
emit(asyncLatePackage, "session_start");
asyncLatePackage.activeTools = [...asyncLatePackage.activeTools, "mcp"];
await new Promise((resolve) => setTimeout(resolve, 40));
assert(
	"bounded startup synchronization removes roots reactivated after session_start",
	!CAPABILITIES.some((name) => asyncLatePackage.activeTools.includes(name)) &&
		asyncLatePackage.activeTools.includes(LOAD_TOOLS_NAME),
	asyncLatePackage.activeTools.join(","),
);
emit(asyncLatePackage, "session_shutdown");

const mcp = fresh.tools.get(LOAD_TOOLS_NAME);
const loaded = await mcp.execute("load-1", { capability: "mcp" });
assert(
	"loading an installed capability appends its root tool",
	loaded.details.capability === "mcp" &&
		loaded.details.toolName === "mcp" &&
		loaded.details.status === "loaded" &&
		fresh.activeTools.at(-1) === "mcp" &&
		fresh.activeTools.filter((name) => name === "mcp").length === 1 &&
		fresh.activeTools.includes(LOAD_TOOLS_NAME),
	JSON.stringify({ details: loaded.details, active: fresh.activeTools }),
);

const beforeRepeat = [...fresh.activeTools];
const active = await mcp.execute("load-2", { capability: "mcp" });
assert(
	"loading an active capability is idempotent",
	active.details.status === "active" &&
		active.content[0]?.text.includes("already active") &&
		JSON.stringify(fresh.activeTools) === JSON.stringify(beforeRepeat),
	JSON.stringify({ details: active.details, active: fresh.activeTools }),
);

const batch = createHarness([], [...DEFAULT_TOOLS, "subagent_status", "job_status", "load_tools"]);
const batchResult = await batch.tools.get(LOAD_TOOLS_NAME).execute("load-batch", {
	capabilities: ["mcp", "subagent", "handoff"],
});
assert(
	"a batch request loads multiple capabilities with one active-set update",
	batchResult.details.results.length === 3 &&
		batchResult.details.results.every((result: any) => result.status === "unavailable") &&
		batch.setCalls.length === 0,
	JSON.stringify({ details: batchResult.details, setCalls: batch.setCalls }),
);
const installedBatch = createHarness(
	["mcp", "subagent", "handoff"],
	[...DEFAULT_TOOLS, "subagent_status", "job_status", "load_tools"],
);
const installedBatchResult = await installedBatch.tools
	.get(LOAD_TOOLS_NAME)
	.execute("load-batch-2", {
		capabilities: ["mcp", "subagent", "handoff"],
	});
assert(
	"a batch request activates every available capability atomically",
	installedBatchResult.details.results.every((result: any) => result.status === "loaded") &&
		installedBatch.setCalls.length === 1 &&
		["mcp", "subagent", "handoff"].every((name) => installedBatch.activeTools.includes(name)),
	JSON.stringify({ details: installedBatchResult.details, setCalls: installedBatch.setCalls }),
);

const missing = createHarness(["mcp", "subagent", "handoff"]);
const beforeMissing = [...missing.activeTools];
const unavailable = await missing.tools.get(LOAD_TOOLS_NAME).execute("missing-1", {
	capability: "memory",
});
assert(
	"an unavailable capability is non-fatal and does not mutate active tools",
	unavailable.details.status === "unavailable" &&
		unavailable.details.toolName === "memory" &&
		unavailable.content[0]?.text.length <= 300 &&
		JSON.stringify(missing.activeTools) === JSON.stringify(beforeMissing) &&
		missing.setCalls.length === 0,
	JSON.stringify({ details: unavailable.details, active: missing.activeTools }),
);

const metadataHarness = createHarness();
const metadata = metadataHarness.tools.get(LOAD_TOOLS_NAME);
const publicMetadata = JSON.stringify({
	name: metadata.name,
	label: metadata.label,
	description: metadata.description,
	promptSnippet: metadata.promptSnippet,
	promptGuidelines: metadata.promptGuidelines,
	parameters: metadata.parameters,
});
const forbiddenMetadataTerms = [
	"sentry",
	"ollama",
	"codex",
	"openai",
	"github",
	"vendor",
	"service",
];
assert(
	"capability metadata stays generic and the enum covers every capability",
	CAPABILITIES.every((capability) => JSON.stringify(metadata.parameters).includes(capability)) &&
		forbiddenMetadataTerms.every((term) => !publicMetadata.toLowerCase().includes(term)),
	publicMetadata,
);

const estimatedTokens = estimateToolDefinitionTokens(metadata);
assert(
	"load_tools definition stays within the context budget",
	estimatedTokens <= 250,
	String(estimatedTokens),
);

const commandHarness = createHarness();
emit(commandHarness, "session_start");
const command = commandHarness.commands.get(LOAD_TOOLS_COMMAND);
const commandContext = {
	ui: {
		notify(message: string, level: string) {
			commandHarness.notifications.push({ message, level });
		},
	},
};
await command.handler("", commandContext);
await command.handler("unknown", commandContext);
await command.handler("mcp extra", commandContext);
assert(
	"the manual command reports usage for missing or invalid arguments",
	commandHarness.notifications.length === 3 &&
		commandHarness.notifications.every(
			({ message, level }) =>
				message === "Usage: /tools:load <mcp|subagent|memory|handoff> [...]" && level === "error",
		),
	JSON.stringify(commandHarness.notifications),
);
await command.handler("memory handoff", commandContext);
emit(commandHarness, "before_agent_start");
assert(
	"the manual command uses the same additive generic activation",
	commandHarness.notifications.at(-1)?.message === "Loaded: memory, handoff" &&
		commandHarness.activeTools.includes("memory") &&
		commandHarness.activeTools.includes("handoff"),
	JSON.stringify({
		notifications: commandHarness.notifications,
		active: commandHarness.activeTools,
	}),
);

const renderHarness = createHarness();
const loaderTool = renderHarness.tools.get(LOAD_TOOLS_NAME);
const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};
const firstRendered = loaderTool.renderCall({ capabilities: ["mcp", "subagent"] }, theme, {
	toolCallId: "load-1",
	executionStarted: true,
	expanded: false,
});
const secondRendered = loaderTool.renderCall({ capability: "memory" }, theme, {
	toolCallId: "load-2",
	executionStarted: true,
	expanded: false,
});
const firstRow = firstRendered.render(100).join("\\n");
const secondRow = secondRendered.render(100).join("\\n");
assert(
	"loader calls use the shared compact soft-group tree renderer",
	loaderTool.renderShell === "self" &&
		firstRow.includes("load tools") &&
		firstRow.includes("· 2 · mcp, subagent") &&
		secondRow.includes("load tools") &&
		secondRow.includes("├─") &&
		secondRow.includes("└─") &&
		!loaderTool
			.renderResult(
				{ content: [{ type: "text", text: "Loaded: mcp, subagent" }] },
				{ expanded: false, isPartial: false },
				theme,
				{ expanded: false, isError: false },
			)
			.render(100)
			.join(""),
	JSON.stringify({ firstRow, secondRow }),
);

const allCapabilities = createHarness();
emit(allCapabilities, "session_start");
emit(allCapabilities, "before_agent_start");
const statuses = [] as string[];
for (const capability of CAPABILITIES) {
	const result = loadCapability(allCapabilities.pi, capability);
	statuses.push(result.details.status);
}
assert(
	"every enum capability loads through the explicit map",
	statuses.every((status) => status === "loaded") &&
		CAPABILITIES.every((capability) => allCapabilities.activeTools.includes(capability)),
	JSON.stringify({ statuses, active: allCapabilities.activeTools }),
);

const replacement = createHarness();
emit(replacement, "session_start");
await replacement.tools.get(LOAD_TOOLS_NAME).execute("replacement-1", { capability: "handoff" });
await replacement.tools.get(LOAD_TOOLS_NAME).execute("replacement-2", { capability: "mcp" });
emit(replacement, "session_start");
assert(
	"a replacement session resets optional roots but keeps the loader active",
	!CAPABILITIES.some((name) => replacement.activeTools.includes(name)) &&
		replacement.activeTools.filter((name) => name === LOAD_TOOLS_NAME).length === 1 &&
		DEFAULT_TOOLS.every((name) => replacement.activeTools.includes(name)),
	replacement.activeTools.join(","),
);

const directReset = createHarness([], ["read", "mcp", "subagent_status", "load_tools"]);
resetOptionalTools(directReset.pi);
assert(
	"reset removes only optional roots",
	directReset.activeTools.join(",") === "read,subagent_status,load_tools",
	directReset.activeTools.join(","),
);

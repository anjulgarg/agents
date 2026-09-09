import escapeUnsend, {
	assistantHasProgress,
	findLatestUserPrompt,
	messageText,
	resolvePendingPrompt,
	shouldUnsend,
} from "../escape-unsend.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

assert(
	"messageText joins text blocks and ignores tools",
	messageText([
		{ type: "text", text: "hello " },
		{ type: "toolCall", name: "read", id: "1", arguments: {} },
		{ type: "text", text: "world" },
	]) === "hello world",
	messageText([
		{ type: "text", text: "hello " },
		{ type: "text", text: "world" },
	]),
);

assert(
	"assistantHasProgress is false for empty aborted stubs",
	!assistantHasProgress({ content: [] }) &&
		!assistantHasProgress({ content: [{ type: "text", text: "  " }] }) &&
		!assistantHasProgress({ content: [{ type: "thinking", thinking: "" }] }),
	"empty",
);

assert(
	"assistantHasProgress detects text, thinking, and tool calls",
	assistantHasProgress({ content: [{ type: "text", text: "hi" }] }) &&
		assistantHasProgress({ content: [{ type: "thinking", thinking: "plan" }] }) &&
		assistantHasProgress({
			content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
		}),
	"progress",
);

assert(
	"findLatestUserPrompt walks the branch from the leaf",
	findLatestUserPrompt([
		{ id: "a", type: "message", message: { role: "user", content: "first" } },
		{ id: "b", type: "message", message: { role: "assistant", content: "ok" } },
		{
			id: "c",
			type: "message",
			message: { role: "user", content: [{ type: "text", text: " second " }] },
		},
	])?.entryId === "c" &&
		findLatestUserPrompt([
			{
				id: "c",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: " second " }] },
			},
		])?.text === "second",
	JSON.stringify(
		findLatestUserPrompt([
			{
				id: "c",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: " second " }] },
			},
		]),
	),
);

const branchForResolve = [
	{ id: "u1", type: "message", message: { role: "user", content: "older" } },
	{ id: "a1", type: "message", message: { role: "assistant", content: "ok" } },
	{ id: "u2", type: "message", message: { role: "user", content: "newer" } },
];
assert(
	"resolvePendingPrompt matches expected text instead of an older sibling",
	resolvePendingPrompt(branchForResolve, "newer")?.entryId === "u2" &&
		resolvePendingPrompt(branchForResolve, "older")?.entryId === "u1" &&
		resolvePendingPrompt(branchForResolve)?.entryId === "u2",
	JSON.stringify([
		resolvePendingPrompt(branchForResolve, "newer"),
		resolvePendingPrompt(branchForResolve, "older"),
		resolvePendingPrompt(branchForResolve),
	]),
);

assert(
	"shouldUnsend only for aborted idle TUI turns with a pending prompt",
	shouldUnsend({
		stopReason: "aborted",
		producedWork: false,
		escapeRequested: true,
		pending: { entryId: "u1", text: "fix me" },
		mode: "tui",
	}) &&
		!shouldUnsend({
			stopReason: "aborted",
			producedWork: true,
			escapeRequested: true,
			pending: { entryId: "u1", text: "fix me" },
			mode: "tui",
		}) &&
		!shouldUnsend({
			stopReason: "stop",
			producedWork: false,
			escapeRequested: true,
			pending: { entryId: "u1", text: "fix me" },
			mode: "tui",
		}) &&
		!shouldUnsend({
			stopReason: "aborted",
			producedWork: false,
			escapeRequested: true,
			pending: { entryId: "u1", text: "fix me" },
			mode: "rpc",
		}) &&
		!shouldUnsend({
			stopReason: "aborted",
			producedWork: false,
			escapeRequested: false,
			pending: { entryId: "u1", text: "fix me" },
			mode: "tui",
		}) &&
		!shouldUnsend({
			stopReason: "aborted",
			producedWork: false,
			escapeRequested: true,
			pending: undefined,
			mode: "tui",
		}),
	"gates",
);

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;
const handlers = new Map<string, Handler[]>();
const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
const navigations: string[] = [];
const editorTexts: string[] = [];
const submitted: string[] = [];
const dispatchOptions: Array<{ expandPromptTemplates?: boolean } | undefined> = [];
const pendingDispatches: Array<Promise<void>> = [];
const terminalInputHandlers: Array<(data: string) => unknown> = [];
const emitTerminalInput = (data: string): void => {
	for (const handler of terminalInputHandlers) handler(data);
};
const branch = [
	{ id: "root-user", type: "message", message: { role: "user", content: "older" } },
	{ id: "assistant-1", type: "message", message: { role: "assistant", content: "ok" } },
];
const commandCtx = {
	mode: "tui",
	sessionManager: { getBranch: () => branch },
	navigateTree: async (entryId: string) => {
		navigations.push(entryId);
		return { cancelled: false };
	},
	waitForIdle: async () => undefined,
	ui: {
		setEditorText: (value: string) => editorTexts.push(value),
		notify: () => undefined,
	},
};

escapeUnsend({
	on: (event: string, handler: Handler) => {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
	registerCommand: (
		name: string,
		options: { handler: (args: string, ctx: any) => Promise<void> },
	) => {
		commands.set(name, options);
	},
	sendUserMessage: (text: string, options?: { expandPromptTemplates?: boolean }) => {
		submitted.push(text);
		dispatchOptions.push(options);
		const command = commands.get(text.replace(/^\//, ""));
		if (!command) throw new Error(`missing command: ${text}`);
		pendingDispatches.push(command.handler("", commandCtx));
	},
} as any);

const emit = async (event: string, payload: any, ctx: any): Promise<void> => {
	for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
};

const flushTimers = async (): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await Promise.all(pendingDispatches.splice(0));
};

let editorInstallCalls = 0;
const ctx = {
	mode: "tui",
	isIdle: () => false,
	sessionManager: { getBranch: () => branch },
	ui: {
		onTerminalInput: (handler: (data: string) => unknown) => {
			terminalInputHandlers.push(handler);
			return () => undefined;
		},
		getEditorComponent: () => undefined,
		setEditorComponent: () => {
			editorInstallCalls += 1;
		},
		setEditorText: (text: string) => editorTexts.push(text),
		notify: (message: string) => {
			throw new Error(`unexpected notify: ${message}`);
		},
	},
};

await emit("session_start", {}, ctx);
assert(
	"session_start leaves the editor untouched when no custom editor exists yet",
	editorInstallCalls === 0,
	`editor installs: ${editorInstallCalls}`,
);

await emit("agent_start", {}, ctx);
await emit(
	"message_end",
	{
		message: { role: "user", content: "oops wrong prompt" },
	},
	ctx,
);
branch.push({
	id: "user-2",
	type: "message",
	message: { role: "user", content: "oops wrong prompt" },
});
emitTerminalInput("\x1b");
await emit(
	"message_end",
	{
		message: { role: "assistant", content: [], stopReason: "aborted" },
	},
	ctx,
);
await emit("agent_settled", {}, ctx);
await flushTimers();

assert(
	"an immediate abort submits /escape-unsend and restores only the new prompt",
	submitted.join(",") === "/escape-unsend" &&
		dispatchOptions[0]?.expandPromptTemplates === true &&
		navigations.join(",") === "user-2" &&
		editorTexts.join("|") === "oops wrong prompt",
	JSON.stringify({ submitted, dispatchOptions, navigations, editorTexts }),
);

submitted.length = 0;
navigations.length = 0;
editorTexts.length = 0;
await emit("agent_start", {}, ctx);
await emit(
	"message_end",
	{
		message: { role: "user", content: "real work" },
	},
	ctx,
);
branch.push({
	id: "user-3",
	type: "message",
	message: { role: "user", content: "real work" },
});
await emit(
	"message_update",
	{
		message: { role: "assistant", content: [{ type: "text", text: "Looking…" }] },
	},
	ctx,
);
emitTerminalInput("\x1b");
await emit(
	"message_end",
	{
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Looking…" }],
			stopReason: "aborted",
		},
	},
	ctx,
);
await emit("agent_settled", {}, ctx);
await flushTimers();

assert(
	"progress before abort leaves the turn in the thread",
	submitted.length === 0 && navigations.length === 0 && editorTexts.length === 0,
	JSON.stringify({ submitted, navigations, editorTexts }),
);

submitted.length = 0;
navigations.length = 0;
editorTexts.length = 0;
await emit("agent_start", {}, ctx);
await emit(
	"message_end",
	{
		message: { role: "user", content: "tool bound" },
	},
	ctx,
);
branch.push({
	id: "user-4",
	type: "message",
	message: { role: "user", content: "tool bound" },
});
await emit("tool_execution_start", { toolName: "read" }, ctx);
emitTerminalInput("\x1b");
await emit(
	"message_end",
	{
		message: { role: "assistant", content: [], stopReason: "aborted" },
	},
	ctx,
);
await emit("agent_settled", {}, ctx);
await flushTimers();

assert(
	"a tool call before abort blocks unsend",
	submitted.length === 0 && navigations.length === 0 && editorTexts.length === 0,
	JSON.stringify({ submitted, navigations, editorTexts }),
);

submitted.length = 0;
navigations.length = 0;
editorTexts.length = 0;
await emit("before_agent_start", {}, ctx);
await emit("agent_start", {}, ctx);
await emit(
	"message_end",
	{
		message: { role: "user", content: "long autonomous work" },
	},
	ctx,
);
branch.push({
	id: "user-5",
	type: "message",
	message: { role: "user", content: "long autonomous work" },
});
await emit(
	"message_update",
	{
		message: { role: "assistant", content: [{ type: "text", text: "changed files" }] },
	},
	ctx,
);
await emit(
	"message_end",
	{
		message: {
			role: "assistant",
			content: [{ type: "text", text: "changed files" }],
			stopReason: "stop",
		},
	},
	ctx,
);
// A continuation starts another low-level run without a new top-level prompt.
await emit("agent_start", {}, ctx);
emitTerminalInput("\x1b");
await emit(
	"message_end",
	{
		message: { role: "assistant", content: [], stopReason: "aborted" },
	},
	ctx,
);
await emit("agent_settled", {}, ctx);
await flushTimers();

assert(
	"work from an earlier low-level run blocks a later continuation abort",
	submitted.length === 0 && navigations.length === 0 && editorTexts.length === 0,
	JSON.stringify({ submitted, navigations, editorTexts }),
);

assert(
	"registers /escape-unsend as a manual fallback",
	commands.has("escape-unsend"),
	[...commands.keys()].join(","),
);

console.log("All escape-unsend tests passed.");

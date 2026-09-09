import conversationSeparator, {
	CONVERSATION_SEPARATOR_ENTRY_TYPE,
} from "../conversation-separator.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

const handlers = new Map<string, (event: any, context: any) => void>();
let renderer: ((entry: any, options: any, theme: any) => any) | undefined;
const entries: string[] = [];
const pi = {
	registerEntryRenderer: (_type: string, registered: typeof renderer) => {
		renderer = registered;
	},
	on: (event: string, handler: (event: any, context: any) => void) => {
		handlers.set(event, handler);
	},
	appendEntry: (type: string) => entries.push(type),
};

conversationSeparator(pi as any);

let color = "";
const rendered = renderer?.(
	{},
	{},
	{
		fg: (name: string, text: string) => {
			color = name;
			return text;
		},
	},
).render(12) as string[];
assert(
	"separator uses faint muted border styling at exact visible width",
	color === "borderMuted" &&
		rendered.length === 1 &&
		rendered[0] === ` \x1b[2m${"─".repeat(11)}\x1b[22m`,
	JSON.stringify({ color, rendered }),
);

let idle = true;
const context = {
	mode: "tui",
	isIdle: () => idle,
	sessionManager: { getEntries: () => [] },
};
const settled = handlers.get("agent_settled");
settled?.({}, context);
assert(
	"separator is deferred until settled handlers finish",
	entries.length === 0,
	JSON.stringify(entries),
);
await new Promise((resolve) => setTimeout(resolve, 0));
assert(
	"idle settlement appends one transcript-only entry",
	entries.length === 1 && entries[0] === CONVERSATION_SEPARATOR_ENTRY_TYPE,
	JSON.stringify(entries),
);

idle = false;
settled?.({}, context);
await new Promise((resolve) => setTimeout(resolve, 0));
assert(
	"follow-up work suppresses a premature separator",
	entries.length === 1,
	JSON.stringify(entries),
);

idle = true;
settled?.({}, context);
settled?.({}, context);
await new Promise((resolve) => setTimeout(resolve, 0));
assert(
	"duplicate settlement notifications coalesce",
	entries.length === 2,
	JSON.stringify(entries),
);

settled?.({}, context);
handlers.get("session_shutdown")?.({}, context);
await new Promise((resolve) => setTimeout(resolve, 0));
assert(
	"session shutdown cancels pending separators",
	entries.length === 2,
	JSON.stringify(entries),
);

settled?.({}, { ...context, mode: "print" });
await new Promise((resolve) => setTimeout(resolve, 0));
assert(
	"non-interactive runs do not persist visual separators",
	entries.length === 2,
	JSON.stringify(entries),
);

const historicalEntries = [
	{
		type: "custom_message",
		customType: "subagent-wake",
		display: false,
		content: "done",
	},
	{
		type: "custom",
		customType: "announce-step-activity",
		data: { toolCount: 0 },
	},
	{
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: " (blank) " }],
			stopReason: "stop",
		},
	},
	{
		type: "custom",
		id: "noop-separator",
		customType: CONVERSATION_SEPARATOR_ENTRY_TYPE,
	},
];
const noopContext = {
	...context,
	sessionManager: { getEntries: () => historicalEntries },
};
handlers.get("session_start")?.({}, noopContext);
const hiddenSeparator = renderer?.(
	historicalEntries[3],
	{},
	{ fg: (_name: string, text: string) => text },
).render(12) as string[];
settled?.({}, noopContext);
await new Promise((resolve) => setTimeout(resolve, 0));
assert(
	"no-op subagent wake turns hide historical separators and append no new separator",
	hiddenSeparator.length === 0 && entries.length === 2,
	JSON.stringify({ hiddenSeparator, entries }),
);

const toolEndingEntries = [
	{
		type: "custom_message",
		customType: "subagent-wake",
		display: false,
		content: "Subagent task done",
	},
	{
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", name: "subagent_result" }],
		},
	},
	{
		type: "message",
		message: {
			role: "toolResult",
			toolName: "subagent_result",
			content: [{ type: "text", text: "review evidence" }],
		},
	},
	{
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", name: "subagent_resume" }],
		},
	},
	{
		type: "message",
		message: {
			role: "toolResult",
			toolName: "subagent_resume",
			content: [{ type: "text", text: "Parent run will settle now" }],
		},
	},
];
const toolEndingContext = {
	...context,
	sessionManager: { getEntries: () => toolEndingEntries },
};
settled?.({}, toolEndingContext);
await new Promise((resolve) => setTimeout(resolve, 0));
assert(
	"hidden wake turns ending on a terminating tool result append no separator",
	entries.length === 2,
	JSON.stringify(entries),
);

const historicalToolEndingEntries = [
	...toolEndingEntries,
	{
		type: "custom",
		id: "tool-ending-separator",
		customType: CONVERSATION_SEPARATOR_ENTRY_TYPE,
	},
];
handlers.get("session_start")?.(
	{},
	{
		...context,
		sessionManager: { getEntries: () => historicalToolEndingEntries },
	},
);
const hiddenToolEndingSeparator = renderer?.(
	historicalToolEndingEntries.at(-1),
	{},
	{ fg: (_name: string, text: string) => text },
).render(12) as string[];
assert(
	"persisted separators after silent tool-ending wake turns stay hidden after resume",
	hiddenToolEndingSeparator.length === 0,
	JSON.stringify(hiddenToolEndingSeparator),
);

const visibleWakeContext = {
	...context,
	sessionManager: {
		getEntries: () => [
			toolEndingEntries[0],
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Review complete." }],
				},
			},
		],
	},
};
settled?.({}, visibleWakeContext);
await new Promise((resolve) => setTimeout(resolve, 0));
assert(
	"hidden wake turns retain a separator when they produce user-facing text",
	entries.length === 3,
	JSON.stringify(entries),
);

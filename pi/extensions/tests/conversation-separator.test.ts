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

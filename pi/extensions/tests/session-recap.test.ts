import { initTheme, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { completeDirectRequest } from "../lib/direct-completion.ts";
import { extractSessionEvidence } from "../lib/session-evidence.ts";
import sessionRecapExtension, {
	formatRecapUsage,
	RecapLoadingView,
	RecapView,
} from "../session-recap/index.ts";
import {
	buildRecapInput,
	isValidRecapMarkdown,
	prepareRecap,
	RECAP_ENTRY_TYPE,
	type RecapState,
} from "../session-recap/core.ts";

initTheme(undefined, false);

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

function recapMarkdown(focus: string): string {
	return [
		"# Session Recap",
		"## Started With",
		"Initial session work.",
		"## Evolution",
		"The implementation evolved.",
		"## Current Focus",
		focus,
		"## Progress",
		"Relevant progress was completed.",
		"## Remaining",
		"Continue the remaining work.",
	].join("\n");
}

const usage = {
	input: 100,
	output: 20,
	cacheRead: 900,
	cacheWrite: 0,
	totalTokens: 1_020,
	cost: { input: 0.0001, output: 0.0002, cacheRead: 0.00009, cacheWrite: 0, total: 0.00039 },
};

function entry(overrides: Record<string, unknown>): SessionEntry {
	return {
		type: "message",
		id: "entry",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		...overrides,
	} as SessionEntry;
}

const fixture = [
	entry({
		id: "u1",
		message: { role: "user", content: "Fix the login race", timestamp: 1 },
	}),
	entry({
		id: "a1",
		parentId: "u1",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I will inspect it." },
				{
					type: "toolCall",
					id: "t1",
					name: "future_tool",
					arguments: { secret: "do-not-include" },
				},
				{ type: "toolCall", id: "t2", name: "subagent", arguments: { task: "investigate" } },
				{ type: "toolCall", id: "t3", name: "future_tool", arguments: {} },
			],
			api: "test",
			provider: "test",
			model: "test",
			usage,
			stopReason: "toolUse",
			timestamp: 2,
		},
	}),
	entry({
		id: "tr1",
		parentId: "a1",
		message: {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "future_tool",
			content: [{ type: "text", text: "raw result must stay excluded" }],
			isError: false,
			timestamp: 3,
		},
	}),
	entry({
		id: "a2",
		parentId: "tr1",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "The race is isolated and the fix is ready." }],
			api: "test",
			provider: "test",
			model: "test",
			usage,
			stopReason: "stop",
			timestamp: 4,
		},
	}),
	entry({
		type: "custom",
		id: "ann-incomplete",
		parentId: "a2",
		customType: "announce-step-duration-update",
		data: { completed: false, step: "Ignore unfinished announcement" },
	}),
	entry({
		type: "custom",
		id: "ann1",
		parentId: "ann-incomplete",
		customType: "announce-step-duration-update",
		data: {
			completed: true,
			step: "Diagnose login race",
			toolCount: 4,
			changedFiles: ["src/login.ts"],
			checkCount: 1,
			failedChecks: 0,
			recoveredFailures: 1,
		},
	}),
] as SessionEntry[];

const extracted = extractSessionEvidence(fixture);
const extractedText = extracted.map((event) => event.text).join("\n");
assert(
	"extracts only user, generic tools, final response, and completed announcement",
	extractedText.includes("USER: Fix the login race") &&
		extractedText.includes("TOOLS: future_tool x2, subagent x1") &&
		extractedText.includes("AGENT: The race is isolated") &&
		extractedText.includes("WORK: Diagnose login race (4 tools, 1 file changed)") &&
		!extractedText.includes("checks") &&
		!extractedText.includes("recovered") &&
		!extractedText.includes("I will inspect") &&
		!extractedText.includes("do-not-include") &&
		!extractedText.includes("raw result") &&
		!extractedText.includes("unfinished"),
	extractedText,
);

const lengthEvents = extractSessionEvidence([
	entry({
		id: "length-output",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Useful progress before the output limit." }],
			api: "test",
			provider: "test",
			model: "test",
			usage,
			stopReason: "length",
			timestamp: 5,
		},
	}),
]);
assert(
	"retains useful length-terminated assistant output",
	lengthEvents.length === 1 && lengthEvents[0]?.text.includes("Useful progress"),
	JSON.stringify(lengthEvents),
);

const priorState: RecapState = {
	v: 1,
	recap: recapMarkdown("Previous history"),
	cursorEntryId: "ann1",
	generatedAt: 10,
};
const recapEntry = entry({
	type: "custom",
	id: "recap1",
	parentId: "ann1",
	customType: RECAP_ENTRY_TYPE,
	data: priorState,
});
assert(
	"validates recap structure and rejects echoed agent output",
	isValidRecapMarkdown(priorState.recap) &&
		isValidRecapMarkdown(priorState.recap.replace(/^# /gm, "## ").replace(/^## /gm, "### ")) &&
		!isValidRecapMarkdown("Here's what the code actually does: the widget stays visible."),
	priorState.recap,
);

const pollutedRecapEntry = entry({
	type: "custom",
	id: "polluted-recap",
	parentId: "recap1",
	customType: RECAP_ENTRY_TYPE,
	data: { ...priorState, recap: "Here's what the code actually does: echoed output." },
});
const recovered = prepareRecap([...fixture, recapEntry, pollutedRecapEntry]);
assert(
	"ignores a malformed latest recap and recovers the previous valid state",
	recovered.previous === priorState && recovered.events.length === 0,
	JSON.stringify(recovered),
);

const updatedBranch = [
	...fixture,
	recapEntry,
	entry({
		id: "u2",
		parentId: "recap1",
		message: { role: "user", content: "Now add a regression test", timestamp: 11 },
	}),
];
const prepared = prepareRecap(updatedBranch);
assert(
	"uses the latest recap and extracts only entries after its cursor",
	prepared.previous === priorState &&
		prepared.events.length === 1 &&
		prepared.events[0]?.text === "USER: Now add a regression test" &&
		prepared.cursorEntryId === "u2",
	JSON.stringify(prepared),
);

const largeInput = buildRecapInput({
	cursorEntryId: "last",
	events: [
		{ entryId: "first", text: `USER: original problem ${"a".repeat(4_000)}` },
		...Array.from({ length: 12 }, (_, index) => ({
			entryId: `middle-${index}`,
			text: `AGENT: middle ${index} ${"b".repeat(4_000)}`,
		})),
		{ entryId: "last", text: "USER: latest scope change" },
	],
});
assert(
	"bounded source keeps the original and latest activity",
	largeInput.length < 33_000 &&
		largeInput.includes("original problem") &&
		largeInput.includes("latest scope change") &&
		largeInput.includes("omitted for input limit"),
	String(largeInput.length),
);

const commands = new Map<string, any>();
const appended: Array<{ type: string; data: RecapState }> = [];
let toolRegistrations = 0;
let completeCalls = 0;
let invalidResponse = false;
let completeGate: Promise<void> | undefined;
const completionInputs: Array<{ context: any; options: any }> = [];
const selectedModels: any[] = [];
const utilityModel = {
	id: "utility-fast",
	provider: "utility-provider",
	name: "Utility Fast",
	reasoning: false,
	thinkingLevelMap: { off: "off" },
};
const utilityStore = {
	read: () => ({
		status: "configured",
		model: { provider: utilityModel.provider, id: utilityModel.id, thinkingLevel: "off" },
	}),
} as any;
const pi = {
	registerCommand: (name: string, command: any) => commands.set(name, command),
	registerTool: () => toolRegistrations++,
	appendEntry: (type: string, data: RecapState) => appended.push({ type, data }),
};

const fakeComplete = async (model: any, context: any, options: any) => {
	selectedModels.push(model);
	completeCalls++;
	completionInputs.push({ context, options });
	if (completeGate) await completeGate;
	return {
		role: "assistant",
		content: [
			{
				type: "text",
				text: invalidResponse
					? "Here's what the code actually does: echoed agent output."
					: recapMarkdown(`Generated version ${completeCalls}`),
			},
		],
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
};

let customStreamCalls = 0;
const customResponse = await completeDirectRequest(
	{
		complete: async (_model: unknown, context: unknown, requestOptions: unknown) => {
			customStreamCalls++;
			completionInputs.push({ context, options: requestOptions });
			return fakeComplete(null, null, null);
		},
	} as any,
	{ provider: "custom" } as any,
	{ messages: [] },
	{ maxTokens: 10 },
);
assert(
	"uses the coding-agent model runtime for custom providers",
	customStreamCalls === 1 && customResponse.stopReason === "stop",
	JSON.stringify({ customStreamCalls, stopReason: customResponse.stopReason }),
);
completionInputs.length = 0;
selectedModels.length = 0;
completeCalls = 0;

sessionRecapExtension(pi as any, {
	complete: fakeComplete as any,
	store: utilityStore,
});
assert(
	"registers only the recap command and no model-facing tool",
	commands.size === 1 && commands.has("recap") && toolRegistrations === 0,
	JSON.stringify({ commands: [...commands.keys()], toolRegistrations }),
);

let branch = [...fixture];
let idle = true;
let waitForIdleCalls = 0;
const notifications: Array<{ message: string; type: string }> = [];
const statuses = new Map<string, string>();
const tui = { terminal: { rows: 20 }, requestRender: () => undefined };
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};
const ctx = {
	mode: "tui",
	model: { id: "test-model", provider: "test-provider" },
	isIdle: () => idle,
	waitForIdle: async () => {
		waitForIdleCalls++;
	},
	sessionManager: { getBranch: () => branch },
	modelRegistry: {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: { test: "1" }, env: {} }),
		getProviderAuth: async () => undefined,
		find: (provider: string, id: string) =>
			provider === utilityModel.provider && id === utilityModel.id ? utilityModel : undefined,
		getRegisteredProviderConfig: () => undefined,
	},
	ui: {
		notify: (message: string, type: string) => notifications.push({ message, type }),
		setStatus: (id: string, value: string | undefined) => {
			if (value === undefined) statuses.delete(id);
			else statuses.set(id, value);
		},
		custom: (factory: any) =>
			new Promise((resolve) => {
				let component: any;
				const done = (value: unknown) => {
					component?.dispose?.();
					resolve(value);
				};
				component = factory(tui, theme, {}, done);
				if (component instanceof RecapView) done(undefined);
			}),
	},
};

let releaseCompletion!: () => void;
completeGate = new Promise<void>((resolve) => {
	releaseCompletion = resolve;
});
idle = false;
const immediateRecap = commands.get("recap").handler("", ctx);
const lateActiveEntry = entry({
	id: "late-active-entry",
	parentId: "ann1",
	message: { role: "user", content: "Late active work", timestamp: 12 },
});
branch = [...branch, lateActiveEntry];
for (let attempt = 0; attempt < 5 && completeCalls === 0; attempt++) await Promise.resolve();
await commands.get("recap").handler("", ctx);
assert(
	"starts recap immediately during an active run and rejects duplicate generation",
	completeCalls === 1 &&
		waitForIdleCalls === 0 &&
		!statuses.has("session-recap") &&
		!completionInputs[0].context.messages[0].content[0].text.includes("Late active work") &&
		!notifications.some(({ message }) => message.includes("queued until")) &&
		notifications.some(({ message }) => message.includes("already generating")),
	JSON.stringify({
		completeCalls,
		waitForIdleCalls,
		notifications,
		statuses: [...statuses],
		completionInputs,
	}),
);
idle = true;
releaseCompletion();
await immediateRecap;
completeGate = undefined;
assert(
	"direct generation uses the configured utility model and sends filtered source without Pi tools",
	completeCalls === 1 &&
		selectedModels[0] === utilityModel &&
		completionInputs[0].context.tools === undefined &&
		completionInputs[0].context.messages.length === 1 &&
		completionInputs[0].context.messages[0].content[0].text.includes("future_tool x2") &&
		!completionInputs[0].context.messages[0].content[0].text.includes("do-not-include") &&
		completionInputs[0].options.reasoning === undefined &&
		completionInputs[0].options.maxTokens === 900 &&
		!statuses.has("session-recap"),
	JSON.stringify(completionInputs[0]),
);
assert(
	"persists generated recap with cursor and usage",
	appended.length === 1 &&
		appended[0].type === RECAP_ENTRY_TYPE &&
		appended[0].data.cursorEntryId === "ann1" &&
		appended[0].data.recap.includes("Generated version 1") &&
		appended[0].data.usage?.cost === 0.00039 &&
		appended[0].data.usage?.cacheRead === 900 &&
		appended[0].data.usage?.model === "test/test" &&
		appended[0].data.usage?.effort === "off",
	JSON.stringify(appended),
);
assert(
	"formats generated and reused cost and cache status",
	formatRecapUsage(appended[0].data.usage, false) ===
		"Model test/test · Effort off\nInput 1,000 · Output 20 · Cache hit 900 (90%) · Cost $0.0004" &&
		formatRecapUsage({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.0002 }, false) ===
			"Model unavailable · Effort unknown\nInput 10 · Output 2 · Cache miss · Cost $0.0002" &&
		formatRecapUsage(appended[0].data.usage, true).includes("Original generation metrics") &&
		formatRecapUsage(undefined, true) ===
			"Model unavailable · Effort unknown\nInput unavailable · Output unavailable · Cache unavailable · Cost unavailable\nStored recap · No model call",
	JSON.stringify(appended[0].data.usage),
);

branch = [
	...fixture,
	entry({
		type: "custom",
		id: "stored1",
		parentId: "ann1",
		customType: RECAP_ENTRY_TYPE,
		data: appended[0].data,
	}),
];
await commands.get("recap").handler("", ctx);
assert(
	"unchanged recap displays from persistence without another model call",
	completeCalls === 1 && appended.length === 1,
	JSON.stringify({ completeCalls, appended: appended.length }),
);

branch = [
	...branch,
	lateActiveEntry,
	entry({
		id: "u3",
		parentId: "stored1",
		message: { role: "user", content: "Switch focus to session documentation", timestamp: 20 },
	}),
	entry({
		id: "a3",
		parentId: "u3",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Documentation work remains." }],
			api: "test",
			provider: "test",
			model: "test",
			usage,
			stopReason: "stop",
			timestamp: 21,
		},
	}),
];
await commands.get("recap").handler("", ctx);
const incrementalSource = completionInputs[1].context.messages[0].content[0].text as string;
assert(
	"incremental generation sends the previous recap and only new activity",
	completeCalls === 2 &&
		incrementalSource.includes("PREVIOUS RECAP") &&
		incrementalSource.includes("Generated version 1") &&
		incrementalSource.includes("Late active work") &&
		incrementalSource.includes("Switch focus") &&
		incrementalSource.includes("Documentation work remains") &&
		!incrementalSource.includes("Fix the login race"),
	incrementalSource,
);

const persistedBeforeInvalidResponse = appended.length;
branch = [
	...branch,
	entry({
		type: "custom",
		id: "stored2",
		parentId: "a3",
		customType: RECAP_ENTRY_TYPE,
		data: appended[1].data,
	}),
	entry({
		id: "u4",
		parentId: "stored2",
		message: { role: "user", content: "Capture one more update", timestamp: 22 },
	}),
];
invalidResponse = true;
await commands.get("recap").handler("", ctx);
assert(
	"rejects echoed provider output without polluting persisted recap state",
	appended.length === persistedBeforeInvalidResponse &&
		notifications.some(
			({ message, type }) => type === "error" && message.includes("nothing was saved"),
		),
	JSON.stringify({ appended: appended.length, notifications }),
);

let closed = false;
const view = new RecapView(
	tui as any,
	theme as any,
	"# Recap\n\n" + "line\n".repeat(30),
	formatRecapUsage(
		{
			input: 100,
			output: 20,
			cacheRead: 900,
			cacheWrite: 0,
			cost: 0.00039,
			model: "test/test",
			effort: "off",
		},
		false,
	),
	() => {
		closed = true;
	},
);
const rendered = view.render(40);
view.handleInput("q");
assert(
	"recap view is full-screen, bounded, and closable",
	rendered.length === 20 &&
		rendered[2]?.includes("Model test/test") &&
		rendered.some((line) => line.includes("Effort off")) &&
		rendered.some((line) => line.includes("Input 1,000")) &&
		rendered.some((line) => line.includes("Cache hit")) &&
		rendered.every((line) => visibleWidth(line) === 40) &&
		rendered.at(-1)?.trim() === "" &&
		closed,
	JSON.stringify({ lines: rendered.length, closed }),
);

let loadingClosed: unknown;
const loading = new RecapLoadingView(
	tui as any,
	theme as any,
	"test/test-model",
	(result) => {
		loadingClosed = result;
	},
	"off",
);
try {
	const loadingLines = loading.render(24);
	loading.handleInput("\x1b");
	assert(
		"recap loading state is full-screen and cancellable",
		loadingLines.length === 20 &&
			loadingLines.every((line) => visibleWidth(line) === 24) &&
			loadingClosed === null &&
			loadingLines.some((line) => line.includes("test/test-model")) &&
			loadingLines.some((line) => line.includes("pending")) &&
			loadingLines.some((line) => line.includes("Generating recap")),
		JSON.stringify({ loadingLines, loadingClosed }),
	);
} finally {
	loading.dispose();
}

const emptyView = new RecapView(
	tui as any,
	theme as any,
	"",
	formatRecapUsage(undefined, false),
	() => {},
);
const emptyLines = emptyView.render(32);
assert(
	"recap empty state remains full-screen and bounded",
	emptyLines.length === 20 &&
		emptyLines.every((line) => visibleWidth(line) === 32) &&
		emptyLines.some((line) => line.includes("No recap available")),
	JSON.stringify({ emptyLines }),
);

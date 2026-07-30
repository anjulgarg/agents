/**
 * Run: npm run test:extensions
 */

import {
	allocateBarWidths,
	buildContextBreakdown,
	CATEGORY_PASTEL_COLORS,
	buildToolCallLabelMap,
	classifyMessages,
	ContextViewComponent,
	estimateSystemBreakdown,
	estimateTextTokens,
	estimateToolDefinitionTokens,
	filterActiveTools,
	formatTokenCount,
	getActiveContextMessages,
	labelFromToolArgs,
	renderCapacityBar,
	scaleCategoryTokensToUsed,
	truncateContextLabel,
	topNWithRemainder,
} from "../context.ts";
import contextExtension from "../context.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

// --- classification and estimates ---

const messages = [
	{
		role: "user",
		content: "Hello world",
		timestamp: 1,
	},
	{
		role: "assistant",
		content: [
			{ type: "text", text: "Sure" },
			{
				type: "toolCall",
				id: "call_1",
				name: "bash",
				arguments: { command: "ls -la src" },
			},
			{
				type: "toolCall",
				id: "call_2",
				name: "read",
				arguments: { path: "/tmp/big.txt" },
			},
		],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	},
	{
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "bash",
		content: [{ type: "text", text: "a".repeat(400) }],
		isError: false,
		timestamp: 3,
	},
	{
		role: "toolResult",
		toolCallId: "call_2",
		toolName: "read",
		content: [{ type: "text", text: "b".repeat(40) }],
		isError: false,
		timestamp: 4,
	},
	{
		role: "user",
		content: "thanks",
		timestamp: 5,
	},
] as any[];

const classified = classifyMessages(messages);
assert(
	"classifies conversation vs tool results and counts turns",
	classified.turnCount === 2 &&
		classified.toolResults.length === 2 &&
		classified.conversationTokens > 0 &&
		classified.toolResults[0].tokens > classified.toolResults[1].tokens,
	JSON.stringify(classified),
);

const labels = buildToolCallLabelMap(messages);
assert(
	"labels tool results from assistant call arguments",
	labels.get("call_1") === "bash ls -la src" && labels.get("call_2") === "read /tmp/big.txt",
	JSON.stringify([...labels.entries()]),
);

assert(
	"labelFromToolArgs falls back safely",
	labelFromToolArgs("grep", undefined) === "grep" &&
		labelFromToolArgs("grep", { pattern: "TODO" }) === "grep TODO" &&
		labelFromToolArgs("x", { nested: { a: 1 } }) === "x",
	"fallback labels",
);

const longToolPath =
	"/repo/.cache/generated/vendor/node_modules/@scope/package/deep/components/something.tsx";
const longToolLabel = labelFromToolArgs("read", { path: longToolPath });
assert(
	"tool labels preserve full filenames until render time",
	longToolLabel === `read ${longToolPath}`,
	longToolLabel,
);
const widePathLabel = truncateContextLabel(longToolLabel, 70);
const narrowPathLabel = truncateContextLabel(longToolLabel, 40);
assert(
	"path labels preserve filenames and nearest directories after a leading ellipsis",
	widePathLabel.startsWith("read ...") &&
		narrowPathLabel.startsWith("read ...") &&
		widePathLabel.endsWith("something.tsx") &&
		narrowPathLabel.endsWith("something.tsx") &&
		visibleWidth(widePathLabel) === 70 &&
		visibleWidth(narrowPathLabel) === 40,
	JSON.stringify({ widePathLabel, narrowPathLabel }),
);

const system = estimateSystemBreakdown("BASE".repeat(100) + "\n" + "CTX".repeat(50), {
	cwd: "/tmp",
	contextFiles: [{ path: "AGENTS.md", content: "CTX".repeat(50) }],
	skills: [
		{
			name: "demo",
			description: "skill",
			filePath: "",
			baseDir: "",
			sourceInfo: {} as any,
			disableModelInvocation: false,
		},
	],
	appendSystemPrompt: "APPEND",
	promptGuidelines: ["Be brief"],
});
assert(
	"system breakdown includes meaningful option rows",
	system.total > 0 &&
		system.rows.some((r) => r.label === "Context files") &&
		system.rows.some((r) => r.label === "Skills") &&
		system.rows.some((r) => r.label === "Appended") &&
		system.rows.some((r) => r.label === "Guidelines") &&
		system.rows.some((r) => r.label === "Base prompt" || r.label === "Custom prompt"),
	JSON.stringify(system),
);

assert(
	"estimateTextTokens matches chars/4",
	estimateTextTokens("abcd") === 1 && estimateTextTokens("abcde") === 2,
	"token heuristic",
);

// --- top-five sorting / aggregation ---

const ranked = topNWithRemainder(
	[
		{ label: "a", tokens: 10 },
		{ label: "b", tokens: 50 },
		{ label: "c", tokens: 5 },
		{ label: "d", tokens: 40 },
		{ label: "e", tokens: 30 },
		{ label: "f", tokens: 20 },
		{ label: "g", tokens: 1 },
	],
	5,
);
assert(
	"top five sorts descending and aggregates remainder",
	ranked.top.map((t) => t.label).join(",") === "b,d,e,f,a" &&
		ranked.remainderCount === 2 &&
		ranked.remainderTokens === 6,
	JSON.stringify(ranked),
);

const toolDefinition = {
	name: "bash",
	description: "Run a shell command",
	parameters: { type: "object", properties: { command: { type: "string" } } },
};
const toolTokens = estimateToolDefinitionTokens({
	...toolDefinition,
	promptGuidelines: ["Prefer rg over grep"],
} as any);
assert("tool definition estimate is positive", toolTokens > 0, String(toolTokens));
assert(
	"tool definition excludes system-prompt guidelines",
	toolTokens === estimateToolDefinitionTokens(toolDefinition as any),
	String(toolTokens),
);

// --- active-tool filtering ---

const active = filterActiveTools(
	[
		{ name: "bash", description: "a" },
		{ name: "read", description: "b" },
		{ name: "sleep", description: "c" },
	] as any[],
	["bash", "read"],
);
assert(
	"filters to active tools only",
	active.map((t) => t.name).join(",") === "bash,read",
	JSON.stringify(active),
);

const breakdown = buildContextBreakdown({
	modelId: "gpt-test",
	contextWindow: 100_000,
	usage: { tokens: 12_000, percent: 12, contextWindow: 100_000 },
	systemPrompt: "You are helpful. " + "x".repeat(200),
	systemPromptOptions: {
		cwd: "/repo",
		contextFiles: [{ path: "README.md", content: "hi" }],
	},
	allTools: [
		{
			name: "bash",
			description: "shell " + "y".repeat(100),
			parameters: {},
			promptGuidelines: ["g"],
		},
		{ name: "read", description: "read", parameters: {} },
		{ name: "inactive", description: "z".repeat(5000), parameters: {} },
	] as any[],
	activeToolNames: ["bash", "read"],
	messages,
});
assert(
	"breakdown ignores inactive tools and uses usage for overall",
	breakdown.tools.activeCount === 2 &&
		!breakdown.tools.rows.some((r) => r.label === "inactive") &&
		breakdown.usedTokens === 12_000 &&
		breakdown.usedFromUsage === true &&
		breakdown.toolResults.callCount === 2 &&
		breakdown.conversation.turnCount === 2,
	JSON.stringify(breakdown),
);

// --- proportional colored bar / width safety ---

const widths = allocateBarWidths(
	{ system: 100, tools: 1, conversation: 1000, toolResults: 0 },
	10_000,
	40,
);
assert(
	"bar widths sum to requested width",
	widths.system + widths.tools + widths.conversation + widths.toolResults + widths.remaining === 40,
	JSON.stringify(widths),
);
assert(
	"tiny non-zero category remains distinguishable",
	widths.tools >= 1 && widths.toolResults === 0,
	JSON.stringify(widths),
);

const narrow = allocateBarWidths({ system: 1, tools: 1, conversation: 1, toolResults: 1 }, 100, 3);
assert(
	"narrow bar never overflows width",
	narrow.system + narrow.tools + narrow.conversation + narrow.toolResults + narrow.remaining === 3,
	JSON.stringify(narrow),
);

const lowEstimateSections = { system: 100, tools: 50, conversation: 200, toolResults: 50 }; // sum 400
const scaledTo12k = scaleCategoryTokensToUsed(lowEstimateSections, 12_000);
const scaledSum =
	scaledTo12k.system + scaledTo12k.tools + scaledTo12k.conversation + scaledTo12k.toolResults;
assert(
	"scales section mix to overall used while preserving ratios",
	Math.abs(scaledSum - 12_000) < 1e-6 &&
		Math.abs(scaledTo12k.system / scaledTo12k.tools - 2) < 1e-6 &&
		Math.abs(scaledTo12k.conversation / scaledTo12k.tools - 4) < 1e-6,
	JSON.stringify(scaledTo12k),
);

const barWidth = 100;
const matched = allocateBarWidths(lowEstimateSections, 100_000, barWidth, 12_000);
const colored = matched.system + matched.tools + matched.conversation + matched.toolResults;
assert(
	"12% overall usage yields ~12% colored bar even when estimates are much lower",
	colored === 12 &&
		colored + matched.remaining === barWidth &&
		matched.system > 0 &&
		matched.tools > 0 &&
		matched.conversation > 0 &&
		matched.toolResults > 0,
	JSON.stringify({ matched, colored }),
);

const fallback = allocateBarWidths(lowEstimateSections, 100_000, barWidth, null);
const fallbackColored =
	fallback.system + fallback.tools + fallback.conversation + fallback.toolResults;
assert(
	"unknown usage falls back to estimated section sum for bar fill",
	fallbackColored < colored && fallbackColored + fallback.remaining === barWidth,
	JSON.stringify({ fallback, fallbackColored, colored }),
);

const bar = renderCapacityBar(
	theme,
	{ system: 10, tools: 10, conversation: 10, toolResults: 10 },
	100,
	20,
	40,
);
assert(
	"rendered bar fits width and uses four distinct pastel colors",
	visibleWidth(bar) <= 20 &&
		bar.includes("█") &&
		new Set(Object.values(CATEGORY_PASTEL_COLORS)).size === 4 &&
		Object.values(CATEGORY_PASTEL_COLORS).every((color) => bar.includes(`\x1b[38;5;${color}m`)),
	JSON.stringify({ bar, colors: CATEGORY_PASTEL_COLORS, width: visibleWidth(bar) }),
);

assert(
	"formatTokenCount marks estimates",
	formatTokenCount(1500, true).startsWith("≈") && !formatTokenCount(200_000, false).includes("≈"),
	`${formatTokenCount(1500, true)} ${formatTokenCount(200_000, false)}`,
);

// --- compaction-aware context source ---

let branchCalled = false;
const sessionManager = {
	getBranch: () => {
		branchCalled = true;
		return [{ type: "message", message: { role: "user", content: "OLD", timestamp: 0 } }];
	},
	buildContextEntries: () => [
		{
			type: "message",
			id: "1",
			parentId: null,
			timestamp: "",
			message: { role: "user", content: "ACTIVE", timestamp: 1 },
		},
	],
};
const activeMessages = getActiveContextMessages(sessionManager as any);
assert(
	"uses buildContextEntries rather than full branch",
	!branchCalled && activeMessages.length === 1 && (activeMessages[0] as any).content === "ACTIVE",
	JSON.stringify(activeMessages),
);

// --- command registration / closing behavior ---

let registered:
	{ description: string; handler: (args: string, ctx: any) => Promise<void> } | undefined;
const notifications: Array<{ message: string; type?: string }> = [];
let customFactory: any;
let customOptions: any;
let closed = false;

contextExtension({
	registerCommand: (name: string, cmd: any) => {
		if (name === "context") registered = cmd;
	},
	getAllTools: () => [],
	getActiveTools: () => [],
} as any);

assert("registers /context command", Boolean(registered), "missing command");

await registered!.handler("", {
	mode: "rpc",
	ui: {
		notify: (message: string, type?: string) => notifications.push({ message, type }),
		custom: async () => undefined,
	},
	model: undefined,
	getContextUsage: () => undefined,
	getSystemPrompt: () => "",
	getSystemPromptOptions: () => ({ cwd: "/tmp" }),
	sessionManager: { buildContextEntries: () => [] },
});
assert(
	"non-TUI mode shows error notification",
	notifications.some((n) => n.type === "error" && n.message.includes("/context")),
	JSON.stringify(notifications),
);

await registered!.handler("", {
	mode: "tui",
	ui: {
		notify: () => undefined,
		custom: async (_fn: any, options: any) => {
			customFactory = _fn;
			customOptions = options;
			const component = _fn(
				{ terminal: { rows: 8 }, requestRender: () => undefined },
				theme,
				undefined,
				() => {
					closed = true;
				},
			);
			component.handleInput("\x1b"); // escape
			return undefined;
		},
	},
	model: { id: "m", contextWindow: 1000 },
	getContextUsage: () => ({ tokens: 10, percent: 1, contextWindow: 1000 }),
	getSystemPrompt: () => "sys",
	getSystemPromptOptions: () => ({ cwd: "/tmp" }),
	sessionManager: { buildContextEntries: () => [] },
});
assert(
	"TUI custom view uses a full-screen overlay and closes on Escape",
	closed &&
		Boolean(customFactory) &&
		customOptions?.overlay === true &&
		customOptions.overlayOptions.width === "100%" &&
		customOptions.overlayOptions.maxHeight === "100%",
	JSON.stringify({ closed, customOptions }),
);

closed = false;
const view = new ContextViewComponent(
	buildContextBreakdown({
		modelId: "m",
		contextWindow: 1000,
		usage: { tokens: null, percent: null },
		systemPrompt: "",
		allTools: [],
		activeToolNames: [],
		messages: [],
	}),
	theme,
	() => {
		closed = true;
	},
);
view.handleInput("\x03"); // ctrl+c
assert("view closes on Ctrl+C", closed, "ctrl+c");

const rendered = new ContextViewComponent(breakdown, theme, () => undefined).render(60);
assert(
	"rendered full-screen view uses standard chrome and one padded footer row",
	rendered.every((line) => visibleWidth(line) === 60) &&
		rendered.at(-1)?.trim() === "" &&
		rendered.at(-2)?.includes("Ctrl+C") &&
		rendered.at(-3)?.trim() !== "",
	rendered.join("\n"),
);
assert(
	"rendered lines fit width and include hierarchy",
	rendered.every((line) => visibleWidth(line) <= 60) &&
		rendered.some((l) => l.includes("Context")) &&
		rendered.some((l) => l.includes("SYSTEM")) &&
		rendered.some((l) => l.includes("TOOLS")) &&
		rendered.some((l) => l.includes("CONVERSATION")) &&
		rendered.some((l) => l.includes("TOOL RESULTS")) &&
		rendered.some((l) => l.includes("Free")) &&
		rendered.some((l) => l.includes("Esc")),
	rendered.join("\n"),
);
const toolsTitleLine = rendered.find((line) => line.includes("TOOLS"));
const toolRowLine = rendered.find((line) => line.includes("bash"));
assert(
	"context section rows align with their titles",
	Boolean(toolsTitleLine && toolRowLine) &&
		stripAnsi(toolsTitleLine!).indexOf("TOOLS") === stripAnsi(toolRowLine!).indexOf("bash"),
	JSON.stringify({ toolsTitleLine, toolRowLine }),
);

const longLabelBreakdown = {
	...breakdown,
	toolResults: {
		...breakdown.toolResults,
		callCount: 1,
		rows: [{ label: longToolLabel, tokens: 1234 }],
		remainderCount: 0,
		remainderTokens: 0,
	},
};
const wideLongLabel = new ContextViewComponent(longLabelBreakdown, theme, () => undefined)
	.render(80)
	.find((line) => line.includes("read ..."));
const narrowLongLabel = new ContextViewComponent(longLabelBreakdown, theme, () => undefined)
	.render(50)
	.find((line) => line.includes("read ..."));
assert(
	"context rows use available width and prefix truncated paths with three dots",
	Boolean(wideLongLabel && narrowLongLabel) &&
		wideLongLabel!.includes("read ...") &&
		narrowLongLabel!.includes("read ...") &&
		wideLongLabel!.includes("something.tsx") &&
		narrowLongLabel!.includes("something.tsx") &&
		visibleWidth(wideLongLabel!) === 80 &&
		visibleWidth(narrowLongLabel!) === 50,
	JSON.stringify({ wideLongLabel, narrowLongLabel }),
);
assert(
	"context header truncates without an ellipsis",
	!rendered.find((line) => line.includes("Context"))?.endsWith("..."),
	rendered.join("\n"),
);

const emptyRendered = new ContextViewComponent(
	buildContextBreakdown({
		allTools: [],
		activeToolNames: [],
		messages: [],
	}),
	theme,
	() => undefined,
).render(40);
assert(
	"handles no model / empty session",
	emptyRendered.some((l) => l.includes("No model")) &&
		emptyRendered.every((l) => visibleWidth(l) <= 40),
	emptyRendered.join("\n"),
);

const tinyRendered = new ContextViewComponent(breakdown, theme, () => undefined, {
	terminal: { rows: 3 },
	requestRender: () => undefined,
} as any).render(20);
assert(
	"handles narrow terminals and tiny heights",
	tinyRendered.length === 3 && tinyRendered.every((line) => visibleWidth(line) === 20),
	tinyRendered.map((line) => `${visibleWidth(line)}:${line}`).join("\n"),
);

console.log("\nAll context tests passed.");

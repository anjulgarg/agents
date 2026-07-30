import { visibleWidth } from "@earendil-works/pi-tui";
import codexWebSearch, { normalizeSearchQueries } from "../codex-web-search.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

const tools = new Map<string, any>();
let activeTools = ["read", "codex_web_search", "ollama_web_search", "ollama_web_fetch"];
const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
codexWebSearch({
	registerTool: (definition: any) => {
		tools.set(definition.name, definition);
	},
	getActiveTools: () => [...activeTools],
	setActiveTools: (next: string[]) => {
		activeTools = next;
	},
	on: (event: string, handler: (event: any, ctx: any) => void) => {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
} as any);

function emit(event: string, payload: any = {}, ctx: any = {}): void {
	for (const handler of handlers.get(event) ?? []) {
		handler(payload, ctx);
	}
}

const codexTool = tools.get("codex_web_search");
const ollamaSearch = tools.get("ollama_web_search");
const ollamaFetch = tools.get("ollama_web_fetch");

emit("session_start", {}, { model: { provider: "openai-codex" } });
assert(
	"activates only Codex search for OpenAI Codex models",
	activeTools.includes("codex_web_search") &&
		!activeTools.includes("ollama_web_search") &&
		!activeTools.includes("ollama_web_fetch"),
	activeTools.join(","),
);
emit("model_select", { model: { provider: "ollama" } });
assert(
	"activates Ollama web tools for Ollama models",
	!activeTools.includes("codex_web_search") &&
		activeTools.includes("ollama_web_search") &&
		activeTools.includes("ollama_web_fetch"),
	activeTools.join(","),
);
emit("model_select", { model: { provider: "kimi-coding" } });
assert(
	"deactivates provider-specific web tools for other models",
	!["codex_web_search", "ollama_web_search", "ollama_web_fetch"].some((name) =>
		activeTools.includes(name),
	),
	activeTools.join(","),
);

assert(
	"registers renamed Ollama tools instead of generic web_search names",
	Boolean(codexTool && ollamaSearch && ollamaFetch) &&
		!tools.has("web_search") &&
		!tools.has("web_fetch"),
	[...tools.keys()].join(","),
);

assert(
	"normalizes query and queries into a search list",
	normalizeSearchQueries({ query: " alpha " }).join("|") === "alpha" &&
		normalizeSearchQueries({ queries: ["a", " b "] }).join("|") === "a|b" &&
		normalizeSearchQueries({ query: "ignored", queries: ["keep"] }).join("|") === "keep",
	JSON.stringify({
		query: normalizeSearchQueries({ query: " alpha " }),
		queries: normalizeSearchQueries({ queries: ["a", " b "] }),
		preferQueries: normalizeSearchQueries({ query: "ignored", queries: ["keep"] }),
	}),
);

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;
const success = { content: [{ type: "text", text: "Detailed results\nwith sources" }] };

assert("uses no-background shell", codexTool.renderShell === "self", String(codexTool.renderShell));

emit("turn_start");
const firstCall = codexTool
	.renderCall(
		{ query: "current TypeScript release and detailed compatibility information" },
		theme,
		{ toolCallId: "search-1", expanded: false, isError: false, invalidate: () => undefined },
	)
	.render(80);
const secondCall = ollamaSearch
	.renderCall(
		{ queries: ["TypeScript 5.8 compatibility", "tsconfig moduleResolution bundler"] },
		theme,
		{ toolCallId: "search-2", expanded: false, isError: false, invalidate: () => undefined },
	)
	.render(80);
const firstCallAfter = codexTool
	.renderCall(
		{ query: "current TypeScript release and detailed compatibility information" },
		theme,
		{ toolCallId: "search-1", expanded: false, isError: false, invalidate: () => undefined },
	)
	.render(80);

assert(
	"each Codex/Ollama search renders its own collapsed row with the last query",
	firstCall.length === 1 &&
		secondCall.length === 1 &&
		firstCallAfter.length === 1 &&
		firstCall[0].includes("web search") &&
		firstCall[0].includes("current TypeScript release") &&
		secondCall[0].includes("web search") &&
		!secondCall[0].includes("· 3 ·") &&
		secondCall[0].includes("tsconfig moduleResolution bundler") &&
		visibleWidth(secondCall[0]) <= 80,
	JSON.stringify({ firstCall, secondCall, firstCallAfter }),
);

const collapsedResult = codexTool
	.renderResult(success, { expanded: false }, theme, { expanded: false, isError: false })
	.render(40);
assert(
	"collapsed successful results stay hidden",
	collapsedResult.length === 0,
	JSON.stringify(collapsedResult),
);

const expandedCall = codexTool
	.renderCall({ query: "current TypeScript release" }, theme, {
		toolCallId: "search-3",
		expanded: true,
		isError: false,
		invalidate: () => undefined,
	})
	.render(80)
	.join("\n");
const expandedBatchCall = ollamaSearch
	.renderCall({ queries: ["one", "two"] }, theme, {
		toolCallId: "search-4",
		expanded: true,
		isError: false,
		invalidate: () => undefined,
	})
	.render(80)
	.join("\n");
const expandedResult = codexTool
	.renderResult(success, { expanded: true }, theme, { expanded: true, isError: false })
	.render(80)
	.join("\n");
assert(
	"Ctrl+O reveals each row's own query list and complete result",
	expandedCall.includes("current TypeScript release") &&
		expandedBatchCall.includes("web search · 2") &&
		expandedBatchCall.includes("1. one") &&
		expandedBatchCall.includes("2. two") &&
		expandedResult.includes("Detailed results") &&
		expandedResult.includes("with sources"),
	JSON.stringify({ expandedCall, expandedBatchCall, expandedResult }),
);

const failed = codexTool
	.renderResult(
		{ content: [{ type: "text", text: "Authentication failed\nMore detail" }] },
		{ expanded: false },
		theme,
		{ expanded: false, isError: true },
	)
	.render(32);
assert(
	"collapsed errors remain visible without exposing the successful result body",
	failed.join("\n").includes("Authentication failed"),
	JSON.stringify(failed),
);

emit("tool_execution_start", { toolName: "bash", toolCallId: "bash-1" });
const afterBreak = ollamaSearch
	.renderCall({ query: "fresh streak query" }, theme, {
		toolCallId: "search-5",
		expanded: false,
		isError: false,
		invalidate: () => undefined,
	})
	.render(40);
assert(
	"each search call stays on its own row after unrelated tools",
	afterBreak.length === 1 &&
		!afterBreak[0].includes("· 1 ·") &&
		afterBreak[0].includes("web search fresh streak query"),
	JSON.stringify(afterBreak),
);

const fetchCollapsed = ollamaFetch
	.renderCall({ url: "https://example.com/docs" }, theme, {
		toolCallId: "fetch-1",
		expanded: false,
		isError: false,
		invalidate: () => undefined,
	})
	.render(40);
assert(
	"ollama web fetch stays compact when collapsed",
	fetchCollapsed.length === 1 && fetchCollapsed[0].includes("web fetch"),
	JSON.stringify(fetchCollapsed),
);

emit("turn_start");
const liveAfterTurn = codexTool
	.renderCall({ query: "live turn query" }, theme, {
		toolCallId: "search-live",
		expanded: false,
		isError: false,
		executionStarted: true,
		invalidate: () => undefined,
	})
	.render(80);
const historicalAfterTurn = codexTool
	.renderCall({ query: "old historical query" }, theme, {
		toolCallId: "search-1",
		expanded: false,
		isError: false,
		executionStarted: false,
		invalidate: () => undefined,
	})
	.render(80);
const liveAfterHistoricalPaint = codexTool
	.renderCall({ query: "live turn query" }, theme, {
		toolCallId: "search-live",
		expanded: false,
		isError: false,
		executionStarted: true,
		invalidate: () => undefined,
	})
	.render(80);
assert(
	"turn_start keeps each call on its own row in live and historical paints",
	liveAfterTurn.length === 1 &&
		liveAfterTurn[0].includes("web search live turn query") &&
		historicalAfterTurn.length === 1 &&
		historicalAfterTurn[0].includes("web search old historical query") &&
		liveAfterHistoricalPaint.length === 1 &&
		liveAfterHistoricalPaint[0].includes("web search live turn query") &&
		![liveAfterTurn, historicalAfterTurn, liveAfterHistoricalPaint].some((rows) =>
			rows[0].includes("· 1 ·"),
		),
	JSON.stringify({ liveAfterTurn, historicalAfterTurn, liveAfterHistoricalPaint }),
);

emit("turn_start");
const batchCollapsed = codexTool
	.renderCall({ queries: ["alpha", "beta", "gamma"] }, theme, {
		toolCallId: "search-batch",
		expanded: false,
		isError: false,
		executionStarted: true,
		invalidate: () => undefined,
	})
	.render(80);
assert(
	"a batched collapsed call shows the last query without a streak count",
	batchCollapsed.length === 1 &&
		!batchCollapsed[0].includes("· 3 ·") &&
		batchCollapsed[0].includes("gamma"),
	JSON.stringify({ batchCollapsed }),
);

emit("turn_start");
const multiA = ollamaSearch
	.renderCall({ queries: ["one", "two"] }, theme, {
		toolCallId: "multi-a",
		expanded: false,
		isError: false,
		executionStarted: true,
		invalidate: () => undefined,
	})
	.render(80);
const multiB = ollamaSearch
	.renderCall({ query: "three" }, theme, {
		toolCallId: "multi-b",
		expanded: false,
		isError: false,
		executionStarted: true,
		invalidate: () => undefined,
	})
	.render(80);
const expandA = ollamaSearch
	.renderCall({ queries: ["one", "two"] }, theme, {
		toolCallId: "multi-a",
		expanded: true,
		isError: false,
		executionStarted: true,
		invalidate: () => undefined,
	})
	.render(80)
	.join("\n");
const expandB = ollamaSearch
	.renderCall({ query: "three" }, theme, {
		toolCallId: "multi-b",
		expanded: true,
		isError: false,
		executionStarted: true,
		invalidate: () => undefined,
	})
	.render(80)
	.join("\n");
const collapseA = ollamaSearch
	.renderCall({ queries: ["one", "two"] }, theme, {
		toolCallId: "multi-a",
		expanded: false,
		isError: false,
		executionStarted: true,
		invalidate: () => undefined,
	})
	.render(80);
const collapseB = ollamaSearch
	.renderCall({ query: "three" }, theme, {
		toolCallId: "multi-b",
		expanded: false,
		isError: false,
		executionStarted: true,
		invalidate: () => undefined,
	})
	.render(80);
assert(
	"Ctrl+O expand/collapse keeps each call on its own row",
	multiA.length === 1 &&
		multiB.length === 1 &&
		!multiA[0].includes("· 2 ·") &&
		!multiB[0].includes("· 3 ·") &&
		expandA.includes("web search · 2 queries") &&
		expandB.includes("three") &&
		collapseA.length === 1 &&
		collapseA[0].includes("two") &&
		collapseB.length === 1 &&
		collapseB[0].includes("three"),
	JSON.stringify({ multiA, multiB, expandA, expandB, collapseA, collapseB }),
);

/**
 * Shared minimal tool presentation tests.
 *
 * Run: npx tsx pi/extensions/lib/minimal-tool-presentation.test.ts
 */
import { initTheme } from "@earendil-works/pi-coding-agent";
import { seedSessionTopology } from "./tui/index.ts";
import minimalMode from "../minimal-mode.ts";
import {
	MINIMAL_TOOL_NAMES,
	createMinimalToolPresentations,
	type MinimalToolPresentation,
} from "./minimal-tool-presentation.ts";

initTheme();

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

type Handler = (event?: any, ctx?: any) => unknown | Promise<unknown>;

const handlers = new Map<string, Handler[]>();
const registered: Array<{
	name: string;
	renderCall?: (...args: any[]) => any;
	renderResult?: (...args: any[]) => any;
	execute?: unknown;
	parameters?: unknown;
}> = [];
minimalMode({
	registerTool: (tool: any) => registered.push(tool),
	on: (event: string, handler: Handler) => {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
} as any);
const emit = (event: string, payload: any = {}, ctx: any = {}) => {
	for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
};
emit("session_start");

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

type Component = { render(width: number): string[] };

function text(component: Component | undefined, width = 80): string {
	return (component?.render(width) ?? []).join("\n");
}

function liveContext(
	toolCallId: string,
	args: Record<string, unknown>,
	overrides: Record<string, unknown> = {},
) {
	return {
		args,
		toolCallId,
		invalidate: () => undefined,
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: true,
		expanded: false,
		showImages: true,
		isError: false,
		...overrides,
	};
}

function historicalContext(
	toolCallId: string,
	args: Record<string, unknown>,
	overrides: Record<string, unknown> = {},
) {
	return liveContext(toolCallId, args, { executionStarted: false, isPartial: false, ...overrides });
}

function parentTool(name: string) {
	const tool = registered.find((candidate) => candidate.name === name)!;
	return {
		renderCall: tool.renderCall,
		renderResult: tool.renderResult,
	};
}

// ---------------------------------------------------------------------------
// AC1: render-only registry with exactly the seven supported tools
// ---------------------------------------------------------------------------
{
	const bundle = createMinimalToolPresentations();
	const names = Object.keys(bundle.presentations).sort();
	assert(
		"registry exposes exactly read, bash, write, edit, find, grep, and ls",
		names.join(",") === [...MINIMAL_TOOL_NAMES].sort().join(","),
		JSON.stringify(names),
	);
	for (const name of MINIMAL_TOOL_NAMES) {
		const presentation = bundle.presentations[name];
		assert(
			`${name} is render-only with call and result callbacks`,
			typeof presentation.renderCall === "function" &&
				typeof presentation.renderResult === "function" &&
				(presentation as MinimalToolPresentation & { execute?: unknown }).execute === undefined &&
				(presentation as MinimalToolPresentation & { parameters?: unknown }).parameters ===
					undefined,
			JSON.stringify(Object.keys(presentation)),
		);
	}
	assert(
		"unsupported tools stay outside the registry",
		!(bundle.presentations as unknown as Record<string, unknown>)["announce_step"] &&
			!(bundle.presentations as unknown as Record<string, unknown>)["question"],
		"unexpected extra tool",
	);
	assert(
		"bundle carries its own tracker and reset",
		typeof bundle.tracker.has === "function" && typeof bundle.reset === "function",
		"missing per-view state",
	);
}

// ---------------------------------------------------------------------------
// AC2 + AC6: parent minimal mode delegates to the shared presentations
// ---------------------------------------------------------------------------
{
	const bundle = createMinimalToolPresentations();
	const resetAll = () => {
		emit("session_start");
		bundle.tracker.reset();
		bundle.reset();
	};

	const scenarios: Array<{
		name: string;
		tool: string;
		run: (presentation: { renderCall?: any; renderResult?: any }) => string;
	}> = [
		{
			name: "read collapsed call",
			tool: "read",
			run: (p) =>
				text(
					p.renderCall(
						{ path: "src/a.ts" },
						theme,
						liveContext("compat-read", { path: "src/a.ts" }),
					),
				),
		},
		{
			name: "read expanded result",
			tool: "read",
			run: (p) =>
				text(
					p.renderResult(
						{ content: [{ type: "text", text: "line one\nline two" }] },
						{ expanded: true, isPartial: false },
						theme,
						liveContext(
							"compat-read-expanded",
							{ path: "src/a.ts" },
							{ expanded: true, isPartial: false },
						),
					),
				),
		},
		{
			name: "bash running call",
			tool: "bash",
			run: (p) =>
				text(
					p.renderCall(
						{ command: "bun test", timeout: undefined },
						theme,
						liveContext("compat-bash", { command: "bun test" }),
					),
				),
		},
		{
			name: "bash failed result",
			tool: "bash",
			run: (p) =>
				text(
					p.renderResult(
						{ content: [{ type: "text", text: "Command exited with code 1" }] },
						{ expanded: false, isPartial: false },
						theme,
						liveContext(
							"compat-bash-fail",
							{ command: "exit 1" },
							{ isPartial: false, isError: true },
						),
					),
				),
		},
		{
			name: "bash expanded output",
			tool: "bash",
			run: (p) =>
				text(
					p.renderResult(
						{ content: [{ type: "text", text: "alpha\nbeta" }] },
						{ expanded: true, isPartial: false },
						theme,
						liveContext(
							"compat-bash-expanded",
							{ command: "echo hi" },
							{ expanded: true, isPartial: false },
						),
					),
				),
		},
		{
			name: "write settled result",
			tool: "write",
			run: (p) =>
				text(
					p.renderResult(
						{ content: [{ type: "text", text: "Wrote 2 lines" }] },
						{ expanded: false, isPartial: false },
						theme,
						liveContext(
							"compat-write",
							{ path: "src/new.ts", content: "a\nb" },
							{ isPartial: false },
						),
					),
				),
		},
		{
			name: "edit settled receipt",
			tool: "edit",
			run: (p) =>
				text(
					p.renderResult(
						{ content: [{ type: "text", text: "done" }], details: { diff: "-1 old\n+1 new" } },
						{ expanded: false, isPartial: false },
						theme,
						liveContext("compat-edit", { path: "src/b.ts", edits: [] }, { isPartial: false }),
					),
				),
		},
		{
			name: "edit expanded diff",
			tool: "edit",
			run: (p) =>
				text(
					p.renderResult(
						{ content: [{ type: "text", text: "done" }], details: { diff: "-1 old\n+1 new" } },
						{ expanded: true, isPartial: false },
						theme,
						liveContext(
							"compat-edit-expanded",
							{ path: "src/b.ts", edits: [] },
							{
								expanded: true,
								isPartial: false,
							},
						),
					),
				),
		},
		{
			name: "find call",
			tool: "find",
			run: (p) =>
				text(
					p.renderCall(
						{ pattern: "*.ts", path: "src" },
						theme,
						liveContext("compat-find", { pattern: "*.ts", path: "src" }),
					),
				),
		},
		{
			name: "grep call with limit",
			tool: "grep",
			run: (p) =>
				text(
					p.renderCall(
						{ pattern: "needle", path: "src", limit: 50 },
						theme,
						liveContext("compat-grep", { pattern: "needle", path: "src", limit: 50 }),
					),
				),
		},
		{
			name: "ls call",
			tool: "ls",
			run: (p) =>
				text(p.renderCall({ path: "src" }, theme, liveContext("compat-ls", { path: "src" }))),
		},
	];

	for (const scenario of scenarios) {
		resetAll();
		const parentOutput = scenario.run(parentTool(scenario.tool));
		resetAll();
		const sharedOutput = scenario.run(
			bundle.presentations[scenario.tool as keyof typeof bundle.presentations],
		);
		assert(
			`parent ${scenario.name} matches the shared presentation`,
			parentOutput === sharedOutput,
			`parent:\n${parentOutput}\nshared:\n${sharedOutput}`,
		);
	}
}

// ---------------------------------------------------------------------------
// AC3: deterministic topology seeding from ordered messages
// ---------------------------------------------------------------------------
function seededTranscript() {
	return [
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "seed-read-1", name: "read", arguments: { path: "src/one.ts" } },
			],
		},
		{
			role: "toolResult",
			toolCallId: "seed-read-1",
			toolName: "read",
			content: [],
			isError: false,
		},
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "seed-read-2", name: "read", arguments: { path: "src/two.ts" } },
			],
		},
		{
			role: "toolResult",
			toolCallId: "seed-read-2",
			toolName: "read",
			content: [],
			isError: false,
		},
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "seed-step", name: "announce_step", arguments: {} }],
		},
		{
			role: "toolResult",
			toolCallId: "seed-step",
			toolName: "announce_step",
			content: [],
			isError: false,
		},
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "seed-read-3", name: "read", arguments: { path: "src/three.ts" } },
			],
		},
		{
			role: "toolResult",
			toolCallId: "seed-read-3",
			toolName: "read",
			content: [],
			isError: false,
		},
		{ role: "assistant", content: [{ type: "text", text: "Here is a summary." }] },
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "seed-grep-1",
					name: "grep",
					arguments: { pattern: "needle", path: "src" },
				},
			],
		},
		{
			role: "toolResult",
			toolCallId: "seed-grep-1",
			toolName: "grep",
			content: [],
			isError: false,
		},
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "seed-grep-fail",
					name: "grep",
					arguments: { pattern: "missing", path: "src" },
				},
			],
		},
		{
			role: "toolResult",
			toolCallId: "seed-grep-fail",
			toolName: "grep",
			content: [{ type: "text", text: "Path not found" }],
			isError: true,
		},
	];
}

{
	const bundle = createMinimalToolPresentations();
	seedSessionTopology(seededTranscript(), bundle.tracker, ["read", "find", "grep", "ls", "edit"], {
		nonBreakingToolNames: ["announce_step"],
	});

	const reads: Record<string, string> = {};
	for (const [id, path] of [
		["seed-read-1", "src/one.ts"],
		["seed-read-2", "src/two.ts"],
		["seed-read-3", "src/three.ts"],
	] as const) {
		reads[id] = text(
			bundle.presentations.read.renderCall({ path }, theme, historicalContext(id, { path })),
		);
	}
	assert(
		"consecutive reads group across announce_step into one streak",
		reads["seed-read-1"] === "" &&
			reads["seed-read-2"] === "" &&
			reads["seed-read-3"].includes("read") &&
			reads["seed-read-3"].includes("├─ src/one.ts") &&
			reads["seed-read-3"].includes("├─ src/two.ts") &&
			reads["seed-read-3"].includes("└─ src/three.ts"),
		JSON.stringify(reads),
	);

	const grepRow = text(
		bundle.presentations.grep.renderCall(
			{ pattern: "needle", path: "src" },
			theme,
			historicalContext("seed-grep-1", { pattern: "needle", path: "src" }),
		),
	);
	assert(
		"visible prose breaks the streak; the later grep renders standalone",
		grepRow.includes("grep /needle/ in src") && !grepRow.includes("├─"),
		JSON.stringify(grepRow),
	);

	const failedGrep = text(
		bundle.presentations.grep.renderResult(
			{ content: [{ type: "text", text: "Path not found: /src/missing\nmore detail" }] },
			{ expanded: false, isPartial: false },
			theme,
			historicalContext("seed-grep-fail", { pattern: "missing", path: "src" }, { isError: true }),
		),
	);
	assert(
		"a failed seeded call renders separately and stays attributable",
		failedGrep.includes("× Path not found: /src/missing") && !failedGrep.includes("more detail"),
		JSON.stringify(failedGrep),
	);
}

// ---------------------------------------------------------------------------
// AC4: reverse and repeated historical repaint keeps topology stable
// ---------------------------------------------------------------------------
{
	const bundle = createMinimalToolPresentations();
	seedSessionTopology(seededTranscript(), bundle.tracker, ["read", "find", "grep", "ls", "edit"], {
		nonBreakingToolNames: ["announce_step"],
	});

	const readArgs = new Map([
		["seed-read-1", { path: "src/one.ts" }],
		["seed-read-2", { path: "src/two.ts" }],
		["seed-read-3", { path: "src/three.ts" }],
	]);
	const renderPass = (order: string[]): Record<string, string> => {
		const rows: Record<string, string> = {};
		for (const id of order) {
			const args = readArgs.get(id)!;
			rows[id] = text(
				bundle.presentations.read.renderCall(args, theme, historicalContext(id, args)),
			);
		}
		return rows;
	};

	const forward = renderPass(["seed-read-1", "seed-read-2", "seed-read-3"]);
	const reverse = renderPass(["seed-read-3", "seed-read-2", "seed-read-1"]);
	const repeated = renderPass(["seed-read-1", "seed-read-2", "seed-read-3"]);
	const leaderOutputs = [forward, reverse, repeated].map((rows) => rows["seed-read-3"]);
	const branches = (output: string) => (output.match(/[├└]─/g) ?? []).length;

	assert(
		"every repaint order renders the same three-child tree without duplicates",
		leaderOutputs.every(
			(output) =>
				branches(output) === 3 &&
				output.includes("├─ src/one.ts") &&
				output.includes("├─ src/two.ts") &&
				output.includes("└─ src/three.ts"),
		) &&
			// Reverse repaint still lists the durable order, not the render order.
			reverse["seed-read-3"].indexOf("src/one.ts") <
				reverse["seed-read-3"].indexOf("src/three.ts") &&
			leaderOutputs.every((output) => output === leaderOutputs[0]),
		JSON.stringify(leaderOutputs),
	);
	assert(
		"repeated repaint never duplicates non-leader rows",
		forward["seed-read-1"] === "" &&
			reverse["seed-read-1"] === "" &&
			repeated["seed-read-1"] === "" &&
			repeated["seed-read-2"] === "",
		JSON.stringify({ forward: forward["seed-read-1"], reverse: reverse["seed-read-1"] }),
	);
}

// ---------------------------------------------------------------------------
// AC5: failures keep their own row; collapsed neighbors stay compact
// ---------------------------------------------------------------------------
{
	const bundle = createMinimalToolPresentations();
	const grepTool = bundle.presentations.grep;

	grepTool.renderCall(
		{ pattern: "alpha", path: "src" },
		theme,
		liveContext("fail-grep-1", { pattern: "alpha", path: "src" }),
	);
	const running = liveContext("fail-grep-2", { pattern: "renderPad(", path: "src" });
	grepTool.renderCall({ pattern: "renderPad(", path: "src" }, theme, running);
	// The settled error renderCall drops the failed call, leaving a boundary.
	const failedContext = { ...running, isPartial: false, isError: true };
	grepTool.renderCall({ pattern: "renderPad(", path: "src" }, theme, failedContext);
	const failRow = text(
		grepTool.renderResult(
			{ content: [{ type: "text", text: "Path not found: /x\nfull detail" }] },
			{ expanded: false, isPartial: false },
			theme,
			failedContext,
		),
	);
	const following = text(
		grepTool.renderCall(
			{ pattern: "beta", path: "lib" },
			theme,
			liveContext("fail-grep-3", { pattern: "beta", path: "lib" }),
		),
	);
	assert(
		"a failed collapsed call stays visible while the next call stays compact",
		failRow.includes("× Path not found: /x") &&
			!failRow.includes("full detail") &&
			following.includes("grep /beta/ in lib") &&
			!following.includes("├─"),
		JSON.stringify({ failRow, following }),
	);
}

// ---------------------------------------------------------------------------
// AC4 + AC5: two simultaneous instances never share topology or activity
// ---------------------------------------------------------------------------
{
	const bundleA = createMinimalToolPresentations();
	const bundleB = createMinimalToolPresentations();

	const read = (
		bundle: ReturnType<typeof createMinimalToolPresentations>,
		id: string,
		path: string,
		overrides = {},
	) =>
		text(
			bundle.presentations.read.renderCall({ path }, theme, liveContext(id, { path }, overrides)),
		);

	// Identical tool-call IDs drive both views.
	const firstA = read(bundleA, "shared-read-1", "src/one.ts");
	read(bundleA, "shared-read-2", "src/two.ts");
	const leaderA = read(bundleA, "shared-read-3", "src/three.ts");

	// View B interleaves an ungrouped boundary, so only its own events count.
	read(bundleB, "shared-read-1", "src/one.ts");
	bundleB.tracker.noteBreak();
	read(bundleB, "shared-read-2", "src/two.ts");
	const leaderB = read(bundleB, "shared-read-3", "src/three.ts");

	assert(
		"instances with identical tool-call IDs keep separate grouping state",
		firstA.includes("src/one.ts") &&
			leaderA.includes("├─ src/one.ts") &&
			leaderA.includes("├─ src/two.ts") &&
			leaderA.includes("└─ src/three.ts") &&
			(leaderA.match(/[├└]─/g) ?? []).length === 3 &&
			leaderB.includes("├─ src/two.ts") &&
			leaderB.includes("└─ src/three.ts") &&
			!leaderB.includes("src/one.ts") &&
			(leaderB.match(/[├└]─/g) ?? []).length === 2,
		JSON.stringify({ leaderA, leaderB }),
	);

	// Activity state: settling the same call ID in B must not alter A's live row.
	const freshA = createMinimalToolPresentations();
	const freshB = createMinimalToolPresentations();
	const settledB = text(
		freshB.presentations.read.renderCall(
			{ path: "src/live.ts" },
			theme,
			liveContext("iso-live", { path: "src/live.ts" }, { isPartial: false }),
		),
	);
	const runningA = text(
		freshA.presentations.read.renderCall(
			{ path: "src/live.ts" },
			theme,
			liveContext("iso-live", { path: "src/live.ts" }),
		),
	);
	assert(
		"activity timing stays per view for the same tool-call ID",
		!settledB.includes("· running") && /· \d+\.\ds/u.test(runningA),
		JSON.stringify({ runningA, settledB }),
	);
}

emit("session_shutdown");
console.log("All minimal-tool-presentation tests passed.");

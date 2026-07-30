import { visibleWidth } from "@earendil-works/pi-tui";

import worktreeExtension, { WorktreesView, type GitWorktree } from "../worktree.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

const worktrees: GitWorktree[] = [
	{ path: "/repo", branch: "main", detached: false, locked: false, prunable: false },
	{
		path: "/repo/wt-current",
		branch: "feature/current",
		detached: false,
		locked: false,
		prunable: false,
	},
	{
		path: "/repo/wt-locked",
		branch: "feature/locked",
		detached: false,
		locked: true,
		prunable: false,
	},
	{ path: "/repo/wt-stale", detached: true, locked: false, prunable: true },
];
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function makeView(
	items: GitWorktree[] = worktrees,
	rows = 20,
	currentPath = "/repo/wt-current",
): {
	view: WorktreesView;
	getRenderRequests: () => number;
	getResult: () => GitWorktree | undefined;
} {
	let renderRequests = 0;
	let result: GitWorktree | undefined;
	const tui = {
		terminal: { rows },
		requestRender: () => {
			renderRequests++;
		},
	};
	return {
		view: new WorktreesView(tui as never, theme as never, items, currentPath, (selected) => {
			result = selected;
		}),
		getRenderRequests: () => renderRequests,
		getResult: () => result,
	};
}

function testWorktreeViewNavigationAndChrome(): void {
	const width = 64;
	const { view, getRenderRequests, getResult } = makeView();
	const initial = view.render(width);
	view.handleInput("\x1b[B");
	const next = view.render(width);
	const changedRows = initial
		.map((line, index) => (line === next[index] ? -1 : index))
		.filter((index) => index >= 0);

	assert(
		"worktree TUI uses shared full-screen chrome and exact bounds",
		initial.length === 20 &&
			initial.every((line) => visibleWidth(line) === width) &&
			initial[0]?.includes("Worktrees") &&
			initial[1]?.includes("select a checkout") &&
			initial[2]?.includes("─") &&
			initial.some((line) => line.includes("PgUp/PgDn")) &&
			initial.at(-1)?.trim() === "",
		JSON.stringify(initial),
	);
	assert(
		"worktree TUI starts on the current checkout and exposes worktree states",
		initial[6]?.includes("› ") &&
			initial[7]?.includes("current") &&
			initial.some((line) => line.includes("locked")) &&
			initial.some((line) => line.includes("prunable")),
		JSON.stringify(initial),
	);
	assert(
		"worktree TUI navigation repaints selection rows and requests rendering",
		changedRows.join(",") === "6,9" && getRenderRequests() === 1 && next[9]?.includes("› "),
		`changedRows=${JSON.stringify(changedRows)} requests=${getRenderRequests()} next=${JSON.stringify(next)}`,
	);
	view.handleInput("\r");
	assert(
		"worktree TUI returns the selected checkout",
		getResult()?.path === "/repo/wt-locked",
		JSON.stringify(getResult()),
	);
}

function testWorktreeViewScrollEmptyAndNarrow(): void {
	const many = Array.from({ length: 12 }, (_, index): GitWorktree => ({
		path: `/repo/worktree-${index}`,
		branch: `feature/worktree-${index}`,
		detached: false,
		locked: false,
		prunable: false,
	}));
	const scrolling = makeView(many, 20, many[0]!.path).view;
	scrolling.handleInput("\x1b[F");
	const last = scrolling.render(52);
	const empty = makeView([], 12, "/repo").view.render(30);
	const narrow = makeView(worktrees, 7).view.render(20);

	assert(
		"worktree TUI scrolls to the final checkout inside pinned chrome",
		last.length === 20 &&
			last.every((line) => visibleWidth(line) === 52) &&
			last.some((line) => line.includes("feature/worktree-11")) &&
			last[0]?.includes("Worktrees") &&
			last.at(-1)?.trim() === "",
		JSON.stringify(last),
	);
	assert(
		"worktree TUI preserves useful empty, narrow, and short states",
		empty.length === 12 &&
			empty.every((line) => visibleWidth(line) === 30) &&
			empty.some((line) => line.includes("No Git worktrees")) &&
			narrow.length === 7 &&
			narrow.every((line) => visibleWidth(line) === 20) &&
			narrow[0]?.includes("Worktrees") &&
			narrow.at(-1)?.trim() === "",
		`empty=${JSON.stringify(empty)} narrow=${JSON.stringify(narrow)}`,
	);
}

testWorktreeViewNavigationAndChrome();
testWorktreeViewScrollEmptyAndNarrow();

let cleanupTool: any;
const commands = new Map<string, any>();
const porcelain = [
	"worktree /repo",
	"HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	"branch refs/heads/main",
	"",
	"worktree /repo/wt-current",
	"HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	"branch refs/heads/feature/current",
	"",
].join("\n");
worktreeExtension({
	registerCommand: (name: string, command: any) => {
		commands.set(name, command);
	},
	registerTool: (tool: any) => {
		cleanupTool = tool;
	},
	on: (event: string, handler: (event: unknown, ctx: { cwd: string }) => void) => {
		if (event === "session_start") handler({}, { cwd: "/repo/wt-current" });
	},
	sendUserMessage: () => undefined,
	getActiveTools: () => [],
	setActiveTools: () => undefined,
	exec: async () => ({ stdout: porcelain, stderr: "", code: 0 }),
} as any);

const completions = (await commands.get("git:worktree").getArgumentCompletions("")) as Array<{
	value: string;
	label: string;
	description?: string;
}> | null;
assert(
	"/git:worktree Space completions list worktrees with current marked",
	Array.isArray(completions) &&
		completions.some((item) => item.value === "main") &&
		completions.some(
			(item) => item.value === "feature/current" && item.description?.includes("current"),
		),
	JSON.stringify(completions),
);

let customCalled = false;
let fallbackSelectCalled = false;
let overlayLines: string[] = [];
await commands.get("git:worktree").handler("", {
	cwd: "/repo/wt-current",
	mode: "tui",
	hasUI: true,
	ui: {
		notify: () => undefined,
		select: async () => {
			fallbackSelectCalled = true;
			return undefined;
		},
		custom: async (factory: any, options: any) => {
			customCalled = options?.overlay === true;
			const component = factory(
				{ terminal: { rows: 16 }, requestRender: () => undefined },
				theme,
				{},
				() => undefined,
			);
			overlayLines = component.render(52);
			return undefined;
		},
	},
});
assert(
	"/git:worktree opens the shared full-screen picker in TUI mode",
	customCalled &&
		!fallbackSelectCalled &&
		overlayLines.length === 16 &&
		overlayLines.every((line) => visibleWidth(line) === 52) &&
		overlayLines[0]?.includes("Worktrees"),
	JSON.stringify({ customCalled, fallbackSelectCalled, overlayLines }),
);

let rpcSelectCalled = false;
let rpcCustomCalled = false;
await commands.get("git:worktree").handler("", {
	cwd: "/repo/wt-current",
	mode: "rpc",
	hasUI: true,
	ui: {
		notify: () => undefined,
		select: async () => {
			rpcSelectCalled = true;
			return undefined;
		},
		custom: async () => {
			rpcCustomCalled = true;
			return undefined;
		},
	},
});
assert(
	"/git:worktree preserves the standard selector outside TUI mode",
	rpcSelectCalled && !rpcCustomCalled,
	JSON.stringify({ rpcSelectCalled, rpcCustomCalled }),
);

const result = {
	content: [{ type: "text", text: "Queued interactive worktree cleanup as a follow-up." }],
};
const collapsedCall = cleanupTool
	.renderCall({}, theme, { expanded: false, isError: false })
	.render(80)
	.join("\n");
const collapsedResult = cleanupTool
	.renderResult(result, { expanded: false, isPartial: false }, theme, {
		expanded: false,
		isError: false,
	})
	.render(80)
	.join("\n");
const expandedCall = cleanupTool
	.renderCall({}, theme, { expanded: true, isError: false })
	.render(80)
	.join("\n");
const expandedResult = cleanupTool
	.renderResult(result, { expanded: true, isPartial: false }, theme, {
		expanded: true,
		isError: false,
	})
	.render(80)
	.join("\n");
const errorResult = cleanupTool
	.renderResult(
		{ content: [{ type: "text", text: "Cleanup failed" }] },
		{ expanded: false, isPartial: false },
		theme,
		{ expanded: false, isError: true },
	)
	.render(80)
	.join("\n");

assert(
	"worktree cleanup stays hidden until Ctrl+O and keeps failures visible",
	cleanupTool.renderShell === "self" &&
		collapsedCall === "" &&
		collapsedResult === "" &&
		expandedCall.includes("worktree cleanup") &&
		expandedResult.includes("Queued interactive worktree cleanup") &&
		errorResult.includes("Cleanup failed"),
	JSON.stringify({ collapsedCall, collapsedResult, expandedCall, expandedResult, errorResult }),
);

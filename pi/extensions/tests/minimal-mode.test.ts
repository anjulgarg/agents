import { createGrepTool, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatSummaryOutput, resolveRipgrepPath, runGrepSummary } from "../lib/grep-summary.ts";
import minimalMode, { compactCommandLines, MinimalCommand } from "../minimal-mode.ts";

initTheme();

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

type EventHandler = (event?: any, ctx?: any) => unknown | Promise<unknown>;

const handlers = new Map<string, EventHandler[]>();
const registered: Array<{
	name: string;
	renderShell?: string;
	parameters?: { properties?: Record<string, unknown> };
	execute?: (...args: any[]) => Promise<any>;
	renderCall?: (args: any, theme: any, context: any) => { render(width: number): string[] };
	renderResult?: (
		result: any,
		options: any,
		theme: any,
		context: any,
	) => { render(width: number): string[] };
}> = [];
minimalMode({
	registerTool: (tool: any) => registered.push(tool),
	on: (event: string, handler: EventHandler) => {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
} as any);
const emit = (event: string, payload: any = {}, ctx: any = {}) => {
	for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
};
const emitResults = async (event: string, payload: any): Promise<unknown[]> =>
	Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload, {})));
emit("session_start");

assert(
	"all compact tool renderers bypass the background shell",
	registered.length === 7 && registered.every((tool) => tool.renderShell === "self"),
	JSON.stringify(registered.map(({ name, renderShell }) => ({ name, renderShell }))),
);

const command = "printf '%s\\n' alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";
const collapsed = compactCommandLines(command, 24);
assert(
	"collapsed Bash commands occupy at most two lines",
	collapsed.length === 2,
	JSON.stringify(collapsed),
);
assert(
	"collapsed Bash commands add no truncation suffix",
	!collapsed.join("").includes("...") &&
		!collapsed.join("").includes("…") &&
		!collapsed.join("").includes("lambda"),
	JSON.stringify(collapsed),
);

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

function renderContext(
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

const readTool = registered.find((candidate) => candidate.name === "read")!;
const readAArgs = { path: "src/a.ts" };
const readBArgs = { path: "src/b.ts" };
const readA = renderContext("read-a", readAArgs);
const readB = renderContext("read-b", readBArgs);
const readAFirst = readTool.renderCall?.(readAArgs, theme, readA).render(80) ?? [];
const readBFirst = readTool.renderCall?.(readBArgs, theme, readB).render(80) ?? [];
const readAAfter = readTool.renderCall?.(readAArgs, theme, readA).render(80) ?? [];
assert(
	"same-name inspection calls form one consecutive group",
	readAFirst.join("").includes("read src/a.ts · 0.0s") &&
		readBFirst.join("").includes("read · 0.0s") &&
		readBFirst.join("").includes("├─ src/a.ts") &&
		readBFirst.join("").includes("└─ src/b.ts") &&
		readAAfter.length === 0,
	JSON.stringify({ readAFirst, readBFirst, readAAfter }),
);

emit("session_start");
const batchReadArgs = { path: "src/batch.ts" };
const followupReadArgs = { path: "src/followup.ts" };
readTool.renderCall?.(batchReadArgs, theme, renderContext("read-batch", batchReadArgs)).render(80);
emit("tool_execution_start", { toolName: "activity-boundary", toolCallId: "activity-between" });
const crossBatchReads =
	readTool
		.renderCall?.(followupReadArgs, theme, renderContext("read-followup", followupReadArgs))
		.render(80) ?? [];
assert(
	"passive activity boundaries do not preserve obsolete announcement grouping",
	crossBatchReads.join("").includes("read src/followup.ts") &&
		!crossBatchReads.join("").includes("src/batch.ts"),
	JSON.stringify(crossBatchReads),
);

const grepTool = registered.find((candidate) => candidate.name === "grep")!;
const findTool = registered.find((candidate) => candidate.name === "find")!;
const lsTool = registered.find((candidate) => candidate.name === "ls")!;

emit("session_start");
const interleavedReadOne = { path: "src/one.ts" };
const interleavedLs = { path: "src" };
const interleavedReadTwo = { path: "src/two.ts" };
const interleavedReadThree = { path: "src/three.ts" };
readTool
	.renderCall?.(interleavedReadOne, theme, renderContext("read-interleaved-1", interleavedReadOne))
	.render(80);
lsTool
	.renderCall?.(interleavedLs, theme, renderContext("ls-interleaved", interleavedLs))
	.render(80);
readTool
	.renderCall?.(interleavedReadTwo, theme, renderContext("read-interleaved-2", interleavedReadTwo))
	.render(80);
const interleavedReads =
	readTool
		.renderCall?.(
			interleavedReadThree,
			theme,
			renderContext("read-interleaved-3", interleavedReadThree),
		)
		.render(80) ?? [];
assert(
	"reads group across interleaved inspection tools and sequential batches",
	interleavedReads.join("").includes("├─ src/one.ts") &&
		interleavedReads.join("").includes("├─ src/two.ts") &&
		interleavedReads.join("").includes("└─ src/three.ts") &&
		!interleavedReads.join("").includes("ls"),
	JSON.stringify(interleavedReads),
);

emit("session_start");
const expandedReadArgs = { path: "src/expanded.ts" };
const expandedReadContext = renderContext("read-expanded", expandedReadArgs, {
	expanded: true,
	isPartial: false,
});
const expandedReadCall =
	readTool.renderCall?.(expandedReadArgs, theme, expandedReadContext).render(80).join("\n") ?? "";
const expandedReadOutput =
	readTool
		.renderResult?.(
			{ content: [{ type: "text", text: "expanded output" }] },
			{ expanded: true, isPartial: false },
			theme,
			expandedReadContext,
		)
		.render(80)
		.join("\n") ?? "";
assert(
	"expanded inspection calls keep local chrome and full output",
	expandedReadCall.includes("read src/expanded.ts") &&
		!expandedReadCall.includes("· 2 ·") &&
		expandedReadOutput.includes("expanded output"),
	JSON.stringify({ expandedReadCall, expandedReadOutput }),
);

emit("session_start");
const mixedRead = { path: "src/a.ts" };
const mixedGrep = { pattern: "needle", path: "src" };
const mixedFind = { pattern: "*.ts", path: "src" };
const mixedFirst =
	readTool.renderCall?.(mixedRead, theme, renderContext("mix-1", mixedRead)).render(80) ?? [];
const mixedSecond =
	grepTool.renderCall?.(mixedGrep, theme, renderContext("mix-2", mixedGrep)).render(80) ?? [];
const mixedThird =
	findTool.renderCall?.(mixedFind, theme, renderContext("mix-3", mixedFind)).render(80) ?? [];
const mixedSecondAgain =
	grepTool.renderCall?.(mixedGrep, theme, renderContext("mix-2", mixedGrep)).render(80) ?? [];
assert(
	"mixed inspection tools form separate exact-name boundaries",
	mixedFirst.join("").includes("read src/a.ts") &&
		mixedSecond.join("").includes("grep /needle/ in src") &&
		mixedThird.join("").includes("find *.ts in src") &&
		mixedSecondAgain.join("").includes("grep /needle/ in src") &&
		![mixedFirst, mixedSecond, mixedThird, mixedSecondAgain]
			.map((row) => row.join(""))
			.some((text) => text.includes("inspect ·") || /· \d+ ·/.test(text)),
	JSON.stringify({ mixedFirst, mixedSecond, mixedThird, mixedSecondAgain }),
);

emit("session_start");
const grepOne = { pattern: "alpha", path: "src" };
const grepTwo = { pattern: "beta", path: "lib" };
grepTool.renderCall?.(grepOne, theme, renderContext("grep-1", grepOne)).render(80);
const pureGrep =
	grepTool.renderCall?.(grepTwo, theme, renderContext("grep-2", grepTwo)).render(80) ?? [];
assert(
	"consecutive calls of one inspection tool group by exact name",
	pureGrep.join("").includes("grep · 0.0s") &&
		pureGrep.join("").includes("├─ /alpha/ in src") &&
		pureGrep.join("").includes("└─ /beta/ in lib") &&
		!pureGrep.join("").includes("inspect"),
	JSON.stringify(pureGrep),
);

const deepLeader = (
	grepTool
		.renderCall?.(
			{ pattern: "elapsed", path: "src" },
			theme,
			renderContext("deep-2", { pattern: "elapsed", path: "src" }),
		)
		.render(60) ?? []
).join("");
assert(
	"a narrow grouped row keeps its tool name when the path has to elide",
	deepLeader.includes("grep") && deepLeader.includes("in src") && !deepLeader.includes("inspect"),
	JSON.stringify(deepLeader),
);

const deepPath =
	"~/.nvm/versions/node/v24.14.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
const buriedArgs = { pattern: "outputPad|output-pad", path: deepPath };
const buried = (
	grepTool.renderCall?.(buriedArgs, theme, renderContext("buried", buriedArgs)).render(80) ?? []
).join("");
assert(
	"a long path may not erase the pattern from a row wide enough for both",
	buried.includes("/outputPad") && buried.includes("interactive-mode.js"),
	JSON.stringify(buried),
);

const failArgs = { pattern: "renderPad(", path: "src" };
const failContext = renderContext("fail-1", failArgs, { isPartial: false, isError: true });
grepTool.renderCall?.(failArgs, theme, failContext).render(80);
const afterFailArgs = { path: "src/after.ts" };
const afterFail =
	readTool.renderCall?.(afterFailArgs, theme, renderContext("fail-2", afterFailArgs)).render(80) ??
	[];
const failRow = grepTool.renderCall?.(failArgs, theme, failContext).render(80) ?? [];
assert(
	"a failed call keeps its own row beside the next call",
	failRow.join("").includes("grep /renderPad(/ in src") &&
		afterFail.join("").includes("read src/after.ts") &&
		!afterFail.join("").includes("· 2 ·"),
	JSON.stringify({ failRow, afterFail }),
);

const wideArgs = {
	pattern: "duration|elapsed|runtime|minimal|tool_result|bash",
	path: "coding/.pi/agent/packages",
};
const wideContext = renderContext("grep-wide", wideArgs);
const renderAtWidth = (width: number): string =>
	(grepTool.renderCall?.(wideArgs, theme, wideContext).render(width) ?? []).join("");
const atFull = renderAtWidth(120);
const atNarrow = renderAtWidth(40);
assert(
	"grouped grep rows keep the tool name and path at full and narrow widths",
	atFull.includes(`/${wideArgs.pattern}/ in ${wideArgs.path}`) &&
		atNarrow.includes("grep") &&
		atNarrow.includes("packages"),
	JSON.stringify({ atFull, atNarrow }),
);

emit("session_start");
const wrappedGrepOne = {
	pattern: "renderSoftGroupedCall|SoftGroupTracker",
	path: "pi/extensions/lib/pi-tui-soft-group/index.ts",
};
const wrappedGrepTwo = {
	pattern: "bindSoftGroupTracker|seedSessionTopology",
	path: "pi/extensions/tests/tui-kit.test.ts",
};
grepTool
	.renderCall?.(wrappedGrepOne, theme, renderContext("grep-wrap-1", wrappedGrepOne))
	.render(42);
const wrappedGrep =
	grepTool
		.renderCall?.(wrappedGrepTwo, theme, renderContext("grep-wrap-2", wrappedGrepTwo))
		.render(42) ?? [];
assert(
	"grouped grep leaves wrap to two aligned lines",
	wrappedGrep.length === 5 &&
		wrappedGrep.every((line) => visibleWidth(line) <= 42) &&
		wrappedGrep[1]?.includes("├─ /renderSoftGroupedCall") &&
		wrappedGrep[2]?.trim().startsWith("│") &&
		wrappedGrep[2]?.endsWith("index.ts") &&
		wrappedGrep[3]?.includes("└─ /bindSoftGroupTracker") &&
		!wrappedGrep[4]?.includes("│") &&
		wrappedGrep[4]?.endsWith("tui-kit.test.ts"),
	JSON.stringify(wrappedGrep),
);

const limitedGrepArgs = {
	pattern: "handcrafted harness|coding harness|Foreman Stack|enterprise",
	path: ".",
	limit: 50,
};
const limitedGrep = (
	grepTool
		.renderCall?.(limitedGrepArgs, theme, renderContext("grep-limit", limitedGrepArgs))
		.render(80) ?? []
).join("\n");
assert(
	"grouped grep preserves a trailing limit when the summary wraps",
	limitedGrep.includes("limit 50") && !limitedGrep.includes("limit…"),
	limitedGrep,
);

const bashTool = registered.find((candidate) => candidate.name === "bash")!;
const bashArgs = { command: "bun test", timeout: undefined };
const bashContext = renderContext("bash-running", bashArgs);
const runningBash = bashTool.renderCall?.(bashArgs, theme, bashContext).render(100) ?? [];
assert(
	"running Bash calls are individually visible with elapsed state",
	runningBash.join("\n").includes("$ bun test · 0.0s"),
	JSON.stringify(runningBash),
);

const longCommandArgs = {
	command:
		"docker compose -f deploy/compose.yaml run --rm migrate alembic upgrade head && npm run build",
	timeout: undefined,
};
const longRunning =
	bashTool
		.renderCall?.(longCommandArgs, theme, renderContext("bash-long", longCommandArgs))
		.render(60) ?? [];
assert(
	"long commands keep the elapsed counter pinned to the last visible line",
	longRunning.length === 2 && longRunning[1].trimEnd().endsWith("· 0.0s"),
	JSON.stringify(longRunning),
);

bashContext.isPartial = false;
bashContext.isError = true;
const settledCall = bashTool.renderCall?.(bashArgs, theme, bashContext).render(100) ?? [];
const failedBash =
	bashTool
		.renderResult?.(
			{ content: [{ type: "text", text: "Command exited with code 1" }] },
			{ expanded: false, isPartial: false },
			theme,
			bashContext,
		)
		.render(100) ?? [];
assert(
	"failed Bash receipts stay aligned and emphasize the status suffix",
	settledCall.length === 0 &&
		failedBash.join("\n").includes("$ bun test · exit 1 · 0.0s") &&
		!failedBash.join("\n").includes("×"),
	JSON.stringify({ settledCall, failedBash }),
);

const bashStyleCalls: Array<{ color: string; text: string }> = [];
const bashStyleTheme = {
	fg: (color: string, text: string) => {
		bashStyleCalls.push({ color, text });
		return text;
	},
	bold: (text: string) => text,
} as any;
const styleRunningArgs = { command: "echo hi", timeout: undefined };
const styleRunningContext = renderContext("bash-style-running", styleRunningArgs);
bashTool.renderCall?.(styleRunningArgs, bashStyleTheme, styleRunningContext).render(100);
const styleFailedContext = renderContext("bash-style-failed", styleRunningArgs, {
	isPartial: false,
	isError: true,
});
bashTool
	.renderResult?.(
		{
			content: [{ type: "text", text: "Command exited with code 1" }],
			details: { durationMs: 100 },
		},
		{ expanded: false, isPartial: false },
		bashStyleTheme,
		styleFailedContext,
	)
	.render(100);
assert(
	"Bash live and duration suffixes use muted styling",
	bashStyleCalls.some(({ color, text }) => color === "muted" && /· \d+\.\ds/.test(text)) &&
		!bashStyleCalls.some(({ text }) => text.includes("· running")) &&
		bashStyleCalls.some(({ color, text }) => color === "error" && text.includes("· exit 1")),
	JSON.stringify(bashStyleCalls),
);

const bashTwoArgs = { command: "git diff --check", timeout: undefined };
const bashTwoContext = renderContext("bash-two", bashTwoArgs, { isPartial: false });
const successfulBash =
	bashTool
		.renderResult?.(
			{ content: [{ type: "text", text: "" }] },
			{ expanded: false, isPartial: false },
			theme,
			bashTwoContext,
		)
		.render(100) ?? [];
assert(
	"successful shell receipts align on the command prompt",
	successfulBash.join("\n").includes("$ git diff --check") &&
		!successfulBash.join("\n").includes("✓") &&
		!successfulBash.join("\n").includes("commands"),
	JSON.stringify(successfulBash),
);

const persistedToolCallId = "bash-persisted-duration";
const persistedResult = await bashTool.execute?.(
	persistedToolCallId,
	{ command: "sleep 0.12" },
	undefined,
	undefined,
	{ cwd: process.cwd() },
);
const persistedPatches = await emitResults("tool_result", {
	toolName: "bash",
	toolCallId: persistedToolCallId,
	details: { ...(persistedResult?.details ?? {}), marker: "preserved" },
});
const persistedDetails = persistedPatches
	.map((patch) => (patch as { details?: Record<string, unknown> } | undefined)?.details)
	.find((details) => typeof details?.durationMs === "number");
const persistedDuration = persistedDetails?.durationMs as number | undefined;
const restoredArgs = { command: "sleep 0.12" };
const restoredContext = renderContext(persistedToolCallId, restoredArgs, {
	executionStarted: false,
	isPartial: false,
	state: {},
});
const restoredReceipt =
	bashTool
		.renderResult?.(
			{ content: persistedResult?.content ?? [], details: persistedDetails },
			{ expanded: false, isPartial: false },
			theme,
			restoredContext,
		)
		.render(100)
		.join("\n") ?? "";
const restoredExpanded =
	bashTool
		.renderResult?.(
			{ content: persistedResult?.content ?? [], details: persistedDetails },
			{ expanded: true, isPartial: false },
			theme,
			{ ...restoredContext, expanded: true },
		)
		.render(100)
		.join("\n") ?? "";
assert(
	"completed Bash duration is persisted and visible after renderer state is lost",
	typeof persistedDuration === "number" &&
		persistedDuration >= 80 &&
		persistedDetails?.marker === "preserved" &&
		/\$ sleep 0\.12 · \d+\.\ds/.test(restoredReceipt) &&
		/Took \d+\.\ds/.test(restoredExpanded),
	JSON.stringify({ persistedDetails, restoredReceipt, restoredExpanded }),
);

const failedToolCallId = "bash-failed-duration";
let failedMessage = "";
try {
	await bashTool.execute?.(
		failedToolCallId,
		{ command: "sleep 0.05; exit 3" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
} catch (error) {
	failedMessage = error instanceof Error ? error.message : String(error);
}
const failedPatches = await emitResults("tool_result", {
	toolName: "bash",
	toolCallId: failedToolCallId,
	details: undefined,
	isError: true,
});
const failedDetails = failedPatches
	.map((patch) => (patch as { details?: Record<string, unknown> } | undefined)?.details)
	.find((details) => typeof details?.durationMs === "number");
const restoredFailureContext = renderContext(
	failedToolCallId,
	{ command: "sleep 0.05; exit 3" },
	{
		executionStarted: false,
		isPartial: false,
		isError: true,
		state: {},
	},
);
const restoredFailure =
	bashTool
		.renderResult?.(
			{ content: [{ type: "text", text: failedMessage }], details: failedDetails },
			{ expanded: false, isPartial: false },
			theme,
			restoredFailureContext,
		)
		.render(100)
		.join("\n") ?? "";
assert(
	"failed Bash duration is persisted beside its exit status",
	failedMessage.includes("Command exited with code 3") &&
		typeof failedDetails?.durationMs === "number" &&
		/\$ sleep 0\.05; exit 3 · exit 3 · \d+\.\ds/.test(restoredFailure),
	JSON.stringify({ failedDetails, restoredFailure }),
);

const editTool = registered.find((candidate) => candidate.name === "edit")!;
const editArgs = { path: "src/a.ts", edits: [] };
const editContext = renderContext("edit-one", editArgs);
const runningEdit = editTool.renderCall?.(editArgs, theme, editContext).render(100) ?? [];
editContext.isPartial = false;
editTool.renderCall?.(editArgs, theme, editContext).render(100);
const completedEdit =
	editTool
		.renderResult?.(
			{
				content: [{ type: "text", text: "Successfully replaced 1 block" }],
				details: { diff: "-10 old first line\n+10 new first line\n+11 another line" },
			},
			{ expanded: false, isPartial: false },
			theme,
			editContext,
		)
		.render(100) ?? [];
assert(
	"mutations shimmer while active and settle into aligned diff receipts",
	runningEdit.join("\n").includes("edit src/a.ts · 0.0s") &&
		completedEdit.join("\n").includes("edit src/a.ts · +2 −1 · 0.0s") &&
		!completedEdit.join("\n").includes("✓"),
	JSON.stringify({ runningEdit, completedEdit }),
);

const secondEditArgs = { path: "src/b.ts", edits: [] };
const secondEditContext = renderContext("edit-two", secondEditArgs, { isPartial: false });
const secondEditResult = {
	content: [{ type: "text", text: "Successfully replaced 1 block" }],
	details: { diff: "-20 old line\n+20 new line" },
};
const groupedEdits =
	editTool
		.renderResult?.(
			secondEditResult,
			{ expanded: false, isPartial: false },
			theme,
			secondEditContext,
		)
		.render(100) ?? [];
const hiddenFirstEdit =
	editTool
		.renderResult?.(
			{
				content: [{ type: "text", text: "Successfully replaced 1 block" }],
				details: { diff: "-10 old first line\n+10 new first line\n+11 another line" },
			},
			{ expanded: false, isPartial: false },
			theme,
			editContext,
		)
		.render(100) ?? [];
const expandedSecondEdit =
	editTool
		.renderResult?.(secondEditResult, { expanded: true, isPartial: false }, theme, {
			...secondEditContext,
			expanded: true,
		})
		.render(100)
		.join("\n") ?? "";
assert(
	"consecutive successful edit receipts group while expanded diffs stay local",
	groupedEdits.length === 3 &&
		groupedEdits[0]?.trim() === "edit" &&
		groupedEdits[1]?.includes("├─ src/a.ts · +2 −1") &&
		groupedEdits[2]?.includes("└─ src/b.ts · +1 −1") &&
		hiddenFirstEdit.length === 0 &&
		expandedSecondEdit.includes("20 old line") &&
		expandedSecondEdit.includes("20 new line"),
	JSON.stringify({ groupedEdits, hiddenFirstEdit, expandedSecondEdit }),
);

const failedEditArgs = { path: "src/fail.ts", edits: [] };
const failedEditContext = renderContext("edit-failed", failedEditArgs, {
	isPartial: false,
	isError: true,
});
const failedEdit =
	editTool
		.renderResult?.(
			{ content: [{ type: "text", text: "oldText not found" }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			failedEditContext,
		)
		.render(100) ?? [];
const afterFailureArgs = { path: "src/after-failure.ts", edits: [] };
const afterFailureContext = renderContext("edit-after-failure", afterFailureArgs, {
	isPartial: false,
});
const afterFailedEdit =
	editTool
		.renderResult?.(
			{ content: [{ type: "text", text: "done" }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			afterFailureContext,
		)
		.render(100) ?? [];
editTool
	.renderResult?.(
		{ content: [{ type: "text", text: "oldText not found" }], details: {} },
		{ expanded: false, isPartial: false },
		theme,
		failedEditContext,
	)
	.render(100);
const afterFailureSecondArgs = { path: "src/after-failure-two.ts", edits: [] };
const afterFailureSecondContext = renderContext("edit-after-failure-two", afterFailureSecondArgs, {
	isPartial: false,
});
const groupedAfterFailure =
	editTool
		.renderResult?.(
			{ content: [{ type: "text", text: "done" }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			afterFailureSecondContext,
		)
		.render(100) ?? [];
emit("tool_execution_start", { toolName: "write", toolCallId: "write-boundary" });
const afterBoundaryArgs = { path: "src/after-write.ts", edits: [] };
const afterBoundaryContext = renderContext("edit-after-write", afterBoundaryArgs, {
	isPartial: false,
});
const afterWriteBoundary =
	editTool
		.renderResult?.(
			{ content: [{ type: "text", text: "done" }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			afterBoundaryContext,
		)
		.render(100) ?? [];
assert(
	"failed edits stay standalone and ungrouped tools split successful receipts",
	failedEdit.length === 1 &&
		failedEdit[0]?.includes("× edit src/fail.ts") &&
		afterFailedEdit.length === 1 &&
		afterFailedEdit[0]?.includes("edit src/after-failure.ts") &&
		groupedAfterFailure.length === 3 &&
		groupedAfterFailure[1]?.includes("├─ src/after-failure.ts") &&
		groupedAfterFailure[2]?.includes("└─ src/after-failure-two.ts") &&
		afterWriteBoundary.length === 1 &&
		afterWriteBoundary[0]?.includes("edit src/after-write.ts"),
	JSON.stringify({ failedEdit, afterFailedEdit, groupedAfterFailure, afterWriteBoundary }),
);

emit("session_start");
const pathStyles: Array<{ color: string; text: string }> = [];
const trackingTheme = {
	fg: (color: string, text: string) => {
		if (text === "src/style.ts") pathStyles.push({ color, text });
		return text;
	},
	bold: (text: string) => text,
} as any;
for (const name of ["edit", "write"]) {
	const tool = registered.find((candidate) => candidate.name === name)!;
	const args =
		name === "edit"
			? { path: "src/style.ts", edits: [] }
			: { path: "src/style.ts", content: "content" };
	const context = renderContext(`${name}-style`, args);
	tool.renderCall?.(args, trackingTheme, context).render(100);
	context.isPartial = false;
	tool.renderCall?.(args, trackingTheme, context).render(100);
	tool
		.renderResult?.(
			{ content: [{ type: "text", text: "done" }], details: {} },
			{ expanded: false, isPartial: false },
			trackingTheme,
			context,
		)
		.render(100);
}
assert(
	"edit and write paths use muted parameter styling",
	pathStyles.length >= 4 && pathStyles.every(({ color }) => color === "muted"),
	JSON.stringify(pathStyles),
);

const historicalBranch = [
	{
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "edit-history-1", name: "edit", arguments: {} }],
		},
	},
	{
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "edit-history-1",
			toolName: "edit",
			content: [],
		},
	},
	{
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "edit-history-2", name: "edit", arguments: {} }],
		},
	},
];
emit("session_start", {}, { sessionManager: { getBranch: () => historicalBranch } });
const historicalEditResult = {
	content: [{ type: "text", text: "done" }],
	details: { diff: "-1 old\n+1 new" },
};
const historicalEditOneContext = renderContext(
	"edit-history-1",
	{ path: "src/history-one.ts", edits: [] },
	{ executionStarted: false, isPartial: false },
);
const historicalEditTwoContext = renderContext(
	"edit-history-2",
	{ path: "src/history-two.ts", edits: [] },
	{ executionStarted: false, isPartial: false },
);
const historicalEditOne =
	editTool
		.renderResult?.(
			historicalEditResult,
			{ expanded: false, isPartial: false },
			theme,
			historicalEditOneContext,
		)
		.render(100) ?? [];
const historicalEditTwo =
	editTool
		.renderResult?.(
			historicalEditResult,
			{ expanded: false, isPartial: false },
			theme,
			historicalEditTwoContext,
		)
		.render(100) ?? [];
assert(
	"restored consecutive edit receipts retain their tree topology",
	historicalEditOne.length === 0 &&
		historicalEditTwo.length === 3 &&
		historicalEditTwo[1]?.includes("├─ src/history-one.ts · +1 −1") &&
		historicalEditTwo[2]?.includes("└─ src/history-two.ts · +1 −1"),
	JSON.stringify({ historicalEditOne, historicalEditTwo }),
);
emit("session_start");

const grepArgs = { pattern: "needle", path: "/missing" };
const grepContext = renderContext("grep-failed", grepArgs, { isPartial: false, isError: true });
grepTool.renderCall?.(grepArgs, theme, grepContext).render(80);
const failedGrep =
	grepTool
		.renderResult?.(
			{ content: [{ type: "text", text: "Path not found: /missing\nAdditional detail" }] },
			{ expanded: false, isPartial: false },
			theme,
			grepContext,
		)
		.render(80) ?? [];
assert(
	"collapsed inspection failures remain visible without full output",
	failedGrep.join("\n").includes("× Path not found: /missing") &&
		!failedGrep.join("\n").includes("Additional detail"),
	JSON.stringify(failedGrep),
);

const grepProperties = Object.keys(grepTool.parameters?.properties ?? {});
const builtInGrepProperties = Object.keys(
	(createGrepTool(process.cwd()).parameters as { properties: Record<string, unknown> }).properties,
);
assert(
	"grep exposes outputMode on top of every built-in parameter",
	grepProperties.includes("outputMode") &&
		builtInGrepProperties.every((name) => grepProperties.includes(name)),
	JSON.stringify({ grepProperties, builtInGrepProperties }),
);

const summaryModeCall =
	grepTool
		.renderCall?.(
			{ pattern: "needle", path: ".", outputMode: "files_with_matches" },
			theme,
			renderContext("grep-summary-mode", { pattern: "needle" }),
		)
		.render(80) ?? [];
assert(
	"summary searches name their output mode in the call row",
	summaryModeCall.join("\n").includes("files with matches"),
	JSON.stringify(summaryModeCall),
);

const countOutput = formatSummaryOutput(
	"count",
	[
		{ path: "src/b.ts", count: 2 },
		{ path: "src/a.ts", count: 7 },
	],
	1,
).content[0].text;
assert(
	"count mode leads with totals, orders by match count, and flags the limit",
	countOutput.startsWith("2 files, 9 matches\nsrc/a.ts: 7") &&
		!countOutput.includes("src/b.ts") &&
		countOutput.includes("1 file limit reached. Use limit=2 for more"),
	JSON.stringify(countOutput),
);

assert(
	"summary modes report empty searches like the built-in tool",
	formatSummaryOutput("files_with_matches", [], 100).content[0].text === "No matches found",
	"empty rows",
);

const rgPath = resolveRipgrepPath();
if (rgPath) {
	const searchDir = mkdtempSync(join(tmpdir(), "pi-grep-summary-"));
	try {
		writeFileSync(join(searchDir, "alpha.ts"), "needle\nneedle\n");
		writeFileSync(join(searchDir, "beta.ts"), "needle\n");
		writeFileSync(join(searchDir, "gamma.md"), "needle\n");
		const files = await runGrepSummary(
			rgPath,
			{ mode: "files_with_matches", pattern: "needle", searchPath: searchDir, glob: "*.ts" },
			{ isDirectory: true, limit: 100 },
		);
		const counts = await runGrepSummary(
			rgPath,
			{ mode: "count", pattern: "NEEDLE", searchPath: searchDir, ignoreCase: true },
			{ isDirectory: true, limit: 100 },
		);
		assert(
			"ripgrep summary modes honor glob and case filters and return relative paths",
			files.content[0].text === "2 files with matches\nalpha.ts\nbeta.ts" &&
				counts.content[0].text === "3 files, 4 matches\nalpha.ts: 2\nbeta.ts: 1\ngamma.md: 1",
			JSON.stringify({ files: files.content[0].text, counts: counts.content[0].text }),
		);

		const singleFile = await runGrepSummary(
			rgPath,
			{ mode: "count", pattern: "needle", searchPath: join(searchDir, "alpha.ts") },
			{ isDirectory: false, limit: 100 },
		);
		assert(
			"searching one file still reports its name and count",
			singleFile.content[0].text === "1 file, 2 matches\nalpha.ts: 2",
			JSON.stringify(singleFile.content[0].text),
		);
	} finally {
		rmSync(searchDir, { recursive: true, force: true });
	}
} else {
	console.log("SKIP: ripgrep summary integration (no rg binary available)");
}

const expandedFailed =
	bashTool
		.renderResult?.(
			{ content: [{ type: "text", text: "Command exited with code 1\nAdditional detail" }] },
			{ expanded: true, isPartial: false },
			theme,
			{ ...bashContext, expanded: true },
		)
		.render(100)
		.join("\n") ?? "";
assert(
	"Ctrl+O preserves complete tool output",
	expandedFailed.includes("Command exited with code 1") &&
		expandedFailed.includes("Additional detail"),
	JSON.stringify(expandedFailed),
);

const collapsedComponent = new MinimalCommand(command, undefined, false, theme).render(24);
const expandedComponent = new MinimalCommand(command, undefined, true, theme).render(24);
assert(
	"command rendering stays compact and expands completely",
	collapsedComponent.length <= 2 &&
		expandedComponent.length > 2 &&
		expandedComponent
			.join("")
			.replace(/^\$ |\s/gm, "")
			.includes("lambda"),
	JSON.stringify({ collapsedComponent, expandedComponent }),
);

emit("session_shutdown");
console.log("All minimal-mode tests passed.");
